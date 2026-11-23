import { TranslateError, TranslateService } from "./base";
import type { TranslationContext } from "./base";
import { getString } from "../../utils/locale";
import { getPref } from "../../utils/prefs";
import { HttpStatusError, httpJson, httpText, truncate } from "../../utils/http";
import { ChatCompletionStream } from "./chatStream";
import { readServiceConfig, validateLlmParameters, type LlmProfile } from "../serviceConfig";

/**
 * 大模型引擎（OpenAI 兼容 /chat/completions）。移植自 DocBoxTrans 的 LlmEngine。
 * 支持上下文：把此前成功的翻译成对加入 messages，仅用于统一术语与表达。
 */
const ContextGuidance =
  "\n\n以下是之前已完成翻译的原文与译文（成对给出），仅用于统一术语、缩写与表达习惯；" +
  "请勿翻译这些内容，只翻译最后一条用户消息，并且只输出译文本身。";

const DefaultSystemPrompt =
  "你是面向各学科的专业学术翻译助手。请将用户提供的文本准确、完整地翻译成{targetLanguage}。根据原文及上下文判断所属领域，使用该领域通行的术语，保持术语、缩写与表达一致，不预设学科背景。忠实保留原文的含义、逻辑、语气及不确定性，不增删信息，不补充解释或推测。保留原有段落、换行、列表、公式、符号、数值、单位及引用标记；专有名词和缩写按通行译法处理，必要时保留原文。只输出译文本身，不要添加说明、标题、标注或重复原文。";
const PreviousSystemPrompt =
  "你是专业的翻译引擎。把用户提供的文本翻译成{targetLanguage}，只输出译文本身，不要任何解释、标注或原文。保留原有的换行和标点结构。";
const LegacySystemPrompt = PreviousSystemPrompt.replace("{targetLanguage}", "简体中文");

function currentProfile(): LlmProfile {
  const profile = readServiceConfig().profiles.find(p => p.id === "llm");
  if (!profile) throw new TranslateError(getString("status-unknown-service") + "llm");
  return profile;
}

function requestParameters(profile: LlmProfile) {
  validateLlmParameters(profile);
  return { apiKey: profile.apiKey.trim(), endpoint: profile.endpoint.trim(),
    model: profile.model.trim(), temperature: profile.temperature.trim() ? Number(profile.temperature) : 0.2,
    systemPrompt: profile.systemPrompt };
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
  const template = !systemPrompt || systemPrompt === LegacySystemPrompt || systemPrompt === PreviousSystemPrompt
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

function translateWith(profile: LlmProfile): TranslateService["translate"] {
  const snapshot = { ...profile };
  return async (data, context) => {
    const { apiKey, endpoint, model, temperature, systemPrompt } = requestParameters(snapshot);
    const stream = snapshot.stream && Boolean(data.onProgress);
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
}

/** Each instance captures its own parameters before the request starts. */
export function createLlmService(profile: LlmProfile): TranslateService {
  return { id: profile.id, type: "sentence", supportsContext: () => true,
    translate: translateWith(profile) };
}

export const LlmService: TranslateService = {
  id: "llm",
  type: "sentence",
  supportsContext: () => true,
  translate: (data, context) => translateWith(currentProfile())(data, context),
};

/**
 * 「测试连接」用：按当前设置发一次最小翻译请求，验证接口、密钥与系统提示词是否真的可用。
 * 不抛错，统一返回 { ok, message }，方便偏好面板直接展示。
 */
export async function probeConnection(profile?: LlmProfile): Promise<{ ok: boolean; message: string }> {
  const started = Date.now();
  try {
    const { apiKey, endpoint, model, temperature, systemPrompt } = requestParameters({ ...(profile ?? currentProfile()) });
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
