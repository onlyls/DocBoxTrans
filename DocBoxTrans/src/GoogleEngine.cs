using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace DocBoxTrans
{
    /// <summary>谷歌翻译引擎（免费接口，走代理；多端点轮换 + 退避重试）。</summary>
    class GoogleEngine : ITranslateEngine
    {
        public string Id { get { return "google"; } }
        public string DisplayName { get { return "谷歌"; } }
        public bool SupportsContext(AppConfig cfg) { return false; }

        /// <summary>谷歌为单文本机器翻译，不支持上下文：忽略 context，等价于普通翻译。</summary>
        public Task<TranslateResult> TranslateAsync(AppConfig cfg, string text, IList<HistoryRecord> context, CancellationToken ct)
        {
            return TranslateAsync(cfg, text, ct);
        }

        // 谷歌引擎走代理：代理变更时重建 HttpClient。
        static readonly object clientLock = new object();
        static HttpClient client;
        static string clientProxy;

        // 谷歌免费接口对同一出口 IP（尤其代理共享 IP）会做限流，返回 429。
        // 不同域名/客户端走不同的限额池，因此这里在多个端点间轮换重试，并给刚被限流的端点设一段冷却。
        static readonly Dictionary<string, DateTime> googleCooldown = new Dictionary<string, DateTime>();
        static readonly object googleLock = new object();

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
            List<string> endpoints = GoogleEndpoints(cfg);
            List<string> order = OrderByEndpointHealth(endpoints);
            int attempts = Math.Min(4, Math.Max(2, order.Count + 1));
            string lastErr = null;

            for (int i = 0; i < attempts; i++)
            {
                string ep = order[i % order.Count];
                bool retry = false;
                int retryDelay = 0;
                try
                {
                    string json = await GoogleHttpGetAsync(cfg, ep, text, ct).ConfigureAwait(false);
                    string parsed = ParseGoogle(json);
                    if (parsed != null) return TranslateResult.Ok(parsed);
                    lastErr = "响应解析失败";
                    continue; // 换下一个端点再试
                }
                catch (HttpStatusException se)
                {
                    int status = se.StatusCode;
                    lastErr = "HTTP " + status;
                    if (status == 429) MarkCooldown(ep, 120);
                    if ((status == 429 || status == 500 || status == 503) && i < attempts - 1)
                    {
                        retry = true;
                        retryDelay = 1000 * (1 << i);
                    }
                }
                catch (OperationCanceledException)
                {
                    lastErr = "请求超时或被取消";
                }
                catch (HttpRequestException hre)
                {
                    // 网络层错误（连不上/被重置）→ 退避后换端点重试
                    lastErr = hre.Message;
                    if (i < attempts - 1)
                    {
                        retry = true;
                        retryDelay = 1000 * (1 << i);
                    }
                }
                catch (Exception ex)
                {
                    lastErr = ex.Message;
                }

                if (retry)
                {
                    await Task.Delay(retryDelay, ct).ConfigureAwait(false);
                    continue;
                }
                break;
            }

            string hint;
            if (string.IsNullOrEmpty(cfg.Proxy))
                hint = "\n谷歌免费接口通常需要代理，请在 config.ini 里配置 proxy（例如 http://127.0.0.1:7890）。";
            else
                hint = "\n谷歌免费接口经常被限流（429）。可稍后重试，或在弹窗底部切换到「大模型」/「知网」（更稳定）。";
            return TranslateResult.Err("[谷歌翻译失败] " + (lastErr ?? "未知错误") + hint);
        }

        static List<string> GoogleEndpoints(AppConfig cfg)
        {
            List<string> list = new List<string>();
            if (!string.IsNullOrEmpty(cfg.GoogleApi)) list.Add(cfg.GoogleApi.Trim());
            if (!string.IsNullOrEmpty(cfg.GoogleApiList))
            {
                foreach (string p in cfg.GoogleApiList.Split(','))
                {
                    string t = p.Trim();
                    if (t.Length > 0 && !list.Contains(t)) list.Add(t);
                }
            }
            if (list.Count == 0) list.Add("https://translate.googleapis.com/translate_a/single");
            return list;
        }

        static List<string> OrderByEndpointHealth(List<string> endpoints)
        {
            DateTime now = DateTime.Now;
            List<string> ready = new List<string>();
            List<string> cooling = new List<string>();
            foreach (string e in endpoints)
            {
                DateTime until;
                bool blocked = false;
                lock (googleLock) { if (googleCooldown.TryGetValue(e, out until) && until > now) blocked = true; }
                (blocked ? cooling : ready).Add(e);
            }
            ready.AddRange(cooling);
            return ready;
        }

        static void MarkCooldown(string endpoint, int seconds)
        {
            lock (googleLock) googleCooldown[endpoint] = DateTime.Now.AddSeconds(seconds);
        }

        static async Task<string> GoogleHttpGetAsync(AppConfig cfg, string baseUrl, string text, CancellationToken ct)
        {
            string url = BuildGoogleUrl(baseUrl, cfg, text);
            HttpRequestMessage req = new HttpRequestMessage(HttpMethod.Get, url);
            req.Headers.TryAddWithoutValidation("Accept", "application/json");
            return await TranslateSupport.SendAsync(cfg, GetClient(cfg), req, ct).ConfigureAwait(false);
        }

        /// <summary>兼容两种免费端点：/translate_a/single（client=gtx）与 /translate_a/t（client=dict-chrome-ex）。</summary>
        static string BuildGoogleUrl(string baseUrl, AppConfig cfg, string text)
        {
            bool narrow = baseUrl.IndexOf("/translate_a/t", StringComparison.OrdinalIgnoreCase) >= 0;
            string sep = baseUrl.IndexOf('?') >= 0 ? "&" : "?";
            string client = narrow ? "client=dict-chrome-ex" : "client=gtx";
            string mid = narrow ? "" : "&dt=t";
            return baseUrl + sep + client
                + "&sl=auto&tl=" + Uri.EscapeDataString(cfg.TargetLang)
                + mid + "&q=" + Uri.EscapeDataString(text);
        }

        /// <summary>自适应解析两种免费接口的返回：[["译文","原文",...],...] 或 [["译文","en"]]。</summary>
        static string ParseGoogle(string json)
        {
            try
            {
                JavaScriptSerializer ser = new JavaScriptSerializer();
                ser.MaxJsonLength = 16 * 1024 * 1024;
                object root = ser.DeserializeObject(json);
                System.Collections.IList outer = root as System.Collections.IList;
                if (outer == null || outer.Count == 0) return null;
                System.Collections.IList first = outer[0] as System.Collections.IList;
                if (first == null || first.Count == 0) return null;

                if (first[0] is System.Collections.IList)
                {
                    // single 格式：[[["译文","原文",...],...],...]
                    StringBuilder sb = new StringBuilder();
                    foreach (object segObj in first)
                    {
                        System.Collections.IList seg = segObj as System.Collections.IList;
                        if (seg != null && seg.Count > 0 && seg[0] != null) sb.Append(seg[0].ToString());
                    }
                    return sb.ToString().Trim();
                }
                // t 格式：[["译文","en"]]
                if (first[0] is string) return ((string)first[0]).Trim();
                return null;
            }
            catch { return null; }
        }
    }
}
