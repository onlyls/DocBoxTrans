const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { fixture, deferred, translationService, makeReader } = require("./harness.cjs");
const { makeDocument, findButton } = require("./dom.cjs");

function mountPane(f, window, itemId = 10) {
  f.panes.registerHistoryPane();
  const section = f.sections.get("docboxtrans-history");
  const body = window.doc.createElement("div"); window.doc.body.appendChild(body);
  const item = { id: itemId, isAttachment: () => true };
  const params = { body, item, tabType: "reader" };
  section.onInit(params); section.onRender(params);
  const root = body.querySelector(".docboxtrans-history-root");
  return { section, body, root, params,
    get list() { return root.querySelector(".docboxtrans-history-list"); } };
}

function findText(root, text) {
  for (const child of root.children) {
    if (child.textContent === text) return child;
    const found = findText(child, text); if (found) return found;
  }
  return null;
}

test("all six engines return translation results without mutating frozen input", async t => {
  const f = await fixture(t);
  f.host.Zotero.HTTP.request = async (_method, url, options) => {
    if (url.includes("example.invalid")) return { status: 200,
      response: { choices: [{ message: { content: "translated" } }] } };
    if (url.includes("google")) return { status: 200, responseText: '[[["translated","source"]]]' };
    if (url.includes("microsoft")) return { status: 200, response: [{ translations: [{ text: "translated" }] }] };
    if (url.includes("transmart")) return { status: 200, response: { auto_translation: "translated" } };
    if (url.includes("youdao")) {
      return options.responseType === "text"
        ? { status: 200, responseText: 'data: {"code":"0","data":{"transFull":"translated"}}\n' }
        : { status: 200, response: { errorCode: "0", translation: ["translated"] } };
    }
    if (url.includes("getToken")) return { status: 200, response: { data: "test-token" } };
    return { status: 200, response: { data: { mResult: "translated" } } };
  };
  const request = Object.freeze({ raw: "source", langfrom: "auto", langto: "en" });
  for (const service of [f.LlmService, f.GoogleService, f.BingService,
    f.TencentService, f.YoudaoService, f.CnkiService]) {
    const result = await service.translate(request, Object.freeze([]));
    assert.equal(result.text, "translated", service.id);
    assert.equal(Object.hasOwn(request, "result"), false);
    assert.equal(Object.hasOwn(request, "status"), false);
  }
  f.prefs["youdao.mode"] = "llm";
  assert.equal((await f.YoudaoService.translate(request, [])).text, "translated");
});

test("task pipeline owns state changes and notifies observers without calling UI hooks", async t => {
  const f = await fixture(t);
  f.host.addon.hooks.onReaderPopupRefresh = () => { throw new Error("UI dependency in pipeline"); };
  const states = [], snapshots = [];
  f.services.set("llm", translationService("llm", async request => {
    assert.equal(Object.isFrozen(request), true);
    assert.deepEqual(Object.keys(request).sort(), ["langfrom", "langto", "onProgress", "raw", "signal"]);
    return { text: "  translated  " };
  }));
  const task = f.tasks.createTask("source", 10);
  const unsubscribe = f.updates.subscribeTranslationUpdates(update => {
    states.push(task.status); snapshots.push(update.displayPopup);
  });
  assert.equal(await f.tasks.runTranslationTask(task, { noDisplay: true }), true);
  unsubscribe();
  assert.deepEqual(states, ["processing", "success"]);
  assert.deepEqual(snapshots, [false, false]);
  assert.equal(task.result, "translated");
  assert.equal(f.store.getById(task.recordId).translatedText, "translated");
});

test("notification failures do not break translation or block other observers; unsubscribing works", async t => {
  const f = await fixture(t);
  const received = [];
  const bad = f.updates.subscribeTranslationUpdates(() => { throw new Error("render failed"); });
  const good = f.updates.subscribeTranslationUpdates(update => received.push(update.displayPopup));
  f.services.set("llm", translationService("llm", async () => ({ text: "translated" })));
  assert.equal(await f.tasks.runTranslationTask(f.tasks.createTask("source", 10)), true);
  assert.deepEqual(received, [true, true]);
  assert.equal(f.errors.length, 2);
  bad(); good(); f.updates.notifyTranslationUpdate();
  assert.equal(received.length, 2);
});

test("malformed service results fail without writing history", async t => {
  for (const result of [undefined, {}, { text: 12 }, { text: " \n " }]) {
    const f = await fixture(t);
    f.services.set("llm", translationService("llm", async () => result));
    const task = f.tasks.createTask("source", 10);
    assert.equal(await f.tasks.runTranslationTask(task), false);
    assert.equal(task.status, "fail");
    assert.equal(f.store.count(), 0);
  }
});

test("sidebar search and tag filters remain independent and reset on a document switch", async t => {
  const f = await fixture(t, { realPane: true });
  f.store.add("alpha", "first translation", "llm", "zh-CN", 10);
  const beta = f.store.add("beta", "second translation", "llm", "zh-CN", 10);
  f.store.addTag(beta.id, "focus");
  f.store.add("other paper", "other translation", "llm", "zh-CN", 11);
  const first = makeDocument("a"), second = makeDocument("b");
  f.host.Zotero.Reader._readers = [makeReader("a", 10, first.win), makeReader("b", 11, second.win)];
  const a = mountPane(f, first), b = mountPane(f, second, 11);
  const search = a.root.querySelector(".docboxtrans-history-search");
  search.value = "alpha"; search.dispatch("input");
  assert.equal(a.list.children.length, 1); assert.match(a.list.textContent, /first translation/);
  assert.match(b.list.textContent, /other paper/);
  search.value = ""; search.dispatch("input");
  const tag = a.root.querySelector(".docboxtrans-history-tags");
  tag.value = "focus"; tag.dispatch("change");
  assert.equal(a.list.children.length, 1); assert.match(a.list.textContent, /second translation/);
  a.section.onRender({ ...a.params, item: { id: 11, isAttachment: () => true } });
  assert.equal(search.value, ""); assert.equal(tag.value, "");
  assert.match(a.list.textContent, /other translation/);
});

test("sidebar sorting preserves source reading order and keeps scroll on refresh", async t => {
  const f = await fixture(t, { realPane: true });
  // 右栏的几何顶边更高，但阅读器提供的 sortIndex 应使左栏排在前面。
  f.store.add("left column", "left translation", "llm", "zh-CN", 10,
    { pageIndex: 0, sortIndex: "00000|00001", rects: [[0, 10, 10, 20]] });
  f.store.add("right column", "right translation", "llm", "zh-CN", 10,
    { pageIndex: 0, sortIndex: "00000|00002", rects: [[80, 800, 90, 810]] });
  const window = makeDocument();
  const pane = mountPane(f, window);
  assert.match(pane.list.children[0].textContent, /right column/);
  findButton(pane.root, "history-sortSource").dispatch("click");
  assert.match(pane.list.children[0].textContent, /left column/);
  pane.list.scrollTop = 37;
  f.panes.refreshHistoryPanes();
  assert.equal(pane.list.scrollTop, 37);
});

test("record card expansion, copy, tags and deletion survive the module split", async t => {
  const f = await fixture(t, { realPane: true });
  const rec = f.store.add("source text", "translated text", "llm", "zh-CN", 10);
  f.context.add(rec, 1, f.context.getGeneration());
  const window = makeDocument(), pane = mountPane(f, window);
  let card = pane.list.children[0];
  findButton(card, "history-copy").dispatch("click");
  assert.deepEqual(f.clipboard, ["translated text"]);
  let source = findText(card, "source text");
  assert.match(source.style.cssText, /line-clamp/);
  source.parentElement.dispatch("click");
  assert.doesNotMatch(source.style.cssText, /line-clamp/);
  f.panes.refreshHistoryPanes(); card = pane.list.children[0];
  source = findText(card, "source text");
  assert.doesNotMatch(source.style.cssText, /line-clamp/);
  findButton(card, "+").dispatch("click");
  const input = window.doc.activeElement;
  input.value = "important"; input.dispatch("keydown", { key: "Enter" });
  assert.equal(f.store.getById(rec.id).tags[0], "important");
  card = pane.list.children[0];
  const chip = card.querySelectorAll("span").find(span => span.textContent === "important");
  chip.dispatch("click"); assert.equal(f.store.getById(rec.id).tags.length, 1);
  chip.dispatch("click"); assert.equal(f.store.getById(rec.id).tags.length, 0);
  findButton(pane.list.children[0], "history-delete").dispatch("click");
  assert.equal(f.store.count(), 0); assert.equal(f.context.getCount(), 0);
  assert.match(pane.list.textContent, /history-emptyFile/);
});

test("record navigation retries a page-only location if exact positioning fails", async t => {
  const f = await fixture(t, { realPane: true });
  f.store.add("source", "translation", "llm", "zh-CN", 10, { pageIndex: 3, rects: [[1, 2, 3, 4]] });
  const window = makeDocument(), reader = makeReader("reader-a", 10, window.win);
  const locations = [], navigated = deferred();
  reader.navigate = async location => {
    locations.push(location);
    if (locations.length === 1) throw new Error("unsupported exact position");
    navigated.resolve();
  };
  f.host.Zotero.Reader._readers = [reader];
  const pane = mountPane(f, window);
  const metadata = findText(pane.list.children[0], "llm · zh-CN");
  metadata.dispatch("click"); await navigated.promise;
  assert.equal(locations.length, 2);
  assert.equal(locations[1].pageIndex, 3);
  assert.equal(locations[1].position, undefined);
});

test("current-result sidebars keep each reader's result when updates arrive", async t => {
  const f = await fixture(t, { realPane: true });
  f.services.set("llm", translationService("llm", async request => ({ text: request.raw + " translated" })));
  const a = makeDocument("a"), b = makeDocument("b");
  const ra = makeReader("a", 10, a.win), rb = makeReader("b", 11, b.win);
  f.host.Zotero.Reader._readers = [ra, rb];
  const sa = f.readerState.getReaderState(ra), sb = f.readerState.getReaderState(rb);
  sa.selectedText = "paper A"; sb.selectedText = "paper B";
  const pa = mountPane(f, a), pb = mountPane(f, b, 11);
  const current = pa.root.querySelector(".docboxtrans-history-current");
  const manager = current.querySelector(".docboxtrans-service-manager");
  const selectedService = findButton(manager.parentElement, "llm");
  assert.equal(manager.parentElement, current.children[0], "plus belongs to the service row");
  assert.equal(current.querySelector("details"), null);
  assert.equal(selectedService.getAttribute("aria-pressed"), "true");
  assert.match(selectedService.style.cssText, /color:var\(--fill-primary, inherit\)/);
  assert.doesNotMatch(selectedService.style.cssText, /color:#fff/);
  await f.hooks.onStartup();
  await f.tasks.runTranslationTask(f.actions.createNewTaskFromSelection(sa));
  await f.tasks.runTranslationTask(f.actions.createNewTaskFromSelection(sb));
  assert.match(pa.root.querySelector(".docboxtrans-history-current").textContent, /paper A translated/);
  assert.doesNotMatch(pa.root.querySelector(".docboxtrans-history-current").textContent, /paper B translated/);
  assert.match(pb.root.querySelector(".docboxtrans-history-current").textContent, /paper B translated/);
  await f.hooks.onShutdown();
});

test("destroying or unregistering sidebars releases resize observers and scheduled layout work", async t => {
  const f = await fixture(t, { realPane: true });
  const a = makeDocument("a"), b = makeDocument("b");
  const pa = mountPane(f, a), pb = mountPane(f, b, 11);
  f.panes.refreshHistoryPanes(); f.panes.refreshHistoryPanes();
  assert.equal(a.win.listeners.get("resize").size, 1);
  assert.equal(a.frames.size, 1); assert.equal(a.timers.size, 1);
  pa.section.onDestroy({ body: pa.body });
  assert.equal(a.win.listeners.get("resize").size, 0);
  assert.equal(a.observers[0].targets.size, 0);
  assert.equal(a.frames.size, 0); assert.equal(a.timers.size, 0);
  f.panes.unregisterHistoryPane();
  assert.equal(b.win.listeners.get("resize").size, 0);
  assert.equal(b.observers[0].targets.size, 0);
  assert.equal(b.frames.size, 0); assert.equal(b.timers.size, 0);
  assert.equal(f.sections.size, 0);
  // 重复销毁不会重新绑定资源或抛错。
  pa.section.onDestroy({ body: pa.body });
  pb.section.onDestroy({ body: pb.body });
});

test("production source modules have no runtime dependency cycles", () => {
  const root = path.resolve(__dirname, "../src"), graph = new Map();
  function visit(file) {
    if (graph.has(file)) return;
    const tree = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const edges = []; graph.set(file, edges);
    for (const node of tree.statements) {
      if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) continue;
      if (!node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) continue;
      if (ts.isImportDeclaration(node)) {
        if (node.importClause?.isTypeOnly) continue;
        const clause = node.importClause, bindings = clause?.namedBindings;
        if (!clause?.name && bindings && ts.isNamedImports(bindings) && bindings.elements.every(item => item.isTypeOnly)) continue;
      } else if (node.isTypeOnly) continue;
      const specifier = node.moduleSpecifier.text;
      if (!specifier.startsWith(".")) continue;
      const base = path.resolve(path.dirname(file), specifier);
      const target = [base + ".ts", path.join(base, "index.ts")].find(candidate => fs.existsSync(candidate));
      if (target && target.startsWith(root + path.sep)) { edges.push(target); visit(target); }
    }
  }
  const sourceFiles = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? sourceFiles(path.join(directory, entry.name)) : entry.name.endsWith(".ts") ? [path.join(directory, entry.name)] : []);
  sourceFiles(root).forEach(visit);
  const completed = new Set(), active = [];
  function check(file) {
    assert.equal(active.includes(file), false, "Runtime cycle: " + [...active, file].map(p => path.relative(root, p)).join(" -> "));
    if (completed.has(file)) return;
    active.push(file); for (const next of graph.get(file)) check(next);
    active.pop(); completed.add(file);
  }
  for (const file of graph.keys()) check(file);
});

function versionButton(card, direction) {
  return card.querySelectorAll(".docboxtrans-history-version-button")
    .find(button => button.dataset.direction === String(direction));
}

test("same-source variants share a card with cyclic arrow icons beside the service label", async t => {
  const f = await fixture(t, { realPane: true });
  const llm = f.store.add("shared source", "LLM translation", "llm", "zh-CN", 10);
  f.store.addTag(llm.id, "shared tag");
  f.store.add("shared source", "Bing translation", "bing", "zh-CN", 10);
  const english = f.store.add("shared source", "English translation", "llm", "en", 10);
  const window = makeDocument(), pane = mountPane(f, window);
  assert.equal(pane.list.children.length, 1);
  let card = pane.list.children[0];
  assert.equal(card.querySelectorAll("select").length, 0);
  assert.equal(card.querySelectorAll(".docboxtrans-history-version-button").length, 2);
  assert.equal(versionButton(card, -1).parentElement.parentElement, findText(card, "llm · en").parentElement);
  const navigation = versionButton(card, -1).parentElement;
  assert.equal(navigation.children[1].textContent, "3");
  assert.equal(navigation.children[2], versionButton(card, 1));
  assert.ok(versionButton(card, -1).querySelector("svg"));
  findText(card, "shared source").parentElement.dispatch("click");
  pane.list.scrollTop = 23;
  let stopped = false;
  versionButton(card, -1).dispatch("click", { stopPropagation() { stopped = true; } });
  card = pane.list.children[0];
  assert.equal(stopped, true);
  assert.equal(card.dataset.versionId, llm.id);
  assert.equal(card.querySelector(".docboxtrans-history-version-count").textContent, "3");
  assert.equal(window.doc.activeElement, versionButton(card, -1));
  assert.equal(pane.list.scrollTop, 23);
  assert.ok(findText(card, "LLM translation"));
  assert.equal(findText(card, "English translation"), null);
  assert.doesNotMatch(findText(card, "shared source").style.cssText, /line-clamp/);
  findButton(card, "history-copy").dispatch("click");
  assert.equal(f.clipboard.at(-1), "LLM translation");
  f.panes.refreshHistoryPanes();
  assert.equal(pane.list.children[0].dataset.versionId, llm.id);
  versionButton(pane.list.children[0], 1).dispatch("click");
  assert.equal(pane.list.children[0].dataset.versionId, english.id);
  assert.equal(f.store.count(), 3);
});

test("search matches all variants and tag filters use paragraph-shared tags", async t => {
  const f = await fixture(t, { realPane: true });
  const old = f.store.add("shared source", "unique older terminology", "llm", "zh-CN", 10);
  f.store.addTag(old.id, "shared-tag");
  const newer = f.store.add("shared source", "newer wording", "bing", "zh-CN", 10);
  const pane = mountPane(f, makeDocument());
  const search = pane.root.querySelector(".docboxtrans-history-search");
  search.value = "terminology"; search.dispatch("input");
  assert.equal(pane.list.children.length, 1);
  assert.equal(pane.list.children[0].dataset.versionId, old.id);
  versionButton(pane.list.children[0], 1).dispatch("click");
  assert.ok(findText(pane.list.children[0], "newer wording"));
  search.value = ""; search.dispatch("input");
  const tags = pane.root.querySelector(".docboxtrans-history-tags");
  tags.value = "shared-tag"; tags.dispatch("change");
  assert.equal(pane.list.children[0].dataset.versionId, newer.id);
  assert.equal(pane.list.children[0].querySelectorAll(".docboxtrans-history-version-button").length, 2);
});

test("card tags are shared across variants and deleting one version retains the shared tags", async t => {
  const f = await fixture(t, { realPane: true });
  const llm = f.store.add("shared source", "LLM translation", "llm", "zh-CN", 10);
  const bing = f.store.add("shared source", "Bing translation", "bing", "zh-CN", 10);
  const window = makeDocument(), pane = mountPane(f, window);
  let card = pane.list.children[0];
  findButton(card, "+").dispatch("click");
  window.doc.activeElement.value = "Shared tag";
  window.doc.activeElement.dispatch("keydown", { key: "Enter" });
  assert.equal(f.store.getById(bing.id).tags[0], "Shared tag");
  assert.equal(f.store.getById(llm.id).tags[0], "Shared tag");
  versionButton(pane.list.children[0], 1).dispatch("click");
  assert.ok(findText(pane.list.children[0], "Shared tag"));
  const chip = pane.list.children[0].querySelectorAll("span").find(span => span.textContent === "Shared tag");
  chip.dispatch("click"); chip.dispatch("click");
  assert.equal(f.store.getById(bing.id).tags.length, 0);
  assert.equal(f.store.getById(llm.id).tags.length, 0);
  f.store.addTag(bing.id, "retained tag"); f.panes.refreshHistoryPanes();
  card = pane.list.children[0];
  const remove = findButton(card, "history-delete");
  assert.equal(remove.title, "history-deleteVersion");
  remove.dispatch("click");
  assert.equal(f.store.getById(llm.id), undefined);
  assert.equal(f.store.getById(bing.id).tags[0], "retained tag");
  assert.equal(pane.list.children.length, 1);
  assert.equal(pane.list.children[0].querySelectorAll(".docboxtrans-history-version-button").length, 0);
  assert.ok(findText(pane.list.children[0], "Bing translation"));
});

test("grouping separates attachments and arrow selection remains independent between panels", async t => {
  const f = await fixture(t, { realPane: true });
  const llm = f.store.add("shared source", "file A LLM", "llm", "zh-CN", 10);
  const bing = f.store.add("shared source", "file A Bing", "bing", "zh-CN", 10);
  f.store.add("shared source", "file B LLM", "llm", "zh-CN", 11);
  const a = mountPane(f, makeDocument()), b = mountPane(f, makeDocument());
  versionButton(a.list.children[0], 1).dispatch("click");
  assert.equal(a.list.children[0].dataset.versionId, llm.id);
  assert.equal(b.list.children[0].dataset.versionId, bing.id);
  a.section.onRender({ ...a.params, item: { id: 1, isAttachment: () => false }, tabType: "library" });
  assert.equal(a.list.children.length, 2);
  assert.equal(a.list.querySelectorAll(".docboxtrans-history-version-button").length, 2);
});
