import { config } from "../../../package.json";
import type { HistoryRecord } from "../../utils/history";
import type { PaneScope, PaneFilter, ScopeKind } from "./types";

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

/** 解析本面板范围对应的当前拼合文档 id：文件范围=附件 id；条目范围=当前打开的阅读器附件。 */
function combineItemId(scope: PaneScope): number | undefined {
  if (scope.kind === "file") return scope.id;
  if (typeof scope.id === "number") return findOpenReaderChildItemId(scope.id);
  return undefined;
}

function matchesFilter(
  rec: HistoryRecord,
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

export { setBodyScope, readTabType, readScope, readFilter, writeFilter, getReaders, combineItemId, matchesFilter };
