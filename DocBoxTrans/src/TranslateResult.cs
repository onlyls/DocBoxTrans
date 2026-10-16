namespace DocBoxTrans
{
    /// <summary>
    /// 翻译结果：成功时 <see cref="Text"/> 为译文，失败时 <see cref="Text"/> 为面向用户的错误提示。
    /// 取代旧的「以 '[' 开头即视为错误」的字符串约定——译文本身以 '[' 开头（如文献引用 [1]）时不再被误判，
    /// 由调用方按 <see cref="Success"/> 判定成败，而非嗅探文本前缀。
    /// </summary>
    sealed class TranslateResult
    {
        public readonly bool Success;
        public readonly string Text;

        TranslateResult(bool success, string text)
        {
            Success = success;
            Text = text ?? "";
        }

        /// <summary>成功：text 为译文。</summary>
        public static TranslateResult Ok(string text) { return new TranslateResult(true, text); }

        /// <summary>失败：message 为面向用户的错误提示。</summary>
        public static TranslateResult Err(string message) { return new TranslateResult(false, message); }
    }
}
