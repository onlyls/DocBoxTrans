import type { HistoryRecord, RecordPosition } from "./history";

/**
 * 翻译历史持久化（移植自 DocBoxTrans 的 HistoryStore）。
 * 内存中维护按时间正序的记录列表（唯一数据源），磁盘为每行一个 JSON 对象的文本文件。
 * 落盘异步合并进行，不阻塞 UI；单行解析失败只跳过该行。
 *
 * 按附件、原文、引擎、目标语言保留译文；同段原文的所有版本共享标签。
 */
let records: HistoryRecord[] = [];
let loaded = false;
let loadPromise: Promise<void> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let savePromise: Promise<void> | null = null;
let revision = 0;
let savedRevision = 0;
let storageError = false;
// 读取失败期间临时创建的记录，合并旧文件后仍能由当前任务的旧 id 找到。
const idAliases = new Map<string, string>();
let onStorageStateChange: (() => void) | undefined;

function setStorageError(value: boolean): void {
  if (storageError === value) return;
  storageError = value;
  onStorageStateChange?.();
}

export function setStorageStateListener(listener?: () => void): void {
  onStorageStateChange = listener;
}

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
  return JSON.stringify([
    rec.itemId ?? -1,
    rec.sourceText,
    rec.provider.toLowerCase(),
    rec.targetLanguage.toLowerCase(),
  ]);
}

function paragraphKey(rec: HistoryRecord): string {
  return JSON.stringify([rec.itemId ?? null, rec.sourceText]);
}

function mergedTags(list: readonly HistoryRecord[]): string[] {
  const tags = new Map<string, string>();
  for (const rec of list) for (const raw of rec.tags) {
    const tag = raw.trim();
    if (tag && !tags.has(tag.toLowerCase())) tags.set(tag.toLowerCase(), tag);
  }
  return [...tags.values()];
}

function relatedRecords(rec: HistoryRecord): HistoryRecord[] {
  const key = paragraphKey(rec);
  return records.filter(record => paragraphKey(record) === key);
}

function setSharedTags(rec: HistoryRecord, tags: string[]): void {
  for (const record of relatedRecords(rec)) record.tags = tags;
}

/** 合并旧文件中按引擎隔离的标签，采用并集保留已有标注。 */
function shareLoadedTags(): boolean {
  const groups = new Map<string, HistoryRecord[]>();
  for (const rec of records) {
    const key = paragraphKey(rec);
    const group = groups.get(key) ?? [];
    group.push(rec); groups.set(key, group);
  }
  let changed = false;
  for (const group of groups.values()) {
    const tags = mergedTags(group);
    for (const rec of group) {
      if (JSON.stringify(rec.tags) !== JSON.stringify(tags)) changed = true;
      rec.tags = tags;
    }
  }
  return changed;
}

/** 同一附件、原文、引擎、语言保留最新结果，合并已有标签。 */
function dedupeBySource(list: HistoryRecord[]): HistoryRecord[] {
  const seen = new Map<string, HistoryRecord>();
  const out: HistoryRecord[] = [];
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i];
    if (!r.sourceText) {
      out.unshift(r);
      continue;
    }
    const key = sourceKey(r);
    const latest = seen.get(key);
    if (latest) {
      latest.tags = [...new Set([...r.tags, ...latest.tags])];
      if (latest.id !== r.id) idAliases.set(latest.id, r.id);
      latest.id = r.id;
      latest.position ??= r.position;
      continue;
    }
    seen.set(key, r);
    out.unshift(r);
  }
  return out;
}

/** 启动时读入既有记录（只做一次）。 */
export async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  if (loadPromise) return loadPromise;
  loadPromise = loadHistory();
  try {
    await loadPromise;
  } finally {
    loadPromise = null;
  }
}

async function loadHistory(): Promise<void> {
  const path = historyPath();
  if (!path) throw new Error("History path is unavailable");
  try {
    // 只有明确不存在的文件才作为首次运行；读取失败时禁止覆盖原文件。
    const text = (await IOUtils.exists(path)) ? await IOUtils.readUTF8(path) : "";
    const list: HistoryRecord[] = [];
    for (const line of text.split("\n")) {
      const t = line.replace(/^\uFEFF/, "").trim();
      if (!t) continue;
      try {
        list.push(normalize(JSON.parse(t)));
      } catch {
        Zotero.debug("[DocBoxTrans] 跳过损坏的历史记录；下次写入前会备份原文件");
      }
    }
    // 读取失败期间的新译文暂存于内存，重试成功后合并，不能被磁盘快照顶掉。
    records = dedupeBySource([...list, ...records]);
    const tagsChanged = shareLoadedTags();
    loaded = true;
    if (tagsChanged) scheduleSave();
    setStorageError(false);
  } catch (e) {
    setStorageError(true);
    throw e;
  }
}

/** 等待所有待保存变更落盘；失败保留脏状态，供后续修改或关闭时重试。 */
export async function flush(): Promise<void> {
  if (saveTimer != null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (savePromise) return savePromise;
  if (savedRevision === revision) return;
  savePromise = savePending();
  try {
    await savePromise;
  } finally {
    savePromise = null;
  }
}

async function savePending(): Promise<void> {
  try {
    await ensureLoaded();
    const path = historyPath();
    if (!path) throw new Error("History path is unavailable");
    // 单个写入循环串行排空；写入期间的新变更会在下一轮保存。
    while (savedRevision < revision) {
      const version = revision;
      const text = records.map((r) => JSON.stringify(r)).join("\n");
      await IOUtils.writeUTF8(path, text, {
        tmpPath: `${path}.tmp`,
        backupFile: `${path}.bak`,
        flush: true,
      });
      savedRevision = version;
    }
    setStorageError(false);
  } catch (e) {
    setStorageError(true);
    throw e;
  }
}

function scheduleSave(): void {
  revision++;
  if (saveTimer != null) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void flush().catch((e) => Zotero.logError(e));
  }, 300);
}

export function hasStorageError(): boolean {
  return storageError;
}

function find(id: string): HistoryRecord | undefined {
  const visited = new Set<string>();
  while (idAliases.has(id) && !visited.has(id)) {
    visited.add(id);
    id = idAliases.get(id)!;
  }
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

  // 同版本重译保留 id、标签和已有位置；其它引擎/语言保留各自的译文。
  if (rec.sourceText) {
    const key = sourceKey(rec);
    const previous = records.find((r) => sourceKey(r) === key);
    const related = relatedRecords(rec);
    if (previous) {
      rec.id = previous.id;
      rec.position ??= previous.position;
    }
    rec.tags = mergedTags(related);
    related.forEach(record => { record.tags = rec.tags; });
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
  const record = find(id);
  const idx = record ? records.indexOf(record) : -1;
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
  const tags = mergedTags(relatedRecords(r));
  if (tags.some((x) => x.toLowerCase() === t.toLowerCase())) return false;
  setSharedTags(r, [...tags, t]);
  scheduleSave();
  return true;
}

export function removeTag(id: string, tag: string): boolean {
  const t = (tag ?? "").trim();
  if (!id || !t) return false;
  const r = find(id);
  if (!r) return false;
  const tags = mergedTags(relatedRecords(r));
  const remaining = tags.filter(x => x.toLowerCase() !== t.toLowerCase());
  if (remaining.length === tags.length) return false;
  setSharedTags(r, remaining);
  scheduleSave();
  return true;
}

export function clearTags(id: string): boolean {
  const r = find(id);
  if (!r || !relatedRecords(r).some(record => record.tags.length)) return false;
  setSharedTags(r, []);
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
