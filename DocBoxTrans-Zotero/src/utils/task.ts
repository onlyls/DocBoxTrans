import { getPref, getPrefInt } from "./prefs";
import { getString } from "./locale";
import type { HistoryRecord, RecordPosition } from "./history";
import * as historyStore from "./historyStore";
import { translationContext } from "../modules/context";
import { refreshHistoryPanes } from "../modules/historyPane";
import { TranslateError } from "../modules/services/base";
import { services } from "../modules/services";

/** 一次翻译任务（移植自 DocBoxTrans 的翻译管线，简化为阅读器划词场景）。 */
export interface TranslateTask {
  id: string;
  type: "text";
  /** 待翻译原文。 */
  raw: string;
  /** 译文或错误提示。 */
  result: string;
  /** 服务 id：llm / google / bing / tencent / youdao / cnki。 */
  service: string;
  /** 所属附件（PDF 等）的条目 id（上下文按篇隔离）。 */
  itemId?: number;
  /** 选区在文档中的位置（仅 PDF 有；用于历史记录跳转回原文）。 */
  position?: RecordPosition;
  /** 结果已写入历史后的记录 id（供侧栏「当前翻译」定位其标签）；复用命中时同样写入。 */
  recordId?: string;
  langfrom: string;
  langto: string;
  status: "waiting" | "processing" | "success" | "fail";
}

const MaxQueueLength = 100;

/** 创建并入队一个翻译任务；原文为空时返回 undefined。 */
export function createTask(
  raw: string,
  itemId?: number,
  service?: string,
  position?: RecordPosition,
): TranslateTask | undefined {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return undefined;
  const task: TranslateTask = {
    id: `${Zotero.Utilities.randomString()}-${Date.now()}`,
    type: "text",
    raw: trimmed,
    result: "",
    service: service || String(getPref("translateSource") || "llm"),
    itemId,
    position: position ?? undefined,
    langfrom: "auto",
    langto: String(getPref("targetLanguage") || "zh-CN"),
    status: "waiting",
  };
  const queue = addon.data.translate.queue;
  queue.push(task);
  if (queue.length > MaxQueueLength) {
    queue.splice(0, queue.length - MaxQueueLength);
  }
  return task;
}

/**
 * 执行一次翻译任务：按服务能力与「上下文增强」开关装配上下文，调用引擎，成功后写入上下文存储。
 * 返回是否成功。
 */
export async function runTranslationTask(
  task: TranslateTask | undefined,
  options: { noDisplay?: boolean } = {},
): Promise<boolean> {
  const noDisplay = options.noDisplay ?? false;
  if (!task || !task.raw) return false;

  const service = services.getById(task.service);
  if (!service) {
    task.result = getString("status-unknown-service") + task.service;
    task.status = "fail";
    refresh(noDisplay);
    return false;
  }

  // 相同文本复用：命中同附件+同原文+同引擎+同目标语言的历史则直接返回，不重复发请求。
  // 上下文增强（且服务支持上下文）时不复用，避免返回与本篇上文不符的旧译文。
  if (
    Boolean(getPref("reuseTranslation")) &&
    !(Boolean(getPref("contextEnable")) && service.supportsContext())
  ) {
    const hit = historyStore.findBySource(
      task.raw,
      task.itemId,
      service.id,
      task.langto,
    );
    if (hit) {
      task.status = "success";
      task.result = hit.translatedText;
      task.recordId = hit.id;
      refresh(noDisplay);
      return true;
    }
  }

  // 上下文快照：仅当勾选「上下文增强翻译」且服务具备上下文能力时才携带
  let context: HistoryRecord[] = [];
  if (Boolean(getPref("contextEnable")) && service.supportsContext()) {
    context = translationContext.snapshot(
      task.itemId,
      service.id,
      task.langto,
      getPrefInt("contextMaxItems", 4),
      getPrefInt("contextMaxChars", 1500),
    );
  }
  const seq = translationContext.nextSeq();
  const gen = translationContext.getGeneration();

  task.status = "processing";
  task.result = getString("status-translating");
  refresh(noDisplay);

  try {
    await service.translate(task as Required<TranslateTask>, context);
    task.status = "success";
    if (task.result && task.result.trim().length > 0) {
      // 先落历史（同一原文+文献只保留最新一次），再把同一条记录交给上下文模块复用
      const rec: HistoryRecord = historyStore.add(
        task.raw,
        task.result,
        service.id,
        task.langto,
        task.itemId,
        task.position,
      );
      task.recordId = rec.id;
      translationContext.add(rec, seq, gen);
      refreshHistoryPanes();
    }
  } catch (e) {
    task.status = "fail";
    if (e instanceof TranslateError) {
      task.result = e.message;
    } else {
      task.result = `${getString("status-request-error")} ${service.id}\n\n${String(
        (e as Error)?.message ?? e,
      )}`;
    }
  }
  refresh(noDisplay);
  return task.status === "success";
}

/** 取队列中最后一个任务。 */
export function getLastTask(): TranslateTask | undefined {
  const queue = addon.data.translate.queue;
  return queue.length > 0 ? queue[queue.length - 1] : undefined;
}

function refresh(noDisplay: boolean) {
  // 阅读器弹窗被关闭时不再刷新它；但侧栏「当前翻译」始终要跟随任务状态更新
  if (!noDisplay) addon.hooks.onReaderPopupRefresh();
  refreshHistoryPanes();
}
