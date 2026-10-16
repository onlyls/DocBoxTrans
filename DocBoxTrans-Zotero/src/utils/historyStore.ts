import type { HistoryRecord, RecordPosition } from "./history";

/**
 * 翻译历史持久化（移植自 DocBoxTrans 的 HistoryStore）。
 * 内存中维护按时间正序的记录列表（唯一数据源），磁盘为每行一个 JSON 对象的文本文件。
 * 落盘异步合并进行，不阻塞 UI；单行解析失败只跳过该行。
 *
 * 与 DocBoxTrans 的差异：同一原文的去重按「原文 + 所属文献(itemId)」进行，
 * 避免同一句话在不同论文里被互相顶掉。
 */
let records: HistoryRecord[] = [];
let loaded = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** 用分隔符拼接路径：Zotero.File 底层走 PathUtils/nsIFile，Windows 下必须用原生反斜杠，混用正斜杠会 NS_ERROR_FILE_UNRECOGNIZED_PATH。 */
function joinNative(dir: string, name: string): string {
  if (!dir) return name;
  const sep = dir.includes("\\") ? "\\" : "/";
  const base = dir.endsWith("\\") || dir.endsWith("/") ? dir.slice(0, -1) : dir;
  return `${base}${sep}${name}`;
}

function historyPath(): string | null {
  try {
    const dir = (Zotero as unknown as { DataDirectory?: { dir?: string } })
      .DataDirectory?.dir;
    if (dir) return joinNative(dir, "docboxtrans-history.jsonl");
  } catch {
    // 忽略，走下面的回退
  }
  try {
    const profD = Services.dirsvc.get("ProfD", Components.interfaces.nsIFile);
    return joinNative(profD.path, "docboxtrans-history.jsonl");
  } catch {
    return null;
  }
}

function normalizePosition(raw: any): RecordPosition | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const pageIndex =
    typeof raw.pageIndex === "number" && Number.isFinite(raw.pageIndex)
      ? raw.pageIndex
      : undefined;
  const rects =
    Array.isArray(raw.rects) && raw.rects.length > 0 ? raw.rects : undefined;
  const pageLabel =
    typeof raw.pageLabel === "string" && raw.pageLabel ? raw.pageLabel : undefined;
  const sortIndex =
    typeof raw.sortIndex === "string" && raw.sortIndex ? raw.sortIndex : undefined;
  // selector：既支持我们包好的 position.selector，也兼容直接把选择器写在顶层
  let selector: RecordPosition["selector"];
  if (raw.selector && typeof raw.selector === "object") {
    selector = raw.selector;
  } else if (
    typeof raw.type === "string" &&
    (typeof raw.value === "string" || typeof raw.exact === "string")
  ) {
    selector = raw;
  }
  // 至少要有可定位信息（PDF 页码 / 页标签 / 选择器），否则视为无效位置
  if (pageIndex == null && !pageLabel && !selector) return undefined;
  return { pageIndex, rects, pageLabel, sortIndex, selector };
}

function normalize(raw: any): HistoryRecord {
  const rec: HistoryRecord = {
    id: typeof raw?.id === "string" && raw.id ? raw.id : Zotero.Utilities.randomString(16),
    sourceText: typeof raw?.sourceText === "string" ? raw.sourceText : "",
    translatedText: typeof raw?.translatedText === "string" ? raw.translatedText : "",
    createdAt: typeof raw?.createdAt === "string" ? raw.createdAt : "",
    sourceLanguage: typeof raw?.sourceLanguage === "string" ? raw.sourceLanguage : "auto",
    provider: typeof raw?.provider === "string" ? raw.provider : "",
    targetLanguage: typeof raw?.targetLanguage === "string" ? raw.targetLanguage : "",
    itemId: typeof raw?.itemId === "number" ? raw.itemId : undefined,
    parentItemId: typeof raw?.parentItemId === "number" ? raw.parentItemId : undefined,
    position: normalizePosition(raw?.position),
    tags: Array.isArray(raw?.tags) ? raw.tags.filter((t: unknown) => typeof t === "string") : [],
  };
  return rec;
}

/** 由附件 itemId 推导顶层文献条目 id（条目不存在或本身为顶层时返回 undefined）。 */
function deriveParentItemId(itemId?: number): number | undefined {
  if (typeof itemId !== "number") return undefined;
  try {
    const item = Zotero.Items.get(itemId);
    const parentId = item ? item.parentItemID : false;
    return typeof parentId === "number" ? parentId : undefined;
  } catch {
    return undefined;
  }
}

function sourceKey(rec: HistoryRecord): string {
  return `${rec.itemId ?? -1}\u0000${rec.sourceText}`;
}

/** 同一原文+文献只保留最后一次翻译结果（从最新往旧扫描）。 */
function dedupeBySource(list: HistoryRecord[]): HistoryRecord[] {
  const seen = new Set<string>();
  const out: HistoryRecord[] = [];
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i];
    if (!r.sourceText) {
      out.unshift(r);
      continue;
    }
    const key = sourceKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    out.unshift(r);
  }
  return out;
}

/** 启动时读入既有记录（只做一次）。 */
export async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  loaded = true;
  const path = historyPath();
  if (!path) return;
  let text = "";
  try {
    text = (await Zotero.File.getContentsAsync(path)) as string;
  } catch (e) {
    // 首次运行文件不存在属正常情况；其它错误打到调试输出便于排查
    Zotero.debug(`[DocBoxTrans] 读取历史文件失败: ${String(e)}`);
    text = "";
  }
  const list: HistoryRecord[] = [];
  for (const line of (text || "").split("\n")) {
    const t = line.replace(/^\uFEFF/, "").trim();
    if (!t) continue;
    try {
      list.push(normalize(JSON.parse(t)));
    } catch {
      // 单行损坏只跳过该行
    }
  }
  records = dedupeBySource(list);
}

async function saveNow(): Promise<void> {
  const path = historyPath();
  if (!path) return;
  const text = records.map((r) => JSON.stringify(r)).join("\n");
  try {
    await Zotero.File.putContentsAsync(path, text);
  } catch (e) {
    // 落盘失败不阻塞翻译，但记录到调试输出
    Zotero.debug(`[DocBoxTrans] 写入历史文件失败: ${String(e)}`);
  }
}

function scheduleSave(): void {
  if (saveTimer != null) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveNow();
  }, 300);
}

function find(id: string): HistoryRecord | undefined {
  return records.find((r) => r.id === id);
}

/** 追加一条成功翻译记录并返回它（供上下文模块复用）。 */
export function add(
  source: string,
  translated: string,
  provider: string,
  targetLang: string,
  itemId?: number,
  position?: RecordPosition,
): HistoryRecord {
  const rec: HistoryRecord = {
    id: Zotero.Utilities.randomString(16),
    sourceText: source ?? "",
    translatedText: translated ?? "",
    createdAt: nowString(),
    sourceLanguage: "auto",
    provider: provider ?? "",
    targetLanguage: targetLang ?? "",
    itemId,
    parentItemId: deriveParentItemId(itemId),
    position: position ?? undefined,
    tags: [],
  };

  // 同一原文+文献只保留最后一次结果
  if (rec.sourceText) {
    const key = sourceKey(rec);
    for (let i = records.length - 1; i >= 0; i--) {
      if (sourceKey(records[i]) === key) records.splice(i, 1);
    }
  }
  records.push(rec);
  scheduleSave();
  return rec;
}

/** 按 id 删除一条记录。 */
export function remove(id: string): boolean {
  if (!id) return false;
  const idx = records.findIndex((r) => r.id === id);
  if (idx < 0) return false;
  records.splice(idx, 1);
  scheduleSave();
  return true;
}

/** 清空全部历史记录。 */
export function clear(): void {
  if (records.length === 0) return;
  records = [];
  scheduleSave();
}

export function addTag(id: string, tag: string): boolean {
  const t = (tag ?? "").trim();
  if (!id || !t) return false;
  const r = find(id);
  if (!r) return false;
  if (r.tags.some((x) => x.toLowerCase() === t.toLowerCase())) return false;
  r.tags.push(t);
  scheduleSave();
  return true;
}

export function removeTag(id: string, tag: string): boolean {
  const t = (tag ?? "").trim();
  if (!id || !t) return false;
  const r = find(id);
  if (!r) return false;
  const before = r.tags.length;
  r.tags = r.tags.filter((x) => x.toLowerCase() !== t.toLowerCase());
  if (r.tags.length === before) return false;
  scheduleSave();
  return true;
}

export function clearTags(id: string): boolean {
  const r = find(id);
  if (!r || r.tags.length === 0) return false;
  r.tags = [];
  scheduleSave();
  return true;
}

/** 全部已用标签（去重、按名称排序）。 */
export function allTags(): string[] {
  const seen = new Set<string>();
  const list: string[] = [];
  for (const r of records) {
    for (const t of r.tags ?? []) {
      const v = t.trim();
      if (!v) continue;
      const k = v.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      list.push(v);
    }
  }
  list.sort((a, b) => a.localeCompare(b));
  return list;
}

/** 按时间倒序（最新在前）的副本，供侧栏渲染。 */
export function snapshot(): HistoryRecord[] {
  return [...records].reverse();
}

/** 是否属于指定条目：命中附件 (itemId) 或所属顶层文献 (parentItemId)。 */
export function belongsToItem(rec: HistoryRecord, itemId?: number): boolean {
  if (typeof itemId !== "number") return false;
  return rec.itemId === itemId || rec.parentItemId === itemId;
}

/**
 * 某个附件 itemId 是否落在指定面板范围内（本身相等，或该附件所属顶层文献等于范围 id）。
 * 供侧栏「当前翻译」判断当前任务是否属于本篇：阅读器面板范围=附件 id，条目面板范围=顶层文献 id。
 */
export function itemInScope(itemId: number | undefined, scopeId?: number): boolean {
  if (typeof itemId !== "number" || typeof scopeId !== "number") return false;
  if (itemId === scopeId) return true;
  return deriveParentItemId(itemId) === scopeId;
}

/** 指定条目的记录副本（最新在前）；itemId 为空时返回空数组。 */
export function snapshotForItem(itemId?: number): HistoryRecord[] {
  if (typeof itemId !== "number") return [];
  return records.filter((r) => belongsToItem(r, itemId)).reverse();
}

/** 指定附件（文件）自己的记录副本（最新在前）；只按 itemId 匹配，不含同文献的其它文件。 */
export function snapshotForFile(itemId?: number): HistoryRecord[] {
  if (typeof itemId !== "number") return [];
  return records.filter((r) => r.itemId === itemId).reverse();
}

/**
 * 查找同文本 + 同引擎 + 同目标语言的历史记录（用于复用译文）。
 * 从最新往旧扫描，返回第一条命中（含其 position，便于跳转对应位置）。
 */
export function findBySource(
  sourceText: string,
  itemId: number | undefined,
  provider: string,
  targetLang: string,
): HistoryRecord | undefined {
  if (!sourceText) return undefined;
  const key = itemId ?? -1;
  const eq = (a: unknown, b: unknown) =>
    String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if ((r.itemId ?? -1) !== key) continue;
    if (r.sourceText !== sourceText) continue;
    if (!eq(r.provider, provider)) continue;
    if (!eq(r.targetLanguage, targetLang)) continue;
    return r;
  }
  return undefined;
}

/** 删除指定条目的全部记录（供「清空本条目」），并落盘。 */
export function clearForItem(itemId?: number): number {
  if (typeof itemId !== "number") return 0;
  const before = records.length;
  records = records.filter((r) => !belongsToItem(r, itemId));
  const removed = before - records.length;
  if (removed > 0) scheduleSave();
  return removed;
}

/** 只删除指定附件（文件）自己的记录（供阅读器里的「清空本文件」），并落盘。 */
export function clearForFile(itemId?: number): number {
  if (typeof itemId !== "number") return 0;
  const before = records.length;
  records = records.filter((r) => r.itemId !== itemId);
  const removed = before - records.length;
  if (removed > 0) scheduleSave();
  return removed;
}

/**
 * 为缺失 parentItemId 的旧记录惰性回填顶层文献 id（首次渲染侧栏时调用一次）。
 * 条目已被删除时回填失败，记录保持无归属（不影响其按附件 itemId 展示）。
 */
export function ensureParentsBackfilled(): void {
  let changed = false;
  for (const r of records) {
    if (r.parentItemId != null || typeof r.itemId !== "number") continue;
    const pid = deriveParentItemId(r.itemId);
    if (pid != null) {
      r.parentItemId = pid;
      changed = true;
    }
  }
  if (changed) scheduleSave();
}

export function count(): number {
  return records.length;
}

export function getById(id: string): HistoryRecord | undefined {
  return find(id);
}

function nowString(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
    d.getHours(),
  )}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
