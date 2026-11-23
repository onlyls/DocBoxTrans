import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { pillCss } from "../utils/uiStyle";
import { openServicePreferences } from "./servicePreferences";

/** Compact entry to service settings; opening it never starts translation. */
export function buildServiceManagerButton(doc: Document): HTMLButtonElement {
  const button = doc.createElementNS("http://www.w3.org/1999/xhtml", "button") as HTMLButtonElement;
  button.type = "button";
  button.className = `${config.addonRef}-service-manager`;
  button.textContent = "+";
  button.title = getString("services-manage");
  button.setAttribute("aria-label", getString("services-manage"));
  button.style.cssText = pillCss("ghost", "0.75em") + ";flex:none;";
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    openServicePreferences();
  });
  return button;
}
