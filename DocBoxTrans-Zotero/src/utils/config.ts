/**
 * 各引擎共用的小工具（移植自 DocBoxTrans 的 TranslateSupport）。
 */

/**
 * 把 target_lang（如 zh-CN）映射到各引擎所需的目标语言代码。
 * zhCN / zhTW 为该引擎的简体、繁体代码；其它语言原样返回。
 */
export function mapTargetLang(lang: string, zhCN: string, zhTW: string): string {
  const t = (lang ?? "").trim();
  if (t.length === 0) return zhCN;
  const low = t.toLowerCase();
  if (
    low === "zh" ||
    low === "zh-cn" ||
    low === "zh-hans" ||
    low === "zh-chs" ||
    low === "zh_cn" ||
    low === "chinese" ||
    low === "zhongwen"
  )
    return zhCN;
  if (
    low === "zh-tw" ||
    low === "zh-hk" ||
    low === "zh-hant" ||
    low === "zh-cht" ||
    low === "zh_tw"
  )
    return zhTW;
  return t;
}

/** 按字符数把文本切成不超过 max 的若干块（部分接口有单次长度限制）。 */
export function splitChunks(text: string, max: number): string[] {
  const limited = Math.max(1, max);
  const list: string[] = [];
  for (let i = 0; i < text.length; i += limited) {
    list.push(text.slice(i, i + limited));
  }
  if (list.length === 0) list.push("");
  return list;
}
