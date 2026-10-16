using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace DocBoxTrans
{
    /// <summary>
    /// 轻量标签输入对话框：无边框圆角卡片、跟随应用主题；用于「新建标签」时输入标签名。
    /// 回车 = 确定，Esc = 取消；确定时返回去除首尾空白后的文本，取消或留空返回 null。
    /// </summary>
    class TagPromptForm : Form
    {
        readonly float S;
        readonly int Pad, Radius, BtnH;
        Color cBg, cBorder, cFg, cInputBg, cAccent, cHover;

        readonly TextBox input;
        readonly RoundLabel btnOk, btnCancel;
        readonly Label lblTitle;

        bool dwmCorners;
        bool dragging;
        Point dragOffset;

        TagPromptForm(string title, string initial, bool dark)
        {
            S = Native.DetectDpiScale();
            Pad = (int)Math.Round(14 * S);
            Radius = (int)Math.Round(10 * S);
            BtnH = (int)Math.Round(28 * S);

            if (dark)
            {
                cBg = Color.FromArgb(38, 40, 46);
                cBorder = Color.FromArgb(58, 60, 70);
                cFg = Color.FromArgb(236, 237, 241);
                cInputBg = Color.FromArgb(30, 31, 36);
                cAccent = Color.FromArgb(64, 132, 255);
                cHover = Color.FromArgb(54, 56, 65);
            }
            else
            {
                cBg = Color.FromArgb(255, 255, 255);
                cBorder = Color.FromArgb(226, 228, 234);
                cFg = Color.FromArgb(32, 34, 40);
                cInputBg = Color.FromArgb(246, 247, 250);
                cAccent = Color.FromArgb(47, 107, 255);
                cHover = Color.FromArgb(233, 235, 242);
            }

            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.CenterParent;
            KeyPreview = true;
            AutoScaleMode = AutoScaleMode.None;
            ClientSize = new Size((int)Math.Round(340 * S), (int)Math.Round(148 * S));
            SetStyle(ControlStyles.ResizeRedraw | ControlStyles.AllPaintingInWmPaint
                | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer, true);

            lblTitle = new Label();
            lblTitle.Text = title;
            lblTitle.Font = new Font("Microsoft YaHei UI", 10f, FontStyle.Bold);
            lblTitle.ForeColor = cFg;
            lblTitle.BackColor = cBg;
            lblTitle.AutoSize = false;
            lblTitle.TextAlign = ContentAlignment.MiddleLeft;
            lblTitle.Cursor = Cursors.SizeAll;
            lblTitle.MouseDown += OnDragStart;
            lblTitle.MouseMove += OnDragMove;
            lblTitle.MouseUp += OnDragEnd;

            input = new TextBox();
            input.BorderStyle = BorderStyle.FixedSingle;
            input.BackColor = cInputBg;
            input.ForeColor = cFg;
            input.Font = new Font("Microsoft YaHei UI", 10f);
            input.Text = initial ?? "";

            btnOk = MakeButton("确定", true);
            btnCancel = MakeButton("取消", false);
            btnOk.Click += delegate { Accept(); };
            btnCancel.Click += delegate { Cancel(); };

            Controls.Add(lblTitle);
            Controls.Add(input);
            Controls.Add(btnCancel);
            Controls.Add(btnOk);

            LayoutControls();   // 子控件创建完成后再排一次（构造时 ClientSize 触发的排布被跳过了）

            Shown += delegate { input.Focus(); input.SelectAll(); };
        }

        /// <summary>弹出输入框；owner 可为 null（此时屏幕居中）。取消或留空返回 null。</summary>
        public static string Prompt(IWin32Window owner, string title, string initial, bool dark)
        {
            using (TagPromptForm f = new TagPromptForm(title, initial, dark))
            {
                DialogResult r = owner != null ? f.ShowDialog(owner) : f.ShowDialog();
                return r == DialogResult.OK ? f.Value : null;
            }
        }

        public string Value { get; private set; }

        RoundLabel MakeButton(string text, bool primary)
        {
            RoundLabel b = new RoundLabel();
            b.Radius = (int)Math.Round(6 * S);
            b.Surround = cBg;
            b.FillColor = primary ? cAccent : cHover;
            b.ForeColor = primary ? Color.White : cFg;
            b.Font = new Font("Microsoft YaHei UI", 9f);
            b.Text = text;
            b.Align = ContentAlignment.MiddleCenter;
            b.Cursor = Cursors.Hand;
            int w = TextRenderer.MeasureText(text, b.Font).Width + (int)Math.Round(28 * S);
            b.Size = new Size(w, BtnH);
            if (!primary)
            {
                b.MouseEnter += delegate { b.FillColor = cBorder; };
                b.MouseLeave += delegate { b.FillColor = cHover; };
            }
            else
            {
                b.MouseEnter += delegate { b.FillColor = Color.FromArgb(88, 150, 255); };
                b.MouseLeave += delegate { b.FillColor = cAccent; };
            }
            return b;
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            ApplyWindowChrome();
        }

        void ApplyWindowChrome()
        {
            if (!IsHandleCreated) return;
            if (!dwmCorners) dwmCorners = Native.SetRoundedCorners(Handle);
            if (dwmCorners)
            {
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
            g.SmoothingMode = SmoothingMode.AntiAlias;
            using (SolidBrush b = new SolidBrush(cBg))
                g.FillRectangle(b, ClientRectangle);
            using (GraphicsPath path = Native.RoundPath(new Rectangle(0, 0, Width - 1, Height - 1), Radius))
            using (Pen p = new Pen(cBorder, Math.Max(1f, S)))
            {
                p.Alignment = PenAlignment.Inset;
                g.DrawPath(p, path);
            }
        }

        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            LayoutControls();
        }

        void LayoutControls()
        {
            // 构造函数里设置 ClientSize 会先触发一次 OnResize，此时子控件可能尚未创建
            if (lblTitle == null || input == null || btnOk == null || btnCancel == null) return;

            int w = ClientSize.Width, h = ClientSize.Height;
            int titleH = (int)Math.Round(24 * S);
            lblTitle.SetBounds(Pad, Pad, w - Pad * 2, titleH);

            int inputH = input.PreferredHeight;
            int inputY = Pad + titleH + (int)Math.Round(6 * S);
            input.SetBounds(Pad, inputY, w - Pad * 2, inputH);

            int btnY = h - Pad - BtnH;
            btnOk.SetBounds(w - Pad - btnOk.Width, btnY, btnOk.Width, btnOk.Height);
            btnCancel.SetBounds(btnOk.Left - (int)Math.Round(8 * S) - btnCancel.Width, btnY, btnCancel.Width, btnCancel.Height);
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            base.OnKeyDown(e);
            if (e.KeyCode == Keys.Enter) { e.Handled = true; e.SuppressKeyPress = true; Accept(); }
            else if (e.KeyCode == Keys.Escape) { e.Handled = true; e.SuppressKeyPress = true; Cancel(); }
        }

        void Accept()
        {
            string v = (input.Text ?? "").Trim();
            if (v.Length == 0) { input.Focus(); return; }   // 空标签不提交
            Value = v;
            DialogResult = DialogResult.OK;   // 模态下会随之关闭
        }

        void Cancel()
        {
            DialogResult = DialogResult.Cancel;
        }

        // ---------------- 拖动（无边框窗口） ----------------

        void OnDragStart(object sender, MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Left) return;
            dragging = true;
            dragOffset = new Point(Cursor.Position.X - Location.X, Cursor.Position.Y - Location.Y);
            if (sender is Control) ((Control)sender).Capture = true;
        }

        void OnDragMove(object sender, MouseEventArgs e)
        {
            if (!dragging) return;
            Location = new Point(Cursor.Position.X - dragOffset.X, Cursor.Position.Y - dragOffset.Y);
        }

        void OnDragEnd(object sender, MouseEventArgs e)
        {
            dragging = false;
            if (sender is Control) ((Control)sender).Capture = false;
        }
    }
}
