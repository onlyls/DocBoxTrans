using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace DocBoxTrans
{
    static class Program
    {
        const int ID_SELECTION = 1;
        const int ID_CLIPBOARD = 2;
        const int ID_ESCAPE = 3;
        const int ID_STASH = 4;

        static AppConfig cfg;
        static HotkeySink sink;
        static NotifyIcon tray;
        static PopupForm popup;
        static ToolbarForm toolbar;
        static HistoryForm history;
        static MouseHook mouseHook;
        // only_in_docbox=1 时用低级键盘钩子按“前台程序”条件拦截热键
        static KeyboardHook keyHook;
        // 稻壳进程的 PID 缓存（钩子回调里只能做极轻量判断，不能现查进程名）
        static readonly HashSet<int> docBoxPids = new HashSet<int>();
        static System.Windows.Forms.Timer docBoxPidTimer;
        static LocalServer localServer;
        // 递增的操作号：每次触发翻译自增并捕获快照，回调时若与最新不一致则丢弃，避免过期结果覆盖新结果
        static int opSeq;
        static bool escRegistered;
        static string baseDir;
        static string logPath;
        static uint modsSel, vkSel, modsClip, vkClip, modsStash, vkStash;
        static System.Windows.Forms.Timer docboxTimer;
        static bool sawDocBox;
        static int docboxMisses;
        // 划词工具条“暂存”的文本：下次翻译时与本次选中拼接；被翻译成功后清空
        static string stashText = "";
        // 划词工具条在“拖选结束”瞬间取词并缓存，供「译/存」直接使用：
        // 避免点击按钮后再取词依赖“前台此刻是否仍是目标程序、选区是否还在”的时序（此前的失效根因）。
        static string toolbarSelection = "";
        static bool toolbarSelectionValid = false;
        // 划词拖选结束瞬间缓存的「来源文档」标识（此刻前台必为目标程序），供工具条翻译时按文档隔离
        static string toolbarOrigin = "";
        // 上一次翻译的完整原文（含暂存前缀），用于切换服务后重译
        static string lastSource = "";
        // 上一次翻译的来源文档标识（「进程名｜窗口标题」）；切换服务重译时沿用同一标识（见 IsolateByOrigin）
        static string lastOrigin = "";

        // ---- 按标签页（文档）跟随：浮窗与历史窗口随当前文档显隐 ----
        // 轮询定时器：稻壳处于前台时检测其「文档身份」是否变化（切换标签页/换 PDF）
        static System.Windows.Forms.Timer docTabTimer;
        // 当前正在跟踪的文档键（前台为目标阅读器时的「进程名｜标题」）
        static string activeDocKey = "";

        // 每个文档的记忆：上次展示的原文/译文/是否错误，以及浮窗、历史窗口是否处于显示；切回时据此恢复
        sealed class DocState
        {
            public string Source = "";
            public string Result = "";
            public bool IsError;
            public bool PopupVisible;
            public bool HistoryVisible;
        }
        static readonly Dictionary<string, DocState> docStates = new Dictionary<string, DocState>(StringComparer.Ordinal);
        // 鼠标钩子拖拽判定
        static Point mouseDownAt;
        static bool mouseDown;
        // 静态持有：既是单实例标记，也是守卫进程判断“翻译工具是否在运行”的依据。
        // 若只放在 Main 的局部变量里，它会被 GC 回收，命名互斥体随即消失。
        static Mutex companionMutex;
        // 配置界面（DocBoxTransConfig.exe）保存并正常退出后会 Set 这个命名事件，收到即自动重载配置
        static EventWaitHandle configReloadEvent;
        static RegisteredWaitHandle configReloadWait;

        [STAThread]
        static int Main(string[] args)
        {
            // ---- 命令行模式（被“守卫”进程或开机自启调用）----
            if (args != null && args.Length > 0)
            {
                string a = args[0].Trim().ToLowerInvariant();
                if (a == "--watch") return Lifecycle.RunWatcher();
                if (a == "--install-autostart")
                {
                    Lifecycle.EnableAutostart();
                    Lifecycle.StartWatcher();
                    return 0;
                }
                if (a == "--uninstall-autostart")
                {
                    Lifecycle.DisableAutostart();
                    Lifecycle.StopWatcher();
                    return 0;
                }
                if (a == "--stop-watcher") { Lifecycle.StopWatcher(); return 0; }
                if (a == "--help" || a == "-h" || a == "/?")
                {
                    MessageBox.Show(Lifecycle.HelpText, "DocBox 划词翻译 - 用法",
                        MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return 0;
                }
            }

            bool createdNew;
            // 这个互斥体同时作为“翻译工具是否在运行”的标记，供守卫进程探测
            companionMutex = new Mutex(true, Lifecycle.CompanionMutexName, out createdNew);
            if (!createdNew)
            {
                MessageBox.Show("DocBox 划词翻译已经在运行了（看右下角托盘图标）。", "DocBox 划词翻译",
                    MessageBoxButtons.OK, MessageBoxIcon.Information);
                return 0;
            }

            baseDir = AppDomain.CurrentDomain.BaseDirectory;
            logPath = Path.Combine(baseDir, "log.txt");
            cfg = AppConfig.Load(Path.Combine(baseDir, "config.ini"));
            Translator.EnsureTls();
            // 历史记录持久化：本地文件，加载既有记录并按上限裁剪
            HistoryStore.Init(Path.Combine(baseDir, "history.jsonl"), cfg.HistoryMax, Log);

            // 声明 DPI 感知，避免高 DPI 屏幕上被系统位图放大导致界面发虚（须在创建窗口前调用）
            Native.MakeDpiAware();

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            // 兜底：任何未处理异常都先写日志，避免托盘程序“莫名消失”无从排查
            Application.ThreadException += delegate(object s, System.Threading.ThreadExceptionEventArgs e)
            {
                Log("UI 线程异常: " + e.Exception);
            };
            AppDomain.CurrentDomain.UnhandledException += delegate(object s, UnhandledExceptionEventArgs e)
            {
                Log("未处理异常: " + e.ExceptionObject);
            };

            sink = new HotkeySink();
            sink.HotkeyPressed += OnHotkey;

            tray = new NotifyIcon();
            tray.Icon = BuildTrayIcon();
            tray.Text = "DocBox 划词翻译";
            tray.ContextMenuStrip = BuildTrayMenu();
            tray.Visible = true;

            StartDocBoxPidWatch();   // 先备好稻壳 PID，供键盘钩子回调廉价比较
            if (!RegisterAll())
            {
                tray.ShowBalloonTip(5000, "热键注册失败",
                    cfg.OnlyInDocBox
                        ? "键盘钩子安装失败，划词热键暂不可用。"
                        : "热键可能已被其它程序占用，请在托盘菜单里打开 config.ini 换一个热键（保存后会自动生效）。",
                    ToolTipIcon.Warning);
            }

            Log("启动。取词热键=" + cfg.Hotkey + " 剪贴板热键=" + cfg.HotkeyClipboard +
                " 暂存热键=" + (string.IsNullOrEmpty(cfg.HotkeyStash) ? "(未设置)" : cfg.HotkeyStash) +
                " 热键模式=" + (cfg.OnlyInDocBox ? "仅前台为 " + cfg.DocBoxProcess + " 时拦截（键盘钩子）" : "全局（RegisterHotKey）") +
                " 仅限目标进程=" + (cfg.OnlyInDocBox ? cfg.DocBoxProcess : "否") +
                " 服务=" + cfg.Service + " 接口=" + cfg.Endpoint() + " 模型=" + cfg.Model +
                " api_key=" + (string.IsNullOrEmpty(cfg.ApiKey) ? "(未填写)" : "(已填写)") +
                " 代理=" + (string.IsNullOrEmpty(cfg.Proxy) ? "(无)" : cfg.Proxy) +
                " 工具条=" + (cfg.ToolbarEnable ? "开" : "关") +
                " 随稻壳退出=" + (cfg.ExitWithDocBox ? "是" : "否"));

            StartLifecycleWatch();
            StartMouseHook();
            StartDocTabWatch();   // 按标签页（文档）跟随浮窗/历史窗口的显隐
            StartLocalServer();
            StartConfigWatch();

            Application.Run(new ApplicationContext());

            if (mouseHook != null) mouseHook.Uninstall();
            if (toolbar != null) { toolbar.HideToolbar(); toolbar.Dispose(); }
            if (tray != null) { tray.Visible = false; tray.Dispose(); }
            if (sink != null) sink.ReleaseHandle();
            return 0;
        }

        // ---------------- 与稻壳阅读器联动：稻壳关了就把自己也关掉 ----------------

        static void StartLifecycleWatch()
        {
            if (!cfg.ExitWithDocBox) return;
            docboxTimer = new System.Windows.Forms.Timer();
            docboxTimer.Interval = Math.Max(500, cfg.LifecycleCheckMs);
            docboxTimer.Tick += delegate { CheckDocBoxAlive(); };
            docboxTimer.Start();
        }

        static void CheckDocBoxAlive()
        {
            if (Lifecycle.IsProcessRunning(cfg.DocBoxProcess))
            {
                sawDocBox = true;
                docboxMisses = 0;
                return;
            }
            // 手动启动、且期间稻壳从没启动过 → 保持常驻，方便单独调试
            if (!sawDocBox) return;
            // 稻壳已退出就随它一起退出：浮窗 / 历史窗口 / 工具条还在也一并关掉，
            // 否则这些窗口会永远留在桌面上、程序也无法退出（由 ExitApp 负责收尾）。
            docboxMisses++;
            if (docboxMisses >= 2)
            {
                Log("稻壳阅读器已退出，联动关闭本工具");
                ExitApp(true);
            }
        }

        /// <summary>退出程序。withDocBox=true 表示是“稻壳关闭”触发的联动退出，需要告知守卫进程。</summary>
        static void ExitApp(bool withDocBox)
        {
            if (withDocBox) Lifecycle.SignalExitWithDocBox();
            try { UnregisterAll(); } catch { }
            try { StopLocalServer(); } catch { }
            try { if (mouseHook != null) mouseHook.Uninstall(); } catch { }
            try { if (toolbar != null) { toolbar.HideToolbar(); toolbar.Dispose(); } } catch { }
            try { if (popup != null && !popup.IsDisposed) { popup.HidePopup(); popup.Dispose(); } } catch { }
            try { if (history != null) { history.Hide(); history.Dispose(); } } catch { }
            try { if (docboxTimer != null) { docboxTimer.Stop(); } } catch { }
            try { StopDocTabWatch(); } catch { }
            try { if (tray != null) tray.Visible = false; } catch { }
            Application.Exit();
        }

        // ---------------- 热键 ----------------

        static bool RegisterAll()
        {
            // 只在稻壳里生效时，必须用低级键盘钩子按前台程序条件拦截：
            // RegisterHotKey 是系统级独占的，会在操作系统层面把该组合键从输入流里拿走，
            // 浏览器等其它程序再也收不到它（例如浏览器划词插件用的 Ctrl+Y）。
            if (cfg.OnlyInDocBox) return InstallScopedHotkeys();

            bool ok = true;
            if (!ParseHotkey(cfg.Hotkey, out modsSel, out vkSel))
            {
                Log("热键解析失败：" + cfg.Hotkey);
                ok = false;
            }
            else if (!Native.RegisterHotkey(sink.Handle, ID_SELECTION, modsSel, vkSel))
            {
                Log("热键注册失败（可能被占用）：" + cfg.Hotkey);
                ok = false;
            }

            if (!ParseHotkey(cfg.HotkeyClipboard, out modsClip, out vkClip))
            {
                Log("剪贴板热键解析失败：" + cfg.HotkeyClipboard);
            }
            else if (!Native.RegisterHotkey(sink.Handle, ID_CLIPBOARD, modsClip, vkClip))
            {
                Log("剪贴板热键注册失败（可能被占用）：" + cfg.HotkeyClipboard);
            }

            // 暂存热键：留空表示不注册
            if (!string.IsNullOrEmpty(cfg.HotkeyStash))
            {
                if (!ParseHotkey(cfg.HotkeyStash, out modsStash, out vkStash))
                {
                    Log("暂存热键解析失败：" + cfg.HotkeyStash);
                }
                else if (!Native.RegisterHotkey(sink.Handle, ID_STASH, modsStash, vkStash))
                {
                    Log("暂存热键注册失败（可能被占用）：" + cfg.HotkeyStash);
                }
            }
            return ok;
        }

        /// <summary>
        /// only_in_docbox=1：安装低级键盘钩子。钩子回调里判断前台是不是稻壳：
        /// 是 → 拦截并触发；否 → 原样放行，别的程序里同一个快捷键不受影响。
        /// </summary>
        static bool InstallScopedHotkeys()
        {
            if (keyHook == null)
            {
                keyHook = new KeyboardHook();
                keyHook.ShouldHandle = ShouldSwallowHotkey;
                // 钩子回调运行在 UI 线程，但仍要先把处理丢回消息队列，保证回调尽快返回
                keyHook.HotkeyPressed += delegate(int id) { sink.Post(delegate { OnHotkey(id); }); };
            }

            List<KeyboardHook.Binding> bindings = new List<KeyboardHook.Binding>();
            AddBinding(bindings, ID_SELECTION, cfg.Hotkey, "取词");
            AddBinding(bindings, ID_CLIPBOARD, cfg.HotkeyClipboard, "剪贴板");
            if (!string.IsNullOrEmpty(cfg.HotkeyStash)) AddBinding(bindings, ID_STASH, cfg.HotkeyStash, "暂存");
            // Esc 关浮窗也走钩子：只在浮窗可见时才拦截，平时 Esc 照常传给前台程序
            bindings.Add(new KeyboardHook.Binding { Id = ID_ESCAPE, Mods = 0, Vk = 0x1B });
            keyHook.Bindings = bindings.ToArray();

            if (!keyHook.Install())
            {
                Log("键盘钩子安装失败，热键将不可用（仅在目标程序内响应）");
                return false;
            }
            return true;
        }

        static void AddBinding(List<KeyboardHook.Binding> bindings, int id, string spec, string label)
        {
            uint m, v;
            if (!ParseHotkey(spec, out m, out v))
            {
                Log(label + "热键解析失败：" + spec);
                return;
            }
            bindings.Add(new KeyboardHook.Binding { Id = id, Mods = m, Vk = v });
        }

        /// <summary>钩子回调里的同步判定：这一次按键此刻是否应该由我们拦截。</summary>
        static bool ShouldSwallowHotkey(int id)
        {
            // 不在稻壳里就放行，让浏览器等程序照常收到这个快捷键
            if (cfg.OnlyInDocBox && !ForegroundIsTarget()) return false;
            // Esc 只在浮窗开着时才拦下用来关窗
            if (id == ID_ESCAPE) return popup != null && !popup.IsDisposed && popup.Visible;
            return true;
        }

        /// <summary>前台窗口是否属于目标程序。只用缓存的 PID 集合比对，保证钩子回调足够快。</summary>
        static bool ForegroundIsTarget()
        {
            if (docBoxPids.Count == 0) return false;
            int pid = Native.ForegroundProcessId();
            return pid != 0 && docBoxPids.Contains(pid);
        }

        /// <summary>诊断用：把当前前台窗口的句柄 / PID / 进程名 / 标题写入日志。</summary>
        static void DumpForeground(string tag)
        {
            IntPtr h = Native.ForegroundWindow();
            int pid = Native.ForegroundProcessId();
            string name = Native.ForegroundProcessName() ?? "(未知)";
            Log(tag + " 前台hwnd=" + h + " pid=" + pid + " 进程=" + name + " 标题=" + Native.WindowTitle(h));
        }

        static void UnregisterAll()
        {
            if (keyHook != null)
            {
                try { keyHook.Uninstall(); } catch { }
            }
            StopDocBoxPidWatch();
            Native.UnregisterHotkey(sink.Handle, ID_SELECTION);
            Native.UnregisterHotkey(sink.Handle, ID_CLIPBOARD);
            Native.UnregisterHotkey(sink.Handle, ID_STASH);
            Native.UnregisterHotkey(sink.Handle, ID_ESCAPE);
            escRegistered = false;
        }

        /// <summary>缓存稻壳 PID 供键盘钩子廉价比较；稻壳可能后启动，所以每 2 秒刷新一次。</summary>
        static void StartDocBoxPidWatch()
        {
            RefreshDocBoxPids();
            if (!cfg.OnlyInDocBox) return;
            if (docBoxPidTimer == null)
            {
                docBoxPidTimer = new System.Windows.Forms.Timer();
                docBoxPidTimer.Interval = 2000;
                docBoxPidTimer.Tick += delegate { RefreshDocBoxPids(); };
            }
            docBoxPidTimer.Start();
        }

        static void StopDocBoxPidWatch()
        {
            if (docBoxPidTimer != null) docBoxPidTimer.Stop();
            docBoxPids.Clear();
        }

        static void RefreshDocBoxPids()
        {
            if (cfg.OnlyInDocBox) Lifecycle.CollectProcessIds(cfg.DocBoxProcess, docBoxPids);
            else docBoxPids.Clear();
        }

        static bool ParseHotkey(string spec, out uint mods, out uint vk)
        {
            mods = 0; vk = 0;
            if (string.IsNullOrEmpty(spec)) return false;
            string[] parts = spec.Split('+');
            for (int i = 0; i < parts.Length; i++)
            {
                string u = parts[i].Trim().ToUpperInvariant();
                if (u.Length == 0) continue;
                if (u == "ALT") mods |= Native.MOD_ALT;
                else if (u == "CTRL" || u == "CONTROL") mods |= Native.MOD_CONTROL;
                else if (u == "SHIFT") mods |= Native.MOD_SHIFT;
                else if (u == "WIN") mods |= Native.MOD_WIN;
                else vk = KeyNameToVk(u);
            }
            return vk != 0;
        }

        static uint KeyNameToVk(string u)
        {
            if (u.Length == 1)
            {
                char c = u[0];
                if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) return (uint)c;
            }
            if (u.Length >= 2 && u[0] == 'F')
            {
                int n;
                if (int.TryParse(u.Substring(1), out n) && n >= 1 && n <= 12) return (uint)(0x70 + n - 1);
            }
            if (u == "SPACE") return 0x20;
            if (u == "ESC" || u == "ESCAPE") return 0x1B;
            if (u == "ENTER") return 0x0D;
            if (u == "TAB") return 0x09;
            if (u == "`" || u == "OEM3") return 0xC0;
            return 0;
        }

        static void OnHotkey(int id)
        {
            if (id == ID_ESCAPE)
            {
                if (popup != null && popup.Visible) popup.HidePopup();
                UnregisterEscape();
                return;
            }
            if (id == ID_SELECTION) Trigger(true);
            else if (id == ID_CLIPBOARD) Trigger(false);
            else if (id == ID_STASH) StashSelection();
        }

        static void RegisterEscape()
        {
            // 钩子模式下 Esc 由钩子按“浮窗可见”条件拦截，无需（也不应）注册全局热键
            if (keyHook != null && keyHook.Installed) return;
            if (escRegistered) return;
            escRegistered = Native.RegisterHotkey(sink.Handle, ID_ESCAPE, 0, 0x1B);
        }

        static void UnregisterEscape()
        {
            if (keyHook != null && keyHook.Installed) return;
            if (!escRegistered) return;
            Native.UnregisterHotkey(sink.Handle, ID_ESCAPE);
            escRegistered = false;
        }

        // ---------------- 主流程 ----------------

        static void Trigger(bool fromSelection)
        {
            // 新请求直接取代进行中的翻译（旧请求的结果会在回调里按 opId 丢弃）。
            // 这里刻意不隐藏已存在的浮窗：隐藏窗口会打断取词（选区/前台归属），
            // 导致下一次取词要按两次热键才生效；直接就地更新同一个浮窗即可
            // （ShowBusy 会重置内容、收起原文，并在用户未手动移动时重新定位）。
            if (toolbar != null && !toolbar.IsDisposed && toolbar.Visible) toolbar.HideToolbar();

            if (cfg.OnlyInDocBox)
            {
                string proc = Native.ForegroundProcessName();
                if (proc == null || string.Compare(proc, cfg.DocBoxProcess, true) != 0)
                {
                    DumpForeground("前台不在目标范围内，忽略（进程=" + (proc ?? "(未知)") + "）");
                    return;
                }
            }

            string text;
            if (fromSelection && cfg.UseSelection)
            {
                text = CaptureSelection();
            }
            else
            {
                text = Native.GetClipboardText();
            }

            if (text == null) text = "";
            text = text.Trim();

            EnsurePopup();
            Point at = Cursor.Position;

            if (text.Length == 0)
            {
                popup.ShowBusy("(没有取到文字)", at);
                popup.SetError("(没有取到文字)",
                    "没有取到选中的文字。\n\n请先在阅读器里用鼠标划选一段文字，再按 " + cfg.Hotkey +
                    "；如果仍然不行，可以先把文字复制到剪贴板，再用 " + cfg.HotkeyClipboard + " 翻译剪贴板。");
                RegisterEscape();
                Log("取词为空");
                return;
            }

            // 暂存内容 + 本次选中，一并翻译（解决 PDF 跨页断行）
            // 取词当下前台必为目标程序：在此捕获「来源文档」身份，供上下文/历史按文档隔离
            RunTranslation(text, at, cfg.IsolateByOrigin ? Native.ForegroundDocumentKey() : "");
        }

        /// <summary>对给定文本执行「暂存拼接 → 预处理 → 截断 → 翻译 → 展示」。必须在 UI 线程调用。
        /// origin 为来源文档标识（空串 = 未隔离），用于上下文参考与历史去重按文档隔离。</summary>
        static void RunTranslation(string text, Point at, string origin)
        {
            // 暂存内容 + 本次选中，一并翻译（解决 PDF 跨页断行）
            bool consumeStash = stashText.Length > 0;
            string combined = text;
            if (consumeStash)
            {
                string sep = (cfg.StashSeparator == null || cfg.StashSeparator.Length == 0) ? " " : cfg.StashSeparator;
                combined = stashText + sep + text;
            }

            string note = "";
            if (cfg.PreprocessText)
            {
                string cleaned = TextPreprocessor.Process(combined);
                if (cleaned.Length != combined.Length || cleaned != combined)
                    Log("文本预处理：合并了不合理换行，" + combined.Length + " → " + cleaned.Length + " 字符");
                combined = cleaned;
            }
            if (combined.Length > cfg.MaxChars)
            {
                combined = combined.Substring(0, cfg.MaxChars);
                note = "\n\n[已截断：原文超过 " + cfg.MaxChars + " 字符]";
            }

            // 文档可能已切换：在改动浮窗之前先记下旧文档的显隐（随后展示本次译文，无需恢复旧内容）
            lastOrigin = origin ?? "";
            SetActiveDoc(lastOrigin, false);

            EnsurePopup();
            int myId = ++opSeq;
            popup.ShowBusy(combined, at);
            RegisterEscape();

            string payload = combined;
            string tail = note;
            lastSource = payload;
            string provider = cfg.Service;
            string targetLang = cfg.TargetLang;
            long seq = TranslationContext.NextSeq();
            int reqGen = TranslationContext.Generation;
            // 请求发起时即固定上下文快照：翻译过程中其它请求的追加/清空不影响本次输入。
            // 两个前提必须同时满足才携带上下文：①托盘菜单已勾选「上下文增强翻译」；
            // ②所选服务本身具备上下文能力（大模型恒具备；有道的 auto 模式跟随此开关，text 模式不具备）。
            List<HistoryRecord> ctx = (cfg.ContextEnable && Translator.SupportsContext(cfg, provider))
                ? TranslationContext.Snapshot(cfg, provider, cfg.ContextMaxItems, cfg.ContextMaxChars, lastOrigin)
                : null;

            // 请求级复用：同原文 + 同引擎 + 同目标语言命中历史时直接展示，不重复发请求。
            // 与插件一致：启用「上下文增强翻译」且所选服务具备上下文能力时（ctx 非空）绕过复用，
            // 避免返回与上文不符的旧译文。
            if (cfg.ReuseTranslation && ctx == null)
            {
                HistoryRecord hit = HistoryStore.FindBySource(payload, provider, targetLang, lastOrigin);
                if (hit != null)
                {
                    popup.ShowResult(payload, hit.TranslatedText + tail, false);
                    RememberShownResult(payload, hit.TranslatedText + tail, false);
                    if (consumeStash) { stashText = ""; RefreshStashBadge(); }
                    Log("复用历史译文，服务=" + provider + " 长度=" + payload.Length + " 预览=" + Preview(payload));
                    return;
                }
            }

            Log("开始翻译，服务=" + provider + " 长度=" + payload.Length +
                " 上下文=" + (ctx == null ? 0 : ctx.Count) + " 条 预览=" + Preview(payload));

            Task.Factory.StartNew(delegate
            {
                TranslateResult res;
                try { res = Translator.TranslateAsync(cfg, payload, ctx, CancellationToken.None).GetAwaiter().GetResult(); }
                catch (Exception ex) { res = TranslateResult.Err("[请求异常] " + ex.Message); }
                string displayed = res.Text + tail;
                sink.Post(delegate
                {
                    if (myId != opSeq) return;   // 已被更新的请求取代，丢弃过期结果
                    if (popup == null || popup.IsDisposed) return;
                    try { popup.ShowResult(payload, displayed, !res.Success); }
                    catch (Exception ex) { Log("显示结果失败：" + ex.Message); }
                    RememberShownResult(payload, displayed, !res.Success);
                    // 暂存被成功翻译后才清空，便于失败时重试
                    if (consumeStash && res.Success)
                    {
                        stashText = "";
                        RefreshStashBadge();
                    }
                    // 仅在成功时写入历史与上下文；写入失败不影响已展示译文
                    if (res.Success)
                        RecordSuccessfulTranslation(payload, res.Text, provider, targetLang, seq, reqGen, lastOrigin);
                });
            });
        }

        /// <summary>
        /// 一次成功翻译的统一收尾：写入历史 +（功能开启时）追加到上下文 + 通知历史窗口刷新。仅在 UI 线程调用。
        /// 写入失败不抛出，避免影响已展示的译文。
        /// </summary>
        static void RecordSuccessfulTranslation(string source, string translated, string provider,
            string targetLang, long seq, int requestGen, string origin)
        {
            try
            {
                HistoryRecord rec = HistoryStore.Add(source, translated, provider, targetLang, origin);
                // 同一来源文档 + 同一原文只保留最新一次：切换服务重译后，旧译文不再作为上下文（与历史去重一致）
                TranslationContext.RemoveBySource(rec.SourceText, rec.Origin);
                // 仅对「当前配置下具备上下文能力」的服务累积上下文（谷歌/必应/腾讯/知网、
                // 有道在 text 模式下不具备，避免留下无效条目）
                if (cfg.ContextEnable && Translator.SupportsContext(cfg, provider))
                    TranslationContext.Add(rec, seq, requestGen);
                if (history != null && !history.IsDisposed && history.Visible)
                {
                    // 列表按当前文档过滤：把过滤键同步为本次记录所属文档，再刷新
                    history.OriginFilter = cfg.IsolateByOrigin ? rec.Origin : "";
                    history.RefreshList();
                }
            }
            catch (Exception ex) { Log("写入历史失败：" + ex.Message); }
        }

        /// <summary>
        /// 模拟 Ctrl+C 取得当前选中文字，并按配置清理剪贴板（恢复旧内容 / 清空）。
        /// 仅当本次确实写入过新内容时才清理，避免误删用户原有剪贴板内容。
        /// </summary>
        static string CaptureSelection()
        {
            // 取词会让 UI 线程阻塞数百毫秒（等待修饰键松开 + 模拟复制 + 轮询剪贴板），
            // 而低级键盘/鼠标钩子的回调正是在这个线程里执行：
            // 1) 线程长时间不处理消息，系统会按 LowLevelHooksTimeout 把钩子静默摘除，
            //    热键与划词工具条随之整体失效（需重启才能恢复）；
            // 2) 钩子自身的“自动重复”吞键状态来不及复位，会把本工具模拟的 Ctrl+C 一并吞掉
            //    （暂存热键 Alt+C 与 Ctrl+C 同键，表现尤其明显），导致取不到选中文字。
            // 因此取词前先卸载钩子，取词后再重新安装（顺带自愈任何已被系统摘除的钩子）。
            SuspendInputHooks();
            try
            {
                Native.WaitModifiersReleased(900);
                string before = Native.GetClipboardText();
                Native.SendCtrlC();
                string captured = Native.WaitClipboardTextChanged(before, cfg.ClipboardWaitMs);
                bool fresh = captured != null;
                if (captured == null && cfg.FallbackToClipboard)
                {
                    captured = Native.GetClipboardText();
                    Log("未检测到新的选中内容，改用剪贴板现有内容");
                }
                if (fresh)
                {
                    if (cfg.RestoreClipboard && before != null) Native.SetClipboardText(before);
                    else if (cfg.ClearClipboardAfterCapture) Native.ClearClipboard();
                }
                return captured;
            }
            finally
            {
                ResumeInputHooks();
            }
        }

        /// <summary>取词期间临时卸载低级钩子，避免其回调因 UI 线程阻塞而超时被系统摘除，也避免吞掉模拟的 Ctrl+C。</summary>
        static void SuspendInputHooks()
        {
            if (keyHook != null) { try { keyHook.Uninstall(); } catch { } }
            if (mouseHook != null) { try { mouseHook.Uninstall(); } catch { } }
        }

        /// <summary>取词结束后按当前配置重新安装低级钩子；重新安装也能自愈此前被系统摘除的钩子。</summary>
        static void ResumeInputHooks()
        {
            bool k = true, m = true;
            if (cfg.OnlyInDocBox && keyHook != null) { try { k = keyHook.Install(); } catch { k = false; } }
            if (cfg.ToolbarEnable && mouseHook != null) { try { m = mouseHook.Install(); } catch { m = false; } }
            if (!k || !m) Log("钩子重装结果：键盘=" + k + " 鼠标=" + m);
        }

        /// <summary>把当前选中内容追加到暂存（再次暂存则与已有暂存拼接）。</summary>
        static void StashSelection()
        {
            if (cfg.OnlyInDocBox)
            {
                string proc = Native.ForegroundProcessName();
                if (proc == null || string.Compare(proc, cfg.DocBoxProcess, true) != 0)
                {
                    DumpForeground("暂存：前台不在目标范围内，忽略");
                    return;
                }
            }

            string sel = CaptureSelection();
            if (sel == null) sel = "";
            sel = sel.Trim();
            if (sel.Length == 0)
            {
                DumpForeground("暂存：没有取到选中内容");
                RefreshStashBadge();
                return;
            }
            AppendStash(sel);
        }

        /// <summary>把一段文本追加到暂存（空文本忽略）。由热键暂存与工具条「存」共用。</summary>
        static void AppendStash(string sel)
        {
            if (sel == null) return;
            sel = sel.Trim();
            if (sel.Length == 0) return;
            string sep = (cfg.StashSeparator == null || cfg.StashSeparator.Length == 0) ? " " : cfg.StashSeparator;
            stashText = stashText.Length == 0 ? sel : stashText + sep + sel;
            Log("已暂存，累计长度=" + stashText.Length + " 预览=" + Preview(stashText));
            RefreshStashBadge();
        }

        /// <summary>
        /// 拖选结束瞬间取词：此刻无修饰键按下、前台必为目标程序、选区必新鲜。
        /// 与 CaptureSelection 一样先临时摘掉低级钩子再模拟 Ctrl+C（避免取词期间 UI 线程阻塞
        /// 使钩子超时被系统摘除、也避免钩子干扰注入的 Ctrl+C），取词结束后重装。不清剪贴板、不回退旧内容。
        /// </summary>
        static string CaptureFreshSelection()
        {
            SuspendInputHooks();
            try
            {
                string before = Native.GetClipboardText();
                Native.SendCtrlC();
                string captured = Native.WaitClipboardTextChanged(before, cfg.ClipboardWaitMs);
                return captured == null ? "" : captured.Trim();
            }
            finally
            {
                ResumeInputHooks();
            }
        }

        static void RefreshStashBadge()
        {
            if (toolbar != null && !toolbar.IsDisposed)
                toolbar.UpdateStashBadge(stashText.Length > 0, stashText.Length);
        }

        /// <summary>切换翻译服务：更新 cfg、写回配置，并用新引擎重译上一次的原文。</summary>
        static void OnServiceChanged(string id)
        {
            cfg.Service = (id ?? "llm").ToLowerInvariant();
            AppConfig.SetValue(cfg.Path, "service", cfg.Service);
            Log("切换翻译服务为 " + cfg.Service);
            if (lastSource.Length > 0) ReTranslateLast();
        }

        static void ReTranslateLast()
        {
            if (popup == null || popup.IsDisposed) return;
            string src = lastSource;
            if (src.Length == 0) return;

            int myId = ++opSeq;
            // 保持窗口当前位置，避免切换服务时窗口跳到鼠标位置
            popup.ShowBusyInPlace(src);
            string payload = src;
            string provider = cfg.Service;
            string targetLang = cfg.TargetLang;
            long seq = TranslationContext.NextSeq();
            int reqGen = TranslationContext.Generation;
            // 与划词翻译同一套前提：托盘菜单已勾选「上下文增强翻译」且所选服务具备上下文能力。
            List<HistoryRecord> ctx = (cfg.ContextEnable && Translator.SupportsContext(cfg, provider))
                ? TranslationContext.Snapshot(cfg, provider, cfg.ContextMaxItems, cfg.ContextMaxChars, lastOrigin)
                : null;

            // 切换到某个服务时，若该服务此前已翻译过同一原文，直接复用，不必重复发请求。
            if (cfg.ReuseTranslation && ctx == null)
            {
                HistoryRecord hit = HistoryStore.FindBySource(payload, provider, targetLang, lastOrigin);
                if (hit != null)
                {
                    popup.ShowResultPreserveAnchor(payload, hit.TranslatedText, false);
                    RememberShownResult(payload, hit.TranslatedText, false);
                    Log("复用历史译文（切换服务），服务=" + provider);
                    return;
                }
            }

            Task.Factory.StartNew(delegate
            {
                TranslateResult res;
                try { res = Translator.TranslateAsync(cfg, payload, ctx, CancellationToken.None).GetAwaiter().GetResult(); }
                catch (Exception ex) { res = TranslateResult.Err("[请求异常] " + ex.Message); }
                sink.Post(delegate
                {
                    if (myId != opSeq) return;   // 已被更新的请求取代，丢弃过期结果
                    if (popup == null || popup.IsDisposed) return;
                    try { popup.ShowResultPreserveAnchor(payload, res.Text, !res.Success); }
                    catch (Exception ex) { Log("显示结果失败：" + ex.Message); }
                    RememberShownResult(payload, res.Text, !res.Success);
                    if (res.Success)
                        RecordSuccessfulTranslation(payload, res.Text, provider, targetLang, seq, reqGen, lastOrigin);
                });
            });
        }

        // ---------------- 划词工具条 / 鼠标钩子 ----------------

        static void EnsureToolbar()
        {
            if (toolbar == null || toolbar.IsDisposed)
            {
                toolbar = new ToolbarForm(cfg);
                toolbar.TranslateRequested += delegate { TranslateFromToolbar(); };
                toolbar.StashRequested += delegate { StashFromToolbar(); };
                RefreshStashBadge();
            }
        }

        /// <summary>工具条「译」：优先用拖选结束时缓存的文字（不依赖点击时前台/选区），缓存不可用才回退到常规取词。</summary>
        static void TranslateFromToolbar()
        {
            if (toolbarSelectionValid && toolbarSelection.Length > 0)
            {
                string text = toolbarSelection;
                toolbarSelectionValid = false;
                EnsurePopup();
                RunTranslation(text, Cursor.Position, toolbarOrigin);
            }
            else
            {
                Trigger(true);
            }
        }

        /// <summary>工具条「存」：优先用拖选结束时缓存的文字；缓存不可用才回退到常规取词暂存。</summary>
        static void StashFromToolbar()
        {
            if (toolbarSelectionValid && toolbarSelection.Length > 0)
            {
                string sel = toolbarSelection;
                toolbarSelectionValid = false;
                AppendStash(sel);
            }
            else
            {
                StashSelection();
            }
        }

        static void StartMouseHook()
        {
            if (!cfg.ToolbarEnable) return;
            EnsureToolbar();
            if (mouseHook == null)
            {
                mouseHook = new MouseHook();
                mouseHook.LeftDown += OnMouseLeftDown;
                mouseHook.LeftUp += OnMouseLeftUp;
            }
            if (!mouseHook.Install()) Log("鼠标钩子安装失败，划词工具条可能不可用");
        }

        static void StopMouseHook()
        {
            if (mouseHook != null) mouseHook.Uninstall();
        }

        // ---------------- 本地 HTTP 接口（供稻壳等外部程序直接送文本） ----------------

        /// <summary>按配置启动本地接口；未启用或启动失败只记录日志，不影响程序运行。</summary>
        static void StartLocalServer()
        {
            if (!cfg.LocalEnable) return;
            try
            {
                localServer = new LocalServer(cfg);
                localServer.SelectionRequested += OnLocalSelection;
                localServer.TranslationCompleted += OnLocalTranslationCompleted;
                localServer.Start();
                Log("本地接口已启动：" + localServer.Prefix + "  （POST /translate、/selection）");
            }
            catch (Exception ex)
            {
                localServer = null;
                Log("本地接口启动失败：" + ex.Message);
                if (tray != null)
                    tray.ShowBalloonTip(4000, "本地接口启动失败",
                        "端口可能被占用或权限不足：" + ex.Message, ToolTipIcon.Warning);
            }
        }

        static void StopLocalServer()
        {
            if (localServer != null)
            {
                try { localServer.Stop(); } catch { }
                localServer = null;
                Log("本地接口已停止");
            }
        }

        /// <summary>外部程序请求 /selection：切回 UI 线程，走与热键相同的取词翻译展示流程（不再模拟 Ctrl+C）。</summary>
        static void OnLocalSelection(string text)
        {
            Point at = Cursor.Position;
            // 外部程序直接送入文本，无法得知其来源文档：按未隔离（全局）处理
            sink.Post(delegate { RunTranslation(text, at, ""); });
        }

        /// <summary>外部程序 /translate 成功：切回 UI 线程，纳入统一的历史/上下文写入。</summary>
        static void OnLocalTranslationCompleted(string source, string translated, string provider)
        {
            string targetLang = cfg.TargetLang;
            long seq = TranslationContext.NextSeq();
            int gen = TranslationContext.Generation;
            sink.Post(delegate { RecordSuccessfulTranslation(source, translated, provider, targetLang, seq, gen, ""); });
        }

        /// <summary>开关划词工具条：写回配置并即时生效（无需重启）。</summary>
        static void ToggleToolbar()
        {
            cfg.ToolbarEnable = !cfg.ToolbarEnable;
            AppConfig.SetValue(cfg.Path, "toolbar_enable", cfg.ToolbarEnable ? "1" : "0");
            if (cfg.ToolbarEnable)
            {
                StartMouseHook();
            }
            else
            {
                StopMouseHook();
                if (toolbar != null && !toolbar.IsDisposed) { toolbar.HideToolbar(); toolbar.Dispose(); }
                toolbar = null;
            }
            Log("划词工具条：" + (cfg.ToolbarEnable ? "开" : "关"));
            if (tray != null)
                tray.ShowBalloonTip(2000, "划词工具条",
                    cfg.ToolbarEnable ? "已开启：划词后会在光标旁弹出工具条。" : "已关闭：划词后不再弹出工具条。",
                    ToolTipIcon.Info);
        }

        // 钩子回调虽然在 UI 线程执行，但不能在其中做耗时操作：Windows 对低级鼠标钩子有
        // 超时限制（LowLevelHooksTimeout，默认约 300ms），超时会被系统静默摘除掉钩子。
        // 因此回调里只取一次光标位置，实际处理丢回消息循环执行。
        static void OnMouseLeftDown(Point p)
        {
            Point at = Cursor.Position;
            sink.Post(delegate { HandleMouseDown(at); });
        }

        static void OnMouseLeftUp(Point p)
        {
            Point at = Cursor.Position;
            sink.Post(delegate { HandleMouseUp(at); });
        }

        static void HandleMouseDown(Point at)
        {
            mouseDownAt = at;
            mouseDown = true;
            // 点工具条以外的地方就收起工具条
            if (toolbar != null && !toolbar.IsDisposed && toolbar.Visible && !toolbar.Bounds.Contains(at))
                toolbar.HideToolbar();
        }

        static void HandleMouseUp(Point at)
        {
            if (!mouseDown) return;
            mouseDown = false;
            if (!cfg.ToolbarEnable) return;

            int dx = Math.Abs(at.X - mouseDownAt.X);
            int dy = Math.Abs(at.Y - mouseDownAt.Y);
            if (Math.Max(dx, dy) < cfg.ToolbarDragThreshold) return; // 不是拖拽（划词），忽略普通点击

            if (cfg.OnlyInDocBox)
            {
                string proc = Native.ForegroundProcessName();
                if (proc == null || string.Compare(proc, cfg.DocBoxProcess, true) != 0)
                {
                    DumpForeground("划词：前台不在目标范围内，不弹工具条");
                    return;
                }
            }
            if (toolbar != null && !toolbar.IsDisposed && toolbar.Bounds.Contains(at)) return;

            // 拖选刚刚结束：前台必为目标程序、选区必新鲜——先记录「来源文档」，再取词缓存，供「译/存」直接使用，
            // 不再依赖“点击工具条按钮那一刻前台是否仍是目标程序、选区是否还在”（此前失效的真正根因）。
            toolbarOrigin = cfg.IsolateByOrigin ? Native.ForegroundDocumentKey() : "";
            toolbarSelection = CaptureFreshSelection();
            toolbarSelectionValid = toolbarSelection.Length > 0;
            Log("划词取词缓存：" + (toolbarSelectionValid
                ? "成功 len=" + toolbarSelection.Length + " 预览=" + Preview(toolbarSelection)
                : "失败"));

            EnsureToolbar();
            RefreshStashBadge();
            toolbar.ShowAt(at);
            DumpForeground("划词工具条弹出");
        }

        static void EnsurePopup()
        {
            if (popup == null || popup.IsDisposed)
            {
                popup = new PopupForm(cfg);
                popup.ServiceChanged += OnServiceChanged;
                popup.ClearContextRequested += OnClearContext;
                popup.HistoryToggleRequested += delegate { ToggleHistoryWindow(); };
                popup.VisibleChanged += delegate
                {
                    // 浮窗一关掉就立刻释放 Esc 热键，避免影响其它程序的 Esc；
                    // 同时作废进行中的翻译，避免关闭后旧结果把浮窗又弹回来
                    if (!popup.Visible) { UnregisterEscape(); opSeq++; }
                };
            }
        }

        // ---------------- 按标签页（文档）跟随显隐 ----------------

        static DocState GetDocState(string key)
        {
            if (string.IsNullOrEmpty(key)) key = "";
            DocState st;
            if (!docStates.TryGetValue(key, out st)) { st = new DocState(); docStates[key] = st; }
            return st;
        }

        /// <summary>
        /// 把「当前文档」切换为 key：先保存旧文档的实时显隐，再（restore=true 时）恢复 key 对应的浮窗/历史显示。
        /// restore=false 用于「正要翻译」的场景——此时无需恢复旧译文，随后会展示本次结果。
        /// </summary>
        static void SetActiveDoc(string key, bool restore)
        {
            key = key ?? "";
            if (string.Equals(key, activeDocKey, StringComparison.Ordinal))
            {
                if (restore) RestoreDocState(key);
                return;
            }
            SaveLiveDocState(activeDocKey);   // 先把旧文档当前是否显示浮窗/历史记下来
            activeDocKey = key;
            lastOrigin = key;
            if (restore) RestoreDocState(key);
        }

        /// <summary>记录指定文档此刻浮窗、历史窗口是否处于显示（切走前调用）。</summary>
        static void SaveLiveDocState(string key)
        {
            DocState st = GetDocState(key);
            st.PopupVisible = popup != null && !popup.IsDisposed && popup.Visible;
            st.HistoryVisible = history != null && !history.IsDisposed && history.Visible;
        }

        /// <summary>按记忆恢复某文档的浮窗与历史窗口显隐；无记忆时隐藏二者（不在新文档上残留上一篇内容）。</summary>
        static void RestoreDocState(string key)
        {
            DocState st = GetDocState(key);
            lastOrigin = key;
            lastSource = st.Source ?? "";
            if (st.PopupVisible && !string.IsNullOrEmpty(st.Source))
            {
                EnsurePopup();
                popup.ShowResultPreserveAnchor(st.Source, st.Result ?? "", st.IsError);
            }
            else if (popup != null && !popup.IsDisposed && popup.Visible)
            {
                popup.HidePopup();
            }
            if (st.HistoryVisible) ShowHistoryWindow();
            else HideHistoryWindow();
        }

        /// <summary>展示了一次结果后，把它记入当前文档的记忆（供切走再切回时恢复）。</summary>
        static void RememberShownResult(string source, string result, bool isError)
        {
            DocState st = GetDocState(activeDocKey);
            st.Source = source ?? "";
            st.Result = result ?? "";
            st.IsError = isError;
            st.PopupVisible = true;
        }

        static void StartDocTabWatch()
        {
            if (docTabTimer == null)
            {
                docTabTimer = new System.Windows.Forms.Timer();
                docTabTimer.Interval = 500;
                docTabTimer.Tick += delegate { PollDocTab(); };
            }
            docTabTimer.Start();
        }

        static void StopDocTabWatch()
        {
            if (docTabTimer != null) docTabTimer.Stop();
        }

        /// <summary>
        /// 轮询前台窗口：仅当目标阅读器（稻壳）处于前台、且其「文档身份」发生变化（切换标签页 / 换 PDF）时，
        /// 让浮窗与历史窗口跟随——切走的文档隐藏、切回的文档恢复。前台非目标进程时不做判定，避免在其它程序误触发。
        /// </summary>
        static void PollDocTab()
        {
            IntPtr h = Native.ForegroundWindow();
            if (h == IntPtr.Zero) return;
            string key = Native.DocumentKeyForWindow(h);
            int bar = key.IndexOf('|');
            string proc = bar >= 0 ? key.Substring(0, bar) : "";
            if (string.IsNullOrEmpty(key) || string.Compare(proc, cfg.DocBoxProcess, true) != 0) return;   // 前台不是目标阅读器
            if (string.Equals(key, activeDocKey, StringComparison.Ordinal)) return;
            Log("文档切换：" + (activeDocKey.Length == 0 ? "(初始)" : Preview(activeDocKey)) + " → " + Preview(key));
            SetActiveDoc(key, true);
        }

        // ---------------- 历史窗口 / 上下文 ----------------

        /// <summary>清空当前会话上下文：自增代次使在途旧请求回写被丢弃；不删除历史记录与已展示译文。</summary>
        static void OnClearContext()
        {
            TranslationContext.Clear();
            Log("已清空上下文（历史记录保留）");
            if (popup != null && !popup.IsDisposed) popup.ShowContextCleared();
            if (tray != null)
                tray.ShowBalloonTip(1500, "上下文",
                    "已清空，后续翻译不再引用此前内容（历史记录仍保留）。", ToolTipIcon.Info);
        }

        static void EnsureHistoryWindow()
        {
            if (history == null || history.IsDisposed)
            {
                history = new HistoryForm(cfg);
                history.FormClosing += OnHistoryClosing;
                history.HiddenByUser += OnHistoryHiddenByUser;
                history.RecordDeleted += OnHistoryRecordDeleted;
            }
        }

        /// <summary>历史窗口删除了某条记录：同步从会话上下文中移除，避免其继续被当作参考。</summary>
        static void OnHistoryRecordDeleted(string id)
        {
            TranslationContext.Remove(id);
            Log("已删除一条历史记录");
        }

        /// <summary>窗口上的 ✕：隐藏（不删数据），并把可见状态同步到配置与菜单勾选。</summary>
        static void OnHistoryHiddenByUser()
        {
            SetHistoryVisible(false);
            Log("历史窗口已隐藏（记录保留）");
        }

        /// <summary>Alt+F4 等关闭操作：改为隐藏，避免直接销毁导致菜单状态不同步。</summary>
        static void OnHistoryClosing(object sender, FormClosingEventArgs e)
        {
            if (e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                SetHistoryVisible(false);
                Log("历史窗口已隐藏（记录保留）");
            }
        }

        /// <summary>查找稻壳主窗口句柄，作为历史窗口的所有者（仅在其之上置顶，不被其它软件覆盖）。</summary>
        static IntPtr FindDocBoxWindow()
        {
            try
            {
                Process[] ps = Process.GetProcessesByName(cfg.DocBoxProcess);
                for (int i = 0; i < ps.Length; i++)
                {
                    IntPtr h = IntPtr.Zero;
                    try { h = ps[i].MainWindowHandle; } catch { }
                    ps[i].Dispose();
                    if (h != IntPtr.Zero) return h;
                }
            }
            catch { }
            return IntPtr.Zero;
        }

        static void ShowHistoryWindow()
        {
            EnsureHistoryWindow();
            history.SetOwnerWindow(FindDocBoxWindow());   // 归属稻壳：只在其之上置顶
            history.EnsureExpanded();                     // 折叠状态不跨显示/隐藏保留
            history.OriginFilter = cfg.IsolateByOrigin ? lastOrigin : "";   // 只展示当前文档产生的记录
            history.RefreshList();
            history.Show();
            history.BringToFront();
        }

        static void HideHistoryWindow()
        {
            if (history != null && !history.IsDisposed) history.Hide();
        }

        /// <summary>
        /// 显示 / 隐藏历史窗口。可见性只作为运行时状态，不再写回配置，重启后也不会自动弹出——
        /// 历史窗口改由翻译浮窗标题栏的「历史」按钮手动开关。
        /// </summary>
        static void SetHistoryVisible(bool visible)
        {
            if (visible) ShowHistoryWindow();
            else HideHistoryWindow();
        }

        static void ToggleHistoryWindow()
        {
            bool visible = history != null && !history.IsDisposed && history.Visible;
            SetHistoryVisible(!visible);
            Log("历史窗口：" + (visible ? "隐藏" : "显示"));
        }

        /// <summary>开关上下文增强翻译：仅影响后续请求是否携带上下文，不清空已累积的上下文。</summary>
        static void ToggleContext()
        {
            cfg.ContextEnable = !cfg.ContextEnable;
            AppConfig.SetValue(cfg.Path, "context_enable", cfg.ContextEnable ? "1" : "0");
            // 浮窗底部的「清空上下文」入口随之显隐：重建浮窗，下次翻译按新配置呈现
            if (popup != null && !popup.IsDisposed) { popup.HidePopup(); popup.Dispose(); popup = null; }
            Log("上下文增强翻译：" + (cfg.ContextEnable ? "开" : "关"));
            if (tray != null)
                tray.ShowBalloonTip(2000, "上下文增强翻译",
                    cfg.ContextEnable
                        ? "已开启：后续支持上下文的翻译（大模型、有道 auto/llm 模式）会参考此前成功翻译的内容。"
                        : "已关闭：后续翻译不再携带历史上下文（已累积的内容保留）。",
                    ToolTipIcon.Info);
        }

        // ---------------- 托盘 ----------------

        static ContextMenuStrip BuildTrayMenu()
        {
            ContextMenuStrip menu = new ContextMenuStrip();
            menu.Items.Add("翻译选中文字（" + cfg.Hotkey + "）", null, delegate { Trigger(true); });
            menu.Items.Add("翻译剪贴板（" + cfg.HotkeyClipboard + "）", null, delegate { Trigger(false); });
            menu.Items.Add("暂存选中文字（" + (string.IsNullOrEmpty(cfg.HotkeyStash) ? "未设置" : cfg.HotkeyStash) + "）",
                null, delegate { StashSelection(); });
            menu.Items.Add("清空暂存文本", null, delegate
            {
                stashText = "";
                RefreshStashBadge();
                Log("已清空暂存文本");
            });
            menu.Items.Add(new ToolStripSeparator());

            ToolStripMenuItem toolbarItem = new ToolStripMenuItem("启用划词工具条");
            toolbarItem.Click += delegate { ToggleToolbar(); };
            toolbarItem.Checked = cfg.ToolbarEnable;
            menu.Items.Add(toolbarItem);
            menu.Opening += delegate { toolbarItem.Checked = cfg.ToolbarEnable; };
            menu.Items.Add(new ToolStripSeparator());

            ToolStripMenuItem ctxItem = new ToolStripMenuItem("启用上下文增强翻译");
            ctxItem.Click += delegate { ToggleContext(); };
            menu.Items.Add(ctxItem);
            menu.Opening += delegate
            {
                ctxItem.Checked = cfg.ContextEnable;
            };
            menu.Items.Add(new ToolStripSeparator());

            ToolStripMenuItem linked = new ToolStripMenuItem("随稻壳自动启动 / 关闭（开机自启）");
            linked.Click += delegate { ToggleLinkedLifecycle(); };
            menu.Items.Add(linked);
            menu.Opening += delegate { linked.Checked = Lifecycle.IsAutostartEnabled(); };

            menu.Items.Add("打开配置界面（命令行）", null, delegate { OpenConfigCli(); });
            menu.Items.Add("打开日志 log.txt", null, delegate { OpenPath(logPath); });
            menu.Items.Add("打开程序目录", null, delegate { OpenPath(baseDir); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("退出", null, delegate { ExitApp(false); });
            return menu;
        }

        /// <summary>打开配置界面：同目录下的 DocBoxTransConfig.exe（控制台程序，交互式修改 config.ini）。</summary>
        static void OpenConfigCli()
        {
            try
            {
                string exe = Path.Combine(baseDir, "DocBoxTransConfig.exe");
                if (!File.Exists(exe))
                {
                    MessageBox.Show("没有找到 DocBoxTransConfig.exe（配置界面）。请先运行 build.ps1 重新构建。",
                        "DocBox 划词翻译", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return;
                }
                Process.Start(exe);
            }
            catch (Exception ex) { Log("打开配置界面失败：" + ex.Message); }
        }

        static void ToggleLinkedLifecycle()
        {
            if (Lifecycle.IsAutostartEnabled())
            {
                Lifecycle.DisableAutostart();
                Lifecycle.StopWatcher();
                Log("已关闭与稻壳的联动（移除开机自启 + 停止守卫）");
                tray.ShowBalloonTip(4000, "已关闭联动",
                    "已取消开机自启并停止守卫进程；翻译工具不再随稻壳自动启动/关闭。", ToolTipIcon.Info);
            }
            else
            {
                Lifecycle.EnableAutostart();
                Lifecycle.StartWatcher();
                Log("已开启与稻壳的联动（写入开机自启 + 启动守卫）");
                tray.ShowBalloonTip(4000, "已开启联动",
                    "已设置开机自启：翻译工具会随稻壳启动而自动打开、随稻壳关闭而自动退出。", ToolTipIcon.Info);
            }
        }

        static void ReloadConfig()
        {
            try
            {
                UnregisterAll();
                StopDocTabWatch();
                cfg = AppConfig.Load(Path.Combine(baseDir, "config.ini"));
                // 配置可能改了目标进程/隔离开关：重置文档跟随状态，按新配置重新跟踪
                docStates.Clear();
                activeDocKey = "";
                if (popup != null && !popup.IsDisposed) { popup.HidePopup(); popup.Dispose(); popup = null; }
                // 历史保存上限随配置更新；历史窗口按新配置（主题/上限）重建，原本可见则恢复显示
                HistoryStore.SetMax(cfg.HistoryMax);
                bool histWasVisible = history != null && !history.IsDisposed && history.Visible;
                if (history != null && !history.IsDisposed)
                {
                    history.FormClosing -= OnHistoryClosing;
                    history.HiddenByUser -= OnHistoryHiddenByUser;
                    history.RecordDeleted -= OnHistoryRecordDeleted;
                    history.Dispose();
                }
                history = null;
                if (histWasVisible) ShowHistoryWindow();
                // 工具条与鼠标钩子按新配置重建
                StopMouseHook();
                StopLocalServer();
                if (toolbar != null && !toolbar.IsDisposed) { toolbar.HideToolbar(); toolbar.Dispose(); }
                toolbar = null;
                StartMouseHook();
                StartLocalServer();
                // only_in_docbox 可能被改过：先按新配置备好稻壳 PID，再决定用钩子还是全局热键
                StartDocBoxPidWatch();
                bool ok = RegisterAll();
                if (docboxTimer != null) { docboxTimer.Stop(); docboxTimer.Dispose(); docboxTimer = null; }
                sawDocBox = false;
                docboxMisses = 0;
                StartLifecycleWatch();
                StartDocTabWatch();
                tray.ContextMenuStrip = BuildTrayMenu();
                tray.ShowBalloonTip(3000, "配置已重新加载",
                    ok ? ("取词热键：" + cfg.Hotkey + "；服务：" + cfg.Service +
                          (cfg.OnlyInDocBox ? "；热键仅在 " + cfg.DocBoxProcess + " 内生效" : ""))
                       : "热键注册失败，请换一个热键", ok ? ToolTipIcon.Info : ToolTipIcon.Warning);
                Log("重新加载配置完成");
            }
            catch (Exception ex)
            {
                Log("重新加载配置失败：" + ex.Message);
            }
        }

        // ---------------- 配置界面保存退出后自动重载 ----------------

        /// <summary>
        /// 创建「配置已改好」的命名事件并登记等待。配置界面是独立进程，保存并正常退出后 Set 该事件，
        /// 这里用 RegisterWaitForSingleObject 阻塞等待：不轮询、空闲时零 CPU 开销；
        /// 收到通知后经 sink 切回 UI 线程再重载配置。
        /// </summary>
        static void StartConfigWatch()
        {
            try
            {
                bool createdNew;
                configReloadEvent = new EventWaitHandle(false, EventResetMode.AutoReset,
                    AppConfig.ReloadEventName, out createdNew);
                configReloadWait = ThreadPool.RegisterWaitForSingleObject(
                    configReloadEvent,
                    delegate(object state, bool timedOut)
                    {
                        sink.Post(delegate
                        {
                            Log("收到配置界面通知，自动重新加载配置");
                            ReloadConfig();
                        });
                    },
                    null, Timeout.Infinite, false);
            }
            catch (Exception ex)
            {
                Log("配置重载通知监听启动失败：" + ex.Message);
            }
        }

        static void OpenPath(string p)
        {
            try { Process.Start("explorer.exe", "\"" + p + "\""); }
            catch (Exception ex) { Log("打开失败：" + ex.Message); }
        }

        /// <summary>
        /// 托盘图标：使用与 Zotero 插件一致的应用图标（已随 exe 内嵌，见 build.ps1 的 /win32icon），
        /// 按通知区域实际尺寸取帧；内嵌图标不可用时退回程序绘制的「译」字圆形图标。
        /// </summary>
        static Icon BuildTrayIcon()
        {
            Size sz = SystemInformation.SmallIconSize;   // 通知区域图标尺寸随 DPI 变化
            // 首选：内嵌的多尺寸图标资源（按尺寸取精确帧，最小尺寸下最清晰）
            try
            {
                Icon res = LoadResourceIcon(sz);
                if (res != null) return res;
            }
            catch (Exception ex) { Log("加载内嵌图标失败，改用 exe 关联图标：" + ex.Message); }
            // 其次：exe 关联图标（/win32icon 内嵌）
            try
            {
                Icon app = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
                if (app != null)
                {
                    Icon sized = new Icon(app, sz);
                    try { app.Dispose(); } catch { }
                    return sized;
                }
            }
            catch (Exception ex) { Log("加载应用图标失败，改用内置图标：" + ex.Message); }
            return BuildFallbackTrayIcon();
        }

        /// <summary>从程序集资源读取内嵌的 DocBoxTrans.ico，并按指定尺寸取帧；不可用时返回 null。</summary>
        static Icon LoadResourceIcon(Size sz)
        {
            System.IO.Stream s = typeof(Program).Assembly.GetManifestResourceStream("DocBoxTrans.ico");
            if (s == null) return null;
            using (s) return new Icon(s, sz);
        }

        /// <summary>兜底托盘图标：程序绘制的「译」字圆形图标。</summary>
        static Icon BuildFallbackTrayIcon()
        {
            try
            {
                Bitmap bmp = new Bitmap(32, 32);
                using (Graphics g = Graphics.FromImage(bmp))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    using (SolidBrush b = new SolidBrush(Color.FromArgb(60, 120, 240)))
                        g.FillEllipse(b, 0, 0, 31, 31);
                    using (Font f = new Font("Microsoft YaHei UI", 15f, FontStyle.Bold))
                    using (SolidBrush w = new SolidBrush(Color.White))
                    using (StringFormat sf = new StringFormat())
                    {
                        sf.Alignment = StringAlignment.Center;
                        sf.LineAlignment = StringAlignment.Center;
                        g.DrawString("译", f, w, new RectangleF(0, 0, 32, 33), sf);
                    }
                }
                return Icon.FromHandle(bmp.GetHicon());
            }
            catch { return SystemIcons.Application; }
        }

        // ---------------- 日志 ----------------

        static string Preview(string s)
        {
            string t = s.Replace("\r\n", " ").Replace("\n", " ").Replace("\r", " ");
            return t.Length <= 60 ? t : t.Substring(0, 60) + "…";
        }

        internal static void Log(string msg)
        {
            try
            {
                FileInfo fi = new FileInfo(logPath);
                if (fi.Exists && fi.Length > 1024 * 1024) File.Delete(logPath);
                File.AppendAllText(logPath,
                    DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + msg + "\r\n",
                    new UTF8Encoding(false));
            }
            catch { }
        }
    }
}