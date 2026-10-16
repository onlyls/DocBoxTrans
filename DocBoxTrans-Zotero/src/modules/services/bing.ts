import { TranslateError } from "./base";
import type { TranslateService } from "./base";
import { mapTargetLang, splitChunks } from "../../utils/config";
import { getPref } from "../../utils/prefs";
import { HttpStatusError, httpJson, truncate } from "../../utils/http";

/**
 * 必应翻译引擎（免费）。使用微软 Edge 客户端自己调用的在线翻译接口：
 *   POST https://edge.microsoft.com/translate/translatetext?to=<目标语言>&isEnterpriseClient=false
 * 请求体为「字符串数组」（["待翻译文本"]），无需注册 key，也不需要 X-MT-Signature 匿名签名。
 * 该接口与请求格式参考自 zotero-pdf-translate 的必应服务（AGPL-3.0）：https://github.com/windingwind/zotero-pdf-translate
 *
 * 与旧端点 api.cognitive.microsofttranslator.com/translate（匿名签名）相比：
 *   - 旧端点限制「单次请求内所有待翻译文本合计 ≤1000 字符」，故短文本正常、长文本必被拒；
 *   - 本端点单次上限为 50000 字符（官方文档值；实测 50000 通过，100000 返回
 *     "Request exceeds the maximum allowed translation size."）。
 *     因此这里按块逐次请求、每块不超过 MaxChunk，既避开上限又尽量少发请求。
 *
 * 注意事项：
 *   - 请求必须携带浏览器 User-Agent，缺失会返回 400 "Client Browser Version not supported"；
 *   - 不要传 from 参数：服务端会自动识别源语言（显式传 "auto" 会返回 400）。
 * 国内通常需要代理（跟随 Zotero 的全局代理设置）。
 */
const DefaultApi = "https://edge.microsoft.com/translate/translatetext";
// 旧版内置端点：其匿名签名接口对单次请求有 1000 字符上限，长文本必然失败。
// 设置里仍写着它的（升级前手动填过）一律迁移到新端点。
const LegacyApi = "https://api.cognitive.microsofttranslator.com/translate";
const MaxChunk = 10000; // 该端点官方单次上限 50000 字符，此处留足余量
// 该接口会把「缺少 / 非法 UA」的请求判为 400，固定带上浏览器标识最稳妥。
const UserAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36 Edg/113.0.1774.42";

/** 解析 [{"translations":[{"text":"..."}]}, ...]，按顺序拼接。 */
function parseBing(res: any): string | null {
  try {
    if (!Array.isArray(res) || res.length === 0) return null;
    let out = "";
    for (const item of res) {
      const text = item?.translations?.[0]?.text;
      if (text == null) return null;
      out += String(text);
    }
    return out.trim();
  } catch {
    return null;
  }
}

/** 解析实际使用的接口地址：留空、或仍是旧端点时，回退到新端点。 */
function resolveEndpoint(): string {
  const v = String(getPref("bing.endpoint") || "").trim();
  if (!v) return DefaultApi;
  if (v.replace(/\/+$/, "").toLowerCase() === LegacyApi.toLowerCase()) {
    return DefaultApi;
  }
  return v;
}

/** 按状态码 / 响应体给出排查提示。 */
function statusHint(status: number, body: string): string {
  const b = body || "";
  if (/maximum allowed translation size/i.test(b)) {
    return "（单次文本超出接口上限，请缩短选区或分批翻译）";
  }
  if (/Client Browser Version/i.test(b)) {
    return "（接口拒绝了本次请求，请检查代理设置）";
  }
  switch (status) {
    case 403:
      return "（国内直连可能被拒，请配置 Zotero 代理）";
    case 429:
      return "（请求过于频繁，请稍后重试）";
    default:
      return "";
  }
}

const translate: TranslateService["translate"] = async function (data) {
  const to = mapTargetLang(
    String(getPref("targetLanguage") || "zh-CN"),
    "zh-Hans",
    "zh-Hant",
  );
  const chunks = splitChunks(data.raw, MaxChunk);

  const baseUrl = resolveEndpoint();
  // 不传 from：由服务端自动识别源语言（显式传 "auto" 会报 400）
  const url =
    baseUrl +
    (baseUrl.includes("?") ? "&" : "?") +
    "to=" +
    encodeURIComponent(to) +
    "&isEnterpriseClient=false";

  const parts: string[] = [];
  for (const chunk of chunks) {
    try {
      // 本接口的请求体是字符串数组，不是对象数组
      const res = await httpJson("POST", url, {
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": UserAgent,
        },
        body: JSON.stringify([chunk]),
      });
      const parsed = parseBing(res);
      if (parsed == null) {
        throw new TranslateError(
          "[必应翻译失败] 响应解析失败。\n" +
            truncate(JSON.stringify(res ?? ""), 400),
        );
      }
      parts.push(parsed);
    } catch (e) {
      if (e instanceof HttpStatusError) {
        throw new TranslateError(
          "[必应翻译失败] HTTP " + e.status + statusHint(e.status, e.body),
        );
      }
      throw e;
    }
  }

  data.result = parts.join("").trim();
};

export const BingService: TranslateService = {
  id: "bing",
  type: "sentence",
  supportsContext: () => false,
  translate,
};
