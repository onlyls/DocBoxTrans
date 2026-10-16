using System;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;

namespace DocBoxTrans
{
    /// <summary>
    /// 本地 HTTP 接口：仅监听 127.0.0.1，供稻壳阅读器等外部程序直接把文本送进来翻译，
    /// 绕开“模拟 Ctrl+C + 轮询剪贴板”的脆弱取词方式。基于 HttpListener（回环地址无需管理员权限）。
    ///
    /// 路由：
    ///   POST /translate  body=原文（或 ?text=）→ 返回译文文本
    ///   POST /selection  body=原文（或 ?text=）→ 触发弹窗展示（与热键一致），返回 ok
    /// 鉴权：cfg.LocalToken 非空时，需带请求头 X-DocBox-Token。
    /// </summary>
    class LocalServer : IDisposable
    {
        readonly AppConfig cfg;
        readonly string prefix;
        readonly string token;
        HttpListener listener;
        volatile bool running;

        /// <summary>收到 /selection 请求时触发（参数为原始文本）；调用方应把弹窗展示投递到 UI 线程。</summary>
        public event Action<string> SelectionRequested;

        /// <summary>/translate 成功返回有效译文时触发（原文, 译文, 引擎标识）；供统一写入历史/上下文。</summary>
        public event Action<string, string, string> TranslationCompleted;

        public LocalServer(AppConfig config)
        {
            cfg = config;
            int port = config.LocalPort > 0 ? config.LocalPort : 17635;
            prefix = "http://127.0.0.1:" + port + "/";
            token = config.LocalToken == null ? "" : config.LocalToken;
        }

        public string Prefix { get { return prefix; } }

        public void Start()
        {
            listener = new HttpListener();
            listener.Prefixes.Add(prefix);
            listener.Start();   // 端口被占用/无权限时抛异常，由调用方记录日志
            running = true;
            Thread t = new Thread(Loop);
            t.IsBackground = true;
            t.Start();
        }

        void Loop()
        {
            while (running)
            {
                HttpListenerContext ctx;
                try { ctx = listener.GetContext(); }
                catch { break; }   // listener 已停止
                ThreadPool.QueueUserWorkItem(delegate(object o) { Handle((HttpListenerContext)o); }, ctx);
            }
        }

        void Handle(HttpListenerContext ctx)
        {
            try
            {
                string path = ctx.Request.Url.AbsolutePath.TrimEnd('/').ToLowerInvariant();

                if (token.Length > 0)
                {
                    string got = ctx.Request.Headers["X-DocBox-Token"];
                    if (!string.Equals(got, token, StringComparison.Ordinal))
                    {
                        Respond(ctx, 401, "unauthorized");
                        return;
                    }
                }

                if (path != "/translate" && path != "/selection")
                {
                    Respond(ctx, 404, "not found");
                    return;
                }

                string text = ReadText(ctx.Request);
                if (text != null) text = text.Trim();
                if (string.IsNullOrEmpty(text))
                {
                    Respond(ctx, 400, "empty text");
                    return;
                }

                if (path == "/translate")
                {
                    TranslateResult res;
                    try { res = Translator.TranslateAsync(cfg, text, CancellationToken.None).GetAwaiter().GetResult(); }
                    catch (Exception ex) { res = TranslateResult.Err("[请求异常] " + ex.Message); }
                    // 仅有效译文才纳入统一的历史/上下文写入
                    if (res.Success && !string.IsNullOrEmpty(res.Text))
                    {
                        Action<string, string, string> h = TranslationCompleted;
                        if (h != null) { try { h(text, res.Text, cfg.Service); } catch { } }
                    }
                    Respond(ctx, 200, res.Text);
                }
                else
                {
                    Action<string> h = SelectionRequested;
                    if (h != null) h(text);
                    Respond(ctx, 200, "ok");
                }
            }
            catch (Exception ex)
            {
                try { Respond(ctx, 500, ex.Message); } catch { }
            }
        }

        static string ReadText(HttpListenerRequest req)
        {
            try
            {
                if (req.HasEntityBody)
                {
                    using (StreamReader r = new StreamReader(req.InputStream, req.ContentEncoding))
                        return r.ReadToEnd();
                }
            }
            catch { }
            string q = req.QueryString["text"];
            if (string.IsNullOrEmpty(q)) q = req.QueryString["q"];
            return q;
        }

        static void Respond(HttpListenerContext ctx, int code, string body)
        {
            byte[] data = Encoding.UTF8.GetBytes(body ?? "");
            ctx.Response.StatusCode = code;
            ctx.Response.ContentType = "text/plain; charset=utf-8";
            ctx.Response.ContentLength64 = data.Length;
            ctx.Response.OutputStream.Write(data, 0, data.Length);
            ctx.Response.OutputStream.Close();
        }

        public void Stop()
        {
            running = false;
            try { if (listener != null) listener.Stop(); } catch { }
            try { if (listener != null) listener.Close(); } catch { }
            listener = null;
        }

        public void Dispose() { Stop(); }
    }
}
