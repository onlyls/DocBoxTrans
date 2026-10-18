import { config } from "../../package.json";
import { getLocaleID, getString } from "../utils/locale";
import * as historyStore from "../utils/historyStore";
import type { HistoryRecord, RecordPosition } from "../utils/history";
import { services } from "./services";
import { translationContext } from "./context";
import { getPref, setPref } from "../utils/prefs";
import { getLastTask } from "../utils/task";
import * as combineStore from "../utils/combineStore";
import { pillCss, applyDisabledStyle, PILL_PADDING_COMPACT, type PillVariant } from "../utils/uiStyle";
import { popupState, rerunWith, translateCombined, refreshCombineViews, primaryTranslateLabel } from "./popup";

/**
 * 「翻译记录」侧栏面板：通过 Zotero.ItemPaneManager.registerSection 注册，
 * 同时出现在条目面板与阅读器左侧导航（sidenav），承载 DocBoxTrans 的翻译记录查看/删除/标签能力。
 * 按当前条目隔离：阅读器里条目为附件（命中 itemId），库中选中顶层文献时命中 parentItemId。
 */
/** 已挂载的面板 body（用于直接重渲染，不依赖 Zotero 的 refresh()）。 */
const paneBodies = new Set<HTMLElement>();

/**
 * 筛选状态按面板隔离（挂在各自 root 的 dataset 上），不再全局共享：
 * 条目面板与阅读器面板（乃至不同条目/不同文件）是相互独立的记录范围，
 * 搜索关键词只应作用于当前面板自身，否则会出现「面板 A 搜索后进入面板 B，
 * 结果被 A 的关键词过滤而搜索框却是空的」这种隐藏过滤状态。
 */
/** 面板排序方式（各面板共享）：time=按翻译时间（最新在前，默认）；source=按原文前后顺序。 */
type SortMode = "time" | "source";
let sortMode: SortMode = "time";
/** 已展开（完整显示原文/译文）的记录 id；重渲染后仍保持。 */
const expandedIds = new Set<string>();
/** 旧记录 parentItemId 是否已惰性回填（只需一次）。 */
let parentsBackfilled = false;

/** 面板过滤范围：file=仅单个附件（阅读器），item=整篇文献（含各附件）。 */
type ScopeKind = "file" | "item";
interface PaneScope {
  kind: ScopeKind;
  id?: number;
}

/** 把面板当前的过滤范围记到 body 上（供渲染/清空时按范围过滤）。 */
function setBodyScope(body: HTMLElement, item?: Zotero.Item, tabType?: string) {
  const scope = computeScope(item, tabType);
  const nextId = scope.id != null ? String(scope.id) : "";
  // 面板切换到了不同的条目/文件：清空本面板的搜索条件，避免旧关键词过滤新范围
  const scopeChanged =
    (body.dataset.scopeKind ?? "") !== scope.kind ||
    (body.dataset.scopeId ?? "") !== nextId;
  body.dataset.scopeKind = scope.kind;
  body.dataset.scopeId = nextId;
  body.dataset.itemId = item && item.id != null ? String(item.id) : "";
  // 分区类型：reader=阅读器侧栏（面板需撑满整块空白），library=条目面板（按内容堆叠）
  body.dataset.tabType = tabType ?? "";
  if (scopeChanged) resetPanelFilter(body);
}

/** 面板所属分区类型（reader=阅读器侧栏，library=条目面板）。 */
function readTabType(root: HTMLElement): string {
  return root.dataset.tabType ?? "";
}

/** 读取挂在 root/body 上的过滤范围。 */
function readScope(el: HTMLElement): PaneScope {
  const kind: ScopeKind = el.dataset.scopeKind === "file" ? "file" : "item";
  const v = el.dataset.scopeId;
  const n = v ? parseInt(v, 10) : NaN;
  return { kind, id: Number.isFinite(n) ? n : undefined };
}

/** 本面板的筛选关键词/标签（按 root 隔离，不跨面板共享）。 */
interface PaneFilter {
  text: string;
  tag: string;
}

/** 读取本面板的筛选条件（未设置时为空，即不筛选）。 */
function readFilter(root: HTMLElement): PaneFilter {
  return {
    text: root.dataset.filterText ?? "",
    tag: root.dataset.filterTag ?? "",
  };
}

/** 更新本面板的筛选条件到 root 上。 */
function writeFilter(root: HTMLElement, patch: Partial<PaneFilter>) {
  if (patch.text != null) root.dataset.filterText = patch.text;
  if (patch.tag != null) root.dataset.filterTag = patch.tag;
}

/**
 * 清空本面板的筛选条件，并同步清空搜索框/标签下拉。
 * 面板切换到不同的条目/文件（范围变化）时调用，保证新范围默认展示全部记录、
 * 且控件显示与筛选结果始终一致（不会出现「有结果被过滤但搜索框为空」）。
 */
function resetPanelFilter(body: HTMLElement) {
  const root = body.querySelector(
    `.${config.addonRef}-history-root`,
  ) as HTMLElement | null;
  if (!root) return;
  root.dataset.filterText = "";
  root.dataset.filterTag = "";
  const search = root.querySelector(
    `.${config.addonRef}-history-search`,
  ) as HTMLInputElement | null;
  if (search) search.value = "";
  const tagSel = root.querySelector(
    `.${config.addonRef}-history-tags`,
  ) as HTMLSelectElement | null;
  if (tagSel) tagSel.value = "";
}

/**
 * 决定分组范围：阅读器里按「文件（附件）」隔离，条目面板里按「文献条目（顶层）」隔离。
 * 阅读器 section 传入的 item 可能是附件、也可能是顶层文献条目，这里两种都兼容。
 */
function computeScope(item?: Zotero.Item, tabType?: string): PaneScope {
  if (!item) return { kind: "item" };
  if (tabType === "reader") {
    const attId = item.isAttachment?.() ? item.id : findOpenReaderChildItemId(item.id);
    // 拿不到当前附件 id 时退化为整篇文献，至少不会显示为空
    return typeof attId === "number"
      ? { kind: "file", id: attId }
      : { kind: "item", id: item.id };
  }
  return { kind: "item", id: item.id };
}

function getReaders(): any[] {
  return ((Zotero.Reader as unknown as { _readers?: any[] })._readers ?? []).filter(
    Boolean,
  );
}

/** 找到当前打开、且属于指定文献条目的阅读器附件 id（优先当前选中标签页对应的阅读器）。 */
function findOpenReaderChildItemId(parentItemId: number): number | undefined {
  try {
    const readers = getReaders();
    const childIds = readers
      .map((r) => r.itemID)
      .filter((id): id is number => typeof id === "number")
      .filter((id) => {
        try {
          return Zotero.Items.get(id)?.parentItemID === parentItemId;
        } catch {
          return false;
        }
      });
    if (childIds.length === 0) return undefined;
    const win = (Zotero as unknown as { getMainWindow?: () => any }).getMainWindow?.();
    const selected = (win as any)?.Zotero_Tabs?.selectedID;
    if (selected) {
      const r = readers.find((x) => x.tabID === selected);
      if (typeof r?.itemID === "number" && childIds.includes(r.itemID)) {
        return r.itemID;
      }
    }
    return childIds[childIds.length - 1];
  } catch {
    return undefined;
  }
}

export function registerHistoryPane() {
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
    // 高度不依赖父容器是否已撑开：阅读器侧栏按容器底边固定面板高度（见 fitReaderHeight），
    // 条目面板则用列表 max-height 滚动，二者都在布局稳定后由 scheduleFit 补算。
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
      paneBodies.delete(body);
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
  refreshList(root, doc);
}

/**
 * 给「翻译记录」面板定高，使面板占满分区下方空白，并保持「顶栏/底栏固定、只有列表内部滚动」。
 *
 * 关键点：可用高度必须与「容器当前滚动位置」无关，否则当面板位于可视区下方时（条目面板里上方
 * 还有信息/摘要等分区，初始化滚动在顶部）会算出负数 → 不设高度 → 整块分区随容器滚动，顶栏/底栏
 * 全被滚走。这里改用 Zotero 自己也算的偏移：容器内容坐标系内的偏移 =
 * 面板顶部 − 容器顶部 + scrollTop，可用高度 = 容器可视高度 − 该偏移。
 */
function fitPaneHeight(root: HTMLElement) {
  const list = root.querySelector(
    `.${config.addonRef}-history-list`,
  ) as HTMLElement | null;
  if (!list) return;
  list.style.maxHeight = "";
  list.style.flex = "1 1 auto";
  // 「本次翻译结果」区：不参与收缩（flex:0 0 auto），高度只随文本自适应，
  // 上限取面板高度的 45%；超过上限时在该区内部滚动，避免长译文吃满整块面板
  const current = root.querySelector(
    `.${config.addonRef}-history-current`,
  ) as HTMLElement | null;
  const resetCurrent = () => {
    if (current) current.style.maxHeight = "";
  };
  try {
    const win = root.ownerGlobal as unknown as Window;
    const rect = root.getBoundingClientRect();
    // 未挂载 / 分区收起（未渲染）时 rect 全为 0：先清空高度约束，等下次重渲染/补算再定
    if (!root.isConnected || rect.height <= 0) {
      root.style.height = "";
      resetCurrent();
      return;
    }
    // 分区标题行的高度（退化为「占满整个容器」时需要扣除）
    const headH =
      (
        root
          .closest("item-pane-custom-section")
          ?.querySelector(".head") as HTMLElement | null
      )?.clientHeight ?? 0;

    let avail = 0;
    const view = findViewContainer(root);
    if (view && view.clientHeight > 0) {
      const viewRect = view.getBoundingClientRect();
      // 面板顶部在容器内容中的偏移（scrollTop 抵消，与当前滚动位置无关）
      const topInContent = rect.top - viewRect.top + view.scrollTop;
      avail = view.clientHeight - topInContent - 8;
      if (avail <= 0) {
        // 上方分区已占满容器（面板整块在可视区下方）：退化为「占满整个容器」的高度，
        // 仍保证顶栏/底栏固定、列表内部滚动
        avail = view.clientHeight - headH - 8;
      }
    } else {
      // 找不到容器时按窗口估算（阅读器侧栏一般能命中容器）
      avail = win.innerHeight - rect.top - headH - 8;
    }
    if (!Number.isFinite(avail) || avail <= 0) {
      // 容器尚未完成布局：清空约束，交给 scheduleFit 在布局稳定后补算
      root.style.height = "";
      resetCurrent();
      return;
    }
    const px = Math.max(160, Math.round(avail));
    root.style.height = `${px}px`;
    if (current) current.style.maxHeight = `${Math.round(px * 0.45)}px`;
  } catch {
    root.style.height = "";
    resetCurrent();
  }
}

/** 分区视图容器（Zotero 的 `.zotero-view-item`，条目面板与阅读器侧栏都存在）。 */
function findViewContainer(root: HTMLElement): HTMLElement | null {
  try {
    return root.closest(".zotero-view-item") as HTMLElement | null;
  } catch {
    return null;
  }
}

/**
 * 布局稳定后补算一次高度。首次渲染（尤其是刚打开每个文档时）容器尺寸可能尚未稳定，
 * 此时测得的高度会偏小、面板出现空白又不会被任何事件纠正——这正是本问题的根因。
 */
function scheduleFit(root: HTMLElement) {
  const win = root.ownerGlobal as unknown as Window | undefined;
  const run = () => {
    if (root.isConnected) fitPaneHeight(root);
  };
  try {
    win?.requestAnimationFrame(run);
  } catch {
    /* 忽略：无法调度则退化为下次渲染时重算 */
  }
  try {
    win?.setTimeout(run, 180);
  } catch {
    /* 忽略 */
  }
}

/** 窗口/容器尺寸变化时补算高度（每个面板只绑定一次）。 */
function bindResize(root: HTMLElement) {
  if (root.dataset.resizeBound) return;
  root.dataset.resizeBound = "1";
  const win = root.ownerGlobal as unknown as Window;
  const run = () => {
    if (root.isConnected) fitPaneHeight(root);
  };
  try {
    win.addEventListener("resize", run);
  } catch {
    // 忽略：无法绑定 resize 时退化为默认高度
  }
  // 容器自身尺寸变化（侧栏展开、窗口布局完成、拖动宽度）时补算
  try {
    const target = findViewContainer(root) ?? win.document.documentElement;
    const RO = (win as unknown as { ResizeObserver?: typeof ResizeObserver })
      .ResizeObserver;
    if (RO && target) new RO(run).observe(target);
  } catch {
    /* 忽略 */
  }
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
        refreshHistoryPanes();
      },
    ),
  );

  // 「清空」右侧：排序切换（时间 / 原文顺序）
  foot.appendChild(buildSortControl(doc));
  root.appendChild(foot);
}

// ---------------- 当前翻译（面板顶部） ----------------

/** 服务切换胶囊的样式：当前服务实心高亮，其余浅色。 */
function paneServiceBtnStyle(active: boolean): string {
  return pillCss(active ? "accent" : "ghost", "0.75em");
}

/** 药丸形按钮（与弹窗、服务胶囊同一套视觉语言）。 */
function pillBtn(
  doc: Document,
  text: string,
  variant: PillVariant,
  onClick: () => void,
): HTMLButtonElement {
  const b = doc.createElement("button");
  b.type = "button";
  b.textContent = text;
  b.style.cssText = pillCss(variant, "0.75em", PILL_PADDING_COMPACT);
  b.addEventListener("click", (ev) => {
    ev.stopPropagation();
    onClick();
  });
  return b;
}

/**
 * 药丸形开关组：把多个「复选框 + 文案」放进同一个胶囊（中间加细分隔线），
 * 相比多个独立胶囊更省宽度，便于整行排布。
 */
function pillToggleGroup(
  doc: Document,
  items: Array<{
    checked: boolean;
    label: string;
    title: string;
    onChange: (v: boolean) => void;
  }>,
): HTMLElement {
  const wrap = doc.createElement("div");
  wrap.style.cssText = `${pillCss("ghost", "0.75em", PILL_PADDING_COMPACT)};display:flex;align-items:center;gap:4px;`;
  items.forEach((it, i) => {
    if (i > 0) {
      const divider = doc.createElement("span");
      divider.style.cssText =
        "width:1px;height:12px;flex:none;background:var(--fill-quaternary, rgba(127,127,127,.35));";
      wrap.appendChild(divider);
    }
    const label = doc.createElement("label");
    label.style.cssText =
      "display:flex;align-items:center;gap:4px;cursor:pointer;white-space:nowrap;";
    label.title = it.title;
    const cb = doc.createElement("input");
    cb.type = "checkbox";
    cb.checked = it.checked;
    cb.addEventListener("change", () => it.onChange(cb.checked));
    const span = doc.createElement("span");
    span.textContent = it.label;
    label.appendChild(cb);
    label.appendChild(span);
    wrap.appendChild(label);
  });
  return wrap;
}

/**
 * 渲染面板顶部「当前翻译」区：只展示译文（不折叠），并带上下文/拼接选项、服务切换与「翻译」入口。
 * 与下方列表同源：任务成功后会在列表中同时出现，可按需打标签。
 * 仅在阅读器侧栏展示；文献条目面板只需要「翻译记录」列表，故直接把该区隐藏。
 */
function refreshCurrent(root: HTMLElement, doc: Document) {
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
  const task = getLastTask();
  // 拼接模式下收录了新选区：本范围内的上次译文视为已清空，不显示
  const resultCleared =
    popupState.resultClearedFor != null &&
    historyStore.itemInScope(popupState.resultClearedFor, scope.id);
  const cur =
    !resultCleared && task && historyStore.itemInScope(task.itemId, scope.id)
      ? task
      : undefined;

  // 服务切换 + 翻译入口
  const row = doc.createElement("div");
  row.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:4px;";

  const current = String(getPref("translateSource") || "llm");
  for (const s of services.getAll()) {
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.textContent = services.getDisplayName(s.id);
    btn.style.cssText = paneServiceBtnStyle(s.id === current);
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      rerunCurrent(root, s.id);
    });
    row.appendChild(btn);
  }
  box.appendChild(row);

  // 拼接翻译：单行内「拼接模式 + 加入当前选区 + 清空 + 翻译（计数）+ 片段胶囊」
  box.appendChild(buildCombineArea(root, doc, scope));

  // 译文：完整展示、不做折叠（用户可在此直接阅读本次结果）
  const res = doc.createElement("div");
  res.textContent = cur && cur.result ? cur.result : getString("history-currentEmpty");
  res.style.cssText =
    "line-height:1.5;white-space:pre-wrap;word-break:break-word;" +
    "background:var(--fill-quaternary, rgba(127,127,127,.08));" +
    "border-radius:6px;padding:5px;";
  box.appendChild(res);

  // 标签：本次结果已落为历史记录时，提供与列表卡片一致的增删标签能力
  const rec = cur && cur.recordId ? historyStore.getById(cur.recordId) : undefined;
  if (!rec) return;

  const tagWrap = doc.createElement("div");
  tagWrap.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:4px;";
  for (const t of rec.tags ?? []) {
    tagWrap.appendChild(makeTagChip(doc, rec, t, refreshHistoryPanes));
  }

  const editor = buildTagEditor(doc, rec, refreshHistoryPanes);
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

/** 解析本面板范围对应的当前拼合文档 id：文件范围=附件 id；条目范围=当前打开的阅读器附件。 */
function combineItemId(scope: PaneScope): number | undefined {
  if (scope.kind === "file") return scope.id;
  if (typeof scope.id === "number") return findOpenReaderChildItemId(scope.id);
  return undefined;
}

/** 选项行：上下文 / 拼接 / 追加 / 清空 / 翻译（计数）；片段胶囊另起一行。 */
function buildCombineArea(
  root: HTMLElement,
  doc: Document,
  scope: PaneScope,
): HTMLElement {
  const itemId = combineItemId(scope);
  const items = combineStore.list(itemId);
  const count = items.length;

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
          rerunCurrent(root);
        },
      },
      {
        checked: combineStore.getMode(),
        label: getString("popup-combine"),
        title: getString("popup-combine-title"),
        onChange: (v) => {
          combineStore.setMode(v);
          if (v && popupState.itemId === itemId) {
            // 开启拼接时，若当前选区正属于本面板的文档则同时收录
            combineStore.add(itemId, popupState.selectedText, popupState.position);
          } else if (!v) {
            // 退出拼接：恢复显示上次翻译结果
            popupState.resultClearedFor = undefined;
          }
          refreshCombineViews();
        },
      },
    ]),
  );

  // 追加（把当前选区加入拼合区）
  const canAdd = Boolean(popupState.selectedText) && popupState.itemId === itemId;
  const addBtn = pillBtn(doc, getString("combine-add"), "ghost", () => {
    combineStore.add(itemId, popupState.selectedText, popupState.position);
    refreshCombineViews();
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
  const trBtn = pillBtn(doc, primaryTranslateLabel(count), "accent", () => {
    if (count > 0) void translateCombined(itemId);
    else rerunCurrent(root);
  });
  if (count > 0) trBtn.title = getString("combine-translateTitle");
  row.appendChild(trBtn);

  wrap.appendChild(row);

  // 片段胶囊：单独一行（不与选项行混在一起）
  if (count > 0) {
    const chips = doc.createElement("div");
    chips.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;";
    for (const it of items) {
      const chip = doc.createElement("span");
      chip.textContent = it.text.length > 18 ? `${it.text.slice(0, 18)}…` : it.text;
      chip.title = `${getString("combine-removeTitle")}\n\n${it.text}`;
      chip.style.cssText =
        "font-size:0.75em;padding:1px 7px;border-radius:8px;cursor:pointer;max-width:100%;" +
        "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" +
        "background:var(--fill-quaternary, rgba(127,127,127,.15));" +
        "border:1px solid var(--fill-quaternary, rgba(127,127,127,.25));";
      chip.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (combineStore.remove(itemId, it.id)) refreshCombineViews();
      });
      chips.appendChild(chip);
    }
    wrap.appendChild(chips);
  }

  return wrap;
}

/**
 * 「翻译」/切换服务：对本面板范围内的任务重跑；范围内无任务时用当前选区新建一个。
 * 切换服务会写回 translateSource 偏好（与阅读器弹窗一致），下次沿用。
 */
function rerunCurrent(root: HTMLElement, service?: string) {
  const scope = readScope(root);
  const task = getLastTask();
  const useTask =
    task && historyStore.itemInScope(task.itemId, scope.id) ? task : undefined;
  if (service && String(getPref("translateSource")) !== service) {
    setPref("translateSource", service);
  }
  // 本范围内没有可复用的任务、且当前选区也不属于本范围时：不新建，避免把别处的选区译到本面板
  if (!useTask && !historyStore.itemInScope(popupState.itemId, scope.id)) {
    refreshHistoryPanes();
    return;
  }
  rerunWith(useTask, service ? { service } : {});
  // 立即刷新一次以更新服务高亮；若有翻译在途，完成后任务管线会再次刷新
  refreshHistoryPanes();
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

/** 按当前排序方式重排记录（返回新数组）；time 模式沿用快照的时间倒序。 */
function sortRecords(
  list: HistoryRecord[],
  mode: SortMode,
  scope: PaneScope,
): HistoryRecord[] {
  if (mode !== "source") return list;
  const order = attachmentOrderIndex(scope);
  return [...list].sort((a, b) => {
    const ra = fileRank(a.itemId, order);
    const rb = fileRank(b.itemId, order);
    if (ra !== rb) return ra - rb;
    return compareByPosition(a, b);
  });
}

/**
 * 条目范围的「文件先后」映射：取顶层条目下附件的排列顺序（Zotero 库中的文件顺序）。
 * 非条目范围或附件已删除时返回空表，退化为只按位置比较。
 */
function attachmentOrderIndex(scope: PaneScope): Map<number, number> {
  const map = new Map<number, number>();
  if (scope.kind !== "item" || typeof scope.id !== "number") return map;
  try {
    const item = Zotero.Items.get(scope.id);
    const ids: number[] = item ? item.getAttachments() : [];
    ids.forEach((id, i) => map.set(id, i));
  } catch {
    /* 忽略：读不到附件顺序时按位置兜底 */
  }
  return map;
}

/** 记录所属附件在条目内的序号；未知附件排在最后。 */
function fileRank(itemId: number | undefined, order: Map<number, number>): number {
  if (typeof itemId !== "number") return Number.MAX_SAFE_INTEGER;
  const i = order.get(itemId);
  return i == null ? Number.MAX_SAFE_INTEGER : i;
}

/**
 * 同一文档内按原文位置排序。
 * 首选 Zotero 阅读器写入的 `sortIndex`：它按阅读顺序生成（形如 `页码|页内位置|…`，字段零填充），
 * 已把「左栏在前、右栏在后」的分栏阅读顺序算进去，因此双栏 PDF 也能正确排序，
 * 与 Zotero 注释栏的先后一致。
 * 仅当旧记录缺失 sortIndex 时，才退化为「页码 + 顶边 + 左边」的矩形估算。
 */
function compareByPosition(a: HistoryRecord, b: HistoryRecord): number {
  const ka = positionRank(a.position);
  const kb = positionRank(b.position);
  if (ka == null && kb == null) return 0;
  if (ka == null) return 1; // 未保存位置的记录排在最后
  if (kb == null) return -1;
  // 1) 阅读顺序索引：零填充的字典序即数值序
  if (ka.sort !== kb.sort) {
    if (!ka.sort) return 1; // 有 sortIndex 的更精确，缺失者靠后
    if (!kb.sort) return -1;
    return ka.sort < kb.sort ? -1 : 1;
  }
  // 以下仅用于缺失 sortIndex 的退化排序
  if (ka.page !== kb.page) return ka.page - kb.page; // 页码升序
  if (ka.top !== kb.top) return kb.top - ka.top; // 顶边降序：PDF 坐标 y 向上，越大越靠前
  return ka.left - kb.left; // 同高时左栏在前
}

interface PositionRank {
  sort: string;
  page: number;
  top: number;
  left: number;
}

/** 归一化位置为可比较的排序键；没有任何可定位信息时返回 null。 */
function positionRank(pos: RecordPosition | undefined): PositionRank | null {
  if (!pos) return null;
  const sort = typeof pos.sortIndex === "string" ? pos.sortIndex : "";
  const hasPage = typeof pos.pageIndex === "number";
  const hasRects = Array.isArray(pos.rects) && pos.rects.length > 0;
  if (!sort && !hasPage && !hasRects) return null;
  return {
    sort,
    page: hasPage ? (pos.pageIndex as number) : 0,
    top: rectTop(pos.rects),
    left: rectLeft(pos.rects),
  };
}

/** 一组矩形的最高边 y（PDF 坐标系 y 向上：越大越靠上）；无有效值返回 -Infinity。 */
function rectTop(rects?: number[][]): number {
  let top = Number.NEGATIVE_INFINITY;
  for (const r of rects ?? []) {
    if (!Array.isArray(r)) continue;
    for (const y of [r[1], r[3]]) {
      if (typeof y === "number" && Number.isFinite(y)) top = Math.max(top, y);
    }
  }
  return top;
}

/** 一组矩形的最左边 x（用于同高时判定左右栏）；无有效值返回 +Infinity。 */
function rectLeft(rects?: number[][]): number {
  let left = Number.POSITIVE_INFINITY;
  for (const r of rects ?? []) {
    if (!Array.isArray(r)) continue;
    for (const x of [r[0], r[2]]) {
      if (typeof x === "number" && Number.isFinite(x)) left = Math.min(left, x);
    }
  }
  return left;
}

function refreshList(root: HTMLElement, doc: Document) {
  const list = root.querySelector(
    `.${config.addonRef}-history-list`,
  ) as HTMLElement | null;
  if (!list) return;
  // 「当前翻译」区先渲染：其高度参与下面列表可用高度的计算
  refreshCurrent(root, doc);
  const tagSel = root.querySelector(
    `.${config.addonRef}-history-tags`,
  ) as HTMLSelectElement | null;
  if (tagSel) fillTagOptions(tagSel, doc);

  list.textContent = "";
  const scrollTop = list.scrollTop;
  const scope = readScope(root);
  // 筛选条件取自本面板自身（不跨面板共享），保证「搜索框显示的内容」就是「列表被过滤的条件」
  const filter = readFilter(root);
  syncSortControl(root);
  const view = sortRecords(
    (
      scope.kind === "file"
        ? historyStore.snapshotForFile(scope.id)
        : historyStore.snapshotForItem(scope.id)
    ).filter((rec) => matchesFilter(rec, filter)),
    sortMode,
    scope,
  );
  if (view.length === 0) {
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
  for (const rec of view) {
    list.appendChild(buildItem(root, doc, rec));
  }
  list.scrollTop = scrollTop; // 重渲染后保持原滚动位置
  fitPaneHeight(root);
  scheduleFit(root);
}

/** 卡片式记录（对齐 Zotero 侧栏笔记的视觉：圆角卡片 + 标题/摘要 + 右下角日期）。 */
function buildItem(
  root: HTMLElement,
  doc: Document,
  rec: import("../utils/history").HistoryRecord,
): HTMLElement {
  const expanded = expandedIds.has(rec.id);
  const onChanged = () => refreshHistoryPanes();

  const card = doc.createElement("div");
  card.style.cssText =
    "position:relative;border:1px solid var(--fill-quaternary, rgba(127,127,127,.25));" +
    "border-radius:8px;padding:8px 10px;margin-bottom:6px;background:transparent;" +
    "transition:background .12s ease,border-color .12s ease;";

  // 顶部：图标 + 服务/目标语言（可点击跳回原文）；右侧操作按钮（悬停时显示）
  const head = doc.createElement("div");
  head.style.cssText = "display:flex;align-items:center;gap:6px;";

  const source = doc.createElement("div");
  source.style.cssText =
    "display:flex;align-items:center;gap:6px;flex:1;min-width:0;";

  const icon = doc.createElement("img");
  icon.src = `chrome://${config.addonRef}/content/icons/panel-16.svg`;
  icon.style.cssText = "width:16px;height:16px;flex:none;opacity:.7;";
  source.appendChild(icon);

  const meta = doc.createElement("div");
  meta.style.cssText =
    "flex:1;min-width:0;font-size:0.8em;opacity:.7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
  meta.textContent = `${providerName(rec.provider)} · ${rec.targetLanguage}`;
  source.appendChild(meta);

  // 有原文位置时，点击「服务来源」区域跳回该原文在文档中的位置
  if (typeof rec.itemId === "number" && rec.position) {
    source.style.cursor = "pointer";
    source.title = getString("history-jumpTitle");
    source.addEventListener("click", (ev) => {
      ev.stopPropagation();
      jumpToRecord(rec);
    });
  } else {
    source.title = getString("history-noPosition");
  }
  head.appendChild(source);

  const actions = doc.createElement("div");
  actions.style.cssText =
    "display:flex;gap:4px;flex:none;opacity:0;transition:opacity .12s ease;";
  actions.appendChild(
    mkBtn(doc, getString("history-copy"), () => copyText(root, rec.translatedText), true),
  );
  actions.appendChild(
    mkBtn(
      doc,
      getString("history-delete"),
      () => {
        if (historyStore.remove(rec.id)) {
          translationContext.remove(rec.id);
          expandedIds.delete(rec.id);
          onChanged();
        }
      },
      true,
    ),
  );
  head.appendChild(actions);

  // 原文 + 译文：单击该显示区域展开/收起本条（只改本卡片样式，不动其它记录）
  const content = doc.createElement("div");
  content.style.cssText = "cursor:pointer;";

  const src = doc.createElement("div");
  src.textContent = rec.sourceText;
  content.appendChild(src);

  const dst = rec.translatedText ? doc.createElement("div") : null;
  if (dst) {
    dst.textContent = rec.translatedText;
    content.appendChild(dst);
  }

  const applyExpand = (exp: boolean) => {
    src.style.cssText = `margin-top:4px;font-weight:600;font-size:0.92em;line-height:1.4;${clampStyle(
      exp,
      2,
    )}`;
    if (dst) {
      dst.style.cssText = `margin-top:3px;line-height:1.45;${clampStyle(exp, 3)}`;
    }
  };
  applyExpand(expanded);

  content.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const next = !expandedIds.has(rec.id);
    if (next) expandedIds.add(rec.id);
    else expandedIds.delete(rec.id);
    applyExpand(next);
  });

  // 底部：左侧标签、右侧「+」与日期（同一行、同一高度）
  const foot = doc.createElement("div");
  foot.style.cssText = "margin-top:6px;display:flex;align-items:center;gap:6px;";

  const tagWrap = doc.createElement("div");
  tagWrap.style.cssText = "flex:1;min-width:0;display:flex;flex-wrap:wrap;gap:4px;";
  for (const t of rec.tags ?? []) {
    tagWrap.appendChild(makeTagChip(doc, rec, t, onChanged));
  }
  foot.appendChild(tagWrap);

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
  foot.appendChild(addBtn);

  const date = doc.createElement("div");
  date.textContent = shortDate(rec.createdAt);
  date.title = rec.createdAt;
  date.style.cssText = "flex:none;font-size:0.75em;opacity:.55;";
  foot.appendChild(date);

  card.addEventListener("mouseenter", () => {
    actions.style.opacity = "1";
    card.style.background = "var(--fill-quaternary, rgba(127,127,127,.08))";
  });
  card.addEventListener("mouseleave", () => {
    actions.style.opacity = "0";
    card.style.background = "transparent";
  });

  card.appendChild(head);
  card.appendChild(content);
  card.appendChild(foot);
  card.appendChild(editor.wrap);

  return card;
}

/** 折叠时的行数截断样式；展开后不截断。 */
function clampStyle(expanded: boolean, lines: number): string {
  if (expanded) return "";
  return `-webkit-line-clamp:${lines};display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden;`;
}

/** 标签色相：同一标签始终映射到同一颜色。 */
function tagHue(tag: string): number {
  const s = (tag || "").trim().toLowerCase();
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

/** 标签胶囊的公共样式（背景/描边按标签着色）。 */
function tagChipStyle(hue: number, extra = ""): string {
  return (
    `font-size:0.75em;padding:1px 7px;border-radius:8px;cursor:pointer;color:inherit;` +
    `background:hsla(${hue},65%,50%,0.20);border:1px solid hsla(${hue},65%,45%,0.55);` +
    extra
  );
}

/** 已添加的标签胶囊：点 1 次变为 ✕，再点 1 次即删除该标签。 */
function makeTagChip(
  doc: Document,
  rec: import("../utils/history").HistoryRecord,
  tag: string,
  onChanged: () => void,
): HTMLElement {
  const chip = doc.createElement("span");
  chip.textContent = tag;
  chip.title = getString("history-removeTag");
  chip.style.cssText = tagChipStyle(tagHue(tag));
  let armed = false;
  chip.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (!armed) {
      armed = true;
      chip.textContent = "✕";
      chip.style.background = "hsla(0,70%,50%,0.20)";
      chip.style.borderColor = "hsla(0,70%,45%,0.60)";
      return;
    }
    if (historyStore.removeTag(rec.id, tag)) onChanged();
  });
  return chip;
}

/** 每条记录内联的「加标签」输入器：逐字实时匹配已有标签，Enter 完成添加。 */
function buildTagEditor(
  doc: Document,
  rec: import("../utils/history").HistoryRecord,
  onChanged: () => void,
): { wrap: HTMLElement; open: () => void } {
  const wrap = doc.createElement("div");
  wrap.style.cssText = "display:none;margin-top:6px;";
  // 阻止冒泡，避免点输入区时触发卡片的展开/收起
  wrap.addEventListener("click", (ev) => ev.stopPropagation());

  const input = doc.createElement("input");
  input.type = "text";
  input.placeholder = getString("history-tagPlaceholder");
  input.style.cssText = "width:100%;box-sizing:border-box;padding:2px 6px;";
  wrap.appendChild(input);

  const suggest = doc.createElement("div");
  suggest.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;";
  wrap.appendChild(suggest);

  const renderSuggestions = () => {
    suggest.textContent = "";
    for (const t of tagSuggestions(input.value, rec.tags)) {
      const chip = doc.createElement("button");
      chip.type = "button";
      chip.textContent = t;
      chip.style.cssText = tagChipStyle(tagHue(t));
      chip.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (historyStore.addTag(rec.id, t)) onChanged();
      });
      suggest.appendChild(chip);
    }
  };

  const commit = () => {
    const t = input.value.trim();
    if (!t) {
      wrap.style.display = "none";
      return;
    }
    if (historyStore.addTag(rec.id, t)) onChanged();
    else input.value = ""; // 已存在同名标签：仅清空输入
  };

  input.addEventListener("input", renderSuggestions);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      commit();
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      wrap.style.display = "none";
    }
  });

  return {
    wrap,
    open: () => {
      wrap.style.display = "block";
      renderSuggestions();
      input.focus();
    },
  };
}

/** 输入前缀时实时匹配的候选标签（排除本条已添加的，最多 8 个）。 */
function tagSuggestions(query: string, exclude: string[]): string[] {
  const q = (query || "").trim().toLowerCase();
  const ex = new Set((exclude ?? []).map((t) => t.toLowerCase()));
  return historyStore
    .allTags()
    .filter((t) => !ex.has(t.toLowerCase()))
    .filter((t) => (q ? t.toLowerCase().includes(q) : true))
    .slice(0, 8);
}

/** 日期缩略为笔记卡片风格：yyyy-MM-dd HH:mm:ss → yy/M/d。 */
function shortDate(createdAt: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(createdAt || "");
  if (!m) return createdAt || "";
  return `${m[1].slice(2)}/${Number(m[2])}/${Number(m[3])}`;
}

function fillTagOptions(sel: HTMLSelectElement, doc: Document) {
  const current = sel.value;
  sel.textContent = "";
  const all = doc.createElement("option");
  all.value = "";
  all.textContent = getString("history-allTags");
  sel.appendChild(all);
  for (const t of historyStore.allTags()) {
    const o = doc.createElement("option");
    o.value = t;
    o.textContent = t;
    sel.appendChild(o);
  }
  sel.value = current;
}

function matchesFilter(
  rec: import("../utils/history").HistoryRecord,
  filter: PaneFilter,
): boolean {
  if (filter.tag) {
    const hit = (rec.tags ?? []).some(
      (t) => t.toLowerCase() === filter.tag.toLowerCase(),
    );
    if (!hit) return false;
  }
  if (filter.text) {
    const q = filter.text.toLowerCase();
    if (
      !rec.sourceText.toLowerCase().includes(q) &&
      !rec.translatedText.toLowerCase().includes(q)
    ) {
      return false;
    }
  }
  return true;
}

function providerName(id: string): string {
  return services.getById(id) ? services.getDisplayName(id) : id;
}

/** 点击记录「服务来源」区域：跳回该原文在文档中的位置（找不到已打开的阅读器则新开）。 */
function jumpToRecord(rec: HistoryRecord) {
  if (typeof rec.itemId !== "number" || !rec.position) return;
  const locations = buildLocations(rec.position);
  if (locations.length === 0) return;
  const opened = getReaders().find((r) => r && r.itemID === rec.itemId);
  if (opened) {
    focusReaderTab(opened);
    void navigateReader(opened, locations);
    return;
  }
  void (async () => {
    try {
      const inst = await Zotero.Reader.open(rec.itemId as number, locations[0]);
      if (inst) focusReaderTab(inst);
    } catch (e) {
      Zotero.debug(`[DocBoxTrans] 打开阅读器定位失败: ${String(e)}`);
    }
  })();
}

/** 按优先顺序构造候选位置：选择器（HTML 快照/EPUB）或 页码+矩形（PDF），并带页码兜底。 */
function buildLocations(pos: RecordPosition): _ZoteroTypes.Reader.Location[] {
  const list: _ZoteroTypes.Reader.Location[] = [];
  if (pos.selector) {
    list.push({
      position: pos.selector as unknown as _ZoteroTypes.Reader.Location["position"],
    });
  }
  if (pos.pageIndex != null) {
    list.push({
      pageIndex: pos.pageIndex,
      position: { pageIndex: pos.pageIndex, rects: pos.rects },
    });
    list.push({ pageIndex: pos.pageIndex, pageLabel: pos.pageLabel });
  }
  return list;
}

/** 把目标阅读器所在标签/窗口切到前台，否则用户看不到跳转效果。 */
function focusReaderTab(reader: any | undefined) {
  if (!reader) return;
  try {
    if (reader._window?.focus) reader._window.focus();
    const win =
      reader._window ??
      (Zotero as unknown as { getMainWindow?: () => any }).getMainWindow?.();
    const tabs = (win as any)?.Zotero_Tabs;
    if (reader.tabID && tabs?.select) tabs.select(reader.tabID);
    if (reader.focus) reader.focus();
  } catch {
    // 忽略：切前台失败不影响定位本身
  }
}

/** 依次尝试候选位置定位；全部失败时记录调试输出。 */
async function navigateReader(
  reader: any,
  locations: _ZoteroTypes.Reader.Location[],
) {
  for (const loc of locations) {
    try {
      await reader.navigate(loc);
      return;
    } catch {
      // 该候选不可用，尝试下一个
    }
  }
  Zotero.debug("[DocBoxTrans] 跳转原文位置失败：所有候选位置均不可用");
}

function copyText(root: HTMLElement, text: string) {
  try {
    new ztoolkit.Clipboard().addText(text, "text/plain").copy();
  } catch {
    const win = root.ownerGlobal as unknown as Window;
    win?.navigator?.clipboard?.writeText(text);
  }
}

function mkBtn(
  doc: Document,
  text: string,
  onClick: () => void,
  small = false,
): HTMLButtonElement {
  const b = doc.createElement("button");
  b.textContent = text;
  b.style.cssText = small ? "font-size:0.8em;padding:1px 6px;" : "padding:2px 8px;";
  b.addEventListener("click", (ev) => {
    ev.stopPropagation();
    onClick();
  });
  return b;
}
