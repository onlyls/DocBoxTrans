const { build } = require("esbuild");
const vm = require("node:vm");
const path = require("node:path");
const { webcrypto } = require("node:crypto");

const root = path.resolve(__dirname, "..");
const bundles = new Map();

async function compile(realPane = false, realServices = false) {
  const bundleKey = `${realPane}:${realServices}`;
  if (!bundles.has(bundleKey)) bundles.set(bundleKey, build({
    stdin: {
      contents: `
        export * as store from './src/utils/historyStore';
        export * as tasks from './src/utils/task';
        export * as popup from './src/modules/popup';
        export * as actions from './src/modules/translationActions';
        export * as updates from './src/utils/translationEvents';
        export * as scopes from './src/modules/history/scope';
        export * as sorting from './src/modules/history/sorting';
        export * as layout from './src/modules/history/layout';
        export * as cards from './src/modules/history/recordCard';
        export * as current from './src/modules/history/currentTranslation';
        export * as tags from './src/modules/history/tags';
        export * as panes from './src/modules/historyPane';
        export * as readerState from './src/modules/readerState';
        export * as reader from './src/modules/reader';
        export * as serviceConfig from './src/modules/serviceConfig';
        export * as servicePreferences from './src/modules/servicePreferences';
        export * as serviceVisibility from './src/modules/serviceVisibility';
        export { services as registry } from './src/modules/services';
        export * as http from './src/utils/http';
        export * as text from './src/utils/text';
        export { ChatCompletionStream } from './src/modules/services/chatStream';
        export { buildCombineChip } from './src/modules/combineChips';
        export { translationContext as context } from './src/modules/context';
        export { LlmService, probeConnection } from './src/modules/services/llm';
        export { GoogleService } from './src/modules/services/google';
        export { BingService } from './src/modules/services/bing';
        export { TencentService } from './src/modules/services/tencent';
        export { YoudaoService } from './src/modules/services/youdao';
        export { CnkiService } from './src/modules/services/cnki';
        export * as combine from './src/utils/combineStore';
        export { default as hooks } from './src/hooks';
      `,
      resolveDir: root,
      sourcefile: "regression-tests.ts",
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    plugins: [{ name: "host-boundaries", setup(builder) {
      builder.onResolve({ filter: /^zotero-plugin-toolkit$/ }, () => ({
        path: "toolkit", namespace: "mock",
      }));
      builder.onLoad({ filter: /.*/, namespace: "mock" }, () => ({
        contents: "export const KeyModifier = globalThis.testKeyModifier;",
      }));
      builder.onLoad({ filter: /[/\\]src[/\\].*\.ts$/ }, ({ path: file }) => {
        const p = file.replace(/\\/g, "/");
        if (p.endsWith("/utils/locale.ts")) return { contents:
          'export const getString = (key) => key; export const getLocaleID = (key) => key; export const initLocale = () => {};',
        };
        if (!realPane && p.endsWith("/modules/historyPane.ts")) return { contents:
          'export const refreshHistoryPanes = () => globalThis.testRefresh(); export const registerHistoryPane = () => {}; export const unregisterHistoryPane = () => {}; export const refreshHistoryCurrent = () => globalThis.testRefresh();',
        };
        if (p.endsWith("/modules/preferenceWindow.ts")) return { contents:
          'export const registerPrefsWindow = () => {}; export const registerPrefsScripts = () => {};',
        };
        if (!realServices && p.endsWith("/modules/services/index.ts")) return { contents:
          'export const services = {getById: id => globalThis.testServices.get(id), getAll: () => [...globalThis.testServices.values()], getVisible: () => [...globalThis.testServices.values()], getDisplayName: id => id};',
        };
      });
    } }],
  }).then((result) => result.outputFiles[0].text));
  return bundles.get(bundleKey);
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function fixture(t, options = {}) {
  const prefs = {
    translateSource: "llm", targetLanguage: "zh-CN", reuseTranslation: false,
    contextEnable: false, enablePopup: true, enableAuto: true,
    showServiceSelector: true, fontSize: "12",
    combineAddShortcut: "Alt+Shift+A", combineTranslateShortcut: "Alt+Shift+S",
    "llm.apiKey": "test-key", "llm.endpoint": "https://example.invalid/translate",
    "llm.model": "test-model", "llm.temperature": "0.2", "llm.systemPrompt": "",
    "youdao.appKey": "test-app", "youdao.secret": "test-secret", "youdao.mode": "text",
    ...options.prefs,
  };
  let serial = 0;
  const disk = { text: options.text ?? null, readError: null, writeError: null,
    reads: 0, writes: [], activeWrites: 0, maxActiveWrites: 0, beforeWrite: null };
  const timers = new Set();
  const services = new Map();
  const events = new Map();
  const errors = [];
  const sections = new Map();
  const clipboard = [];
  const appObservers = new Map();
  const barrier = { blocker: null, addBlocker(_name, blocker) { this.blocker = blocker; },
    removeBlocker(blocker) { if (this.blocker === blocker) this.blocker = null; } };
  const host = {
    exports: {}, AbortController, URL, TextEncoder, crypto: webcrypto,
    testServices: services, testRefresh: () => {},
    testKeyModifier: class { constructor(ev) { this.key = ev.shortcut; } equals(key) { return key === this.key; } },
    setTimeout(fn, ms) {
      const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms);
      timers.add(timer); return timer;
    },
    clearTimeout(timer) { clearTimeout(timer); timers.delete(timer); },
    Zotero: {
      Utilities: { randomString: () => `id-${++serial}` },
      Items: { get: id => ({ parentItemID: id === 10 || id === 11 ? 1 : false }) },
      Prefs: { get: key => prefs[key.replace(/^extensions\.zotero\.DocBoxTrans\./, "")],
        set: (key, value) => { prefs[key.replace(/^extensions\.zotero\.DocBoxTrans\./, "")] = value; } },
      DataDirectory: { dir: "C:\\test-profile" },
      Reader: { _readers: [], registerEventListener: (name, handler) => events.set(name, handler) },
      ItemPaneManager: {
        registerSection(definition) { sections.set(definition.paneID, definition); return definition.paneID; },
        unregisterSection(key) { return sections.delete(key); },
      },
      HTTP: { request: async () => { throw new Error("Unexpected network request"); } },
      debug() {}, logError: error => errors.push(error), getMainWindows: () => [],
    },
    Services: { prompt: { confirm: () => false }, obs: {
      addObserver(observer, topic) {
        if (!appObservers.has(topic)) appObservers.set(topic, new Set());
        appObservers.get(topic).add(observer);
      },
      removeObserver(observer, topic) { appObservers.get(topic)?.delete(observer); },
    } },
    IOUtils: {
      profileBeforeChange: barrier,
      exists: async () => disk.text !== null,
      readUTF8: async () => { disk.reads++; if (disk.readError) throw disk.readError; return disk.text; },
      async writeUTF8(file, text, settings) {
        disk.activeWrites++; disk.maxActiveWrites = Math.max(disk.maxActiveWrites, disk.activeWrites);
        try {
          if (disk.beforeWrite) await disk.beforeWrite();
          if (disk.writeError) throw disk.writeError;
          disk.writes.push({ file, text, settings, backup: disk.text }); disk.text = text;
        } finally { disk.activeWrites--; }
      },
    },
    Cc: new Proxy({}, { get: (_, contract) => ({
      getService: () => {
        if (contract === "@mozilla.org/async-shutdown-service;1") return { profileBeforeChange: barrier };
        throw new Error("Unavailable host service");
      },
      createInstance: () => ({}),
    }) }),
    Ci: {}, ChromeUtils: { generateQI: () => () => {} },
    ztoolkit: {
      UI: { createElement: (_doc, _tag, definition) => definition },
      Keyboard: { register: handler => { events.set("keyboard", handler); } },
      getGlobal: key => key === "btoa" ? value => Buffer.from(value, "binary").toString("base64") : undefined,
      unregisterAll() {},
      Clipboard: class {
        addText(text) { this.text = text; return this; }
        copy() { clipboard.push(this.text); }
      },
    },
    addon: { data: { translate: { queue: [] }, alive: true }, hooks: { onReaderPopupRefresh() {} } },
  };
  host.module = { exports: host.exports };
  vm.runInNewContext(await compile(Boolean(options.realPane), Boolean(options.realServices)), host, { filename: "regression-tests.cjs" });
  const api = host.module.exports;
  t.after(() => { api.tasks.stopTranslationTasks(); api.servicePreferences.disposeServicePreferences(); for (const timer of timers) clearTimeout(timer); });
  return { ...api, host, prefs, disk, services, events, barrier, errors, sections, clipboard, appObservers };
}

function translationService(id, translate) {
  return { id, type: "sentence", supportsContext: () => false, translate };
}

function makeWindow(selectedID) {
  const win = { Zotero_Tabs: { selectedID } };
  win.top = win;
  return win;
}

function makeReader(id, itemID, win = makeWindow(id), tabID = id) {
  return { _instanceID: id, itemID, tabID, _iframe: { ownerDocument: { defaultView: win } },
    _iframeWindow: { top: win } };
}

function makePopupEvent(reader) {
  const textarea = { value: "", style: {}, scrollHeight: 40 };
  const doc = { body: { clientWidth: 900 } };
  const popup = { ownerDocument: doc, style: {}, offsetLeft: 0, setAttribute() {},
    querySelector: selector => selector.endsWith("-text") ? textarea : null,
    querySelectorAll: () => [] };
  doc.querySelector = () => popup;
  let definition;
  return { event: { reader, doc, append: value => { definition = value; } }, textarea,
    get definition() { return definition; } };
}

module.exports = { fixture, deferred, translationService, makeWindow, makeReader, makePopupEvent };
