using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace DocBoxTrans
{
    /// <summary>
    /// 结果浮窗：无边框、圆角、置顶、不抢焦点（这样划词选区不会被清掉，可以连续翻译）。
    /// 视觉参考 STranslate / Pot 的弹窗卡片：分区小标题、层次化排版、圆角胶囊分段控件与图标按钮。
    /// 支持：拖动标题区移动、右下角抓手缩放、底部切换翻译服务。
    /// 由于窗口不激活，移动/缩放/点击均以“不抢焦点”的方式手动实现。
    /// 所有尺寸常量按屏幕 DPI 缩放，保证高 DPI 下文字与布局同样清晰、比例一致。
    /// </summary>
    class PopupForm : Form
    {
        // ---------------- 设计基准尺寸（96 DPI） ----------------
        // 圆角半径与 Win11 DWM 的“标准圆角”对齐（都是 8dip），这样自绘的边框不会超出 DWM 圆角而被削掉。
        const int R_Radius = Native.DwmCornerBaseRadius, R_Pad = 14, R_HeaderH = 28, R_CapH = 16, R_SourceH = 34, R_FooterH = 34;
        const int R_G1 = 6, R_G2 = 8, R_G3 = 10, R_G4 = 12, R_DivH = 1;
        const int R_Close = 24, R_ChipW = 48, R_ChipH = 24, R_TrackPad = 2, R_CopyW = 80, R_CopyH = 28;
        // 底部引擎胶囊变多后，最小宽度需保证「胶囊行 + 状态 + 复制按钮」不重叠
        const int R_MinW = 450, R_MaxW = 920, R_MinH = 150, R_MaxH = 760;
        // 底部胶囊行固定最多同时显示 3 个服务；超过 3 个时用滚轮或按住左键拖动切换显示
        const int R_VisibleChips = 3;
        // 展开原文后原文区的最大高度（逻辑像素），超出则在原文区内上下滚动，不挤占译文区
        const int R_SourceMaxH = 240;

        // 顶部一行服务行显示哪些服务由配置 enabled_services 决定，用户也可在左上角标题下拉里勾选调整
        static readonly string[] AllServiceIds = AppConfig.KnownServices;
        const string AppName = "DocBoxTrans";

        // 已按 DPI 换算后的实际尺寸
        readonly float S;
        readonly int Radius, Pad, HeaderH, CapH, SourceH, SourceMaxH, FooterH, G1, G2, G3, G4, DivH;
        readonly int CloseSize, ChipH, TrackPad, CopyW, CopyH, GripSize;
        readonly int MinW, MaxW, MinH, MaxH;

        // ---------------- 调色板 ----------------
        Color cBg, cBorder, cFg, cMuted, cFaint, cAccent, cAccentHi, cTrack, cDivider, cHover, cDanger, cMenu;

        readonly AppConfig cfg;

        Label lblTitle, lblLang, lblSrcCap, lblSource, lblResCap, lblStatus;
        RoundLabel btnClose, btnHistory, track, btnCopy, btnClearCtx;
        Panel sep;
        TextBox txtResult, txtSource;
        RoundLabel[] serviceLabels;
        // 当前要显示在底部胶囊行的服务 id 列表（顺序按 AppConfig.KnownServices）
        List<string> enabledIds;
        // 底部胶囊的统一宽度（按最长服务名自适应，已按 DPI 换算）
        int chipW;
        // 底部胶囊行的横向滚动偏移（仅在服务数超过 R_VisibleChips 时可能非 0）
        int chipScrollOffset;
        // 按住左键拖动胶囊行时的状态：区分「点按切换服务」与「拖动滚动」
        bool chipDragActive, chipDragMoved;
        Point chipDragStartCursor;
        int chipDragStartOffset;
        // 左上角点按标题弹出的服务勾选菜单
        MenuPanel menuPanel;
        MenuRow[] menuRows;
        bool dwmCorners;
        // 本次会话是否已成功显示过一次浮窗。首次创建时句柄尚未稳定，跨进程设置所有者可能不生效，
        // 若此时改用“归属式 z 序”会把窗口压到稻壳之下而看不见；因此首次显示一律置顶保证可见。
        bool everShown;
        // 原文展开状态：默认折叠，只显示两行预览；展开后在原文区内显示全文并可按需滚动
        bool sourceExpanded;
        string fullSource = "";
        // 触发本次翻译时所在的前台窗口：浮窗以它为所有者，只在其上方浮起
        IntPtr sourceHwnd;
        Timer animTimer, closeTimer;
        int animStep;
        bool busy;
        Point anchor;

        string currentService;

        bool dragging, resizing;
        Point dragOffset;
        // 标题区按下时的标记：用于区分「点按标题」与「拖动标题移动窗口」（释放时按位移判定）
        bool titlePressed;
        Point titleDownPos;
        Point resizeStartCursor;
        Size resizeStartSize;
        bool userMoved;
        // 用户拖动调整后的浮窗宽度（逻辑像素）：会写回配置（popup_width），下次启动沿用。
        int widthLogical;
        // 用户是否「显式拖高」过浮窗：钉住后译文区高度不再随内容自适应。
        // 只在本会话内有效，不写配置——高度本就应当随译文多少在合理范围内变化。
        bool heightPinned;
        int pinnedResultH;
        // 右下角缩放抓手：作为最顶层子控件接收鼠标，避免被文本框/按钮等子控件盖住而点不到
        ResizeGrip grip;

        /// <summary>用户点按底部服务标签切换引擎时触发，参数为服务 id（llm/google/bing/tencent/youdao/cnki）。</summary>
        public event Action<string> ServiceChanged;

        /// <summary>用户点按「清空上下文」时触发；由调用方执行 TranslationContext.Clear()。</summary>
        public event Action ClearContextRequested;

        /// <summary>用户点按标题栏「历史」时触发；由调用方打开/关闭翻译历史窗口。</summary>
        public event Action HistoryToggleRequested;

        public PopupForm(AppConfig config)
        {
            cfg = config;
            currentService = string.IsNullOrEmpty(cfg.Service) ? "llm" : cfg.Service.ToLowerInvariant();
            enabledIds = new List<string>(cfg.EnabledServiceList());

            S = Native.DetectDpiScale();
            Radius = Px(R_Radius); Pad = Px(R_Pad); HeaderH = Px(R_HeaderH); CapH = Px(R_CapH);
            SourceH = Px(R_SourceH); SourceMaxH = Px(R_SourceMaxH); FooterH = Px(R_FooterH);
            G1 = Px(R_G1); G2 = Px(R_G2); G3 = Px(R_G3); G4 = Px(R_G4); DivH = Px(R_DivH);
            CloseSize = Px(R_Close); ChipH = Px(R_ChipH); TrackPad = Px(R_TrackPad);
            CopyW = Px(R_CopyW); CopyH = Px(R_CopyH); GripSize = Px(16);
            MinW = Px(R_MinW); MaxW = Px(R_MaxW); MinH = Px(R_MinH); MaxH = Px(R_MaxH);
            // 浮窗宽度来自配置；用户拖拽调整后会写回，实现「记忆上次的宽度」
            widthLogical = cfg.PopupWidth;

            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            // 不再无条件置顶：以“来源程序”为所有者，只在该程序之上浮起，切到别的软件会被盖住
            TopMost = false;
            StartPosition = FormStartPosition.Manual;
            KeyPreview = true;
            AutoScaleMode = AutoScaleMode.None;   // 手动按 DPI 缩放，避免 WinForms 再叠加一层
            // ResizeRedraw 保证窗口尺寸变化时整窗重绘，避免旧内容（如缩放抓手）残留在中间。
            SetStyle(ControlStyles.ResizeRedraw | ControlStyles.AllPaintingInWmPaint
                | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer, true);

            BuildPalette();

            lblTitle = new Label();
            // 标题兼作下拉入口：点按弹出服务勾选菜单（▼ 提示可展开）
            lblTitle.Text = AppName + " ▼";
            lblTitle.ForeColor = cFg;
            lblTitle.BackColor = cBg;
            lblTitle.Font = new Font("Microsoft YaHei UI", 9.5f, FontStyle.Bold);
            lblTitle.AutoSize = false;
            lblTitle.TextAlign = ContentAlignment.MiddleLeft;
            lblTitle.Cursor = Cursors.Hand;
            lblTitle.MouseDown += delegate(object s, MouseEventArgs me)
            {
                if (me.Button != MouseButtons.Left) return;
                titlePressed = true; titleDownPos = Cursor.Position; StartDrag();
            };
            lblTitle.MouseEnter += delegate { if (menuPanel == null || !menuPanel.Visible) lblTitle.ForeColor = cAccent; };
            lblTitle.MouseLeave += delegate { if (menuPanel == null || !menuPanel.Visible) lblTitle.ForeColor = cFg; };

            lblLang = new Label();
            lblLang.Text = "自动 → " + LangShort(cfg.TargetLang);
            lblLang.ForeColor = cMuted;
            lblLang.BackColor = cBg;
            lblLang.Font = new Font("Microsoft YaHei UI", 8.5f);
            lblLang.AutoSize = false;
            lblLang.TextAlign = ContentAlignment.MiddleRight;

            btnClose = new RoundLabel();
            btnClose.Radius = Px(6);
            btnClose.Surround = cBg;
            btnClose.FillColor = Color.Transparent;   // 常态与卡片底色一致
            btnClose.Text = "✕";
            btnClose.ForeColor = cMuted;
            btnClose.Font = new Font("Segoe UI", 9.5f);
            btnClose.Align = ContentAlignment.MiddleCenter;
            btnClose.Cursor = Cursors.Hand;
            btnClose.Click += delegate { HidePopup(); };
            btnClose.MouseEnter += delegate { btnClose.FillColor = cDanger; btnClose.ForeColor = Color.White; };
            btnClose.MouseLeave += delegate { btnClose.FillColor = Color.Transparent; btnClose.ForeColor = cMuted; };

            // 「历史」：标题栏内的历史窗口开关（替代原来的托盘右键菜单项）
            btnHistory = new RoundLabel();
            btnHistory.Radius = Px(6);
            btnHistory.Surround = cBg;
            btnHistory.FillColor = cTrack;
            btnHistory.Text = "历史";
            btnHistory.ForeColor = cMuted;
            btnHistory.Font = new Font("Microsoft YaHei UI", 8.5f);
            btnHistory.Align = ContentAlignment.MiddleCenter;
            btnHistory.Cursor = Cursors.Hand;
            btnHistory.Click += delegate
            {
                Action h = HistoryToggleRequested;
                if (h != null) h();
            };
            btnHistory.MouseEnter += delegate { btnHistory.FillColor = cHover; btnHistory.ForeColor = cFg; };
            btnHistory.MouseLeave += delegate { btnHistory.FillColor = cTrack; btnHistory.ForeColor = cMuted; };

            lblSrcCap = MakeCaption("原文");
            lblSrcCap.Cursor = Cursors.Hand;
            lblSrcCap.Click += delegate { ToggleSource(); };   // 点“原文”小标题可展开 / 收起
            lblResCap = MakeCaption("译文");

            lblSource = new Label();
            lblSource.ForeColor = cMuted;
            lblSource.BackColor = cBg;
            lblSource.Font = new Font("Microsoft YaHei UI", 9f);
            lblSource.AutoSize = false;
            lblSource.AutoEllipsis = false;   // 交给自动换行显示两行，超出部分由 Compact() 截断
            lblSource.TextAlign = ContentAlignment.TopLeft;
            lblSource.Cursor = Cursors.Hand;
            lblSource.Click += delegate { if (!sourceExpanded) ToggleSource(); };   // 点两行预览即展开

            // 展开态：在原文区内显示全文，过长时本区内部纵向滚动（不挤占译文区）
            txtSource = new TextBox();
            txtSource.Multiline = true;
            txtSource.ReadOnly = true;
            txtSource.BorderStyle = BorderStyle.None;
            txtSource.BackColor = cBg;
            txtSource.ForeColor = cMuted;
            txtSource.Font = new Font("Microsoft YaHei UI", 9f);
            txtSource.WordWrap = true;
            txtSource.ShortcutsEnabled = true;
            txtSource.TabStop = false;
            txtSource.Visible = false;

            sep = new Panel();
            sep.BackColor = cDivider;

            txtResult = new TextBox();
            txtResult.Multiline = true;
            txtResult.ReadOnly = true;
            txtResult.BorderStyle = BorderStyle.None;
            txtResult.ScrollBars = ScrollBars.Vertical;
            txtResult.BackColor = cBg;
            txtResult.ForeColor = cFg;
            txtResult.Font = new Font("Microsoft YaHei UI", cfg.FontSize);
            txtResult.WordWrap = true;
            txtResult.ShortcutsEnabled = true;
            txtResult.TabStop = false;

            // 深色主题下把内嵌滚动条也切到深色，避免浅色滚动条与卡片底色不协调
            txtSource.HandleCreated += delegate { Native.ApplyScrollTheme(txtSource.Handle, cfg.DarkTheme); };
            txtResult.HandleCreated += delegate { Native.ApplyScrollTheme(txtResult.Handle, cfg.DarkTheme); };

            // 底部：圆角胶囊分段控件（引擎切换）
            track = new RoundLabel();
            track.Radius = Px(8);
            track.Surround = cBg;
            track.FillColor = cTrack;
            // 服务数超过可视数量时，在胶囊行的空隙上滚动滚轮也能切换显示
            track.MouseWheel += OnServiceWheel;

            // 底部胶囊按「已启用服务」动态生成（数量随用户勾选变化）
            RebuildServiceChips();

            btnCopy = new RoundLabel();
            btnCopy.Radius = Px(8);
            btnCopy.Surround = cBg;
            btnCopy.FillColor = cAccent;
            btnCopy.Text = "复制译文";
            btnCopy.ForeColor = Color.White;
            btnCopy.Font = new Font("Microsoft YaHei UI", 9f);
            btnCopy.Align = ContentAlignment.MiddleCenter;
            btnCopy.Cursor = Cursors.Hand;
            btnCopy.Click += delegate { CopyResult(); };
            btnCopy.MouseEnter += delegate { btnCopy.FillColor = cAccentHi; };
            btnCopy.MouseLeave += delegate { btnCopy.FillColor = cAccent; };

            // 「清空上下文」：仅当上下文增强开启时显示（配置关闭时隐藏且不占位）
            btnClearCtx = new RoundLabel();
            btnClearCtx.Radius = Px(6);
            btnClearCtx.Surround = cBg;
            btnClearCtx.FillColor = cTrack;
            btnClearCtx.Text = "清空上下文";
            btnClearCtx.ForeColor = cMuted;
            btnClearCtx.Font = new Font("Microsoft YaHei UI", 8.5f);
            btnClearCtx.Align = ContentAlignment.MiddleCenter;
            btnClearCtx.Cursor = Cursors.Hand;
            btnClearCtx.Visible = cfg.ContextEnable;
            btnClearCtx.Click += delegate
            {
                Action h = ClearContextRequested;
                if (h != null) h();
            };
            btnClearCtx.MouseEnter += delegate { btnClearCtx.FillColor = cHover; btnClearCtx.ForeColor = cFg; };
            btnClearCtx.MouseLeave += delegate { btnClearCtx.FillColor = cTrack; btnClearCtx.ForeColor = cMuted; };

            lblStatus = new Label();
            lblStatus.ForeColor = cMuted;
            lblStatus.BackColor = cBg;
            lblStatus.Font = new Font("Microsoft YaHei UI", 8.5f);
            lblStatus.AutoSize = false;
            lblStatus.TextAlign = ContentAlignment.MiddleLeft;

            Controls.Add(lblTitle);
            Controls.Add(lblLang);
            Controls.Add(btnClose);
            Controls.Add(btnHistory);
            Controls.Add(lblSrcCap);
            Controls.Add(lblSource);
            Controls.Add(txtSource);
            Controls.Add(sep);
            Controls.Add(lblResCap);
            Controls.Add(txtResult);
            Controls.Add(track);
            Controls.Add(btnClearCtx);
            Controls.Add(lblStatus);
            Controls.Add(btnCopy);

            // 右下角缩放抓手：最后加入并置于最上层，保证不被任何子控件遮挡（否则缩放会失效）
            grip = new ResizeGrip();
            grip.Surround = cBg;
            grip.LineColor = cFaint;
            grip.Inset = Px(4);
            grip.Step = Px(4);
            grip.MouseDown += delegate(object s, MouseEventArgs me) { if (me.Button == MouseButtons.Left) BeginResize(); };
            grip.MouseMove += delegate { if (resizing) UpdateResize(); };
            grip.MouseUp += delegate { if (resizing) FinishResize(); };
            Controls.Add(grip);

            // 服务勾选菜单：最后加入（z 序最上），默认隐藏，点按标题时弹出
            BuildMenu();

            animTimer = new Timer();
            animTimer.Interval = 90;
            animTimer.Tick += delegate
            {
                animStep++;
                string[] frames = new string[] { "翻译中", "翻译中 ·", "翻译中 ··", "翻译中 ···" };
                if (busy)
                {
                    lblStatus.Text = frames[animStep % frames.Length];
                    Invalidate(new Rectangle(0, Height - Px(8), Width, Px(8)), false);
                }
            };

            closeTimer = new Timer();
            closeTimer.Tick += delegate { HidePopup(); };

            SetEngineDisplay(currentService);
            UpdateSourceToggle();   // 初始为折叠态：小标题带展开提示、按钮为“复制译文”
        }

        int Px(int v) { return (int)Math.Round(v * S); }

        void BuildPalette()
        {
            if (cfg.DarkTheme)
            {
                cBg = Color.FromArgb(30, 31, 36);
                cBorder = Color.FromArgb(58, 60, 70);
                cFg = Color.FromArgb(236, 237, 241);
                cMuted = Color.FromArgb(152, 154, 164);
                cFaint = Color.FromArgb(116, 118, 128);
                cAccent = Color.FromArgb(64, 132, 255);
                cAccentHi = Color.FromArgb(88, 150, 255);
                cTrack = Color.FromArgb(43, 45, 52);
                cDivider = Color.FromArgb(46, 48, 56);
                cHover = Color.FromArgb(54, 56, 65);
                cDanger = Color.FromArgb(214, 58, 63);
                cMenu = Color.FromArgb(38, 40, 46);
            }
            else
            {
                cBg = Color.FromArgb(255, 255, 255);
                cBorder = Color.FromArgb(226, 228, 234);
                cFg = Color.FromArgb(32, 34, 40);
                cMuted = Color.FromArgb(112, 115, 126);
                cFaint = Color.FromArgb(152, 155, 165);
                cAccent = Color.FromArgb(47, 107, 255);
                cAccentHi = Color.FromArgb(70, 124, 255);
                cTrack = Color.FromArgb(243, 244, 248);
                cDivider = Color.FromArgb(235, 236, 241);
                cHover = Color.FromArgb(233, 235, 242);
                cDanger = Color.FromArgb(224, 62, 68);
                cMenu = Color.FromArgb(255, 255, 255);
            }
        }

        Label MakeCaption(string text)
        {
            Label l = new Label();
            l.Text = text;
            l.ForeColor = cFaint;
            l.BackColor = cBg;
            l.Font = new Font("Microsoft YaHei UI", 8f);
            l.AutoSize = false;
            l.TextAlign = ContentAlignment.BottomLeft;
            return l;
        }

        static string LangShort(string code)
        {
            if (string.IsNullOrEmpty(code)) return "中文";
            string c = code.ToLowerInvariant();
            if (c.StartsWith("zh")) return "中文";
            if (c.StartsWith("en")) return "英语";
            if (c.StartsWith("ja")) return "日语";
            if (c.StartsWith("ko")) return "韩语";
            if (c.StartsWith("fr")) return "法语";
            if (c.StartsWith("de")) return "德语";
            if (c.StartsWith("ru")) return "俄语";
            return code;
        }

        protected override bool ShowWithoutActivation
        {
            get { return true; }
        }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= 0x08000000; // WS_EX_NOACTIVATE：不抢焦点
                cp.ExStyle |= 0x00000080; // WS_EX_TOOLWINDOW：不出现在 Alt+Tab
                return cp;
            }
        }

        // 与工具条同理：点击浮窗内控件（切换服务/清空上下文/历史/复制等）不应把浮窗变成前台，
        // 否则下一次取词/暂存的“目标进程”判定会失效。显式返回 MA_NOACTIVATE。
        const int WM_MOUSEACTIVATE = 0x0021;
        const int MA_NOACTIVATE = 3;
        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_MOUSEACTIVATE) { m.Result = (IntPtr)MA_NOACTIVATE; return; }
            base.WndProc(ref m);
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            ApplyWindowChrome();
            ApplyOwner();
            // 强制创建子控件句柄并应用深色滚动条主题
            Native.ApplyScrollTheme(txtResult.Handle, cfg.DarkTheme);
            Native.ApplyScrollTheme(txtSource.Handle, cfg.DarkTheme);
        }

        /// <summary>
        /// 记录“本次翻译是从哪个前台窗口触发的”，并把它设为浮窗的所有者。
        /// 这样浮窗只在该窗口之上浮起；用户切换到浏览器等其它软件时，浮窗会被那些窗口盖住，
        /// 而不是像 TopMost 那样永远压在最上面。
        /// </summary>
        void AttachToForeground()
        {
            IntPtr fg = Native.ForegroundWindow();
            // 拿不到前台窗口、或前台是本程序自己的窗口时不改动既有归属
            if (fg != IntPtr.Zero && !Native.IsOwnWindow(fg)) sourceHwnd = fg;
            ApplyOwner();
        }

        /// <summary>把 sourceHwnd 应用到窗口；没有可用归属窗口时退回“始终置顶”，至少保证可见。</summary>
        void ApplyOwner()
        {
            // 拿不到归属窗口、或浮窗是本次会话首次创建时，一律用“无条件置顶”：
            // 首次创建时窗口句柄尚未稳定，跨进程设置所有者（SetWindowLongPtr）可能不生效，
            // 一旦此时改成归属式 z 序，浮窗就会被稻壳盖住而看不见（翻译其实已完成）。
            // 首次显示之后（窗口已存在且可见）再切回“只浮在来源窗口之上”。
            if (sourceHwnd == IntPtr.Zero || !everShown)
            {
                TopMost = true;
                return;
            }
            TopMost = false;
            if (IsHandleCreated)
            {
                bool okOwner = Native.SetOwner(Handle, sourceHwnd);
                bool okAbove = Native.PlaceAbove(Handle, sourceHwnd);
                Program.Log("浮窗归属：owner=" + sourceHwnd + " setOwner=" + okOwner + " placeAbove=" + okAbove);
            }
        }

        /// <summary>把浮窗提到“所有者之上”（而不是像 BringToFront 那样压到所有窗口之上）。</summary>
        void RaiseToOwner()
        {
            // 已置顶时不要再插到归属窗口之上：SetWindowPos(hWndInsertAfter=非置顶窗口) 会把窗口
            // 从置顶层降下来，反而可能被稻壳盖住。
            if (TopMost) return;
            if (sourceHwnd != IntPtr.Zero) Native.PlaceAbove(Handle, sourceHwnd);
            else BringToFront();
        }

        /// <summary>
        /// 推迟到下一轮消息循环再做一次 z 序提升/校准（首次 Show() 时窗口管理器尚未完成安置，
        /// 立即调用可能被忽略）。同时记录一次窗口状态，便于排查“浮窗不可见”。
        /// </summary>
        void RaiseSoon()
        {
            if (!IsHandleCreated) { RaiseToOwner(); return; }
            try
            {
                BeginInvoke((Action)delegate
                {
                    if (IsDisposed) return;
                    RaiseToOwner();
                    Program.Log("浮窗状态：visible=" + Visible + " topmost=" + TopMost +
                        " loc=" + Location + " size=" + ClientSize +
                        " owner=" + Native.GetOwnerWindow(Handle) + " src=" + sourceHwnd);
                });
            }
            catch { RaiseToOwner(); }
        }

        protected override void OnSizeChanged(EventArgs e)
        {
            base.OnSizeChanged(e);
            ApplyWindowChrome();
        }

        /// <summary>
        /// 处理窗口本身的圆角：优先交给 Win11 的 DWM 做抗锯齿圆角；
        /// 不可用时（Win10 / 调用被拒）退回 Region 裁剪，保证圆角始终存在。
        /// </summary>
        void ApplyWindowChrome()
        {
            if (!IsHandleCreated) return;
            // 本窗已在用 DWM 圆角时不必再裁剪 Region
            if (!dwmCorners) dwmCorners = Native.SetRoundedCorners(Handle);
            if (dwmCorners)
            {
                // 交给 DWM 抗锯齿圆角后必须撤掉 Region：Region 会把窗口再裁成硬边，反而盖掉 DWM 的平滑圆角
                Region old = Region;
                if (old != null) { Region = null; old.Dispose(); }
            }
            else
            {
                Native.ApplyRound(this, Radius);
            }
        }

        // ---------------- 绘制 ----------------

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;

            using (SolidBrush b = new SolidBrush(cBg))
                g.FillRectangle(b, ClientRectangle);

            // 自绘的描边半径取得与 DWM 圆角一致，避免在角上被圆角裁掉
            using (GraphicsPath path = Native.RoundPath(new Rectangle(0, 0, Width - 1, Height - 1), Radius))
            using (Pen p = new Pen(cBorder, Math.Max(1f, S)))
            {
                p.Alignment = PenAlignment.Inset;
                g.DrawPath(p, path);
            }

            DrawBusyBar(g);
        }

        void DrawBusyBar(Graphics g)
        {
            if (!busy) return;
            int trackW = Width - Pad * 2;
            if (trackW <= 0) return;
            int segW = Math.Max(Px(48), trackW / 3);
            int span = trackW - segW;
            int pos = 0;
            if (span > 0)
            {
                int period = 18;
                int t = animStep % (period * 2);
                float f = t < period ? t / (float)period : (period * 2 - t) / (float)period;
                pos = (int)(span * f);
            }
            Rectangle bar = new Rectangle(Pad + pos, Height - Px(6), segW, Px(3));
            using (GraphicsPath path = Native.RoundPath(bar, Px(2)))
            using (SolidBrush b = new SolidBrush(cAccent))
                g.FillPath(b, path);
        }

        // ---------------- 显示 ----------------

        public void ShowBusy(string source, Point at)
        {
            anchor = at;
            ShowBusyCore(source, true);
        }

        /// <summary>重新翻译 / 切换服务时使用：保持窗口当前所在位置，不重新定位到光标。</summary>
        public void ShowBusyInPlace(string source)
        {
            ShowBusyCore(source, false);
        }

        void ShowBusyCore(string source, bool reposition)
        {
            closeTimer.Stop();
            SetMenuVisible(false);   // 新一轮翻译收起服务勾选菜单
            // 新的一轮翻译：以当前前台窗口为归属，浮窗只浮在它上面
            AttachToForeground();
            // 新的一次翻译默认收起原文；切换服务重译时保留用户已展开的状态
            if (reposition) sourceExpanded = false;
            SetSource(source);
            UpdateSourceToggle();
            txtResult.Text = "";
            busy = true;
            SetStatus("翻译中", false);
            LayoutForContent();
            if (reposition && !userMoved) PositionAt(anchor);
            animTimer.Start();
            if (!Visible) { Show(); Native.ShowNoActivate(Handle); }
            everShown = true;   // 首次显示结束：此后可按“归属式 z 序”浮在来源窗口之上
            RaiseSoon();
        }

        public void ShowResult(string source, string result, bool isError)
        {
            ShowResultCore(source, result, true, isError);
        }

        /// <summary>保持窗口当前位置展示结果。</summary>
        public void ShowResultPreserveAnchor(string source, string result, bool isError)
        {
            ShowResultCore(source, result, false, isError);
        }

        void ShowResultCore(string source, string result, bool reposition, bool isError)
        {
            animTimer.Stop();
            busy = false;
            SetSource(source);
            txtResult.Text = result;
            SetStatus(isError ? "失败" : "完成", isError);
            LayoutForContent();
            if (reposition && !userMoved) PositionAt(anchor);
            if (!Visible) { Show(); Native.ShowNoActivate(Handle); }
            everShown = true;   // 首次显示结束：此后可按“归属式 z 序”浮在来源窗口之上
            RaiseSoon();
            if (cfg.AutoCloseSeconds > 0)
            {
                closeTimer.Interval = cfg.AutoCloseSeconds * 1000;
                closeTimer.Start();
            }
        }

        public void SetError(string source, string message)
        {
            SetErrorCore(source, message, true);
        }

        void SetErrorCore(string source, string message, bool reposition)
        {
            animTimer.Stop();
            busy = false;
            SetSource(source);
            txtResult.Text = message;
            SetStatus("失败", true);
            LayoutForContent();
            if (reposition && !userMoved) PositionAt(anchor);
            if (!Visible) { Show(); Native.ShowNoActivate(Handle); }
            everShown = true;   // 首次显示结束：此后可按“归属式 z 序”浮在来源窗口之上
            RaiseSoon();
        }

        void SetStatus(string text, bool error)
        {
            lblStatus.Text = text;
            lblStatus.ForeColor = error ? cDanger : cMuted;
        }

        /// <summary>在状态栏显示一次非错误的操作反馈（如「已清空上下文」）。</summary>
        public void ShowContextCleared()
        {
            SetStatus("已清空上下文", false);
        }

        /// <summary>切换底部高亮到指定服务（不触发 ServiceChanged）。</summary>
        public void SetEngineDisplay(string id)
        {
            currentService = (id ?? "llm").ToLowerInvariant();
            for (int i = 0; i < serviceLabels.Length; i++)
            {
                bool on = string.Equals((string)serviceLabels[i].Tag, currentService, StringComparison.OrdinalIgnoreCase);
                serviceLabels[i].FillColor = on ? cAccent : cTrack;
                serviceLabels[i].ForeColor = on ? Color.White : cMuted;
            }
        }

        // ---------------- 底部服务胶囊 / 左上角服务勾选菜单 ----------------

        /// <summary>按当前 enabledIds 重建底部胶囊行（切换服务或勾选变化后调用）。</summary>
        void RebuildServiceChips()
        {
            Font chipFont = new Font("Microsoft YaHei UI", 8.5f);
            if (serviceLabels != null)
            {
                for (int i = 0; i < serviceLabels.Length; i++)
                {
                    if (serviceLabels[i] == null) continue;
                    track.Controls.Remove(serviceLabels[i]);
                    serviceLabels[i].Dispose();
                }
            }

            // 统一胶囊宽度：按最长服务名自适应，避免「大模型」等多字名称被压缩
            chipW = Px(R_ChipW);
            for (int i = 0; i < enabledIds.Count; i++)
            {
                int tw = TextRenderer.MeasureText(Translator.DisplayName(enabledIds[i]), chipFont).Width + Px(12);
                if (tw > chipW) chipW = tw;
            }

            serviceLabels = new RoundLabel[enabledIds.Count];
            for (int i = 0; i < enabledIds.Count; i++)
            {
                RoundLabel l = new RoundLabel();
                l.Text = Translator.DisplayName(enabledIds[i]);
                l.Tag = enabledIds[i];
                l.Radius = Px(6);
                l.Surround = cTrack;
                l.FillColor = cTrack;
                l.Align = ContentAlignment.MiddleCenter;
                l.Font = new Font("Microsoft YaHei UI", 8.5f);
                l.ForeColor = cMuted;
                l.Cursor = Cursors.Hand;
                // 点按切换服务的判定放在 MouseUp 里做（见 OnChipMouseUp），
                // 避免与拖动滚动共用 Click 时无法区分「点按」与「拖动」。
                l.MouseDown += OnChipMouseDown;
                l.MouseMove += OnChipMouseMove;
                l.MouseUp += OnChipMouseUp;
                l.MouseWheel += OnServiceWheel;
                l.MouseEnter += delegate(object s, EventArgs e)
                {
                    RoundLabel lab = (RoundLabel)s;
                    if ((string)lab.Tag != currentService) lab.FillColor = cHover;
                };
                l.MouseLeave += delegate(object s, EventArgs e)
                {
                    RoundLabel lab = (RoundLabel)s;
                    if ((string)lab.Tag != currentService) lab.FillColor = cTrack;
                };
                serviceLabels[i] = l;
                track.Controls.Add(l);
            }
            chipScrollOffset = 0;
            SetEngineDisplay(currentService);
            EnsureCurrentChipVisible();
        }

        // ---------------- 底部胶囊行横向滚动（服务多于 R_VisibleChips 个时启用） ----------------

        /// <summary>胶囊行当前可同时显示的服务数（最多 R_VisibleChips 个）。</summary>
        int VisibleChipCount()
        {
            return Math.Min(enabledIds.Count, R_VisibleChips);
        }

        /// <summary>胶囊行可滚动的最大偏移（超出可视宽度的部分）。</summary>
        int MaxChipScroll()
        {
            int over = enabledIds.Count - R_VisibleChips;
            return over > 0 ? over * chipW : 0;
        }

        /// <summary>滚动到指定偏移（自动夹紧到合法范围）并重排胶囊；偏移不变时不做任何事。</summary>
        void SetChipScroll(int offset)
        {
            int max = MaxChipScroll();
            if (offset < 0) offset = 0;
            if (offset > max) offset = max;
            if (offset == chipScrollOffset) return;
            chipScrollOffset = offset;
            LayoutChips();
        }

        /// <summary>让当前所选服务的胶囊落在可视窗内（服务多于 R_VisibleChips 个时才有意义）。</summary>
        void EnsureCurrentChipVisible()
        {
            int idx = enabledIds.IndexOf(currentService);
            if (idx < 0) { SetChipScroll(0); return; }
            int start = chipScrollOffset / chipW;   // 偏移始终是 chipW 的整数倍
            if (idx < start) SetChipScroll(idx * chipW);
            else if (idx >= start + R_VisibleChips) SetChipScroll((idx - R_VisibleChips + 1) * chipW);
        }

        /// <summary>按当前滚动偏移排布胶囊。超出 track 可视区域的胶囊由 WinForms 自动裁掉，形成视窗效果。</summary>
        void LayoutChips()
        {
            if (serviceLabels == null) return;
            for (int i = 0; i < serviceLabels.Length; i++)
                serviceLabels[i].SetBounds(TrackPad + i * chipW - chipScrollOffset, TrackPad, chipW, ChipH);
        }

        /// <summary>滚轮切换显示的翻译服务；服务不足 R_VisibleChips 个时无需滚动。</summary>
        void OnServiceWheel(object sender, MouseEventArgs e)
        {
            if (enabledIds.Count <= R_VisibleChips) return;
            int steps = e.Delta / SystemInformation.MouseWheelScrollDelta;
            if (steps == 0) steps = e.Delta > 0 ? 1 : -1;
            SetChipScroll(chipScrollOffset - steps * chipW);
        }

        void OnChipMouseDown(object sender, MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Left) return;
            chipDragActive = true;
            chipDragMoved = false;
            chipDragStartCursor = Cursor.Position;
            chipDragStartOffset = chipScrollOffset;
            Control c = sender as Control;
            if (c != null) c.Capture = true;   // 保证拖出胶囊后仍能收到移动事件
        }

        void OnChipMouseMove(object sender, MouseEventArgs e)
        {
            if (!chipDragActive || e.Button != MouseButtons.Left) return;
            int dx = Cursor.Position.X - chipDragStartCursor.X;
            if (!chipDragMoved && Math.Abs(dx) <= Px(4)) return;   // 未超过阈值仍视为点按
            chipDragMoved = true;
            SetChipScroll(chipDragStartOffset - dx);
        }

        void OnChipMouseUp(object sender, MouseEventArgs e)
        {
            if (!chipDragActive) return;
            chipDragActive = false;
            Control c = sender as Control;
            if (c != null) c.Capture = false;

            if (chipDragMoved)
            {
                chipDragMoved = false;
                // 拖拽结束后吸附到整颗胶囊，避免半颗胶囊长年卡在视窗边缘
                SetChipScroll((int)Math.Round(chipScrollOffset / (double)chipW) * chipW);
                return;   // 拖动只滚动，不切换服务
            }
            // 点按（且释放仍在同一颗胶囊上）才切换服务
            if (c != null && c.ClientRectangle.Contains(e.Location)) ActivateChip(sender);
        }

        /// <summary>点按胶囊：切换到该服务并通知调用方重译。</summary>
        void ActivateChip(object sender)
        {
            RoundLabel l = sender as RoundLabel;
            if (l == null) return;
            string id = (string)l.Tag;
            if (id == currentService) return;
            SetEngineDisplay(id);
            Action<string> h = ServiceChanged;
            if (h != null) h(id);
        }

        /// <summary>构建「服务勾选」菜单（默认隐藏）：列出全部服务，勾选即显示在底部胶囊行。</summary>
        void BuildMenu()
        {
            menuPanel = new MenuPanel();
            menuPanel.Surround = cBg;
            menuPanel.Fill = cMenu;
            menuPanel.BorderColor = cBorder;
            menuPanel.Radius = Px(8);
            menuPanel.BorderW = Math.Max(1f, S);
            menuPanel.Font = new Font("Microsoft YaHei UI", 9f);
            menuPanel.Visible = false;

            menuRows = new MenuRow[AllServiceIds.Length];
            for (int i = 0; i < AllServiceIds.Length; i++)
            {
                MenuRow row = new MenuRow();
                row.Tag = AllServiceIds[i];
                row.Text = Translator.DisplayName(AllServiceIds[i]);
                row.Radius = Px(6);
                row.BoxSize = Px(14);
                row.PadX = Px(8);
                row.SurroundColor = cMenu;
                row.HoverColor = cHover;
                row.AccentColor = cAccent;
                row.TextColor = cFg;
                row.MutedColor = cMuted;
                row.Click += delegate(object s, EventArgs e) { ToggleService((string)((MenuRow)s).Tag); };
                menuRows[i] = row;
                menuPanel.Controls.Add(row);
            }
            Controls.Add(menuPanel);
            menuPanel.BringToFront();
        }

        void ToggleMenu()
        {
            SetMenuVisible(menuPanel == null || !menuPanel.Visible);
        }

        void SetMenuVisible(bool on)
        {
            if (menuPanel == null || menuPanel.IsDisposed) return;
            if (on)
            {
                RefreshMenuChecks();
                menuPanel.BringToFront();
            }
            menuPanel.Visible = on;
            lblTitle.ForeColor = on ? cAccent : cFg;
        }

        void RefreshMenuChecks()
        {
            for (int i = 0; i < menuRows.Length; i++)
                menuRows[i].Checked = enabledIds.Contains((string)menuRows[i].Tag);
        }

        /// <summary>
        /// 勾选/取消某项服务：立即重建底部胶囊行并写回 config.ini。
        /// 至少保留一项（全部取消会让底部没有任何可切换入口）。
        /// </summary>
        void ToggleService(string id)
        {
            bool on = enabledIds.Contains(id);
            if (on)
            {
                if (enabledIds.Count <= 1)
                {
                    SetStatus("至少保留一个服务", true);
                    return;
                }
                enabledIds.Remove(id);
            }
            else
            {
                enabledIds.Add(id);
                enabledIds.Sort(CompareByKnownOrder);
            }
            cfg.EnabledServices = string.Join(",", enabledIds.ToArray());
            AppConfig.SetValue(cfg.Path, "enabled_services", cfg.EnabledServices);
            RefreshMenuChecks();
            RebuildServiceChips();
            LayoutForContent();
            if (menuPanel.Visible) menuPanel.BringToFront();
        }

        static int CompareByKnownOrder(string a, string b)
        {
            return Array.IndexOf(AllServiceIds, a).CompareTo(Array.IndexOf(AllServiceIds, b));
        }

        public void HidePopup()
        {
            animTimer.Stop();
            closeTimer.Stop();
            busy = false;
            if (resizing) { resizing = false; grip.Capture = false; }
            SetMenuVisible(false);
            Hide();
        }

        /// <summary>右下角按钮：展开原文时复制原文，否则复制译文。</summary>
        void CopyResult()
        {
            bool copySource = sourceExpanded;
            string text = copySource ? fullSource : txtResult.Text;
            if (Native.SetClipboardText(text)) SetStatus(copySource ? "已复制原文" : "已复制译文", false);
        }

        void SetSource(string text)
        {
            fullSource = text == null ? "" : text.Trim();
            lblSource.Text = Compact(fullSource);
            // 原文未变时不重设，避免把用户已经滚动到的位置重置回顶部
            if (txtSource.Text != fullSource) txtSource.Text = fullSource;
        }

        /// <summary>同步“原文”小标题的展开提示与右下角按钮文案。</summary>
        void UpdateSourceToggle()
        {
            lblSrcCap.Text = sourceExpanded ? "原文 ▼" : "原文 ▶";
            btnCopy.Text = sourceExpanded ? "复制原文" : "复制译文";
        }

        /// <summary>展开 / 收起原文。展开时窗口向下加高，译文区高度不受影响。</summary>
        void ToggleSource()
        {
            sourceExpanded = !sourceExpanded;
            UpdateSourceToggle();
            LayoutForContent();
            KeepOnScreen();
        }

        /// <summary>确保窗口仍完整落在当前屏幕工作区内（展开原文后可能变高）。</summary>
        void KeepOnScreen()
        {
            Rectangle wa = Screen.FromPoint(Location).WorkingArea;
            int x = Location.X, y = Location.Y;
            if (x + Width > wa.Right) x = wa.Right - Width;
            if (y + Height > wa.Bottom) y = wa.Bottom - Height;
            if (x < wa.Left) x = wa.Left;
            if (y < wa.Top) y = wa.Top;
            if (x != Location.X || y != Location.Y) Location = new Point(x, y);
        }

        static string Compact(string s)
        {
            if (s == null) return "";
            string t = s.Replace("\r\n", " ").Replace("\n", " ").Replace("\r", " ").Trim();
            while (t.IndexOf("  ") >= 0) t = t.Replace("  ", " ");
            if (t.Length > 96) t = t.Substring(0, 96) + "…";
            return t;
        }

        // ---------------- 布局 ----------------

        /// <summary>结果区以外的固定高度（内边距 + 标题 + 原文区 + 底部操作行等）。srcH 为当前原文区高度。</summary>
        int ChromeHeight(int srcH)
        {
            return Pad + HeaderH + G1 + CapH + srcH + G2 + DivH + G3 + CapH + G4 + FooterH + Pad;
        }

        /// <summary>原文区高度：折叠时为两行预览的固定高度；展开时按全文自适应，超出上限则内部滚动。</summary>
        int ComputeSourceHeight(int w)
        {
            if (!sourceExpanded) return SourceH;
            int innerW = w - Pad * 2 - Px(6);
            Size ms = TextRenderer.MeasureText(txtSource.Text, txtSource.Font,
                new Size(innerW, Px(4000)), TextFormatFlags.WordBreak);
            int h = ms.Height + Px(8);
            if (h < SourceH) h = SourceH;
            if (h > SourceMaxH) h = SourceMaxH;
            return h;
        }

        void LayoutForContent()
        {
            int w = Px(widthLogical);
            if (w < MinW) w = MinW;
            if (w > MaxW) w = MaxW;

            int srcH = ComputeSourceHeight(w);

            int resultH;
            if (heightPinned)
            {
                resultH = pinnedResultH;
                if (resultH < Px(64)) resultH = Px(64);
            }
            else
            {
                int innerW = w - Pad * 2 - Px(6);
                Size measured = TextRenderer.MeasureText(txtResult.Text, txtResult.Font,
                    new Size(innerW, Px(2000)), TextFormatFlags.WordBreak);
                resultH = measured.Height + Px(6);
                if (resultH < Px(64)) resultH = Px(64);
                if (resultH > Px(340)) resultH = Px(340);
            }

            Size meas2 = TextRenderer.MeasureText(txtResult.Text, txtResult.Font,
                new Size(w - Pad * 2 - Px(6), Px(2000)), TextFormatFlags.WordBreak);
            bool overflow = (meas2.Height + Px(6)) > resultH;
            ScrollBars want = overflow ? ScrollBars.Vertical : ScrollBars.None;
            if (txtResult.ScrollBars != want) txtResult.ScrollBars = want;

            // 总高超出上限时，优先压缩可滚动的原文区，尽量不挤占译文区
            int totalH = ChromeHeight(srcH) + resultH;
            if (totalH > MaxH)
            {
                int newSrcH = srcH - (totalH - MaxH);
                if (newSrcH < SourceH) newSrcH = SourceH;
                srcH = newSrcH;
                totalH = ChromeHeight(srcH) + resultH;
            }

            // 展开态下原文区过长时，让它自己出现纵向滚动条
            if (sourceExpanded)
            {
                int innerW = w - Pad * 2 - Px(6);
                Size ms = TextRenderer.MeasureText(txtSource.Text, txtSource.Font,
                    new Size(innerW, Px(4000)), TextFormatFlags.WordBreak);
                ScrollBars sw = (ms.Height + Px(8)) > srcH ? ScrollBars.Vertical : ScrollBars.None;
                if (txtSource.ScrollBars != sw) txtSource.ScrollBars = sw;
            }

            ClientSize = new Size(w, totalH);

            int y = Pad;
            btnClose.SetBounds(w - Pad - CloseSize, y + (HeaderH - CloseSize) / 2, CloseSize, CloseSize);
            int rightLimit = btnClose.Left - Px(8);

            // 「历史」紧邻关闭按钮（标题栏内，不抢焦点）
            int histW = TextRenderer.MeasureText(btnHistory.Text, btnHistory.Font).Width + Px(16);
            if (histW < Px(46)) histW = Px(46);
            int histH = Math.Min(ChipH, HeaderH);
            int histX = rightLimit - histW;
            if (histX < Pad + Px(56)) histX = Pad + Px(56);
            btnHistory.SetBounds(histX, y + (HeaderH - histH) / 2, histW, histH);
            rightLimit = histX - Px(8);

            // 「清空上下文」放在标题栏右侧（底部行保持与改动前完全一致，避免挤占状态文字）
            btnClearCtx.Visible = cfg.ContextEnable;
            if (btnClearCtx.Visible)
            {
                int clearW = TextRenderer.MeasureText(btnClearCtx.Text, btnClearCtx.Font).Width + Px(16);
                if (clearW < Px(70)) clearW = Px(70);
                int clearH = Math.Min(ChipH, HeaderH);
                int clearX = rightLimit - clearW;
                if (clearX < Pad + Px(56)) clearX = Pad + Px(56);   // 窗口很窄时不压住标题
                btnClearCtx.SetBounds(clearX, y + (HeaderH - clearH) / 2, clearW, clearH);
                rightLimit = clearX - Px(8);
            }

            int langW = TextRenderer.MeasureText(lblLang.Text, lblLang.Font).Width + Px(4);
            lblLang.SetBounds(rightLimit - langW, y, langW, HeaderH);
            // 标题（下拉入口）只占文字宽度：避免点到标题右侧的大片空白也触发服务配置菜单。
            // 标题右侧的空白仍可作为拖动区（由窗体自身的表头鼠标处理负责拖动）。
            int titleW = TextRenderer.MeasureText(lblTitle.Text, lblTitle.Font).Width + Px(10);
            int titleMaxW = Math.Max(Px(40), lblLang.Left - Px(8) - Pad);
            if (titleW > titleMaxW) titleW = titleMaxW;
            lblTitle.SetBounds(Pad, y, titleW, HeaderH);
            y += HeaderH + G1;

            lblSrcCap.SetBounds(Pad, y, w - Pad * 2, CapH);
            y += CapH;
            if (sourceExpanded)
            {
                txtSource.SetBounds(Pad, y, w - Pad * 2, srcH);
                txtSource.Visible = true;
                lblSource.Visible = false;
            }
            else
            {
                lblSource.SetBounds(Pad, y, w - Pad * 2, srcH);
                lblSource.Visible = true;
                txtSource.Visible = false;
            }
            y += srcH + G2;

            sep.SetBounds(Pad, y, w - Pad * 2, DivH);
            y += DivH + G3;

            lblResCap.SetBounds(Pad, y, w - Pad * 2, CapH);
            y += CapH;
            txtResult.SetBounds(Pad, y, w - Pad * 2, resultH);
            y += resultH + G4;

            // 胶囊行宽度固定按最多 R_VisibleChips 个服务计；服务更多时超出的部分靠滚动查看
            int trackW = VisibleChipCount() * chipW + TrackPad * 2;
            int trackH = ChipH + TrackPad * 2;
            track.SetBounds(Pad, y + (FooterH - trackH) / 2, trackW, trackH);
            if (chipScrollOffset > MaxChipScroll()) chipScrollOffset = MaxChipScroll();
            LayoutChips();

            // 「清空上下文」入口在标题栏内定位（见上方 header 布局），底部行保持与改动前一致
            btnCopy.SetBounds(w - Pad - CopyW, y + (FooterH - CopyH) / 2, CopyW, CopyH);

            int statusX = Pad + trackW + Px(10);
            int statusW = (w - Pad - CopyW) - Px(10) - statusX;
            if (statusW < Px(30)) statusW = Px(30);
            lblStatus.SetBounds(statusX, y, statusW, FooterH);

            grip.SetBounds(w - GripSize, ClientSize.Height - GripSize, GripSize, GripSize);
            grip.BringToFront();

            LayoutMenu();
        }

        /// <summary>
        /// 服务勾选菜单的尺寸与定位：紧贴标题下沿、左对齐，覆盖在内容之上（弹出即自动到最上层）。
        /// 宽度按最长服务名 + 勾选框自适应，保证名称完整可读。
        /// </summary>
        void LayoutMenu()
        {
            if (menuPanel == null) return;
            int pad = Px(6);
            int rowH = Px(27);
            int nameW = 0;
            for (int i = 0; i < AllServiceIds.Length; i++)
            {
                Size ms = TextRenderer.MeasureText(Translator.DisplayName(AllServiceIds[i]), menuPanel.Font);
                if (ms.Width > nameW) nameW = ms.Width;
            }
            // 行宽 = 左右内边距 + 勾选框 + 名称左右留白 + 名称宽；面板再各加一层内边距
            int menuW = pad * 2 + Px(8) + Px(14) + Px(8) + nameW + Px(8);
            int menuH = pad * 2 + rowH * AllServiceIds.Length;
            menuPanel.SetBounds(Pad, Pad + HeaderH + Px(4), menuW, menuH);
            for (int i = 0; i < menuRows.Length; i++)
                menuRows[i].SetBounds(pad, pad + i * rowH, menuW - pad * 2, rowH);
        }

        void PositionAt(Point at)
        {
            Rectangle wa = Screen.FromPoint(at).WorkingArea;
            int x = at.X + Px(14);
            int y = at.Y + Px(18);
            if (x + Width > wa.Right) x = at.X - Width - Px(14);
            if (y + Height > wa.Bottom) y = wa.Bottom - Height - Px(4);
            if (x < wa.Left) x = wa.Left + Px(4);
            if (y < wa.Top) y = wa.Top + Px(4);
            Location = new Point(x, y);
        }

        // ---------------- 移动 / 缩放 ----------------

        // 鼠标位于浮窗空白处时也能用滚轮切换底部显示的翻译服务
        protected override void OnMouseWheel(MouseEventArgs e)
        {
            base.OnMouseWheel(e);
            OnServiceWheel(this, e);
        }

        void StartDrag()
        {
            dragging = true;
            dragOffset = new Point(Cursor.Position.X - Location.X, Cursor.Position.Y - Location.Y);
            Capture = true;
        }

        // ---------------- 右下角抓手缩放 ----------------
        // 抓手是最顶层的子控件 ResizeGrip，鼠标事件由它接收；这里只做尺寸计算与写回配置。
        // 宽度会被记入配置（下次启动沿用）；高度仅在用户「明显纵向拖动」时才钉住，
        // 否则保持随译文内容自适应（也正因此高度不写入配置）。

        void BeginResize()
        {
            resizing = true;
            resizeStartCursor = Cursor.Position;
            resizeStartSize = ClientSize;
            grip.Capture = true;
        }

        void UpdateResize()
        {
            int dx = Cursor.Position.X - resizeStartCursor.X;
            int dy = Cursor.Position.Y - resizeStartCursor.Y;
            int nw = Clamp(resizeStartSize.Width + dx, MinW, MaxW);
            widthLogical = UnPx(nw);
            if (Math.Abs(dy) > Px(4)) heightPinned = true;
            if (heightPinned)
            {
                int nh = Clamp(resizeStartSize.Height + dy, MinH, MaxH);
                // 窗口高矮只改译文区高度，原文区高度保持其自身规则（折叠固定 / 展开自适应）
                pinnedResultH = nh - ChromeHeight(ComputeSourceHeight(nw));
                if (pinnedResultH < Px(48)) pinnedResultH = Px(48);
            }
            LayoutForContent();
        }

        void FinishResize()
        {
            resizing = false;
            grip.Capture = false;
            SaveWidth();
            LayoutForContent();
        }

        /// <summary>把当前浮窗宽度写回配置（换算回设计像素，避免高 DPI 下被重复放大）。</summary>
        void SaveWidth()
        {
            try
            {
                int logical = UnPx(ClientSize.Width);
                if (logical < R_MinW) logical = R_MinW;
                if (logical > R_MaxW) logical = R_MaxW;
                if (logical == cfg.PopupWidth) return;
                cfg.PopupWidth = logical;
                AppConfig.SetValue(cfg.Path, "popup_width", logical.ToString());
            }
            catch { }
        }

        int UnPx(int px) { return (int)Math.Round(px / S); }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button != MouseButtons.Left) return;

            // 点浮窗空白处（非菜单内）即收起服务勾选菜单
            SetMenuVisible(false);

            if (e.Y <= Pad + HeaderH) StartDrag();
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            if (dragging)
                Location = new Point(Cursor.Position.X - dragOffset.X, Cursor.Position.Y - dragOffset.Y);
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            if (!dragging) return;
            dragging = false;
            userMoved = true;
            Capture = false;
            // 标题区几乎没有位移 = 点按，打开/收起服务勾选菜单；有位移则是拖动移动窗口
            if (titlePressed)
            {
                titlePressed = false;
                int dx = Math.Abs(Cursor.Position.X - titleDownPos.X);
                int dy = Math.Abs(Cursor.Position.Y - titleDownPos.Y);
                if (dx <= Px(4) && dy <= Px(4)) ToggleMenu();
            }
        }

        static int Clamp(int v, int lo, int hi)
        {
            if (v < lo) return lo;
            if (v > hi) return hi;
            return v;
        }

        /// <summary>
        /// 服务勾选菜单的容器：自绘圆角背景 + 描边，圆角之外露出父级底色 <see cref="Surround"/>。
        /// </summary>
        sealed class MenuPanel : Control
        {
            public int Radius = 8;
            public float BorderW = 1f;
            public Color Fill = Color.White;
            public Color BorderColor = Color.Gray;
            public Color Surround = Color.White;

            public MenuPanel()
            {
                SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint
                    | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
                TabStop = false;
            }

            protected override void OnPaintBackground(PaintEventArgs e) { }

            protected override void OnPaint(PaintEventArgs e)
            {
                Graphics g = e.Graphics;
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;

                using (SolidBrush sb = new SolidBrush(Surround))
                    g.FillRectangle(sb, ClientRectangle);

                Rectangle r = new Rectangle(0, 0, Width - 1, Height - 1);
                using (GraphicsPath path = Native.RoundPath(r, Radius))
                {
                    using (SolidBrush b = new SolidBrush(Fill))
                        g.FillPath(b, path);
                    using (Pen p = new Pen(BorderColor, BorderW))
                    {
                        p.Alignment = PenAlignment.Inset;
                        g.DrawPath(p, path);
                    }
                }
            }
        }

        /// <summary>
        /// 菜单里的一行：左侧自绘勾选框（选中=实心 + 对勾，未选=空心框），右侧服务名。
        /// 选中态整行带淡强调底色，悬停有高亮反馈。
        /// </summary>
        sealed class MenuRow : Control
        {
            public int Radius = 6;
            public int BoxSize = 14;
            public int PadX = 8;
            public Color SurroundColor = Color.White;
            public Color HoverColor = Color.LightGray;
            public Color AccentColor = Color.RoyalBlue;
            public Color TextColor = Color.Black;
            public Color MutedColor = Color.Gray;

            bool checkedOn, hover;

            public bool Checked
            {
                get { return checkedOn; }
                set { if (checkedOn != value) { checkedOn = value; Invalidate(); } }
            }

            public MenuRow()
            {
                SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint
                    | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
                TabStop = false;
                Cursor = Cursors.Hand;
            }

            protected override void OnPaintBackground(PaintEventArgs e) { }

            protected override void OnMouseEnter(EventArgs e) { base.OnMouseEnter(e); hover = true; Invalidate(); }
            protected override void OnMouseLeave(EventArgs e) { base.OnMouseLeave(e); hover = false; Invalidate(); }

            protected override void OnPaint(PaintEventArgs e)
            {
                Graphics g = e.Graphics;
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;

                using (SolidBrush sb = new SolidBrush(SurroundColor))
                    g.FillRectangle(sb, ClientRectangle);

                Color fill = Color.Transparent;
                if (Checked) fill = Color.FromArgb(38, AccentColor);
                else if (hover) fill = HoverColor;
                if (fill.A > 0)
                {
                    using (GraphicsPath path = Native.RoundPath(new Rectangle(0, 0, Width - 1, Height - 1), Radius))
                    using (SolidBrush b = new SolidBrush(fill))
                        g.FillPath(b, path);
                }

                Rectangle box = new Rectangle(PadX, (Height - BoxSize) / 2, BoxSize, BoxSize);
                if (Checked)
                {
                    using (GraphicsPath bp = Native.RoundPath(box, Math.Max(2, BoxSize / 5)))
                    using (SolidBrush b = new SolidBrush(AccentColor))
                        g.FillPath(b, bp);
                    using (Pen pen = new Pen(Color.White, Math.Max(1.6f, BoxSize / 7f)))
                    {
                        pen.StartCap = LineCap.Round;
                        pen.EndCap = LineCap.Round;
                        Point[] pts = new Point[]
                        {
                            new Point(box.Left + BoxSize / 4, box.Top + BoxSize / 2),
                            new Point(box.Left + BoxSize * 2 / 5, box.Bottom - BoxSize / 4),
                            new Point(box.Right - BoxSize / 4, box.Top + BoxSize / 4)
                        };
                        g.DrawLines(pen, pts);
                    }
                }
                else
                {
                    using (Pen pen = new Pen(MutedColor, Math.Max(1f, BoxSize / 9f)))
                    {
                        pen.Alignment = PenAlignment.Inset;
                        g.DrawRectangle(pen, box);
                    }
                }

                int textLeft = box.Right + PadX;
                Rectangle tr = new Rectangle(textLeft, 0, Math.Max(1, Width - textLeft - PadX), Height);
                TextRenderer.DrawText(g, Text, Font, tr, Checked ? TextColor : MutedColor,
                    TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix | TextFormatFlags.EndEllipsis);
            }
        }
    }
}