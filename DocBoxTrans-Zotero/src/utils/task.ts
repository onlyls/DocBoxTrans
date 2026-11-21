import { getPref, getPrefInt } from "./prefs";
import { getString } from "./locale";
import type { HistoryRecord, RecordPosition } from "./history";
import * as historyStore from "./historyStore";
import { translationContext } from "../modules/context";
import { notifyTranslationUpdate } from "./translationEvents";
import { TranslateError, type TranslationRequest } from "../modules/services/base";
import { services } from "../modules/services";
import { preprocessPdfText } from "./text";

/** 一次翻译任务（移植自 DocBoxTrans 的翻译管线，简化为阅读器划词场景）。 */
export interface TranslateTask {
  id: string;
  type: "text";
  /** 待翻译原文。 */
  raw: string;
  originalRaw?: string;
  isPdf?: boolean;
  /** 流式中断时保留部分译文，错误和任务状态分别展示。 */
  partialResult?: string;
  error?: string;
  /** 译文或错误提示。 */
  result: string;
  /** 服务 id：llm / google / bing / tencent / youdao / cnki。 */
  service: string;
  /** 阅读器实例标识，同一附件在不同窗口中打开时仍独立。 */
  readerId?: string;
  /** 所属附件（PDF 等）的条目 id（上下文按篇隔离）。 */
  itemId?: number;
  /** 选区在文档中的位置（仅 PDF 有；用于历史记录跳转回原文）。 */
  position?: RecordPosition;
  /** 结果已写入历史后的记录 id（供侧栏「当前翻译」定位其标签）；复用命中时同样写入。 */
  recordId?: string;
  /** 是否由拼合区拼接而成；此时上下文需排除已包含在原文中的片段，避免重复。 */
  combined?: boolean;
  langfrom: string;
  langto: string;
  status: "waiting" | "processing" | "success" | "fail" | "cancelled";
}

const MaxQueueLength = 100;
const latestTasks = new Map<string, TranslateTask>();
const running = new Map<string, AbortController>();
const inFlight = new WeakMap<TranslateTask, Promise<boolean>>();
let stopped = false;

function taskScope(task: TranslateTask): string {
  return task.readerId ? `reader:${task.readerId}` : `item:${task.itemId ?? -1}`;
}

/** 创建并入队一个翻译任务；原文为空时返回 undefined。 */
export function createTask(
  raw: string,
  itemId?: number,
  service?: string,
  position?: RecordPosition,
  combined?: boolean,
  readerId?: string,
  isPdf?: boolean,
): TranslateTask | undefined {
  const originalRaw = (raw ?? "").trim();
  const pdf = isPdf ?? typeof position?.pageIndex === "number";
  const trimmed = pdf && getPref("preprocessText") !== false ? preprocessPdfText(originalRaw) : originalRaw;
  if (!trimmed) return undefined;
  const task: TranslateTask = {
    id: `${Zotero.Utilities.randomString()}-${Date.now()}`,
    type: "text",
    raw: trimmed,
    originalRaw,
    isPdf: pdf,
    result: "",
    service: service || String(getPref("translateSource") || "llm"),
    readerId,
    itemId,
    position: position ?? undefined,
    combined: combined || undefined,
    langfrom: "auto",
    langto: String(getPref("targetLanguage") || "zh-CN"),
    status: "waiting",
  };
  const scope = taskScope(task);
  const previous = latestTasks.get(scope);
  if (previous?.status === "processing") {
    previous.status = "cancelled";
    previous.result = previous.partialResult || getString("status-cancelled");
  }
  running.get(scope)?.abort();
  latestTasks.set(scope, task);
  const queue = addon.data.translate.queue;
  queue.push(task);
  if (queue.length > MaxQueueLength) {
    for (const discarded of queue.splice(0, queue.length - MaxQueueLength)) {
      const discardedScope = taskScope(discarded);
      if (latestTasks.get(discardedScope) === discarded && !running.has(discardedScope)) {
        latestTasks.delete(discardedScope);
      }
    }
  }
  return task;
}

/**
 * 执行一次翻译任务：按服务能力与「上下文增强」开关装配上下文，调用引擎，成功后写入上下文存储。
 * 返回是否成功。
 */
export function runTranslationTask(
  task: TranslateTask | undefined,
  options: { noDisplay?: boolean; force?: boolean } = {},
): Promise<boolean> {
  if (!task || !task.raw || stopped || task.status === "cancelled") return Promise.resolve(false);
  // 同一任务被重复触发时共享在途请求，避免重复计费。
  const existing = inFlight.get(task);
  if (existing) return existing;
  if (latestTasks.get(taskScope(task)) !== task) return Promise.resolve(false);
  const promise = executeTask(task, options);
  inFlight.set(task, promise);
  void promise.finally(() => inFlight.delete(task)).catch(() => {});
  return promise;
}

async function executeTask(
  task: TranslateTask,
  options: { noDisplay?: boolean; force?: boolean },
): Promise<boolean> {
  const noDisplay = options.noDisplay ?? false;

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
    !options.force && Boolean(getPref("reuseTranslation")) &&
    !(Boolean(getPref("contextEnable")) && service.supportsContext())
  ) {
    const hit = historyStore.findBySource(
      task.raw,
      task.itemId,
      service.id,
      task.langto,
    );
    if (hit?.translatedText.trim()) {
      task.status = "success";
      task.result = hit.translatedText;
      task.recordId = hit.id;
      translationContext.add(hit, translationContext.nextSeq(), translationContext.getGeneration());
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
      // 重译不参考自己的旧译文；拼接时也排除原文已包含的片段。
      // 必须先排除再计算预算，避免重复内容挤占有效参考的名额。
      (r) => r.sourceText === task.raw ||
        Boolean(task.combined && r.sourceText && task.raw.includes(r.sourceText)),
    );
  }
  const seq = translationContext.nextSeq();
  const gen = translationContext.getGeneration();
  const scope = taskScope(task);
  const controller = new AbortController();
  running.set(scope, controller);
  const isCurrent = () => !stopped && !controller.signal.aborted && task.status === "processing" &&
    latestTasks.get(scope) === task;
  let progressTimer: ReturnType<typeof setTimeout> | undefined;
  let lastProgress = 0;
  const clearProgress = () => {
    if (progressTimer != null) clearTimeout(progressTimer);
    progressTimer = undefined;
  };
  controller.signal.addEventListener("abort", clearProgress, { once: true });
  const displayProgress = () => {
    clearProgress();
    if (!isCurrent()) return;
    lastProgress = Date.now();
    notifyTranslationUpdate(!noDisplay, true);
  };
  const request: TranslationRequest = Object.freeze({
    raw: task.raw,
    langfrom: task.langfrom,
    langto: task.langto,
    signal: controller.signal,
    onProgress: (text: string) => {
      if (!isCurrent() || !text) return;
      task.partialResult = text;
      task.result = text;
      if (Date.now() - lastProgress >= 80) displayProgress();
      else progressTimer ??= setTimeout(displayProgress, 80 - (Date.now() - lastProgress));
    },
  });

  task.status = "processing";
  task.result = getString("status-translating");
  refresh(noDisplay);

  try {
    const result = await service.translate(request, context);
    if (!isCurrent()) return false;
    if (typeof result?.text !== "string" || !result.text.trim()) {
      throw new TranslateError(getString("status-empty-result"));
    }
    task.result = result.text.trim();
    // 先落历史，再把同一条记录交给上下文模块复用。
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
    task.status = "success";
  } catch (e) {
    if (!isCurrent()) return false;
    task.status = "fail";
    if (e instanceof TranslateError) {
      task.error = e.message;
    } else {
      task.error = `${getString("status-request-error")} ${service.id}\n\n${String(
        (e as Error)?.message ?? e,
      )}`;
    }
    task.result = task.partialResult || task.error;
  } finally {
    clearProgress();
    controller.signal.removeEventListener("abort", clearProgress);
    if (running.get(scope) === controller) running.delete(scope);
    if (latestTasks.get(scope) === task && !addon.data.translate.queue.includes(task)) {
      latestTasks.delete(scope);
    }
  }
  refresh(noDisplay);
  return task.status === "success";
}

export function cancelTranslationTask(task?: TranslateTask): boolean {
  if (!task || task.status !== "processing" || latestTasks.get(taskScope(task)) !== task) return false;
  task.status = "cancelled";
  task.result = task.partialResult || getString("status-cancelled");
  running.get(taskScope(task))?.abort();
  refresh(!Boolean(getPref("enablePopup")));
  return true;
}

/** 取队列中最后一个任务。 */
export function getLastTask(itemId?: number, readerId?: string): TranslateTask | undefined {
  const queue = addon.data.translate.queue;
  for (let i = queue.length - 1; i >= 0; i--) {
    const task = queue[i];
    if (readerId ? task.readerId === readerId :
      itemId != null ? historyStore.itemInScope(task.itemId, itemId) : true) return task;
  }
  return undefined;
}

/** 插件关闭后，在途请求不得重新写入历史或刷新已卸载的 UI。 */
export function stopTranslationTasks(): void {
  stopped = true;
  for (const [scope, controller] of running) {
    const task = latestTasks.get(scope);
    if (task) task.status = "cancelled";
    controller.abort();
  }
  running.clear();
  latestTasks.clear();
}

function refresh(noDisplay: boolean) {
  // 阅读器弹窗被关闭时不再刷新它；但侧栏「当前翻译」始终要跟随任务状态更新
  notifyTranslationUpdate(!noDisplay);
}
