import { config } from "../../../package.json";
import { getString } from "../../utils/locale";
import * as historyStore from "../../utils/historyStore";
import { getPref, setPref } from "../../utils/prefs";
import { getLastTask, cancelTranslationTask } from "../../utils/task";
import * as combineStore from "../../utils/combineStore";
import { applyDisabledStyle } from "../../utils/uiStyle";
import { services } from "../services";
import { buildServiceManagerButton } from "../serviceVisibility";
import { selectService } from "../serviceConfig";
import { rerunWith, translateCombined, refreshCombineViews, addSelectionToCombine, forceRetranslate } from "../translationActions";
import { buildCombineChip } from "../combineChips";
import { primaryActionLabel, taskStatusText } from "../translationControls";
import { getReaderStateForItem, getReaderStates } from "../readerState";
import { readScope, readTabType, combineItemId } from "./scope";
import type { PaneScope } from "./types";
import { paneServiceBtnStyle, pillBtn, pillToggleGroup } from "./controls";
import { makeTagChip, buildTagEditor } from "./tags";

/**
 * 渲染面板顶部「当前翻译」区：只展示译文（不折叠），并带上下文/拼接选项、服务切换与「翻译」入口。
 * 与下方列表同源：任务成功后会在列表中同时出现，可按需打标签。
 * 仅在阅读器侧栏展示；文献条目面板只需要「翻译记录」列表，故直接把该区隐藏。
 */
function refreshCurrent(root: HTMLElement, doc: Document, onChanged: () => void) {
  const box = root.querySelector(
    `.${config.addonRef}-history-current`,
  ) as HTMLElement | null;
  if (!box) return;
  // 文献条目面板：隐藏顶部的「本次翻译结果」区（服务/上下文/拼接/译文/标签一并隐藏）
  if (readTabType(root) !== "reader") {
    box.textContent = "";
    box.style.display = "none";
    return;
  }
  box.style.display = "";
  box.textContent = "";

  const scope = readScope(root);
  const state = getReaderStateForItem(combineItemId(scope), root.ownerDocument.defaultView);
  const task = getLastTask(scope.id, state?.readerId);
  // 拼接模式下收录了新选区：本范围内的上次译文视为已清空，不显示
  const resultCleared = state?.resultCleared ?? false;
  const cur =
    !resultCleared && task && historyStore.itemInScope(task.itemId, scope.id)
      ? task
      : undefined;

  // 服务切换 + 翻译入口
  const row = doc.createElement("div");
  row.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:4px;";

  const current = String(getPref("translateSource") || "llm");
  for (const s of services.getVisible()) {
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.textContent = services.getDisplayName(s.id);
    btn.setAttribute("aria-pressed", String(s.id === current));
    btn.style.cssText = paneServiceBtnStyle(s.id === current) +
      "max-width:100%;white-space:normal;overflow-wrap:anywhere;";
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      rerunCurrent(root, s.id, onChanged);
    });
    row.appendChild(btn);
  }
  row.appendChild(buildServiceManagerButton(doc));
  box.appendChild(row);

  // 拼接翻译：单行内「拼接模式 + 加入当前选区 + 清空 + 翻译（计数）+ 片段胶囊」
  box.appendChild(buildCombineArea(root, doc, scope, onChanged));

  // 译文：完整展示、不做折叠（用户可在此直接阅读本次结果）
  const res = doc.createElement("div");
  res.className = `${config.addonRef}-history-result`;
  res.textContent = cur && cur.result ? cur.result : getString("history-currentEmpty");
  res.style.cssText =
    "line-height:1.5;white-space:pre-wrap;word-break:break-word;" +
    "background:var(--fill-quaternary, rgba(127,127,127,.08));" +
    "border-radius:6px;padding:5px;";
  box.appendChild(res);
  const status = doc.createElement("div");
  status.className = `${config.addonRef}-history-status`;
  status.setAttribute("role", "status");
  status.textContent = taskStatusText(cur);
  status.style.cssText = "font-size:0.8em;opacity:.7;white-space:pre-wrap;";
  box.appendChild(status);

  // 标签：本次结果已落为历史记录时，提供与列表卡片一致的增删标签能力
  const rec = cur && cur.recordId ? historyStore.getById(cur.recordId) : undefined;
  if (!rec) return;

  const tagWrap = doc.createElement("div");
  tagWrap.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:4px;";
  for (const t of rec.tags ?? []) {
    tagWrap.appendChild(makeTagChip(doc, rec, t, onChanged));
  }

  const editor = buildTagEditor(doc, rec, onChanged);
  const addBtn = doc.createElement("button");
  addBtn.type = "button";
  addBtn.textContent = "+";
  addBtn.title = getString("history-addTag");
  addBtn.style.cssText =
    "flex:none;width:18px;height:18px;line-height:1;padding:0;border-radius:9px;" +
    "border:1px dashed var(--fill-quaternary, rgba(127,127,127,.5));background:transparent;" +
    "color:inherit;cursor:pointer;font-size:13px;";
  addBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    editor.open();
  });
  tagWrap.appendChild(addBtn);

  box.appendChild(tagWrap);
  box.appendChild(editor.wrap);
}

/** 选项行：上下文 / 拼接 / 追加 / 清空 / 翻译（计数）；片段胶囊另起一行。 */
function buildCombineArea(
  root: HTMLElement,
  doc: Document,
  scope: PaneScope,
  onChanged: () => void,
): HTMLElement {
  const itemId = combineItemId(scope);
  const state = getReaderStateForItem(itemId, doc.defaultView);
  const items = combineStore.list(itemId);
  const count = items.length;
  const task = getLastTask(scope.id, state?.readerId);

  const wrap = doc.createElement("div");
  wrap.style.cssText = "display:flex;flex-direction:column;gap:4px;margin-top:2px;";

  const row = doc.createElement("div");
  row.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:4px;";

  // 上下文 + 拼接 放进同一个胶囊，减小占用宽度
  row.appendChild(
    pillToggleGroup(doc, [
      {
        checked: Boolean(getPref("contextEnable")),
        label: getString("popup-context"),
        title: getString("popup-context-title"),
        onChange: (v) => {
          setPref("contextEnable", v);
          rerunCurrent(root, undefined, onChanged);
        },
      },
      {
        checked: combineStore.getMode(),
        label: getString("popup-combine"),
        title: getString("popup-combine-title"),
        onChange: (v) => {
          combineStore.setMode(v);
          // 开启拼接只切换模式，不收录任何已有选区：片段由拼接模式下的新选区自动加入，
          // 或由用户主动点「追加」，避免把上次选中的段落（甚至已翻译的）重新带入拼合区
          if (!v) {
            // 退出拼接：恢复显示上次翻译结果
            getReaderStates().forEach((state) => { state.resultCleared = false; });
          }
          refreshCombineViews();
        },
      },
    ]),
  );

  // 追加（把当前选区加入拼合区）
  const canAdd = Boolean(state?.selectedText) && state?.itemId === itemId;
  const addBtn = pillBtn(doc, getString("combine-add"), "ghost", () => {
    if (state) addSelectionToCombine(state);
  });
  addBtn.disabled = !canAdd;
  applyDisabledStyle(addBtn, !canAdd);
  if (!canAdd) addBtn.title = getString("combine-addSelectionTitle");
  row.appendChild(addBtn);

  // 清空：始终显示，无片段时置灰不可点
  const clearBtn = pillBtn(doc, getString("combine-clear"), "ghost", () => {
    combineStore.clear(itemId);
    refreshCombineViews();
  });
  clearBtn.disabled = count === 0;
  applyDisabledStyle(clearBtn, count === 0);
  row.appendChild(clearBtn);

  // 主「翻译」按钮（蓝色实心）：有拼合内容时翻译拼合内容，否则翻译当前选区
  const trBtn = pillBtn(doc, primaryActionLabel(task, count), "accent", () => {
    if (cancelTranslationTask(getLastTask(scope.id, state?.readerId))) return;
    if (count > 0) void translateCombined(itemId, state);
    else rerunCurrent(root, undefined, onChanged);
  });
  trBtn.className = `${config.addonRef}-history-translate`;
  if (count > 0) trBtn.title = getString("combine-translateTitle");
  row.appendChild(trBtn);
  const force = pillBtn(doc, getString("popup-force"), "ghost", () => {
    void forceRetranslate(state, getLastTask(scope.id, state?.readerId));
  });
  force.className = `${config.addonRef}-history-force`;
  force.title = getString("popup-force-title");
  force.disabled = task?.status === "processing" || !(count || task || state?.selectedText);
  applyDisabledStyle(force, force.disabled);
  row.appendChild(force);

  wrap.appendChild(row);

  // 片段胶囊：单独一行（不与选项行混在一起）
  if (count > 0) {
    const chips = doc.createElement("div");
    chips.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;";
    items.forEach((item, index) => chips.appendChild(buildCombineChip(doc, itemId, item, index, count)));
    wrap.appendChild(chips);
  }

  return wrap;
}

/**
 * 「翻译」/切换服务：对本面板范围内的任务重跑；范围内无任务时用当前选区新建一个。
 * 切换服务会写回 translateSource 偏好（与阅读器弹窗一致），下次沿用。
 */
function rerunCurrent(root: HTMLElement, service: string | undefined, onChanged: () => void) {
  const scope = readScope(root);
  const state = getReaderStateForItem(combineItemId(scope), root.ownerDocument.defaultView);
  const task = getLastTask(scope.id, state?.readerId);
  const useTask =
    task && historyStore.itemInScope(task.itemId, scope.id) ? task : undefined;
  if (service && String(getPref("translateSource")) !== service) {
    selectService(service);
  }
  // 本范围内没有可复用的任务、且当前选区也不属于本范围时：不新建，避免把别处的选区译到本面板
  if (!useTask && !historyStore.itemInScope(state?.itemId, scope.id)) {
    onChanged();
    return;
  }
  rerunWith(useTask, { service }, state);
  // 立即刷新一次以更新服务高亮；若有翻译在途，完成后任务管线会再次刷新
  onChanged();
}

/** 流式刷新只修改结果和状态，避免重建列表、标签输入框和操作按钮。 */
export function refreshCurrentResult(root: HTMLElement) {
  const scope = readScope(root);
  const state = getReaderStateForItem(combineItemId(scope), root.ownerDocument.defaultView);
  const task = getLastTask(scope.id, state?.readerId);
  if (state?.resultCleared || !task || !historyStore.itemInScope(task.itemId, scope.id)) return;
  const result = root.querySelector(`.${config.addonRef}-history-result`);
  const status = root.querySelector(`.${config.addonRef}-history-status`);
  if (result) result.textContent = task.result;
  if (status) status.textContent = taskStatusText(task);
}

export { refreshCurrent };
