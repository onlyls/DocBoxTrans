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
    /// 有道翻译引擎（有道智云开放接口），国内直连，需要在 config.ini 填写 youdao_appkey 与 youdao_secret。
    /// 请求走哪条接口由 youdao_mode 决定：
    ///   auto（默认）：跟随「上下文增强翻译」开关——已勾选且已填 key 时用大模型翻译（带上下文），否则用文本翻译；
    ///   text：文本翻译 https://openapi.youdao.com/api —— 纯机器翻译，不支持上下文；
    ///   llm ：大模型翻译 https://openapi.youdao.com/proxy/http/llm-trans —— 支持 prompt，
    ///         可把此前的成功翻译注入 prompt 作为参考，实现「连续上下文增强翻译」。
    ///         注意：该服务需在有道控制台为当前应用单独开通（否则返回错误码 110）。
    /// </summary>
    class YoudaoEngine : ITranslateEngine
    {
        static readonly HttpClient Client = TranslateSupport.CreateClient("");
        static readonly DateTime Epoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);

        const string DefaultApi = "https://openapi.youdao.com/api";
        const string DefaultLlmApi = "https://openapi.youdao.com/proxy/http/llm-trans";
        // 文本翻译单次 q 不宜过长，按 2000 字符分批
        const int MaxChunk = 2000;
        // 大模型翻译单次 i 上限 5000 字符，预留余量按 4000 分批
        const int MaxLlmChunk = 4000;
        // 大模型翻译的 prompt 上限 1200 字符（官方限制 1200 字符 / 400 单词）
        const int PromptMaxChars = 1200;

        public string Id { get { return "youdao"; } }
        public string DisplayName { get { return "有道"; } }
        // 是否具备上下文能力 = 本次请求是否会走大模型翻译：
        // auto 模式下「勾选了上下文增强且已填 key」才为 true；text 模式恒 false。
        // 注意这只是必要条件之一：还要用户在托盘菜单勾选「上下文增强翻译」才会真正携带上下文。
        public bool SupportsContext(AppConfig cfg) { return UseLlm(cfg); }

        public Task<TranslateResult> TranslateAsync(AppConfig cfg, string text, CancellationToken ct)
        {
            return TranslateAsync(cfg, text, null, ct);
        }

        public async Task<TranslateResult> TranslateAsync(AppConfig cfg, string text, IList<HistoryRecord> context, CancellationToken ct)
        {
            string appKey = (cfg.YoudaoAppKey ?? "").Trim();
            string secret = (cfg.YoudaoSecret ?? "").Trim();
            if (appKey.Length == 0 || secret.Length == 0)
                return TranslateResult.Err("[配置错误] 有道翻译需要填写 appkey 与 secret。\n" +
                       "请编辑 config.ini 里的 youdao_appkey / youdao_secret，保存后会自动生效。");

            try
            {
                string to = TranslateSupport.MapTargetLang(cfg.TargetLang, "zh-CHS", "zh-CHT");
                if (UseLlm(cfg))
                {
                    string prompt = BuildPrompt(context);
                    int max = Math.Max(200, MaxLlmChunk);
                    List<string> chunks = TranslateSupport.SplitChunks(text, max);
                    StringBuilder sb = new StringBuilder();
                    for (int i = 0; i < chunks.Count; i++)
                    {
                        TranslateResult part = await LlmTranslateChunkAsync(cfg, appKey, secret, chunks[i], to, prompt, ct).ConfigureAwait(false);
                        if (!part.Success) return part;
                        sb.Append(part.Text);
                    }
                    return TranslateResult.Ok(sb.ToString().Trim());
                }

                List<string> textChunks = TranslateSupport.SplitChunks(text, MaxChunk);
                StringBuilder outSb = new StringBuilder();
                for (int i = 0; i < textChunks.Count; i++)
                {
                    TranslateResult part = await TranslateChunkAsync(cfg, appKey, secret, textChunks[i], to, ct).ConfigureAwait(false);
                    if (!part.Success) return part;
                    outSb.Append(part.Text);
                }
                return TranslateResult.Ok(outSb.ToString().Trim());
            }
            catch (HttpStatusException se)
            {
                return TranslateResult.Err("[有道翻译失败] HTTP " + se.StatusCode);
            }
            catch (Exception ex)
            {
                return TranslateResult.Err("[有道翻译失败] " + ex.Message);
            }
        }

        /// <summary>
        /// 本次请求是否走大模型翻译。youdao_mode=auto（默认）时跟随「上下文增强翻译」开关：
        /// 已勾选且已填 key 才走大模型翻译（可带上下文），否则走文本翻译；
        /// text / llm 为强制覆盖。公开供 Translator 判定上下文能力。
        /// </summary>
        public static bool UseLlm(AppConfig cfg)
        {
            if (cfg == null) return false;
            string m = (cfg.YoudaoMode ?? "").Trim().ToLowerInvariant();
            if (m == "text") return false;
            if (m == "llm" || m == "1" || m == "true" || m == "yes" || m == "on") return true;
            // auto（含未设置）：勾选了上下文增强且已配置 key 时才启用大模型翻译
            return cfg.ContextEnable && HasKey(cfg);
        }

        /// <summary>是否已填写 appkey / secret（未填写时无论哪种模式都会提示配置错误）。</summary>
        static bool HasKey(AppConfig cfg)
        {
            return cfg != null
                && (cfg.YoudaoAppKey ?? "").Trim().Length > 0
                && (cfg.YoudaoSecret ?? "").Trim().Length > 0;
        }

        // ---------------- 文本翻译（无上下文）----------------

        static async Task<TranslateResult> TranslateChunkAsync(
            AppConfig cfg, string appKey, string secret, string chunk, string to, CancellationToken ct)
        {
            string salt = Guid.NewGuid().ToString("N");
            string curtime = ((long)(DateTime.UtcNow - Epoch).TotalSeconds).ToString(CultureInfo.InvariantCulture);
            string sign = Sha256Hex(appKey + TruncateInput(chunk) + salt + curtime + secret);

            List<KeyValuePair<string, string>> form = new List<KeyValuePair<string, string>>();
            form.Add(new KeyValuePair<string, string>("q", chunk));
            form.Add(new KeyValuePair<string, string>("from", "auto"));
            form.Add(new KeyValuePair<string, string>("to", to));
            form.Add(new KeyValuePair<string, string>("appKey", appKey));
            form.Add(new KeyValuePair<string, string>("salt", salt));
            form.Add(new KeyValuePair<string, string>("sign", sign));
            form.Add(new KeyValuePair<string, string>("signType", "v3"));
            form.Add(new KeyValuePair<string, string>("curtime", curtime));

            string url = string.IsNullOrEmpty(cfg.YoudaoApi) ? DefaultApi : cfg.YoudaoApi;
            HttpRequestMessage req = new HttpRequestMessage(HttpMethod.Post, url);
            req.Content = new FormUrlEncodedContent(form);
            req.Headers.TryAddWithoutValidation("Accept", "application/json");

            string txt = await TranslateSupport.SendAsync(cfg, Client, req, ct).ConfigureAwait(false);
            return ParseYoudao(txt);
        }

        // ---------------- 大模型翻译（prompt 携带上下文）----------------

        static async Task<TranslateResult> LlmTranslateChunkAsync(
            AppConfig cfg, string appKey, string secret, string chunk, string to, string prompt, CancellationToken ct)
        {
            string salt = Guid.NewGuid().ToString("N");
            string curtime = ((long)(DateTime.UtcNow - Epoch).TotalSeconds).ToString(CultureInfo.InvariantCulture);
            string sign = Sha256Hex(appKey + TruncateInput(chunk) + salt + curtime + secret);

            List<KeyValuePair<string, string>> form = new List<KeyValuePair<string, string>>();
            form.Add(new KeyValuePair<string, string>("i", chunk));
            form.Add(new KeyValuePair<string, string>("from", "auto"));
            form.Add(new KeyValuePair<string, string>("to", to));
            form.Add(new KeyValuePair<string, string>("appKey", appKey));
            form.Add(new KeyValuePair<string, string>("salt", salt));
            form.Add(new KeyValuePair<string, string>("sign", sign));
            form.Add(new KeyValuePair<string, string>("signType", "v3"));
            form.Add(new KeyValuePair<string, string>("curtime", curtime));
            form.Add(new KeyValuePair<string, string>("handleOption", "0"));
            // streamType=full：每条消息都带全量译文，累积到最后一个即为完整译文
            form.Add(new KeyValuePair<string, string>("streamType", "full"));
            if (!string.IsNullOrEmpty(prompt)) form.Add(new KeyValuePair<string, string>("prompt", prompt));

            string url = string.IsNullOrEmpty(cfg.YoudaoLlmApi) ? DefaultLlmApi : cfg.YoudaoLlmApi;
            HttpRequestMessage req = new HttpRequestMessage(HttpMethod.Post, url);
            req.Content = new FormUrlEncodedContent(form);
            // 该接口以 SSE(text/event-stream) 返回；若声明 Accept: application/json 会因内容协商失败
            // 而返回「错误码 1：发生未知错误」，掩盖真实的鉴权/参数错误。
            req.Headers.TryAddWithoutValidation("Accept", "text/event-stream");

            string txt = await TranslateSupport.SendAsync(cfg, Client, req, ct).ConfigureAwait(false);
            return ParseYoudaoLlm(txt);
        }

        /// <summary>
        /// 把此前的成功翻译拼成参考提示词：仅用于统一术语与表达，不作为待翻译内容。
        /// prompt 有 1200 字符硬上限，而参考价值随距离快速衰减，因此从最新一条往旧装填：
        /// 先尽量完整收下最近的若干条；若连最新一条都装不下，则只保留它并按原文/译文等比截断。
        /// 固定提示语、每条的「原文：」「译文：」标签与换行都计入预算，保证总长不超过 1200。
        /// </summary>
        static string BuildPrompt(IList<HistoryRecord> context)
        {
            if (context == null || context.Count == 0) return null;

            const string head = "以下“原文→译文”是此前已完成的翻译，仅用于统一术语与表达，请勿翻译它们，只翻译最后给出的待翻译文本。";
            const int LabelCost = 8;   // 每条 "\n原文：" + "\n译文：" 的固定开销
            int budget = PromptMaxChars - head.Length;
            if (budget <= LabelCost) return null;

            List<string> parts = new List<string>();
            int used = 0;
            for (int i = context.Count - 1; i >= 0; i--)   // 由新到旧（context 为「旧 → 新」）
            {
                HistoryRecord r = context[i];
                if (r == null) continue;
                string src = (r.SourceText ?? "").Trim();
                string dst = (r.TranslatedText ?? "").Trim();
                if (src.Length == 0 && dst.Length == 0) continue;

                int remain = budget - used;
                int need = src.Length + dst.Length + LabelCost;
                if (need <= remain)
                {
                    parts.Add("\n原文：" + src + "\n译文：" + dst);
                    used += need;
                    continue;
                }

                // 装不下：更旧的参考价值更低，不再继续；若尚未收下任何条目，则截断保住最新的这一条。
                int room = remain - LabelCost;
                if (parts.Count == 0 && room > 40)
                {
                    int half = room / 2;   // 原文与译文各分一半空间
                    string s = src.Length > half ? src.Substring(0, half - 1) + "…" : src;
                    string d = dst.Length > room - s.Length
                        ? dst.Substring(0, Math.Max(0, room - s.Length - 1)) + "…"
                        : dst;
                    parts.Add("\n原文：" + s + "\n译文：" + d);
                }
                break;
            }
            if (parts.Count == 0) return null;

            parts.Reverse();   // 还原为「旧 → 新」的阅读顺序
            StringBuilder sb = new StringBuilder(head);
            for (int i = 0; i < parts.Count; i++) sb.Append(parts[i]);
            return sb.ToString();
        }

        /// <summary>有道的签名输入：长度 ≤20 用原文，否则取「前 10 + 长度 + 后 10」。</summary>
        static string TruncateInput(string q)
        {
            if (q == null) return "";
            int len = q.Length;
            return len <= 20
                ? q
                : q.Substring(0, 10) + len.ToString(CultureInfo.InvariantCulture) + q.Substring(len - 10, 10);
        }

        static string Sha256Hex(string s)
        {
            using (SHA256 sha = SHA256.Create())
            {
                byte[] hash = sha.ComputeHash(Encoding.UTF8.GetBytes(s));
                StringBuilder sb = new StringBuilder(hash.Length * 2);
                for (int i = 0; i < hash.Length; i++) sb.Append(hash[i].ToString("x2"));
                return sb.ToString();
            }
        }

        /// <summary>解析 {"errorCode":"0","translation":["译文"]}；errorCode 非 0 时给出可读提示。</summary>
        static TranslateResult ParseYoudao(string json)
        {
            try
            {
                JavaScriptSerializer ser = new JavaScriptSerializer();
                ser.MaxJsonLength = 16 * 1024 * 1024;
                Dictionary<string, object> root = ser.Deserialize<Dictionary<string, object>>(json);
                if (root == null) return TranslateResult.Err("[有道翻译失败] 响应解析失败。");

                object codeObj;
                string code = null;
                if (root.TryGetValue("errorCode", out codeObj) && codeObj != null) code = codeObj.ToString();
                if (code != null && code != "0")
                    return TranslateResult.Err("[有道翻译失败] 错误码 " + code + YoudaoHint(code));

                object trObj;
                if (root.TryGetValue("translation", out trObj))
                {
                    System.Collections.IList list = trObj as System.Collections.IList;
                    if (list != null && list.Count > 0 && list[0] != null) return TranslateResult.Ok(list[0].ToString().Trim());
                }
                return TranslateResult.Err("[有道翻译失败] 响应中没有译文。");
            }
            catch { return TranslateResult.Err("[有道翻译失败] 响应解析失败。"); }
        }

        /// <summary>
        /// 解析大模型翻译的 SSE 流式响应：逐行 JSON，successful 为真时取 data.transFull（full 模式为全量译文）。
        /// 返回最后一个非空 transFull，出错时返回带错误码的提示。
        /// </summary>
        static TranslateResult ParseYoudaoLlm(string body)
        {
            if (string.IsNullOrEmpty(body)) return TranslateResult.Err("[有道翻译失败] 响应为空。");
            JavaScriptSerializer ser = new JavaScriptSerializer();
            ser.MaxJsonLength = 16 * 1024 * 1024;

            string last = null;
            string err = null;
            string[] lines = body.Split('\n');
            for (int i = 0; i < lines.Length; i++)
            {
                string line = lines[i].Trim();
                if (line.Length == 0) continue;
                if (line.StartsWith("data:", StringComparison.OrdinalIgnoreCase)) line = line.Substring(5).Trim();
                if (line.Length == 0 || line[0] != '{') continue;

                try
                {
                    Dictionary<string, object> root = ser.Deserialize<Dictionary<string, object>>(line);
                    if (root == null) continue;

                    object codeObj;
                    if (root.TryGetValue("code", out codeObj) && codeObj != null)
                    {
                        string code = codeObj.ToString();
                        string message = "";
                        object msgObj;
                        if (root.TryGetValue("message", out msgObj) && msgObj != null) message = msgObj.ToString();
                        if (code != "0")
                        {
                            err = "错误码 " + code + YoudaoHint(code) + (message.Length > 0 ? "：" + message : "");
                            continue;
                        }
                    }

                    object dataObj;
                    if (!root.TryGetValue("data", out dataObj) || dataObj == null) continue;
                    Dictionary<string, object> data = dataObj as Dictionary<string, object>;
                    if (data == null) continue;
                    object fullObj;
                    if (data.TryGetValue("transFull", out fullObj) && fullObj != null)
                    {
                        string s = fullObj.ToString();
                        if (s.Length > 0) last = s;
                    }
                }
                catch { }
            }

            if (last != null) return TranslateResult.Ok(last.Trim());
            if (err != null) return TranslateResult.Err("[有道翻译失败] " + err);
            return TranslateResult.Err("[有道翻译失败] 响应中没有译文。");
        }

        static string YoudaoHint(string code)
        {
            if (code == "101") return "（缺少必填参数）";
            if (code == "108") return "（应用 ID 无效，请检查 youdao_appkey）";
            if (code == "110") return "（当前应用未开通「大模型翻译」：请在有道控制台为应用开通该服务；" +
                                      "或取消勾选「上下文增强翻译」/ 把 youdao_mode 设为 text 改用文本翻译）";
            if (code == "112") return "（请求的服务不存在）";
            if (code == "202") return "（签名校验失败，请检查 youdao_secret）";
            if (code == "203") return "（访问 IP 不在白名单）";
            if (code == "206") return "（时间戳无效）";
            if (code == "411") return "（访问频率受限）";
            if (code == "902000") return "（大模型翻译调用失败）";
            return "";
        }
    }
}
