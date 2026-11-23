const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { FluentParser } = require("@fluent/syntax");
const { fixture, deferred, makeReader } = require("./harness.cjs");
const { makeDocument, findButton } = require("./dom.cjs");

const plain = value => JSON.parse(JSON.stringify(value));
const ids = services => Array.from(services, service => service.id);
function addProfile(f, name = "Second model") {
  const profile = { ...f.serviceConfig.createLlmProfile(), name, apiKey: "second-key",
    endpoint: "https://second.invalid/v1/chat/completions", model: "second-model", stream: false };
  f.serviceConfig.saveLlmProfile(profile);
  return profile;
}

test("migration preserves every legacy parameter and llm identity without overwriting new settings on restart", async t => {
  const f = await fixture(t, { realServices: true, prefs: { "llm.stream": false, "llm.temperature": "0",
    "llm.systemPrompt": "Custom {targetLanguage}" } });
  const before = plain(f.serviceConfig.readServiceConfig());
  assert.equal(f.prefs["services.config"], undefined, "reading does not migrate implicitly");
  f.serviceConfig.initializeServiceConfig();
  assert.deepEqual(plain(f.serviceConfig.readServiceConfig()), before);
  assert.equal(before.profiles[0].id, "llm");
  assert.equal(before.profiles[0].temperature, "0");
  assert.equal(before.profiles[0].stream, false);
  assert.equal(f.prefs["llm.systemPrompt"], "Custom {targetLanguage}");
  const profile = addProfile(f);
  f.serviceConfig.saveLlmProfile({ ...before.profiles[0], name: "Renamed original" });
  const reopened = await fixture(t, { realServices: true, prefs: { ...f.prefs, "llm.model": "obsolete" } });
  reopened.serviceConfig.initializeServiceConfig();
  assert.deepEqual(plain(reopened.serviceConfig.readServiceConfig()), plain(f.serviceConfig.readServiceConfig()));
  assert.equal(reopened.registry.getDisplayName("llm"), "Renamed original");
  assert.deepEqual(ids(reopened.registry.getAll()).slice(0, 2), ["llm", profile.id]);
});

test("damaged or newer service storage is never replaced by migration or editing", async t => {
  for (const raw of ['{"version":2}', 'broken json', '{"version":1,"profiles":null}']) {
    const f = await fixture(t, { realServices: true, prefs: { "services.config": raw } });
    assert.throws(() => f.serviceConfig.initializeServiceConfig(), /services-storage-error/);
    assert.throws(() => f.serviceConfig.setServiceVisible("google", false), /services-storage-error/);
    assert.equal(f.prefs["services.config"], raw);
    assert.equal(f.prefs["llm.apiKey"], "test-key");
  }
});

test("invalid and duplicate profiles never alter saved settings", async t => {
  const f = await fixture(t, { realServices: true });
  f.serviceConfig.initializeServiceConfig();
  const profile = addProfile(f);
  const before = f.prefs["services.config"];
  for (const patch of [{ name: " " }, { name: "service-llm" }, { name: "service-google" },
    { endpoint: "file:///secret" }, { endpoint: "https://" }, { model: "" }, { apiKey: "" },
    { temperature: "NaN" }, { temperature: "2.1" }, { temperature: "-1" }]) {
    assert.throws(() => f.serviceConfig.saveLlmProfile({ ...profile, ...patch }));
    assert.equal(f.prefs["services.config"], before);
  }
  f.serviceConfig.saveLlmProfile({ ...profile, name: " Renamed ", temperature: "0" });
  assert.equal(f.registry.getDisplayName(profile.id), "Renamed");
  assert.equal(f.registry.getById(profile.id).id, profile.id);
});

test("visibility shares an ordered global list, falls back from a hidden default, and keeps one visible service", async t => {
  const f = await fixture(t, { realServices: true });
  f.serviceConfig.initializeServiceConfig();
  const profile = addProfile(f);
  let changes = 0;
  const unsubscribe = f.serviceConfig.subscribeServiceConfig(() => changes++);
  f.serviceConfig.selectService(profile.id);
  f.serviceConfig.setServiceVisible(profile.id, false);
  assert.equal(f.prefs.translateSource, "llm");
  f.serviceConfig.setServiceVisible("llm", false);
  assert.equal(f.prefs.translateSource, "google");
  for (const id of ["bing", "tencent", "youdao", "cnki"]) f.serviceConfig.setServiceVisible(id, false);
  assert.deepEqual(ids(f.registry.getVisible()), ["google"]);
  assert.throws(() => f.serviceConfig.setServiceVisible("google", false), /services-keep-one/);
  assert.throws(() => f.serviceConfig.selectService(profile.id));
  assert.equal(f.prefs.translateSource, "google");
  unsubscribe(); const count = changes;
  f.serviceConfig.setServiceVisible(profile.id, true);
  assert.equal(changes, count);
  assert.deepEqual(ids(f.registry.getVisible()), [profile.id, "google"]);
  assert.equal(f.host.addon.data.translate.queue.length, 0);
});

test("model requests and draft connection tests use independent parameters without persisting drafts", async t => {
  const f = await fixture(t, { realServices: true });
  f.serviceConfig.initializeServiceConfig();
  const profile = addProfile(f);
  const captured = f.registry.getById(profile.id);
  f.serviceConfig.saveLlmProfile({ ...profile, model: "edited-model", apiKey: "edited-key" });
  const calls = [];
  f.host.Zotero.HTTP.request = async (_method, url, options) => {
    calls.push({ url, body: JSON.parse(options.body), headers: options.headers });
    return { response: { choices: [{ message: { content: "translated" } }] } };
  };
  const request = { raw: "source", langfrom: "auto", langto: "ja" };
  await captured.translate(request, []);
  await f.registry.getById("llm").translate(request, []);
  await f.registry.getById(profile.id).translate(request, []);
  const before = f.prefs["services.config"];
  assert.equal((await f.probeConnection({ ...profile, model: "draft-model", apiKey: "draft-key" })).ok, true);
  assert.equal(f.prefs["services.config"], before);
  assert.deepEqual(calls.map(call => call.body.model), ["second-model", "test-model", "edited-model", "draft-model"]);
  assert.deepEqual(calls.map(call => call.headers.Authorization), ["Bearer second-key", "Bearer test-key", "Bearer edited-key", "Bearer draft-key"]);
  assert.deepEqual(calls.map(call => call.url), [profile.endpoint, f.prefs["llm.endpoint"], profile.endpoint, profile.endpoint]);
});

test("real task pipeline isolates profiles' history reuse and context, including after renaming", async t => {
  const f = await fixture(t, { realServices: true, prefs: { "llm.stream": false } });
  f.serviceConfig.initializeServiceConfig();
  const profile = addProfile(f);
  const calls = [];
  f.host.Zotero.HTTP.request = async (_method, _url, options) => {
    const body = JSON.parse(options.body); calls.push(body);
    return { response: { choices: [{ message: { content: `${body.model} translation` } }] } };
  };
  const original = f.tasks.createTask("same paragraph", 10, "llm");
  const second = () => f.tasks.createTask("same paragraph", 10, profile.id);
  await f.tasks.runTranslationTask(original);
  await f.tasks.runTranslationTask(second());
  f.prefs.reuseTranslation = true;
  f.serviceConfig.saveLlmProfile({ ...profile, name: "Renamed model" });
  await f.tasks.runTranslationTask(second());
  assert.equal(calls.length, 2);
  assert.equal(f.store.findBySource("same paragraph", 10, "llm", "zh-CN").translatedText, "test-model translation");
  assert.equal(f.store.findBySource("same paragraph", 10, profile.id, "zh-CN").translatedText, "second-model translation");
  f.prefs.contextEnable = true;
  await f.tasks.runTranslationTask(f.tasks.createTask("next paragraph", 10, profile.id));
  assert.equal(calls[2].messages.filter(message => message.role === "assistant").length, 1);
  assert.equal(calls[2].messages.find(message => message.role === "assistant").content, "second-model translation");
});

test("deleting a profile retains translated records, tags and its last display name", async t => {
  const f = await fixture(t, { realServices: true });
  f.serviceConfig.initializeServiceConfig();
  const profile = addProfile(f);
  const record = f.store.add("source", "saved", profile.id, "zh-CN", 10);
  f.store.addTag(record.id, "Important");
  f.serviceConfig.selectService(profile.id);
  f.serviceConfig.deleteLlmProfile(profile.id);
  assert.equal(f.registry.getById(profile.id), undefined);
  assert.equal(f.registry.getDisplayName(profile.id), profile.name);
  assert.equal(f.prefs.translateSource, "llm");
  assert.deepEqual(Array.from(f.store.getById(record.id).tags), ["Important"]);
  assert.throws(() => f.serviceConfig.saveLlmProfile(profile), /status-unknown-service/);
  f.serviceConfig.deleteLlmProfile("llm");
  assert.equal(f.prefs.translateSource, "google");
  assert.equal(f.registry.getById("llm"), undefined);
  await f.store.flush();
  const reopened = await fixture(t, { realServices: true, prefs: { ...f.prefs }, text: f.disk.text });
  await reopened.store.ensureLoaded();
  assert.equal(reopened.registry.getDisplayName(profile.id), profile.name);
  assert.deepEqual(Array.from(reopened.store.getById(record.id).tags), ["Important"]);
});

test("a deleted service's old task can be rerun using the current fallback service", async t => {
  const f = await fixture(t, { realServices: true, prefs: { "llm.stream": false } });
  f.serviceConfig.initializeServiceConfig();
  const profile = addProfile(f);
  f.serviceConfig.selectService(profile.id);
  const old = f.tasks.createTask("source", 10, profile.id);
  f.serviceConfig.deleteLlmProfile(profile.id);
  let calls = 0;
  f.host.Zotero.HTTP.request = async () => {
    calls++; return { response: { choices: [{ message: { content: "fallback translation" } }] } };
  };
  const rerun = f.actions.rerunWith(old, {});
  assert.equal(rerun.service, "llm");
  await f.tasks.runTranslationTask(rerun);
  assert.equal(rerun.result, "fallback translation");
  assert.equal(calls, 1);
});

test("the next rerun uses the selected frontend service after hiding the old default", async t => {
  const f = await fixture(t, { realServices: true }); f.serviceConfig.initializeServiceConfig();
  const profile = addProfile(f);
  const old = f.tasks.createTask("source", 10, "llm");
  f.serviceConfig.setServiceVisible("llm", false);
  assert.equal(f.host.addon.data.translate.queue.length, 1, "visibility changes do not rerun automatically");
  f.host.Zotero.HTTP.request = async () => ({ response: { choices: [{ message: { content: "selected service" } }] } });
  const rerun = f.actions.rerunWith(old, {});
  assert.equal(rerun.service, profile.id);
  await f.tasks.runTranslationTask(rerun);
  assert.equal(rerun.result, "selected service");
});

function mountSettings(f) {
  const dom = makeDocument();
  const { doc, win } = dom;
  const root = doc.createElement("div"); root.id = "docboxtrans-settings"; doc.body.appendChild(root);
  const make = (id, tag = "div") => { const element = doc.createElement(tag); element.id = `docboxtrans-${id}`; root.appendChild(element); return element; };
  for (const tab of ["general", "services", "reading", "about"]) { make(`tab-${tab}`, "button"); make(`panel-${tab}`); }
  for (const id of ["service-add", "service-list", "llm-editor", "service-message", "builtin-hint",
    "builtin-google", "builtin-bing", "builtin-tencent", "builtin-youdao", "builtin-cnki"]) make(id);
  const nav = doc.createElement("richlistbox"); nav.id = "prefs-navigation";
  nav.value = f.servicePreferences.preferencesPaneId; doc.body.appendChild(nav);
  f.servicePreferences.registerServicePreferences(win);
  const get = id => root.querySelector(`#docboxtrans-${id}`);
  const fill = (key, value) => { const input = get(`profile-${key}`); input.value = value; input.dispatch("input"); };
  const click = key => findButton(root, key).dispatch("click");
  return { ...dom, root, get, fill, click, nav };
}

function promptChoices(f, choices) {
  Object.assign(f.host.Services.prompt, { BUTTON_TITLE_IS_STRING: 127, BUTTON_POS_0: 1,
    BUTTON_POS_1: 256, BUTTON_POS_2: 65536, BUTTON_POS_2_DEFAULT: 33554432,
    confirmEx: () => { assert.ok(choices.length, "unexpected unsaved prompt"); return choices.shift(); } });
}

test("settings keep drafts private, save/cancel explicitly, and guard tabs, external navigation and window close", async t => {
  const f = await fixture(t, { realServices: true }); f.serviceConfig.initializeServiceConfig();
  const ui = mountSettings(f), choices = []; promptChoices(f, choices);
  ui.get("tab-services").dispatch("click");
  ui.fill("name", "Unsaved name");
  assert.notEqual(f.registry.getDisplayName("llm"), "Unsaved name");
  choices.push(2); ui.get("tab-reading").dispatch("click");
  assert.equal(ui.get("panel-services").hidden, false);
  let prevented = false;
  choices.push(2); ui.win.dispatch("DOMWindowClose", { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  const veto = { data: false, QueryInterface() { return this; } };
  choices.push(2);
  for (const observer of f.appObservers.get("quit-application-requested")) observer.observe(veto);
  assert.equal(veto.data, true, "keep editing vetoes application quit without a generic browser prompt");
  ui.nav.value = "another-pane"; choices.push(2); ui.nav.dispatch("select");
  assert.equal(ui.nav.value, f.servicePreferences.preferencesPaneId);
  choices.push(0); ui.get("tab-reading").dispatch("click");
  assert.equal(f.registry.getDisplayName("llm"), "Unsaved name");
  assert.equal(ui.get("panel-reading").hidden, false);
  ui.get("tab-services").dispatch("click");
  ui.fill("name", "Discard me"); ui.click("services-cancel");
  assert.equal(ui.get("profile-name").value, "Unsaved name");
  ui.fill("name", ""); choices.push(0); ui.get("tab-about").dispatch("click");
  assert.equal(ui.get("panel-services").hidden, false, "validation failure keeps the editor open");
  assert.match(ui.get("service-message").textContent, /services-name-required/);
  choices.push(1); ui.get("tab-about").dispatch("click");
  assert.equal(ui.get("panel-about").hidden, false);
  ui.get("tab-services").dispatch("click"); ui.get("service-add").dispatch("click");
  ui.fill("name", "New model"); ui.fill("apiKey", "new-key"); ui.click("services-save");
  assert.equal(f.serviceConfig.readServiceConfig().profiles.length, 2);
  assert.equal(f.registry.getAll()[1].id, f.serviceConfig.readServiceConfig().profiles[1].id);
  assert.equal(choices.length, 0);
});

test("connection testing uses the current unsaved form and does not replace later edits with a stale result", async t => {
  const f = await fixture(t, { realServices: true }); f.serviceConfig.initializeServiceConfig();
  const ui = mountSettings(f); const gate = deferred(); let requested;
  f.host.Zotero.HTTP.request = async (_method, _url, options) => {
    requested = JSON.parse(options.body); return gate.promise;
  };
  ui.fill("model", "draft-only");
  const before = f.prefs["services.config"];
  ui.click("services-test");
  assert.equal(requested.model, "draft-only");
  ui.fill("model", "newer draft");
  gate.resolve({ response: { choices: [{ message: { content: "translation" } }] } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.prefs["services.config"], before);
  assert.equal(ui.get("profile-model").value, "newer draft");
  assert.equal(ui.root.textContent.includes("test-ok"), false);
});

test("sidebar plus opens service settings and multiple windows share visibility without overwriting a dirty model draft", async t => {
  const f = await fixture(t, { realServices: true }); f.serviceConfig.initializeServiceConfig();
  const a = mountSettings(f), b = mountSettings(f);
  const paneRoot = a.doc.createElement("div"); a.doc.body.appendChild(paneRoot);
  let openedPane;
  f.host.Zotero.Utilities.Internal = { openPreferences: id => { openedPane = id; } };
  const manager = f.serviceVisibility.buildServiceManagerButton(a.doc);
  paneRoot.appendChild(manager);
  assert.equal(manager.textContent, "+");
  assert.equal(manager.getAttribute("aria-label"), "services-manage");
  manager.dispatch("click");
  assert.equal(openedPane, f.servicePreferences.preferencesPaneId);
  assert.equal(a.get("panel-services").hidden, false);
  assert.equal(paneRoot.querySelector("details"), null);
  assert.equal(f.host.addon.data.translate.queue.length, 0);
  a.fill("name", "Private draft");
  const llm = a.get("service-list").querySelectorAll("input")[0];
  llm.checked = false; llm.dispatch("change");
  assert.equal(a.get("service-list").querySelectorAll("input")[0].checked, false);
  assert.equal(b.get("service-list").querySelectorAll("input")[0].checked, false);
  assert.equal(a.get("profile-name").value, "Private draft");
  assert.equal(f.prefs.translateSource, "google");
  const bing = b.get("service-list").querySelectorAll("input")[2];
  bing.focus();
  bing.checked = false; bing.dispatch("change");
  assert.equal(b.doc.activeElement, b.get("service-list").querySelectorAll("input")[2]);
  assert.equal(a.get("service-list").querySelectorAll("input")[2].checked, false);
  assert.equal(f.host.addon.data.translate.queue.length, 0);
  a.win.dispatch("unload");
  assert.equal(a.win.listeners.get("DOMWindowClose").size, 0);
  assert.equal(f.appObservers.get("quit-application-requested").size, 1, "only the other settings window remains subscribed");
});

test("keyboard tabs, API-key visibility and delete confirmation work without implicitly saving drafts", async t => {
  const f = await fixture(t, { realServices: true }); f.serviceConfig.initializeServiceConfig();
  const ui = mountSettings(f);
  ui.get("tab-general").dispatch("keydown", { key: "End" });
  assert.equal(ui.get("panel-about").hidden, false);
  assert.equal(ui.doc.activeElement, ui.get("tab-about"));
  ui.get("tab-about").dispatch("keydown", { key: "Home" });
  assert.equal(ui.get("panel-general").hidden, false);
  const checkbox = ui.get("llm-editor").querySelectorAll("input")[4];
  assert.equal(ui.get("profile-apiKey").type, "password");
  checkbox.checked = true; checkbox.dispatch("change");
  assert.equal(ui.get("profile-apiKey").type, "text");
  ui.click("services-cancel");
  assert.equal(ui.get("profile-apiKey").type, "password");
  ui.fill("name", "Never saved");
  f.host.Services.prompt.confirm = () => false;
  ui.click("services-delete");
  assert.ok(f.registry.getById("llm"));
  f.host.Services.prompt.confirm = () => true;
  ui.click("services-delete");
  assert.equal(f.registry.getById("llm"), undefined);
  assert.equal(f.registry.getDisplayName("llm"), "service-llm");
});

test("configuration events refresh all open reader service rows without changing tasks, text or combine contents", async t => {
  const f = await fixture(t, { realServices: true }); await f.hooks.onStartup();
  const profile = addProfile(f);
  const records = [];
  for (const id of ["a", "b"]) {
    const dom = makeDocument(id), reader = makeReader(id, 10, dom.win), state = f.readerState.getReaderState(reader);
    f.host.Zotero.Reader._readers.push(reader);
    state.selectedText = `selection-${id}`; state.prefix = `test-${id}`;
    const popup = dom.doc.createElement("div"), row = dom.doc.createElement("div");
    row.id = `test-${id}-services`; popup.appendChild(row); dom.doc.body.appendChild(popup);
    state.currentPopup = popup;
    const task = f.tasks.createTask(state.selectedText, 10, "llm", undefined, false, id);
    task.result = `result-${id}`; records.push({ state, row, task });
  }
  f.host.ztoolkit.UI.createElement = (_doc, _tag, definition) => {
    const element = _doc.createElement("div"); element.definition = definition; return element;
  };
  f.combine.add(10, "kept fragment");
  f.serviceConfig.saveLlmProfile({ ...profile, name: "New display name" });
  f.serviceConfig.setServiceVisible("google", false);
  for (const { state, row, task } of records) {
    const buttons = row.children[0].definition.children;
    assert.equal(buttons.some(button => button.attributes["data-service"] === "google"), false);
    assert.ok(buttons.some(button => button.properties.textContent === "New display name"));
    assert.equal(state.selectedText, task.raw);
    assert.equal(f.tasks.getLastTask(10, state.readerId), task);
    assert.match(task.result, /result-/);
  }
  assert.equal(f.combine.list(10).length, 1);
  assert.equal(f.host.addon.data.translate.queue.length, 2);
  records[0].state.currentPopup.querySelector = () => { throw new Error("closed reader"); };
  f.serviceConfig.setServiceVisible("bing", false);
  assert.ok(records[1].row.children[0].definition.children.every(button => button.attributes["data-service"] !== "bing"));
});

test("locale resources parse without Fluent errors and new messages exist in both languages", () => {
  const parser = new FluentParser();
  const locale = language => path.resolve(__dirname, `../addon/locale/${language}`);
  for (const name of ["addon.ftl", "preferences.ftl"]) {
    const resources = ["en-US", "zh-CN"].map(language => parser.parse(fs.readFileSync(path.join(locale(language), name), "utf8")));
    for (const resource of resources) assert.equal(resource.body.some(node => node.type === "Junk"), false);
    const keys = resources.map(resource => resource.body.filter(node => node.type === "Message").map(node => node.id.name).sort());
    assert.deepEqual(keys[0], keys[1]);
  }
  for (const name of ["addon.ftl", "preferences.ftl"]) {
    assert.match(fs.readFileSync(path.join(locale("zh-CN"), name), "utf8"), /service-tencent = 腾讯\r?\n/);
  }
});
