import { TranslateError, TranslateService } from "./base";
import type { TranslationContext } from "./base";
import { getString } from "../../utils/locale";
import { getPref } from "../../utils/prefs";
import { HttpStatusError, httpJson, httpText, truncate } from "../../utils/http";
import { ChatCompletionStream } from "./chatStream";

/**
 * 大模型引擎（OpenAI 兼容 /chat/completions）。移植自 DocBoxTrans 的 LlmEngine。
 * 支持上下文：把此前成功的翻译成对加入 messages，仅用于统一术语与表达。
 */
const ContextGuidance =
  "\n\n以下是之前已完成翻译的原文与译文（成对给出），仅用于统一术语、缩写与表达习惯；" +
  "请勿翻译这些内容，只翻译最后一条用户消息，并且只输出译文本身。";

const DefaultSystemPrompt =
  "你是专业的翻译引擎。把用户提供的文本翻译成{targetLanguage}，只输出译文本身，不要任何解释、标注或原文。保留原有的换行和标点结构。";
const LegacySystemPrompt = DefaultSystemPrompt.replace("{targetLanguage}", "简体中文");

function readTemperature(): number {
  const raw = String(getPref("llm.temperature") ?? "").trim();
  const value = raw ? Number(raw) : 0.2;
  if (!Number.isFinite(value) || value < 0 || value > 2) {
    throw new TranslateError(getString("status-invalid-temperature"));
  }
  return value;
}

function buildBody(
  model: string,
  temperature: number,
  systemPrompt: string,
  text: string,
  targetLanguage: string,
  context: TranslationContext,
  stream = false,
): string {
  const hasCtx = context && context.length > 0;
  const messages: Array<{ role: string; content: string }> = [];
  const template = !systemPrompt || systemPrompt === LegacySystemPrompt
    ? DefaultSystemPrompt : systemPrompt;
  let sys = template.split("{targetLanguage}").join(targetLanguage);
  // 兼容已有自定义模板，明确以本次任务的目标语言为准。
  sys += `\n\nTarget language: ${targetLanguage}. This target language overrides any other target language specified above. Output only the translation.`;
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
    stream,
    messages,
  });
}

function extractContent(res: any): string | null {
  try {
    const choices = res?.choices;
    if (Array.isArray(choices) && choices.length > 0) {
      const c0 = choices[0];
      const content = c0?.message?.content;
      if (typeof content === "string") return content.trim() || null;
      if (typeof c0?.text === "string") return c0.text.trim() || null;
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
  const temperature = readTemperature();
  const systemPrompt = String(getPref("llm.systemPrompt") || "");

  if (!apiKey) {
    throw new TranslateError(
      "[配置错误] 还没有填写大模型 apiKey。请在「设置 → DocBoxTrans → 大模型」里填写。",
    );
  }
  if (!endpoint) {
    throw new TranslateError("[配置错误] 还没有填写大模型接口地址。");
  }

  const stream = getPref("llm.stream") !== false && Boolean(data.onProgress);
  const body = buildBody(model, temperature, systemPrompt, data.raw, data.langto, context, stream);
  const headers = {
    "Content-Type": "application/json",
    Authorization: "Bearer " + apiKey,
    Accept: stream ? "text/event-stream, application/json" : "application/json",
  };
  try {
    if (stream) {
      const parser = new ChatCompletionStream(text => data.onProgress?.(text));
      const response = await httpText("POST", endpoint, {
        headers, body, signal: data.signal,
        onTextChunk: chunk => parser.feed(chunk),
      });
      // 部分兼容服务忽略 stream，直接返回普通 JSON；使用同一次响应，不额外计费。
      if (response.trimStart().startsWith("{")) {
        const res = JSON.parse(response);
        const err = extractErrorFromResponse(res);
        if (err) throw new TranslateError(err);
        const text = extractContent(res);
        if (!text) throw new TranslateError(getString("status-empty-result"));
        return { text };
      }
      return { text: parser.finish() };
    }
    const res = await httpJson("POST", endpoint, {
      headers,
      body,
      signal: data.signal,
    });
    const err = extractErrorFromResponse(res);
    if (err) throw new TranslateError(err);
    const content = extractContent(res);
    if (content == null) {
      throw new TranslateError(
        "[响应解析失败]\n" + truncate(JSON.stringify(res ?? ""), 400),
      );
    }
    return { text: content };
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
  const systemPrompt = String(getPref("llm.systemPrompt") || "");

  if (!apiKey || !endpoint) {
    return { ok: false, message: getString("test-need-config") };
  }

  const started = Date.now();
  try {
    const temperature = readTemperature();
    const res = await httpJson("POST", endpoint, {
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey,
        Accept: "application/json",
      },
      body: buildBody(model, temperature, systemPrompt, "Hello",
        String(getPref("targetLanguage") || "zh-CN"), []),
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
