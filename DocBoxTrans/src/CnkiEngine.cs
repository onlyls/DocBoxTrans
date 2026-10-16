using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace DocBoxTrans
{
    /// <summary>知网引擎（dict.cnki.net 免费学术翻译）。</summary>
    class CnkiEngine : ITranslateEngine
    {
        // 知网需要共享 Cookie（getToken 下发的 SESSION）；HttpClientHandler 默认自带 CookieContainer，
        // 因此同一个 Client 上的 getToken 与 translate 请求会自动带上同一会话。
        static readonly HttpClient Client = TranslateSupport.CreateClient("");

        public string Id { get { return "cnki"; } }
        public string DisplayName { get { return "知网"; } }
        public bool SupportsContext(AppConfig cfg) { return false; }

        /// <summary>知网为单文本机器翻译，不支持上下文：忽略 context，等价于普通翻译。</summary>
        public Task<TranslateResult> TranslateAsync(AppConfig cfg, string text, IList<HistoryRecord> context, CancellationToken ct)
        {
            return TranslateAsync(cfg, text, ct);
        }

        public async Task<TranslateResult> TranslateAsync(AppConfig cfg, string text, CancellationToken ct)
        {
            try
            {
                string token = await CnkiGetTokenAsync(cfg, ct).ConfigureAwait(false);
                if (string.IsNullOrEmpty(token))
                    return TranslateResult.Err("[知网翻译失败] 未能获取 Token，接口可能已变更或网络不可达。");

                int max = Math.Max(60, cfg.CnkiMaxChars);
                List<string> chunks = TranslateSupport.SplitChunks(text, max);
                StringBuilder sb = new StringBuilder();
                for (int i = 0; i < chunks.Count; i++)
                {
                    TranslateResult part = await CnkiTranslateChunkAsync(cfg, token, chunks[i], ct).ConfigureAwait(false);
                    if (!part.Success) return part;
                    if (sb.Length > 0) sb.Append('\n');
                    sb.Append(part.Text);
                }
                return TranslateResult.Ok(sb.ToString().Trim());
            }
            catch (HttpStatusException se)
            {
                return TranslateResult.Err("[知网翻译失败] HTTP " + se.StatusCode);
            }
            catch (Exception ex)
            {
                return TranslateResult.Err("[知网翻译失败] " + ex.Message);
            }
        }

        static async Task<string> CnkiGetTokenAsync(AppConfig cfg, CancellationToken ct)
        {
            HttpRequestMessage req = new HttpRequestMessage(HttpMethod.Get, cfg.CnkiTokenUrl);
            req.Headers.TryAddWithoutValidation("Accept", "application/json");
            req.Headers.TryAddWithoutValidation("Referer", "https://dict.cnki.net/index");
            string txt = await TranslateSupport.SendAsync(cfg, Client, req, ct).ConfigureAwait(false);
            return ExtractDataString(txt);
        }

        static async Task<TranslateResult> CnkiTranslateChunkAsync(AppConfig cfg, string token, string chunk, CancellationToken ct)
        {
            string words = CnkiEncrypt(chunk);
            string json = "{\"translateType\":null,\"words\":" + TranslateSupport.JsonString(words) + "}";
            HttpRequestMessage req = new HttpRequestMessage(HttpMethod.Post, cfg.CnkiApi);
            req.Content = new StringContent(json, Encoding.UTF8, "application/json");
            req.Headers.TryAddWithoutValidation("Accept", "application/json, text/plain, */*");
            req.Headers.TryAddWithoutValidation("Referer", "https://dict.cnki.net/index");
            req.Headers.TryAddWithoutValidation("Origin", "https://dict.cnki.net");
            req.Headers.TryAddWithoutValidation("Token", token);
            string txt = await TranslateSupport.SendAsync(cfg, Client, req, ct).ConfigureAwait(false);
            string parsed = ExtractCnkiResult(txt);
            if (parsed == null) return TranslateResult.Err("[知网翻译失败] 响应解析失败。");
            return TranslateResult.Ok(parsed);
        }

        /// <summary>AES-ECB / PKCS7，key=4e87183cfd3a45fe，Base64 后 / → _ 、 + → -。</summary>
        static string CnkiEncrypt(string plain)
        {
            byte[] key = Encoding.UTF8.GetBytes("4e87183cfd3a45fe");
            using (Aes aes = Aes.Create())
            {
                aes.Key = key;
                aes.Mode = CipherMode.ECB;
                aes.Padding = PaddingMode.PKCS7;
                ICryptoTransform enc = aes.CreateEncryptor();
                byte[] input = Encoding.UTF8.GetBytes(plain);
                byte[] output = enc.TransformFinalBlock(input, 0, input.Length);
                return Convert.ToBase64String(output).Replace('/', '_').Replace('+', '-');
            }
        }

        static string ExtractDataString(string json)
        {
            try
            {
                JavaScriptSerializer ser = new JavaScriptSerializer();
                ser.MaxJsonLength = 16 * 1024 * 1024;
                Dictionary<string, object> root = ser.Deserialize<Dictionary<string, object>>(json);
                object d;
                if (root != null && root.TryGetValue("data", out d) && d != null)
                {
                    string s = d as string;
                    return s != null ? s : d.ToString();
                }
                return null;
            }
            catch { return null; }
        }

        static string ExtractCnkiResult(string json)
        {
            try
            {
                JavaScriptSerializer ser = new JavaScriptSerializer();
                ser.MaxJsonLength = 16 * 1024 * 1024;
                Dictionary<string, object> root = ser.Deserialize<Dictionary<string, object>>(json);
                object dataObj;
                if (root == null || !root.TryGetValue("data", out dataObj) || dataObj == null) return null;
                Dictionary<string, object> data = dataObj as Dictionary<string, object>;
                if (data == null) return dataObj.ToString();
                object m;
                if (!data.TryGetValue("mResult", out m) || m == null) return null;
                string s = m as string;
                if (s != null) return s.Trim();
                Dictionary<string, object> md = m as Dictionary<string, object>;
                if (md != null)
                {
                    string[] keys = new string[] { "translateResult", "result", "text", "dst" };
                    for (int i = 0; i < keys.Length; i++)
                    {
                        object v;
                        if (md.TryGetValue(keys[i], out v) && v != null) return v.ToString().Trim();
                    }
                }
                return m.ToString().Trim();
            }
            catch { return null; }
        }
    }
}
