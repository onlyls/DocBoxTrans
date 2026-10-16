using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace DocBoxTrans
{
    /// <summary>
    /// 右下角缩放抓手：自绘三条斜线，作为窗口「最顶层的子控件」接收鼠标。
    ///
    /// 之所以要单独做成一个控件，是因为浮窗/历史窗口内部都填满了子控件（文本框、滚动列表等），
    /// 若只在窗体的 OnMouseDown 里判断角落坐标，鼠标按下会被上层子控件截走，窗体根本收不到事件，
    /// 表现为「窗口无法缩放」。把抓手做成置于最上层的子控件即可绕开遮挡问题。
    ///
    /// 抓手自身只负责命中判定、光标与绘制；具体尺寸计算与写回配置由宿主窗体完成。
    /// </summary>
    class ResizeGrip : Control
    {
        Color surround = Color.White;
        Color lineColor = Color.Gray;
        int inset = 4;
        int step = 4;

        /// <summary>抓手矩形内、斜线之外露出的底色（父容器在该处的底色）。</summary>
        public Color Surround
        {
            get { return surround; }
            set { if (surround != value) { surround = value; Invalidate(); } }
        }

        /// <summary>三条斜线的颜色。</summary>
        public Color LineColor
        {
            get { return lineColor; }
            set { if (lineColor != value) { lineColor = value; Invalidate(); } }
        }

        /// <summary>斜线距右下角的起始内缩（像素，已按 DPI 换算）。</summary>
        public int Inset
        {
            get { return inset; }
            set { if (inset != value) { inset = value; Invalidate(); } }
        }

        /// <summary>三条斜线之间的间距（像素，已按 DPI 换算）。</summary>
        public int Step
        {
            get { return step; }
            set { if (step != value) { step = value; Invalidate(); } }
        }

        public ResizeGrip()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint
                   | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            TabStop = false;
            Cursor = Cursors.SizeNWSE;
        }

        // 整个矩形都会在 OnPaint 里重绘，背景无需额外擦除，避免闪烁
        protected override void OnPaintBackground(PaintEventArgs e) { }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;

            if (Surround.A > 0)
                using (SolidBrush b = new SolidBrush(Surround))
                    g.FillRectangle(b, ClientRectangle);

            if (Width <= 1 || Height <= 1) return;

            using (Pen p = new Pen(LineColor))
            {
                for (int i = 0; i < 3; i++)
                {
                    int off = i * Step;
                    g.DrawLine(p, Width - Inset - off, Height - Inset,
                                  Width - Inset, Height - Inset - off);
                }
            }
        }
    }
}
