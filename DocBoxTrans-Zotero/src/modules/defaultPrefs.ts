import { getPref, setPref } from "../utils/prefs";
import { services } from "./services";
import { initializeServiceConfig } from "./serviceConfig";

/** 首次启动时修正无效/缺失的偏好（服务 id 必须存在，目标语言不能为空）。 */
export function setDefaultPrefs() {
  initializeServiceConfig();
  const ids = services.getVisible().map((s) => s.id);
  const current = String(getPref("translateSource") || "");
  if (!ids.includes(current)) {
    setPref("translateSource", ids[0]);
  }
  if (!String(getPref("targetLanguage") || "").trim()) {
    setPref("targetLanguage", Zotero.locale === "zh-CN" ? "zh-CN" : "en");
  }
}
