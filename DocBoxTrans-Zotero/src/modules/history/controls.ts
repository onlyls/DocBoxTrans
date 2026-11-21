import { pillCss, PILL_PADDING_COMPACT, type PillVariant } from "../../utils/uiStyle";

// ---------------- 当前翻译（面板顶部） ----------------

/** 服务切换胶囊的样式：当前服务实心高亮，其余浅色。 */
function paneServiceBtnStyle(active: boolean): string {
  return pillCss(active ? "accent" : "ghost", "0.75em");
}

/** 药丸形按钮（与弹窗、服务胶囊同一套视觉语言）。 */
function pillBtn(
  doc: Document,
  text: string,
  variant: PillVariant,
  onClick: () => void,
): HTMLButtonElement {
  const b = doc.createElement("button");
  b.type = "button";
  b.textContent = text;
  b.style.cssText = pillCss(variant, "0.75em", PILL_PADDING_COMPACT);
  b.addEventListener("click", (ev) => {
    ev.stopPropagation();
    onClick();
  });
  return b;
}

/**
 * 药丸形开关组：把多个「复选框 + 文案」放进同一个胶囊（中间加细分隔线），
 * 相比多个独立胶囊更省宽度，便于整行排布。
 */
function pillToggleGroup(
  doc: Document,
  items: Array<{
    checked: boolean;
    label: string;
    title: string;
    onChange: (v: boolean) => void;
  }>,
): HTMLElement {
  const wrap = doc.createElement("div");
  wrap.style.cssText = `${pillCss("ghost", "0.75em", PILL_PADDING_COMPACT)};display:flex;align-items:center;gap:4px;`;
  items.forEach((it, i) => {
    if (i > 0) {
      const divider = doc.createElement("span");
      divider.style.cssText =
        "width:1px;height:12px;flex:none;background:var(--fill-quaternary, rgba(127,127,127,.35));";
      wrap.appendChild(divider);
    }
    const label = doc.createElement("label");
    label.style.cssText =
      "display:flex;align-items:center;gap:4px;cursor:pointer;white-space:nowrap;";
    label.title = it.title;
    const cb = doc.createElement("input");
    cb.type = "checkbox";
    cb.checked = it.checked;
    cb.addEventListener("change", () => it.onChange(cb.checked));
    const span = doc.createElement("span");
    span.textContent = it.label;
    label.appendChild(cb);
    label.appendChild(span);
    wrap.appendChild(label);
  });
  return wrap;
}

function copyText(root: HTMLElement, text: string) {
  try {
    new ztoolkit.Clipboard().addText(text, "text/plain").copy();
  } catch {
    const win = root.ownerGlobal as unknown as Window;
    win?.navigator?.clipboard?.writeText(text);
  }
}

function mkBtn(
  doc: Document,
  text: string,
  onClick: () => void,
  small = false,
): HTMLButtonElement {
  const b = doc.createElement("button");
  b.textContent = text;
  b.style.cssText = small ? "font-size:0.8em;padding:1px 6px;" : "padding:2px 8px;";
  b.addEventListener("click", (ev) => {
    ev.stopPropagation();
    onClick();
  });
  return b;
}

export { paneServiceBtnStyle, pillBtn, pillToggleGroup, copyText, mkBtn };
