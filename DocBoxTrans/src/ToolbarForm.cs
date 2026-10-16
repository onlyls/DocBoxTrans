using System;
using System.Drawing;
using System.Windows.Forms;

namespace DocBoxTrans
{
    /// <summary>
    /// 划词工具条：鼠标拖选后在光标旁出现，提供「译」「存」两个按钮。
    /// 与结果浮窗一样使用 WS_EX_NOACTIVATE，点击不抢焦点、不清除稻壳里的选区。
    /// 外观与结果浮窗保持一致：圆角卡片 + 悬停高亮。
    /// </summary>
    class ToolbarForm : Form
    {
        const int R_Radius = 8, R_W = 102, R_H = 32;
        const int R_PT = 3, R_PW = 36, R_STASH = 39, R_DISMISS = 75, R_DW = 22;

        readonly float S;
        readonly int Radius, BtnTop, BtnH, XTranslate, XStash, XDismiss, WTranslate, WDismiss, WAll, HAll;

        readonly AppConfig cfg;
        RoundLabel btnTranslate;
        RoundLabel btnStash;
        RoundLabel btnDismiss;
        Color cBg, cBorder, cFg, cSub, cHot, cHover;
        ToolTip tips;
        bool dwmCorners;
        // 划词时所在的前台窗口：工具条以它为所有者，只在其上方浮起
        IntPtr sourceHwnd;

        /// <summary>点按「译」：调用方应执行与划词热键相同的取词翻译逻辑。</summary>
        public event Action TranslateRequested;
        /// <summary>点按「存」：调用方应把当前选区内容追加到暂存。</summary>
        public event Action StashRequested;

        public ToolbarForm(AppConfig config)
        {
            cfg = config;

            S = Native.DetectDpiScale();
            Radius = Px(R_Radius);
            BtnTop = Px(R_PT); BtnH = Px(R_H - R_PT * 2);
            XTranslate = Px(R_PT); XStash = Px(R_STASH); XDismiss = Px(R_DISMISS);
            WTranslate = Px(R_PW); WDismiss = Px(R_DW);
            WAll = Px(R_W); HAll = Px(R_H);

            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            // 与结果浮窗一致：只浮在“划词来源程序”之上，切到别的软件会被盖住
            TopMost = false;
            StartPosition = FormStartPosition.Manual;
            AutoScaleMode = AutoScaleMode.None;
            SetStyle(ControlStyles.ResizeRedraw | ControlStyles.AllPaintingInWmPaint
                | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer, true);
            Size = new Size(WAll, HAll);

            if (cfg.DarkTheme)
            {
                cBg = Color.FromArgb(30, 31, 36);
                cBorder = Color.FromArgb(58, 60, 70);
                cFg = Color.FromArgb(236, 237, 241);
                cSub = Color.FromArgb(152, 154, 164);
                cHot = Color.FromArgb(64, 132, 255);
                cHover = Color.FromArgb(54, 56, 65);
            }
            else
            {
                cBg = Color.FromArgb(255, 255, 255);
                cBorder = Color.FromArgb(226, 228, 234);
                cFg = Color.FromArgb(32, 34, 40);
                cSub = Color.FromArgb(112, 115, 126);
                cHot = Color.FromArgb(47, 107, 255);
                cHover = Color.FromArgb(243, 244, 248);
            }
            tips = new ToolTip();

            btnTranslate = MakeButton("译", cFg, "翻译选中文字");
            btnTranslate.Click += delegate
            {
                HideToolbar();
                Action h = TranslateRequested;
                if (h != null) h();
            };

            btnStash = MakeButton("存", cFg, "暂存选中内容，下次一并翻译");
            btnStash.Click += delegate
            {
                Action h = StashRequested;
                if (h != null) h();
            };

            btnDismiss = MakeButton("✕", cSub, "关闭工具条");
            btnDismiss.Click += delegate { HideToolbar(); };

            Controls.Add(btnTranslate);
            Controls.Add(btnStash);
            Controls.Add(btnDismiss);

            LayoutButtons();
        }

        RoundLabel MakeButton(string text, Color fore, string tip)
        {
            RoundLabel l = new RoundLabel();
            l.Radius = Px(6);
            l.Surround = cBg;
            l.FillColor = cBg;
            l.Text = text;
            l.ForeColor = fore;
            l.Font = new Font("Microsoft YaHei UI", 10.5f, FontStyle.Bold);
            l.Align = ContentAlignment.MiddleCenter;
            l.Cursor = Cursors.Hand;
            tips.SetToolTip(l, tip);
            l.MouseEnter += delegate { l.FillColor = cHot; l.ForeColor = Color.White; };
            l.MouseLeave += delegate
            {
                l.FillColor = cBg;
                l.ForeColor = l == btnStash && HasStash ? cHot : (l == btnDismiss ? cSub : cFg);
            };
            return l;
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
                cp.ExStyle |= 0x08000000; // WS_EX_NOACTIVATE
                cp.ExStyle |= 0x00000080; // WS_EX_TOOLWINDOW
                return cp;
            }
        }

        // WS_EX_NOACTIVATE 只影响 Show() 时是否激活；用户点击工具条时系统仍会走 WM_MOUSEACTIVATE，
        // 若按默认返回 MA_ACTIVATE，会把工具条（本进程）变成前台，导致取词/暂存的“目标进程”判定失效。
        // 这里显式返回 MA_NOACTIVATE，确保点击「译/存/✕」不会抢走稻壳的前台焦点、也不会清空选区。
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
        }

        /// <summary>记录“本次划词来自哪个前台窗口”，并把它设为工具条的所有者（只在其上方浮起）。</summary>
        void AttachToForeground()
        {
            IntPtr fg = Native.ForegroundWindow();
            if (fg != IntPtr.Zero && !Native.IsOwnWindow(fg)) sourceHwnd = fg;
            ApplyOwner();
        }

        /// <summary>把 sourceHwnd 应用到窗口；没有可用归属窗口时退回“始终置顶”，至少保证可见。
        /// 注意：不跨进程设置所有者（SetWindowLongPtr GWLP_HWNDPARENT）——那会再次激活本窗口、
        /// 把本进程变成前台，导致取词/暂存的前台判定失效。只用 SetWindowPos(insertAfter=来源窗口) 做 z 序。</summary>
        void ApplyOwner()
        {
            if (sourceHwnd == IntPtr.Zero)
            {
                TopMost = true;
                return;
            }
            TopMost = false;
            if (IsHandleCreated)
            {
                Native.PlaceAbove(Handle, sourceHwnd);
            }
        }

        protected override void OnSizeChanged(EventArgs e)
        {
            base.OnSizeChanged(e);
            ApplyWindowChrome();
        }

        /// <summary>优先用 Win11 DWM 抗锯齿圆角；不可用时退回 Region 裁剪。</summary>
        void ApplyWindowChrome()
        {
            if (!IsHandleCreated) return;
            if (!dwmCorners) dwmCorners = Native.SetRoundedCorners(Handle);
            if (dwmCorners)
            {
                // 交给 DWM 抗锯齿圆角后必须撤掉 Region，否则硬边会盖掉 DWM 的平滑圆角
                Region old = Region;
                if (old != null) { Region = null; old.Dispose(); }
            }
            else
            {
                Native.ApplyRound(this, Radius);
            }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
            using (SolidBrush b = new SolidBrush(cBg))
                g.FillRectangle(b, ClientRectangle);
            using (System.Drawing.Drawing2D.GraphicsPath path =
                Native.RoundPath(new Rectangle(0, 0, Width - 1, Height - 1), Radius))
            using (Pen p = new Pen(cBorder, Math.Max(1f, S)))
            {
                p.Alignment = System.Drawing.Drawing2D.PenAlignment.Inset;
                g.DrawPath(p, path);
            }
        }

        void LayoutButtons()
        {
            btnTranslate.SetBounds(XTranslate, BtnTop, WTranslate, BtnH);
            btnStash.SetBounds(XStash, BtnTop, WTranslate, BtnH);
            btnDismiss.SetBounds(XDismiss, BtnTop, WDismiss, BtnH);
        }

        int Px(int v) { return (int)Math.Round(v * S); }

        public bool HasStash { get; private set; }

        public void UpdateStashBadge(bool hasStash, int chars)
        {
            HasStash = hasStash;
            btnStash.Text = hasStash ? "存●" : "存";
            btnStash.ForeColor = hasStash ? cHot : cFg;
            tips.SetToolTip(btnStash, hasStash
                ? ("已有暂存 " + chars + " 字，点「译」将连同本次选中一并翻译")
                : "暂存选中内容，下次一并翻译");
        }

        public void ShowAt(Point p)
        {
            Rectangle wa = Screen.FromPoint(p).WorkingArea;
            int x = p.X + Px(12);
            int y = p.Y + Px(16);
            if (x + Width > wa.Right) x = p.X - Width - Px(12);
            if (y + Height > wa.Bottom) y = p.Y - Height - Px(8);
            if (x < wa.Left) x = wa.Left + Px(4);
            if (y < wa.Top) y = wa.Top + Px(4);
            Location = new Point(x, y);
            AttachToForeground();
            if (!Visible) { Show(); Native.ShowNoActivate(Handle); }
            if (sourceHwnd != IntPtr.Zero) Native.PlaceAbove(Handle, sourceHwnd);
            else BringToFront();
        }

        public void HideToolbar()
        {
            if (Visible) Hide();
        }
    }
}