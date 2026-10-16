using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace DocBoxTrans
{
    /// <summary>
    /// 独立「翻译历史」窗口：按时间倒序展示成功翻译记录（最新在顶部）。
    ///
    /// 外观与行为对齐结果浮窗：无边框圆角卡片、跟随主题配色；以「稻壳主窗口」为所有者，
    /// 只在稻壳之上置顶，切到其它软件时被其盖住（而非无条件 TopMost）。
    /// 关闭（✕）= 隐藏而非删除；显示/隐藏由翻译弹窗标题栏的「历史」按钮控制，并与配置状态同步。
    ///
    /// 布局采用绝对定位 + 手动滚动：卡片宽度由「窗体宽度」推导（不用 Dock 子控件宽度，
    /// 避免布局尚未完成时取到默认尺寸导致卡片过窄、文字被截断）。
    /// </summary>
    class HistoryForm : Form
    {
        // 设计基准尺寸（96 DPI）
        const int R_Radius = Native.DwmCornerBaseRadius, R_Pad = 12, R_Gap = 8, R_HeaderH = 46;
        const int R_Close = 24, R_MinW = 340, R_MaxW = 1000, R_MinH = 260, R_MaxH = 1200;

        readonly AppConfig cfg;
        readonly float S;
        readonly int Radius, Pad, Gap, HeaderH, CloseSize, MinW, MaxW, MinH, MaxH, GripSize;

        Color cBg, cCard, cBorder, cFg, cMuted, cFaint, cDivider;
        Color cAccent, cTrack, cHover, cChipBg;
        readonly Font fTitle, fMeta, fCap, fSource, fResult, fEmpty, fChip;

        Panel header;
        Label lblTitle, lblInfo, lblEmpty, lblChevron;
        RoundLabel btnClose;
        Panel scroll;
        ToolTip tips;

        // 顶部标签筛选栏（横向自动换行）：仅在存在标签时显示；「全部」= 不筛选。
        Panel filterBar;
        readonly List<RoundLabel> filterChips = new List<RoundLabel>();
        string activeTag;   // 当前筛选的标签；null = 显示全部

        // 来源文档过滤：非空时列表只显示该来源文档的记录（由 Program 在显示前按当前文档设置）；空串 = 不按文档过滤。
        string originFilter = "";

        readonly List<HistoryCard> cards = new List<HistoryCard>();

        IntPtr ownerHwnd;
        bool dwmCorners;
        bool relayouting;

        // 折叠状态：点击顶部标题栏可在「仅标题栏」与「展开」之间切换
        bool collapsed;
        Size expandedSize;

        bool dragging, resizing, dragMoved;
        Point dragOffset, dragStartCursor, resizeStartCursor;
        Size resizeStartSize;
        // 右下角缩放抓手：作为最顶层子控件接收鼠标，避免被列表/空态控件盖住导致无法缩放
        ResizeGrip grip;

        public HistoryForm(AppConfig config)
        {
            cfg = config;

            S = Native.DetectDpiScale();
            Radius = Px(R_Radius); Pad = Px(R_Pad); Gap = Px(R_Gap); HeaderH = Px(R_HeaderH);
            CloseSize = Px(R_Close); GripSize = Px(16);
            MinW = Px(R_MinW); MaxW = Px(R_MaxW); MinH = Px(R_MinH); MaxH = Px(R_MaxH);

            BuildPalette();

            fTitle = new Font("Microsoft YaHei UI", 10.5f, FontStyle.Bold);
            fMeta = new Font("Microsoft YaHei UI", 8.5f);
            fCap = new Font("Microsoft YaHei UI", 8f);
            fSource = new Font("Microsoft YaHei UI", 9f);
            fResult = new Font("Microsoft YaHei UI", 10.5f);
            fEmpty = new Font("Microsoft YaHei UI", 10f);
            fChip = new Font("Microsoft YaHei UI", 8.5f);

            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = false;                 // 归属稻壳，仅在其之上；不做无条件置顶
            StartPosition = FormStartPosition.Manual;   // 位置改为从配置恢复（无记录时才居中）
            KeyPreview = true;
            AutoScaleMode = AutoScaleMode.None;
            SetStyle(ControlStyles.ResizeRedraw | ControlStyles.AllPaintingInWmPaint
                | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer, true);

            tips = new ToolTip();
            tips.AutoPopDelay = 20000;
            tips.InitialDelay = 350;

            BuildHeader();

            scroll = new Panel();
            scroll.AutoScroll = true;
            scroll.BackColor = cBg;
            scroll.Resize += delegate { Relayout(); };
            scroll.HandleCreated += delegate { Native.ApplyScrollTheme(scroll.Handle, cfg.DarkTheme); };

            lblEmpty = new Label();
            lblEmpty.BackColor = cBg;
            lblEmpty.ForeColor = cFaint;
            lblEmpty.Font = fEmpty;
            lblEmpty.TextAlign = ContentAlignment.MiddleCenter;
            lblEmpty.Text = "暂无翻译记录";
            lblEmpty.Visible = false;

            // 顶部标签筛选栏（仅在有标签时显示）
            BuildFilterBar();

            // 全部采用绝对定位（见 Relayout）：不依赖 WinForms 的 Dock 顺序，
            // 避免 grip / 空态的 BringToFront 打乱停靠次序后列表与筛选栏互相覆盖。
            Controls.Add(scroll);
            Controls.Add(lblEmpty);
            Controls.Add(filterBar);
            Controls.Add(header);

            // 右下角缩放抓手：最后加入并置于最上层，scroll 等 Fill 控件不会盖住它（否则无法缩放）
            grip = new ResizeGrip();
            grip.Surround = cBg;
            grip.LineColor = cFaint;
            grip.Inset = Px(5);
            grip.Step = Px(4);
            grip.MouseDown += delegate(object s, MouseEventArgs me) { if (me.Button == MouseButtons.Left) BeginResize(); };
            grip.MouseMove += delegate { if (resizing) UpdateResize(); };
            grip.MouseUp += delegate { if (resizing) FinishResize(); };
            Controls.Add(grip);

            Size = ClampToScreen(new Size(Px(cfg.HistoryWidth), Px(cfg.HistoryHeight)));
            expandedSize = Size;
            Location = RestorePosition(Size);   // 恢复上次的位置；无记录时居中

            Shown += delegate { ApplyOwner(); Relayout(); };
        }

        int Px(int v) { return (int)Math.Round(v * S); }

        /// <summary>物理尺寸 → 逻辑尺寸（写回配置用，避免高 DPI 下被重复放大）。</summary>
        int UnPx(int px) { return (int)Math.Round(px / S); }

        /// <summary>把期望尺寸夹取到允许范围与当前屏幕工作区内。</summary>
        Size ClampToScreen(Size s)
        {
            int w = Clamp(s.Width, MinW, MaxW);
            int h = Clamp(s.Height, MinH, MaxH);
            Rectangle wa = Screen.FromPoint(Cursor.Position).WorkingArea;
            if (w > wa.Width) w = Math.Max(MinW, wa.Width);
            if (h > wa.Height) h = Math.Max(MinH, wa.Height);
            return new Size(w, h);
        }

        void BuildPalette()
        {
            if (cfg.DarkTheme)
            {
                cBg = Color.FromArgb(30, 31, 36);
                cCard = Color.FromArgb(43, 45, 52);
                cBorder = Color.FromArgb(58, 60, 70);
                cFg = Color.FromArgb(236, 237, 241);
                cMuted = Color.FromArgb(176, 178, 188);
                cFaint = Color.FromArgb(130, 132, 142);
                cDivider = Color.FromArgb(56, 58, 66);
                cAccent = Color.FromArgb(64, 132, 255);
                cTrack = Color.FromArgb(43, 45, 52);
                cHover = Color.FromArgb(54, 56, 65);
                cChipBg = Color.FromArgb(58, 60, 70);
            }
            else
            {
                cBg = Color.FromArgb(246, 247, 250);
                cCard = Color.FromArgb(255, 255, 255);
                cBorder = Color.FromArgb(226, 228, 234);
                cFg = Color.FromArgb(32, 34, 40);
                cMuted = Color.FromArgb(96, 99, 112);
                cFaint = Color.FromArgb(152, 155, 165);
                cDivider = Color.FromArgb(235, 236, 241);
                cAccent = Color.FromArgb(47, 107, 255);
                cTrack = Color.FromArgb(243, 244, 248);
                cHover = Color.FromArgb(233, 235, 242);
                cChipBg = Color.FromArgb(238, 240, 246);
            }
        }

        void BuildHeader()
        {
            header = new Panel();
            header.Dock = DockStyle.None;   // 位置由 Relayout 绝对定位
            header.Height = HeaderH;
            header.BackColor = cBg;
            header.MouseDown += delegate { StartDrag(); };

            lblTitle = new Label();
            lblTitle.Text = "翻译历史";
            lblTitle.Font = fTitle;
            lblTitle.ForeColor = cFg;
            lblTitle.BackColor = cBg;
            lblTitle.AutoSize = false;
            lblTitle.TextAlign = ContentAlignment.MiddleLeft;
            lblTitle.Cursor = Cursors.SizeAll;
            lblTitle.MouseDown += delegate { StartDrag(); };

            lblInfo = new Label();
            lblInfo.Font = fMeta;
            lblInfo.ForeColor = cFaint;
            lblInfo.BackColor = cBg;
            lblInfo.AutoSize = false;
            lblInfo.TextAlign = ContentAlignment.MiddleLeft;

            btnClose = new RoundLabel();
            btnClose.Radius = Px(6);
            btnClose.Surround = cBg;
            btnClose.FillColor = Color.Transparent;
            btnClose.Text = "✕";
            btnClose.ForeColor = cMuted;
            btnClose.Font = new Font("Segoe UI", 9.5f);
            btnClose.Align = ContentAlignment.MiddleCenter;
            btnClose.Cursor = Cursors.Hand;
            btnClose.Click += delegate { HideAndSync(); };
            btnClose.MouseEnter += delegate { btnClose.FillColor = Color.FromArgb(214, 58, 63); btnClose.ForeColor = Color.White; };
            btnClose.MouseLeave += delegate { btnClose.FillColor = Color.Transparent; btnClose.ForeColor = cMuted; };

            // 折叠指示（▾ 展开 / ▸ 已折叠）：点击顶部标题栏即可切换；这里挂 MouseDown 以复用拖动判定
            lblChevron = new Label();
            lblChevron.Text = "▾";
            lblChevron.Font = new Font("Segoe UI", 9f);
            lblChevron.ForeColor = cMuted;
            lblChevron.BackColor = cBg;
            lblChevron.AutoSize = false;
            lblChevron.TextAlign = ContentAlignment.MiddleCenter;
            lblChevron.Cursor = Cursors.Hand;
            lblChevron.MouseDown += delegate { StartDrag(); };

            header.Controls.Add(lblTitle);
            header.Controls.Add(lblInfo);
            header.Controls.Add(lblChevron);
            header.Controls.Add(btnClose);
        }

        // ---------------- 顶部标签筛选栏 ----------------

        void BuildFilterBar()
        {
            filterBar = new Panel();
            filterBar.Dock = DockStyle.None;   // 位置由 Relayout 绝对定位
            filterBar.BackColor = cBg;
            filterBar.Height = 0;
            filterBar.Visible = false;   // 无标签时不占用空间
            filterBar.HandleCreated += delegate { Native.ApplyScrollTheme(filterBar.Handle, cfg.DarkTheme); };
        }

        /// <summary>按当前标签集合重建筛选栏；集合为空时隐藏筛选栏并清除筛选。</summary>
        void RebuildFilterBar()
        {
            if (collapsed) { filterBar.Visible = false; return; }   // 折叠态不显示筛选栏

            List<string> all = HistoryStore.AllTags();
            if (activeTag != null && !ContainsTag(all, activeTag)) activeTag = null;   // 所选标签已不存在

            for (int i = 0; i < filterChips.Count; i++)
            {
                filterBar.Controls.Remove(filterChips[i]);
                filterChips[i].Dispose();
            }
            filterChips.Clear();

            if (all.Count == 0)
            {
                filterBar.Visible = false;
                filterBar.Height = 0;
                return;
            }

            filterBar.Visible = true;
            AddFilterChip("全部", null);
            for (int i = 0; i < all.Count; i++) AddFilterChip(all[i], all[i]);
            LayoutFilterChips();
        }

        /// <summary>创建一个筛选胶囊；tagValue 为 null 表示「全部」。</summary>
        void AddFilterChip(string text, string tagValue)
        {
            bool selected = tagValue == null
                ? activeTag == null
                : string.Equals(activeTag, tagValue, StringComparison.OrdinalIgnoreCase);

            RoundLabel l = new RoundLabel();
            int chipH = Px(22);
            l.Radius = Math.Max(2, (chipH - 1) / 2);   // 胶囊：半径取到 (高-1)/2 以内，避免退化为方角
            l.Surround = cBg;
            l.FillColor = selected ? cAccent : cTrack;
            l.ForeColor = selected ? Color.White : cMuted;
            l.Font = fChip;
            l.Text = text;
            l.Align = ContentAlignment.MiddleCenter;
            l.Cursor = Cursors.Hand;
            l.Size = new Size(TextRenderer.MeasureText(text, fChip).Width + Px(20), chipH);
            l.Click += delegate { SetFilter(tagValue); };
            if (!selected)
            {
                l.MouseEnter += delegate { l.FillColor = cHover; l.ForeColor = cFg; };
                l.MouseLeave += delegate { l.FillColor = cTrack; l.ForeColor = cMuted; };
            }
            filterChips.Add(l);
            filterBar.Controls.Add(l);
        }

        /// <summary>按窗体宽度把筛选胶囊横向换行排布，并把筛选栏高度设为所需高度。</summary>
        void LayoutFilterChips()
        {
            if (filterBar == null) return;
            int w = ClientSize.Width;
            if (w <= 0) return;

            int padX = Pad, padTop = Px(2), padBottom = Px(4);
            int gapX = Gap, gapY = Px(4);
            int innerW = Math.Max(Px(80), w - padX * 2);
            int chipH = filterChips.Count > 0 ? filterChips[0].Height : Px(22);

            int x = padX, y = padTop;
            for (int i = 0; i < filterChips.Count; i++)
            {
                RoundLabel c = filterChips[i];
                if (x > padX && x + c.Width > padX + innerW) { x = padX; y += chipH + gapY; }
                c.SetBounds(x, y, c.Width, chipH);
                x += c.Width + gapX;
            }

            int h = filterChips.Count == 0 ? 0 : y + chipH + padBottom;
            if (filterBar.Height != h) filterBar.Height = h;
        }

        /// <summary>设置当前筛选标签：点击已选中的标签会取消筛选（回到「全部」）。</summary>
        void SetFilter(string tag)
        {
            if (!IsHandleCreated) return;
            // 延迟到本次点击事件处理结束后再重建（会销毁被点击的胶囊），避免在控件自身事件里销毁它
            BeginInvoke((Action)delegate
            {
                string next = tag;
                if (next != null && string.Equals(next, activeTag, StringComparison.OrdinalIgnoreCase)) next = null;
                activeTag = next;
                RefreshList(true);
            });
        }

        static bool ContainsTag(List<string> list, string tag)
        {
            for (int i = 0; i < list.Count; i++)
                if (string.Equals(list[i], tag, StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }

        // ---------------- 所有者（只在稻壳之上置顶） ----------------

        /// <summary>设置归属窗口（稻壳主窗口）；为 0 时退回无条件置顶（调试/稻壳未运行）。</summary>
        public void SetOwnerWindow(IntPtr hwnd)
        {
            ownerHwnd = hwnd;
            ApplyOwner();
        }

        void ApplyOwner()
        {
            if (!IsHandleCreated) return;
            if (ownerHwnd == IntPtr.Zero)
            {
                TopMost = true;
                return;
            }
            TopMost = false;
            Native.SetOwner(Handle, ownerHwnd);
        }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= 0x00000080; // WS_EX_TOOLWINDOW：不进 Alt+Tab（由托盘菜单控制显隐）
                return cp;
            }
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            ApplyWindowChrome();
            ApplyOwner();
        }

        protected override void OnSizeChanged(EventArgs e)
        {
            base.OnSizeChanged(e);
            ApplyWindowChrome();
        }

        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            Relayout();
        }

        /// <summary>优先用 Win11 DWM 抗锯齿圆角；不可用时退回 Region 裁剪。</summary>
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

        // ---------------- 绘制 ----------------

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;

            using (SolidBrush b = new SolidBrush(cBg))
                g.FillRectangle(b, ClientRectangle);

            using (GraphicsPath path = Native.RoundPath(new Rectangle(0, 0, Width - 1, Height - 1), Radius))
            using (Pen p = new Pen(cBorder, Math.Max(1f, S)))
            {
                p.Alignment = PenAlignment.Inset;
                g.DrawPath(p, path);
            }
        }

        // ---------------- 列表 ----------------

        /// <summary>按来源文档过滤：非空时列表只显示该文档的记录（Program 在显示前按当前文档设置）。</summary>
        public string OriginFilter
        {
            get { return originFilter; }
            set { originFilter = value ?? ""; }
        }

        /// <summary>重新从存储读取并渲染列表（最新在顶部）。</summary>
        public void RefreshList()
        {
            RefreshList(false);
        }

        /// <summary>keepScroll=true 时保留当前滚动位置（删除单条记录后不跳回顶部）。</summary>
        public void RefreshList(bool keepScroll)
        {
            int keepY = 0;
            if (keepScroll && scroll.Visible)
            {
                try { keepY = -scroll.AutoScrollPosition.Y; } catch { keepY = 0; }
            }

            List<HistoryRecord> all = HistoryStore.Snapshot();
            RebuildFilterBar();   // 标签集合可能已变化；必要时会重置 activeTag

            // 按「来源文档」与当前筛选标签过滤（activeTag 为 null = 不按标签筛选）
            bool docFilter = !string.IsNullOrEmpty(originFilter);
            List<HistoryRecord> recs = all;
            if (docFilter || activeTag != null)
            {
                recs = new List<HistoryRecord>();
                for (int i = 0; i < all.Count; i++)
                {
                    if (docFilter && !string.Equals(all[i].Origin ?? "", originFilter, StringComparison.Ordinal)) continue;
                    if (activeTag != null && !all[i].HasTag(activeTag)) continue;
                    recs.Add(all[i]);
                }
            }

            scroll.SuspendLayout();
            for (int i = 0; i < cards.Count; i++) cards[i].Dispose();
            cards.Clear();
            scroll.Controls.Clear();

            HistoryCard.Skin skin = BuildSkin();
            for (int i = 0; i < recs.Count; i++)
            {
                HistoryCard card = new HistoryCard(skin, recs[i], tips);
                card.DeleteClicked += OnCardDelete;
                card.TagsChanged += OnCardTagsChanged;
                cards.Add(card);
                scroll.Controls.Add(card);
            }
            scroll.ResumeLayout();

            if (activeTag == null)
                lblInfo.Text = docFilter
                    ? "本篇 " + recs.Count + " 条 · 共 " + all.Count + " 条记录"
                    : "共 " + all.Count + " 条记录 · 最多保留 " + Math.Max(1, cfg.HistoryMax) + " 条";
            else
                lblInfo.Text = "标签「" + activeTag + "」" + recs.Count + " 条 · " + (docFilter ? "本篇" : "共") + " " + all.Count + " 条";
            if (recs.Count == 0 && docFilter && activeTag == null) lblEmpty.Text = "本篇暂无翻译记录";
            else lblEmpty.Text = (all.Count > 0 && recs.Count == 0) ? "该标签下暂无记录" : "暂无翻译记录";
            LayoutHeader();
            Relayout();
            scroll.AutoScrollPosition = new Point(0, keepScroll ? keepY : 0);
        }

        /// <summary>某条记录被删除时触发（参数为记录 id）；Program 据此从会话上下文中同步移除。</summary>
        public event Action<string> RecordDeleted;

        /// <summary>用户点某条记录上的「删除」：删除存储并刷新列表。</summary>
        void OnCardDelete(HistoryRecord rec)
        {
            if (rec == null) return;
            if (!IsHandleCreated) { DoDelete(rec); return; }
            // 延迟到本次点击事件处理结束后再删除并重建列表，避免在控件自身的事件里销毁它
            BeginInvoke((Action)delegate { DoDelete(rec); });
        }

        void DoDelete(HistoryRecord rec)
        {
            HistoryStore.Delete(rec.Id);
            Action<string> h = RecordDeleted;
            if (h != null) h(rec.Id);
            RefreshList(true);
        }

        /// <summary>某条记录的标签发生增删：重建筛选栏，并在其不再符合当前筛选时刷新列表。</summary>
        void OnCardTagsChanged(HistoryRecord rec)
        {
            if (!IsHandleCreated) return;
            // 延迟到本次点击事件处理结束后再重建列表，避免在控件自身的事件里销毁它
            BeginInvoke((Action)delegate { RefreshList(true); });
        }

        /// <summary>按当前窗体宽度绝对定位各区域并重排卡片（不依赖 Dock 顺序）。</summary>
        void Relayout()
        {
            if (relayouting) return;
            relayouting = true;
            try
            {
                int w = ClientSize.Width, h = ClientSize.Height;

                header.SetBounds(0, 0, w, HeaderH);
                LayoutHeader();

                if (collapsed)
                {
                    scroll.Visible = false;
                    lblEmpty.Visible = false;
                    if (grip != null) grip.Visible = false;
                    return;
                }

                // 筛选栏按窗体宽度重新换行（其高度自适应），再据其高度定位下方列表
                if (filterBar != null && filterBar.Visible) LayoutFilterChips();
                int barH = (filterBar != null && filterBar.Visible) ? filterBar.Height : 0;
                if (filterBar != null) filterBar.SetBounds(0, HeaderH, w, barH);

                int listTop = HeaderH + barH;
                int listH = Math.Max(0, h - listTop);
                scroll.SetBounds(0, listTop, w, listH);
                lblEmpty.SetBounds(0, listTop, w, listH);

                // 抓手区域始终有效（即便当前没有卡片也能缩放窗口），并置于最上层避免被 scroll 盖住。
                // 注意：构造函数里 Controls.Add 会触发一次布局（进而调用本方法），而抓手是最后创建的，
                // 因此这里必须容忍 grip 尚未创建 / 尚未挂到窗体上的情况。
                if (grip != null)
                {
                    grip.Visible = true;
                    grip.SetBounds(w - GripSize, h - GripSize, GripSize, GripSize);
                    if (grip.Parent != null) grip.BringToFront();
                }

                if (cards.Count == 0)
                {
                    scroll.Visible = false;
                    lblEmpty.Visible = true;
                    lblEmpty.BringToFront();
                    return;
                }
                lblEmpty.Visible = false;
                scroll.Visible = true;

                // 用「窗体宽度」推导卡片宽度：不随滚动条出现/消失变化，避免布局抖动
                int innerW = ClientSize.Width - Pad * 2 - SystemInformation.VerticalScrollBarWidth;
                if (innerW < Px(160)) innerW = Px(160);

                int y = Pad;
                for (int i = 0; i < cards.Count; i++)
                {
                    HistoryCard c = cards[i];
                    c.SetCardWidth(innerW);
                    c.SetBounds(Pad, y, innerW, c.Height);
                    y += c.Height + Gap;
                }
                scroll.AutoScrollMinSize = new Size(0, y + Pad);
                // 滚动条出现/消失后再次应用深色主题，避免又变回浅色
                if (scroll.IsHandleCreated) Native.ApplyScrollTheme(scroll.Handle, cfg.DarkTheme);
            }
            finally { relayouting = false; }
        }

        void LayoutHeader()
        {
            // 用窗体宽度而非 header.Width：布局尚未完成时 header.Width 可能还是默认值
            int w = ClientSize.Width;
            int y = Pad;
            int infoH = fMeta.Height + Px(2);
            int titleH = Math.Max(Px(20), HeaderH - Pad * 2 - infoH);

            btnClose.SetBounds(w - Pad - CloseSize, y + (titleH - CloseSize) / 2, CloseSize, CloseSize);
            int chevW = Math.Max(Px(16), CloseSize - Px(2));
            lblChevron.SetBounds(btnClose.Left - Px(4) - chevW, y + (titleH - chevW) / 2, chevW, chevW);
            int textW = Math.Max(Px(60), lblChevron.Left - Px(8) - Pad);
            lblTitle.SetBounds(Pad, y, textW, titleH);
            lblInfo.SetBounds(Pad, y + titleH, textW, infoH);
        }

        HistoryCard.Skin BuildSkin()
        {
            HistoryCard.Skin skin = new HistoryCard.Skin();
            skin.Card = cCard;
            skin.Fg = cFg;
            skin.Muted = cMuted;
            skin.Faint = cFaint;
            skin.Divider = cDivider;
            skin.Meta = fMeta;
            skin.Cap = fCap;
            skin.Source = fSource;
            skin.Result = fResult;
            skin.Pad = Pad;
            skin.Gap = Gap;
            skin.Radius = Radius;
            skin.Hover = cHover;
            skin.ChipBg = cChipBg;
            skin.ChipFg = cMuted;
            skin.ChipFont = fChip;
            return skin;
        }

        /// <summary>隐藏窗口并把可见状态同步给 Program（菜单勾选随之为未勾选）。</summary>
        void HideAndSync()
        {
            Hide();
            Action h = HiddenByUser;
            if (h != null) h();
        }

        /// <summary>用户通过 ✕ 关闭窗口时触发（Program 据此写回配置）。</summary>
        public event Action HiddenByUser;

        // ---------------- 移动 / 缩放 ----------------

        void StartDrag()
        {
            dragging = true;
            dragMoved = false;
            dragStartCursor = Cursor.Position;
            dragOffset = new Point(Cursor.Position.X - Location.X, Cursor.Position.Y - Location.Y);
            Capture = true;
        }

        /// <summary>顶部标题栏单击（未发生拖动）：在「折叠为仅标题栏」与「展开」之间切换。</summary>
        void ToggleCollapse()
        {
            if (collapsed) Expand(); else Collapse();
        }

        void Collapse()
        {
            if (collapsed) return;
            expandedSize = ClientSize;
            collapsed = true;
            lblChevron.Text = "▸";
            scroll.Visible = false;
            lblEmpty.Visible = false;
            if (filterBar != null) filterBar.Visible = false;
            ClientSize = new Size(ClientSize.Width, HeaderH);   // 仅保留标题栏
        }

        void Expand()
        {
            if (!collapsed) return;
            collapsed = false;
            lblChevron.Text = "▾";
            ClientSize = new Size(Math.Max(expandedSize.Width, MinW), Math.Max(expandedSize.Height, MinH));
            RefreshList(true);   // 重新计算标签筛选栏可见性与换行，并恢复列表
        }

        /// <summary>确保展开（重新显示窗口时调用）：折叠状态不跨「显示/隐藏」保留。</summary>
        public void EnsureExpanded()
        {
            if (collapsed) Expand();
        }

        /// <summary>把当前展开尺寸与窗口位置写回配置（尺寸换算回设计像素），下次打开按此复用。</summary>
        void SavePlacement()
        {
            if (collapsed) return;
            try
            {
                cfg.HistoryWidth = UnPx(ClientSize.Width);
                cfg.HistoryHeight = UnPx(ClientSize.Height);
                AppConfig.SetValue(cfg.Path, "history_width", cfg.HistoryWidth.ToString());
                AppConfig.SetValue(cfg.Path, "history_height", cfg.HistoryHeight.ToString());
                cfg.HistoryPos = Location.X + "," + Location.Y;
                AppConfig.SetValue(cfg.Path, "history_pos", cfg.HistoryPos);
            }
            catch { }
        }

        /// <summary>从配置恢复窗口位置；无记录或解析失败时在鼠标所在屏幕居中。</summary>
        Point RestorePosition(Size size)
        {
            Point saved;
            if (TryParsePos(cfg.HistoryPos, out saved)) return ClampPosition(saved, size);
            Rectangle wa = Screen.FromPoint(Cursor.Position).WorkingArea;
            return new Point(wa.Left + (wa.Width - size.Width) / 2, wa.Top + (wa.Height - size.Height) / 2);
        }

        /// <summary>把窗口位置夹取到某块屏幕的工作区内（多屏移除/分辨率变化后依然可见）。</summary>
        static Point ClampPosition(Point p, Size size)
        {
            Rectangle wa = Screen.FromPoint(p).WorkingArea;
            int x = p.X, y = p.Y;
            if (x + size.Width > wa.Right) x = wa.Right - size.Width;
            if (y + size.Height > wa.Bottom) y = wa.Bottom - size.Height;
            if (x < wa.Left) x = wa.Left;
            if (y < wa.Top) y = wa.Top;
            return new Point(x, y);
        }

        /// <summary>解析配置里的位置（"x,y"）；为空或格式不合法返回 false。</summary>
        static bool TryParsePos(string s, out Point p)
        {
            p = Point.Empty;
            if (string.IsNullOrEmpty(s)) return false;
            string[] parts = s.Split(',');
            int x, y;
            if (parts.Length != 2) return false;
            if (!int.TryParse(parts[0].Trim(), out x)) return false;
            if (!int.TryParse(parts[1].Trim(), out y)) return false;
            p = new Point(x, y);
            return true;
        }

        // ---------------- 右下角抓手缩放 ----------------
        // 抓手是最顶层的子控件 ResizeGrip，鼠标事件由它接收；这里只做尺寸计算并在结束时写回配置。

        void BeginResize()
        {
            resizing = true;
            resizeStartCursor = Cursor.Position;
            resizeStartSize = ClientSize;
            grip.Capture = true;
        }

        void UpdateResize()
        {
            int nw = Clamp(resizeStartSize.Width + (Cursor.Position.X - resizeStartCursor.X), MinW, MaxW);
            int nh = Clamp(resizeStartSize.Height + (Cursor.Position.Y - resizeStartCursor.Y), MinH, MaxH);
            ClientSize = new Size(nw, nh);
        }

        void FinishResize()
        {
            resizing = false;
            grip.Capture = false;
            SavePlacement();   // 记住本次调整的宽高与位置
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button != MouseButtons.Left) return;
            if (e.Y <= Pad + HeaderH) StartDrag();
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            if (!dragging) return;
            if (!dragMoved)
            {
                int dx = Math.Abs(Cursor.Position.X - dragStartCursor.X);
                int dy = Math.Abs(Cursor.Position.Y - dragStartCursor.Y);
                if (Math.Max(dx, dy) < 4) return;   // 未超过阈值：仍视为单击
                dragMoved = true;
            }
            Location = new Point(Cursor.Position.X - dragOffset.X, Cursor.Position.Y - dragOffset.Y);
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            if (!dragging) return;
            dragging = false;
            Capture = false;
            if (dragMoved) SavePlacement();   // 拖动结束后记住窗口位置
            else ToggleCollapse();            // 顶部单击 = 折叠 / 展开
        }

        static int Clamp(int v, int lo, int hi)
        {
            if (v < lo) return lo;
            if (v > hi) return hi;
            return v;
        }

        /// <summary>一张历史记录卡片：时间 + 原文（两行省略） + 分隔线 + 译文（完整换行）。</summary>
        public class HistoryCard : Panel
        {
            public class Skin
            {
                public Color Card, Fg, Muted, Faint, Divider;
                public Color Hover;      // 「标签」按钮悬停底色
                public Color ChipBg, ChipFg;   // 卡片标签胶囊的底色/文字色
                public Font Meta, Cap, Source, Result, ChipFont;
                public int Pad, Gap, Radius;
            }

            readonly Skin skin;
            readonly HistoryRecord rec;

            readonly Label lblMeta, lblSrcCap, lblSource, sep, lblResCap, lblResult;
            RoundLabel btnDel, btnTag;
            readonly List<RoundLabel> tagChips = new List<RoundLabel>();
            int width;
            int delW, delH, tagW, tagH;

            /// <summary>点按卡片右上角「删除」时触发（参数为本条记录）。</summary>
            public event Action<HistoryRecord> DeleteClicked;

            /// <summary>本记录的标签被增删后触发；由宿主重建筛选栏与列表。</summary>
            public event Action<HistoryRecord> TagsChanged;

            public HistoryCard(Skin skin, HistoryRecord record, ToolTip tooltip)
            {
                this.skin = skin;
                this.rec = record;
                this.width = 300;

                BackColor = skin.Card;
                SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint, true);

                string meta = string.IsNullOrEmpty(record.CreatedAt) ? "" : record.CreatedAt;
                string prov = Translator.DisplayName(record.Provider);
                if (!string.IsNullOrEmpty(prov)) meta = (meta.Length == 0 ? prov : meta + " · " + prov);

                lblMeta = MakeLabel(meta, skin.Meta, skin.Faint);
                lblSrcCap = MakeLabel("原文", skin.Cap, skin.Faint);
                lblSource = MakeLabel("", skin.Source, skin.Muted);
                lblResCap = MakeLabel("译文", skin.Cap, skin.Faint);
                lblResult = MakeLabel("", skin.Result, skin.Fg);

                sep = new Label();
                sep.BackColor = skin.Divider;

                // 右上角「删除」按钮（悬停变红）
                btnDel = new RoundLabel();
                btnDel.Radius = skin.Radius;
                btnDel.Surround = skin.Card;
                btnDel.FillColor = Color.Transparent;
                btnDel.Text = "删除";
                btnDel.ForeColor = skin.Faint;
                btnDel.Font = skin.Cap;
                btnDel.Align = ContentAlignment.MiddleCenter;
                btnDel.Cursor = Cursors.Hand;
                btnDel.Click += delegate
                {
                    Action<HistoryRecord> h = DeleteClicked;
                    if (h != null) h(rec);
                };
                btnDel.MouseEnter += delegate { btnDel.FillColor = Color.FromArgb(214, 58, 63); btnDel.ForeColor = Color.White; };
                btnDel.MouseLeave += delegate { btnDel.FillColor = Color.Transparent; btnDel.ForeColor = skin.Faint; };
                delW = TextRenderer.MeasureText("删除", skin.Cap).Width + skin.Pad;
                delH = Math.Max(skin.Cap.Height + 4, skin.Meta.Height);

                // 右上角「标签」按钮（悬停变色）：点按弹出标签菜单（勾选已有标签 / 新建 / 清除）
                btnTag = new RoundLabel();
                btnTag.Radius = skin.Radius;
                btnTag.Surround = skin.Card;
                btnTag.FillColor = Color.Transparent;
                btnTag.Text = "标签";
                btnTag.ForeColor = skin.Faint;
                btnTag.Font = skin.Cap;
                btnTag.Align = ContentAlignment.MiddleCenter;
                btnTag.Cursor = Cursors.Hand;
                btnTag.Click += delegate { ShowTagMenu(); };
                btnTag.MouseEnter += delegate { btnTag.FillColor = skin.Hover; btnTag.ForeColor = skin.Fg; };
                btnTag.MouseLeave += delegate { btnTag.FillColor = Color.Transparent; btnTag.ForeColor = skin.Faint; };
                tagW = TextRenderer.MeasureText("标签", skin.Cap).Width + skin.Pad;
                tagH = delH;

                Controls.Add(lblMeta);
                Controls.Add(lblSrcCap);
                Controls.Add(lblSource);
                Controls.Add(sep);
                Controls.Add(lblResCap);
                Controls.Add(lblResult);
                Controls.Add(btnTag);
                Controls.Add(btnDel);

                if (tooltip != null && !string.IsNullOrEmpty(record.SourceText))
                    tooltip.SetToolTip(lblSource, record.SourceText);

                RebuildTagChips();
                LayoutCard();
            }

            // ---------------- 标签 ----------------

            /// <summary>重建卡片上的标签胶囊（只显示，位置由 LayoutCard 计算）。</summary>
            void RebuildTagChips()
            {
                for (int i = 0; i < tagChips.Count; i++)
                {
                    Controls.Remove(tagChips[i]);
                    tagChips[i].Dispose();
                }
                tagChips.Clear();
                if (rec.Tags == null) return;

                int chipH = Math.Max(skin.Cap.Height + skin.Pad / 2, 18);
                for (int i = 0; i < rec.Tags.Count; i++)
                {
                    string t = rec.Tags[i] == null ? "" : rec.Tags[i].Trim();
                    if (t.Length == 0) continue;
                    RoundLabel c = new RoundLabel();
                    c.Radius = Math.Max(2, (chipH - 1) / 2);   // 胶囊圆角
                    c.Surround = skin.Card;
                    c.FillColor = skin.ChipBg;
                    c.ForeColor = skin.ChipFg;
                    c.Font = skin.ChipFont;
                    c.Text = t;
                    c.Align = ContentAlignment.MiddleCenter;
                    c.Size = new Size(TextRenderer.MeasureText(t, skin.ChipFont).Width + skin.Pad, chipH);
                    tagChips.Add(c);
                    Controls.Add(c);
                }
            }

            /// <summary>点「标签」按钮后弹出的菜单：勾选已有标签、新建标签、清除标签。</summary>
            void ShowTagMenu()
            {
                ContextMenuStrip menu = new ContextMenuStrip();
                List<string> all = HistoryStore.AllTags();
                for (int i = 0; i < all.Count; i++)
                {
                    string tag = all[i];
                    ToolStripMenuItem it = new ToolStripMenuItem(tag);
                    it.Checked = rec.HasTag(tag);
                    it.CheckOnClick = false;
                    it.Click += delegate { ToggleTag(tag); };
                    menu.Items.Add(it);
                }
                if (all.Count > 0) menu.Items.Add(new ToolStripSeparator());

                ToolStripMenuItem add = new ToolStripMenuItem("新建标签…");
                // 延迟到菜单关闭后再弹输入框，避免与菜单的关闭流程相互干扰
                add.Click += delegate
                {
                    Form f = FindForm();
                    if (f != null) f.BeginInvoke((Action)PromptNewTag);
                    else PromptNewTag();
                };
                menu.Items.Add(add);

                if (rec.Tags != null && rec.Tags.Count > 0)
                {
                    ToolStripMenuItem clr = new ToolStripMenuItem("清除标签");
                    clr.Click += delegate { ClearTags(); };
                    menu.Items.Add(clr);
                }

                // 关闭后再释放菜单：不能在 Closed 事件里直接 Dispose。此时下拉菜单仍在收尾，
                // ToolStripManager 会再次访问其句柄（ReparentToDropDownOwnerWindow → CreateHandle），
                // 对已释放对象抛 ObjectDisposedException，最终以「未处理异常」使进程退出。
                // 因此改到关闭处理结束之后（下一条消息）再释放。
                menu.Closed += delegate { DisposeMenuLater(menu); };
                menu.Show(btnTag, new Point(0, btnTag.Height));
            }

            /// <summary>把菜单的释放推迟到关闭流程结束之后执行（见 ShowTagMenu 的说明）。</summary>
            void DisposeMenuLater(ContextMenuStrip menu)
            {
                Form f = FindForm();
                if (f != null && f.IsHandleCreated)
                {
                    try { f.BeginInvoke((Action)delegate { try { menu.Dispose(); } catch { } }); return; }
                    catch { }
                }
                try { menu.Dispose(); } catch { }
            }

            void ToggleTag(string tag)
            {
                if (rec.HasTag(tag)) HistoryStore.RemoveTag(rec.Id, tag);
                else HistoryStore.AddTag(rec.Id, tag);
                RebuildTagChips();
                LayoutCard();
                NotifyTagsChanged();
            }

            void PromptNewTag()
            {
                // 以历史窗口为 owner，弹出与该窗口同主题的输入框
                string v = TagPromptForm.Prompt(FindForm(), "新建标签", "", IsDarkCard());
                v = v == null ? null : v.Trim();
                if (string.IsNullOrEmpty(v)) return;
                HistoryStore.AddTag(rec.Id, v);
                RebuildTagChips();
                LayoutCard();
                NotifyTagsChanged();
            }

            /// <summary>卡片底色较暗即视为深色主题（用于让标签输入框配色一致）。</summary>
            bool IsDarkCard()
            {
                return skin.Card.GetBrightness() < 0.5f;
            }

            void ClearTags()
            {
                HistoryStore.ClearTags(rec.Id);
                RebuildTagChips();
                LayoutCard();
                NotifyTagsChanged();
            }

            void NotifyTagsChanged()
            {
                Action<HistoryRecord> h = TagsChanged;
                if (h != null) h(rec);
            }

            static Label MakeLabel(string text, Font font, Color fore)
            {
                Label l = new Label();
                l.Text = text;
                l.Font = font;
                l.ForeColor = fore;
                l.BackColor = Color.Transparent;
                l.AutoSize = false;
                l.TextAlign = ContentAlignment.TopLeft;
                return l;
            }

            public void SetCardWidth(int w)
            {
                if (w < 80 || w == width) return;
                width = w;
                LayoutCard();
            }

            void LayoutCard()
            {
                int pad = skin.Pad;
                int innerW = Math.Max(40, width - pad * 2);
                int divH = Math.Max(1, pad / 12);

                int lineSource = LineHeight(skin.Source);
                int lineResult = LineHeight(skin.Result);

                // 原文：两行省略（不无限扩展）
                string srcShown = ClampToLines(rec.SourceText, skin.Source, innerW, 2);
                int srcH = Math.Max(lineSource, MeasureH(srcShown, skin.Source, innerW));

                // 译文：完整展示、自动换行
                string resText = rec.TranslatedText == null ? "" : rec.TranslatedText;
                int resH = Math.Max(lineResult, MeasureH(resText, skin.Result, innerW));

                int capH = skin.Cap.Height;
                int metaH = skin.Meta.Height;

                int y = pad;
                int rowH = Math.Max(Math.Max(metaH, delH), tagH);
                int btnRowW = delW + skin.Gap + tagW;
                lblMeta.TextAlign = ContentAlignment.MiddleLeft;
                lblMeta.SetBounds(pad, y, Math.Max(40, innerW - btnRowW - skin.Gap), rowH);
                btnDel.SetBounds(pad + innerW - delW, y + (rowH - delH) / 2, delW, delH);
                btnTag.SetBounds(btnDel.Left - skin.Gap - tagW, y + (rowH - tagH) / 2, tagW, tagH);
                y += rowH + skin.Gap;

                // 标签胶囊：自动换行排布（位于时间行之下、原文标题之上）
                if (tagChips.Count > 0)
                {
                    int chipH = tagChips[0].Height;
                    int cgx = Math.Max(4, skin.Gap / 2);
                    int cx = pad, cy = y;
                    for (int i = 0; i < tagChips.Count; i++)
                    {
                        RoundLabel chip = tagChips[i];
                        if (cx > pad && cx + chip.Width > pad + innerW) { cx = pad; cy += chipH + cgx; }
                        chip.SetBounds(cx, cy, chip.Width, chipH);
                        cx += chip.Width + cgx;
                    }
                    y = cy + chipH + skin.Gap;
                }

                lblSrcCap.SetBounds(pad, y, innerW, capH);
                y += capH;
                lblSource.Text = srcShown;
                lblSource.SetBounds(pad, y, innerW, srcH);
                y += srcH + skin.Gap;

                sep.SetBounds(pad, y, innerW, divH);
                y += divH + skin.Gap;

                lblResCap.SetBounds(pad, y, innerW, capH);
                y += capH;
                lblResult.Text = resText;
                lblResult.SetBounds(pad, y, innerW, resH);
                y += resH + pad;

                Height = y;
            }

            static int LineHeight(Font font)
            {
                return TextRenderer.MeasureText("测", font, new Size(int.MaxValue, int.MaxValue),
                    TextFormatFlags.SingleLine).Height;
            }

            static int MeasureH(string text, Font font, int width)
            {
                if (string.IsNullOrEmpty(text)) return 0;
                return TextRenderer.MeasureText(text, font, new Size(width, int.MaxValue),
                    TextFormatFlags.WordBreak).Height;
            }

            /// <summary>把文本折叠为单行流并以不超过 maxLines 行显示，超出追加省略号。</summary>
            static string ClampToLines(string text, Font font, int width, int maxLines)
            {
                if (string.IsNullOrEmpty(text)) return "";
                string t = text.Replace("\r\n", " ").Replace('\n', ' ').Replace('\r', ' ').Trim();
                while (t.IndexOf("  ") >= 0) t = t.Replace("  ", " ");

                int maxH = LineHeight(font) * maxLines;
                if (MeasureH(t, font, width) <= maxH) return t;

                int lo = 0, hi = t.Length, best = 0;
                while (lo <= hi)
                {
                    int mid = (lo + hi) / 2;
                    string sub = t.Substring(0, mid) + "…";
                    if (MeasureH(sub, font, width) <= maxH) { best = mid; lo = mid + 1; }
                    else hi = mid - 1;
                }
                return t.Substring(0, best).TrimEnd() + "…";
            }
        }
    }
}