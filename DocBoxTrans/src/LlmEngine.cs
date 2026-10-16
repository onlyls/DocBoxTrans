using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace DocBoxTrans
{
    /// <summary>大模型引擎（OpenAI 兼容 /chat/completions）。</summary>
    class LlmEngine : ITranslateEngine
    {
        // 大模型接口不使用代理，复用同一个 HttpClient。
        static readonly HttpClient Client = TranslateSupport.CreateClient("");

        public string Id { get { return "llm"; } }
        public string DisplayName { get { return "LLM"; } }
        public bool SupportsContext(AppConfig cfg) { return true; }

        // 存在上下文时追加到系统提示末尾（不改动用户配置的 system_prompt 本身）
        const string ContextGuidance =
            "\n\n以下是之前已完成翻译的原文与译文（成对给出），仅用于统一术语、缩写与表达习惯；" +
            "请勿翻译这些内容，只翻译最后一条用户消息，并且只输出译文本身。";

        public Task<TranslateResult> TranslateAsync(AppConfig cfg, string text, CancellationToken ct)
        {
            return TranslateAsync(cfg, text, null, ct);
        }

        public async Task<TranslateResult> TranslateAsync(AppConfig cfg, string text, IList<HistoryRecord> context, CancellationToken ct)
        {
            if (string.IsNullOrEmpty(cfg.ApiKey))
                return TranslateResult.Err("[配置错误] 还没有填写 api_key。\n请编辑 config.ini 里的 api_key，保存后会自动生效。");

            string body = BuildBody(cfg, text, context);
            HttpRequestMessage req = new HttpRequestMessage(HttpMethod.Post, cfg.Endpoint());
            req.Content = new StringContent(body, Encoding.UTF8, "application/json");
            req.Headers.TryAddWithoutValidation("Authorization", "Bearer " + cfg.ApiKey);
            req.Headers.TryAddWithoutValidation("Accept", "application/json");

            try
            {
                string txt = await TranslateSupport.SendAsync(cfg, Client, req, ct).ConfigureAwait(false);
                string content = ExtractContent(txt);
                if (content != null) return TranslateResult.Ok(content);
                // 没有译文时再尝试解析接口错误，避免把错误信息当成译文返回
                string em = ExtractError(txt);
                if (em != null) return TranslateResult.Err("[请求失败] " + em);
                return TranslateResult.Err("[响应解析失败]\n" + TranslateSupport.Truncate(txt, 800));
            }
            catch (HttpStatusException se)
            {
                string detail = se.Body;
                string em = ExtractError(detail);
                if (em != null) detail = em;
                return TranslateResult.Err("[请求失败] " + detail);
            }
            catch (Exception ex)
            {
                return TranslateResult.Err("[请求异常] " + ex.Message);
            }
        }

        static string BuildBody(AppConfig cfg, string text, IList<HistoryRecord> context)
        {
            bool hasCtx = context != null && context.Count > 0;
            StringBuilder sb = new StringBuilder();
            sb.Append("{\"model\":").Append(TranslateSupport.JsonString(cfg.Model));
            sb.Append(",\"temperature\":").Append(cfg.Temperature.ToString(System.Globalization.CultureInfo.InvariantCulture));
            sb.Append(",\"stream\":false,\"messages\":[");
            string sys = cfg.SystemPrompt;
            if (hasCtx) sys = sys + ContextGuidance;
            sb.Append("{\"role\":\"system\",\"content\":").Append(TranslateSupport.JsonString(sys)).Append("}");
            if (hasCtx)
            {
                // 历史原文/译文严格成对给出（旧 → 新），与当前待翻译文本明确区分
                for (int i = 0; i < context.Count; i++)
                {
                    HistoryRecord r = context[i];
                    if (r == null) continue;
                    sb.Append(",{\"role\":\"user\",\"content\":").Append(TranslateSupport.JsonString(r.SourceText ?? "")).Append("}");
                    sb.Append(",{\"role\":\"assistant\",\"content\":").Append(TranslateSupport.JsonString(r.TranslatedText ?? "")).Append("}");
                }
            }
            sb.Append(",{\"role\":\"user\",\"content\":").Append(TranslateSupport.JsonString(text)).Append("}");
            sb.Append("]}");
            return sb.ToString();
        }

        static string ExtractContent(string json)
        {
            try
            {
                JavaScriptSerializer ser = new JavaScriptSerializer();
                ser.MaxJsonLength = 16 * 1024 * 1024;
                Dictionary<string, object> root = ser.Deserialize<Dictionary<string, object>>(json);
                object choicesObj;
                if (root != null && root.TryGetValue("choices", out choicesObj))
                {
                    // 注意：JavaScriptSerializer 把 JSON 数组反序列化成 ArrayList（实现了 IList）
                    System.Collections.IList choices = choicesObj as System.Collections.IList;
                    if (choices != null && choices.Count > 0)
                    {
                        Dictionary<string, object> c0 = choices[0] as Dictionary<string, object>;
                        if (c0 != null)
                        {
                            object msgObj;
                            if (c0.TryGetValue("message", out msgObj))
                            {
                                Dictionary<string, object> msg = msgObj as Dictionary<string, object>;
                                object content;
                                if (msg != null && msg.TryGetValue("content", out content) && content != null)
                                {
                                    string s = content as string;
                                    if (s != null) return s.Trim();
                                }
                            }
                            object textObj;
                            if (c0.TryGetValue("text", out textObj) && textObj is string)
                                return ((string)textObj).Trim();
                        }
                    }
                }
                return null;   // 无译文即返回 null，交由调用方区分「响应解析失败」与「接口错误」
            }
            catch { return null; }
        }

        static string ExtractError(string json)
        {
            try
            {
                JavaScriptSerializer ser = new JavaScriptSerializer();
                ser.MaxJsonLength = 16 * 1024 * 1024;
                Dictionary<string, object> root = ser.Deserialize<Dictionary<string, object>>(json);
                object errObj;
                if (root != null && root.TryGetValue("error", out errObj))
                {
                    Dictionary<string, object> err = errObj as Dictionary<string, object>;
                    if (err != null)
                    {
                        object m;
                        if (err.TryGetValue("message", out m) && m != null) return "接口返回错误：" + m.ToString();
                    }
                    if (errObj != null) return "接口返回错误：" + errObj.ToString();
                }
            }
            catch { }
            return null;
        }
    }
}
