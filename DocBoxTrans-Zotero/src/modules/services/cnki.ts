import { TranslateError } from "./base";
import type { TranslateService } from "./base";
import { splitChunks } from "../../utils/config";
import { getPref, getPrefInt } from "../../utils/prefs";
import { HttpStatusError, httpJson } from "../../utils/http";
import { aesEcbEncrypt, base64 } from "../../utils/crypto";

/**
 * 知网引擎（dict.cnki.net 免费学术翻译）。移植自 DocBoxTrans 的 CnkiEngine：
 * 先取 Token（带 300s 内存缓存），再把待翻译文本 AES-ECB 加密后连同 Token 提交。
 */
const DefaultTokenUrl = "https://dict.cnki.net/fyzs-front-api/getToken";
const DefaultApi =
  "https://dict.cnki.net/fyzs-front-api/translate/literaltranslation";
const TokenTtlMs = 300 * 1000;

let tokenCache: { token: string; t: number } | null = null;

async function getToken(): Promise<string> {
  const now = Date.now();
  if (tokenCache && now - tokenCache.t < TokenTtlMs) return tokenCache.token;
  const url = String(getPref("cnki.tokenUrl") || "").trim() || DefaultTokenUrl;
  const res = await httpJson("GET", url, {
    headers: {
      Accept: "application/json",
      referer: "https://dict.cnki.net/index",
    },
  });
  const token = res?.data;
  if (typeof token === "string" && token.length > 0) {
    tokenCache = { token, t: now };
    return token;
  }
  throw new TranslateError(
    "[知网翻译失败] 未能获取 Token，接口可能已变更或网络不可达。",
  );
}

/** AES-ECB / PKCS7，key=4e87183cfd3a45fe，Base64 后 / → _ 、 + → -。 */
async function encryptWords(text: string): Promise<string> {
  const encrypted = await aesEcbEncrypt(text, "4e87183cfd3a45fe");
  return base64(encrypted.buffer as ArrayBuffer)
    .replace(/\//g, "_")
    .replace(/\+/g, "-");
}

function extractCnkiResult(res: any): string | null {
  const data = res?.data;
  if (data == null) return null;
  if (data.isInputVerificationCode) {
    throw new TranslateError(
      "[知网翻译失败] 访问被临时限制，请在 https://dict.cnki.net/ 手动翻译并通过人机验证后重试。",
    );
  }
  const m = data.mResult;
  if (typeof m === "string") return m.trim();
  if (m != null) return String(m).trim();
  return null;
}

const translate: TranslateService["translate"] = async function (data) {
  const token = await getToken();
  const api = String(getPref("cnki.api") || "").trim() || DefaultApi;
  const max = Math.max(60, getPrefInt("cnki.maxChars", 500));
  const chunks = splitChunks(data.raw, max);

  try {
    const parts: string[] = [];
    for (const chunk of chunks) {
      const words = await encryptWords(chunk);
      const res = await httpJson("POST", api, {
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/plain, */*",
          referer: "https://dict.cnki.net/index",
          Token: token,
        },
        body: JSON.stringify({ translateType: null, words }),
      });
      const result = extractCnkiResult(res);
      if (result == null) throw new TranslateError("[知网翻译失败] 响应解析失败。");
      parts.push(result);
    }
    data.result = parts.join("\n").trim();
  } catch (e) {
    if (e instanceof HttpStatusError) {
      throw new TranslateError("[知网翻译失败] HTTP " + e.status);
    }
    throw e;
  }
};

export const CnkiService: TranslateService = {
  id: "cnki",
  type: "sentence",
  supportsContext: () => false,
  translate,
};
