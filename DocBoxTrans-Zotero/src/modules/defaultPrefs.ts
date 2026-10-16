import { getPref, setPref } from "../utils/prefs";
import { services } from "./services";

/** 首次启动时修正无效/缺失的偏好（服务 id 必须存在，目标语言不能为空）。 */
export function setDefaultPrefs() {
  const ids = services.getAll().map((s) => s.id);
  const current = String(getPref("translateSource") || "");
  if (!ids.includes(current)) {
    setPref("translateSource", "llm");
  }
  if (!String(getPref("targetLanguage") || "").trim()) {
    setPref("targetLanguage", Zotero.locale === "zh-CN" ? "zh-CN" : "en");
  }
}
