import { config } from "../../package.json";
import type { RecordPosition } from "../utils/history";
import { popupState } from "./popup";

/** 注册阅读器事件：选中文本 → 构建弹窗并触发 onReaderPopupShow 钩子。 */
export function registerReaderInitializer() {
  Zotero.Reader.registerEventListener(
    "renderTextSelectionPopup",
    (event) => {
      const { params, reader } = event;
      popupState.selectedText = (params.annotation?.text ?? "").trim();
      popupState.itemId = (reader as { itemID?: number })?.itemID;
      // 选区位置：PDF 为 pageIndex+rects，HTML 快照/EPUB 为 WADM 选择器；供点击历史记录跳回原文
      popupState.position = extractPosition(params.annotation);
      // 稳定的 id 前缀（按阅读器实例），使同一阅读器内重复 append 时不会产生重复元素
      const instanceID = (reader as { _instanceID?: string })?._instanceID;
      popupState.prefix = `${config.addonRef}-${instanceID ?? Zotero.Utilities.randomString(6)}`;
      popupState.autoTranslated = false;
      addon.hooks.onReaderPopupShow(event);
    },
    config.addonID,
  );
}

/** 把选区注解的位置整理成可持久化的位置对象（PDF 用页码+矩形，其它文档保留选择器）。 */
function extractPosition(
  ann: _ZoteroTypes.Annotations.AnnotationJson | undefined,
): RecordPosition | undefined {
  const raw = ann?.position as unknown;
  if (!raw || typeof raw !== "object") return undefined;
  const p = raw as { pageIndex?: number; rects?: number[][] };
  const base = { pageLabel: ann?.pageLabel, sortIndex: ann?.sortIndex };
  if (typeof p.pageIndex === "number" || Array.isArray(p.rects)) {
    return { ...base, pageIndex: p.pageIndex, rects: Array.isArray(p.rects) ? p.rects : undefined };
  }
  // 非 PDF：position 本身即 WADM 选择器（CssSelector / TextQuoteSelector / FragmentSelector）
  return { ...base, selector: raw as RecordPosition["selector"] };
}
