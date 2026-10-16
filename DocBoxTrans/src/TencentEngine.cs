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
    /// 腾讯交互翻译引擎（transmart.qq.com 免费接口，匿名即可用，国内直连）。
    /// 必须走「整块」形态：header.fn=auto_translation_block + header.client_key + source.text_block，
    /// 且 Referer 指向 yi.qq.com；否则会返回 ret_code=Auth-Failed（该方法要求 qtv/qtk 令牌鉴权）。
    /// </summary>
    class TencentEngine : ITranslateEngine
    {
        // 国内可直连，不使用代理，复用同一个 HttpClient。
        static readonly HttpClient Client = TranslateSupport.CreateClient("");

        const string DefaultApi = "https://transmart.qq.com/api/imt";
        // 浏览器端生成的调用方标识（非密钥），缺失即鉴权失败
        const string ClientKey = "browser-chrome-110.0.0-Mac OS-df4bd4c5-a65d-44b2-a40f-42f34f3535f2-1677486696487";
        const string Referer = "https://yi.qq.com/zh-CN/index";
        const string UserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36";
        // 单次文本上限未公开，按 1000 字符分批，尽量规避超长报错
        const int MaxChunk = 1000;

        public string Id { get { return "tencent"; } }
        public string DisplayName { get { return "腾讯"; } }
        public bool SupportsContext(AppConfig cfg) { return false; }

        /// <summary>腾讯交互为单文本机器翻译，不支持上下文：忽略 context，等价于普通翻译。</summary>
        public Task<TranslateResult> TranslateAsync(AppConfig cfg, string text, IList<HistoryRecord> context, CancellationToken ct)
        {
            return TranslateAsync(cfg, text, ct);
        }

        public async Task<TranslateResult> TranslateAsync(AppConfig cfg, string text, CancellationToken ct)
        {
            try
            {
                string to = TranslateSupport.MapTargetLang(cfg.TargetLang, "zh", "zh-TW");
                List<string> chunks = TranslateSupport.SplitChunks(text, MaxChunk);

                StringBuilder sb = new StringBuilder();
                for (int i = 0; i < chunks.Count; i++)
                {
                    TranslateResult part = await TranslateChunkAsync(cfg, chunks[i], to, ct).ConfigureAwait(false);
                    if (!part.Success) return part;
                    sb.Append(part.Text);
                }
                return TranslateResult.Ok(sb.ToString().Trim());
            }
            catch (HttpStatusException se)
            {
                return TranslateResult.Err("[腾讯翻译失败] HTTP " + se.StatusCode);
            }
            catch (Exception ex)
            {
                return TranslateResult.Err("[腾讯翻译失败] " + ex.Message);
            }
        }

        static async Task<TranslateResult> TranslateChunkAsync(AppConfig cfg, string chunk, string to, CancellationToken ct)
        {
            StringBuilder body = new StringBuilder();
            body.Append("{\"header\":{\"fn\":\"auto_translation_block\",\"client_key\":\"").Append(ClientKey).Append("\"}");
            body.Append(",\"type\":\"plain\"");
            body.Append(",\"model_category\":\"normal\"");
            body.Append(",\"source\":{\"lang\":\"auto\",\"text_block\":").Append(TranslateSupport.JsonString(chunk)).Append('}');
            body.Append(",\"target\":{\"lang\":").Append(TranslateSupport.JsonString(to)).Append("}}");

            string url = string.IsNullOrEmpty(cfg.TencentApi) ? DefaultApi : cfg.TencentApi;
            HttpRequestMessage req = new HttpRequestMessage(HttpMethod.Post, url);
            req.Content = new StringContent(body.ToString(), Encoding.UTF8, "application/json");
            req.Headers.TryAddWithoutValidation("Accept", "application/json");
            req.Headers.TryAddWithoutValidation("Referer", Referer);
            req.Headers.TryAddWithoutValidation("User-Agent", UserAgent);

            string txt = await TranslateSupport.SendAsync(cfg, Client, req, ct).ConfigureAwait(false);
            return ParseTransmart(txt);
        }

        /// <summary>
        /// 解析 {"auto_translation":"译文"}。没有译文时把上游真实错误透传出来
        /// （header.ret_code + message，如 Auth-Failed）。
        /// </summary>
        static TranslateResult ParseTransmart(string json)
        {
            try
            {
                JavaScriptSerializer ser = new JavaScriptSerializer();
                ser.MaxJsonLength = 16 * 1024 * 1024;
                Dictionary<string, object> root = ser.Deserialize<Dictionary<string, object>>(json);
                if (root == null) return TranslateResult.Err("[腾讯翻译失败] 响应解析失败。\n" + TranslateSupport.Truncate(json, 400));

                object trObj;
                if (root.TryGetValue("auto_translation", out trObj) && trObj != null)
                {
                    string tr = trObj.ToString().Trim();
                    if (tr.Length > 0) return TranslateResult.Ok(tr);
                }

                string code = null;
                object hObj;
                if (root.TryGetValue("header", out hObj))
                {
                    Dictionary<string, object> h = hObj as Dictionary<string, object>;
                    object cObj;
                    if (h != null && h.TryGetValue("ret_code", out cObj) && cObj != null) code = cObj.ToString();
                }
                string message = null;
                object mObj;
                if (root.TryGetValue("message", out mObj) && mObj != null) message = mObj.ToString();
                if (code != null && code != "succ")
                    return TranslateResult.Err("[腾讯翻译失败] " + code + (string.IsNullOrEmpty(message) ? "" : "：" + message));
                return TranslateResult.Err("[腾讯翻译失败] 响应解析失败。\n" + TranslateSupport.Truncate(json, 400));
            }
            catch { return TranslateResult.Err("[腾讯翻译失败] 响应解析失败。\n" + TranslateSupport.Truncate(json, 400)); }
        }
    }
}
