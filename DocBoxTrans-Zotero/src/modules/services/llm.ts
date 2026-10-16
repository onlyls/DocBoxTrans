import { TranslateError, TranslateService } from "./base";
import type { HistoryRecord } from "../../utils/history";
import { getString } from "../../utils/locale";
import { getPref } from "../../utils/prefs";
import { HttpStatusError, httpJson, truncate } from "../../utils/http";

/**
 * 大模型引擎（OpenAI 兼容 /chat/completions）。移植自 DocBoxTrans 的 LlmEngine。
 * 支持上下文：把此前成功的翻译成对加入 messages，仅用于统一术语与表达。
 */
const ContextGuidance =
  "\n\n以下是之前已完成翻译的原文与译文（成对给出），仅用于统一术语、缩写与表达习惯；" +
  "请勿翻译这些内容，只翻译最后一条用户消息，并且只输出译文本身。";

function buildBody(
  model: string,
  temperature: number,
  systemPrompt: string,
  text: string,
  context: HistoryRecord[],
): string {
  const hasCtx = context && context.length > 0;
  const messages: Array<{ role: string; content: string }> = [];
  let sys = systemPrompt || "";
  if (hasCtx) sys = sys + ContextGuidance;
  messages.push({ role: "system", content: sys });
  if (hasCtx) {
    for (const r of context) {
      if (!r) continue;
      messages.push({ role: "user", content: r.sourceText ?? "" });
      messages.push({ role: "assistant", content: r.translatedText ?? "" });
    }
  }
  messages.push({ role: "user", content: text });

  return JSON.stringify({
    model,
    temperature,
    stream: false,
    messages,
  });
}

function extractContent(res: any): string | null {
  try {
    const choices = res?.choices;
    if (Array.isArray(choices) && choices.length > 0) {
      const c0 = choices[0];
      const content = c0?.message?.content;
      if (typeof content === "string") return content.trim();
      if (typeof c0?.text === "string") return c0.text.trim();
    }
    return null;
  } catch {
    return null;
  }
}

function extractErrorFromResponse(res: any): string | null {
  const m = res?.error?.message;
  if (m != null) return "接口返回错误：" + String(m);
  if (res?.error != null) return "接口返回错误：" + JSON.stringify(res.error);
  return null;
}

function extractErrorFromBody(body: string): string | null {
  try {
    return extractErrorFromResponse(JSON.parse(body));
  } catch {
    return body ? truncate(body, 400) : null;
  }
}

const translate: TranslateService["translate"] = async function (data, context) {
  const apiKey = String(getPref("llm.apiKey") || "").trim();
  const endpoint = String(getPref("llm.endpoint") || "").trim();
  const model = String(getPref("llm.model") || "").trim();
  const temperature = Number(getPref("llm.temperature")) || 0.2;
  const systemPrompt = String(getPref("llm.systemPrompt") || "");

  if (!apiKey) {
    throw new TranslateError(
      "[配置错误] 还没有填写大模型 apiKey。请在「设置 → DocBoxTrans → 大模型」里填写。",
    );
  }
  if (!endpoint) {
    throw new TranslateError("[配置错误] 还没有填写大模型接口地址。");
  }

  const body = buildBody(model, temperature, systemPrompt, data.raw, context);
  try {
    const res = await httpJson("POST", endpoint, {
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey,
        Accept: "application/json",
      },
      body,
    });
    const err = extractErrorFromResponse(res);
    if (err) throw new TranslateError(err);
    const content = extractContent(res);
    if (content == null) {
      throw new TranslateError(
        "[响应解析失败]\n" + truncate(JSON.stringify(res ?? ""), 400),
      );
    }
    data.result = content;
  } catch (e) {
    if (e instanceof HttpStatusError) {
      const m = extractErrorFromBody(e.body);
      throw new TranslateError("[请求失败] " + (m ?? e.message));
    }
    throw e;
  }
};

export const LlmService: TranslateService = {
  id: "llm",
  type: "sentence",
  supportsContext: () => true,
  translate,
};

/**
 * 「测试连接」用：按当前设置发一次最小翻译请求，验证接口、密钥与系统提示词是否真的可用。
 * 不抛错，统一返回 { ok, message }，方便偏好面板直接展示。
 */
export async function probeConnection(): Promise<{ ok: boolean; message: string }> {
  const apiKey = String(getPref("llm.apiKey") || "").trim();
  const endpoint = String(getPref("llm.endpoint") || "").trim();
  const model = String(getPref("llm.model") || "").trim();
  const temperature = Number(getPref("llm.temperature")) || 0.2;
  const systemPrompt = String(getPref("llm.systemPrompt") || "");

  if (!apiKey || !endpoint) {
    return { ok: false, message: getString("test-need-config") };
  }

  const started = Date.now();
  try {
    const res = await httpJson("POST", endpoint, {
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey,
        Accept: "application/json",
      },
      body: buildBody(model, temperature, systemPrompt, "Hello", []),
      timeout: 20000,
    });
    const err = extractErrorFromResponse(res);
    if (err) {
      return { ok: false, message: getString("test-fail", { args: { detail: err } }) };
    }
    const content = extractContent(res);
    if (content == null) {
      return {
        ok: false,
        message: getString("test-fail", {
          args: { detail: truncate(JSON.stringify(res ?? ""), 200) },
        }),
      };
    }
    return {
      ok: true,
      message: getString("test-ok", {
        args: { detail: `${content}（${Date.now() - started}ms）` },
      }),
    };
  } catch (e) {
    if (e instanceof HttpStatusError) {
      const detail = extractErrorFromBody(e.body) ?? e.message;
      return { ok: false, message: getString("test-fail", { args: { detail } }) };
    }
    return {
      ok: false,
      message: getString("test-fail", {
        args: { detail: String((e as any)?.message ?? e) },
      }),
    };
  }
}
