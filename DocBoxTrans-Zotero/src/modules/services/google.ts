import { TranslateError } from "./base";
import type { TranslateService } from "./base";
import { mapTargetLang } from "../../utils/config";
import { getPref } from "../../utils/prefs";
import { HttpStatusError, httpText, truncate } from "../../utils/http";

/**
 * 谷歌翻译引擎（免费接口）。移植自 DocBoxTrans 的 GoogleEngine：
 * 多端点轮换 + 429 冷却 + 指数退避重试。
 */
const DefaultApi = "https://translate.googleapis.com/translate_a/single";
const BuiltinFallbacks = ["https://clients5.google.com/translate_a/t"];

/** endpoint -> 冷却截止时间（ms） */
const cooldown: Record<string, number> = {};

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function endpoints(): string[] {
  const list: string[] = [];
  const pref = String(getPref("google.endpoint") || "").trim();
  list.push(pref || DefaultApi);
  for (const f of BuiltinFallbacks) {
    if (!list.includes(f)) list.push(f);
  }
  return list;
}

function orderByHealth(list: string[]): string[] {
  const now = Date.now();
  const ready: string[] = [];
  const cooling: string[] = [];
  for (const e of list) {
    if (cooldown[e] && cooldown[e] > now) cooling.push(e);
    else ready.push(e);
  }
  return ready.concat(cooling);
}

/** 兼容两种免费端点：/translate_a/single（client=gtx）与 /translate_a/t（client=dict-chrome-ex）。 */
function buildUrl(base: string, targetLang: string, text: string): string {
  const narrow = /\/translate_a\/t/i.test(base);
  const sep = base.includes("?") ? "&" : "?";
  const client = narrow ? "client=dict-chrome-ex" : "client=gtx";
  const mid = narrow ? "" : "&dt=t";
  return `${base}${sep}${client}&sl=auto&tl=${encodeURIComponent(
    targetLang,
  )}${mid}&q=${encodeURIComponent(text)}`;
}

/** 自适应解析两种免费接口的返回：[["译文","原文",...],...] 或 [["译文","en"]]。 */
function parseGoogle(json: string): string | null {
  try {
    const root = JSON.parse(json);
    if (!Array.isArray(root) || root.length === 0) return null;
    const first = root[0];
    if (!Array.isArray(first) || first.length === 0) return null;
    if (Array.isArray(first[0])) {
      let out = "";
      for (const seg of first) {
        if (Array.isArray(seg) && seg.length > 0 && seg[0] != null) {
          out += String(seg[0]);
        }
      }
      return out.trim();
    }
    if (typeof first[0] === "string") return first[0].trim();
    return null;
  } catch {
    return null;
  }
}

const translate: TranslateService["translate"] = async function (data) {
  const targetLang = String(getPref("targetLanguage") || "zh-CN");
  const eps = orderByHealth(endpoints());
  const attempts = Math.min(4, Math.max(2, eps.length + 1));
  let lastErr = "未知错误";

  for (let i = 0; i < attempts; i++) {
    const ep = eps[i % eps.length];
    try {
      const txt = await httpText("GET", buildUrl(ep, targetLang, data.raw), {
        headers: { Accept: "application/json" },
      });
      const parsed = parseGoogle(txt);
      if (parsed != null) {
        data.result = parsed;
        return;
      }
      lastErr = "响应解析失败";
    } catch (e) {
      if (e instanceof HttpStatusError) {
        lastErr = "HTTP " + e.status;
        if (e.status === 429) cooldown[ep] = Date.now() + 120_000;
      } else {
        lastErr = (e as Error)?.message ?? String(e);
      }
    }
    if (i < attempts - 1) await delay(1000 * (1 << i));
  }

  throw new TranslateError(
    "[谷歌翻译失败] " +
      lastErr +
      "\n谷歌免费接口通常需要代理，可在「设置 → 免费引擎 → 谷歌代理」填写代理地址（留空则沿用 Zotero 的代理设置），且该接口易被限流（429）。" +
      "\n" +
      truncate(String(lastErr), 200),
  );
};

export const GoogleService: TranslateService = {
  id: "google",
  type: "sentence",
  supportsContext: () => false,
  translate,
};
