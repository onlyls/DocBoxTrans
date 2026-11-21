import { getString } from "../../utils/locale";
import type { HistoryRecord } from "../../utils/history";
import * as historyStore from "../../utils/historyStore";

/** 标签色相：同一标签始终映射到同一颜色。 */
function tagHue(tag: string): number {
  const s = (tag || "").trim().toLowerCase();
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

/** 标签胶囊的公共样式（背景/描边按标签着色）。 */
function tagChipStyle(hue: number, extra = ""): string {
  return (
    `font-size:0.75em;padding:1px 7px;border-radius:8px;cursor:pointer;color:inherit;` +
    `background:hsla(${hue},65%,50%,0.20);border:1px solid hsla(${hue},65%,45%,0.55);` +
    extra
  );
}

/** 已添加的标签胶囊：点 1 次变为 ✕，再点 1 次即删除该标签。 */
function makeTagChip(
  doc: Document,
  rec: HistoryRecord,
  tag: string,
  onChanged: () => void,
): HTMLElement {
  const chip = doc.createElement("span");
  chip.textContent = tag;
  chip.title = getString("history-removeTag");
  chip.style.cssText = tagChipStyle(tagHue(tag));
  let armed = false;
  chip.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (!armed) {
      armed = true;
      chip.textContent = "✕";
      chip.style.background = "hsla(0,70%,50%,0.20)";
      chip.style.borderColor = "hsla(0,70%,45%,0.60)";
      return;
    }
    if (historyStore.removeTag(rec.id, tag)) onChanged();
  });
  return chip;
}

/** 每条记录内联的「加标签」输入器：逐字实时匹配已有标签，Enter 完成添加。 */
function buildTagEditor(
  doc: Document,
  rec: HistoryRecord,
  onChanged: () => void,
): { wrap: HTMLElement; open: () => void } {
  const wrap = doc.createElement("div");
  wrap.style.cssText = "display:none;margin-top:6px;";
  // 阻止冒泡，避免点输入区时触发卡片的展开/收起
  wrap.addEventListener("click", (ev) => ev.stopPropagation());

  const input = doc.createElement("input");
  input.type = "text";
  input.placeholder = getString("history-tagPlaceholder");
  input.style.cssText = "width:100%;box-sizing:border-box;padding:2px 6px;";
  wrap.appendChild(input);

  const suggest = doc.createElement("div");
  suggest.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;";
  wrap.appendChild(suggest);

  const renderSuggestions = () => {
    suggest.textContent = "";
    for (const t of tagSuggestions(input.value, rec.tags)) {
      const chip = doc.createElement("button");
      chip.type = "button";
      chip.textContent = t;
      chip.style.cssText = tagChipStyle(tagHue(t));
      chip.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (historyStore.addTag(rec.id, t)) onChanged();
      });
      suggest.appendChild(chip);
    }
  };

  const commit = () => {
    const t = input.value.trim();
    if (!t) {
      wrap.style.display = "none";
      return;
    }
    if (historyStore.addTag(rec.id, t)) onChanged();
    else input.value = ""; // 已存在同名标签：仅清空输入
  };

  input.addEventListener("input", renderSuggestions);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      commit();
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      wrap.style.display = "none";
    }
  });

  return {
    wrap,
    open: () => {
      wrap.style.display = "block";
      renderSuggestions();
      input.focus();
    },
  };
}

/** 输入前缀时实时匹配的候选标签（排除本条已添加的，最多 8 个）。 */
function tagSuggestions(query: string, exclude: string[]): string[] {
  const q = (query || "").trim().toLowerCase();
  const ex = new Set((exclude ?? []).map((t) => t.toLowerCase()));
  return historyStore
    .allTags()
    .filter((t) => !ex.has(t.toLowerCase()))
    .filter((t) => (q ? t.toLowerCase().includes(q) : true))
    .slice(0, 8);
}

function fillTagOptions(sel: HTMLSelectElement, doc: Document) {
  const current = sel.value;
  sel.textContent = "";
  const all = doc.createElement("option");
  all.value = "";
  all.textContent = getString("history-allTags");
  sel.appendChild(all);
  for (const t of historyStore.allTags()) {
    const o = doc.createElement("option");
    o.value = t;
    o.textContent = t;
    sel.appendChild(o);
  }
  sel.value = current;
}

export { makeTagChip, buildTagEditor, fillTagOptions };
