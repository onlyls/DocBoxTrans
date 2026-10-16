import { getPref } from "./prefs";

/**
 * Zotero.HTTP.request 的薄封装。默认 30s 超时；非 2xx 时抛出携带状态码的 HttpStatusError。
 */
export class HttpStatusError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

export interface HttpOptions {
  headers?: Record<string, string>;
  body?: string;
  timeout?: number;
  responseType?: "text" | "json" | "arraybuffer" | "blob";
  /** 允许「非 2xx 也返回」，由调用方自行判断 */
  allowNon2xx?: boolean;
}

/**
 * 发送一次请求并返回 xhr。`responseType` 默认 text。
 * 非 2xx 时抛 HttpStatusError（除非 allowNon2xx）。
 */
export async function httpRequest(
  method: string,
  url: string,
  options: HttpOptions = {},
): Promise<XMLHttpRequest> {
  const responseType = options.responseType ?? "text";
  let xhr: XMLHttpRequest;
  try {
    xhr = await Zotero.HTTP.request(method, url, {
      headers: options.headers,
      body: options.body,
      responseType,
      timeout: options.timeout ?? 30000,
    });
  } catch (e: any) {
    // Zotero.HTTP.request 在非成功码时抛错，尽量还原状态与响应体
    const status =
      (typeof e?.status === "number" && e.status) ||
      (typeof e?.xhr?.status === "number" && e.xhr.status) ||
      0;
    const body = e?.xhr?.responseText ?? e?.responseText ?? String(e?.message ?? e);
    if (options.allowNon2xx) {
      return e?.xhr as XMLHttpRequest;
    }
    throw new HttpStatusError(status, body);
  }
  if (!options.allowNon2xx && (xhr.status < 200 || xhr.status >= 300)) {
    throw new HttpStatusError(xhr.status, (xhr.responseText as string) || "");
  }
  return xhr;
}

export async function httpText(
  method: string,
  url: string,
  options: HttpOptions = {},
): Promise<string> {
  const xhr = await httpRequest(method, url, { ...options, responseType: "text" });
  return (xhr.responseText as string) || "";
}

export async function httpJson(
  method: string,
  url: string,
  options: HttpOptions = {},
): Promise<any> {
  const xhr = await httpRequest(method, url, { ...options, responseType: "json" });
  return xhr.response;
}

/** 把 params 序列化为 application/x-www-form-urlencoded。 */
export function formEncode(params: Record<string, string>): string {
  return Object.entries(params)
    .map(
      ([k, v]) =>
        `${encodeURIComponent(k)}=${encodeURIComponent(v ?? "")}`,
    )
    .join("&");
}

/** 截断用于错误展示的文本。 */
export function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length <= n ? s : s.slice(0, n) + "…";
}

// ---------------- 谷歌翻译专用代理 ----------------
// Zotero.HTTP.request 只能走 Zotero 的全局代理设置，无法按请求指定代理。
// 因此这里注册一个「按 URI 命中」的协议代理过滤器：命中谷歌翻译端点时，
// 使用设置里的 google.proxy；留空则沿用 Zotero 的全局代理。
// 其它请求不受影响，仍走 Zotero 的默认代理。

/** 谷歌免费翻译端点所在主机（内置端点）。 */
const GOOGLE_HOSTS = ["translate.googleapis.com", "clients5.google.com"];

let proxyFilterInstalled = false;
let registeredPps: nsIProtocolProxyService | null = null;
let registeredFilter: nsIProtocolProxyFilter | null = null;

/** 解析形如 http://127.0.0.1:7890 / socks5://127.0.0.1:1080 的代理地址；无法解析返回 null。 */
function parseProxy(raw: string): { type: string; host: string; port: number } | null {
  let s = (raw || "").trim();
  if (!s) return null;

  let type = "http";
  const m = /^([a-z0-9]+):\/\//i.exec(s);
  if (m) {
    const scheme = m[1].toLowerCase();
    s = s.slice(m[0].length);
    if (scheme.startsWith("socks")) type = "socks";
    else if (scheme === "https") type = "https";
    else type = "http";
  }
  const at = s.lastIndexOf("@");
  if (at >= 0) s = s.slice(at + 1);
  const slash = s.indexOf("/");
  if (slash >= 0) s = s.slice(0, slash);

  let host = s;
  let port = type === "socks" ? 1080 : 8080;
  const colon = s.lastIndexOf(":");
  if (colon > 0) {
    host = s.slice(0, colon).replace(/^\[|\]$/g, "");
    const p = parseInt(s.slice(colon + 1), 10);
    if (Number.isFinite(p) && p > 0) port = p;
  }
  if (!host) return null;
  return { type, host, port };
}

/** 该主机是否属于谷歌翻译端点（含用户自定义的谷歌接口域名）。 */
function isGoogleHost(host: string): boolean {
  if (!host) return false;
  for (const h of GOOGLE_HOSTS) {
    if (host === h || host.endsWith("." + h)) return true;
  }
  const custom = String(getPref("google.endpoint") || "").trim();
  if (custom) {
    try {
      if (new URL(custom).hostname === host) return true;
    } catch {
      // 非法地址忽略
    }
  }
  return false;
}

/**
 * 安装谷歌代理过滤器（启动时调用一次即可）。过滤器每次都实时读取 google.proxy，
 * 因此在设置面板改动后无需重新注册。
 */
export function installGoogleProxyFilter(): void {
  if (proxyFilterInstalled) return;

  let pps: nsIProtocolProxyService;
  try {
    pps = Cc["@mozilla.org/network/protocol-proxy-service;1"].getService(
      Ci.nsIProtocolProxyService,
    );
  } catch (e) {
    Zotero.debug(`[DocBoxTrans] 获取代理服务失败: ${String(e)}`);
    return;
  }

  const filter: nsIProtocolProxyFilter = {
    applyFilter(uri, proxy, callback) {
      let result = proxy;
      try {
        if (uri && isGoogleHost(uri.host)) {
          const parsed = parseProxy(String(getPref("google.proxy") || ""));
          // 留空 = 沿用 Zotero 的全局代理；填写才覆盖
          if (parsed) {
            result = pps.newProxyInfo(
              parsed.type,
              parsed.host,
              parsed.port,
              "",
              "",
              0,
              0,
              null as unknown as nsIProxyInfo,
            );
          }
        }
      } catch (e) {
        Zotero.debug(`[DocBoxTrans] 应用谷歌代理失败: ${String(e)}`);
        result = proxy;
      }
      callback.onProxyFilterResult(result);
    },
  };

  try {
    // 位置 0 = 最高优先级，覆盖 Zotero 的全局代理设置
    pps.registerFilter(filter, 0);
    registeredPps = pps;
    registeredFilter = filter;
    proxyFilterInstalled = true;
  } catch (e) {
    Zotero.debug(`[DocBoxTrans] 注册谷歌代理过滤器失败: ${String(e)}`);
  }
}

/** 卸载谷歌代理过滤器（插件关闭时调用，避免过滤器残留引用插件作用域）。 */
export function uninstallGoogleProxyFilter(): void {
  try {
    if (registeredPps && registeredFilter) {
      registeredPps.unregisterFilter(registeredFilter);
    }
  } catch (e) {
    Zotero.debug(`[DocBoxTrans] 卸载谷歌代理过滤器失败: ${String(e)}`);
  } finally {
    registeredPps = null;
    registeredFilter = null;
    proxyFilterInstalled = false;
  }
}
