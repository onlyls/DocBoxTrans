const test = require("node:test");
const assert = require("node:assert/strict");
const { fixture, deferred, translationService, makeWindow, makeReader, makePopupEvent } = require("./harness.cjs");
const plain = value => JSON.parse(JSON.stringify(value));
const record = (extra = {}) => ({ id: "saved-id", sourceText: "source", translatedText: "saved",
  provider: "llm", targetLanguage: "zh-CN", itemId: 10, tags: ["important"], ...extra });

test("paragraph tags are shared for add/remove/clear, new services and retranslation but isolated by source and file", async t => {
  const f = await fixture(t);
  await f.store.ensureLoaded();
  const llm = f.store.add("source", "LLM", "llm", "zh-CN", 10);
  const bing = f.store.add("source", "Bing", "bing", "en", 10);
  const otherFile = f.store.add("source", "other file", "llm", "zh-CN", 11);
  const otherSource = f.store.add("different source", "other paragraph", "llm", "zh-CN", 10);
  assert.equal(f.store.addTag(bing.id, " Shared "), true);
  assert.deepEqual(plain(f.store.getById(llm.id).tags), ["Shared"]);
  assert.equal(f.store.addTag(llm.id, "shared"), false);
  assert.equal(otherFile.tags.length, 0); assert.equal(otherSource.tags.length, 0);
  const google = f.store.add("source", "Google", "google", "zh-CN", 10);
  assert.deepEqual(plain(google.tags), ["Shared"]);
  const rerun = f.store.add("source", "updated", "llm", "zh-CN", 10);
  assert.equal(rerun.id, llm.id); assert.deepEqual(plain(rerun.tags), ["Shared"]);
  assert.equal(f.store.removeTag(google.id, "SHARED"), true);
  assert.equal(rerun.tags.length, 0); assert.equal(bing.tags.length, 0);
  f.store.addTag(rerun.id, "another");
  assert.equal(f.store.clearTags(bing.id), true);
  assert.equal(rerun.tags.length, 0); assert.equal(google.tags.length, 0);
});

test("loading legacy provider tags merges their union and persists shared edits without resurrecting removed tags", async t => {
  const original = [
    record({ id: "llm", tags: ["Alpha"] }),
    record({ id: "bing", provider: "bing", tags: ["alpha", " Beta "] }),
    record({ id: "english", targetLanguage: "en", tags: ["Gamma"] }),
    record({ id: "other-file", itemId: 11, tags: ["Private"] }),
  ].map(JSON.stringify).join("\n");
  const f = await fixture(t, { text: original });
  await f.store.ensureLoaded();
  for (const id of ["llm", "bing", "english"]) {
    assert.deepEqual(plain(f.store.getById(id).tags), ["Alpha", "Beta", "Gamma"]);
  }
  assert.deepEqual(plain(f.store.getById("other-file").tags), ["Private"]);
  await f.store.flush();
  assert.equal(f.disk.writes[0].backup, original);
  f.store.removeTag("bing", "alpha");
  await f.store.flush();
  const reopened = await fixture(t, { text: f.disk.text });
  await reopened.store.ensureLoaded();
  for (const id of ["llm", "bing", "english"]) {
    assert.deepEqual(plain(reopened.store.getById(id).tags), ["Beta", "Gamma"]);
  }
  reopened.store.addTag("english", "New");
  assert.deepEqual(plain(reopened.store.getById("llm").tags), ["Beta", "Gamma", "New"]);
});

test("retranslation preserves ID, tags and position; provider/language variants survive reload", async t => {
  const f = await fixture(t);
  await f.store.ensureLoaded();
  const original = f.store.add("source", "first", "llm", "zh-CN", 10, { pageIndex: 2 });
  f.store.addTag(original.id, "important");
  const updated = f.store.add("source", "second", "llm", "zh-CN", 10);
  assert.equal(updated.id, original.id);
  assert.deepEqual(plain(updated.tags), ["important"]);
  assert.equal(updated.position.pageIndex, 2);
  const other = f.store.add("source", "bing version", "bing", "zh-CN", 10);
  assert.notEqual(other.id, original.id);
  assert.deepEqual(plain(other.tags), ["important"]);
  f.store.add("source", "English version", "llm", "en", 10);
  assert.equal(f.store.count(), 3);
  await f.store.flush();
  const reopened = await fixture(t, { text: f.disk.text });
  await reopened.store.ensureLoaded();
  assert.equal(reopened.store.count(), 3);
  assert.equal(reopened.store.findBySource("source", 10, "LLM", "ZH-CN").id, original.id);
  assert.equal(reopened.store.findBySource("source", 10, "llm", "en").translatedText, "English version");
});

test("old duplicate rows merge tags while retaining the latest translation", async t => {
  const old = record({ id: "old", tags: ["old-tag"] });
  const latest = record({ id: "new", tags: ["new-tag"], translatedText: "latest" });
  const f = await fixture(t, { text: [old, latest].map(JSON.stringify).join("\n") });
  await f.store.ensureLoaded();
  assert.equal(f.store.count(), 1);
  const found = f.store.findBySource("source", 10, "llm", "zh-CN");
  assert.equal(found.id, "old");
  assert.equal(found.translatedText, "latest");
  assert.deepEqual(plain(found.tags), ["old-tag", "new-tag"]);
});

test("read failure never overwrites the old file; retry merges in-memory translations", async t => {
  const original = JSON.stringify(record());
  const f = await fixture(t, { text: original });
  f.disk.readError = new Error("permission denied");
  await assert.rejects(f.store.ensureLoaded(), /permission denied/);
  f.store.add("new source", "new translation", "bing", "en", 11);
  await assert.rejects(f.store.flush(), /permission denied/);
  assert.equal(f.disk.writes.length, 0);
  assert.equal(f.disk.text, original);
  assert.equal(f.store.hasStorageError(), true);
  f.disk.readError = null;
  await f.store.flush();
  assert.equal(f.store.hasStorageError(), false);
  assert.equal(f.store.count(), 2);
  assert.deepEqual(plain(f.store.findBySource("source", 10, "llm", "zh-CN").tags), ["important"]);
  assert.equal(f.disk.writes[0].backup, original);
  assert.equal(f.disk.writes[0].settings.tmpPath, f.disk.writes[0].file + ".tmp");
  assert.equal(f.disk.writes[0].settings.backupFile, f.disk.writes[0].file + ".bak");
});

test("retrying a translation after a read error preserves old tags and stable ID", async t => {
  const f = await fixture(t, { text: JSON.stringify(record()) });
  f.disk.readError = new Error("temporary failure");
  await assert.rejects(f.store.ensureLoaded());
  const pending = f.store.add("source", "new translation", "llm", "zh-CN", 10);
  const pendingId = pending.id;
  f.disk.readError = null;
  await f.store.flush();
  const found = f.store.findBySource("source", 10, "llm", "zh-CN");
  assert.equal(found.id, "saved-id");
  assert.equal(found.translatedText, "new translation");
  assert.deepEqual(plain(found.tags), ["important"]);
  assert.equal(f.store.getById(pendingId), found);
  assert.equal(f.store.addTag(pendingId, "after recovery"), true);
});

test("concurrent loads share one disk read", async t => {
  const f = await fixture(t, { text: JSON.stringify(record()) });
  const gate = deferred(), started = deferred();
  f.host.IOUtils.readUTF8 = async () => { f.disk.reads++; started.resolve(); await gate.promise; return f.disk.text; };
  const first = f.store.ensureLoaded(), second = f.store.ensureLoaded();
  await started.promise;
  assert.equal(f.disk.reads, 1);
  gate.resolve(); await Promise.all([first, second]);
  assert.equal(f.store.count(), 1);
});

test("writes are serialized and flush includes changes made during a write", async t => {
  const f = await fixture(t);
  await f.store.ensureLoaded();
  const gate = deferred(), started = deferred();
  let count = 0;
  f.disk.beforeWrite = async () => { if (++count === 1) { started.resolve(); await gate.promise; } };
  f.store.add("first", "one", "llm", "zh-CN", 10);
  const first = f.store.flush();
  await started.promise;
  const next = f.store.add("second", "two", "llm", "zh-CN", 10);
  f.store.addTag(next.id, "added during write");
  const second = f.store.flush();
  gate.resolve(); await Promise.all([first, second]);
  assert.equal(f.disk.maxActiveWrites, 1);
  assert.equal(f.disk.writes.length, 2);
  assert.deepEqual(JSON.parse(f.disk.text.split("\n")[1]).tags, ["added during write"]);
});

test("failed write remains pending and can be flushed again", async t => {
  const f = await fixture(t);
  f.store.add("source", "translation", "llm", "zh-CN", 10);
  f.disk.writeError = new Error("disk full");
  await assert.rejects(f.store.flush(), /disk full/);
  assert.equal(f.disk.text, null);
  f.disk.writeError = null;
  await f.store.flush();
  assert.equal(JSON.parse(f.disk.text).translatedText, "translation");
});

test("damaged rows do not hide valid records; original contents are backed up", async t => {
  const text = JSON.stringify(record()) + "\n{damaged\n";
  const f = await fixture(t, { text });
  await f.store.ensureLoaded();
  assert.equal(f.store.count(), 1);
  f.store.addTag("saved-id", "new-tag");
  await f.store.flush();
  assert.equal(f.disk.writes[0].backup, text);
});

test("older responses cannot overwrite a newer task or enter history/context", async t => {
  const f = await fixture(t);
  const old = deferred(), newer = deferred();
  let oldSignal;
  f.services.set("llm", translationService("llm", async task => {
    oldSignal = task.signal; return { text: await old.promise };
  }));
  f.services.set("bing", translationService("bing", async task => { return { text: await newer.promise }; }));
  const first = f.tasks.createTask("source", 10, "llm", undefined, undefined, "reader-a");
  const firstRun = f.tasks.runTranslationTask(first);
  const second = f.actions.rerunWith(first, { service: "bing" });
  const secondRun = f.tasks.runTranslationTask(second);
  assert.notEqual(first.id, second.id);
  assert.equal(first.service, "llm");
  assert.equal(oldSignal.aborted, true);
  newer.resolve("new translation"); assert.equal(await secondRun, true);
  old.resolve("stale translation"); assert.equal(await firstRun, false);
  assert.equal(second.result, "new translation");
  assert.equal(first.status, "cancelled");
  assert.equal(f.store.count(), 1);
  assert.equal(f.context.getCount(), 1);
  assert.equal(f.store.findBySource("source", 10, "llm", "zh-CN"), undefined);
});

test("duplicate starts of the same task share the in-flight request", async t => {
  const f = await fixture(t);
  const gate = deferred(); let calls = 0;
  f.services.set("llm", translationService("llm", async task => { calls++; return { text: await gate.promise }; }));
  const task = f.tasks.createTask("source", 10);
  const first = f.tasks.runTranslationTask(task), second = f.tasks.runTranslationTask(task);
  assert.equal(first, second);
  assert.equal(calls, 1);
  gate.resolve("translation"); await first;
  assert.equal(f.store.count(), 1);
});

test("empty result fails and preserves combine fragments; successful retry removes only its snapshot", async t => {
  const f = await fixture(t);
  f.services.set("llm", translationService("llm", async task => { return { text: " \n " }; }));
  f.combine.add(10, "first");
  assert.equal(await f.actions.translateCombined(10), false);
  assert.equal(f.combine.count(10), 1);
  assert.equal(f.store.count(), 0);
  assert.equal(f.tasks.getLastTask(10).status, "fail");
  const gate = deferred();
  f.services.set("llm", translationService("llm", async task => { return { text: await gate.promise }; }));
  const retry = f.actions.translateCombined(10);
  f.combine.add(10, "added later");
  gate.resolve("translation");
  assert.equal(await retry, true);
  assert.deepEqual(plain(f.combine.list(10).map(item => item.text)), ["added later"]);
});

test("shutdown cancels requests and prevents late writes", async t => {
  const f = await fixture(t);
  const gate = deferred(); let signal;
  f.services.set("llm", translationService("llm", async task => { signal = task.signal; return { text: await gate.promise }; }));
  const task = f.tasks.createTask("source", 10);
  const promise = f.tasks.runTranslationTask(task);
  f.tasks.stopTranslationTasks();
  assert.equal(signal.aborted, true);
  gate.resolve("late result"); assert.equal(await promise, false);
  assert.equal(f.store.count(), 0);
});

test("LLM uses task language and accepts temperature zero, including legacy and custom prompts", async t => {
  const f = await fixture(t, { prefs: { targetLanguage: "zh-CN", "llm.temperature": "0" } });
  const requests = [];
  f.host.Zotero.HTTP.request = async (_method, _url, options) => {
    requests.push(JSON.parse(options.body));
    return { status: 200, response: { choices: [{ message: { content: "translation" } }] } };
  };
  const legacy = "你是专业的翻译引擎。把用户提供的文本翻译成简体中文，只输出译文本身，不要任何解释、标注或原文。保留原有的换行和标点结构。";
  const custom = "Translate to {targetLanguage}. Keep terminology.";
  for (const prompt of ["", legacy, legacy.replace("简体中文", "{targetLanguage}"), custom]) {
    f.prefs["llm.systemPrompt"] = prompt;
    const task = { raw: "原文", langto: "en" };
    const result = await f.LlmService.translate(task, []);
    const body = requests.at(-1);
    assert.equal(body.temperature, 0);
    assert.match(body.messages[0].content, /Target language: en/);
    assert.doesNotMatch(body.messages[0].content, /\{targetLanguage\}|翻译成简体中文/);
    if (prompt === custom) assert.ok(body.messages[0].content.startsWith("Translate to en. Keep terminology."));
    else assert.match(body.messages[0].content, /面向各学科[\s\S]*不预设学科背景/);
    assert.equal(result.text, "translation");
  }
});

test("LLM rejects empty content and invalid temperatures; connection probe reports failure", async t => {
  const f = await fixture(t);
  f.host.Zotero.HTTP.request = async () => ({ status: 200,
    response: { choices: [{ message: { content: "  " } }] } });
  await assert.rejects(f.LlmService.translate({ raw: "source", langto: "en" }, []));
  assert.equal((await f.probeConnection()).ok, false);
  for (const value of ["NaN", "-1", "3"]) {
    f.prefs["llm.temperature"] = value;
    await assert.rejects(f.LlmService.translate({ raw: "source", langto: "en" }, []), /status-invalid-temperature/);
    assert.equal((await f.probeConnection()).ok, false);
  }
});

test("Google, Bing, Tencent and Youdao use the task's captured target language", async t => {
  const f = await fixture(t, { prefs: { targetLanguage: "zh-CN" } });
  const seen = [];
  f.host.Zotero.HTTP.request = async (_method, url, options) => {
    seen.push({ url, body: options.body });
    let response;
    if (url.includes("google")) return { status: 200, responseText: '[[["translation","source"]]]' };
    if (url.includes("microsoft")) response = [{ translations: [{ text: "translation" }] }];
    else if (url.includes("transmart")) response = { auto_translation: "translation" };
    else response = { errorCode: "0", translation: ["translation"] };
    return { status: 200, response };
  };
  for (const service of [f.GoogleService, f.BingService, f.TencentService, f.YoudaoService]) {
    await service.translate({ raw: "source", langto: "en" }, []);
  }
  assert.equal(new URL(seen[0].url).searchParams.get("tl"), "en");
  assert.equal(new URL(seen[1].url).searchParams.get("to"), "en");
  assert.equal(JSON.parse(seen[2].body).target.lang, "en");
  assert.equal(new URLSearchParams(seen[3].body).get("to"), "en");
});

test("HTTP cancellation reaches Zotero's canceller and pre-cancelled requests never start", async t => {
  const f = await fixture(t);
  const controller = new AbortController(); let calls = 0, cancelled = 0;
  f.host.Zotero.HTTP.request = (_method, _url, options) => new Promise((_resolve, reject) => {
    calls++; options.cancellerReceiver(() => { cancelled++; reject(new Error("cancelled")); });
  });
  const request = f.http.httpJson("POST", "https://example.invalid", { signal: controller.signal });
  controller.abort(); await assert.rejects(request);
  assert.equal(cancelled, 1);
  await assert.rejects(f.http.httpJson("POST", "https://example.invalid", { signal: controller.signal }));
  assert.equal(calls, 1);
});

test("cancelling Google's retry wait prevents subsequent network requests", async t => {
  const f = await fixture(t);
  const started = deferred(), controller = new AbortController(); let calls = 0;
  f.host.Zotero.HTTP.request = async () => { calls++; started.resolve(); throw { status: 429 }; };
  const promise = f.GoogleService.translate({ raw: "source", langto: "en", signal: controller.signal }, []);
  await started.promise;
  controller.abort();
  await assert.rejects(promise);
  assert.equal(calls, 1);
});

test("HTTP error parsing supports JSON XHRs and allowNon2xx still rejects transport failures", async t => {
  const f = await fixture(t);
  f.host.Zotero.HTTP.request = async () => { throw { xmlhttp: {
    status: 401, responseType: "json", response: { error: { message: "bad key" } },
    get responseText() { throw new Error("InvalidStateError"); },
  } }; };
  await assert.rejects(f.http.httpJson("GET", "https://example.invalid"), error =>
    error.status === 401 && error.body.includes("bad key"));
  f.host.Zotero.HTTP.request = async () => { throw new Error("offline"); };
  await assert.rejects(f.http.httpRequest("GET", "https://example.invalid", { allowNon2xx: true }));
});

test("reader instances retain their own tasks and popup callbacks after another reader is used", async t => {
  const f = await fixture(t);
  const win = makeWindow("a"), a = makeReader("a", 10, win), b = makeReader("b", 11, win);
  f.host.Zotero.Reader._readers = [a, b];
  f.services.set("llm", translationService("llm", async task => { return { text: task.raw + " translation" }; }));
  f.services.set("bing", translationService("bing", async task => { return { text: "bing " + task.raw }; }));
  const sa = f.readerState.getReaderState(a), sb = f.readerState.getReaderState(b);
  sa.selectedText = "paper A"; sb.selectedText = "paper B";
  const ta = f.actions.createNewTaskFromSelection(sa); await f.tasks.runTranslationTask(ta);
  const pa = makePopupEvent(a); f.popup.buildReaderPopup(pa.event);
  const tb = f.actions.createNewTaskFromSelection(sb); await f.tasks.runTranslationTask(tb);
  const pb = makePopupEvent(b); f.popup.buildReaderPopup(pb.event);
  f.popup.updateReaderPopup();
  assert.equal(pa.textarea.value, "paper A translation");
  assert.equal(pb.textarea.value, "paper B translation");
  const buttons = pa.definition.children.find(child => child.id?.endsWith("-services")).children;
  const click = buttons.find(button => button.attributes["data-service"] === "bing").listeners[0].listener;
  click({ currentTarget: { getAttribute: () => "bing" } });
  const rerun = f.tasks.getLastTask(10, "a"); await f.tasks.runTranslationTask(rerun);
  assert.equal(rerun.raw, "paper A");
  assert.equal(f.tasks.getLastTask(11, "b"), tb);
  assert.equal(pb.textarea.value, "paper B translation");
});

test("active tab, reader iframe, library tab and separate windows resolve without stale fallback", async t => {
  const f = await fixture(t);
  const win = makeWindow("b"), a = makeReader("a", 10, win), b = makeReader("b", 11, win);
  const otherWindow = makeWindow("c"), c = makeReader("c", 10, otherWindow);
  f.host.Zotero.Reader._readers = [a, b, c];
  assert.equal(f.readerState.getActiveReaderState(win).readerId, "b");
  assert.equal(f.readerState.getActiveReaderState(b._iframeWindow).readerId, "b");
  assert.equal(f.readerState.getReaderStateForItem(10, otherWindow).readerId, "c");
  assert.equal(f.readerState.getReaderStateForItem(10, win).readerId, "a");
  win.Zotero_Tabs.selectedID = "zotero-pane";
  assert.equal(f.readerState.getActiveReaderState(win), undefined);
  assert.equal(f.readerState.getActiveReaderState(), undefined);
  // 独立阅读器窗口没有 Zotero_Tabs，tabID 为空。
  const standaloneWindow = {}; standaloneWindow.top = standaloneWindow;
  const standalone = { _instanceID: "standalone", itemID: 12, _window: standaloneWindow };
  f.host.Zotero.Reader._readers.push(standalone);
  assert.equal(f.readerState.getActiveReaderState(standaloneWindow).readerId, "standalone");
});

test("startup registers a shutdown barrier; keyboard targets the actual active document", async t => {
  const f = await fixture(t);
  f.services.set("llm", translationService("llm", async task => { return { text: "translation" }; }));
  await f.hooks.onStartup();
  assert.ok(f.barrier.blocker);
  const win = makeWindow("b"), a = makeReader("a", 10, win), b = makeReader("b", 11, win);
  f.host.Zotero.Reader._readers = [a, b];
  f.readerState.getReaderState(a).selectedText = "A";
  f.readerState.getReaderState(b).selectedText = "B";
  const event = { view: win, shortcut: "Alt+Shift+A", target: { tagName: "DIV" },
    preventDefault() {}, stopPropagation() {} };
  f.events.get("keyboard")(event, { type: "keydown" });
  assert.equal(f.combine.count(10), 0);
  assert.equal(f.combine.join(11), "B");
  win.Zotero_Tabs.selectedID = "zotero-pane";
  f.events.get("keyboard")(event, { type: "keydown" });
  assert.equal(f.combine.count(10), 0);
  f.store.add("source", "translation", "llm", "zh-CN", 10);
  const blocker = f.barrier.blocker;
  await blocker();
  assert.equal(JSON.parse(f.disk.text).translatedText, "translation");
});

test("context keeps provider variants and ignores older completions for the same version", async t => {
  const f = await fixture(t);
  const generation = f.context.getGeneration();
  f.context.add(record({ translatedText: "new" }), 2, generation);
  f.context.add(record({ translatedText: "old" }), 1, generation);
  f.context.add(record({ provider: "bing", translatedText: "bing" }), 3, generation);
  assert.equal(f.context.snapshot(10, "llm", "zh-CN", 4, 1500)[0].translatedText, "new");
  assert.equal(f.context.snapshot(10, "bing", "zh-CN", 4, 1500)[0].translatedText, "bing");
});

test("the same PDF in two windows has independent selections, tasks and popups", async t => {
  const f = await fixture(t);
  const a = makeReader("a", 10), b = makeReader("b", 10);
  f.host.Zotero.Reader._readers = [a, b];
  f.services.set("llm", translationService("llm", async task => { return { text: task.raw + " translated" }; }));
  const sa = f.readerState.getReaderState(a), sb = f.readerState.getReaderState(b);
  sa.selectedText = "first window"; sb.selectedText = "second window";
  const pa = makePopupEvent(a), pb = makePopupEvent(b);
  f.popup.buildReaderPopup(pa.event); f.popup.buildReaderPopup(pb.event);
  const ta = f.actions.createNewTaskFromSelection(sa), tb = f.actions.createNewTaskFromSelection(sb);
  await Promise.all([f.tasks.runTranslationTask(ta), f.tasks.runTranslationTask(tb)]);
  f.popup.updateReaderPopup();
  assert.equal(pa.textarea.value, "first window translated");
  assert.equal(pb.textarea.value, "second window translated");
  assert.equal(f.tasks.getLastTask(10, "a"), ta);
  assert.equal(f.tasks.getLastTask(10, "b"), tb);
});

test("disabling awaits pending writes and shares one shutdown promise", async t => {
  const f = await fixture(t);
  f.host.Zotero.DocBoxTrans = f.host.addon;
  const gate = deferred(), started = deferred();
  f.disk.beforeWrite = async () => { started.resolve(); await gate.promise; };
  f.store.add("source", "translation", "llm", "zh-CN", 10);
  const first = f.hooks.onShutdown(), second = f.hooks.onShutdown();
  assert.equal(first, second);
  assert.equal(f.host.addon.data.shutdownPromise, first);
  await started.promise;
  assert.equal(f.host.Zotero.DocBoxTrans, f.host.addon);
  gate.resolve(); await first;
  assert.equal(f.host.Zotero.DocBoxTrans, undefined);
  assert.equal(JSON.parse(f.disk.text).translatedText, "translation");
});
