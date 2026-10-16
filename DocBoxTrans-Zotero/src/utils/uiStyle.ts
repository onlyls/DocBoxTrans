/**
 * 弹窗与「翻译记录」面板共用的「药丸形」控件样式。
 * 与服务按钮保持同一套视觉语言：幽灵态为浅色描边胶囊，强调态为蓝色实心胶囊。
 */

export type PillVariant = "ghost" | "accent";

/** 药丸形基础样式（camelCase，供 ztoolkit UI 的 styles 字段 / Object.assign(style) 使用）。 */
const PILL_BASE: Record<string, string> = {
  margin: "0",
  borderRadius: "10px",
  lineHeight: "1.4",
  whiteSpace: "nowrap",
  cursor: "pointer",
  color: "inherit",
};

/** 默认内边距。 */
export const PILL_PADDING = "2px 8px";
/** 紧凑内边距（用于需要把较多控件塞进一行的场景）。 */
export const PILL_PADDING_COMPACT = "2px 6px";

/** 生成药丸形样式对象；variant=accent 时为蓝色实心主按钮。 */
export function pillStyle(
  variant: PillVariant,
  fontSize?: string,
  padding: string = PILL_PADDING,
): Record<string, string> {
  const style: Record<string, string> = { ...PILL_BASE, padding };
  if (fontSize) style.fontSize = fontSize;
  if (variant === "accent") {
    style.border = "1px solid var(--accent-blue, #0a84ff)";
    style.background = "var(--accent-blue, #0a84ff)";
    style.color = "#fff";
  } else {
    style.border = "1px solid var(--fill-quaternary, rgba(127,127,127,.25))";
    style.background = "var(--fill-quaternary, rgba(127,127,127,.15))";
  }
  return style;
}

/** 生成药丸形样式的 CSS 文本（供直接设置 style.cssText 的场景）。 */
export function pillCss(
  variant: PillVariant,
  fontSize?: string,
  padding: string = PILL_PADDING,
): string {
  return Object.entries(pillStyle(variant, fontSize, padding))
    .map(([k, v]) => `${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}:${v}`)
    .join(";");
}

/** 禁用态附加样式：自定义背景下仅靠 disabled 不足以呈现「置灰」。 */
export function applyDisabledStyle(el: HTMLElement, disabled: boolean): void {
  el.style.opacity = disabled ? "0.5" : "";
  el.style.cursor = disabled ? "default" : "pointer";
}
