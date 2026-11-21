/** 任务和暂存区只发布变化；由生命周期入口决定刷新哪些界面。 */
export interface TranslationUpdate {
  displayPopup: boolean;
  progressOnly?: boolean;
}

const listeners = new Set<(update: TranslationUpdate) => void>();

export function subscribeTranslationUpdates(
  listener: (update: TranslationUpdate) => void,
): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function notifyTranslationUpdate(displayPopup = true, progressOnly = false): void {
  for (const listener of [...listeners]) {
    try {
      listener({ displayPopup, progressOnly });
    } catch (e) {
      // 一个界面刷新失败不能改变翻译结果，或阻止其它界面接收更新。
      Zotero.logError(e instanceof Error ? e : new Error(String(e)));
    }
  }
}
