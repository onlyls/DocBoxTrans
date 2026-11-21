const test = require("node:test");
const assert = require("node:assert/strict");
const { fixture } = require("./harness.cjs");

const record = (sourceText, extra = {}) => ({
  id: sourceText, sourceText, translatedText: `translated ${sourceText}`,
  provider: "llm", targetLanguage: "zh-CN", itemId: 10, tags: [], ...extra,
});
function add(f, rec) {
  f.context.add(rec, f.context.nextSeq(), f.context.getGeneration());
}
function captureLlm(f) {
  const bodies = [];
  f.services.set("llm", f.LlmService);
  f.host.Zotero.HTTP.request = async (_method, _url, options) => {
    bodies.push(JSON.parse(options.body));
    return { status: 200, response: { choices: [{ message: { content: "new translation" } }] } };
  };
  return bodies;
}
const sources = records => Array.from(records, r => r.sourceText);
const userMessages = body => body.messages.filter(m => m.role === "user").map(m => m.content);

test("context skips oversized pairs and continues filling the remaining budget in chronological order", async t => {
  const f = await fixture(t);
  add(f, record("older"));
  add(f, record("x".repeat(1100), { translatedText: "y".repeat(500) }));
  add(f, record("recent"));
  const snapshot = f.context.snapshot(10, "llm", "zh-CN", 4, 1500);
  assert.deepEqual(sources(snapshot), ["older", "recent"]);
  assert.deepEqual(sources(f.context.snapshot(10, "llm", "zh-CN", 1, 1500)), ["recent"]);
  assert.ok(snapshot.reduce((n, r) => n + r.sourceText.length + r.translatedText.length, 0) <= 1500);
  add(f, record("bad", { translatedText: " " }));
  assert.deepEqual(sources(f.context.snapshot(10, "llm", "zh-CN", 1, 1500)), ["recent"]);
  assert.deepEqual(sources(f.context.snapshot(10, "llm", "zh-CN", 4, 1)), []);
});

test("context isolates attachments, engines and languages while accepting case variants", async t => {
  const f = await fixture(t);
  add(f, record("valid"));
  add(f, record("other file", { itemId: 11 }));
  add(f, record("other engine", { provider: "youdao" }));
  add(f, record("other language", { targetLanguage: "en" }));
  assert.deepEqual(sources(f.context.snapshot(10, "LLM", "ZH-cn", 4, 1500)), ["valid"]);
});

test("context exclusion happens before both count and character limits", async t => {
  const f = await fixture(t);
  add(f, record("useful"));
  add(f, record("duplicate"));
  assert.deepEqual(sources(f.context.snapshot(10, "llm", "zh-CN", 1, 30,
    r => r.sourceText === "duplicate")), ["useful"]);
});

test("invalid context limits use documented defaults and fractional counts are bounded", async t => {
  const f = await fixture(t);
  for (let i = 0; i < 6; i++) add(f, record(String(i)));
  for (const limit of [0, -1, NaN, Infinity]) {
    assert.equal(f.context.snapshot(10, "llm", "zh-CN", limit, limit).length, 4);
  }
  assert.equal(f.context.snapshot(10, "llm", "zh-CN", 1.9, 1500).length, 1);
});

test("clearing context prevents an older in-flight generation from restoring it", async t => {
  const f = await fixture(t);
  const generation = f.context.getGeneration(), seq = f.context.nextSeq();
  add(f, record("before clear"));
  f.context.clear();
  f.context.add(record("late completion"), seq, generation);
  assert.equal(f.context.getCount(), 0);
  add(f, record("after clear"));
  assert.deepEqual(sources(f.context.snapshot(10, "llm", "zh-CN", 4, 1500)), ["after clear"]);
});

test("LLM retranslation excludes its old answer without crowding out earlier references", async t => {
  const f = await fixture(t, { prefs: { contextEnable: true, contextMaxItems: 1, "llm.stream": false } });
  const bodies = captureLlm(f);
  for (const text of ["first paragraph", "second paragraph", "second paragraph"]) {
    assert.equal(await f.tasks.runTranslationTask(f.tasks.createTask(text, 10)), true);
  }
  assert.deepEqual(userMessages(bodies[1]), ["first paragraph", "second paragraph"]);
  assert.deepEqual(userMessages(bodies[2]), ["first paragraph", "second paragraph"]);
  assert.equal(bodies[2].messages[2].role, "assistant");
  assert.match(bodies[2].messages[0].content, /仅用于统一术语/);
  assert.equal(await f.tasks.runTranslationTask(f.tasks.createTask("other document", 11)), true);
  assert.deepEqual(userMessages(bodies[3]), ["other document"]);
});

test("combined translation excludes included fragments before selecting references", async t => {
  const f = await fixture(t, { prefs: { contextEnable: true, contextMaxItems: 1, "llm.stream": false } });
  const bodies = captureLlm(f);
  add(f, record("earlier useful reference"));
  add(f, record("included fragment"));
  const task = f.tasks.createTask("included fragment\n\nnew fragment", 10, "llm", undefined, true);
  assert.equal(await f.tasks.runTranslationTask(task), true);
  assert.deepEqual(userMessages(bodies[0]), ["earlier useful reference", task.raw]);
});

test("history reuse warms context without a network call or rewriting the saved record", async t => {
  const f = await fixture(t, { prefs: { contextEnable: false, reuseTranslation: true, "llm.stream": false } });
  await f.store.ensureLoaded();
  const saved = f.store.add("cached paragraph", "cached translation", "llm", "zh-CN", 10);
  const bodies = captureLlm(f);
  const cached = f.tasks.createTask("cached paragraph", 10);
  assert.equal(await f.tasks.runTranslationTask(cached), true);
  assert.equal(bodies.length, 0);
  assert.equal(cached.recordId, saved.id);
  assert.equal(f.store.count(), 1);
  f.prefs.contextEnable = true;
  assert.equal(await f.tasks.runTranslationTask(f.tasks.createTask("next paragraph", 10)), true);
  assert.deepEqual(userMessages(bodies[0]), ["cached paragraph", "next paragraph"]);
  assert.equal(bodies[0].messages[2].content, "cached translation");
});

test("disabled context sends no references but successful translations seed later enhanced requests", async t => {
  const f = await fixture(t, { prefs: { contextEnable: false, "llm.stream": false } });
  const bodies = captureLlm(f);
  add(f, record("prior"));
  await f.tasks.runTranslationTask(f.tasks.createTask("ordinary translation", 10));
  assert.deepEqual(userMessages(bodies[0]), ["ordinary translation"]);
  f.prefs.contextEnable = true;
  await f.tasks.runTranslationTask(f.tasks.createTask("enhanced translation", 10));
  assert.deepEqual(userMessages(bodies[1]), ["prior", "ordinary translation", "enhanced translation"]);
});

test("Youdao auto mode carries filtered context in prompt and respects the disabled switch", async t => {
  const f = await fixture(t, { prefs: { contextEnable: true, "youdao.mode": "auto" } });
  f.services.set("youdao", f.YoudaoService);
  const calls = [];
  f.host.Zotero.HTTP.request = async (_method, url, options) => {
    calls.push({ url, params: new URLSearchParams(options.body) });
    return url.includes("llm-trans")
      ? { status: 200, responseText: 'data: {"code":0,"data":{"transFull":"有道译文"}}\n' }
      : { status: 200, response: { errorCode: "0", translation: ["普通译文"] } };
  };
  add(f, record("youdao reference", { provider: "youdao" }));
  add(f, record("current", { provider: "youdao" }));
  await f.tasks.runTranslationTask(f.tasks.createTask("current", 10, "youdao"));
  assert.match(calls[0].url, /llm-trans/);
  assert.match(calls[0].params.get("prompt"), /youdao reference/);
  assert.doesNotMatch(calls[0].params.get("prompt"), /current/);
  assert.ok(calls[0].params.get("prompt").length <= 1200);
  f.prefs.contextEnable = false;
  await f.tasks.runTranslationTask(f.tasks.createTask("ordinary", 10, "youdao"));
  assert.match(calls[1].url, /\/api$/);
  assert.equal(calls[1].params.has("prompt"), false);
});
