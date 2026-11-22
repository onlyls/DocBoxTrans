import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { services } from "./services";
import { setServiceVisible, visibleServiceIds } from "./serviceConfig";
import { openServicePreferences } from "./servicePreferences";

/** Inline checklist: opening it or changing visibility never starts translation. */
export function buildServiceVisibility(doc: Document, root: HTMLElement): HTMLElement {
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K) =>
    doc.createElementNS("http://www.w3.org/1999/xhtml", tag) as HTMLElementTagNameMap[K];
  const details = make("details");
  details.className = `${config.addonRef}-service-manager`;
  details.style.cssText = "font-size:.9em;margin:4px 0;";
  details.open = root.dataset.serviceManagerOpen === "true";
  details.addEventListener("toggle", () => {
    if (details.isConnected) root.dataset.serviceManagerOpen = String(details.open);
  });
  const summary = make("summary");
  summary.textContent = getString("services-manage");
  summary.style.cssText = "cursor:pointer;padding:3px 0;";
  details.appendChild(summary);
  const list = make("div");
  list.style.cssText = "display:flex;flex-direction:column;gap:5px;padding:6px;border:1px solid var(--fill-quaternary, #8885);border-radius:5px;";
  const message = make("div");
  message.setAttribute("role", "status");
  const visible = visibleServiceIds();
  for (const service of services.getAll()) {
    const label = make("label");
    label.style.cssText = "display:flex;align-items:center;gap:5px;overflow-wrap:anywhere;";
    const check = make("input");
    check.type = "checkbox";
    check.checked = visible.includes(service.id);
    check.addEventListener("change", () => {
      root.dataset.serviceManagerOpen = "true";
      try { setServiceVisible(service.id, check.checked); message.textContent = ""; }
      catch (e) { check.checked = !check.checked; message.textContent = String((e as Error).message); }
    });
    const name = make("span"); name.textContent = services.getDisplayName(service.id);
    label.appendChild(check); label.appendChild(name); list.appendChild(label);
  }
  const edit = make("button"); edit.type = "button";
  edit.textContent = getString("services-open-settings");
  edit.style.cssText = "font:inherit;color:inherit;cursor:pointer;";
  edit.addEventListener("click", () => openServicePreferences());
  list.appendChild(edit); list.appendChild(message); details.appendChild(list);
  return details;
}
