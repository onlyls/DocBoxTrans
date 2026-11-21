import { config } from "../../package.json";
import { getLocaleID, getString } from "../utils/locale";
import * as historyStore from "../utils/historyStore";
import { translationContext } from "./context";
import type { SortMode } from "./history/types";
import { setBodyScope, readScope, readFilter, writeFilter, matchesFilter } from "./history/scope";
import { fitPaneHeight, scheduleFit, bindResize, disposePaneLayout } from "./history/layout";
import { paneServiceBtnStyle, pillBtn, mkBtn } from "./history/controls";
import { fillTagOptions } from "./history/tags";
import { refreshCurrent, refreshCurrentResult } from "./history/currentTranslation";
import { sortRecords } from "./history/sorting";
import { buildItem } from "./history/recordCard";
import { groupHistoryRecords } from "./history/groups";

/**
 * 「翻译记录」侧栏面板：通过 Zotero.ItemPaneManager.registerSection 注册，
 * 同时出现在条目面板与阅读器左侧导航（sidenav），承载 DocBoxTrans 的翻译记录查看/删除/标签能力。
 * 按当前条目隔离：阅读器里条目为附件（命中 itemId），库中选中顶层文献时命中 parentItemId。
 */
/** 已挂载的面板 body（用于直接重渲染，不依赖 Zotero 的 refresh()）。 */
const paneBodies = new Set<HTMLElement>();
let sortMode: SortMode = "time";
/** 已展开（完整显示原文/译文）的记录 id；重渲染后仍保持。 */
const expandedIds = new Set<string>();
/** 版本选择按面板隔离，筛选条件改变时重新优先显示命中的译文。 */
const versionSelections = new WeakMap<HTMLElement, { filter: string; selected: Map<string, string> }>();
/** 旧记录 parentItemId 是否已惰性回填（只需一次）。 */
let parentsBackfilled = false;
let sectionKey: string | undefined;

function disposeBody(body: HTMLElement) {
  const root = body.querySelector(`.${config.addonRef}-history-root`) as HTMLElement | null;
  if (root) disposePaneLayout(root);
  paneBodies.delete(body);
}

export function unregisterHistoryPane() {
  for (const body of [...paneBodies]) disposeBody(body);
  expandedIds.clear();
  const key = sectionKey;
  sectionKey = undefined;
  if (key) Zotero.ItemPaneManager.unregisterSection(key);
}

export function registerHistoryPane() {
  if (sectionKey) return sectionKey;
  const paneID = `${config.addonRef}-history`;
  const key = Zotero.ItemPaneManager.registerSection({
    paneID,
    pluginID: config.addonID,
    header: {
      l10nID: getLocaleID("history-header"),
      // Zotero 要求 header 图标为 16*16，且按固有尺寸渲染，传 48px 会被裁切
      icon: `chrome://${config.addonRef}/content/icons/panel-16.svg`,
    },
    sidenav: {
      l10nID: getLocaleID("history-sidenav"),
      // Zotero 要求 sidenav 图标为 20*20
      icon: `chrome://${config.addonRef}/content/icons/panel-20.svg`,
    },
    // bodyXHTML 用来让 Zotero 创建分区 body 容器；具体内容仍由 onRender 用代码填充。
    // 高度在布局稳定后由 layout 模块计算，列表在分区内部滚动。
    bodyXHTML: `<div class="${config.addonRef}-history-root"></div>`,
    onInit: ({
      body,
      item,
      tabType,
    }: {
      body: HTMLElement;
      item?: Zotero.Item;
      tabType?: string;
    }) => {
      paneBodies.add(body);
      setBodyScope(body, item, tabType);
    },
    onDestroy: ({ body }: { body: HTMLElement }) => {
      disposeBody(body);
    },
    onRender: ({
      body,
      item,
      tabType,
    }: {
      body: HTMLElement;
      item?: Zotero.Item;
      tabType?: string;
    }) => {
      setBodyScope(body, item, tabType);
      renderInto(body);
    },
    onToggle: ({
      body,
      item,
      tabType,
    }: {
      body: HTMLElement;
      item?: Zotero.Item;
      tabType?: string;
    }) => {
      setBodyScope(body, item, tabType);
      renderInto(body);
    },
    onItemChange: ({
      body,
      item,
      tabType,
    }: {
      body: HTMLElement;
      item?: Zotero.Item;
      tabType?: string;
    }) => {
      setBodyScope(body, item, tabType);
      renderInto(body);
      return true;
    },
  });
  Zotero.debug(`[DocBoxTrans] registerSection(${paneID}) -> ${String(key)}`);
  if (key) sectionKey = key;
  return key;
}

/** 让所有已挂载的面板重新渲染（新增/删除/标签变更后调用）。 */
export function refreshHistoryPanes() {
  paneBodies.forEach((body) => {
    try {
      renderInto(body);
    } catch (e) {
      Zotero.debug(`[DocBoxTrans] 历史面板渲染失败: ${String(e)}`);
    }
  });
}

export function refreshHistoryCurrent() {
  for (const body of paneBodies) {
    try {
      const root = body.querySelector(`.${config.addonRef}-history-root`) as HTMLElement | null;
      if (root) {
        refreshCurrentResult(root);
        fitPaneHeight(root);
        scheduleFit(root);
      }
    } catch (e) {
      Zotero.debug(`[DocBoxTrans] 更新流式译文失败: ${String(e)}`);
    }
  }
}

function renderInto(body: HTMLElement) {
  if (!body || !body.ownerDocument) {
    Zotero.debug("[DocBoxTrans] 历史面板 body 不可用，无法渲染");
    return;
  }
  const doc = body.ownerDocument;

  // 惰性回填旧记录的顶层文献 id（只需一次；此时 Zotero.Items 已可用）
  if (!parentsBackfilled) {
    parentsBackfilled = true;
    try {
      historyStore.ensureParentsBackfilled();
    } catch (e) {
      Zotero.debug(`[DocBoxTrans] 回填 parentItemId 失败: ${String(e)}`);
    }
  }

  // 不依赖 bodyXHTML：容器缺失时直接创建，避免注册片段被忽略或未被解析
  let root = body.querySelector(`.${config.addonRef}-history-root`) as HTMLElement | null;
  if (!root) {
    root = doc.createElement("div");
    root.className = `${config.addonRef}-history-root`;
    body.appendChild(root);
  }
  root.style.cssText =
    "display:flex;flex-direction:column;box-sizing:border-box;overflow:hidden;";
  // 把过滤范围透传到 root 上，供列表/筛选按钮在任意时刻读取
  root.dataset.scopeKind = body.dataset.scopeKind ?? "item";
  root.dataset.scopeId = body.dataset.scopeId ?? "";
  root.dataset.tabType = body.dataset.tabType ?? "";

  if (!root.dataset.built) {
    root.dataset.built = "1";
    const scope = readScope(root);
    Zotero.debug(
      `[DocBoxTrans] 历史面板渲染: scope=${scope.kind}#${scope.id}, records=${historyStore.count()}`,
    );
    buildChrome(root, doc);
    bindResize(root);
  }
  let warning = root.querySelector(`.${config.addonRef}-history-storage-warning`) as HTMLElement | null;
  if (!warning) {
    warning = doc.createElement("div");
    warning.className = `${config.addonRef}-history-storage-warning`;
    warning.setAttribute("role", "alert");
    warning.style.cssText = "flex:none;padding:6px;color:var(--color-accent-orange, #b65a00);";
    const message = doc.createElement("span");
    message.textContent = getString("history-storageError");
    warning.appendChild(message);
    warning.appendChild(pillBtn(doc, getString("history-storageRetry"), "ghost", () => {
      void historyStore.ensureLoaded().then(() => historyStore.flush())
        .catch((e) => Zotero.logError(e)).finally(refreshHistoryPanes);
    }));
    root.prepend(warning);
  }
  warning.hidden = !historyStore.hasStorageError();
  refreshList(root, doc);
}

/** 构建静态骨架（工具条 + 列表容器 + 底部操作行），只在首次渲染时执行。 */
function buildChrome(root: HTMLElement, doc: Document) {
  // 顶部「当前翻译」区（服务切换 + 上下文/拼接选项 + 翻译入口 + 译文 + 标签）：
  // 由 refreshCurrent 每次渲染填充；文献条目面板会隐藏该区（只保留记录列表）
  const current = doc.createElement("div");
  current.className = `${config.addonRef}-history-current`;
  // flex:0 0 auto + overflow:auto：不参与伸缩（记录再多也不会被列表挤小），
  // 高度只随译文文本自适应；上限由 fitPaneHeight 按面板高度设置（超出则区内滚动）
  current.style.cssText =
    "display:flex;flex-direction:column;gap:4px;padding:6px 6px 8px 6px;" +
    "flex:0 0 auto;overflow:auto;" +
    "border-bottom:1px solid var(--fill-quaternary, rgba(127,127,127,.25));";
  root.appendChild(current);

  const bar = doc.createElement("div");
  bar.className = `${config.addonRef}-history-bar`;
  bar.style.cssText = "display:flex;gap:4px;padding:4px;flex:none;";

  const search = doc.createElement("input");
  search.type = "search";
  search.className = `${config.addonRef}-history-search`;
  search.placeholder = getString("history-search");
  search.style.cssText = "flex:1;min-width:0;box-sizing:border-box;";
  // 初值取本面板自身的筛选条件，保证搜索框显示与筛选结果一致
  search.value = root.dataset.filterText ?? "";
  search.addEventListener("input", () => {
    writeFilter(root, { text: search.value });
    refreshList(root, doc);
  });

  const tagSel = doc.createElement("select");
  tagSel.className = `${config.addonRef}-history-tags`;
  tagSel.style.cssText = "max-width:110px;";
  tagSel.addEventListener("change", () => {
    writeFilter(root, { tag: tagSel.value });
    refreshList(root, doc);
  });
  fillTagOptions(tagSel, doc);
  // 初值取本面板自身的标签筛选条件（选项填充后回填，保证与筛选结果一致）
  tagSel.value = root.dataset.filterTag ?? "";

  bar.appendChild(search);
  bar.appendChild(tagSel);
  root.appendChild(bar);

  const list = doc.createElement("div");
  list.className = `${config.addonRef}-history-list`;
  // 固定顶栏/底栏、只有列表内部滚动：列表用 flex:1 吸收收缩并填满面板中间区域，
  // 高度由 fitPaneHeight 按可用空间给 root 定高（内容少时列表撑满空白，内容多时内部滚动）
  list.style.cssText =
    "overflow:auto;padding:0 4px 4px 4px;min-height:80px;";
  root.appendChild(list);

  const foot = doc.createElement("div");
  foot.className = `${config.addonRef}-history-foot`;
  foot.style.cssText =
    "display:flex;flex-wrap:wrap;gap:4px;padding:4px;flex:none;" +
    "border-top:1px solid var(--fill-quaternary);";

  // 标签增删已下放到每条记录卡片内，这里只保留「清空本范围」（阅读器=本文件，条目面板=本条目）
  const clearKind = readScope(root).kind;
  foot.appendChild(
    mkBtn(
      doc,
      clearKind === "file"
        ? getString("history-clearFile")
        : getString("history-clearScope"),
      () => {
        const scope = readScope(root);
        if (scope.id == null) return;
        const isFile = scope.kind === "file";
        const view = isFile
          ? historyStore.snapshotForFile(scope.id)
          : historyStore.snapshotForItem(scope.id);
        if (view.length === 0) return;
        const win = root.ownerGlobal as unknown as Window;
        let ok = true;
        try {
          ok = Services.prompt.confirm(
            win as unknown as mozIDOMWindowProxy,
            getString(
              isFile
                ? "history-clearFileConfirmTitle"
                : "history-clearScopeConfirmTitle",
            ),
            getString(
              isFile
                ? "history-clearFileConfirmBody"
                : "history-clearScopeConfirmBody",
            ),
          );
        } catch {
          ok = true;
        }
        if (!ok) return;
        if (isFile) historyStore.clearForFile(scope.id);
        else historyStore.clearForItem(scope.id);
        view.forEach((r) => {
          translationContext.remove(r.id);
          expandedIds.delete(r.id);
        });
        groupHistoryRecords(view).forEach(group => expandedIds.delete(group.key));
        refreshHistoryPanes();
      },
    ),
  );

  // 「清空」右侧：排序切换（时间 / 原文顺序）
  foot.appendChild(buildSortControl(doc));
  root.appendChild(foot);
}

// ---------------- 排序（时间 / 原文顺序） ----------------

/** 底部排序切换：时间 / 原文顺序（两枚药丸，当前项高亮），挂在「清空」右侧。 */
function buildSortControl(doc: Document): HTMLElement {
  const wrap = doc.createElement("div");
  wrap.className = `${config.addonRef}-history-sort`;
  wrap.title = getString("history-sortTitle");
  wrap.style.cssText = "display:flex;gap:2px;align-items:center;margin-left:auto;";
  const modes: Array<[SortMode, string]> = [
    ["time", getString("history-sortTime")],
    ["source", getString("history-sortSource")],
  ];
  for (const [mode, label] of modes) {
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    btn.dataset.sortMode = mode;
    btn.style.cssText = paneServiceBtnStyle(false);
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (sortMode === mode) return;
      sortMode = mode;
      refreshHistoryPanes();
    });
    wrap.appendChild(btn);
  }
  return wrap;
}

/** 每次渲染按共享的 sortMode 同步两枚按钮高亮（各面板的按钮在不同时间创建）。 */
function syncSortControl(root: HTMLElement) {
  const mode = sortMode;
  root
    .querySelectorAll(`.${config.addonRef}-history-sort button`)
    .forEach((node) => {
      const btn = node as HTMLButtonElement;
      btn.style.cssText = paneServiceBtnStyle(btn.dataset.sortMode === mode);
    });
}

function refreshList(root: HTMLElement, doc: Document) {
  const list = root.querySelector(
    `.${config.addonRef}-history-list`,
  ) as HTMLElement | null;
  if (!list) return;
  // 「当前翻译」区先渲染：其高度参与下面列表可用高度的计算
  refreshCurrent(root, doc, refreshHistoryPanes);
  const tagSel = root.querySelector(
    `.${config.addonRef}-history-tags`,
  ) as HTMLSelectElement | null;
  if (tagSel) fillTagOptions(tagSel, doc);

  const scrollTop = list.scrollTop;
  list.textContent = "";
  const scope = readScope(root);
  // 筛选条件取自本面板自身（不跨面板共享），保证「搜索框显示的内容」就是「列表被过滤的条件」
  const filter = readFilter(root);
  syncSortControl(root);
  const view = sortRecords(
    (
      scope.kind === "file"
        ? historyStore.snapshotForFile(scope.id)
        : historyStore.snapshotForItem(scope.id)
    ),
    sortMode,
    scope,
  );
  const groups = groupHistoryRecords(view).filter(group =>
    group.variants.some(record => matchesFilter(record, filter)));
  const filterKey = JSON.stringify([scope, filter]);
  let selection = versionSelections.get(root);
  if (!selection || selection.filter !== filterKey) {
    selection = { filter: filterKey, selected: new Map() };
    versionSelections.set(root, selection);
  }
  if (groups.length === 0) {
    const empty = doc.createElement("div");
    empty.textContent = getString(
      scope.kind === "file" ? "history-emptyFile" : "history-emptyScope",
    );
    empty.style.cssText = "opacity:.6;padding:8px;";
    list.appendChild(empty);
    fitPaneHeight(root);
    scheduleFit(root);
    return;
  }
  for (const group of groups) {
    const selectedId = selection.selected.get(group.key);
    const rec = group.variants.find(record => record.id === selectedId) ??
      group.variants.find(record => matchesFilter(record, filter))!;
    list.appendChild(buildItem(root, doc, rec, expandedIds, refreshHistoryPanes, {
      key: group.key,
      records: group.variants,
      onSelect: (id, direction) => {
        selection.selected.set(group.key, id);
        refreshHistoryPanes();
        // 重建卡片后恢复键盘焦点，保留滚动与展开状态。
        const button = Array.from(root.querySelectorAll(`.${config.addonRef}-history-version-button`))
          .find(element => {
            const data = (element as HTMLButtonElement).dataset;
            return data.groupKey === group.key && data.direction === String(direction);
          }) as HTMLButtonElement | undefined;
        button?.focus({ preventScroll: true });
      },
    }));
  }
  list.scrollTop = scrollTop; // 重渲染后保持原滚动位置
  fitPaneHeight(root);
  scheduleFit(root);
}
