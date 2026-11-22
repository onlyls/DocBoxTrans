import { getPref, setPref } from "../utils/prefs";
import { getString } from "../utils/locale";

export interface LlmProfile {
  id: string;
  name: string;
  endpoint: string;
  apiKey: string;
  model: string;
  temperature: string;
  systemPrompt: string;
  stream: boolean;
}

export interface ServiceConfig {
  version: 1;
  profiles: LlmProfile[];
  visible: string[];
  deletedNames: Record<string, string>;
}

export const builtinServiceIds = ["google", "bing", "tencent", "youdao", "cnki"];
const storageKey = "services.config";
const listeners = new Set<() => void>();

export function subscribeServiceConfig(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function notifyServiceConfig(): void {
  for (const listener of [...listeners]) {
    try { listener(); } catch (e) {
      Zotero.logError(e instanceof Error ? e : new Error(String(e)));
    }
  }
}

/** Legacy reads remain non-mutating until startup migration or an explicit edit. */
export function legacyLlmProfile(): LlmProfile {
  return {
    id: "llm", name: getString("service-llm"),
    endpoint: String(getPref("llm.endpoint") || ""),
    apiKey: String(getPref("llm.apiKey") || ""),
    model: String(getPref("llm.model") || ""),
    temperature: String(getPref("llm.temperature") ?? "0.2"),
    systemPrompt: String(getPref("llm.systemPrompt") || ""),
    stream: getPref("llm.stream") !== false,
  };
}

export function readServiceConfig(): ServiceConfig {
  const raw = getPref(storageKey);
  if (!raw) return {
    version: 1, profiles: [legacyLlmProfile()],
    visible: ["llm", ...builtinServiceIds], deletedNames: {},
  };
  // Never overwrite damaged or newer settings with a fresh migration.
  try {
    const data = JSON.parse(String(raw));
    const fields = ["id", "name", "endpoint", "apiKey", "model", "temperature", "systemPrompt"];
    if (data.version !== 1 || !Array.isArray(data.profiles) ||
      !data.profiles.every((p: any) => p && fields.every(k => typeof p[k] === "string") &&
        typeof p.stream === "boolean" && (p.id === "llm" || /^llm-[\w-]+$/.test(p.id))) ||
      new Set(data.profiles.map((p: LlmProfile) => p.id)).size !== data.profiles.length ||
      !Array.isArray(data.visible) || !data.visible.every((id: unknown) => typeof id === "string") ||
      !data.deletedNames || typeof data.deletedNames !== "object" || Array.isArray(data.deletedNames) ||
      !Object.values(data.deletedNames).every(name => typeof name === "string")) throw new Error();
    return data;
  } catch {
    throw new Error(getString("services-storage-error"));
  }
}

function orderedIds(data: ServiceConfig): string[] {
  return [...data.profiles.map(p => p.id), ...builtinServiceIds];
}

export function visibleServiceIds(data = readServiceConfig()): string[] {
  const ids = orderedIds(data);
  const visible = ids.filter(id => data.visible.includes(id));
  return visible.length ? visible : [ids[0]];
}

function commit(data: ServiceConfig): void {
  data.visible = visibleServiceIds(data);
  // One JSON write keeps profiles, visibility and deleted names consistent.
  setPref(storageKey, JSON.stringify(data));
  const current = String(getPref("translateSource") || "");
  if (!data.visible.includes(current)) setPref("translateSource", data.visible[0]);
  notifyServiceConfig();
}

export function initializeServiceConfig(): void {
  commit(readServiceConfig());
}

export function createLlmProfile(): LlmProfile {
  let id: string;
  const data = readServiceConfig();
  do { id = `llm-${Zotero.Utilities.randomString()}-${Date.now()}`; }
  while (data.profiles.some(p => p.id === id) || Object.hasOwn(data.deletedNames, id));
  return {
    id, name: "", endpoint: "https://api.deepseek.com/v1/chat/completions",
    apiKey: "", model: "deepseek-chat", temperature: "0.2", systemPrompt: "", stream: true,
  };
}

export function validateLlmParameters(profile: LlmProfile): void {
  try {
    const url = new URL(profile.endpoint.trim());
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname) throw new Error();
  } catch { throw new Error(getString("services-invalid-endpoint")); }
  if (!profile.model.trim()) throw new Error(getString("services-model-required"));
  if (!profile.apiKey.trim()) throw new Error(getString("test-need-config"));
  const temperature = profile.temperature.trim() ? Number(profile.temperature) : 0.2;
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw new Error(getString("status-invalid-temperature"));
  }
}

export function saveLlmProfile(profile: LlmProfile): void {
  const data = readServiceConfig();
  const name = profile.name.trim();
  if (!name) throw new Error(getString("services-name-required"));
  const names = [...data.profiles.filter(p => p.id !== profile.id).map(p => p.name),
    ...builtinServiceIds.map(id => getString(`service-${id}`))];
  if (names.some(n => n.trim().toLowerCase() === name.toLowerCase())) {
    throw new Error(getString("services-name-duplicate"));
  }
  if (!(profile.id === "llm" || /^llm-[\w-]+$/.test(profile.id)) ||
    Object.hasOwn(data.deletedNames, profile.id)) throw new Error(getString("status-unknown-service"));
  validateLlmParameters(profile);
  const saved = { ...profile, name, endpoint: profile.endpoint.trim(),
    apiKey: profile.apiKey.trim(), model: profile.model.trim() };
  const index = data.profiles.findIndex(p => p.id === profile.id);
  if (index < 0) {
    data.profiles.push(saved);
    data.visible.push(saved.id);
  } else data.profiles[index] = saved;
  commit(data);
}

export function deleteLlmProfile(id: string): void {
  const data = readServiceConfig();
  const profile = data.profiles.find(p => p.id === id);
  if (!profile) throw new Error(getString("status-unknown-service") + id);
  data.deletedNames[id] = profile.name;
  data.profiles = data.profiles.filter(p => p.id !== id);
  data.visible = data.visible.filter(value => value !== id);
  commit(data);
}

export function setServiceVisible(id: string, visible: boolean): void {
  const data = readServiceConfig();
  if (!orderedIds(data).includes(id)) throw new Error(getString("status-unknown-service") + id);
  const next = new Set(visibleServiceIds(data));
  if (visible) next.add(id); else next.delete(id);
  if (!next.size) throw new Error(getString("services-keep-one"));
  data.visible = [...next];
  commit(data);
}

export function selectService(id: string): void {
  if (!visibleServiceIds().includes(id)) throw new Error(getString("status-unknown-service") + id);
  setPref("translateSource", id);
  notifyServiceConfig();
}
