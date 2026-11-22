import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
import { services } from "./services";
import { probeConnection } from "./services/llm";
import {
  builtinServiceIds, createLlmProfile, deleteLlmProfile, readServiceConfig,
  saveLlmProfile, selectService, setServiceVisible, subscribeServiceConfig,
  visibleServiceIds, type LlmProfile,
} from "./serviceConfig";

export const preferencesPaneId = `zotero-prefpane-${config.addonRef}`;
const controllers = new Set<ServicePreferences>();
let openServicesOnLoad = false;

export function openServicePreferences(): void {
  openServicesOnLoad = true;
  Zotero.Utilities.Internal.openPreferences(preferencesPaneId);
  for (const controller of controllers) {
    if (controller.root.isConnected && controller.showTab("services")) openServicesOnLoad = false;
  }
}

export function registerServicePreferences(win: Window): void {
  const root = win.document.querySelector(`#${config.addonRef}-settings`) as HTMLElement | null;
  if (!root || [...controllers].some(c => c.root === root)) return;
  const controller = new ServicePreferences(win, root);
  controllers.add(controller);
  if (openServicesOnLoad) {
    controller.showTab("services");
    openServicesOnLoad = false;
  }
}

export function disposeServicePreferences(): void {
  for (const controller of [...controllers]) controller.dispose();
  openServicesOnLoad = false;
}

/** Window-local draft; only explicit Save writes model parameters. */
export class ServicePreferences {
  private selected = "";
  private profile?: LlmProfile;
  private original = "";
  private tab = "general";
  private unsubscribe: () => void;
  private cleanup: Array<() => void> = [];
  private disposed = false;

  constructor(private win: Window, public readonly root: HTMLElement) {
    const tabs = ["general", "services", "reading", "about"];
    tabs.forEach((name, index) => {
      const button = this.element(`tab-${name}`);
      this.listen(button, "click", () => this.showTab(name));
      this.listen(button, "keydown", (event: Event) => {
        const ev = event as KeyboardEvent;
        let next: number;
        if (ev.key === "ArrowRight") next = (index + 1) % tabs.length;
        else if (ev.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
        else if (ev.key === "Home") next = 0;
        else if (ev.key === "End") next = tabs.length - 1;
        else return;
        ev.preventDefault();
        if (this.showTab(tabs[next])) this.element(`tab-${tabs[next]}`).focus();
      });
    });
    this.listen(this.element("service-add"), "click", () => {
      if (!this.allowLeave()) return;
      this.loadProfile(createLlmProfile());
    });
    // Zotero keeps loaded panes alive. Capture navigation before its select handler,
    // including keyboard selection and programmatic navigation, not just clicks.
    const nav = win.document.querySelector("#prefs-navigation") as XUL.MenuList | null;
    if (nav) this.listen(nav, "select", (event: Event) => {
      if (nav.value === preferencesPaneId || this.allowLeave()) return;
      event.stopImmediatePropagation();
      nav.value = preferencesPaneId;
    }, true);
    const close = (event: Event) => {
      if (this.allowLeave()) return;
      event.preventDefault();
    };
    // beforeunload cancellation opens Gecko's second, generic confirmation.
    // Privileged close events can veto the window close directly instead.
    this.listen(win, "DOMWindowClose", close);
    this.listen(win, "close", close);
    const quitObserver = { observe: (subject: nsISupports) => {
      const veto = subject.QueryInterface!(Ci.nsISupportsPRBool);
      if (!veto.data && !this.allowLeave()) veto.data = true;
    } };
    Services.obs.addObserver(quitObserver, "quit-application-requested");
    this.cleanup.push(() => Services.obs.removeObserver(quitObserver, "quit-application-requested"));
    this.listen(win, "unload", () => this.dispose());
    this.unsubscribe = subscribeServiceConfig(() => {
      if (!root.isConnected) { this.dispose(); return; }
      this.refreshList();
      // Preserve an active draft when visibility or another window changes.
      if (!this.dirty && this.profile) this.select(this.selected, false);
    });
    try {
      this.refreshList();
      this.select(String(getPref("translateSource") || services.getAll()[0].id), false);
    } catch (e) { this.message(String((e as Error).message)); }
  }

  private element(id: string): HTMLElement {
    return this.root.querySelector(`#${config.addonRef}-${id}`) as HTMLElement;
  }

  private make<K extends keyof HTMLElementTagNameMap>(tag: K, text = ""): HTMLElementTagNameMap[K] {
    const element = this.win.document.createElementNS("http://www.w3.org/1999/xhtml", tag) as HTMLElementTagNameMap[K];
    if (text) element.textContent = text;
    return element;
  }

  private listen(target: EventTarget, type: string, listener: EventListener, capture = false) {
    target.addEventListener(type, listener, capture);
    this.cleanup.push(() => target.removeEventListener(type, listener, capture));
  }

  get dirty(): boolean {
    return Boolean(this.profile && JSON.stringify(this.profile) !== this.original);
  }

  private message(text: string) {
    this.element("service-message").textContent = text;
  }

  private attempt(action: () => void): boolean {
    try { action(); this.message(""); return true; }
    catch (e) { this.message(String((e as Error).message)); return false; }
  }

  private save(): boolean {
    if (!this.profile) return true;
    return this.attempt(() => {
      const savedId = this.profile!.id;
      saveLlmProfile({ ...this.profile! });
      this.select(savedId, false);
    });
  }

  /** Return false to keep editing; modal choices work in privileged Zotero windows. */
  allowLeave(): boolean {
    if (!this.dirty) return true;
    const prompt = Services.prompt;
    const flags = prompt.BUTTON_TITLE_IS_STRING! *
      (prompt.BUTTON_POS_0! + prompt.BUTTON_POS_1! + prompt.BUTTON_POS_2!) + prompt.BUTTON_POS_2_DEFAULT!;
    const choice = prompt.confirmEx(this.win as any, getString("pref-title"), getString("services-unsaved"),
      flags, getString("services-save"), getString("services-discard"), getString("services-keep-editing"), "", { value: false });
    if (choice === 0) return this.save();
    if (choice !== 1) return false;
    this.select(this.selected, false);
    return true;
  }

  showTab(name: string): boolean {
    if (name !== this.tab && !this.allowLeave()) return false;
    for (const tab of ["general", "services", "reading", "about"]) {
      this.element(`panel-${tab}`).hidden = tab !== name;
      const button = this.element(`tab-${tab}`);
      button.setAttribute("aria-selected", String(tab === name));
      button.tabIndex = tab === name ? 0 : -1;
    }
    this.tab = name;
    return true;
  }

  private refreshList() {
    const list = this.element("service-list");
    const focused = this.win.document.activeElement as HTMLElement | null;
    const restoreFocus = focused?.parentElement?.parentElement === list
      ? focused.dataset.serviceControl : undefined;
    list.textContent = "";
    const visible = visibleServiceIds();
    const current = String(getPref("translateSource") || "");
    for (const service of services.getAll()) {
      const name = services.getDisplayName(service.id);
      const row = this.make("div");
      row.className = "dbt-service-row";
      const check = this.make("input");
      check.dataset.serviceControl = `${service.id}:visible`;
      check.type = "checkbox";
      check.checked = visible.includes(service.id);
      check.setAttribute("aria-label", getString("services-show", { args: { name } }));
      check.addEventListener("change", () => {
        if (!this.attempt(() => setServiceVisible(service.id, check.checked))) check.checked = !check.checked;
      });
      const edit = this.make("button", name);
      edit.dataset.serviceControl = `${service.id}:edit`;
      edit.type = "button";
      edit.className = `dbt-service-edit${this.selected === service.id ? " dbt-active" : ""}`;
      edit.setAttribute("aria-pressed", String(this.selected === service.id));
      edit.addEventListener("click", () => this.select(service.id));
      const defaultButton = this.make("button", current === service.id ? "★" : "☆");
      defaultButton.dataset.serviceControl = `${service.id}:default`;
      defaultButton.type = "button";
      defaultButton.title = getString(current === service.id ? "services-default" : "services-set-default");
      defaultButton.setAttribute("aria-label", `${defaultButton.title}: ${name}`);
      defaultButton.disabled = !visible.includes(service.id);
      defaultButton.addEventListener("click", () => this.attempt(() => selectService(service.id)));
      row.appendChild(check); row.appendChild(edit); row.appendChild(defaultButton);
      list.appendChild(row);
      if (restoreFocus) {
        for (const control of [check, edit, defaultButton]) {
          if (control.dataset.serviceControl === restoreFocus) control.focus();
        }
      }
    }
  }

  private select(id: string, guard = true) {
    if (guard && !this.allowLeave()) return;
    const data = readServiceConfig();
    const profile = data.profiles.find(p => p.id === id);
    if (profile) { this.loadProfile(profile); return; }
    this.profile = undefined;
    this.original = "";
    this.selected = builtinServiceIds.includes(id) ? id : services.getAll()[0].id;
    if (this.selected !== id) { this.select(this.selected, false); return; }
    this.element("llm-editor").textContent = "";
    for (const builtin of builtinServiceIds) this.element(`builtin-${builtin}`).hidden = builtin !== id;
    this.element("builtin-hint").hidden = id === "youdao";
    this.message("");
    this.refreshList();
  }

  private loadProfile(profile: LlmProfile) {
    this.profile = { ...profile };
    this.selected = profile.id;
    // An unsaved newly added profile must also prompt before leaving.
    this.original = readServiceConfig().profiles.some(p => p.id === profile.id) ? JSON.stringify(profile) : "";
    for (const builtin of builtinServiceIds) this.element(`builtin-${builtin}`).hidden = true;
    this.element("builtin-hint").hidden = true;
    this.message("");
    this.renderForm();
    this.refreshList();
  }

  private renderForm() {
    const profile = this.profile!;
    const host = this.element("llm-editor");
    host.textContent = "";
    const form = this.make("div");
    form.className = "dbt-model-form";
    form.appendChild(this.make("h3", getString("services-model-heading")));
    const fields = ["name", "endpoint", "model", "apiKey", "temperature", "systemPrompt"] as const;
    for (const key of fields) {
      const label = this.make("label");
      label.className = "dbt-field";
      label.appendChild(this.make("span", getString(`services-field-${key}`)));
      const input = key === "systemPrompt" ? this.make("textarea") : this.make("input");
      input.id = `${config.addonRef}-profile-${key}`;
      input.value = profile[key];
      if (key !== "systemPrompt") {
        (input as HTMLInputElement).type = key === "apiKey" ? "password" : "text";
        (input as HTMLInputElement).autocomplete = "off";
        input.spellcheck = false;
      }
      input.addEventListener("input", () => {
        profile[key] = input.value;
        status.textContent = getString("services-draft");
        testResult.textContent = "";
      });
      label.appendChild(input); form.appendChild(label);
      if (key === "apiKey") {
        const show = this.make("label");
        const toggle = this.make("input"); toggle.type = "checkbox";
        toggle.addEventListener("change", () => { (input as HTMLInputElement).type = toggle.checked ? "text" : "password"; });
        show.appendChild(toggle); show.appendChild(this.make("span", getString("services-show-secret")));
        form.appendChild(show);
      }
    }
    const streamLabel = this.make("label");
    const stream = this.make("input"); stream.type = "checkbox"; stream.checked = profile.stream;
    stream.addEventListener("change", () => {
      profile.stream = stream.checked;
      status.textContent = getString("services-draft");
      testResult.textContent = "";
    });
    streamLabel.appendChild(stream); streamLabel.appendChild(this.make("span", getString("services-stream")));
    form.appendChild(streamLabel);
    form.appendChild(this.make("p", getString("services-prompt-hint")));
    const actions = this.make("div"); actions.className = "dbt-actions";
    const button = (key: string, action: () => void) => {
      const el = this.make("button", getString(key)); el.type = "button";
      el.addEventListener("click", action); actions.appendChild(el); return el;
    };
    button("services-save", () => this.save());
    button("services-cancel", () => this.select(this.selected, false));
    const test = button("services-test", async () => {
      test.disabled = true;
      const snapshot = JSON.stringify(profile);
      testResult.textContent = getString("test-running");
      try {
        const result = await probeConnection({ ...profile });
        if (!this.disposed && this.profile === profile && JSON.stringify(profile) === snapshot) {
          testResult.textContent = result.message;
        }
      } finally { test.disabled = false; }
    });
    const saved = readServiceConfig().profiles.some(p => p.id === profile.id);
    if (saved) button("services-delete", () => {
      if (!Services.prompt.confirm(this.win as any, getString("pref-title"), getString("services-delete-confirm", { args: { name: profile.name } }))) return;
      this.attempt(() => {
        deleteLlmProfile(profile.id);
        this.select(String(getPref("translateSource")), false);
      });
    });
    form.appendChild(actions);
    const status = this.make("div", saved ? "" : getString("services-draft"));
    status.className = "dbt-form-status";
    status.setAttribute("role", "status");
    const testResult = this.make("div"); testResult.className = "dbt-form-status";
    testResult.setAttribute("role", "status");
    form.appendChild(status); form.appendChild(testResult);
    host.appendChild(form);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.cleanup.forEach(cleanup => cleanup());
    this.profile = undefined;
    this.element("llm-editor").textContent = "";
    controllers.delete(this);
  }
}
