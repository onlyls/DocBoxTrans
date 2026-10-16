import { TranslateError } from "./base";
import type { TranslateService } from "./base";
import { mapTargetLang, splitChunks } from "../../utils/config";
import { getPref } from "../../utils/prefs";
import { HttpStatusError, httpJson } from "../../utils/http";

/**
 * 腾讯交互翻译引擎（transmart.qq.com 免费接口，匿名即可用）。移植自 DocBoxTrans 的 TencentEngine：
 * 必须走「整块」形态（fn=auto_translation_block + client_key + source.text_block），且 Referer 指向 yi.qq.com。
 */
const DefaultApi = "https://transmart.qq.com/api/imt";
const ClientKey =
  "browser-chrome-110.0.0-Mac OS-df4bd4c5-a65d-44b2-a40f-42f34f3535f2-1677486696487";
const Referer = "https://yi.qq.com/zh-CN/index";
const UserAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36";
const MaxChunk = 1000;

async function translateChunk(
  endpoint: string,
  chunk: string,
  to: string,
): Promise<string | null> {
  const body = JSON.stringify({
    header: { fn: "auto_translation_block", client_key: ClientKey },
    type: "plain",
    model_category: "normal",
    source: { lang: "auto", text_block: chunk },
    target: { lang: to },
  });

  const res = await httpJson("POST", endpoint, {
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      referer: Referer,
      "user-agent": UserAgent,
    },
    body,
  });

  if (res && typeof res.auto_translation === "string") {
    const tr = res.auto_translation.trim();
    if (tr.length > 0) return tr;
  }
  const code = res?.header?.ret_code;
  if (code && code !== "succ") {
    throw new TranslateError(
      "[腾讯翻译失败] " + code + (res?.message ? "：" + res.message : ""),
    );
  }
  return null;
}

const translate: TranslateService["translate"] = async function (data) {
  const endpoint =
    String(getPref("tencent.endpoint") || "").trim() || DefaultApi;
  const to = mapTargetLang(String(getPref("targetLanguage") || "zh-CN"), "zh", "zh-TW");
  const chunks = splitChunks(data.raw, MaxChunk);

  try {
    const parts: string[] = [];
    for (const chunk of chunks) {
      const part = await translateChunk(endpoint, chunk, to);
      if (part == null) {
        throw new TranslateError("[腾讯翻译失败] 响应解析失败。");
      }
      parts.push(part);
    }
    data.result = parts.join("").trim();
  } catch (e) {
    if (e instanceof HttpStatusError) {
      throw new TranslateError("[腾讯翻译失败] HTTP " + e.status);
    }
    throw e;
  }
};

export const TencentService: TranslateService = {
  id: "tencent",
  type: "sentence",
  supportsContext: () => false,
  translate,
};
