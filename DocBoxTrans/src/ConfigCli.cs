using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading;

namespace DocBoxTrans
{
    /// <summary>
    /// 命令行配置界面（独立的 DocBoxTransConfig.exe，控制台程序）：
    /// 按分组列出 config.ini 的全部配置项、当前值与取值说明，选中某项即可行内修改并立即写回文件。
    /// config.ini 因此不再需要注释——所有说明都内置在这里（AppConfig.Defaults 也只保留 key=value）。
    /// </summary>
    static class ConfigCli
    {
        // 配置项类型：s=字符串，b=开关(1/0)，i=整数，f=小数，e=枚举，x=密钥/令牌（列表中不回显明文）
        const string KStr = "s";
        const string KBool = "b";
        const string KInt = "i";
        const string KNum = "f";
        const string KEnum = "e";
        const string KSecret = "x";

        sealed class Item
        {
            public readonly string Key;
            public readonly string Label;
            public readonly string Desc;
            public readonly string Kind;
            public readonly string[] Options;

            public Item(string key, string label, string desc, string kind)
            {
                Key = key; Label = label; Desc = desc; Kind = kind; Options = null;
            }

            public Item(string key, string label, string desc, string kind, string[] options)
            {
                Key = key; Label = label; Desc = desc; Kind = kind; Options = options;
            }
        }

        sealed class Group
        {
            public readonly string Title;
            public readonly Item[] Items;
            public Group(string title, Item[] items) { Title = title; Items = items; }
        }

        static readonly Group[] Groups = new Group[]
        {
            new Group("翻译服务与密钥", new Item[]
            {
                new Item("service", "使用的翻译服务", "llm=大模型 / google=谷歌 / bing=必应 / tencent=腾讯交互 / youdao=有道 / cnki=知网", KEnum,
                    new string[] { "llm", "google", "bing", "tencent", "youdao", "cnki" }),
                new Item("enabled_services", "浮窗显示的服务", "弹窗底部胶囊行要显示的服务，逗号分隔（例 llm,youdao）；留空=全部。也可在弹窗左上角点按标题勾选调整", KStr),
                new Item("proxy", "代理地址", "例 http://127.0.0.1:7890；留空=不使用代理。谷歌与必应通常需要代理", KStr),
                new Item("target_lang", "目标语言", "例 zh-CN（简体）/ zh-TW（繁体）/ en / ja", KStr),
                new Item("google_api", "谷歌接口地址", "谷歌免费翻译接口", KStr),
                new Item("google_api_list", "谷歌备用端点", "逗号分隔；主端点被限流(429)时自动轮换。留空=只用主端点", KStr),
                new Item("bing_api", "必应翻译地址", "必应翻译接口（免费，匿名签名鉴权，国内通常需代理）", KStr),
                new Item("tencent_api", "腾讯翻译地址", "腾讯交互翻译接口（免费，国内直连，无需 key）", KStr),
                new Item("cnki_token_url", "知网取令牌地址", "知网取会话令牌的地址", KStr),
                new Item("cnki_api", "知网翻译地址", "知网学术翻译接口", KStr),
                new Item("cnki_max_chars", "知网单次字符上限", "超出后自动分批", KInt),
                new Item("youdao_api", "有道文本翻译地址", "有道智云文本翻译接口", KStr),
                new Item("youdao_appkey", "有道应用 ID", "在 https://ai.youdao.com 控制台创建应用后获取", KSecret),
                new Item("youdao_secret", "有道应用密钥", "与上者配套，用于 v3 签名", KSecret),
                new Item("youdao_mode", "有道接口模式", "auto=跟随「上下文增强翻译」开关（勾选且已填 key 才用大模型翻译）；text=恒文本翻译（纯机翻）；llm=恒大模型翻译（需在控制台开通该服务，否则报错误码 110）", KEnum,
                    new string[] { "auto", "text", "llm" }),
                new Item("youdao_llm_api", "有道大模型翻译地址", "有道大模型翻译接口（支持 prompt 上下文）", KStr),
            }),
            new Group("大模型接口（OpenAI 兼容）", new Item[]
            {
                new Item("api_base", "接口根地址", "例 DeepSeek https://api.deepseek.com/v1；通义 https://dashscope.aliyuncs.com/compatible-mode/v1；本地 Ollama http://127.0.0.1:11434/v1", KStr),
                new Item("api_path", "接口路径", "留空= /chat/completions", KStr),
                new Item("api_key", "接口密钥", "不填则大模型翻译不可用", KSecret),
                new Item("model", "模型名", "例 deepseek-chat", KStr),
                new Item("temperature", "温度", "0.0 ~ 2.0，翻译建议 0.2 左右（越小越稳定）", KNum),
                new Item("timeout_seconds", "请求超时", "单次请求超时（秒）", KInt),
                new Item("max_chars", "单次字符上限", "超出后自动分批送翻", KInt),
                new Item("system_prompt", "系统提示词", "原样写入请求的 system 内容，用于约束译文风格", KStr),
            }),
            new Group("热键与触发范围", new Item[]
            {
                new Item("hotkey", "划词翻译热键", "会先模拟 Ctrl+C 取词。修饰键支持 Alt/Ctrl/Shift/Win，可组合，例 Ctrl+Alt+T", KStr),
                new Item("hotkey_clipboard", "翻译剪贴板热键", "直接翻译剪贴板里的内容", KStr),
                new Item("hotkey_stash", "暂存热键", "暂存当前选中内容（等价于工具条的「存」）。留空=不注册", KStr),
                new Item("only_in_docbox", "仅目标程序内生效", "1=热键只在 docbox_process 为前台窗口时响应（不占用系统快捷键）；0=任意窗口生效（会占用该组合键）", KBool),
                new Item("docbox_process", "目标进程名", "不带 .exe，例 DocBox", KStr),
            }),
            new Group("取词与预处理", new Item[]
            {
                new Item("use_selection", "优先取选中文字", "1=模拟 Ctrl+C 取当前选中内容；0=只取剪贴板", KBool),
                new Item("restore_clipboard", "取词后恢复剪贴板", "1=恢复原有内容；0=保留选中的文字", KBool),
                new Item("fallback_to_clipboard", "退用剪贴板", "取不到新内容时，是否退而使用剪贴板里已有的文字", KBool),
                new Item("clipboard_wait_ms", "等待剪贴板毫秒", "发送 Ctrl+C 后等待剪贴板更新的最长时间（毫秒）", KInt),
                new Item("clear_clipboard_after_capture", "取词后清空剪贴板", "1=清除本次写入的文本，保持剪贴板干净（restore_clipboard=1 时以恢复旧内容优先）", KBool),
                new Item("preprocess_text", "合并 PDF 不合理换行", "1=上一行末尾非句末标点且属同一句时并成一行，提升机翻质量；0=原样翻译", KBool),
            }),
            new Group("划词工具条", new Item[]
            {
                new Item("toolbar_enable", "启用划词工具条", "1=划词拖选后在光标旁弹出「译 / 存」工具条", KBool),
                new Item("toolbar_drag_threshold", "拖选判定像素", "判定为「拖选」的最小鼠标移动像素", KInt),
            }),
            new Group("历史记录与上下文", new Item[]
            {
                new Item("history_max", "历史保存上限", "超出后按时间清理最旧的记录", KInt),
                new Item("history_width", "历史窗口宽", "拖拽调整后自动写回（像素）", KInt),
                new Item("history_height", "历史窗口高", "拖拽调整后自动写回（像素）", KInt),
                new Item("history_pos", "历史窗口位置", "拖拽移动后自动写回（格式 x,y）；留空=首次打开时居中", KStr),
                new Item("context_enable", "上下文增强翻译", "1=把此前成功翻译作为后续翻译的参考。需与「具备上下文能力的服务」同时满足：大模型恒具备；有道 auto 模式随此开关（llm 模式恒生效）", KBool),
                new Item("context_max_items", "最多引用条目数", "单次请求最多引用多少条历史译文", KInt),
                new Item("context_max_chars", "上下文合计字符上限", "单次请求上下文（原文+译文）合计字符上限", KInt),
                new Item("reuse_translation", "复用历史译文", "1=相同原文+同引擎+同目标语言命中历史时直接复用，不重复发请求；开启「上下文增强翻译」时自动绕过，避免返回与上文不符的旧译文", KBool),
                new Item("isolate_by_origin", "按文档隔离", "1=按「来源文档（进程名+窗口标题）」隔离上下文与历史去重，避免多篇文档互相串味/互相顶掉；0=沿用全局（与旧版行为一致）。历史面板始终按当前文档展示", KBool),
            }),
            new Group("浮窗外观", new Item[]
            {
                new Item("popup_width", "浮窗宽度", "翻译结果浮窗宽度（像素）", KInt),
                new Item("font_size", "译文字号", "浮窗里译文的字号", KInt),
                new Item("auto_close_seconds", "自动关闭秒数", "多少秒后自动关闭，0=不自动关闭", KInt),
                new Item("dark_theme", "深色主题", "1=深色；0=浅色", KBool),
            }),
            new Group("本地 HTTP 接口", new Item[]
            {
                new Item("local_enable", "启用本地接口", "1=开启（仅监听 127.0.0.1，不对外网开放），供稻壳等外部程序直接送文本翻译", KBool),
                new Item("local_port", "监听端口", "默认 17635", KInt),
                new Item("local_token", "访问令牌", "非空时请求需带请求头 X-DocBox-Token: <令牌>；留空=不校验", KSecret),
            }),
            new Group("生命周期与暂存", new Item[]
            {
                new Item("exit_with_docbox", "稻壳关闭后退出", "1=稻壳关闭后本工具自动退出（配合守卫进程）；若本工具是手动打开且稻壳从未启动过则不会退出", KBool),
                new Item("lifecycle_check_ms", "稻壳检测间隔", "检查稻壳是否在运行的间隔（毫秒）", KInt),
                new Item("stash_separator", "暂存拼接符", "暂存文本与本次选中内容的拼接符；留空=单个空格", KStr),
            }),
        };

        static string path;
        static Dictionary<string, string> current;    // 文件中已有的键值
        static Dictionary<string, string> defaults;   // 内置默认值（解析 AppConfig.Defaults）
        static bool running;                          // 翻译工具是否正在运行
        static int changedCount;

        public static int Run(string[] args)
        {
            path = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "config.ini");
            try { Console.OutputEncoding = Encoding.UTF8; }
            catch { }

            AppConfig.Load(path);                 // 文件不存在时先落一份默认配置
            defaults = AppConfig.DefaultsMap();
            Reload();
            running = IsCompanionRunning();

            Console.WriteLine();
            Console.WriteLine("DocBox 划词翻译 · 配置界面");
            Console.WriteLine("配置文件：" + path);
            if (running)
                Console.WriteLine("提示：翻译工具正在运行，退出配置界面后会自动通知它重新加载。");
            Console.WriteLine("------------------------------------------------------------");

            MainMenu();

            if (changedCount > 0)
            {
                Console.WriteLine();
                Console.WriteLine("本次共修改 " + changedCount + " 项，已写入 config.ini。");
                Console.WriteLine(NotifyReload()
                    ? "已通知翻译工具重新加载，改动立即生效。"
                    : "翻译工具未在运行，改动将在它下次启动时生效。");
            }
            Console.WriteLine("已退出配置界面。");
            return 0;
        }

        static void MainMenu()
        {
            while (true)
            {
                Console.WriteLine();
                for (int i = 0; i < Groups.Length; i++)
                    Console.WriteLine("  " + (i + 1).ToString(CultureInfo.InvariantCulture).PadLeft(2) +
                                      ") " + Pad(Groups[i].Title, 24) +
                                      "（" + Groups[i].Items.Length + " 项）");
                Console.WriteLine("   0) 退出");
                Console.Write("选择分组：");
                string s = Console.ReadLine();
                if (s == null) return;            // 输入流已耗尽（例如管道输入）
                s = s.Trim();
                if (s.Length == 0) continue;
                if (s == "0" || s.Equals("q", StringComparison.OrdinalIgnoreCase)) return;

                int n;
                if (int.TryParse(s, out n) && n >= 1 && n <= Groups.Length) { EditGroup(Groups[n - 1]); continue; }
                Console.WriteLine("无效输入：请输入分组编号（或 0 退出）。");
            }
        }

        static void EditGroup(Group g)
        {
            while (true)
            {
                Console.WriteLine();
                Console.WriteLine("[" + g.Title + "]");
                for (int i = 0; i < g.Items.Length; i++)
                {
                    Item it = g.Items[i];
                    Console.WriteLine("  " + (i + 1).ToString(CultureInfo.InvariantCulture).PadLeft(2) + "  " +
                                      Pad(it.Key, 28) + Pad(Show(it), 0));
                }
                Console.WriteLine("   0) 返回");
                Console.Write("修改哪一项（编号，回车=返回）：");
                string s = Console.ReadLine();
                if (s == null) return;
                s = s.Trim();
                if (s.Length == 0 || s == "0") return;

                int n;
                if (int.TryParse(s, out n) && n >= 1 && n <= g.Items.Length) { EditItem(g.Items[n - 1]); continue; }
                Console.WriteLine("无效输入：请输入列表里的编号。");
            }
        }

        static void EditItem(Item it)
        {
            string cur;
            bool fromFile = current.TryGetValue(it.Key, out cur);
            if (!fromFile && !defaults.TryGetValue(it.Key, out cur)) cur = "";

            Console.WriteLine();
            Console.WriteLine("· " + it.Label + "（" + it.Key + "）");
            Console.WriteLine("  " + it.Desc);
            if (!fromFile) Console.WriteLine("  当前文件中没有这个键，正按内置默认值运行。");
            if (it.Kind == KSecret)
                Console.WriteLine("  当前：" + (cur.Length == 0 ? "未设置" : "已设置（" + cur.Length + " 位，不回显）"));
            else
                Console.WriteLine("  当前：" + (cur.Length == 0 ? "（空）" : cur));
            if (it.Kind == KEnum) Console.WriteLine("  可选：" + string.Join(" / ", it.Options));
            if (it.Kind == KBool) Console.WriteLine("  可选：1=开 / 0=关（也接受 on/off、true/false、y/n、开/关）");
            if (it.Kind == KInt || it.Kind == KNum) Console.WriteLine("  只接受数值。");
            Console.Write("  新值（回车=不修改；输入 - 表示清空）：");

            string s = Console.ReadLine();
            if (s == null) return;
            s = s.Trim();
            if (s.Length == 0) { Console.WriteLine("  未修改。"); return; }
            if (s == "-") s = "";

            string norm;
            if (!Normalize(it, s, out norm)) return;

            AppConfig.SetValue(path, it.Key, norm);
            Reload();
            changedCount++;

            Console.WriteLine(it.Kind == KSecret
                ? "  已写入 config.ini：" + it.Key + "（值不回显）"
                : "  已写入 config.ini：" + it.Key + "=" + (norm.Length == 0 ? "（空）" : norm));
            if (running) Console.WriteLine("  提示：退出配置界面后会自动通知翻译工具重新加载。");
        }

        /// <summary>
        /// 通知正在运行的翻译工具重新加载配置（Set 双方约定的命名事件）；未在运行或通知失败返回 false。
        /// 事件由翻译工具创建，因此打不开就等于它没在运行。
        /// </summary>
        static bool NotifyReload()
        {
            try
            {
                using (EventWaitHandle ev = EventWaitHandle.OpenExisting(AppConfig.ReloadEventName))
                {
                    ev.Set();
                }
                return true;
            }
            catch (Exception) { return false; }
        }

        /// <summary>校验并归一化输入；不合法时打印原因并返回 false。</summary>
        static bool Normalize(Item it, string s, out string norm)
        {
            norm = s;

            if (it.Kind == KBool)
            {
                string low = s.ToLowerInvariant();
                if (low == "1" || low == "on" || low == "true" || low == "yes" || low == "y" || low == "开" || low == "是")
                { norm = "1"; return true; }
                if (low == "0" || low == "off" || low == "false" || low == "no" || low == "n" || low == "关" || low == "否")
                { norm = "0"; return true; }
                Console.WriteLine("  无效值：开关只能填 1 或 0。");
                return false;
            }

            if (it.Kind == KInt)
            {
                int n;
                if (!int.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out n) || n < 0)
                {
                    Console.WriteLine("  无效值：需要一个不小于 0 的整数。");
                    return false;
                }
                norm = n.ToString(CultureInfo.InvariantCulture);
                return true;
            }

            if (it.Kind == KNum)
            {
                double d;
                if (!double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out d))
                {
                    Console.WriteLine("  无效值：需要一个数字（小数点用 . ，例 0.2）。");
                    return false;
                }
                norm = d.ToString(CultureInfo.InvariantCulture);
                return true;
            }

            if (it.Kind == KEnum)
            {
                for (int i = 0; i < it.Options.Length; i++)
                    if (string.Equals(it.Options[i], s, StringComparison.OrdinalIgnoreCase)) { norm = it.Options[i]; return true; }
                Console.WriteLine("  无效值：只能填 " + string.Join(" / ", it.Options) + "。");
                return false;
            }

            return true;
        }

        /// <summary>列表里显示的值：文件值优先，缺失时显示内置默认值并标注；密钥类不回显明文。</summary>
        static string Show(Item it)
        {
            string v;
            bool fromFile = current.TryGetValue(it.Key, out v);
            if (!fromFile && !defaults.TryGetValue(it.Key, out v)) v = "";
            if (it.Kind == KSecret) return v.Length == 0 ? "（未设置）" : "（已设置 " + v.Length + " 位）";
            if (!fromFile) return (v.Length == 0 ? "（空）" : v) + "  [默认]";
            return v.Length == 0 ? "（空）" : v;
        }

        static void Reload()
        {
            try { current = AppConfig.ReadRaw(path); }
            catch { current = new Dictionary<string, string>(); }
        }

        /// <summary>翻译工具是否正在运行：它持有名为 DocBoxTrans_Companion 的互斥体（与 Lifecycle 中同名）。</summary>
        static bool IsCompanionRunning()
        {
            Mutex m = null;
            try
            {
                m = Mutex.OpenExisting("DocBoxTrans_Companion");
                return true;
            }
            catch { return false; }
            finally { if (m != null) m.Close(); }
        }

        /// <summary>按显示宽度右填充空格（中文等全角字符占 2 列），使列表对齐。</summary>
        static string Pad(string s, int width)
        {
            int w = DisplayWidth(s);
            if (w >= width) return s + "  ";
            return s + new string(' ', width - w);
        }

        static int DisplayWidth(string s)
        {
            int w = 0;
            for (int i = 0; i < s.Length; i++) w += s[i] >= 0x1100 ? 2 : 1;
            return w;
        }
    }
}
