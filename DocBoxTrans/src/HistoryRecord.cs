using System;
using System.Collections.Generic;

namespace DocBoxTrans
{
    /// <summary>
    /// 一条成功翻译记录。原文与译文始终作为同一条记录持久化，避免分别管理后出现错配。
    /// 序列化用 JavaScriptSerializer（字段名即 JSON 键，沿用项目 PascalCase 风格）。
    /// </summary>
    class HistoryRecord
    {
        /// <summary>唯一记录标识。</summary>
        public string Id;

        /// <summary>原文（实际送去翻译的文本）。</summary>
        public string SourceText;

        /// <summary>译文（引擎原始输出，不含界面附加的截断提示）。</summary>
        public string TranslatedText;

        /// <summary>翻译完成时间，格式 "yyyy-MM-dd HH:mm:ss"（本地时间，可按字符串排序）。</summary>
        public string CreatedAt;

        /// <summary>源语言。本工具源语言始终为自动检测，无法可靠获取，固定为 "auto"。</summary>
        public string SourceLanguage;

        /// <summary>目标语言（记录时的 cfg.TargetLang，如 zh-CN）。</summary>
        public string TargetLanguage;

        /// <summary>翻译引擎标识（记录时的 cfg.Service：llm / google / bing / tencent / youdao / cnki）。</summary>
        public string Provider;

        /// <summary>
        /// 来源文档标识（形如 "DocBox|xxx.pdf … 稻壳阅读器"）：取词时由前台窗口的「进程名 + 规范化标题」得到，
        /// 用于「按文档隔离上下文」与「历史去重」；取不到时为空串（退化为全局，不隔离）。
        /// 旧记录没有该字段，反序列化后为 null，加载时归一化为 ""。
        /// </summary>
        public string Origin;

        /// <summary>用户为该记录附加的标签（可多个）；旧记录或未标注时为 null/空。</summary>
        public List<string> Tags;

        /// <summary>是否带有指定标签（忽略大小写与首尾空白）。</summary>
        public bool HasTag(string tag)
        {
            if (Tags == null || string.IsNullOrEmpty(tag)) return false;
            string t = tag.Trim();
            if (t.Length == 0) return false;
            for (int i = 0; i < Tags.Count; i++)
            {
                if (Tags[i] != null && string.Equals(Tags[i].Trim(), t, StringComparison.OrdinalIgnoreCase))
                    return true;
            }
            return false;
        }
    }
}