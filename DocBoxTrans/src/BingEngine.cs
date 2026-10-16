using System;
using System.Collections.Generic;
using System.Globalization;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace DocBoxTrans
{
    /// <summary>
    /// 必应翻译引擎（免费）：直接调用微软在线翻译接口 api.cognitive.microsofttranslator.com/translate，
    /// 用 X-MT-Signature 头（HMAC-SHA256）匿名鉴权，无需注册 key。国内通常需要代理。
    /// 注：原先「先用 edge.microsoft.com/translate/auth 取临时令牌」的链路已被官方下线（返回 404），故不再使用。
    /// </summary>
    class BingEngine : ITranslateEngine
    {
        // 免费接口对国内网络通常不通，需要代理；代理变更时重建 HttpClient。
        static readonly object clientLock = new object();
        static HttpClient client;
        static string clientProxy;

        const string DefaultApi = "https://api.cognitive.microsofttranslator.com/translate";
        const int MaxChunk = 1000;      // 微软接口单元素 1000 字符上限
        const string ApiVersion = "3.0";

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

        public async Task<TranslateResult> TranslateAsync(AppConfig cfg, string text, CancellationToken ct)
        {
            try
            {
                string to = TranslateSupport.MapTargetLang(cfg.TargetLang, "zh-Hans", "zh-Hant");
                List<string> chunks = TranslateSupport.SplitChunks(text, MaxChunk);

                // 一次请求携带多段（接口按数组下标返回，顺序一致）
                StringBuilder body = new StringBuilder();
                body.Append('[');
                for (int i = 0; i < chunks.Count; i++)
                {
                    if (i > 0) body.Append(',');
                    body.Append("{\"Text\":").Append(TranslateSupport.JsonString(chunks[i])).Append('}');
                }
                body.Append(']');

                string baseUrl = string.IsNullOrEmpty(cfg.BingApi) ? DefaultApi : cfg.BingApi;
                string url = baseUrl + (baseUrl.IndexOf('?') >= 0 ? "&" : "?")
                    + "api-version=" + ApiVersion + "&to=" + Uri.EscapeDataString(to);

                HttpRequestMessage req = new HttpRequestMessage(HttpMethod.Post, url);
                req.Content = new StringContent(body.ToString(), Encoding.UTF8, "application/json");
                // 签名对象是「不含协议头」的完整请求地址，必须与实际请求的 URL 完全一致
                string signTarget = url.Substring(url.IndexOf("://", StringComparison.Ordinal) + 3);
                req.Headers.TryAddWithoutValidation("X-MT-Signature", GetSignature(signTarget));
                req.Headers.TryAddWithoutValidation("Accept", "application/json");

                string txt = await TranslateSupport.SendAsync(cfg, GetClient(cfg), req, ct).ConfigureAwait(false);
                string parsed = ParseBing(txt);
                if (parsed == null) return TranslateResult.Err("[必应翻译失败] 响应解析失败。\n" + TranslateSupport.Truncate(txt, 400));
                return TranslateResult.Ok(parsed);
            }
            catch (HttpStatusException se)
            {
                return TranslateResult.Err("[必应翻译失败] HTTP " + se.StatusCode
                     + (se.StatusCode == 403 ? "（国内直连可能被拒，请在 config.ini 里配置 proxy，例如 http://127.0.0.1:7890）" : ""));
            }
            catch (Exception ex)
            {
                return TranslateResult.Err("[必应翻译失败] " + ex.Message);
            }
        }

        /// <summary>
        /// 解析 [{"translations":[{"text":"...","to":"..."}]}, ...]，按顺序拼接。
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

        /// <summary>
        /// 生成 X-MT-Signature。算法来自微软 Edge 客户端的匿名鉴权方案：
        /// HMAC-SHA256(key, lower("MSTranslatorAndroidApp" + urlencode(不含协议头的 URL) + 时间 + guid))，
        /// 头值形如 "MSTranslatorAndroidApp::{签名}::{时间}::{guid}"。
        /// 参考 https://github.com/d4n3436/GTranslate/blob/master/src/GTranslate/Translators/MicrosoftTranslator.cs
        /// </summary>
        /// <param name="url">不含协议头的请求地址（含查询串）。</param>
        static string GetSignature(string url)
        {
            string guid = Guid.NewGuid().ToString("N");
            string escapedUrl = Uri.EscapeDataString(url);
            string dateTime = DateTime.UtcNow.ToString("ddd, dd MMM yyyy HH:mm:ss", CultureInfo.InvariantCulture) + "GMT";

            byte[] bytes = Encoding.UTF8.GetBytes(("MSTranslatorAndroidApp" + escapedUrl + dateTime + guid).ToLowerInvariant());
            using (HMACSHA256 hmac = new HMACSHA256(PrivateKey))
            {
                byte[] hash = hmac.ComputeHash(bytes);
                return "MSTranslatorAndroidApp::" + Convert.ToBase64String(hash) + "::" + dateTime + "::" + guid;
            }
        }

        static readonly byte[] PrivateKey = new byte[]
        {
            0xa2, 0x29, 0x3a, 0x3d, 0xd0, 0xdd, 0x32, 0x73,
            0x97, 0x7a, 0x64, 0xdb, 0xc2, 0xf3, 0x27, 0xf5,
            0xd7, 0xbf, 0x87, 0xd9, 0x45, 0x9d, 0xf0, 0x5a,
            0x09, 0x66, 0xc6, 0x30, 0xc6, 0x6a, 0xaa, 0x84,
            0x9a, 0x41, 0xaa, 0x94, 0x3a, 0xa8, 0xd5, 0x1a,
            0x6e, 0x4d, 0xaa, 0xc9, 0xa3, 0x70, 0x12, 0x35,
            0xc7, 0xeb, 0x12, 0xf6, 0xe8, 0x23, 0x07, 0x9e,
            0x47, 0x10, 0x95, 0x91, 0x88, 0x55, 0xd8, 0x17
        };
    }
}
