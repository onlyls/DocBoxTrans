import type { HistoryRecord } from "../utils/history";

/**
 * 连续上下文增强翻译的会话级上下文（移植自 DocBoxTrans 的 TranslationContext）。
 * 维护本次运行中成功翻译的原文/译文配对，供后续支持上下文的引擎参考；不写入磁盘。
 * 与 DocBoxTrans 的差异：按「所属文献（itemId）」隔离上下文，避免不同论文互相污染。
 *
 * 并发保护：Add / Clear / Snapshot 均在 UI 线程调用，无需加锁；请求发起时捕获「代次(generation)」，
 * 清空会自增代次，使清空前已发出的旧请求在成功回写时被丢弃。
 */
interface Entry {
  rec: HistoryRecord;
  seq: number; // 翻译发起顺序
}

function equalsIgnoreCase(a: unknown, b: unknown): boolean {
  return String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
}

function strLen(s: string | undefined | null): number {
  return s ? s.length : 0;
}

class TranslationContextStore {
  private entries: Entry[] = []; // 按 Seq 升序 = 翻译发起顺序
  private generation = 0;
  private seqCounter = 0;

  // 会话内最多保存的条目数（快照时再按 maxItems/maxChars 二次裁剪），防止长会话无限增长
  private static readonly MaxStoredEntries = 200;

  getGeneration(): number {
    return this.generation;
  }

  /** 分配一个单调递增的请求序号（= 翻译发起顺序）。 */
  nextSeq(): number {
    return ++this.seqCounter;
  }

  getCount(): number {
    return this.entries.length;
  }

  /**
   * 追加一条成功翻译。gen 与当前代次不一致（说明期间用户已清空）则丢弃，
   * 保证「清空后旧记录不会被在途请求重新写回」。
   */
  add(rec: HistoryRecord, seq: number, gen: number): void {
    if (!rec) return;
    if (gen !== this.generation) return;

    // 同一版本按发起顺序保留最新一次；不同窗口的响应也可能乱序返回。
    const sameVersion = (entry: Entry) => entry.rec.itemId === rec.itemId &&
      entry.rec.sourceText === rec.sourceText &&
      equalsIgnoreCase(entry.rec.provider, rec.provider) &&
      equalsIgnoreCase(entry.rec.targetLanguage, rec.targetLanguage);
    if (this.entries.some((entry) => sameVersion(entry) && entry.seq > seq)) return;
    this.entries = this.entries.filter((entry) => !sameVersion(entry));

    let i = this.entries.length;
    while (i > 0 && this.entries[i - 1].seq > seq) i--; // 按发起顺序插入，避免乱序
    this.entries.splice(i, 0, { rec, seq });
    while (this.entries.length > TranslationContextStore.MaxStoredEntries) {
      this.entries.shift();
    }
  }

  /**
   * 构建本次请求使用的上下文快照（返回「旧 → 新」的副本）。
   * 筛选与当前 provider、目标语言、所属文献一致的记录；从最新往旧累计，
   * 在计算预算前排除本次原文等不应参考的记录；超长记录跳过，保留完整的原文/译文配对。
   * 条数与原文+译文字符总数均不超过上限，最终按翻译发起顺序排列。
   */
  snapshot(
    itemId: number | undefined,
    provider: string,
    targetLanguage: string,
    maxItems: number,
    maxChars: number,
    exclude?: (rec: Readonly<HistoryRecord>) => boolean,
  ): HistoryRecord[] {
    const result: HistoryRecord[] = [];
    if (this.entries.length === 0) return result;
    if (!Number.isFinite(maxItems) || maxItems <= 0) maxItems = 4;
    if (!Number.isFinite(maxChars) || maxChars <= 0) maxChars = 1500;
    maxItems = Math.max(1, Math.floor(maxItems));
    maxChars = Math.floor(maxChars);

    const target = targetLanguage ?? "";
    const prov = provider ?? "";
    const key = itemId ?? -1;

    let taken = 0;
    let used = 0;
    for (let i = this.entries.length - 1; i >= 0 && taken < maxItems; i--) {
      const r = this.entries[i].rec;
      if (!r) continue;
      if ((r.itemId ?? -1) !== key) continue;
      if (!equalsIgnoreCase(r.provider, prov)) continue;
      if (!equalsIgnoreCase(r.targetLanguage, target)) continue;
      if (!r.sourceText?.trim() || !r.translatedText?.trim()) continue;
      if (exclude?.(r)) continue;

      const len = strLen(r.sourceText) + strLen(r.translatedText);
      if (used + len > maxChars) continue;
      result.push(r);
      taken++;
      used += len;
    }

    result.reverse(); // 旧 → 新，按翻译发起顺序构造消息
    return result;
  }

  /** 清空上下文并递增代次（不影响已展示的译文）。 */
  clear(): void {
    this.entries = [];
    this.generation++;
  }

  /** 按记录 id 移除（历史记录被删除时同步，避免其仍被当作上下文参考）。 */
  remove(id: string): void {
    if (!id) return;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const r = this.entries[i].rec;
      if (r && r.id === id) this.entries.splice(i, 1);
    }
  }

  /** 按原文移除：同一原文只保留最新一次（与 add 的去重一致）。 */
  removeBySource(source: string, itemId?: number): void {
    if (!source) return;
    const key = itemId ?? -1;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const r = this.entries[i].rec;
      if (r && (r.itemId ?? -1) === key && r.sourceText === source) {
        this.entries.splice(i, 1);
      }
    }
  }
}

export const translationContext = new TranslationContextStore();
