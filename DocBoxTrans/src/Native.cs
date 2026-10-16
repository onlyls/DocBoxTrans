using System;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace DocBoxTrans
{
    /// <summary>Win32 互操作：全局热键、模拟按键、前台窗口、剪贴板轮询。</summary>
    static class Native
    {
        public const int WM_HOTKEY = 0x0312;

        public const uint MOD_ALT = 0x0001;
        public const uint MOD_CONTROL = 0x0002;
        public const uint MOD_SHIFT = 0x0004;
        public const uint MOD_WIN = 0x0008;
        public const uint MOD_NOREPEAT = 0x4000;

        const int VK_SHIFT = 0x10;
        const int VK_CONTROL = 0x11;
        const int VK_MENU = 0x12;   // Alt
        const int VK_LWIN = 0x5B;
        const int VK_C = 0x43;

        const uint KEYEVENTF_KEYUP = 0x0002;

        [DllImport("user32.dll", SetLastError = true)]
        static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

        [DllImport("user32.dll", SetLastError = true)]
        static extern bool UnregisterHotKey(IntPtr hWnd, int id);

        [DllImport("user32.dll")]
        static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

        [DllImport("user32.dll")]
        static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

        [DllImport("user32.dll")]
        static extern short GetAsyncKeyState(int vKey);

        // ---------- 高 DPI ----------

        [DllImport("user32.dll")]
        static extern bool SetProcessDPIAware();

        /// <summary>
        /// 声明进程为 DPI 感知。否则在高 DPI 屏幕上 Windows 会把整窗位图放大，导致文字发虚。
        /// 必须在创建任何窗口/设备上下文之前调用。
        /// </summary>
        public static void MakeDpiAware()
        {
            try { SetProcessDPIAware(); } catch { }
        }

        // ---------- Windows 11：交给 DWM 绘制抗锯齿圆角 ----------

        [DllImport("dwmapi.dll", PreserveSig = true)]
        static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

        const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
        const int DWMWCP_DONOTROUND = 1;
        const int DWMWCP_ROUND = 2;
        const int DWMWCP_ROUNDSMALL = 3;

        /// <summary>DWM 圆角在 96 DPI 下的基准半径（“标准圆角”档）。</summary>
        public const int DwmCornerBaseRadius = 8;

        /// <summary>
        /// 让 DWM 为无边框窗口绘制抗锯齿圆角（Windows 11 起支持），避免用 Region 裁剪产生锯齿。
        /// 成功返回 true，调用方应放弃 Region；失败（Win10 / 调用被拒）返回 false，调用方退回 Region 方案。
        /// 不依赖版本号判断（无清单的进程 Environment.OSVersion 可能被兼容性垫片谎报），直接看返回值即可。
        /// </summary>
        public static bool SetRoundedCorners(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero) return false;
            try
            {
                int pref = DWMWCP_ROUND;
                return DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, ref pref, sizeof(int)) == 0;
            }
            catch { return false; }
        }

        // ---------- 深色滚动条 ----------

        [DllImport("uxtheme.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern int SetWindowTheme(IntPtr hwnd, string pszSubAppName, string pszSubIdList);

        /// <summary>
        /// 把控件的内嵌滚动条等切到深色主题。WinForms（.NET Framework）不自带深色模式，
        /// 深色界面里滚动条仍是浅色底，很刺眼；用 "DarkMode_Explorer" 主题名可让系统按深色绘制
        /// （Win10 1809+ / Win11 生效；不支持时原样返回，不影响功能）。
        /// </summary>
        public static void ApplyScrollTheme(IntPtr hwnd, bool dark)
        {
            if (hwnd == IntPtr.Zero) return;
            try { SetWindowTheme(hwnd, dark ? "DarkMode_Explorer" : "Explorer", null); }
            catch { }
        }

        // ---------- 窗口归属（owner）：让浮窗只在“来源程序”之上置顶 ----------

        [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW", SetLastError = true)]
        static extern IntPtr SetWindowLongPtr64(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

        [DllImport("user32.dll", EntryPoint = "SetWindowLongW", SetLastError = true)]
        static extern int SetWindowLong32(IntPtr hWnd, int nIndex, int dwNewLong);

        [DllImport("user32.dll")]
        static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

        [DllImport("user32.dll")]
        static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        const int GWLP_HWNDPARENT = -8;
        const uint SWP_NOSIZE = 0x0001, SWP_NOMOVE = 0x0002, SWP_NOACTIVATE = 0x0010;
        const int SW_SHOWNOACTIVATE = 4;

        static int ownProcessId;

        /// <summary>当前前台窗口句柄；失败返回 0。</summary>
        public static IntPtr ForegroundWindow()
        {
            try { return GetForegroundWindow(); }
            catch { return IntPtr.Zero; }
        }

        /// <summary>
        /// 当前前台窗口所属进程的 PID（取不到返回 0）。只做两次廉价系统调用（不查进程名），
        /// 因此可以在低级键盘钩子的回调里同步调用——调用方拿它和缓存的 PID 集合比对即可。
        /// </summary>
        public static int ForegroundProcessId()
        {
            try
            {
                IntPtr h = GetForegroundWindow();
                if (h == IntPtr.Zero) return 0;
                uint p;
                GetWindowThreadProcessId(h, out p);
                return (int)p;
            }
            catch { return 0; }
        }

        /// <summary>该窗口是否属于本进程（用于避免把自家窗口当作归属窗口）。</summary>
        public static bool IsOwnWindow(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero) return false;
            try
            {
                if (ownProcessId == 0) ownProcessId = Process.GetCurrentProcess().Id;
                uint pid;
                GetWindowThreadProcessId(hwnd, out pid);
                return pid != 0 && pid == (uint)ownProcessId;
            }
            catch { return false; }
        }

        /// <summary>
        /// 设置窗口的所有者窗口。所有者被激活时本窗口随之在其上方，切换到其它程序时则会被盖住——
        /// 这正是“只在来源程序之上置顶”的效果，比无条件 TopMost 更合适。
        /// </summary>
        public static bool SetOwner(IntPtr hwnd, IntPtr owner)
        {
            if (hwnd == IntPtr.Zero) return false;
            try
            {
                IntPtr ret;
                if (IntPtr.Size == 8) ret = SetWindowLongPtr64(hwnd, GWLP_HWNDPARENT, owner);
                else ret = new IntPtr(SetWindowLong32(hwnd, GWLP_HWNDPARENT, owner.ToInt32()));
                // 返回 0 且无错误码时也可能表示设置成功（原值为 0），故用错误码判定
                if (ret == IntPtr.Zero) return Marshal.GetLastWin32Error() == 0;
                return true;
            }
            catch { return false; }
        }

        /// <summary>
        /// 把窗口插到 target 的紧上方（同一 z 序带内），不激活、不改位置尺寸。
        /// 注意 SetWindowPos 的 hWndInsertAfter 语义是“插到该窗口之下”，所以要传 target 上面那个窗口，
        /// 本窗口才会落在 target 之上；直接传 target 只会把本窗口塞到它下面——工具条被目标窗口盖住即由此而来。
        /// </summary>
        public static bool PlaceAbove(IntPtr hwnd, IntPtr target)
        {
            if (hwnd == IntPtr.Zero || target == IntPtr.Zero) return false;
            try
            {
                IntPtr above = GetWindow(target, GW_HWNDPREV);
                return SetWindowPos(hwnd, above, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            }
            catch { return false; }
        }

        /// <summary>
        /// 以不激活的方式显示窗口（SW_SHOWNOACTIVATE）。WinForms 的 Show() 即便设置了
        /// WS_EX_NOACTIVATE + ShowWithoutActivation，在部分 Windows 版本上仍可能激活窗口、
        /// 把本进程变成前台；这里在 Show() 之后再强制一次，确保显示工具条/浮窗绝不抢前台焦点。
        /// </summary>
        public static void ShowNoActivate(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero) return;
            try { ShowWindow(hwnd, SW_SHOWNOACTIVATE); } catch { }
        }

        const uint GW_OWNER = 4;
        const uint GW_HWNDPREV = 3;

        [DllImport("user32.dll")]
        static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);

        /// <summary>窗口当前的所有者窗口句柄（无则返回 0）；用于诊断“归属是否真正生效”。</summary>
        public static IntPtr GetOwnerWindow(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero) return IntPtr.Zero;
            try { return GetWindow(hwnd, GW_OWNER); }
            catch { return IntPtr.Zero; }
        }

        /// <summary>当前系统 DPI 相对 96 的缩放比（如 150% → 1.5）。DPI 感知后即可拿到真实值。</summary>
        public static float DetectDpiScale()
        {
            try
            {
                using (Graphics g = Graphics.FromHwnd(IntPtr.Zero))
                {
                    float s = g.DpiX / 96f;
                    return s > 0.1f ? s : 1f;
                }
            }
            catch { return 1f; }
        }

        // ---------- 圆角外观（无第三方依赖，用 GraphicsPath 生成 Region） ----------

        /// <summary>构造圆角矩形路径；radius&lt;=0 时退化为普通矩形。</summary>
        public static System.Drawing.Drawing2D.GraphicsPath RoundPath(Rectangle r, int radius)
        {
            System.Drawing.Drawing2D.GraphicsPath p = new System.Drawing.Drawing2D.GraphicsPath();
            int d = radius * 2;
            if (d <= 0 || d > r.Width || d > r.Height) { p.AddRectangle(r); return p; }
            p.AddArc(r.X, r.Y, d, d, 180, 90);
            p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            p.CloseFigure();
            return p;
        }

        /// <summary>把控件裁剪成圆角（尺寸为 0 时跳过），旧的 Region 会被释放。</summary>
        public static void ApplyRound(Control c, int radius)
        {
            if (c.Width <= 0 || c.Height <= 0) return;
            Region old = c.Region;
            using (System.Drawing.Drawing2D.GraphicsPath p =
                RoundPath(new Rectangle(0, 0, c.Width, c.Height), radius))
                c.Region = new Region(p);
            if (old != null) old.Dispose();
        }

        public static bool RegisterHotkey(IntPtr hwnd, int id, uint mods, uint vk)
        {
            // MOD_NOREPEAT 避免长按重复触发
            return RegisterHotKey(hwnd, id, mods | MOD_NOREPEAT, vk);
        }

        public static void UnregisterHotkey(IntPtr hwnd, int id)
        {
            try { UnregisterHotKey(hwnd, id); }
            catch { }
        }

        /// <summary>前台窗口所属进程名（如 DocBox），失败返回 null。</summary>
        public static string ForegroundProcessName()
        {
            IntPtr h = GetForegroundWindow();
            if (h == IntPtr.Zero) return null;
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            if (pid == 0) return null;
            try
            {
                using (Process p = Process.GetProcessById((int)pid))
                    return p.ProcessName;
            }
            catch { return null; }
        }

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);

        /// <summary>窗口标题（用于诊断前台窗口到底是谁），失败返回 "(无)"。</summary>
        public static string WindowTitle(IntPtr h)
        {
            if (h == IntPtr.Zero) return "(无)";
            try
            {
                System.Text.StringBuilder sb = new System.Text.StringBuilder(256);
                GetWindowText(h, sb, 256);
                string t = sb.ToString();
                return t.Length == 0 ? "(无标题)" : t;
            }
            catch { return "(无)"; }
        }

        /// <summary>前台窗口的「文档身份」键（见 <see cref="DocumentKeyForWindow"/>）。</summary>
        public static string ForegroundDocumentKey()
        {
            return DocumentKeyForWindow(GetForegroundWindow());
        }

        /// <summary>
        /// 指定窗口的「文档身份」键：进程名 + 规范化窗口标题（形如 "DocBox|xxx.pdf … 稻壳阅读器"）。
        /// 用作「按文档隔离上下文 / 历史去重」以及「按标签页跟随显隐」的维度；
        /// 标题取不到（无标题/失败）时返回空串（未知来源，退化为全局）。
        /// </summary>
        public static string DocumentKeyForWindow(IntPtr h)
        {
            if (h == IntPtr.Zero) return "";
            string proc = null;
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            if (pid != 0)
            {
                try { using (Process p = Process.GetProcessById((int)pid)) proc = p.ProcessName; }
                catch { proc = null; }
            }
            string title = WindowTitle(h);   // 可能返回占位串 "(无标题)"/"(无)"
            if (title == "(无标题)" || title == "(无)") title = "";
            title = CollapseSpace(title);
            if (string.IsNullOrEmpty(proc) && title.Length == 0) return "";
            return (proc ?? "") + "|" + title;
        }

        /// <summary>把连续空白折叠为单个空格并去掉首尾空白。</summary>
        static string CollapseSpace(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            System.Text.StringBuilder sb = new System.Text.StringBuilder(s.Length);
            bool ws = false;
            for (int i = 0; i < s.Length; i++)
            {
                char c = s[i];
                if (char.IsWhiteSpace(c)) { if (!ws) sb.Append(' '); ws = true; }
                else { sb.Append(c); ws = false; }
            }
            return sb.ToString().Trim();
        }

        /// <summary>等待修饰键（Alt/Ctrl/Shift/Win）松开，避免和模拟的 Ctrl+C 冲突。</summary>
        public static void WaitModifiersReleased(int timeoutMs)
        {
            int[] keys = new int[] { VK_MENU, VK_CONTROL, VK_SHIFT, VK_LWIN };
            int waited = 0;
            while (waited < timeoutMs)
            {
                bool down = false;
                for (int i = 0; i < keys.Length; i++)
                {
                    if ((GetAsyncKeyState(keys[i]) & 0x8000) != 0) { down = true; break; }
                }
                if (!down) break;
                Thread.Sleep(15);
                waited += 15;
            }
            Thread.Sleep(40);
        }

        /// <summary>向当前前台窗口发送 Ctrl+C。</summary>
        public static void SendCtrlC()
        {
            keybd_event((byte)VK_CONTROL, 0, 0, UIntPtr.Zero);
            Thread.Sleep(15);
            keybd_event((byte)VK_C, 0, 0, UIntPtr.Zero);
            Thread.Sleep(25);
            keybd_event((byte)VK_C, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
            Thread.Sleep(15);
            keybd_event((byte)VK_CONTROL, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
        }

        // ---------- 剪贴板（带重试，剪贴板可能被其它进程短暂占用） ----------

        public static string GetClipboardText()
        {
            for (int i = 0; i < 12; i++)
            {
                try
                {
                    if (Clipboard.ContainsText()) return Clipboard.GetText();
                    return null;
                }
                catch { Thread.Sleep(25); }
            }
            return null;
        }

        public static bool SetClipboardText(string text)
        {
            for (int i = 0; i < 12; i++)
            {
                try
                {
                    if (text == null) { Clipboard.Clear(); return true; }
                    Clipboard.SetText(text);
                    return true;
                }
                catch { Thread.Sleep(25); }
            }
            return false;
        }

        /// <summary>清空剪贴板（用于取词后保持剪贴板干净）。</summary>
        public static void ClearClipboard()
        {
            SetClipboardText(null);
        }

        /// <summary>发送 Ctrl+C 后轮询剪贴板，等待内容发生变化。</summary>
        public static string WaitClipboardTextChanged(string before, int timeoutMs)
        {
            int waited = 0;
            while (waited < timeoutMs)
            {
                string cur = GetClipboardText();
                if (!string.IsNullOrEmpty(cur) && cur != before) return cur;
                Thread.Sleep(25);
                waited += 25;
            }
            return null;
        }
    }

    /// <summary>只用来接收 WM_HOTKEY 的不可见消息窗口，同时充当“把结果切回 UI 线程”的投递目标。</summary>
    class HotkeySink : NativeWindow
    {
        const int WM_APP_RUN = 0x8001; // WM_APP + 1

        [DllImport("user32.dll", CharSet = CharSet.Auto)]
        static extern bool PostMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

        readonly System.Collections.Generic.Queue<Action> pending =
            new System.Collections.Generic.Queue<Action>();

        public event Action<int> HotkeyPressed;

        public HotkeySink()
        {
            CreateParams cp = new CreateParams();
            cp.Parent = (IntPtr)(-3); // HWND_MESSAGE：消息窗口，不参与界面
            CreateHandle(cp);
        }

        /// <summary>线程安全地把一段代码投递到 UI 线程执行。</summary>
        public void Post(Action action)
        {
            if (action == null) return;
            lock (pending) pending.Enqueue(action);
            PostMessage(Handle, WM_APP_RUN, IntPtr.Zero, IntPtr.Zero);
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == Native.WM_HOTKEY)
            {
                Action<int> h = HotkeyPressed;
                if (h != null) h(m.WParam.ToInt32());
                return;
            }
            if (m.Msg == WM_APP_RUN)
            {
                Action action = null;
                lock (pending) { if (pending.Count > 0) action = pending.Dequeue(); }
                if (action != null)
                {
                    try { action(); }
                    catch { }
                }
                return;
            }
            base.WndProc(ref m);
        }
    }

    /// <summary>
    /// 全局低级鼠标钩子：仅用于判断“鼠标拖拽（划词）结束”，事件在安装钩子的 UI 线程回调。
    /// 回调内绝不阻塞，且始终 CallNextHookEx，不影响正常输入。
    /// </summary>
    class MouseHook : IDisposable
    {
        const int WH_MOUSE_LL = 14;
        const int WM_LBUTTONDOWN = 0x0201;
        const int WM_LBUTTONUP = 0x0202;

        delegate IntPtr LowLevelMouseProc(int nCode, IntPtr wParam, IntPtr lParam);

        [StructLayout(LayoutKind.Sequential)]
        struct POINT { public int x; public int y; }

        [StructLayout(LayoutKind.Sequential)]
        struct MSLLHOOKSTRUCT
        {
            public POINT pt;
            public uint mouseData;
            public uint flags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
        static extern IntPtr SetWindowsHookEx(int idHook, LowLevelMouseProc lpfn, IntPtr hMod, uint dwThreadId);

        [DllImport("user32.dll", SetLastError = true)]
        static extern bool UnhookWindowsHookEx(IntPtr hhk);

        [DllImport("user32.dll")]
        static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("kernel32.dll", CharSet = CharSet.Auto)]
        static extern IntPtr GetModuleHandle(string lpModuleName);

        // 必须持有委托，否则会被 GC 回收导致钩子失效
        readonly LowLevelMouseProc proc;
        IntPtr hookId = IntPtr.Zero;

        public event Action<Point> LeftDown;
        public event Action<Point> LeftUp;

        public MouseHook()
        {
            proc = HookCallback;
        }

        public bool Install()
        {
            if (hookId != IntPtr.Zero) return true;
            hookId = SetWindowsHookEx(WH_MOUSE_LL, proc, GetModuleHandle(null), 0);
            return hookId != IntPtr.Zero;
        }

        public void Uninstall()
        {
            if (hookId != IntPtr.Zero)
            {
                UnhookWindowsHookEx(hookId);
                hookId = IntPtr.Zero;
            }
        }

        IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0)
            {
                int msg = wParam.ToInt32();
                if (msg == WM_LBUTTONDOWN || msg == WM_LBUTTONUP)
                {
                    MSLLHOOKSTRUCT info = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
                    Point pt = new Point(info.pt.x, info.pt.y);
                    try
                    {
                        if (msg == WM_LBUTTONDOWN)
                        {
                            Action<Point> h = LeftDown;
                            if (h != null) h(pt);
                        }
                        else
                        {
                            Action<Point> h = LeftUp;
                            if (h != null) h(pt);
                        }
                    }
                    catch { }
                }
            }
            return CallNextHookEx(hookId, nCode, wParam, lParam);
        }

        public void Dispose()
        {
            Uninstall();
        }
    }

    /// <summary>
    /// 全局低级键盘钩子。
    ///
    /// 为什么不用 RegisterHotKey：RegisterHotKey 是“系统级独占”的，一旦注册，这个组合键就被
    /// 操作系统直接从输入流里拿走了，任何其它程序（比如浏览器里的划词翻译插件）都再也收不到它。
    /// 事后在事件处理里判断“前台是不是目标程序”已经太晚——按键早就被吞了。
    ///
    /// 低级钩子允许我们在按键**传递之前**同步判断：目标程序在前台 → 拦截并触发本工具；
    /// 否则原样 CallNextHookEx 放行，其它程序的同名快捷键完全不受影响。
    ///
    /// 注意：低级钩子回调有约 300ms 的超时限制，回调里只做极轻量的判断（比较 vk、查修饰键、
    /// 两次系统调用判断前台进程），真正的处理逻辑由调用方投递到 UI 线程执行。
    /// </summary>
    class KeyboardHook : IDisposable
    {
        const int WH_KEYBOARD_LL = 13;
        const int WM_KEYDOWN = 0x0100;
        const int WM_KEYUP = 0x0101;
        const int WM_SYSKEYDOWN = 0x0104;
        const int WM_SYSKEYUP = 0x0105;
        // 由系统（keybd_event / SendInput）注入的按键，绝不能被本钩子吞掉：
        // 否则本工具模拟的 Ctrl+C 会被当作热键的自动重复而丢弃，导致取词失败。
        const uint LLKHF_INJECTED = 0x10;

        // 虚拟键：修饰键
        const int VK_SHIFT = 0x10, VK_CONTROL = 0x11, VK_MENU = 0x12, VK_LWIN = 0x5B, VK_RWIN = 0x5C;

        delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

        [StructLayout(LayoutKind.Sequential)]
        struct KBDLLHOOKSTRUCT
        {
            public uint vkCode;
            public uint scanCode;
            public uint flags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
        static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);

        [DllImport("user32.dll", SetLastError = true)]
        static extern bool UnhookWindowsHookEx(IntPtr hhk);

        [DllImport("user32.dll")]
        static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("kernel32.dll", CharSet = CharSet.Auto)]
        static extern IntPtr GetModuleHandle(string lpModuleName);

        [DllImport("user32.dll")]
        static extern short GetAsyncKeyState(int vKey);

        /// <summary>一个待监听的热键：id 用于回调区分，Mods/Vk 与 AppConfig 里解析出来的一致。</summary>
        public sealed class Binding
        {
            public int Id;
            public uint Mods;
            public uint Vk;
            internal bool SwallowedDown;
        }

        /// <summary>要监听的热键列表。可在安装期间随时替换。</summary>
        public Binding[] Bindings = new Binding[0];

        /// <summary>
        /// 回调里同步判断“这一组按键此刻是否应该由我们拦截”。
        /// 必须非常快（低级钩子超时约 300ms），返回 false 则按键原样放行。
        /// </summary>
        public Func<int, bool> ShouldHandle;

        /// <summary>命中了某个热键（且决定拦截）时触发。回调内只应做投递，不要做耗时操作。</summary>
        public event Action<int> HotkeyPressed;

        // 必须持有委托，否则会被 GC 回收导致钩子失效
        readonly LowLevelKeyboardProc proc;
        IntPtr hookId = IntPtr.Zero;

        public KeyboardHook() { proc = HookCallback; }

        public bool Installed { get { return hookId != IntPtr.Zero; } }

        public bool Install()
        {
            if (hookId != IntPtr.Zero) return true;
            hookId = SetWindowsHookEx(WH_KEYBOARD_LL, proc, GetModuleHandle(null), 0);
            return hookId != IntPtr.Zero;
        }

        public void Uninstall()
        {
            if (hookId != IntPtr.Zero)
            {
                UnhookWindowsHookEx(hookId);
                hookId = IntPtr.Zero;
            }
            for (int i = 0; i < Bindings.Length; i++) Bindings[i].SwallowedDown = false;
        }

        IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0)
            {
                int msg = wParam.ToInt32();
                bool down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
                bool up = msg == WM_KEYUP || msg == WM_SYSKEYUP;
                if (down || up)
                {
                    KBDLLHOOKSTRUCT info = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
                    uint vk = info.vkCode;
                    // 注入的按键（含本工具模拟的 Ctrl+C）一律放行，不参与热键拦截与自动重复吞键
                    if ((info.flags & LLKHF_INJECTED) != 0)
                        return CallNextHookEx(hookId, nCode, wParam, lParam);
                    for (int i = 0; i < Bindings.Length; i++)
                    {
                        Binding b = Bindings[i];
                        if (b.Vk != vk) continue;

                        if (down)
                        {
                            if (b.SwallowedDown) return (IntPtr)1;   // 长按自动重复：吞掉但不再重复触发
                            // 修饰键不符（或此刻不在目标范围内）→ 本条不处理，继续看有没有别的同键位绑定
                            if (CurrentMods() != b.Mods) { b.SwallowedDown = false; continue; }
                            Func<int, bool> f = ShouldHandle;
                            if (f != null && !f(b.Id)) { b.SwallowedDown = false; continue; }
                            b.SwallowedDown = true;
                            Action<int> h = HotkeyPressed;
                            if (h != null) { try { h(b.Id); } catch { } }
                            return (IntPtr)1;                        // 拦截：不再传给前台程序
                        }

                        // keyup：凡是按下时被我们吞掉的，抬起也要一起吞，避免目标程序收到悬空的按键抬起
                        if (b.SwallowedDown) { b.SwallowedDown = false; return (IntPtr)1; }
                    }
                }
            }
            return CallNextHookEx(hookId, nCode, wParam, lParam);
        }

        /// <summary>当前按下的修饰键集合。</summary>
        static uint CurrentMods()
        {
            uint m = 0;
            if (Down(VK_CONTROL)) m |= Native.MOD_CONTROL;
            if (Down(VK_MENU)) m |= Native.MOD_ALT;
            if (Down(VK_SHIFT)) m |= Native.MOD_SHIFT;
            if (Down(VK_LWIN) || Down(VK_RWIN)) m |= Native.MOD_WIN;
            return m;
        }

        static bool Down(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }

        public void Dispose() { Uninstall(); }
    }
}