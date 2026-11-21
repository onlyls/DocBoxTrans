import { config } from "../../package.json";
import type { RecordPosition } from "../utils/history";

/** 每个阅读器拥有自己的选区、弹窗和结果状态，事件处理器捕获此对象。 */
export interface ReaderState {
  readerId: string;
  itemId?: number;
  currentPopup: HTMLDivElement | null;
  prefix: string;
  selectedText: string;
  isPdf?: boolean;
  position?: RecordPosition;
  autoTranslated: boolean;
  resultCleared: boolean;
}

let states = new WeakMap<object, ReaderState>();

export function getReaderState(reader: _ZoteroTypes.ReaderInstance): ReaderState {
  let state = states.get(reader);
  if (!state) {
    const readerId = reader._instanceID || Zotero.Utilities.randomString(16);
    state = {
      readerId,
      itemId: reader.itemID,
      currentPopup: null,
      prefix: `${config.addonRef}-${readerId}`,
      selectedText: "",
      isPdf: reader.type === "pdf",
      autoTranslated: false,
      resultCleared: false,
    };
    states.set(reader, state);
  }
  return state;
}

function readers(): _ZoteroTypes.ReaderInstance[] {
  return Zotero.Reader._readers ?? [];
}

export function getReaderStates(): ReaderState[] {
  return readers().map((reader) => states.get(reader)).filter(
    (state): state is ReaderState => Boolean(state),
  );
}

function topWindow(win: Window | null | undefined): Window | undefined {
  if (!win) return undefined;
  try {
    return win.top ?? win;
  } catch {
    return win;
  }
}

function ownsWindow(reader: _ZoteroTypes.ReaderInstance, win: Window): boolean {
  return reader._window === win ||
    topWindow(reader._iframeWindow) === win ||
    reader._iframe?.ownerDocument?.defaultView === win;
}

/** 从事件实际所属窗口及活动标签页确定阅读器，绝不回退到上次选区。 */
export function getActiveReaderState(win?: Window | null): ReaderState | undefined {
  const top = topWindow(win);
  if (!top) return undefined;
  const selectedID = (top as Window & { Zotero_Tabs?: { selectedID?: string } })
    .Zotero_Tabs?.selectedID;
  const reader = readers().find((r) =>
    ownsWindow(r, top) && (r.tabID
      ? selectedID ? r.tabID === selectedID : topWindow(r._iframeWindow) === top
      : true),
  );
  return reader ? getReaderState(reader) : undefined;
}

/** 侧栏依据其附件和所属窗口取状态，支持同一 PDF 在不同窗口中打开。 */
export function getReaderStateForItem(
  itemId: number | undefined,
  win?: Window | null,
): ReaderState | undefined {
  if (itemId == null) return undefined;
  const active = getActiveReaderState(win);
  if (active?.itemId === itemId) return active;
  const top = topWindow(win);
  const reader = readers().find((r) =>
    r.itemID === itemId && (!top || ownsWindow(r, top)),
  );
  return reader ? getReaderState(reader) : undefined;
}

export function clearReaderStates(): void {
  states = new WeakMap();
}
