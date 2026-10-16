using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace DocBoxTrans
{
    /// <summary>
    /// 必应翻译引擎（免费）：调用微软 Edge 客户端使用的在线翻译接口
    ///   POST https://edge.microsoft.com/translate/translatetext?to=&lt;目标语言&gt;&amp;isEnterpriseClient=false
    /// 请求体为「字符串数组」（["待翻译文本"]），无需注册 key，也不需要 X-MT-Signature 匿名签名。
    /// 该接口与请求格式参考自 zotero-pdf-translate 的必应服务（AGPL-3.0）：https://github.com/windingwind/zotero-pdf-translate
    ///
    /// 与旧端点 api.cognitive.microsofttranslator.com/translate（匿名签名）相比：
    ///   - 旧端点限制「单次请求内所有待翻译文本合计 ≤1000 字符」，故短文本正常、长文本必被拒；
    ///   - 本端点单次上限为 50000 字符（官方文档值；实测 50000 通过，100000 返回
    ///     "Request exceeds the maximum allowed translation size."）。
    ///     因此这里按块逐次请求、每块不超过 MaxChunk，既避开上限又尽量少发请求。
    ///
    /// 注意事项：
    ///   - 必须携带浏览器 User-Agent，缺失会返回 400 "Client Browser Version not supported"；
    ///     共享 HttpClient 已统一设置 Chrome UA，无需在请求上单独添加。
    ///   - 不要传 from 参数：服务端会自动识别源语言；显式传 "auto" 会返回 400。
    /// 国内通常需要代理（走 cfg.Proxy）。
    /// </summary>
    class BingEngine : ITranslateEngine
    {
        // 免费接口对国内网络通常不通，需要代理；代理变更时重建 HttpClient。
        static readonly object clientLock = new object();
        static HttpClient client;
        static string clientProxy;

        const string DefaultApi = "https://edge.microsoft.com/translate/translatetext";
        // 旧版内置端点：其匿名签名接口对单次请求有 1000 字符上限，长文本必然失败。
        // 配置文件里仍写着它的（老版本生成的 config.ini）一律迁移到上面的新端点。
        const string LegacyApi = "https://api.cognitive.microsofttranslator.com/translate";
        const int MaxChunk = 10000; // 该端点官方单次上限 50000 字符，此处留足余量

        public string Id { get { return "bing"; } }
        public string DisplayName { get { return "必应"; } }
        public bool SupportsContext(AppConfig cfg) { return false; }

        /// <summary>必应为单文本机器翻译，不支持上下文：忽略 context，等价于普通翻译。</summary>
        public Task<TranslateResult> TranslateAsync(AppConfig cfg, string text, IList<HistoryRecord> context, CancellationToken ct)
        {
            return TranslateAsync(cfg, text, ct);
        }

        static HttpClient GetClient(AppConfig cfg)
        {
            string proxy = string.IsNullOrEmpty(cfg.Proxy) ? "" : TranslateSupport.NormalizeProxy(cfg.Proxy);
            lock (clientLock)
            {
                if (client != null && clientProxy == proxy) return client;
                if (client != null) { try { client.Dispose(); } catch { } }
                client = TranslateSupport.CreateClient(proxy);
                clientProxy = proxy;
                return client;
            }
        }

        /// <summary>解析实际使用的接口地址：留空、或仍是旧端点时，回退到新端点。</summary>
        static string ResolveEndpoint(string configured)
        {
            string v = (configured ?? "").Trim();
            if (v.Length == 0) return DefaultApi;
            if (string.Equals(v.TrimEnd('/'), LegacyApi, StringComparison.OrdinalIgnoreCase)) return DefaultApi;
            return v;
        }

        public async Task<TranslateResult> TranslateAsync(AppConfig cfg, string text, CancellationToken ct)
        {
            try
            {
                string to = TranslateSupport.MapTargetLang(cfg.TargetLang, "zh-Hans", "zh-Hant");
                List<string> chunks = TranslateSupport.SplitChunks(text, MaxChunk);

                string baseUrl = ResolveEndpoint(cfg.BingApi);
                // 不传 from：由服务端自动识别源语言（显式传 "auto" 会报 400）
                string url = baseUrl + (baseUrl.IndexOf('?') >= 0 ? "&" : "?")
                    + "to=" + Uri.EscapeDataString(to) + "&isEnterpriseClient=false";

                StringBuilder sb = new StringBuilder();
                for (int i = 0; i < chunks.Count; i++)
                {
                    // 本接口的请求体是字符串数组，不是对象数组
                    string body = "[" + TranslateSupport.JsonString(chunks[i]) + "]";

                    HttpRequestMessage req = new HttpRequestMessage(HttpMethod.Post, url);
                    req.Content = new StringContent(body, Encoding.UTF8, "application/json");
                    req.Headers.TryAddWithoutValidation("Accept", "application/json");

                    string txt = await TranslateSupport.SendAsync(cfg, GetClient(cfg), req, ct).ConfigureAwait(false);
                    string parsed = ParseBing(txt);
                    if (parsed == null) return TranslateResult.Err("[必应翻译失败] 响应解析失败。\n" + TranslateSupport.Truncate(txt, 400));
                    sb.Append(parsed);
                }
                return TranslateResult.Ok(sb.ToString().Trim());
            }
            catch (HttpStatusException se)
            {
                return TranslateResult.Err("[必应翻译失败] HTTP " + se.StatusCode + StatusHint(se));
            }
            catch (Exception ex)
            {
                return TranslateResult.Err("[必应翻译失败] " + ex.Message);
            }
        }

        /// <summary>按状态码 / 响应体给出排查提示。</summary>
        static string StatusHint(HttpStatusException se)
        {
            string body = se.Body ?? "";
            if (body.IndexOf("maximum allowed translation size", StringComparison.OrdinalIgnoreCase) >= 0)
                return "（单次文本超出接口上限，请缩短选区或分批翻译）";
            if (body.IndexOf("Client Browser Version", StringComparison.OrdinalIgnoreCase) >= 0)
                return "（接口拒绝了本次请求，请检查代理设置）";
            switch (se.StatusCode)
            {
                case 403: return "（国内直连可能被拒，请配置 proxy，例如 http://127.0.0.1:7890）";
                case 429: return "（请求过于频繁，请稍后重试）";
                default: return "";
            }
        }

        /// <summary>
        /// 解析 [{"translations":[{"text":"..."}]}, ...]，按顺序拼接。
        /// </summary>
        static string ParseBing(string json)
        {
            try
            {
                JavaScriptSerializer ser = new JavaScriptSerializer();
                ser.MaxJsonLength = 16 * 1024 * 1024;
                System.Collections.IList arr = ser.DeserializeObject(json) as System.Collections.IList;
                if (arr == null || arr.Count == 0) return null;

                StringBuilder sb = new StringBuilder();
                for (int i = 0; i < arr.Count; i++)
                {
                    Dictionary<string, object> item = arr[i] as Dictionary<string, object>;
                    if (item == null) return null;
                    object trObj;
                    if (!item.TryGetValue("translations", out trObj)) return null;
                    System.Collections.IList list = trObj as System.Collections.IList;
                    if (list == null || list.Count == 0) return null;
                    Dictionary<string, object> first = list[0] as Dictionary<string, object>;
                    if (first == null) return null;
                    object textObj;
                    if (!first.TryGetValue("text", out textObj) || textObj == null) return null;
                    sb.Append(textObj.ToString());
                }
                return sb.ToString().Trim();
            }
            catch { return null; }
        }
    }
}
