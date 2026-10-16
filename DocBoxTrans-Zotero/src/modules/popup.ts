import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";
import { getLastTask, createTask, runTranslationTask } from "../utils/task";
import type { RecordPosition } from "../utils/history";
import * as combineStore from "../utils/combineStore";
import type { CombineItem } from "../utils/combineStore";
import { pillStyle, applyDisabledStyle, PILL_PADDING_COMPACT } from "../utils/uiStyle";
import { services } from "./services";
import { refreshHistoryPanes } from "./historyPane";

/** 当前弹窗相关状态（跨调用共享）。 */
interface PopupState {
  currentPopup: HTMLDivElement | null;
  prefix: string;
  selectedText: string;
  itemId: number | undefined;
  /** 当前选区在文档中的位置（仅 PDF 有；用于翻译记录跳转回原文）。 */
  position: RecordPosition | undefined;
  autoTranslated: boolean;
  /**
   * 「已清空上次翻译结果」的文档 itemId：拼接模式下收录新选区后置位（避免把上次译文
   * 误认为本次结果），发起新翻译或退出拼接后清除。
   */
  resultClearedFor: number | undefined;
}

export const popupState: PopupState = {
  currentPopup: null,
  prefix: "",
  selectedText: "",
  itemId: undefined,
  position: undefined,
  autoTranslated: false,
  resultClearedFor: undefined,
};

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

function makeId(type: string): string {
  return `${popupState.prefix}-${type}`;
}

/** 服务切换按钮的样式：当前服务高亮为实心，其余为浅色胶囊。 */
function serviceButtonStyle(active: boolean, fs: number): Record<string, string> {
  return pillStyle(active ? "accent" : "ghost", `${Math.max(11, fs - 1)}px`);
}

/** 一行服务按钮：展示全部已注册服务，点击即切换并重跑当前选区。 */
function serviceButtons(): any[] {
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
          updateServiceButtons();
          rerunWith(getLastTask(), { service: id });
        },
      },
    ],
  }));
}

/** 同步服务按钮的选中态（切换服务后调用）。 */
function updateServiceButtons() {
  const popup = popupState.currentPopup;
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
function applyPopupWidth(text: string) {
  const popup = popupState.currentPopup;
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
  // 「翻译结果窗口」开关关闭时：不向阅读器选择弹窗注入任何翻译界面；
  // 翻译改由「翻译记录」侧栏的「当前翻译」区完成（选区仍会被记录，供其使用）。
  if (!Boolean(getPref("enablePopup"))) {
    popupState.currentPopup = null;
    return;
  }
  const popup = doc.querySelector(".selection-popup") as HTMLDivElement;
  if (!popup) return;
  popupState.currentPopup = popup;
  if (!popupState.prefix) {
    popupState.prefix = `${config.addonRef}-${Zotero.Utilities.randomString(6)}`;
  }
  popup.setAttribute(`${config.addonRef}-prefix`, popupState.prefix);

  const fs = fontSize();
  const popupCls = `${config.addonRef}-readerpopup`;
  const children: any[] = [];

  if (getPref("showServiceSelector")) {
    children.push({
      tag: "div",
      namespace: "html",
      id: makeId("services"),
      classList: [popupCls],
      styles: {
        display: "flex",
        flexWrap: "wrap",
        gap: "4px",
        margin: "2px 0",
      },
      children: serviceButtons(),
      ignoreIfExists: true,
    });
  }

  // 选项行：上下文 / 拼接 / 追加 / 清空 / 翻译（药丸形控件，同一行内排布）
  children.push({
    tag: "div",
    namespace: "html",
    id: makeId("combine-bar"),
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
        id: makeId("combine-toggles"),
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
            id: makeId("context-label"),
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
                id: makeId("context"),
                attributes: { type: "checkbox" },
                properties: { checked: Boolean(getPref("contextEnable")) },
                listeners: [
                  {
                    type: "change",
                    listener: (ev: Event) => {
                      setPref("contextEnable", (ev.target as HTMLInputElement).checked);
                      rerunWith(getLastTask(), {});
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
            id: makeId("combine-label"),
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
                id: makeId("combine"),
                attributes: { type: "checkbox" },
                properties: { checked: combineStore.getMode() },
                listeners: [
                  {
                    type: "change",
                    listener: (ev: Event) => {
                      const checked = (ev.target as HTMLInputElement).checked;
                      combineStore.setMode(checked);
                      if (checked) {
                        // 开启拼接时，顺带把当前选区也收录进来
                        combineStore.add(
                          popupState.itemId,
                          popupState.selectedText,
                          popupState.position,
                        );
                      } else {
                        // 退出拼接：恢复显示上次翻译结果
                        popupState.resultClearedFor = undefined;
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
        id: makeId("combine-add"),
        classList: [popupCls],
        attributes: { type: "button" },
        styles: { ...pillStyle("ghost", `${Math.max(11, fs - 1)}px`, PILL_PADDING_COMPACT) },
        properties: { textContent: getString("combine-add") },
        listeners: [
          {
            type: "click",
            listener: () => {
              addSelectionToCombine();
            },
          },
        ],
        ignoreIfExists: true,
      },
      {
        tag: "button",
        namespace: "html",
        id: makeId("combine-clear"),
        classList: [popupCls],
        attributes: { type: "button" },
        styles: { ...pillStyle("ghost", `${Math.max(11, fs - 1)}px`, PILL_PADDING_COMPACT) },
        properties: { textContent: getString("combine-clear") },
        listeners: [
          {
            type: "click",
            listener: () => {
              combineStore.clear(popupState.itemId);
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
        id: makeId("translate"),
        classList: [popupCls],
        attributes: { type: "button" },
        styles: { ...pillStyle("accent", `${fs}px`, PILL_PADDING_COMPACT) },
        properties: { textContent: getString("popup-translate") },
        listeners: [
          {
            type: "click",
            listener: () => {
              translatePrimary();
            },
          },
        ],
        ignoreIfExists: true,
      },
    ],
    ignoreIfExists: true,
  });

  // 片段胶囊单独一行，不与选项行混在一起（为空时隐藏）
  children.push({
    tag: "div",
    namespace: "html",
    id: makeId("combine-chips"),
    classList: [popupCls],
    styles: { display: "none", flexWrap: "wrap", gap: "4px", margin: "2px 0" },
    ignoreIfExists: true,
  });

  children.push({
    tag: "textarea",
    namespace: "html",
    id: makeId("text"),
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
  applyPopupWidth(popupState.selectedText);
}

/** 刷新弹窗里的结果文本（由 task 管线在状态变化时调用）。 */
export function updateReaderPopup() {
  const popup = popupState.currentPopup;
  if (!popup) return;
  const textarea = popup.querySelector(`#${makeId("text")}`) as HTMLTextAreaElement;
  if (!textarea) return;

  updateCombineUI();

  if (!popupState.selectedText) {
    textarea.value = getString("status-empty-selection");
    applyPopupWidth(textarea.value);
    return;
  }

  const task = getLastTask();
  // 拼接模式下收录了新选区：清空上次译文，避免被误认为本次选区的结果
  textarea.value = isResultClearedFor(popupState.itemId) ? "" : task?.result ?? "";
  textarea.style.fontSize = `${fontSize()}px`;
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(
    TEXTAREA_MAX_HEIGHT,
    Math.max(30, textarea.scrollHeight + 2),
  )}px`;
  // 译文通常比原文更长：按当前展示文本重新适配宽度
  applyPopupWidth(textarea.value || popupState.selectedText);
  updateServiceButtons();
}

/**
 * 在同一弹窗上以新的服务/配置重跑当前选区的翻译。
 * 供阅读器弹窗与「翻译记录」侧栏的「当前翻译」区共用（无任务时用当前选区新建）。
 */
export function rerunWith(
  task: ReturnType<typeof getLastTask>,
  patch: { service?: string },
) {
  // 发起新翻译：取消「上次结果已清空」状态，让结果区重新显示本次译文
  popupState.resultClearedFor = undefined;
  if (!task) {
    // 尚无任务（例如未选中/未自动翻译）：用当前选区新建一个
    const created = createNewTaskFromSelection();
    if (created) runTranslationTask(created);
    return;
  }
  if (patch.service) {
    task.service = patch.service;
  }
  task.result = "";
  task.status = "waiting";
  runTranslationTask(task);
}

/** 用当前选区创建一个任务。 */
export function createNewTaskFromSelection() {
  const selection = popupState.selectedText;
  if (!selection) return undefined;
  return createTask(selection, popupState.itemId, undefined, popupState.position);
}

// ---------------- 拼接翻译（拼合区） ----------------

/** 判断指定文档是否处于「上次翻译结果已被清空」的状态（拼接模式收录新选区后）。 */
export function isResultClearedFor(itemId: number | undefined): boolean {
  return (
    popupState.resultClearedFor != null &&
    itemId != null &&
    popupState.resultClearedFor === itemId
  );
}

/** 拼合区片段数 > 0 时，主「翻译」按钮翻译拼合内容；否则翻译当前选区（与原有行为一致）。 */
export function translatePrimary() {
  const itemId = popupState.itemId;
  if (combineStore.count(itemId) > 0) {
    void translateCombined(itemId);
    return;
  }
  popupState.resultClearedFor = undefined;
  const created = createNewTaskFromSelection();
  if (created) {
    void runTranslationTask(created, { noDisplay: !Boolean(getPref("enablePopup")) });
  } else {
    // 当前没有选区时，退回重跑上一次任务（例如仅切换服务后重译）
    rerunWith(getLastTask(), {});
  }
}

/**
 * 把当前选区加入拼合区（同文档内按文本去重）。
 * 供弹窗按钮、快捷键与「翻译记录」侧栏共用。
 */
export function addSelectionToCombine(): boolean {
  const ok = combineStore.add(
    popupState.itemId,
    popupState.selectedText,
    popupState.position,
  );
  if (ok) refreshCombineViews();
  return ok;
}

/**
 * 一并翻译拼合区：把已收录的片段拼接成一段后创建一个任务；
 * 翻译成功后清空拼合区（失败则保留，便于调整后重试）。
 */
export async function translateCombined(itemId: number | undefined): Promise<boolean> {
  const text = combineStore.join(itemId);
  if (!text) return false;
  // 发起新翻译：结果区重新显示这次拼接译文
  popupState.resultClearedFor = undefined;
  const task = createTask(text, itemId, undefined, combineStore.firstPosition(itemId));
  if (!task) return false;
  const ok = await runTranslationTask(task, {
    noDisplay: !Boolean(getPref("enablePopup")),
  });
  if (ok) combineStore.clear(itemId);
  refreshCombineViews();
  return ok;
}

/** 同步刷新弹窗与侧栏中的拼合区展示（拼合区发生增删/清空时调用）。 */
export function refreshCombineViews() {
  addon.hooks.onReaderPopupRefresh();
  refreshHistoryPanes();
}

/** 主「翻译」按钮的文案：拼合区有内容时显示计数（如「翻译（3）」）。 */
export function primaryTranslateLabel(count: number): string {
  return count > 0
    ? getString("combine-translate", { args: { count } })
    : getString("popup-translate");
}

/** 重渲染弹窗内的拼合区：模式开关、片段胶囊、按钮可用性与主按钮计数。 */
export function updateCombineUI() {
  const popup = popupState.currentPopup;
  if (!popup) return;
  const fs = fontSize();
  const itemId = popupState.itemId;
  const items = combineStore.list(itemId);
  const count = items.length;

  const toggle = popup.querySelector(`#${makeId("combine")}`) as HTMLInputElement | null;
  if (toggle) toggle.checked = combineStore.getMode();

  const addBtn = popup.querySelector(
    `#${makeId("combine-add")}`,
  ) as HTMLButtonElement | null;
  if (addBtn) {
    addBtn.disabled = !popupState.selectedText;
    applyDisabledStyle(addBtn, addBtn.disabled);
  }

  const clearBtn = popup.querySelector(
    `#${makeId("combine-clear")}`,
  ) as HTMLButtonElement | null;
  if (clearBtn) {
    // 始终显示；无片段时置灰不可点
    clearBtn.disabled = count === 0;
    applyDisabledStyle(clearBtn, clearBtn.disabled);
  }

  const trBtn = popup.querySelector(`#${makeId("translate")}`) as HTMLButtonElement | null;
  if (trBtn) {
    trBtn.textContent = primaryTranslateLabel(count);
    trBtn.title = count > 0 ? getString("combine-translateTitle") : "";
  }

  const chips = popup.querySelector(
    `#${makeId("combine-chips")}`,
  ) as HTMLElement | null;
  if (chips) {
    chips.textContent = "";
    chips.style.display = count > 0 ? "flex" : "none";
    for (const it of items) {
      chips.appendChild(makeCombineChip(popup.ownerDocument, itemId, it, fs));
    }
  }
}

/** 拼合区片段胶囊：展示片段摘要，点击移除该片段。 */
function makeCombineChip(
  doc: Document,
  itemId: number | undefined,
  it: CombineItem,
  fs: number,
): HTMLElement {
  const chip = doc.createElement("span");
  chip.className = `${config.addonRef}-combine-chip`;
  chip.textContent = it.text.length > 16 ? `${it.text.slice(0, 16)}…` : it.text;
  chip.title = `${getString("combine-removeTitle")}\n\n${it.text}`;
  chip.style.cssText =
    `display:inline-block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;` +
    `font-size:${Math.max(11, fs - 1)}px;line-height:1.4;padding:1px 8px;border-radius:8px;cursor:pointer;` +
    `background:var(--fill-quaternary, rgba(127,127,127,.15));` +
    `border:1px solid var(--fill-quaternary, rgba(127,127,127,.25));`;
  chip.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (combineStore.remove(itemId, it.id)) refreshCombineViews();
  });
  return chip;
}
