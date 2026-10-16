import { config, homepage } from "../../package.json";
import { getString } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";
import { services } from "./services";
import { probeConnection as probeLlm } from "./services/llm";
import { probeConnection as probeYoudao } from "./services/youdao";

/** 注册 Zotero 7 偏好设置面板。 */
export function registerPrefsWindow() {
  Zotero.PreferencePanes.register({
    pluginID: config.addonID,
    src: rootURI + "chrome/content/preferences.xhtml",
    label: getString("pref-title"),
    // 首选项侧栏图标与 Zotero 内置面板同为 20*20；Zotero 以原生尺寸渲染，传 48px 会被裁切
    image: `chrome://${config.addonRef}/content/icons/panel-20.svg`,
    helpURL: homepage,
  });
}

/** 偏好面板打开时调用：记录窗口并动态填充服务下拉框。 */
export function registerPrefsScripts(win: Window) {
  addon.data.prefs.window = win;
  buildServiceMenulist(win);
  bindSystemPrompt(win);
  bindYoudaoMode(win);
  bindSecretToggles(win);
  bindConnectionTests(win);
}

/** 密钥 / 应用 ID 等敏感字段：默认以密码框显示，勾选「显示」后才临时明文。 */
function bindSecretToggles(win: Window) {
  const pairs: Array<[string, string]> = [
    ["llm-apiKey", "llm-apiKey-show"],
    ["youdao-appKey", "youdao-appKey-show"],
    ["youdao-secret", "youdao-secret-show"],
  ];
  for (const [inputId, toggleId] of pairs) {
    const input = win.document.querySelector(
      `#${config.addonRef}-${inputId}`,
    ) as HTMLInputElement | null;
    const toggle = win.document.querySelector(
      `#${config.addonRef}-${toggleId}`,
    ) as XUL.Checkbox | null;
    if (!input || !toggle) continue;
    const sync = () => {
      input.type = toggle.checked ? "text" : "password";
    };
    sync();
    toggle.addEventListener("command", sync);
  }
}

/** 「测试连接」按钮：用当前设置发一次探测请求，把结果写到下方的说明文字里。 */
function bindConnectionTests(win: Window) {
  bindConnectionTest(win, "llm-test", "llm-testResult", probeLlm);
  bindConnectionTest(win, "youdao-test", "youdao-testResult", probeYoudao);
}

function bindConnectionTest(
  win: Window,
  buttonId: string,
  resultId: string,
  probe: () => Promise<{ ok: boolean; message: string }>,
) {
  const button = win.document.querySelector(
    `#${config.addonRef}-${buttonId}`,
  ) as XUL.Button | null;
  const result = win.document.querySelector(
    `#${config.addonRef}-${resultId}`,
  ) as XUL.Label | null;
  if (!button || !result) return;

  button.addEventListener("command", async () => {
    button.disabled = true;
    setTestResult(result, getString("test-running"), "");
    try {
      const r = await probe();
      setTestResult(result, r.message, r.ok ? "#2e7d32" : "#d32f2f");
    } catch (e) {
      setTestResult(
        result,
        getString("test-fail", { args: { detail: String((e as any)?.message ?? e) } }),
        "#d32f2f",
      );
    } finally {
      button.disabled = false;
    }
  });
}

/** XUL label 用 value 承载文本；顺便用颜色区分通过 / 失败。 */
function setTestResult(el: XUL.Label, text: string, color: string) {
  el.value = text;
  el.style.color = color;
}

/** 系统提示词是 XUL textarea，Zotero 默认不做 preference 绑定，这里手动读写。 */
function bindSystemPrompt(win: Window) {
  const el = win.document.querySelector(
    `#${config.addonRef}-llm-systemPrompt`,
  ) as HTMLTextAreaElement | null;
  if (!el) return;
  el.value = String(getPref("llm.systemPrompt") || "");
  el.addEventListener("input", () => {
    setPref("llm.systemPrompt", el.value);
  });
}

/** 有道模式 menulist 同样手动读写，避免依赖 preference 绑定。 */
function bindYoudaoMode(win: Window) {
  const el = win.document.querySelector(
    `#${config.addonRef}-youdao-mode`,
  ) as XUL.MenuList | null;
  if (!el) return;
  el.setAttribute("value", String(getPref("youdao.mode") || "auto"));
  el.addEventListener("command", () => {
    const value = el.getAttribute("value");
    if (value) setPref("youdao.mode", value);
  });
}

function buildServiceMenulist(win: Window) {
  const doc = win.document;
  const placeholder = doc.querySelector(
    `#${config.addonRef}-serviceSource-placeholder`,
  );
  if (!placeholder) return;

  const current = String(getPref("translateSource") || "llm");
  ztoolkit.UI.replaceElement(
    {
      tag: "menulist",
      id: `${config.addonRef}-serviceSource`,
      attributes: { value: current, native: "true" },
      listeners: [
        {
          type: "command",
          listener: (e: Event) => {
            const value = (e.target as XUL.Element).getAttribute("value");
            if (value) setPref("translateSource", value);
          },
        },
      ],
      children: [
        {
          tag: "menupopup",
          children: services.getAll().map((s) => ({
            tag: "menuitem",
            attributes: {
              label: services.getDisplayName(s.id),
              value: s.id,
            },
          })),
        },
      ],
    },
    placeholder as XUL.Element,
  );
}
