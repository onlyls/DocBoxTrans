using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace DocBoxTrans
{
    /// <summary>
    /// 抗锯齿圆角块：用 GDI+ 平滑绘制圆角与文字，替代过去用 Region 裁剪的办法。
    /// Region 裁剪是 1 位（非抗锯齿）的，圆角处会出现台阶状锯齿，在高 DPI 缩放后尤其明显（即“颗粒感”）。
    ///
    /// 控件自身矩形里“圆角之外”需要露出父级底色，因此用 <see cref="Surround"/> 指定该底色
    /// （卡片底或胶囊轨道底），先铺满再叠画圆角填充，从而无需依赖 WinForms 的透明背景机制。
    /// </summary>
    class RoundLabel : Control
    {
        int radius = 6;
        Color surround = Color.White;
        Color fillColor = Color.Transparent;
        ContentAlignment align = ContentAlignment.MiddleCenter;

        /// <summary>圆角半径（像素，已按 DPI 换算）。</summary>
        public int Radius
        {
            get { return radius; }
            set { if (radius != value) { radius = value; Invalidate(); } }
        }

        /// <summary>圆角之外露出的底色（父容器在该处的颜色）。</summary>
        public Color Surround
        {
            get { return surround; }
            set { if (surround != value) { surround = value; Invalidate(); } }
        }

        /// <summary>圆角内的填充色；Alpha=0 表示不填充（只见底色）。</summary>
        public Color FillColor
        {
            get { return fillColor; }
            set { if (fillColor != value) { fillColor = value; Invalidate(); } }
        }

        /// <summary>文字对齐。</summary>
        public ContentAlignment Align
        {
            get { return align; }
            set { if (align != value) { align = value; Invalidate(); } }
        }

        public RoundLabel()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint
                   | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            TabStop = false;
        }

        // 整个矩形都会在 OnPaint 里重绘，背景无需额外擦除，避免闪烁
        protected override void OnPaintBackground(PaintEventArgs e) { }

        // Control.Text 改变不会自带重绘（与 Label 不同），必须显式 Invalidate，
        // 否则文字会停留在旧值：例如浮窗「复制译文/复制原文」、工具条「存/存●」的切换。
        protected override void OnTextChanged(EventArgs e)
        {
            base.OnTextChanged(e);
            Invalidate();
        }

        protected override void OnForeColorChanged(EventArgs e)
        {
            base.OnForeColorChanged(e);
            Invalidate();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;

            // 1) 先用底色铺满整个矩形：圆角之外露出的就是正确的父级底色
            if (Surround.A > 0)
                using (SolidBrush sb = new SolidBrush(Surround))
                    g.FillRectangle(sb, ClientRectangle);

            if (Width <= 1 || Height <= 1) return;

            // 2) 叠画抗锯齿圆角填充
            if (FillColor.A > 0)
            {
                Rectangle r = new Rectangle(0, 0, Width - 1, Height - 1);
                using (GraphicsPath path = Native.RoundPath(r, Radius))
                using (SolidBrush b = new SolidBrush(FillColor))
                    g.FillPath(b, path);
            }

            // 3) 文字走 GDI(TextRenderer)，小字号下比 GDI+ 更清晰，与其它 Label 风格一致
            if (!string.IsNullOrEmpty(Text))
                TextRenderer.DrawText(g, Text, Font, ClientRectangle, ForeColor,
                    TextFormatFlags.NoPrefix | TextFormatFlags.EndEllipsis | Flags(Align));
        }

        static TextFormatFlags Flags(ContentAlignment a)
        {
            switch (a)
            {
                case ContentAlignment.TopLeft: return TextFormatFlags.Left | TextFormatFlags.Top;
                case ContentAlignment.TopCenter: return TextFormatFlags.HorizontalCenter | TextFormatFlags.Top;
                case ContentAlignment.TopRight: return TextFormatFlags.Right | TextFormatFlags.Top;
                case ContentAlignment.MiddleLeft: return TextFormatFlags.Left | TextFormatFlags.VerticalCenter;
                case ContentAlignment.MiddleRight: return TextFormatFlags.Right | TextFormatFlags.VerticalCenter;
                case ContentAlignment.BottomLeft: return TextFormatFlags.Left | TextFormatFlags.Bottom;
                case ContentAlignment.BottomCenter: return TextFormatFlags.HorizontalCenter | TextFormatFlags.Bottom;
                case ContentAlignment.BottomRight: return TextFormatFlags.Right | TextFormatFlags.Bottom;
                default: return TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter;
            }
        }
    }
}
