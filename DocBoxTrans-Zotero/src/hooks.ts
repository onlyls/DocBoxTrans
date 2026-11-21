import { config } from "../package.json";
import { KeyModifier } from "zotero-plugin-toolkit";
import { initLocale } from "./utils/locale";
import { getPref } from "./utils/prefs";
import { registerPrefsWindow, registerPrefsScripts } from "./modules/preferenceWindow";
import { setDefaultPrefs } from "./modules/defaultPrefs";
import { registerReaderInitializer } from "./modules/reader";
import { registerHistoryPane, refreshHistoryPanes, refreshHistoryCurrent, unregisterHistoryPane } from "./modules/historyPane";
import * as historyStore from "./utils/historyStore";
import * as combineStore from "./utils/combineStore";
import {
  installGoogleProxyFilter,
  uninstallGoogleProxyFilter,
} from "./utils/http";
import { buildReaderPopup, updateReaderPopup } from "./modules/popup";
import { addSelectionToCombine, createNewTaskFromSelection, translateCombined } from "./modules/translationActions";
import { subscribeTranslationUpdates } from "./utils/translationEvents";

import { runTranslationTask, stopTranslationTasks } from "./utils/task";
import { clearReaderStates, getActiveReaderState, getReaderState } from "./modules/readerState";

let unsubscribeTranslationUpdates: (() => void) | undefined;

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();
  unsubscribeTranslationUpdates?.();
  const unsubscribePopup = subscribeTranslationUpdates(({ displayPopup, progressOnly }) => {
    if (displayPopup) updateReaderPopup(undefined, progressOnly);
  });
  const unsubscribePanes = subscribeTranslationUpdates(({ progressOnly }) => {
    if (progressOnly) refreshHistoryCurrent(); else refreshHistoryPanes();
  });
  unsubscribeTranslationUpdates = () => { unsubscribePopup(); unsubscribePanes(); };
  historyStore.setStorageStateListener(refreshHistoryPanes);
  try {
    registerHistoryShutdown();
  } catch (e) {
    Zotero.logError(e instanceof Error ? e : new Error(String(e)));
  }
  setDefaultPrefs();

  // 逐步注册：任一步失败都不影响其它功能，并把原因写入 Zotero 调试输出（帮助 → 调试输出）
  try {
    await historyStore.ensureLoaded();
  } catch (e) {
    Zotero.debug(`[DocBoxTrans] 读取翻译历史失败: ${String(e)}`);
  }
  try {
    registerReaderInitializer();
  } catch (e) {
    Zotero.debug(`[DocBoxTrans] 注册阅读器事件失败: ${String(e)}`);
  }
  try {
    registerPrefsWindow();
  } catch (e) {
    Zotero.debug(`[DocBoxTrans] 注册设置面板失败: ${String(e)}`);
  }
  try {
    registerHistoryPane();
  } catch (e) {
    Zotero.debug(`[DocBoxTrans] 注册翻译记录侧栏失败: ${String(e)}`);
  }
  try {
    registerCombineShortcuts();
  } catch (e) {
    Zotero.debug(`[DocBoxTrans] 注册拼接翻译快捷键失败: ${String(e)}`);
  }
  try {
    installGoogleProxyFilter();
  } catch (e) {
    Zotero.debug(`[DocBoxTrans] 安装谷歌代理过滤器失败: ${String(e)}`);
  }

  await Promise.all(Zotero.getMainWindows().map((win) => onMainWindowLoad(win)));
}

// APP_SHUTDOWN 不调用插件卸载钩子，使用异步屏障等待最后一批历史落盘。
interface HistoryShutdownClient {
  addBlocker(name: string, blocker: () => Promise<void>): void;
  removeBlocker(blocker: () => Promise<void>): void;
}
let shutdownClient: HistoryShutdownClient | undefined;
let shutdownBlocker: (() => Promise<void>) | undefined;

function registerHistoryShutdown() {
  // 使用 IOUtils 自己的屏障，确保此时仍接受新的磁盘写入。
  shutdownClient = IOUtils.profileBeforeChange as HistoryShutdownClient;
  shutdownBlocker = async () => {
    stopTranslationTasks();
    try {
      await historyStore.flush();
    } catch (e) {
      Zotero.logError(e instanceof Error ? e : new Error(String(e)));
    }
  };
  shutdownClient.addBlocker("DocBoxTrans: save translation history", shutdownBlocker);
}

function unregisterHistoryShutdown() {
  if (shutdownClient && shutdownBlocker) shutdownClient.removeBlocker(shutdownBlocker);
  shutdownClient = undefined;
  shutdownBlocker = undefined;
}

/** 拼接翻译快捷键：把当前选区加入拼合区 / 一并翻译拼合区。留空表示不启用。 */
function registerCombineShortcuts() {
  ztoolkit.Keyboard.register((ev, data) => {
    if (data.type !== "keydown" || ev.repeat) return;
    if (isEditableTarget(ev.target)) return;
    const addKey = String(getPref("combineAddShortcut") || "").trim();
    const trKey = String(getPref("combineTranslateShortcut") || "").trim();
    if (!addKey && !trKey) return;
    const state = getActiveReaderState(ev.view ?? (ev.target as Node)?.ownerDocument?.defaultView);
    if (!state) return;
    const keyboard = new KeyModifier(ev);
    if (addKey && keyboard.equals(addKey)) {
      ev.preventDefault();
      ev.stopPropagation();
      addSelectionToCombine(state);
    } else if (trKey && keyboard.equals(trKey)) {
      ev.preventDefault();
      ev.stopPropagation();
      void translateCombined(state.itemId, state);
    }
  });
}

/** 输入框/可编辑区域内不触发拼接快捷键，避免干扰正常输入。 */
function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  const tag = el.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || el.isContentEditable === true;
}

async function onMainWindowLoad(win: Window) {
  await new Promise<void>((resolve) => {
    if (win.document.readyState === "complete") {
      resolve();
      return;
    }
    win.document.addEventListener("readystatechange", () => {
      if (win.document.readyState === "complete") resolve();
    });
  });

  (win as any).MozXULElement.insertFTLIfNeeded(
    `${config.addonRef}-mainWindow.ftl`,
  );
}

function onMainWindowUnload(win: Window) {
  win.document
    .querySelector(`[href="${config.addonRef}-mainWindow.ftl"]`)
    ?.remove();
}

function onShutdown(): Promise<void> {
  // 快速禁用/启用时，共享同一次关闭操作，启动端会等待其落盘结束。
  return addon.data.shutdownPromise ??= shutdownAddon();
}

async function shutdownAddon() {
  addon.data.alive = false;
  unsubscribeTranslationUpdates?.();
  unsubscribeTranslationUpdates = undefined;
  try {
    unregisterHistoryPane();
  } catch (e) {
    Zotero.logError(e instanceof Error ? e : new Error(String(e)));
  }
  stopTranslationTasks();
  try {
    await historyStore.flush();
  } catch (e) {
    Zotero.logError(e instanceof Error ? e : new Error(String(e)));
  }
  unregisterHistoryShutdown();
  historyStore.setStorageStateListener(undefined);
  clearReaderStates();
  try {
    uninstallGoogleProxyFilter();
  } catch (e) {
    Zotero.debug(`[DocBoxTrans] 卸载谷歌代理过滤器失败: ${String(e)}`);
  }
  ztoolkit.unregisterAll();
  Zotero.getMainWindows().forEach((win) => onMainWindowUnload(win));
  delete (Zotero as any)[config.addonInstance];
}

/** 偏好面板打开时触发。 */
function onPrefsLoad(event: Event) {
  registerPrefsScripts((event.target as any).ownerGlobal);
}

/** 选中文本、构建弹窗后：创建任务，若开启「自动翻译」则立即翻译。 */
function onReaderPopupShow(
  event: _ZoteroTypes.Reader.EventParams<"renderTextSelectionPopup">,
) {
  const state = getReaderState(event.reader);
  buildReaderPopup(event);

  if (!state.selectedText) {
    updateReaderPopup();
    return;
  }

  // 拼接模式：把新选区自动加入拼合区，并暂停「选中文本后自动翻译」（翻译由「翻译」按钮/快捷键触发）
  if (combineStore.getMode()) {
    // 仅在确实收录了新片段时清空上次翻译结果：重复选中同一段落时保留原结果，
    // 避免把已有译文误清空
    if (addSelectionToCombine(state)) {
      state.resultCleared = true;
    }
    updateReaderPopup();
    refreshHistoryPanes();
    return;
  }

  // 非拼接模式：本次选区会产生新结果，取消「已清空」状态
  state.resultCleared = false;
  const task = createNewTaskFromSelection(state);
  updateReaderPopup();
  // 侧栏「当前翻译」区需即时反映新选区（未翻译时先显示待翻译状态）
  refreshHistoryPanes();
  if (task && Boolean(getPref("enableAuto")) && !state.autoTranslated) {
    state.autoTranslated = true;
    // 阅读器弹窗被关闭时不把结果显示到弹窗；结果统一出现在「翻译记录」侧栏
    runTranslationTask(task, { noDisplay: !Boolean(getPref("enablePopup")) });
  }
}

function onReaderPopupRefresh() {
  updateReaderPopup();
}

export default {
  onStartup,
  onMainWindowLoad,
  onMainWindowUnload,
  onShutdown,
  onPrefsLoad,
  onReaderPopupShow,
  onReaderPopupRefresh,
};
