declare const _globalThis: {
  [key: string]: any;
  Zotero: _ZoteroTypes.Zotero;
  crypto: Crypto;
  TextEncoder: typeof TextEncoder;
  ztoolkit: ZToolkit;
  addon: typeof addon;
};

declare type ZToolkit = ReturnType<
  typeof import("../src/utils/ztoolkit").createZToolkit
>;

declare const ztoolkit: ZToolkit;

declare const rootURI: string;

declare const addon: import("../src/addon").default;

declare const __env__: "production" | "development";

declare class MozXULElement {
  static parseXULToFragment(xul: string): DocumentFragment;
  static insertFTLIfNeeded(ftl: string): void;
}

declare namespace Zotero {
  const DocBoxTrans: import("../src/addon").default;
}
