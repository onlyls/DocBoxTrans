// 最小宿主 DOM：供离线交互测试使用，不模拟真实浏览器的像素布局。
class Element {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase(); this.ownerDocument = doc;
    this.children = []; this.parentElement = null; this.dataset = {};
    this.style = {}; this.className = ""; this.value = ""; this.hidden = false;
    this.attributes = {}; this.listeners = new Map(); this._text = "";
    this.scrollTop = 0; this.clientHeight = 800; this.clientWidth = 500;
    this.rect = { top: 0, height: 200 };
  }
  get ownerGlobal() { return this.ownerDocument.defaultView; }
  get isConnected() { return this === this.ownerDocument.documentElement || Boolean(this.parentElement?.isConnected); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(""); }
  set textContent(value) {
    this._text = String(value);
    for (const child of this.children) child.parentElement = null;
    this.children = []; this.scrollTop = 0;
  }
  appendChild(child) { child.remove(); this.children.push(child); child.parentElement = this; return child; }
  prepend(child) { child.remove(); this.children.unshift(child); child.parentElement = this; }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
    this.parentElement = null;
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }
  removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler); }
  dispatch(type, fields = {}) {
    const event = { target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...fields };
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler(event);
  }
  matches(selector) {
    if (selector.startsWith(".")) return this.className.split(/\s+/).includes(selector.slice(1));
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node;
    return null;
  }
  querySelectorAll(selector) {
    const parts = selector.split(/\s+/), result = [];
    const matches = node => {
      if (!node.matches(parts.at(-1))) return false;
      let ancestor = node.parentElement;
      for (let i = parts.length - 2; i >= 0; i--) {
        while (ancestor && !ancestor.matches(parts[i])) ancestor = ancestor.parentElement;
        if (!ancestor) return false;
        ancestor = ancestor.parentElement;
      }
      return true;
    };
    const visit = node => { for (const child of node.children) { if (matches(child)) result.push(child); visit(child); } };
    visit(this); return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  getBoundingClientRect() { return this.rect; }
  focus() { this.ownerDocument.activeElement = this; }
}

function makeDocument(selectedID = "reader-a") {
  let serial = 0;
  const frames = new Map(), timers = new Map(), observers = [];
  const win = new Element("window", {});
  win.top = win; win.innerHeight = 900;
  win.Zotero_Tabs = { selectedID };
  win.requestAnimationFrame = callback => { const id = ++serial; frames.set(id, callback); return id; };
  win.cancelAnimationFrame = id => frames.delete(id);
  win.setTimeout = callback => { const id = ++serial; timers.set(id, callback); return id; };
  win.clearTimeout = id => timers.delete(id);
  win.ResizeObserver = class {
    constructor(callback) { this.callback = callback; this.targets = new Set(); observers.push(this); }
    observe(target) { this.targets.add(target); }
    disconnect() { this.targets.clear(); }
  };
  const doc = { defaultView: win, activeElement: null,
    createElementNS: (_namespace, tag) => new Element(tag, doc),
    createElement: tag => new Element(tag, doc) };
  doc.documentElement = doc.createElement("html");
  doc.body = doc.createElement("body"); doc.documentElement.appendChild(doc.body);
  doc.querySelector = selector => doc.documentElement.querySelector(selector);
  win.document = doc;
  return { doc, win, frames, timers, observers };
}

function findButton(root, text) {
  return root.querySelectorAll("button").find(button => button.textContent === text);
}

module.exports = { makeDocument, findButton };
