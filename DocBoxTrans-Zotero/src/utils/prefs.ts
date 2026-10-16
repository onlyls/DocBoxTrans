import { config } from "../../package.json";

export { getPref, setPref, clearPref, getPrefInt };

function getPref(key: string): string | number | boolean {
  return Zotero.Prefs.get(`${config.prefsPrefix}.${key}`, true) as
    | string
    | number
    | boolean;
}

function setPref(key: string, value: string | number | boolean) {
  return Zotero.Prefs.set(`${config.prefsPrefix}.${key}`, value, true);
}

function clearPref(key: string) {
  return Zotero.Prefs.clear(`${config.prefsPrefix}.${key}`, true);
}

/** 读取一个数值型偏好，非法或缺失时回退到默认值。 */
function getPrefInt(key: string, fallback: number): number {
  const raw = getPref(key);
  const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : fallback;
}
