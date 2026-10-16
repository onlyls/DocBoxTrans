using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace DocBoxTrans
{
    /// <summary>
    /// 翻译历史持久化：内存中维护按时间正序的记录列表（唯一数据源），磁盘为每行一个 JSON 对象的文本文件。
    /// 落盘异步进行，不阻塞 UI；单行解析失败只跳过该行，避免一处损坏导致全部不可读。
    /// 线程安全：所有读写都在 sync 锁内；文件写入另用 saveLock 串行，避免并发覆盖。
    /// 仅使用框架自带的 JavaScriptSerializer，不引入第三方依赖。
    /// </summary>
    static class HistoryStore
    {
        static readonly object sync = new object();
        static readonly object saveLock = new object();
        static readonly List<HistoryRecord> records = new List<HistoryRecord>();
        static string path;
        static int max = 500;
        static Action<string> log;

        public static int Count { get { lock (sync) return records.Count; } }

        /// <summary>初始化：读入既有记录并按上限裁剪。启动时调用一次。</summary>
        public static void Init(string filePath, int maxRecords, Action<string> logger)
        {
            log = logger;
            lock (sync)
            {
                path = filePath;
                max = maxRecords > 0 ? maxRecords : 500;
                records.Clear();
                LoadInto(records, path);
                bool changed = DedupeBySource();   // 整理历史遗留的重复记录
                if (TrimToMax()) changed = true;
                if (changed) ScheduleSave();
            }
        }

        /// <summary>更新保存上限（配置重载后调用），超出则立即裁剪。</summary>
        public static void SetMax(int maxRecords)
        {
            lock (sync)
            {
                max = maxRecords > 0 ? maxRecords : 500;
                if (TrimToMax()) ScheduleSave();
            }
        }

        /// <summary>
        /// 追加一条成功翻译记录，返回记录对象（供上下文模块复用）。落盘异步进行。
        /// 同一「来源文档 + 原文」只保留最新一次翻译结果：同一句在不同文档里互不影响，
        /// 同一文档内切换翻译服务重译时旧记录被本记录替换。
        /// </summary>
        public static HistoryRecord Add(string source, string translated, string provider, string targetLang, string origin)
        {
            HistoryRecord rec = new HistoryRecord();
            rec.Id = Guid.NewGuid().ToString("N");
            rec.SourceText = source == null ? "" : source;
            rec.TranslatedText = translated == null ? "" : translated;
            rec.CreatedAt = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss");
            rec.SourceLanguage = "auto";   // 源语言无法可靠获取，固定 auto
            rec.TargetLanguage = targetLang == null ? "" : targetLang;
            rec.Provider = provider == null ? "" : provider;
            rec.Origin = origin == null ? "" : origin;
            rec.Tags = new List<string>();
            lock (sync)
            {
                // 同一来源文档 + 同一原文（精确匹配）只保留最后一次翻译结果
                if (rec.SourceText.Length > 0)
                {
                    for (int i = records.Count - 1; i >= 0; i--)
                        if (string.Equals(records[i].SourceText, rec.SourceText, StringComparison.Ordinal)
                            && string.Equals(records[i].Origin ?? "", rec.Origin, StringComparison.Ordinal))
                            records.RemoveAt(i);
                }
                records.Add(rec);
                TrimToMax();
            }
            ScheduleSave();
            return rec;
        }

        /// <summary>按 id 删除一条记录（历史窗口的删除按钮）。删除后异步落盘；返回是否确实删除了记录。</summary>
        public static bool Delete(string id)
        {
            if (string.IsNullOrEmpty(id)) return false;
            bool removed = false;
            lock (sync)
            {
                for (int i = records.Count - 1; i >= 0; i--)
                {
                    if (string.Equals(records[i].Id, id, StringComparison.Ordinal))
                    {
                        records.RemoveAt(i);
                        removed = true;
                    }
                }
            }
            if (removed) ScheduleSave();
            return removed;
        }

        /// <summary>给指定记录追加一个标签（去重、忽略大小写）；返回是否确实新增。落盘异步进行。</summary>
        public static bool AddTag(string id, string tag)
        {
            tag = (tag ?? "").Trim();
            if (string.IsNullOrEmpty(id) || tag.Length == 0) return false;
            bool changed = false;
            lock (sync)
            {
                HistoryRecord r = Find(id);
                if (r == null) return false;
                if (r.Tags == null) r.Tags = new List<string>();
                if (!r.HasTag(tag)) { r.Tags.Add(tag); changed = true; }
            }
            if (changed) ScheduleSave();
            return changed;
        }

        /// <summary>移除指定记录的某个标签（忽略大小写）；返回是否确实移除。</summary>
        public static bool RemoveTag(string id, string tag)
        {
            tag = (tag ?? "").Trim();
            if (string.IsNullOrEmpty(id) || tag.Length == 0) return false;
            bool changed = false;
            lock (sync)
            {
                HistoryRecord r = Find(id);
                if (r == null || r.Tags == null) return false;
                for (int i = r.Tags.Count - 1; i >= 0; i--)
                {
                    if (r.Tags[i] != null && string.Equals(r.Tags[i].Trim(), tag, StringComparison.OrdinalIgnoreCase))
                    {
                        r.Tags.RemoveAt(i);
                        changed = true;
                    }
                }
            }
            if (changed) ScheduleSave();
            return changed;
        }

        /// <summary>清空指定记录的全部标签；返回是否确实有变化。</summary>
        public static bool ClearTags(string id)
        {
            if (string.IsNullOrEmpty(id)) return false;
            bool changed = false;
            lock (sync)
            {
                HistoryRecord r = Find(id);
                if (r != null && r.Tags != null && r.Tags.Count > 0)
                {
                    r.Tags.Clear();
                    changed = true;
                }
            }
            if (changed) ScheduleSave();
            return changed;
        }

        /// <summary>全部已用标签（去重、按名称排序），供筛选栏与卡片标签菜单展示。</summary>
        public static List<string> AllTags()
        {
            lock (sync)
            {
                List<string> list = new List<string>();
                HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                for (int i = 0; i < records.Count; i++)
                {
                    List<string> tags = records[i].Tags;
                    if (tags == null) continue;
                    for (int j = 0; j < tags.Count; j++)
                    {
                        string t = tags[j] == null ? "" : tags[j].Trim();
                        if (t.Length == 0) continue;
                        if (seen.Add(t)) list.Add(t);
                    }
                }
                list.Sort(StringComparer.CurrentCulture);
                return list;
            }
        }

        /// <summary>按 id 查找记录对象（返回内部引用，调用方须持有 sync）。</summary>
        static HistoryRecord Find(string id)
        {
            for (int i = 0; i < records.Count; i++)
                if (string.Equals(records[i].Id, id, StringComparison.Ordinal)) return records[i];
            return null;
        }

        /// <summary>
        /// 查找同「来源文档 + 原文 + 引擎 + 目标语言」的最近一条记录（用于请求级复用，命中即直接返回译文、不重复发请求）。
        /// 从最新往旧扫描，命中第一条即返回；无命中返回 null。
        /// </summary>
        public static HistoryRecord FindBySource(string source, string provider, string targetLang, string origin)
        {
            if (string.IsNullOrEmpty(source)) return null;
            string prov = provider ?? "";
            string target = targetLang ?? "";
            string org = origin ?? "";
            lock (sync)
            {
                for (int i = records.Count - 1; i >= 0; i--)
                {
                    HistoryRecord r = records[i];
                    if (r == null) continue;
                    if (!string.Equals(r.Origin ?? "", org, StringComparison.Ordinal)) continue;
                    if (!string.Equals(r.SourceText, source, StringComparison.Ordinal)) continue;
                    if (!string.Equals(r.Provider, prov, StringComparison.OrdinalIgnoreCase)) continue;
                    if (!string.Equals(r.TargetLanguage, target, StringComparison.OrdinalIgnoreCase)) continue;
                    return r;
                }
            }
            return null;
        }

        /// <summary>返回按时间倒序（最新在前）的副本，供历史窗口渲染。</summary>
        public static List<HistoryRecord> Snapshot()
        {
            lock (sync)
            {
                List<HistoryRecord> copy = new List<HistoryRecord>(records.Count);
                for (int i = records.Count - 1; i >= 0; i--) copy.Add(records[i]);
                return copy;
            }
        }

        // ---------------- 内部 ----------------

        /// <summary>超出上限时从头（最旧）移除。调用方须持有 sync。</summary>
        static bool TrimToMax()
        {
            int m = max > 0 ? max : 500;
            bool changed = false;
            while (records.Count > m) { records.RemoveAt(0); changed = true; }
            return changed;
        }

        /// <summary>
        /// 同一「来源文档 + 原文」只保留最后一次翻译结果：从最新往旧扫描，丢弃更早的同键记录。
        /// 用于整理升级前遗留的重复记录（切换翻译服务重译会产生同键多条）。调用方须持有 sync。
        /// </summary>
        static bool DedupeBySource()
        {
            bool changed = false;
            HashSet<string> seen = new HashSet<string>(StringComparer.Ordinal);
            for (int i = records.Count - 1; i >= 0; i--)
            {
                string s = records[i].SourceText;
                if (string.IsNullOrEmpty(s)) continue;
                string key = (records[i].Origin ?? "") + "\u0000" + s;
                if (!seen.Add(key)) { records.RemoveAt(i); changed = true; }
            }
            return changed;
        }

        static void LoadInto(List<HistoryRecord> into, string file)
        {
            if (string.IsNullOrEmpty(file) || !File.Exists(file)) return;
            string[] lines;
            try { lines = File.ReadAllLines(file, Encoding.UTF8); }
            catch (Exception ex) { LogErr("读取历史文件失败：" + ex.Message); return; }

            JavaScriptSerializer ser = new JavaScriptSerializer();
            ser.MaxJsonLength = 16 * 1024 * 1024;
            int bad = 0;
            for (int i = 0; i < lines.Length; i++)
            {
                string line = lines[i];
                if (line.Length > 0 && line[0] == '\uFEFF') line = line.Substring(1);
                line = line.Trim();
                if (line.Length == 0) continue;
                try
                {
                    HistoryRecord r = ser.Deserialize<HistoryRecord>(line);
                    if (r == null) { bad++; continue; }
                    if (string.IsNullOrEmpty(r.Id)) r.Id = Guid.NewGuid().ToString("N");
                    if (r.SourceText == null) r.SourceText = "";
                    if (r.TranslatedText == null) r.TranslatedText = "";
                    if (r.CreatedAt == null) r.CreatedAt = "";
                    if (r.Origin == null) r.Origin = "";   // 旧记录无该字段：归一化为空（全局桶）
                    if (r.Tags == null) r.Tags = new List<string>();
                    into.Add(r);
                }
                catch { bad++; }
            }
            if (bad > 0) LogErr("历史文件有 " + bad + " 行无法解析，已跳过");
        }

        static void ScheduleSave()
        {
            Task.Factory.StartNew(SaveNow);
        }

        static void SaveNow()
        {
            if (string.IsNullOrEmpty(path)) return;
            string[] lines;
            lock (sync)
            {
                JavaScriptSerializer ser = new JavaScriptSerializer();
                ser.MaxJsonLength = 16 * 1024 * 1024;
                lines = new string[records.Count];
                for (int i = 0; i < records.Count; i++) lines[i] = ser.Serialize(records[i]);
            }
            lock (saveLock)
            {
                try
                {
                    string tmp = path + ".tmp";
                    File.WriteAllLines(tmp, lines, new UTF8Encoding(false));
                    if (File.Exists(path))
                    {
                        try { File.Replace(tmp, path, path + ".bak"); }
                        catch
                        {
                            // File.Replace 在个别环境不可用，退化为删除后移动
                            try { File.Delete(path); } catch { }
                            File.Move(tmp, path);
                        }
                    }
                    else File.Move(tmp, path);
                }
                catch (Exception ex) { LogErr("写入历史文件失败：" + ex.Message); }
            }
        }

        static void LogErr(string msg)
        {
            Action<string> l = log;
            if (l != null) { try { l(msg); } catch { } }
        }
    }
}