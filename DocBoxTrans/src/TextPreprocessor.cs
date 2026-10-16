using System;
using System.Collections.Generic;
using System.Text;

namespace DocBoxTrans
{
    /// <summary>
    /// 翻译前的文本预处理：把 PDF 复制/取词得到的文本里“不合理的换行”还原成正常的句子，
    /// 以提升机器翻译质量。只做保守处理——段落空行、句末标点、列表项等一律保留换行。
    ///
    /// 判定“该换行不合理、应合并”的核心条件（同时满足）：
    ///   1) 上一行末尾不是句末标点（. ! ? ; : 。！？；：… 等，允许被收尾引号/括号包裹）；
    ///   2) 下一行不是列表项（- * • 1. 1) （一） 等）；
    ///   3) 不是“上一行以小写字母结尾、下一行以大写字母开头”这种疑似新句子的情形。
    /// 合并时分隔符：中英文之间不加空格，纯拉丁文之间加一个空格；
    /// 上一行以连字符结尾且下一行以小写字母/数字开头时，视为断词，去掉连字符直接相连。
    /// </summary>
    static class TextPreprocessor
    {
        public static string Process(string text)
        {
            if (string.IsNullOrEmpty(text)) return text ?? "";

            string s = text.Replace("\r\n", "\n").Replace('\r', '\n');
            string[] raw = s.Split('\n');
            List<string> lines = new List<string>(raw.Length);
            for (int i = 0; i < raw.Length; i++) lines.Add(raw[i].Trim());

            StringBuilder sb = new StringBuilder(s.Length + 16);
            sb.Append(lines[0]);
            for (int i = 1; i < lines.Count; i++)
            {
                string prev = lines[i - 1];
                string cur = lines[i];

                if (prev.Length == 0 || cur.Length == 0 || !ShouldJoin(prev, cur))
                {
                    sb.Append('\n');
                    sb.Append(cur);
                    continue;
                }

                if (IsSoftHyphen(prev, cur))
                {
                    // 去掉已经写入的连字符，词内直接相连
                    if (sb.Length > 0 && sb[sb.Length - 1] == '-') sb.Remove(sb.Length - 1, 1);
                }
                else if (NeedsSpace(prev, cur))
                {
                    sb.Append(' ');
                }
                sb.Append(cur);
            }
            return sb.ToString().Trim();
        }

        static bool ShouldJoin(string prev, string cur)
        {
            if (EndsSentence(prev)) return false;                       // 句末标点 → 保留换行
            if (StartsWithListMarker(cur)) return false;                 // 列表项 → 保留换行
            if (IsUpperLatin(cur[0]) && IsLowerLatin(prev[prev.Length - 1])) return false; // 疑似新句子 → 保留
            return true;
        }

        /// <summary>上一行是否以句末标点收尾（跳过结尾的引号/括号后再判断）。</summary>
        static bool EndsSentence(string s)
        {
            int i = s.Length - 1;
            while (i >= 0 && IsClosingChar(s[i])) i--;
            if (i < 0) return false;
            return IsSentencePunct(s[i]);
        }

        static bool IsSentencePunct(char c)
        {
            switch (c)
            {
                case '.': case '!': case '?': case ';': case ':':
                case '。': case '！': case '？': case '；': case '：':
                case '…': case '．':
                    return true;
                default:
                    return false;
            }
        }

        static bool IsClosingChar(char c)
        {
            switch (c)
            {
                case '"': case '\'': case ')': case ']': case '}':
                case '”': case '’': case '）': case '】': case '》': case '」': case '』': case '〕': case '〉':
                    return true;
                default:
                    return false;
            }
        }

        static bool StartsWithListMarker(string s)
        {
            if (s.Length == 0) return false;
            char c0 = s[0];
            if ("•·○●▪◦‣∙■□◆◇".IndexOf(c0) >= 0) return true;
            if (c0 == '-' || c0 == '*' || c0 == '+')
                return s.Length > 1 && (s[1] == ' ' || s[1] == '\t');

            int i = (c0 == '(' || c0 == '（' || c0 == '【') ? 1 : 0;
            if (i >= s.Length) return false;

            // 数字编号：1. 1) 1、 （1）
            int j = i;
            while (j < s.Length && char.IsDigit(s[j])) j++;
            if (j > i && j < s.Length && ".．)、）:：".IndexOf(s[j]) >= 0) return true;

            // 字母编号：a) A.
            if (IsUpperLatin(s[i]) && i + 1 < s.Length && (s[i + 1] == ')' || s[i + 1] == '.' || s[i + 1] == '）')) return true;

            // 中文数字：一、 二.
            if ("一二三四五六七八九十".IndexOf(s[i]) >= 0 && i + 1 < s.Length && "、.．）)".IndexOf(s[i + 1]) >= 0) return true;

            return false;
        }

        /// <summary>上一行以连字符结尾、下一行以小写字母或数字开头 → 断词。</summary>
        static bool IsSoftHyphen(string prev, string cur)
        {
            if (prev.Length == 0 || prev[prev.Length - 1] != '-') return false;
            if (cur.Length == 0) return false;
            char c = cur[0];
            return IsLowerLatin(c) || char.IsDigit(c);
        }

        static bool NeedsSpace(string prev, string cur)
        {
            char a = prev[prev.Length - 1];
            char b = cur[0];
            if (IsCjk(a) || IsCjk(b)) return false; // 中文等无需空格
            return true;
        }

        static bool IsUpperLatin(char c) { return c >= 'A' && c <= 'Z'; }
        static bool IsLowerLatin(char c) { return c >= 'a' && c <= 'z'; }

        static bool IsCjk(char c)
        {
            return (c >= 0x2E80 && c <= 0x9FFF)
                || (c >= 0xF900 && c <= 0xFAFF)
                || (c >= 0xFF00 && c <= 0xFFEF)
                || (c >= 0x3000 && c <= 0x303F);
        }
    }
}
