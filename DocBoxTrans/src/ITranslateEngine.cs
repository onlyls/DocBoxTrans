using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace DocBoxTrans
{
    /// <summary>
    /// 翻译引擎统一接口。每个引擎一个实现类（见 LlmEngine / GoogleEngine / CnkiEngine），
    /// 由 <see cref="Translator"/> 按 config.ini 的 service 分派。
    /// 约定：TranslateAsync 为异步；统一返回 <see cref="TranslateResult"/>（成功为译文、失败为错误提示），
    /// 不抛异常（超时/取消除外），由调用方按 Success 判定成败，不再嗅探字符串前缀。
    /// </summary>
    interface ITranslateEngine
    {
        /// <summary>服务 id（对应 config.ini 的 service，如 llm / google / cnki）。</summary>
        string Id { get; }

        /// <summary>界面展示名（如「大模型」「谷歌」「知网」）。</summary>
        string DisplayName { get; }

        /// <summary>
        /// 在给定配置下，该引擎是否具备上下文能力（把此前的成功翻译作为参考）。
        /// 参数为 cfg，因为能力可能取决于配置（如有道的 auto 模式就是跟随「上下文增强翻译」开关）。
        /// 注意：这只是必要条件，是否真正携带上下文还取决于用户是否在托盘菜单勾选了「上下文增强翻译」。
        /// </summary>
        bool SupportsContext(AppConfig cfg);

        /// <summary>翻译给定文本，返回 <see cref="TranslateResult"/>（成功为译文，失败为错误提示）。</summary>
        Task<TranslateResult> TranslateAsync(AppConfig cfg, string text, CancellationToken ct);

        /// <summary>
        /// 带上下文参考的翻译。不支持上下文的引擎应忽略 context，等价于普通翻译。
        /// context 为「旧 → 新」的成功翻译配对，仅用于统一术语与表达，不作为待翻译内容。
        /// </summary>
        Task<TranslateResult> TranslateAsync(AppConfig cfg, string text, IList<HistoryRecord> context, CancellationToken ct);
    }
}