import { config } from "../../package.json";

export { initLocale, getString, getLocaleID };

/** 初始化本地化数据（读取 `${addonRef}-addon.ftl`）。 */
function initLocale() {
  const l10n = new (
    typeof Localization === "undefined"
      ? ztoolkit.getGlobal("Localization")
      : Localization
  )([`${config.addonRef}-addon.ftl`], true);
  addon.data.locale = {
    current: l10n,
  };
}

/**
 * 从 addon.ftl 取一条文案。缺省时回退为 `${addonRef}-${id}`。
 * @example getString("service-llm")
 */
function getString(id: string, options: { args?: Record<string, unknown> } = {}): string {
  const localStringWithPrefix = `${config.addonRef}-${id}`;
  const pattern = addon.data.locale?.current.formatMessagesSync([
    { id: localStringWithPrefix, args: options.args },
  ])[0];
  if (!pattern) {
    return localStringWithPrefix;
  }
  return pattern.value || localStringWithPrefix;
}

/** 适用于 data-l10n-id 的完整消息 id（供 ItemPaneManager 等需要 l10nID 的 API 使用）。 */
function getLocaleID(id: string): string {
  return `${config.addonRef}-${id}`;
}
