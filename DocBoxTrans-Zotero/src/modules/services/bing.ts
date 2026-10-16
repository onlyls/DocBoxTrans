import { TranslateError } from "./base";
import type { TranslateService } from "./base";
import { mapTargetLang, splitChunks } from "../../utils/config";
import { getPref } from "../../utils/prefs";
import { HttpStatusError, httpJson, truncate } from "../../utils/http";
import { base64, hmacSha256Digest, randomHex32 } from "../../utils/crypto";

/**
 * 必应翻译引擎（免费）。移植自 DocBoxTrans 的 BingEngine：
 * 直接调用 api.cognitive.microsofttranslator.com/translate，用 X-MT-Signature（HMAC-SHA256）匿名鉴权。
 * 国内通常需要代理（走 Zotero 代理设置）。
 */
const DefaultApi = "https://api.cognitive.microsofttranslator.com/translate";
const MaxChunk = 1000; // 微软接口单元素 1000 字符上限
const ApiVersion = "3.0";

/** 微软 Edge 客户端匿名鉴权所用的私钥（来自 DocBoxTrans）。 */
const PrivateKey = new Uint8Array([
  0xa2, 0x29, 0x3a, 0x3d, 0xd0, 0xdd, 0x32, 0x73, 0x97, 0x7a, 0x64, 0xdb, 0xc2,
  0xf3, 0x27, 0xf5, 0xd7, 0xbf, 0x87, 0xd9, 0x45, 0x9d, 0xf0, 0x5a, 0x09, 0x66,
  0xc6, 0x30, 0xc6, 0x6a, 0xaa, 0x84, 0x9a, 0x41, 0xaa, 0x94, 0x3a, 0xa8, 0xd5,
  0x1a, 0x6e, 0x4d, 0xaa, 0xc9, 0xa3, 0x70, 0x12, 0x35, 0xc7, 0xeb, 0x12, 0xf6,
  0xe8, 0x23, 0x07, 0x9e, 0x47, 0x10, 0x95, 0x91, 0x88, 0x55, 0xd8, 0x17,
]);

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function httpDate(d: Date): string {
  return `${WEEKDAYS[d.getUTCDay()]}, ${pad2(d.getUTCDate())} ${
    MONTHS[d.getUTCMonth()]
  } ${d.getUTCFullYear()} ${pad2(d.getUTCHours())}:${pad2(
    d.getUTCMinutes(),
  )}:${pad2(d.getUTCSeconds())}`;
}

function randomGuid(): string {
  return randomHex32();
}

/** 等价于 .NET Uri.EscapeDataString：除 A-Z a-z 0-9 - . _ ~ 外全部百分号编码（大写十六进制）。 */
function escapeDataString(s: string): string {
  const unreserved = /^[A-Za-z0-9\-_.~]$/;
  let out = "";
  for (const ch of s) {
    if (unreserved.test(ch)) {
      out += ch;
    } else {
      for (const b of new TextEncoder().encode(ch)) {
        out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
      }
    }
  }
  return out;
}

/** 生成 X-MT-Signature 头值。url 为「不含协议头」的完整请求地址。 */
async function signature(urlNoScheme: string): Promise<string> {
  const guid = randomGuid();
  const escapedUrl = escapeDataString(urlNoScheme);
  const dateTime = httpDate(new Date()) + "GMT";
  const str = (
    "MSTranslatorAndroidApp" + escapedUrl + dateTime + guid
  ).toLowerCase();
  const sig = base64(await hmacSha256Digest(str, PrivateKey));
  return `MSTranslatorAndroidApp::${sig}::${dateTime}::${guid}`;
}

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

const translate: TranslateService["translate"] = async function (data) {
  const to = mapTargetLang(
    String(getPref("targetLanguage") || "zh-CN"),
    "zh-Hans",
    "zh-Hant",
  );
  const chunks = splitChunks(data.raw, MaxChunk);

  const baseUrl =
    String(getPref("bing.endpoint") || "").trim() || DefaultApi;
  const url =
    baseUrl +
    (baseUrl.includes("?") ? "&" : "?") +
    "api-version=" +
    ApiVersion +
    "&to=" +
    encodeURIComponent(to);

  const body = JSON.stringify(chunks.map((c) => ({ Text: c })));

  try {
    const res = await httpJson("POST", url, {
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-MT-Signature": await signature(url.slice(url.indexOf("://") + 3)),
      },
      body,
    });
    const parsed = parseBing(res);
    if (parsed == null) {
      throw new TranslateError(
        "[必应翻译失败] 响应解析失败。\n" + truncate(JSON.stringify(res ?? ""), 400),
      );
    }
    data.result = parsed;
  } catch (e) {
    if (e instanceof HttpStatusError) {
      throw new TranslateError(
        "[必应翻译失败] HTTP " +
          e.status +
          (e.status === 403
            ? "（国内直连可能被拒，请配置 Zotero 代理）"
            : ""),
      );
    }
    throw e;
  }
};

export const BingService: TranslateService = {
  id: "bing",
  type: "sentence",
  supportsContext: () => false,
  translate,
};
