import { getPref } from "../utils/prefs";
import { getString } from "../utils/locale";
import { createTask, getLastTask, runTranslationTask, cancelTranslationTask } from "../utils/task";
import { notifyTranslationUpdate } from "../utils/translationEvents";
import * as combineStore from "../utils/combineStore";
import type { ReaderState } from "./readerState";

/**
 * 在同一弹窗上以新的服务/配置重跑当前选区的翻译。
 * 供阅读器弹窗与「翻译记录」侧栏的「当前翻译」区共用（无任务时用当前选区新建）。
 */
export function rerunWith(
  task: ReturnType<typeof getLastTask>,
  patch: { service?: string; force?: boolean },
  state?: ReaderState,
) {
  if (state) state.resultCleared = false;
  // 每次重译使用新对象，旧请求即使晚返回也不能改写新任务。
  // 配置默认服务或隐藏旧服务不自动重译；下一次操作使用当前前台选中的服务。
  const created = task
    ? createTask(task.originalRaw ?? task.raw, task.itemId,
        patch.service || String(getPref("translateSource") || task.service),
        task.position, task.combined, task.readerId, task.isPdf)
    : state ? createNewTaskFromSelection(state, patch.service) : undefined;
  if (created) void runTranslationTask(created, {
    noDisplay: !Boolean(getPref("enablePopup")),
    force: patch.force,
  });
  return created;
}

/** 用当前阅读器选区创建一个任务。 */
export function createNewTaskFromSelection(state: ReaderState, service?: string) {
  if (!state.selectedText) return undefined;
  return createTask(state.selectedText, state.itemId, service, state.position,
    undefined, state.readerId, state.isPdf);
}

/** 有拼接片段时强制重译当前拼接内容，否则重译当前任务或选区。 */
export function forceRetranslate(state?: ReaderState, task?: ReturnType<typeof getLastTask>) {
  if (state && combineStore.count(state.itemId) > 0) {
    return translateCombined(state.itemId, state, true);
  }
  return rerunWith(task ?? (state ? getLastTask(state.itemId, state.readerId) : undefined),
    { force: true }, state);
}

// ---------------- 拼接翻译（拼合区） ----------------

/** 拼合区片段数 > 0 时，主「翻译」按钮翻译拼合内容；否则翻译当前选区（与原有行为一致）。 */
export function translatePrimary(state: ReaderState) {
  if (cancelTranslationTask(getLastTask(state.itemId, state.readerId))) return;
  const itemId = state.itemId;
  if (combineStore.count(itemId) > 0) {
    void translateCombined(itemId, state);
    return;
  }
  state.resultCleared = false;
  const created = createNewTaskFromSelection(state);
  if (created) {
    void runTranslationTask(created, { noDisplay: !Boolean(getPref("enablePopup")) });
  } else {
    // 当前没有选区时，退回重跑上一次任务（例如仅切换服务后重译）
    rerunWith(getLastTask(state.itemId, state.readerId), {}, state);
  }
}

/**
 * 把当前选区加入拼合区（同文档内按文本去重）。
 * 供弹窗按钮、快捷键与「翻译记录」侧栏共用。
 */
export function addSelectionToCombine(state: ReaderState): boolean {
  const ok = combineStore.add(
    state.itemId,
    state.selectedText,
    state.position,
    state.isPdf,
  );
  if (ok) refreshCombineViews();
  return ok;
}

/**
 * 一并翻译拼合区：把已收录的片段拼接成一段后创建一个任务；
 * 翻译成功后只清空「本次已送入翻译」的片段（失败则保留，便于调整后重试）。
 * 只清理快照片段，避免翻译进行期间新收录的片段被一并清掉。
 */
export async function translateCombined(
  itemId: number | undefined, state?: ReaderState, force = false,
): Promise<boolean> {
  const items = combineStore.list(itemId);
  const text = combineStore.join(itemId);
  if (!text) return false;
  // 发起新翻译：结果区重新显示这次拼接译文
  if (state) state.resultCleared = false;
  const task = createTask(
    text,
    itemId,
    undefined,
    combineStore.firstPosition(itemId),
    true,
    state?.readerId,
  );
  if (!task) return false;
  const ok = await runTranslationTask(task, {
    noDisplay: !Boolean(getPref("enablePopup")),
    force,
  });
  if (ok) {
    for (const it of items) combineStore.remove(itemId, it.id);
  }
  refreshCombineViews();
  return ok;
}

/** 同步刷新弹窗与侧栏中的拼合区展示（拼合区发生增删/清空时调用）。 */
export function refreshCombineViews() {
  notifyTranslationUpdate();
}

/** 主「翻译」按钮的文案：拼合区有内容时显示计数（如「翻译（3）」）。 */
export function primaryTranslateLabel(count: number): string {
  return count > 0
    ? getString("combine-translate", { args: { count } })
    : getString("popup-translate");
}
