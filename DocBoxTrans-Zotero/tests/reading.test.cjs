const test = require("node:test");
const assert = require("node:assert/strict");
const { fixture, deferred, translationService, makeReader } = require("./harness.cjs");
const { makeDocument, findButton } = require("./dom.cjs");
const event = (content, finish_reason = null) => "data: " + JSON.stringify({
  choices: [{ index: 0, delta: content == null ? {} : { content }, finish_reason }],
}) + "\n\n";

function streamingServer(f) {
  const requests = [];
  f.host.Zotero.HTTP.request = (_method, _url, options) => {
    const gate = deferred(), listeners = new Set();
    const xhr = { status: 200, responseType: "text", responseText: "",
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener) };
    const request = { options, xhr, listeners, cancelled: 0,
      push(chunk) { xhr.responseText += chunk; for (const listener of [...listeners]) listener(); },
      finish() { gate.resolve(xhr); },
    };
    requests.push(request);
    options.requestObserver?.(xhr);
    options.cancellerReceiver?.(() => { request.cancelled++; gate.reject(new Error("cancelled")); });
    return gate.promise;
  };
  f.services.set("llm", f.LlmService);
  return requests;
}

function mountPane(f, window, itemId = 10) {
  f.panes.registerHistoryPane();
  const section = f.sections.get("docboxtrans-history");
  const body = window.doc.createElement("div"); window.doc.body.appendChild(body);
  const params = { body, item: { id: itemId, isAttachment: () => true }, tabType: "reader" };
  section.onInit(params); section.onRender(params);
  return body.querySelector(".docboxtrans-history-root");
}

function mountPopup(f, window, reader) {
  const popup = window.doc.createElement("div"); popup.className = "selection-popup";
  window.doc.body.appendChild(popup);
  f.host.ztoolkit.UI.createElement = (doc, tag, definition) => {
    const element = doc.createElement(tag === "fragment" ? "div" : tag);
    for (const [key, value] of Object.entries(definition.attributes ?? {})) element.setAttribute(key, value);
    if (definition.id) element.id = definition.id;
    element.className = (definition.classList ?? []).join(" ");
    Object.assign(element, definition.properties ?? {});
    Object.assign(element.style, definition.styles ?? {});
    for (const listener of definition.listeners ?? []) element.addEventListener(listener.type, listener.listener);
    for (const child of definition.children ?? []) element.appendChild(f.host.ztoolkit.UI.createElement(doc, child.tag, child));
    return element;
  };
  f.popup.buildReaderPopup({ reader, doc: window.doc, append: element => popup.appendChild(element) });
  return popup;
}

test("SSE parser handles arbitrary chunk boundaries, CRLF, comments and reasoning-only deltas", async t => {
  const f = await fixture(t), updates = [];
  const parser = new f.ChatCompletionStream(text => updates.push(text));
  const stream = '\uFEFF: heartbeat\r\n\r\ndata: {"choices":[{"index":0,"delta":{"reasoning_content":"hidden"}}]}\r\n\r\n' +
    event("中文 ") + event("translation 🧪") + event(null, "stop") + "data: [DONE]\n\n";
  for (const char of stream.split("")) parser.feed(char);
  assert.equal(parser.finish(), "中文 translation 🧪");
  assert.deepEqual(updates, ["中文 ", "中文 translation 🧪"]);
});

test("SSE parser rejects malformed, interrupted and length-limited streams", async t => {
  const f = await fixture(t);
  for (const stream of [event("partial"), event("partial") + event(null, "length") + "data: [DONE]\n\n"]) {
    const parser = new f.ChatCompletionStream(() => {}); parser.feed(stream);
    assert.throws(() => parser.finish(), /status-stream-incomplete/);
  }
  const parser = new f.ChatCompletionStream(() => {});
  assert.throws(() => parser.feed("data: invalid-json\n\n"), /status-stream-invalid/);
  assert.throws(() => new f.ChatCompletionStream(() => {}).feed('data: {"error":{"message":"service failed"}}\n\n'), /service failed/);
});

test("streamed translation updates both UIs without rebuilding history or saving partial text", async t => {
  const f = await fixture(t, { realPane: true }), requests = streamingServer(f);
  f.store.add("previous source", "previous translation", "llm", "zh-CN", 10);
  const window = makeDocument("a"), reader = makeReader("a", 10, window.win);
  f.host.Zotero.Reader._readers = [reader];
  const state = f.readerState.getReaderState(reader); state.selectedText = "new source";
  const root = mountPane(f, window), popup = mountPopup(f, window, reader);
  await f.hooks.onStartup();
  const task = f.actions.createNewTaskFromSelection(state), run = f.tasks.runTranslationTask(task);
  const list = root.querySelector(".docboxtrans-history-list"), card = list.children[0];
  const search = root.querySelector(".docboxtrans-history-search"); search.focus();
  requests[0].push(event("partial "));
  assert.equal(task.status, "processing");
  assert.equal(f.store.count(), 1);
  assert.equal(list.children[0], card);
  assert.equal(window.doc.activeElement, search);
  assert.equal(root.querySelector(".docboxtrans-history-result").textContent, "partial ");
  assert.equal(popup.querySelector("textarea").value, "partial ");
  assert.equal(findButton(root, "popup-force").disabled, true);
  assert.ok(findButton(popup, "popup-cancel"));
  requests[0].push(event("complete") + event(null, "stop") + "data: [DONE]\n\n");
  requests[0].finish(); assert.equal(await run, true);
  assert.equal(task.result, "partial complete"); assert.equal(f.store.count(), 2);
  assert.equal(findButton(root, "popup-force").disabled, false);
  assert.equal(JSON.parse(requests[0].options.body).stream, true);
  assert.equal(requests[0].listeners.size, 0);
  await f.hooks.onShutdown();
});

test("cancel button preserves partial text and combine fragments, with no late progress or history", async t => {
  const f = await fixture(t, { realPane: true }), requests = streamingServer(f);
  const window = makeDocument("a"), reader = makeReader("a", 10, window.win);
  f.host.Zotero.Reader._readers = [reader];
  const state = f.readerState.getReaderState(reader); state.selectedText = "source";
  f.combine.add(10, "first fragment");
  const root = mountPane(f, window), popup = mountPopup(f, window, reader);
  await f.hooks.onStartup();
  const run = f.actions.translateCombined(10, state);
  const task = f.tasks.getLastTask(10, "a");
  requests[0].push(event("kept partial"));
  requests[0].push(event(" and queued update"));
  findButton(popup, "popup-cancel").dispatch("click");
  assert.equal(await run, false);
  assert.equal(task.status, "cancelled"); assert.equal(requests[0].cancelled, 1);
  assert.equal(f.combine.count(10), 1); assert.equal(f.store.count(), 0);
  assert.equal(popup.querySelector("textarea").value, "kept partial and queued update");
  assert.match(root.querySelector(".docboxtrans-history-status").textContent, /status-cancelled-partial/);
  const before = task.result;
  requests[0].push(event("stale text"));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(task.result, before); assert.equal(requests[0].listeners.size, 0);
  await f.hooks.onShutdown();
});

test("stream errors and premature endings preserve partial text but do not write history", async t => {
  for (const invalid of ["data: broken\n\n", ""]) {
    const f = await fixture(t), requests = streamingServer(f);
    const task = f.tasks.createTask("source", 10), run = f.tasks.runTranslationTask(task);
    requests[0].push(event("partial"));
    requests[0].push(invalid); requests[0].finish();
    assert.equal(await run, false);
    assert.equal(task.status, "fail"); assert.equal(task.result, "partial");
    assert.match(task.error, /status-stream-/); assert.equal(f.store.count(), 0);
  }
});

test("compatible services can return JSON to a streaming request without a second request", async t => {
  const f = await fixture(t), requests = streamingServer(f);
  const task = f.tasks.createTask("source", 10), run = f.tasks.runTranslationTask(task);
  requests[0].push(JSON.stringify({ choices: [{ message: { content: "normal JSON translation" } }] }));
  requests[0].finish(); assert.equal(await run, true);
  assert.equal(task.result, "normal JSON translation"); assert.equal(requests.length, 1);
});

test("streaming can be disabled and HTTP errors do not trigger a paid replay", async t => {
  const f = await fixture(t, { prefs: { "llm.stream": false } });
  f.services.set("llm", f.LlmService); let calls = 0;
  f.host.Zotero.HTTP.request = async (_method, _url, options) => {
    calls++; assert.equal(JSON.parse(options.body).stream, false);
    return { status: 200, response: { choices: [{ message: { content: "translation" } }] } };
  };
  assert.equal(await f.tasks.runTranslationTask(f.tasks.createTask("source", 10)), true);
  f.prefs["llm.stream"] = true;
  f.host.Zotero.HTTP.request = async () => { calls++; throw { xmlhttp: {
    status: 400, responseType: "text", responseText: '{"error":{"message":"stream unsupported"}}',
  } }; };
  const task = f.tasks.createTask("different source", 10);
  assert.equal(await f.tasks.runTranslationTask(task), false);
  assert.match(task.error, /stream unsupported/); assert.equal(calls, 2);
});

test("force retranslation bypasses reuse while preserving stable history ID and tags", async t => {
  const f = await fixture(t, { prefs: { reuseTranslation: true } });
  const saved = f.store.add("source", "cached", "llm", "zh-CN", 10);
  f.store.addTag(saved.id, "important"); let calls = 0;
  f.services.set("llm", translationService("llm", async () => { calls++; return { text: "fresh" }; }));
  const task = f.tasks.createTask("source", 10);
  assert.equal(await f.tasks.runTranslationTask(task), true);
  assert.equal(task.result, "cached"); assert.equal(calls, 0);
  const fresh = f.actions.rerunWith(task, { force: true });
  assert.equal(await f.tasks.runTranslationTask(fresh), true);
  assert.equal(calls, 1); assert.equal(fresh.result, "fresh");
  assert.equal(fresh.recordId, saved.id);
  assert.equal(f.store.getById(saved.id).tags[0], "important");
});

test("PDF cleanup repairs wrapped words while preserving paragraphs, lists, compounds and tables", async t => {
  const f = await fixture(t);
  const examples = [
    ["This is a wrapped\nparagraph.", "This is a wrapped paragraph."],
    ["trans-\nlation", "translation"],
    ["inter\u00ad\nnational", "international"],
    ["well-\nknown result", "well-known result"],
    ["state-\nof-the-art", "state-of-the-art"],
    ["double-\nblind", "double-blind"],
    ["RNA-\nseq", "RNA-seq"],
    ["First sentence.\nSecond sentence.", "First sentence.\nSecond sentence."],
    ["First paragraph\n\nnext paragraph", "First paragraph\n\nnext paragraph"],
    ["introductory text\n1. first item\n2. second item", "introductory text\n1. first item\n2. second item"],
    ["Heading\nA new section", "Heading\nA new section"],
    ["中文断\n行文本", "中文断行文本"],
    ["Gene\tValue\nABC\t123", "Gene\tValue\nABC\t123"],
    ["measurement = 5\n+ 2", "measurement = 5\n+ 2"],
  ];
  for (const [source, expected] of examples) assert.equal(f.text.preprocessPdfText(source), expected, source);
});

test("PDF cleanup is optional, retains original input for reruns and does not alter EPUB text", async t => {
  const f = await fixture(t);
  const source = "wrapped\nparagraph";
  const pdf = f.tasks.createTask(source, 10, "llm", { pageIndex: 1 });
  assert.equal(pdf.raw, "wrapped paragraph"); assert.equal(pdf.originalRaw, source);
  assert.equal(f.tasks.createTask(source, 11, "llm", undefined, false, "epub", false).raw, source);
  f.prefs.preprocessText = false;
  f.services.set("llm", translationService("llm", async request => ({ text: request.raw })));
  const rerun = f.actions.rerunWith(pdf, { force: true });
  await f.tasks.runTranslationTask(rerun); assert.equal(rerun.raw, source);
});

test("fragment merging removes full duplicates and long overlap without eating short word matches", async t => {
  const f = await fixture(t);
  const examples = [
    [["alpha shared phrase", "shared phrase continues"], "alpha shared phrase continues"],
    [["alpha shared\nphrase", "shared phrase continues"], "alpha shared\nphrase continues"],
    [["one complete fragment", "one complete fragment"], "one complete fragment"],
    [["a longer sentence containing the fragment", "containing the fragment"], "a longer sentence containing the fragment"],
    [["alpha", "alpha with additional context"], "alpha alpha with additional context"],
    [["scatter", "cat"], "scatter cat"],
    [["the final word", "word is repeated"], "the final word word is repeated"],
    [["文献中共有的六个汉字", "六个汉字以及后文"], "文献中共有的六个汉字六个汉字以及后文"],
    [["前文这是足够长的重复片段", "这是足够长的重复片段后文"], "前文这是足够长的重复片段后文"],
    [["first 🧪 repeated phrase", "🧪 repeated phrase second"], "first 🧪 repeated phrase second"],
  ];
  for (const [fragments, expected] of examples) assert.equal(f.text.mergeFragments(fragments), expected, fragments.join(" | "));
});

test("reordering is document-scoped and successful translation clears only its snapshot", async t => {
  const f = await fixture(t);
  f.combine.add(10, "second fragment", { pageIndex: 2 });
  f.combine.add(10, "first fragment", { pageIndex: 1 });
  f.combine.add(11, "other document");
  const first = f.combine.list(10)[1];
  assert.equal(f.combine.move(10, first.id, -1), true);
  assert.equal(f.combine.firstPosition(10).pageIndex, 1);
  assert.equal(f.combine.move(10, first.id, -1), false);
  assert.equal(f.combine.move(11, first.id, 1), false);
  const gate = deferred(); let raw;
  f.services.set("llm", translationService("llm", async request => { raw = request.raw; return { text: await gate.promise }; }));
  const run = f.actions.translateCombined(10);
  assert.equal(raw, "first fragment second fragment");
  f.combine.move(10, first.id, 1); f.combine.add(10, "added during translation");
  gate.resolve("translated"); assert.equal(await run, true);
  assert.equal(f.combine.join(10), "added during translation");
  assert.equal(f.combine.join(11), "other document");
});

test("forced retranslation with a combine basket uses the current ordered fragments", async t => {
  const f = await fixture(t, { prefs: { reuseTranslation: true } });
  const window = makeDocument("a"), reader = makeReader("a", 10, window.win);
  f.host.Zotero.Reader._readers = [reader];
  const state = f.readerState.getReaderState(reader); state.selectedText = "unrelated selection";
  f.store.add("first fragment second fragment", "cached", "llm", "zh-CN", 10);
  f.tasks.createTask("previous task", 10, "llm", undefined, false, "a");
  f.combine.add(10, "second fragment"); f.combine.add(10, "first fragment");
  f.combine.move(10, f.combine.list(10)[1].id, -1);
  let raw;
  f.services.set("llm", translationService("llm", async request => { raw = request.raw; return { text: "fresh" }; }));
  assert.equal(await f.actions.forceRetranslate(state), true);
  assert.equal(raw, "first fragment second fragment");
  assert.equal(f.tasks.getLastTask(10, "a").result, "fresh");
  assert.equal(f.combine.count(10), 0);
});

test("completed tasks ignore late progress callbacks", async t => {
  const f = await fixture(t); let progress;
  f.services.set("llm", translationService("llm", async request => {
    progress = request.onProgress; progress("partial"); return { text: "complete" };
  }));
  const task = f.tasks.createTask("source", 10);
  assert.equal(await f.tasks.runTranslationTask(task), true);
  progress("late progress");
  assert.equal(task.result, "complete");
  assert.equal(f.store.getById(task.recordId).translatedText, "complete");
});

test("an unavailable popup cannot block progress in another reader's sidebar", async t => {
  const f = await fixture(t, { realPane: true }), requests = streamingServer(f);
  const a = makeDocument("a"), b = makeDocument("b");
  const ra = makeReader("a", 10, a.win), rb = makeReader("b", 11, b.win);
  f.host.Zotero.Reader._readers = [ra, rb];
  f.readerState.getReaderState(ra).currentPopup = { querySelector() { throw new Error("closed window"); } };
  const state = f.readerState.getReaderState(rb); state.selectedText = "source";
  const root = mountPane(f, b, 11);
  await f.hooks.onStartup();
  const run = f.tasks.runTranslationTask(f.actions.createNewTaskFromSelection(state));
  requests[0].push(event("visible progress"));
  assert.equal(root.querySelector(".docboxtrans-history-result").textContent, "visible progress");
  requests[0].push(event(null, "stop") + "data: [DONE]\n\n"); requests[0].finish();
  assert.equal(await run, true);
  await f.hooks.onShutdown();
});

test("popup and sidebar share reorder controls and the forced-retranslation action", async t => {
  const f = await fixture(t, { realPane: true }), window = makeDocument("a");
  const reader = makeReader("a", 10, window.win); f.host.Zotero.Reader._readers = [reader];
  const state = f.readerState.getReaderState(reader); state.selectedText = "source";
  f.services.set("llm", translationService("llm", async () => ({ text: "translated" })));
  const saved = f.store.add("source", "cached", "llm", "zh-CN", 10); f.prefs.reuseTranslation = true;
  const root = mountPane(f, window), popup = mountPopup(f, window, reader);
  await f.hooks.onStartup();
  await f.tasks.runTranslationTask(f.actions.createNewTaskFromSelection(state));
  findButton(popup, "popup-force").dispatch("click");
  await f.tasks.runTranslationTask(f.tasks.getLastTask(10, "a"));
  assert.equal(f.store.getById(saved.id).translatedText, "translated");
  f.combine.add(10, "first fragment"); f.combine.add(10, "second fragment");
  f.actions.refreshCombineViews();
  const firstDown = popup.querySelectorAll("button").find(button => button.title === "combine-moveDown" && !button.disabled);
  firstDown.dispatch("click");
  assert.equal(f.combine.list(10)[0].text, "second fragment");
  assert.match(root.textContent, /1\. second fragment/);
  const remove = root.querySelectorAll("button").find(button => button.title === "combine-removeTitle");
  remove.dispatch("click"); assert.equal(f.combine.count(10), 1);
  assert.match(popup.textContent, /first fragment/);
  await f.hooks.onShutdown();
});
