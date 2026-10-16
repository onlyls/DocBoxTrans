/**
 * 一条成功翻译记录（移植自 DocBoxTrans 的 HistoryRecord，字段语义保持一致）。
 */
export interface HistoryRecord {
  /** 唯一标识。 */
  id: string;
  /** 原文（实际送去翻译的文本）。 */
  sourceText: string;
  /** 译文（引擎原始输出）。 */
  translatedText: string;
  /** 翻译完成时间，"yyyy-MM-dd HH:mm:ss"（本地时间）。 */
  createdAt: string;
  /** 源语言。源语言始终为自动检测，固定为 "auto"。 */
  sourceLanguage: string;
  /** 翻译引擎标识：llm / google / bing / tencent / youdao / cnki。 */
  provider: string;
  /** 目标语言（记录时的 targetLanguage）。 */
  targetLanguage: string;
  /** 所属附件（PDF 等）的条目 id（阅读器 reader.itemID；上下文按篇隔离、历史去重也据此）。 */
  itemId?: number;
  /** 所属顶层文献条目 id（由附件 itemId 推导；历史列表按文献分组时使用）。 */
  parentItemId?: number;
  /** 原文在文档中的位置（仅 PDF 有；用于点击记录跳转回原文）。 */
  position?: RecordPosition;
  /** 用户为该记录附加的标签（可多个）。 */
  tags: string[];
}

/** 原文位置（PDF 用 pageIndex/rects；HTML 快照/EPUB 用 WADM selector），坐标系与 reader.navigate 一致。 */
export interface RecordPosition {
  pageIndex?: number;
  rects?: number[][];
  pageLabel?: string;
  sortIndex?: string;
  /** 非 PDF 文档（HTML 快照 / EPUB）的选择器，跳转时直接交给 reader.navigate。 */
  selector?: RecordSelector;
}

/** Web Annotation 选择器（CssSelector / TextQuoteSelector / FragmentSelector 等）。 */
export interface RecordSelector {
  type?: string;
  value?: string;
  exact?: string;
  prefix?: string;
  suffix?: string;
  refinedBy?: RecordSelector;
  [key: string]: unknown;
}

/** 是否带有指定标签（忽略大小写与首尾空白）。 */
export function hasTag(rec: HistoryRecord, tag: string): boolean {
  const t = (tag ?? "").trim();
  if (t.length === 0 || !rec.tags || rec.tags.length === 0) return false;
  return rec.tags.some((x) => (x ?? "").trim().toLowerCase() === t.toLowerCase());
}
