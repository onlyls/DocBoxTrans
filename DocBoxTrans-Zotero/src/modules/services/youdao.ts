import { TranslateError } from "./base";
import type { TranslateService } from "./base";
import type { HistoryRecord } from "../../utils/history";
import { mapTargetLang, splitChunks } from "../../utils/config";
import { getString } from "../../utils/locale";
import { getPref } from "../../utils/prefs";
import {
  HttpStatusError,
  formEncode,
  httpJson,
  httpText,
} from "../../utils/http";
import { hex, randomHex32, sha256Digest } from "../../utils/crypto";

/**
 * 有道翻译引擎（有道智云开放接口）。移植自 DocBoxTrans 的 YoudaoEngine。
 * 由 youdao.mode 决定走哪条接口：
 *   auto（默认）：跟随「上下文增强翻译」开关——已勾选且已填 key 时用大模型翻译（带上下文），否则用文本翻译；
 *   text：文本翻译 /api —— 纯机器翻译，不支持上下文；
 *   llm ：大模型翻译 /proxy/http/llm-trans —— 支持 prompt，可把此前成功翻译注入 prompt 作为参考。
 */
const DefaultApi = "https://openapi.youdao.com/api";
const DefaultLlmApi = "https://openapi.youdao.com/proxy/http/llm-trans";
const MaxChunk = 2000; // 文本翻译单次 q 上限
const MaxLlmChunk = 4000; // 大模型翻译单次 i 上限 5000，预留余量
const PromptMaxChars = 1200; // 大模型翻译 prompt 上限 1200 字符

function appKey(): string {
  return String(getPref("youdao.appKey") || "").trim();
}

function secret(): string {
  return String(getPref("youdao.secret") || "").trim();
}

function hasKey(): boolean {
  return appKey().length > 0 && secret().length > 0;
}

/** 本次请求是否走大模型翻译（auto 模式跟随「上下文增强翻译」开关）。 */
function useLlm(): boolean {
  const m = String(getPref("youdao.mode") || "auto").trim().toLowerCase();
  if (m === "text") return false;
  if (m === "llm" || m === "1" || m === "true" || m === "yes" || m === "on") {
    return true;
  }
  return Boolean(getPref("contextEnable")) && hasKey();
}

function truncateInput(q: string): string {
  const len = q.length;
  return len <= 20 ? q : q.slice(0, 10) + len + q.slice(len - 10);
}

function curTime(): string {
  return String(Math.floor(Date.now() / 1000));
}

async function makeSign(q: string, ak: string, sk: string, salt: string, ct: string) {
  return hex(await sha256Digest(ak + truncateInput(q) + salt + ct + sk));
}

function youdaoHint(code: string): string {
  switch (code) {
    case "101":
      return "（缺少必填参数）";
    case "108":
      return "（应用 ID 无效，请检查应用 ID）";
    case "110":
      return "（当前应用未开通「大模型翻译」：请在有道控制台开通，或把模式设为 text / 关闭上下文增强）";
    case "112":
      return "（请求的服务不存在）";
    case "202":
      return "（签名校验失败，请检查应用密钥）";
    case "203":
      return "（访问 IP 不在白名单）";
    case "206":
      return "（时间戳无效）";
    case "411":
      return "（访问频率受限）";
    case "902000":
      return "（大模型翻译调用失败）";
    default:
      return "";
  }
}

/** 解析文本翻译 {"errorCode":"0","translation":["译文"]}。 */
function parseYoudaoText(res: any): string {
  const code = res?.errorCode != null ? String(res.errorCode) : null;
  if (code != null && code !== "0") {
    throw new TranslateError("[有道翻译失败] 错误码 " + code + youdaoHint(code));
  }
  const tr = res?.translation;
  if (Array.isArray(tr) && tr.length > 0 && tr[0] != null) {
    return String(tr[0]).trim();
  }
  throw new TranslateError("[有道翻译失败] 响应中没有译文。");
}

/** 解析大模型翻译的 SSE 流式响应：取最后一个非空 data.transFull。 */
function parseYoudaoLlm(body: string): string {
  if (!body) throw new TranslateError("[有道翻译失败] 响应为空。");
  let last: string | null = null;
  let err: string | null = null;
  for (let line of body.split("\n")) {
    line = line.trim();
    if (line.length === 0) continue;
    if (/^data:/i.test(line)) line = line.slice(5).trim();
    if (line.length === 0 || line[0] !== "{") continue;
    try {
      const root = JSON.parse(line);
      const code = root?.code != null ? String(root.code) : null;
      if (code != null && code !== "0") {
        err =
          "错误码 " +
          code +
          youdaoHint(code) +
          (root?.message ? "：" + root.message : "");
        continue;
      }
      const full = root?.data?.transFull;
      if (full != null && String(full).length > 0) last = String(full);
    } catch {
      // 忽略无法解析的行
    }
  }
  if (last != null) return last.trim();
  if (err != null) throw new TranslateError("[有道翻译失败] " + err);
  throw new TranslateError("[有道翻译失败] 响应中没有译文。");
}

/**
 * 把此前成功翻译拼成参考提示词（仅用于统一术语与表达，不作为待翻译内容）。
 * prompt 有 1200 字符硬上限，参考价值随距离衰减，因此从最新一条往旧装填。
 */
function buildPrompt(context: HistoryRecord[]): string | null {
  if (!context || context.length === 0) return null;

  const head =
    "以下“原文→译文”是此前已完成的翻译，仅用于统一术语与表达，请勿翻译它们，只翻译最后给出的待翻译文本。";
  const LabelCost = 8; // 每条 "\n原文：" + "\n译文：" 的固定开销
  const budget = PromptMaxChars - head.length;
  if (budget <= LabelCost) return null;

  const parts: string[] = [];
  let used = 0;
  for (let i = context.length - 1; i >= 0; i--) {
    const r = context[i];
    if (!r) continue;
    const src = (r.sourceText ?? "").trim();
    const dst = (r.translatedText ?? "").trim();
    if (src.length === 0 && dst.length === 0) continue;

    const remain = budget - used;
    const need = src.length + dst.length + LabelCost;
    if (need <= remain) {
      parts.push("\n原文：" + src + "\n译文：" + dst);
      used += need;
      continue;
    }

    const room = remain - LabelCost;
    if (parts.length === 0 && room > 40) {
      const half = Math.floor(room / 2);
      const s = src.length > half ? src.slice(0, half - 1) + "…" : src;
      const d =
        dst.length > room - s.length
          ? dst.slice(0, Math.max(0, room - s.length - 1)) + "…"
          : dst;
      parts.push("\n原文：" + s + "\n译文：" + d);
    }
    break;
  }
  if (parts.length === 0) return null;
  parts.reverse();
  return head + parts.join("");
}

async function translateTextChunk(chunk: string, to: string): Promise<string> {
  const salt = randomHex32();
  const ct = curTime();
  const sign = await makeSign(chunk, appKey(), secret(), salt, ct);
  const body = formEncode({
    q: chunk,
    from: "auto",
    to,
    appKey: appKey(),
    salt,
    sign,
    signType: "v3",
    curtime: ct,
  });
  const res = await httpJson("POST", DefaultApi, {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });
  return parseYoudaoText(res);
}

async function translateLlmChunk(
  chunk: string,
  to: string,
  prompt: string | null,
): Promise<string> {
  const salt = randomHex32();
  const ct = curTime();
  const sign = await makeSign(chunk, appKey(), secret(), salt, ct);
  const params: Record<string, string> = {
    i: chunk,
    from: "auto",
    to,
    appKey: appKey(),
    salt,
    sign,
    signType: "v3",
    curtime: ct,
    handleOption: "0",
    streamType: "full",
  };
  if (prompt) params.prompt = prompt;
  // 该接口以 SSE 返回；声明 Accept: application/json 会因内容协商失败而报「错误码 1」。
  const txt = await httpText("POST", DefaultLlmApi, {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "text/event-stream",
    },
    body: formEncode(params),
  });
  return parseYoudaoLlm(txt);
}

const translate: TranslateService["translate"] = async function (data, context) {
  if (!hasKey()) {
    throw new TranslateError(
      "[配置错误] 有道翻译需要填写应用 ID 与应用密钥。请在「设置 → DocBoxTrans → 有道」里填写。",
    );
  }
  const to = mapTargetLang(
    String(getPref("targetLanguage") || "zh-CN"),
    "zh-CHS",
    "zh-CHT",
  );
  try {
    if (useLlm()) {
      const prompt = buildPrompt(context);
      const chunks = splitChunks(data.raw, Math.max(200, MaxLlmChunk));
      const parts: string[] = [];
      for (const c of chunks) {
        parts.push(await translateLlmChunk(c, to, prompt));
      }
      data.result = parts.join("").trim();
    } else {
      const chunks = splitChunks(data.raw, MaxChunk);
      const parts: string[] = [];
      for (const c of chunks) {
        parts.push(await translateTextChunk(c, to));
      }
      data.result = parts.join("").trim();
    }
  } catch (e) {
    if (e instanceof HttpStatusError) {
      throw new TranslateError("[有道翻译失败] HTTP " + e.status);
    }
    throw e;
  }
};

export const YoudaoService: TranslateService = {
  id: "youdao",
  type: "sentence",
  supportsContext: () => useLlm(),
  translate,
};

/**
 * 「测试连接」用：按当前模式（auto 跟随上下文开关）发一次最小翻译请求，
 * 验证应用 ID / 应用密钥是否有效、所需接口是否已开通。不抛错，返回 { ok, message }。
 */
export async function probeConnection(): Promise<{ ok: boolean; message: string }> {
  if (!hasKey()) {
    return { ok: false, message: getString("test-need-config") };
  }

  const to = mapTargetLang(
    String(getPref("targetLanguage") || "zh-CN"),
    "zh-CHS",
    "zh-CHT",
  );
  const llm = useLlm();
  try {
    const out = llm
      ? await translateLlmChunk("Hello world", to, null)
      : await translateTextChunk("Hello world", to);
    return {
      ok: true,
      message: getString("test-ok", {
        args: { detail: `${out}（${llm ? "llm" : "text"}）` },
      }),
    };
  } catch (e) {
    const detail =
      e instanceof HttpStatusError
        ? "HTTP " + e.status
        : String((e as any)?.message ?? e);
    return { ok: false, message: getString("test-fail", { args: { detail } }) };
  }
}
