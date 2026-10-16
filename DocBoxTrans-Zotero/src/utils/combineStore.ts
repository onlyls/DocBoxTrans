import type { RecordPosition } from "./history";

/**
 * 拼接翻译（拼合区）的会话级暂存。
 * 把阅读器中多次划选的片段按「所属附件(itemId)」分桶暂存，用户可把多段拼接成一段后一次性翻译，
 * 以获得跨片段连贯的译文。仅存于内存、不落盘；关闭或重启 Zotero 后自动清空。
 */
export interface CombineItem {
  /** 片段唯一标识（供 UI 移除）。 */
  id: string;
  /** 片段文本（已 trim）。 */
  text: string;
  /** 片段在原文档中的位置（拼合翻译后跳回原文时只取首段位置）。 */
  position?: RecordPosition;
}

/** 每个附件最多暂存的片段数，超出丢弃最早的，避免长会话无限增长。 */
const MAX_ITEMS = 50;

/** itemId → 片段列表；undefined 归入 -1 桶。 */
const baskets = new Map<number, CombineItem[]>();
/** 拼接模式：开启后新选区自动加入拼合区且不自动翻译（会话级、跨文档共享）。 */
let combineMode = false;

function keyOf(itemId?: number): number {
  return typeof itemId === "number" ? itemId : -1;
}

/** 指定文档的片段副本（按加入顺序）。 */
export function list(itemId?: number): CombineItem[] {
  return [...(baskets.get(keyOf(itemId)) ?? [])];
}

/** 指定文档的片段数量。 */
export function count(itemId?: number): number {
  return baskets.get(keyOf(itemId))?.length ?? 0;
}

/** 追加一段文本（同文档内按文本去重）；返回是否真正加入。 */
export function add(
  itemId: number | undefined,
  text: string,
  position?: RecordPosition,
): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  const key = keyOf(itemId);
  const arr = baskets.get(key) ?? [];
  if (arr.some((x) => x.text === t)) return false;
  arr.push({ id: Zotero.Utilities.randomString(12), text: t, position });
  while (arr.length > MAX_ITEMS) arr.shift();
  baskets.set(key, arr);
  return true;
}

/** 移除一个片段。 */
export function remove(itemId: number | undefined, id: string): boolean {
  const key = keyOf(itemId);
  const arr = baskets.get(key);
  if (!arr || !id) return false;
  const idx = arr.findIndex((x) => x.id === id);
  if (idx < 0) return false;
  arr.splice(idx, 1);
  if (arr.length === 0) baskets.delete(key);
  return true;
}

/** 清空指定文档的拼合区；返回是否确有内容被清空。 */
export function clear(itemId?: number): boolean {
  return baskets.delete(keyOf(itemId));
}

/** 拼接指定文档的全部片段为一段文本（空格相连）；无内容时返回空串。 */
export function join(itemId?: number): string {
  return list(itemId)
    .map((x) => x.text)
    .join(" ")
    .trim();
}

/** 拼合区首段的位置（供拼合翻译后跳回原文）。 */
export function firstPosition(itemId?: number): RecordPosition | undefined {
  return list(itemId)[0]?.position;
}

/** 拼接模式开关（会话级）。 */
export function getMode(): boolean {
  return combineMode;
}

export function setMode(value: boolean): void {
  combineMode = value;
}
