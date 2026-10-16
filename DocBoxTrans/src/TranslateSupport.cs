using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace DocBoxTrans
{
    /// <summary>各翻译引擎共用的 HTTP / JSON / 文本辅助方法。</summary>
    static class TranslateSupport
    {
        const string UserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

        /// <summary>
        /// 创建一个供单个引擎长期复用的 HttpClient（连接池复用）。
        /// proxy 为空串表示直连；非空则走该代理。超时不用 HttpClient.Timeout，而由 SendAsync 按请求用 CTS 控制。
        /// </summary>
        public static HttpClient CreateClient(string proxy)
        {
            HttpClientHandler handler = new HttpClientHandler();
            handler.UseProxy = proxy.Length > 0;
            if (proxy.Length > 0) handler.Proxy = new WebProxy(proxy);
            handler.AllowAutoRedirect = true;
            // 知网需要共享 Cookie（getToken 下发的 SESSION）；HttpClientHandler 默认 UseCookies=true 且自带 CookieContainer。
            handler.AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate;

            HttpClient c = new HttpClient(handler);
            c.Timeout = Timeout.InfiniteTimeSpan;   // 超时改由 SendAsync 的 CTS 控制
            c.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent", UserAgent);
            return c;
        }

        /// <summary>发送请求并读取响应文本；超时按 cfg.TimeoutSeconds 控制；非 2xx 抛 HttpStatusException（携带响应体）。</summary>
        public static async Task<string> SendAsync(AppConfig cfg, HttpClient client, HttpRequestMessage req, CancellationToken ct)
        {
            using (CancellationTokenSource cts = CancellationTokenSource.CreateLinkedTokenSource(ct))
            {
                cts.CancelAfter(TimeSpan.FromSeconds(Math.Max(5, cfg.TimeoutSeconds)));
                using (HttpResponseMessage resp = await client.SendAsync(req, HttpCompletionOption.ResponseContentRead, cts.Token).ConfigureAwait(false))
                {
                    string body = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
                    if (!resp.IsSuccessStatusCode) throw new HttpStatusException((int)resp.StatusCode, body);
                    return body;
                }
            }
        }

        public static string NormalizeProxy(string p)
        {
            p = p.Trim();
            if (p.IndexOf("://") < 0) p = "http://" + p;
            return p;
        }

        /// <summary>最小 JSON 字符串转义。</summary>
        public static string JsonString(string s)
        {
            if (s == null) s = "";
            StringBuilder sb = new StringBuilder(s.Length + 16);
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }

        /// <summary>按字符数把文本切成不超过 max 的若干块（知网接口有单次长度限制）。</summary>
        public static List<string> SplitChunks(string text, int max)
        {
            List<string> list = new List<string>();
            for (int i = 0; i < text.Length; i += max)
                list.Add(text.Substring(i, Math.Min(max, text.Length - i)));
            if (list.Count == 0) list.Add("");
            return list;
        }

        public static string Truncate(string s, int n)
        {
            if (s == null) return "";
            return s.Length <= n ? s : s.Substring(0, n) + "…";
        }

        /// <summary>
        /// 把 config.ini 的 target_lang（如 zh-CN）映射到各引擎所需的目标语言代码。
        /// zhCN / zhTW 为该引擎的简体、繁体代码；其它语言（en/ja/...）原样返回。
        /// </summary>
        public static string MapTargetLang(string lang, string zhCN, string zhTW)
        {
            string t = (lang ?? "").Trim();
            if (t.Length == 0) return zhCN;
            string low = t.ToLowerInvariant();
            if (low == "zh" || low == "zh-cn" || low == "zh-hans" || low == "zh-chs"
                || low == "zh_cn" || low == "chinese" || low == "zhongwen") return zhCN;
            if (low == "zh-tw" || low == "zh-hk" || low == "zh-hant" || low == "zh-cht"
                || low == "zh_tw") return zhTW;
            return t;
        }
    }

    /// <summary>HTTP 非 2xx 响应：携带状态码与响应体，便于各引擎复用统一的错误解析。</summary>
    class HttpStatusException : Exception
    {
        public readonly int StatusCode;
        public readonly string Body;
        public HttpStatusException(int statusCode, string body)
            : base("HTTP " + statusCode)
        {
            StatusCode = statusCode;
            Body = body;
        }
    }
}
