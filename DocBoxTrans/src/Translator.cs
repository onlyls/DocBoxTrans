using System;
using System.Collections.Generic;
using System.Net;
using System.Threading;
using System.Threading.Tasks;

namespace DocBoxTrans
{
    /// <summary>
    /// 翻译引擎分派器：按 config.ini 的 service 找到对应引擎（llm / google / bing / tencent / youdao / cnki）并调用。
    /// 具体实现见各 Engine 类，共用辅助见 TranslateSupport。
    /// </summary>
    static class Translator
    {
        static readonly ITranslateEngine Llm = new LlmEngine();
        static readonly ITranslateEngine[] Engines = new ITranslateEngine[]
        {
            Llm, new GoogleEngine(), new BingEngine(), new TencentEngine(), new YoudaoEngine(), new CnkiEngine()
        };

        public static void EnsureTls()
        {
            // 关闭 100-continue：部分服务端（如知网）不处理该头，会直接断开连接
            try { ServicePointManager.Expect100Continue = false; } catch { }
            try
            {
                // 兼容老框架：显式启用 TLS 1.2（以及 1.3，若系统支持）
                ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12 | (SecurityProtocolType)12288;
            }
            catch { ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12; }
        }

        /// <summary>按服务 id 查找引擎，找不到返回 null。</summary>
        static ITranslateEngine Find(string serviceId)
        {
            string id = (serviceId ?? "").Trim().ToLowerInvariant();
            for (int i = 0; i < Engines.Length; i++)
                if (string.Equals(Engines[i].Id, id, StringComparison.OrdinalIgnoreCase)) return Engines[i];
            return null;
        }

        /// <summary>把服务 id 转成中文名，用于弹窗展示；未知 id 原样返回。</summary>
        public static string DisplayName(string serviceId)
        {
            ITranslateEngine e = Find(serviceId);
            return e != null ? e.DisplayName : (serviceId ?? "");
        }

        /// <summary>
        /// 在给定配置下该服务是否具备上下文能力（大模型恒具备；有道的 auto 模式跟随「上下文增强翻译」开关，
        /// text 模式恒不具备）。
        /// 这只是必要条件，是否真正携带上下文还需用户开启「上下文增强翻译」。
        /// </summary>
        public static bool SupportsContext(AppConfig cfg, string serviceId)
        {
            ITranslateEngine e = Find(serviceId);
            return e != null && e.SupportsContext(cfg);
        }

        public static Task<TranslateResult> TranslateAsync(AppConfig cfg, string text, CancellationToken ct)
        {
            return TranslateAsync(cfg, text, null, ct);
        }

        /// <summary>
        /// 带上下文参考的统一入口。仅当所选引擎具备上下文能力且 context 非空时才注入；
        /// 其余情况（谷歌/必应/腾讯/知网、有道 text 模式，或未开启上下文增强）一律忽略 context，
        /// 走普通翻译，行为完全一致。
        /// </summary>
        public static Task<TranslateResult> TranslateAsync(AppConfig cfg, string text, IList<HistoryRecord> context, CancellationToken ct)
        {
            if (text == null) text = "";
            text = text.Trim();
            if (text.Length == 0) return Task.FromResult(TranslateResult.Err("[无内容] 没有可翻译的文本。"));

            ITranslateEngine e = Find(cfg == null ? null : cfg.Service);
            if (e == null) e = Llm; // 默认大模型
            if (e.SupportsContext(cfg) && context != null && context.Count > 0)
                return e.TranslateAsync(cfg, text, context, ct);
            return e.TranslateAsync(cfg, text, ct);
        }
    }
}
