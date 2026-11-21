import * as combineStore from "../utils/combineStore";
import type { CombineItem } from "../utils/combineStore";
import { getString } from "../utils/locale";
import { notifyTranslationUpdate } from "../utils/translationEvents";

/** 弹窗与侧栏共用可排序的片段控件。操作按钮支持键盘焦点。 */
export function buildCombineChip(
  doc: Document, itemId: number | undefined, item: CombineItem,
  index: number, count: number,
): HTMLElement {
  const chip = doc.createElement("span");
  chip.style.cssText = "display:inline-flex;align-items:center;gap:3px;max-width:100%;" +
    "padding:1px 5px;border-radius:8px;font-size:0.8em;" +
    "background:var(--fill-quaternary, rgba(127,127,127,.15));";
  const text = doc.createElement("span");
  text.textContent = `${index + 1}. ${item.text.length > 20 ? item.text.slice(0, 20) + "…" : item.text}`;
  text.title = item.text;
  text.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
  chip.appendChild(text);
  const button = (label: string, title: string, disabled: boolean, action: () => boolean) => {
    const el = doc.createElement("button");
    el.type = "button"; el.textContent = label; el.title = getString(title);
    el.setAttribute("aria-label", el.title);
    el.disabled = disabled;
    el.style.cssText = "font:inherit;padding:0 3px;flex:none;";
    el.addEventListener("click", event => {
      event.stopPropagation();
      if (!el.disabled && action()) notifyTranslationUpdate();
    });
    chip.appendChild(el);
  };
  button("↑", "combine-moveUp", index === 0, () => combineStore.move(itemId, item.id, -1));
  button("↓", "combine-moveDown", index === count - 1, () => combineStore.move(itemId, item.id, 1));
  button("×", "combine-removeTitle", false, () => combineStore.remove(itemId, item.id));
  return chip;
}
