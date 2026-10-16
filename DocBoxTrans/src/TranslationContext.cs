using System;
using System.Collections.Generic;
using System.Threading;

namespace DocBoxTrans
{
    /// <summary>
    /// 连续上下文增强翻译的会话级上下文：维护本次运行中成功翻译的原文/译文配对，供后续 llm 请求参考。
    /// 不写入磁盘（应用退出即清空）；与历史记录存储解耦——清空上下文不影响历史记录。
    /// 并发保护：Add/Clear/Snapshot 只在 UI 线程调用，故无需加锁；请求发起时捕获「代次(generation)」，
    /// 清空会自增代次，使清空前已发出的旧请求在成功回写时被丢弃，避免旧上下文被重新注入。
    /// </summary>
    static class TranslationContext
    {
        sealed class Entry
        {
            public HistoryRecord Rec;
            public long Seq;   // 翻译发起顺序
        }

        // 会话内最多保存的条目数（快照时再按 maxItems/maxChars 二次裁剪），防止长会话无限增长
        const int MaxStoredEntries = 200;

        static readonly List<Entry> entries = new List<Entry>();   // 按 Seq 升序 = 翻译发起顺序
        static int generation;
        static long seqCounter;

        public static int Generation { get { return generation; } }

        public static int Count { get { return entries.Count; } }

        /// <summary>分配一个单调递增的请求序号（= 翻译发起顺序），可在任意线程调用。</summary>
        public static long NextSeq()
        {
            return Interlocked.Increment(ref seqCounter);
        }

        /// <summary>
        /// 把一条成功翻译追加到当前会话上下文。gen 与当前代次不一致（说明期间用户已清空）则丢弃，
        /// 保证「清空后旧记录不会被在途请求重新写回」。
        /// </summary>
        public static void Add(HistoryRecord rec, long seq, int gen)
        {
            if (rec == null) return;
            if (gen != generation) return;

            int i = entries.Count;
            while (i > 0 && entries[i - 1].Seq > seq) i--;   // 按发起顺序插入，避免按网络返回顺序乱序
            entries.Insert(i, new Entry { Rec = rec, Seq = seq });
            while (entries.Count > MaxStoredEntries) entries.RemoveAt(0);
        }

        /// <summary>
        /// 构建本次请求使用的上下文快照（返回「旧 → 新」的副本）。筛选与当前「来源文档 + provider + 目标语言」一致的记录；
        /// 从最新往旧累计，条数达 maxItems 或再加入会超过 maxChars 即停止；若最新一条单独就超限则返回空
        /// （此时按普通翻译处理）。快照为副本，翻译过程中不受其它请求的追加/清空影响。
        /// </summary>
        public static List<HistoryRecord> Snapshot(AppConfig cfg, string provider, int maxItems, int maxChars, string origin)
        {
            List<HistoryRecord> result = new List<HistoryRecord>();
            if (entries.Count == 0) return result;
            if (maxItems <= 0) maxItems = 1;
            if (maxChars <= 0) maxChars = 800;

            string target = cfg == null ? "" : (cfg.TargetLang ?? "");
            string prov = provider ?? "";
            string org = origin ?? "";

            int taken = 0;
            int used = 0;
            for (int i = entries.Count - 1; i >= 0 && taken < maxItems; i--)
            {
                HistoryRecord r = entries[i].Rec;
                if (r == null) continue;
                if (!string.Equals(r.Origin ?? "", org, StringComparison.Ordinal)) continue;
                if (!string.Equals(r.Provider, prov, StringComparison.OrdinalIgnoreCase)) continue;
                if (!string.Equals(r.TargetLanguage, target, StringComparison.OrdinalIgnoreCase)) continue;

                int len = Len(r.SourceText) + Len(r.TranslatedText);
                if (used + len > maxChars) break;   // 再加会超限 → 停止（最新一条单独超限时将得到空上下文）
                result.Add(r);
                taken++;
                used += len;
            }

            result.Reverse();   // 旧 → 新，便于按阅读顺序构造消息
            return result;
        }

        /// <summary>清空上下文并递增代次。不删除历史记录，也不影响已展示的译文。</summary>
        public static void Clear()
        {
            entries.Clear();
            generation++;
        }

        /// <summary>按记录 id 移除（历史窗口删除某条记录时同步，避免其仍被当作上下文参考）。</summary>
        public static void Remove(string id)
        {
            if (string.IsNullOrEmpty(id)) return;
            for (int i = entries.Count - 1; i >= 0; i--)
                if (entries[i].Rec != null && string.Equals(entries[i].Rec.Id, id, StringComparison.Ordinal))
                    entries.RemoveAt(i);
        }

        /// <summary>
        /// 按「来源文档 + 原文」移除：同一来源文档的同一原文只保留最新一次（切换翻译服务重译后，旧译文不再作为上下文）。
        /// 与历史记录「同一来源文档 + 原文只留最后一次」保持一致，避免上下文与历史错配。
        /// </summary>
        public static void RemoveBySource(string source, string origin)
        {
            if (string.IsNullOrEmpty(source)) return;
            string org = origin ?? "";
            for (int i = entries.Count - 1; i >= 0; i--)
                if (entries[i].Rec != null
                    && string.Equals(entries[i].Rec.SourceText, source, StringComparison.Ordinal)
                    && string.Equals(entries[i].Rec.Origin ?? "", org, StringComparison.Ordinal))
                    entries.RemoveAt(i);
        }

        static int Len(string s) { return s == null ? 0 : s.Length; }
    }
}