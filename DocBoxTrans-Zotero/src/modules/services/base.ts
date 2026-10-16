import type { HistoryRecord } from "../../utils/history";
import type { TranslateTask } from "../../utils/task";

/**
 * 翻译错误：message 为「面向用户的完整提示」（如 [配置错误] ...），
 * runner 会原样作为 result 展示，不再二次包装。
 */
export class TranslateError extends Error {}

/**
 * 翻译服务统一接口（对应 DocBoxTrans 的 ITranslateEngine）。
 * 约定：translate 必须写入 data.result；失败时抛错（由 runner 统一包装成 [请求错误]）。
 */
export interface TranslateService {
  /** 服务 id：llm / google / bing / tencent / youdao / cnki。 */
  id: string;
  /** 服务类型，本插件当前只有整句翻译。 */
  type: "sentence";
  /**
   * 在给定配置下该服务是否具备上下文能力（把此前的成功翻译作为参考）。
   * 这只是必要条件，是否真正携带上下文还取决于用户是否勾选了「上下文增强翻译」。
   */
  supportsContext: () => boolean;
  /**
   * 翻译给定文本。context 为「旧 → 新」的成功翻译配对（仅用于统一术语与表达，不作为待翻译内容）；
   * 不支持上下文的服务应忽略它。
   */
  translate: (
    data: Required<TranslateTask>,
    context: HistoryRecord[],
  ) => Promise<void> | void;
}
