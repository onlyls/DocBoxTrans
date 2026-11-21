import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";
import { getLastTask } from "../utils/task";
import * as combineStore from "../utils/combineStore";
import { pillStyle, applyDisabledStyle, PILL_PADDING_COMPACT } from "../utils/uiStyle";
import { services } from "./services";
import { rerunWith, translatePrimary, addSelectionToCombine, refreshCombineViews, forceRetranslate } from "./translationActions";

import { buildCombineChip } from "./combineChips";
import { primaryActionLabel, taskStatusText } from "./translationControls";
import { getReaderState, getReaderStates, type ReaderState } from "./readerState";

/** 弹窗宽度夹取范围（按文本长度自适应，避免长译文被挤在窄框里）。 */
const MIN_POPUP_WIDTH = 300;
const MAX_POPUP_WIDTH = 640;
/** 译文框最大高度。 */
const TEXTAREA_MAX_HEIGHT = 240;
/** 服务按钮使用的数据属性名（记录服务 id）。 */
const SERVICE_ATTR = "data-service";

function fontSize(): number {
  const n = Number(getPref("fontSize"));
  return Number.isFinite(n) && n > 0 ? n : 12;
}

function makeId(state: ReaderState, type: string): string {
  return `${state.prefix}-${type}`;
}

/** 服务切换按钮的样式：当前服务高亮为实心，其余为浅色胶囊。 */
function serviceButtonStyle(active: boolean, fs: number): Record<string, string> {
  return pillStyle(active ? "accent" : "ghost", `${Math.max(11, fs - 1)}px`);
}

/** 一行服务按钮：展示全部已注册服务，点击即切换并重跑当前选区。 */
function serviceButtons(state: ReaderState): any[] {
  const fs = fontSize();
  const current = String(getPref("translateSource") || "llm");
  return services.getAll().map((s) => ({
    tag: "button",
    namespace: "html",
    attributes: { type: "button", [SERVICE_ATTR]: s.id },
    classList: [`${config.addonRef}-readerpopup`, `${config.addonRef}-service-btn`],
    styles: serviceButtonStyle(s.id === current, fs),
    properties: { textContent: services.getDisplayName(s.id) },
    listeners: [
      {
        type: "click",
        listener: (ev: Event) => {
          const btn = (ev.currentTarget ?? ev.target) as HTMLElement;
          const id = btn.getAttribute(SERVICE_ATTR) || "";
          if (!id) return;
          if (String(getPref("translateSource")) !== id) {
            setPref("translateSource", id);
          }
          updateServiceButtons(state);
          rerunWith(getLastTask(state.itemId, state.readerId), { service: id }, state);
        },
      },
    ],
  }));
}

/** 同步服务按钮的选中态（切换服务后调用）。 */
function updateServiceButtons(state: ReaderState) {
  const popup = state.currentPopup;
  if (!popup) return;
  const current = String(getPref("translateSource") || "llm");
  const fs = fontSize();
  popup
    .querySelectorAll(`.${config.addonRef}-service-btn`)
    .forEach((el: Element) => {
      const isActive = el.getAttribute(SERVICE_ATTR) === current;
      Object.assign((el as HTMLElement).style, serviceButtonStyle(isActive, fs));
    });
}

/** 按文本长度估算合适的弹窗宽度。 */
function desiredPopupWidth(text: string): number {
  const len = (text || "").replace(/\s+/g, " ").trim().length;
  const raw = MIN_POPUP_WIDTH + Math.max(0, len - 40) * 1.6;
  return Math.round(Math.min(MAX_POPUP_WIDTH, Math.max(MIN_POPUP_WIDTH, raw)));
}

/** 按当前展示文本调整阅读器弹窗宽度，并保证不超出阅读器可视范围。 */
function applyPopupWidth(state: ReaderState, text: string) {
  const popup = state.currentPopup;
  if (!popup) return;
  popup.style.maxWidth = "none";
  let width = desiredPopupWidth(text);
  try {
    const body = popup.ownerDocument.body;
    const maxByViewport = body.clientWidth - popup.offsetLeft - 24;
    width = Math.min(width, Math.max(MIN_POPUP_WIDTH, maxByViewport));
  } catch {
    // 布局不可用时按估算宽度渲染
  }
  popup.style.width = `${width}px`;
}

/** 选中文本后在阅读器选择弹窗里插入「服务选择 / 上下文开关 / 翻译按钮 / 结果框」。 */
export function buildReaderPopup(
  event: _ZoteroTypes.Reader.EventParams<"renderTextSelectionPopup">,
) {
  const { doc, append } = event;
  const state = getReaderState(event.reader);
  // 「翻译结果窗口」开关关闭时：不向阅读器选择弹窗注入任何翻译界面；
  // 翻译改由「翻译记录」侧栏的「当前翻译」区完成（选区仍会被记录，供其使用）。
  if (!Boolean(getPref("enablePopup"))) {
    state.currentPopup = null;
    return;
  }
  const popup = doc.querySelector(".selection-popup") as HTMLDivElement;
  if (!popup) return;
  state.currentPopup = popup;
  if (!state.prefix) {
    state.prefix = `${config.addonRef}-${Zotero.Utilities.randomString(6)}`;
  }
  popup.setAttribute(`${config.addonRef}-prefix`, state.prefix);

  const fs = fontSize();
  const popupCls = `${config.addonRef}-readerpopup`;
  const children: any[] = [];

  if (getPref("showServiceSelector")) {
    children.push({
      tag: "div",
      namespace: "html",
      id: makeId(state, "services"),
      classList: [popupCls],
      styles: {
        display: "flex",
        flexWrap: "wrap",
        gap: "4px",
        margin: "2px 0",
      },
      children: serviceButtons(state),
      ignoreIfExists: true,
    });
  }

  // 选项行：上下文 / 拼接 / 追加 / 清空 / 翻译（药丸形控件，同一行内排布）
  children.push({
    tag: "div",
    namespace: "html",
    id: makeId(state, "combine-bar"),
    classList: [popupCls],
    styles: {
      display: "flex",
      flexWrap: "wrap",
      alignItems: "center",
      gap: "4px",
      margin: "2px 0",
    },
    children: [
      {
        // 上下文 + 拼接 放进同一个胶囊，减小占用宽度
        tag: "div",
        namespace: "html",
        id: makeId(state, "combine-toggles"),
        styles: {
          ...pillStyle("ghost", `${fs}px`, PILL_PADDING_COMPACT),
          display: "flex",
          alignItems: "center",
          gap: "4px",
        },
        children: [
          {
            tag: "label",
            namespace: "html",
            id: makeId(state, "context-label"),
            styles: {
              display: "flex",
              alignItems: "center",
              gap: "4px",
              cursor: "pointer",
              whiteSpace: "nowrap",
            },
            properties: { title: getString("popup-context-title") },
            children: [
              {
                tag: "input",
                namespace: "html",
                id: makeId(state, "context"),
                attributes: { type: "checkbox" },
                properties: { checked: Boolean(getPref("contextEnable")) },
                listeners: [
                  {
                    type: "change",
                    listener: (ev: Event) => {
                      setPref("contextEnable", (ev.target as HTMLInputElement).checked);
                      rerunWith(getLastTask(state.itemId, state.readerId), {}, state);
                    },
                  },
                ],
                ignoreIfExists: true,
              },
              {
                tag: "span",
                namespace: "html",
                properties: { textContent: getString("popup-context") },
              },
            ],
            ignoreIfExists: true,
          },
          {
            tag: "span",
            namespace: "html",
            properties: { textContent: "" },
            styles: {
              width: "1px",
              height: "12px",
              flex: "none",
              background: "var(--fill-quaternary, rgba(127,127,127,.35))",
            },
          },
          {
            tag: "label",
            namespace: "html",
            id: makeId(state, "combine-label"),
            styles: {
              display: "flex",
              alignItems: "center",
              gap: "4px",
              cursor: "pointer",
              whiteSpace: "nowrap",
            },
            properties: { title: getString("popup-combine-title") },
            children: [
              {
                tag: "input",
                namespace: "html",
                id: makeId(state, "combine"),
                attributes: { type: "checkbox" },
                properties: { checked: combineStore.getMode() },
                listeners: [
                  {
                    type: "change",
                    listener: (ev: Event) => {
                      const checked = (ev.target as HTMLInputElement).checked;
                      combineStore.setMode(checked);
                      // 开启拼接只切换模式，不收录任何已有选区（含上次残留的选区）：
                      // 片段由拼接模式下的新选区自动加入，或由用户主动点「追加」
                      if (!checked) {
                        // 退出拼接：恢复显示上次翻译结果
                        getReaderStates().forEach((readerState) => { readerState.resultCleared = false; });
                      }
                      refreshCombineViews();
                    },
                  },
                ],
                ignoreIfExists: true,
              },
              {
                tag: "span",
                namespace: "html",
                properties: { textContent: getString("popup-combine") },
              },
            ],
            ignoreIfExists: true,
          },
        ],
        ignoreIfExists: true,
      },
      {
        tag: "button",
        namespace: "html",
        id: makeId(state, "combine-add"),
        classList: [popupCls],
        attributes: { type: "button" },
        styles: { ...pillStyle("ghost", `${Math.max(11, fs - 1)}px`, PILL_PADDING_COMPACT) },
        properties: { textContent: getString("combine-add") },
        listeners: [
          {
            type: "click",
            listener: () => {
              addSelectionToCombine(state);
            },
          },
        ],
        ignoreIfExists: true,
      },
      {
        tag: "button",
        namespace: "html",
        id: makeId(state, "combine-clear"),
        classList: [popupCls],
        attributes: { type: "button" },
        styles: { ...pillStyle("ghost", `${Math.max(11, fs - 1)}px`, PILL_PADDING_COMPACT) },
        properties: { textContent: getString("combine-clear") },
        listeners: [
          {
            type: "click",
            listener: () => {
              combineStore.clear(state.itemId);
              refreshCombineViews();
            },
          },
        ],
        ignoreIfExists: true,
      },
      {
        // 主「翻译」按钮：拼合区有内容时显示计数（如「翻译（3）」）
        tag: "button",
        namespace: "html",
        id: makeId(state, "translate"),
        classList: [popupCls],
        attributes: { type: "button" },
        styles: { ...pillStyle("accent", `${fs}px`, PILL_PADDING_COMPACT) },
        properties: { textContent: getString("popup-translate") },
        listeners: [
          {
            type: "click",
            listener: () => {
              translatePrimary(state);
            },
          },
        ],
        ignoreIfExists: true,
      },
      {
        tag: "button", namespace: "html", id: makeId(state, "force"),
        attributes: { type: "button" },
        styles: pillStyle("ghost", `${fs}px`, PILL_PADDING_COMPACT),
        properties: { textContent: getString("popup-force"), title: getString("popup-force-title") },
        listeners: [{ type: "click", listener: () => {
          void forceRetranslate(state);
        } }],
        ignoreIfExists: true,
      },
    ],
    ignoreIfExists: true,
  });

  // 片段胶囊单独一行，不与选项行混在一起（为空时隐藏）
  children.push({
    tag: "div",
    namespace: "html",
    id: makeId(state, "combine-chips"),
    classList: [popupCls],
    styles: { display: "none", flexWrap: "wrap", gap: "4px", margin: "2px 0" },
    ignoreIfExists: true,
  });

  children.push({
    tag: "div", namespace: "html", id: makeId(state, "status"),
    attributes: { role: "status" },
    styles: { fontSize: "0.85em", opacity: "0.7", whiteSpace: "pre-wrap" },
    ignoreIfExists: true,
  });

  children.push({
    tag: "textarea",
    namespace: "html",
    id: makeId(state, "text"),
    classList: [popupCls],
    attributes: { rows: "3", readonly: "true" },
    styles: {
      width: "100%",
      minHeight: "30px",
      maxHeight: `${TEXTAREA_MAX_HEIGHT}px`,
      margin: "2px 0",
      border: "none",
      borderRadius: "6px",
      padding: "5px",
      background: "var(--color-sidepane)",
      fontFamily: "inherit",
      lineHeight: "1.5",
      fontSize: `${fs}px`,
      resize: "vertical",
      boxSizing: "border-box",
    },
    properties: { spellcheck: false, value: "" },
    ignoreIfExists: true,
  });

  append(ztoolkit.UI.createElement(doc, "fragment", { children }));
  // 弹窗宽度随选区文本长度自适应
  applyPopupWidth(state, state.selectedText);
}

/** 刷新弹窗里的结果文本（由 task 管线在状态变化时调用）。 */
export function updateReaderPopup(state?: ReaderState, progressOnly = false) {
  if (!state) {
    for (const readerState of getReaderStates()) {
      try { updateReaderPopup(readerState, progressOnly); } catch (e) {
        Zotero.debug(`[DocBoxTrans] 更新阅读器弹窗失败: ${String(e)}`);
      }
    }
    return;
  }
  const popup = state.currentPopup;
  if (!popup) return;
  const textarea = popup.querySelector(`#${makeId(state, "text")}`) as HTMLTextAreaElement;
  if (!textarea) return;

  if (!progressOnly) updateCombineUI(state);
  const task = getLastTask(state.itemId, state.readerId);
  const status = popup.querySelector(`#${makeId(state, "status")}`);
  if (status) status.textContent = state.resultCleared ? "" : taskStatusText(task);

  if (!state.selectedText && !task) {
    textarea.value = getString("status-empty-selection");
    applyPopupWidth(state, textarea.value);
    return;
  }

  // 拼接模式下收录了新选区：清空上次译文，避免被误认为本次选区的结果
  textarea.value = state.resultCleared ? "" : task?.result ?? "";
  textarea.style.fontSize = `${fontSize()}px`;
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(
    TEXTAREA_MAX_HEIGHT,
    Math.max(30, textarea.scrollHeight + 2),
  )}px`;
  // 译文通常比原文更长：按当前展示文本重新适配宽度
  applyPopupWidth(state, textarea.value || state.selectedText);
  updateServiceButtons(state);
}

/** 重渲染弹窗内的拼合区：模式开关、片段胶囊、按钮可用性与主按钮计数。 */
export function updateCombineUI(state: ReaderState) {
  const popup = state.currentPopup;
  if (!popup) return;
  const itemId = state.itemId;
  const items = combineStore.list(itemId);
  const count = items.length;

  const toggle = popup.querySelector(`#${makeId(state, "combine")}`) as HTMLInputElement | null;
  if (toggle) toggle.checked = combineStore.getMode();

  const addBtn = popup.querySelector(
    `#${makeId(state, "combine-add")}`,
  ) as HTMLButtonElement | null;
  if (addBtn) {
    addBtn.disabled = !state.selectedText;
    applyDisabledStyle(addBtn, addBtn.disabled);
  }

  const clearBtn = popup.querySelector(
    `#${makeId(state, "combine-clear")}`,
  ) as HTMLButtonElement | null;
  if (clearBtn) {
    // 始终显示；无片段时置灰不可点
    clearBtn.disabled = count === 0;
    applyDisabledStyle(clearBtn, clearBtn.disabled);
  }

  const trBtn = popup.querySelector(`#${makeId(state, "translate")}`) as HTMLButtonElement | null;
  if (trBtn) {
    trBtn.textContent = primaryActionLabel(getLastTask(itemId, state.readerId), count);
    trBtn.title = count > 0 ? getString("combine-translateTitle") : "";
  }

  const force = popup.querySelector(`#${makeId(state, "force")}`) as HTMLButtonElement | null;
  if (force) {
    const task = getLastTask(itemId, state.readerId);
    force.disabled = task?.status === "processing" || !(count || task || state.selectedText);
    applyDisabledStyle(force, force.disabled);
  }

  const chips = popup.querySelector(
    `#${makeId(state, "combine-chips")}`,
  ) as HTMLElement | null;
  if (chips) {
    chips.textContent = "";
    chips.style.display = count > 0 ? "flex" : "none";
    items.forEach((item, index) => chips.appendChild(buildCombineChip(popup.ownerDocument, itemId, item, index, count)));
  }
}
