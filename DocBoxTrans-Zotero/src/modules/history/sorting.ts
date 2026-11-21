import type { HistoryRecord, RecordPosition } from "../../utils/history";
import type { PaneScope, SortMode } from "./types";

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

export { sortRecords };
