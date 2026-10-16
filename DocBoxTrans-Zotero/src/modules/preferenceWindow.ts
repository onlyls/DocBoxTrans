import { config, homepage } from "../../package.json";
import { getString } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";
import { services } from "./services";

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
