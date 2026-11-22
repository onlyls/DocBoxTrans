import { config } from "../../../package.json";
import { getString } from "../../utils/locale";
import type { HistoryRecord, RecordPosition } from "../../utils/history";
import * as historyStore from "../../utils/historyStore";
import { services } from "../services";
import { translationContext } from "../context";
import { getReaders } from "./scope";
import { makeTagChip, buildTagEditor } from "./tags";
import { mkBtn, copyText } from "./controls";

/** 卡片式记录（对齐 Zotero 侧栏笔记的视觉：圆角卡片 + 标题/摘要 + 右下角日期）。 */
function buildItem(
  root: HTMLElement,
  doc: Document,
  rec: HistoryRecord,
  expandedIds: Set<string>,
  onChanged: () => void,
  versions?: {
    key: string;
    records: readonly HistoryRecord[];
    onSelect: (id: string, direction: -1 | 1) => void;
  },
): HTMLElement {
  const expansionKey = versions?.key ?? rec.id;
  const expanded = expandedIds.has(expansionKey);

  const card = doc.createElement("div");
  card.dataset.versionId = rec.id;
  card.style.cssText =
    "position:relative;border:1px solid var(--fill-quaternary, rgba(127,127,127,.25));" +
    "border-radius:8px;padding:8px 10px;margin-bottom:6px;background:transparent;" +
    "transition:background .12s ease,border-color .12s ease;";

  // 顶部：图标 + 服务/目标语言（可点击跳回原文）；右侧操作按钮（悬停时显示）
  const head = doc.createElement("div");
  head.style.cssText = "display:flex;align-items:center;gap:6px;";

  const source = doc.createElement("div");
  source.style.cssText =
    "display:flex;align-items:center;gap:6px;flex:1;min-width:0;";

  const icon = doc.createElement("img");
  icon.src = `chrome://${config.addonRef}/content/icons/panel-16.svg`;
  icon.style.cssText = "width:16px;height:16px;flex:none;opacity:.7;";
  source.appendChild(icon);

  const meta = doc.createElement("div");
  meta.style.cssText =
    "flex:0 1 auto;min-width:0;font-size:0.8em;opacity:.7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
  meta.textContent = `${providerName(rec.provider)} · ${rec.targetLanguage}`;
  source.appendChild(meta);

  // 有原文位置时，点击「服务来源」区域跳回该原文在文档中的位置
  if (typeof rec.itemId === "number" && rec.position) {
    source.style.cursor = "pointer";
    source.title = getString("history-jumpTitle");
    source.addEventListener("click", (ev) => {
      ev.stopPropagation();
      jumpToRecord(rec);
    });
  } else {
    source.title = getString("history-noPosition");
  }
  head.appendChild(source);

  const actions = doc.createElement("div");
  actions.style.cssText =
    "display:flex;gap:4px;flex:none;opacity:0;transition:opacity .12s ease;";
  actions.appendChild(
    mkBtn(doc, getString("history-copy"), () => copyText(root, rec.translatedText), true),
  );
  actions.appendChild(
    mkBtn(
      doc,
      getString("history-delete"),
      () => {
        if (historyStore.remove(rec.id)) {
          translationContext.remove(rec.id);
          if (!versions || versions.records.length === 1) expandedIds.delete(expansionKey);
          onChanged();
        }
      },
      true,
    ),
  );
  head.appendChild(actions);
  if (versions && versions.records.length > 1) {
    const navigation = doc.createElement("span");
    navigation.style.cssText = "display:inline-flex;align-items:center;gap:2px;flex:none;";
    const index = versions.records.findIndex(record => record.id === rec.id);
    for (const direction of [-1, 1] as const) {
      if (direction === 1) {
        const count = doc.createElement("span");
        count.className = `${config.addonRef}-history-version-count`;
        count.textContent = String(versions.records.length);
        count.title = getString("history-resultCount", { args: { count: versions.records.length } });
        count.setAttribute("aria-label", count.title);
        count.style.cssText = "min-width:1ch;text-align:center;font-size:0.8em;" +
          "font-variant-numeric:tabular-nums;cursor:default;";
        count.addEventListener("click", event => event.stopPropagation());
        navigation.appendChild(count);
      }
      const button = doc.createElement("button");
      button.type = "button";
      button.className = `${config.addonRef}-history-version-button`;
      button.dataset.groupKey = versions.key;
      button.dataset.direction = String(direction);
      button.title = getString(direction === -1 ? "history-previousVersion" : "history-nextVersion");
      button.setAttribute("aria-label", button.title);
      button.style.cssText = "display:inline-flex;align-items:center;justify-content:center;" +
        "width:20px;height:20px;padding:1px;border:0;border-radius:4px;" +
        "background:transparent;color:inherit;cursor:pointer;";
      const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 16 16");
      svg.setAttribute("width", "14"); svg.setAttribute("height", "14");
      svg.setAttribute("aria-hidden", "true");
      const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", direction === -1 ? "M10 3 5 8l5 5" : "m6 3 5 5-5 5");
      path.setAttribute("fill", "none"); path.setAttribute("stroke", "currentColor");
      path.setAttribute("stroke-width", "1.8");
      path.setAttribute("stroke-linecap", "round"); path.setAttribute("stroke-linejoin", "round");
      svg.appendChild(path); button.appendChild(svg);
      button.addEventListener("click", event => {
        event.preventDefault(); event.stopPropagation();
        const next = (index + direction + versions.records.length) % versions.records.length;
        versions.onSelect(versions.records[next].id, direction);
      });
      navigation.appendChild(button);
    }
    source.appendChild(navigation);
    const deleteButton = actions.querySelectorAll("button")[1];
    if (deleteButton) deleteButton.title = getString("history-deleteVersion");
  }

  // 原文 + 译文：单击该显示区域展开/收起本条（只改本卡片样式，不动其它记录）
  const content = doc.createElement("div");
  content.style.cssText = "cursor:pointer;";

  const src = doc.createElement("div");
  src.textContent = rec.sourceText;
  content.appendChild(src);

  const dst = rec.translatedText ? doc.createElement("div") : null;
  if (dst) {
    dst.textContent = rec.translatedText;
    content.appendChild(dst);
  }

  const applyExpand = (exp: boolean) => {
    src.style.cssText = `margin-top:4px;font-weight:600;font-size:0.92em;line-height:1.4;${clampStyle(
      exp,
      2,
    )}`;
    if (dst) {
      dst.style.cssText = `margin-top:3px;line-height:1.45;${clampStyle(exp, 3)}`;
    }
  };
  applyExpand(expanded);

  content.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const next = !expandedIds.has(expansionKey);
    if (next) expandedIds.add(expansionKey);
    else expandedIds.delete(expansionKey);
    applyExpand(next);
  });

  // 底部：左侧标签、右侧「+」与日期（同一行、同一高度）
  const foot = doc.createElement("div");
  foot.style.cssText = "margin-top:6px;display:flex;align-items:center;gap:6px;";

  const tagWrap = doc.createElement("div");
  tagWrap.style.cssText = "flex:1;min-width:0;display:flex;flex-wrap:wrap;gap:4px;";
  for (const t of rec.tags ?? []) {
    tagWrap.appendChild(makeTagChip(doc, rec, t, onChanged));
  }
  foot.appendChild(tagWrap);

  const editor = buildTagEditor(doc, rec, onChanged);
  const addBtn = doc.createElement("button");
  addBtn.type = "button";
  addBtn.textContent = "+";
  addBtn.title = getString("history-addTag");
  addBtn.style.cssText =
    "flex:none;width:18px;height:18px;line-height:1;padding:0;border-radius:9px;" +
    "border:1px dashed var(--fill-quaternary, rgba(127,127,127,.5));background:transparent;" +
    "color:inherit;cursor:pointer;font-size:13px;";
  addBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    editor.open();
  });
  foot.appendChild(addBtn);

  const date = doc.createElement("div");
  date.textContent = shortDate(rec.createdAt);
  date.title = rec.createdAt;
  date.style.cssText = "flex:none;font-size:0.75em;opacity:.55;";
  foot.appendChild(date);

  card.addEventListener("mouseenter", () => {
    actions.style.opacity = "1";
    card.style.background = "var(--fill-quaternary, rgba(127,127,127,.08))";
  });
  card.addEventListener("mouseleave", () => {
    actions.style.opacity = "0";
    card.style.background = "transparent";
  });

  card.appendChild(head);
  card.appendChild(content);
  card.appendChild(foot);
  card.appendChild(editor.wrap);

  return card;
}

/** 折叠时的行数截断样式；展开后不截断。 */
function clampStyle(expanded: boolean, lines: number): string {
  if (expanded) return "";
  return `-webkit-line-clamp:${lines};display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden;`;
}

/** 日期缩略为笔记卡片风格：yyyy-MM-dd HH:mm:ss → yy/M/d。 */
function shortDate(createdAt: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(createdAt || "");
  if (!m) return createdAt || "";
  return `${m[1].slice(2)}/${Number(m[2])}/${Number(m[3])}`;
}

function providerName(id: string): string {
  return services.getDisplayName(id);
}

/** 点击记录「服务来源」区域：跳回该原文在文档中的位置（找不到已打开的阅读器则新开）。 */
function jumpToRecord(rec: HistoryRecord) {
  if (typeof rec.itemId !== "number" || !rec.position) return;
  const locations = buildLocations(rec.position);
  if (locations.length === 0) return;
  const opened = getReaders().find((r) => r && r.itemID === rec.itemId);
  if (opened) {
    focusReaderTab(opened);
    void navigateReader(opened, locations);
    return;
  }
  void (async () => {
    try {
      const inst = await Zotero.Reader.open(rec.itemId as number, locations[0]);
      if (inst) focusReaderTab(inst);
    } catch (e) {
      Zotero.debug(`[DocBoxTrans] 打开阅读器定位失败: ${String(e)}`);
    }
  })();
}

/** 按优先顺序构造候选位置：选择器（HTML 快照/EPUB）或 页码+矩形（PDF），并带页码兜底。 */
function buildLocations(pos: RecordPosition): _ZoteroTypes.Reader.Location[] {
  const list: _ZoteroTypes.Reader.Location[] = [];
  if (pos.selector) {
    list.push({
      position: pos.selector as unknown as _ZoteroTypes.Reader.Location["position"],
    });
  }
  if (pos.pageIndex != null) {
    list.push({
      pageIndex: pos.pageIndex,
      position: { pageIndex: pos.pageIndex, rects: pos.rects },
    });
    list.push({ pageIndex: pos.pageIndex, pageLabel: pos.pageLabel });
  }
  return list;
}

/** 把目标阅读器所在标签/窗口切到前台，否则用户看不到跳转效果。 */
function focusReaderTab(reader: any | undefined) {
  if (!reader) return;
  try {
    if (reader._window?.focus) reader._window.focus();
    const win =
      reader._window ??
      (Zotero as unknown as { getMainWindow?: () => any }).getMainWindow?.();
    const tabs = (win as any)?.Zotero_Tabs;
    if (reader.tabID && tabs?.select) tabs.select(reader.tabID);
    if (reader.focus) reader.focus();
  } catch {
    // 忽略：切前台失败不影响定位本身
  }
}

/** 依次尝试候选位置定位；全部失败时记录调试输出。 */
async function navigateReader(
  reader: any,
  locations: _ZoteroTypes.Reader.Location[],
) {
  for (const loc of locations) {
    try {
      await reader.navigate(loc);
      return;
    } catch {
      // 该候选不可用，尝试下一个
    }
  }
  Zotero.debug("[DocBoxTrans] 跳转原文位置失败：所有候选位置均不可用");
}

export { buildItem };
