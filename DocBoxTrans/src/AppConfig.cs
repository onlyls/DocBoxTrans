using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;

namespace DocBoxTrans
{
    /// <summary>
    /// INI 风格配置（仍兼容 # / ; 注释，但不再写注释）。
    /// 首次运行自动生成一份不含注释的默认配置——各项含义与取值说明见配置界面 DocBoxTransConfig.exe。
    /// </summary>
    class AppConfig
    {
        public string Hotkey = "Alt+Q";
        public string HotkeyClipboard = "Alt+Shift+Q";
        // 暂存当前选中内容（与划词工具条的「存」等价）；留空 = 不注册
        public string HotkeyStash = "Alt+S";
        public bool OnlyInDocBox = true;
        public string DocBoxProcess = "DocBox";
        public bool UseSelection = true;
        public bool RestoreClipboard = false;
        public bool FallbackToClipboard = true;
        public int ClipboardWaitMs = 800;

        // ---- 与稻壳阅读器的联动生命周期 ----
        public bool ExitWithDocBox = true;
        public int LifecycleCheckMs = 1500;

        public string ApiBase = "https://api.deepseek.com/v1";
        public string ApiPath = "/chat/completions";
        public string ApiKey = "";
        public string Model = "deepseek-chat";
        public double Temperature = 0.2;
        public int TimeoutSeconds = 30;
        public string SystemPrompt = "你是专业的翻译引擎。把用户提供的文本翻译成简体中文，只输出译文本身，不要任何解释、标注或原文。保留原有的换行和标点结构。";
        public int MaxChars = 4000;

        public int PopupWidth = 460;
        public int FontSize = 12;
        public int AutoCloseSeconds = 0;   // 0 = 不自动关闭
        public bool DarkTheme = true;

        // ---- 取词后清理剪贴板 ----
        // 1 = 取词后清除本次写入剪贴板的文本（保持剪贴板干净）
        public bool ClearClipboardAfterCapture = true;

        // ---- 翻译前文本预处理 ----
        // 1 = 合并 PDF 取词产生的不合理换行（提升机翻质量）
        public bool PreprocessText = true;

        // ---- 划词工具条 ----
        public bool ToolbarEnable = true;
        public int ToolbarDragThreshold = 12;

        // ---- 翻译历史记录 ----
        public int HistoryMax = 500;                 // 历史记录保存上限（超出清理最旧）
        public int HistoryWidth = 460;               // 历史窗口宽（用户调整后写回，下次复用）
        public int HistoryHeight = 560;              // 历史窗口高（用户调整后写回，下次复用）
        public string HistoryPos = "";               // 历史窗口位置（"x,y"；用户拖动后写回）；空=首次打开时居中

        // ---- 连续上下文增强翻译 ----
        public bool ContextEnable = false;           // 上下文增强开关（还需所选服务具备上下文能力才生效）
        public int ContextMaxItems = 4;              // 单次请求最多引用的历史条目数
        public int ContextMaxChars = 1500;           // 单次请求上下文（原文+译文）合计字符上限
        // 请求级复用：同原文 + 同引擎 + 同目标语言命中历史时直接返回旧译文，不重复发请求。
        // 启用「上下文增强翻译」且所选服务具备上下文能力时自动绕过（避免返回与上文不符的旧译文）。
        public bool ReuseTranslation = true;
        // 按「来源文档」隔离：取词时记录前台窗口的「进程名｜标题」作为文档身份，
        // 上下文参考与历史去重都限定在同一文档内，避免多篇文档互相串味/互相顶掉。
        public bool IsolateByOrigin = true;

        // ---- 翻译服务 ----
        public string Service = "llm";      // llm / google / bing / tencent / youdao / cnki
        // 弹窗底部胶囊行要显示的翻译服务（逗号分隔；顺序无关，显示顺序按 KnownServices）。
        // 留空 = 回退为全部。用户也可在弹窗左上角点按标题勾选调整。
        public string EnabledServices = "llm,google,bing,tencent,youdao,cnki";
        public string Proxy = "";           // 例：http://127.0.0.1:7890

        /// <summary>全部可用服务 id（顺序即弹窗底部胶囊的展示顺序）。</summary>
        public static readonly string[] KnownServices = new string[] { "llm", "google", "bing", "tencent", "youdao", "cnki" };
        public string TargetLang = "zh-CN";
        public string GoogleApi = "https://translate.googleapis.com/translate_a/single";
        // 备用谷歌端点（逗号分隔），主端点被限流(429)时轮换使用
        public string GoogleApiList = "https://clients5.google.com/translate_a/t";
        public string CnkiTokenUrl = "https://dict.cnki.net/fyzs-front-api/getToken";
        public string CnkiApi = "https://dict.cnki.net/fyzs-front-api/translate/literaltranslation";
        public int CnkiMaxChars = 500;
        // ---- 必应（免费）/ 腾讯交互（免费）/ 有道（需 key）----
        public string BingApi = "https://edge.microsoft.com/translate/translatetext";
        public string TencentApi = "https://transmart.qq.com/api/imt";
        public string YoudaoApi = "https://openapi.youdao.com/api";
        public string YoudaoAppKey = "";    // 有道智云「应用 ID」
        public string YoudaoSecret = "";    // 有道智云「应用密钥」
        // 有道翻译模式：auto = 跟随「上下文增强翻译」开关；text = 恒文本翻译；llm = 恒大模型翻译（需控制台开通）
        public string YoudaoMode = "auto";           // auto（跟随上下文开关）/ text（恒文本翻译）/ llm（恒大模型翻译）
        public string YoudaoLlmApi = "https://openapi.youdao.com/proxy/http/llm-trans";
        // 暂存与本次选中内容的拼接符；留空表示使用单个空格
        public string StashSeparator = " ";

        // ---- 本地 HTTP 接口（供稻壳等外部程序直接送文本）----
        public bool LocalEnable = false;
        public int LocalPort = 17635;
        public string LocalToken = "";

        public string Path;

        /// <summary>
        /// 「配置已改好，请重新加载」的跨进程通知事件名：配置界面（DocBoxTransConfig.exe）保存并正常退出后
        /// Set 该事件，翻译工具收到后立即重载配置。放在这里是因为两个 exe 都编译本文件，事件名天然共享。
        /// </summary>
        public const string ReloadEventName = "DocBoxTrans_ConfigReload";

        // 说明：这里刻意不带注释，保持配置文件简洁；各项含义与取值见配置界面（DocBoxTransConfig.exe）。
        static readonly string Defaults =
@"service=llm
enabled_services=llm,google,bing,tencent,youdao,cnki
proxy=
target_lang=zh-CN
google_api=https://translate.googleapis.com/translate_a/single
google_api_list=https://clients5.google.com/translate_a/t
cnki_token_url=https://dict.cnki.net/fyzs-front-api/getToken
cnki_api=https://dict.cnki.net/fyzs-front-api/translate/literaltranslation
cnki_max_chars=500
bing_api=https://edge.microsoft.com/translate/translatetext
tencent_api=https://transmart.qq.com/api/imt
youdao_api=https://openapi.youdao.com/api
youdao_appkey=
youdao_secret=
youdao_mode=auto
youdao_llm_api=https://openapi.youdao.com/proxy/http/llm-trans

api_base=https://api.deepseek.com/v1
api_path=/chat/completions
api_key=
model=deepseek-chat
temperature=0.2
timeout_seconds=30
max_chars=4000
system_prompt=你是专业的翻译引擎。把用户提供的文本翻译成简体中文，只输出译文本身，不要任何解释、标注或原文。保留原有的换行和标点结构。

hotkey=Alt+Q
hotkey_clipboard=Alt+Shift+Q
hotkey_stash=Alt+S
only_in_docbox=1
docbox_process=DocBox

use_selection=1
restore_clipboard=0
fallback_to_clipboard=1
clipboard_wait_ms=800
clear_clipboard_after_capture=1
preprocess_text=1

toolbar_enable=1
toolbar_drag_threshold=12

history_max=500
history_width=460
history_height=560
history_pos=
context_enable=0
context_max_items=4
context_max_chars=1500
reuse_translation=1
isolate_by_origin=1

popup_width=460
font_size=12
auto_close_seconds=0
dark_theme=1

local_enable=0
local_port=17635
local_token=

exit_with_docbox=1
lifecycle_check_ms=1500
stash_separator=
";

        public static AppConfig Load(string path)
        {
            AppConfig c = new AppConfig();
            c.Path = path;
            if (!File.Exists(path))
            {
                try { File.WriteAllText(path, Defaults, new UTF8Encoding(false)); } catch { }
            }

            Dictionary<string, string> map = new Dictionary<string, string>();
            ParseInto(map, path);
            // 主文件损坏/为空（如写入中断）时回退到备份
            if (map.Count == 0) ParseInto(map, path + ".bak");

            c.Hotkey = GetStr(map, "hotkey", c.Hotkey);
            c.HotkeyClipboard = GetStr(map, "hotkey_clipboard", c.HotkeyClipboard);
            c.HotkeyStash = GetStrAllowEmpty(map, "hotkey_stash", c.HotkeyStash);
            c.OnlyInDocBox = GetBool(map, "only_in_docbox", c.OnlyInDocBox);
            c.DocBoxProcess = GetStr(map, "docbox_process", c.DocBoxProcess);
            c.UseSelection = GetBool(map, "use_selection", c.UseSelection);
            c.RestoreClipboard = GetBool(map, "restore_clipboard", c.RestoreClipboard);
            c.FallbackToClipboard = GetBool(map, "fallback_to_clipboard", c.FallbackToClipboard);
            c.ClipboardWaitMs = GetInt(map, "clipboard_wait_ms", c.ClipboardWaitMs);
            c.ExitWithDocBox = GetBool(map, "exit_with_docbox", c.ExitWithDocBox);
            c.LifecycleCheckMs = GetInt(map, "lifecycle_check_ms", c.LifecycleCheckMs);

            c.ApiBase = GetStr(map, "api_base", c.ApiBase).TrimEnd('/');
            c.ApiPath = GetStr(map, "api_path", c.ApiPath);
            c.ApiKey = GetStr(map, "api_key", c.ApiKey);
            c.Model = GetStr(map, "model", c.Model);
            c.Temperature = GetDouble(map, "temperature", c.Temperature);
            c.TimeoutSeconds = GetInt(map, "timeout_seconds", c.TimeoutSeconds);
            c.SystemPrompt = GetStr(map, "system_prompt", c.SystemPrompt);
            c.MaxChars = GetInt(map, "max_chars", c.MaxChars);

            c.PopupWidth = GetInt(map, "popup_width", c.PopupWidth);
            c.FontSize = GetInt(map, "font_size", c.FontSize);
            c.AutoCloseSeconds = GetInt(map, "auto_close_seconds", c.AutoCloseSeconds);
            c.DarkTheme = GetBool(map, "dark_theme", c.DarkTheme);

            c.ClearClipboardAfterCapture = GetBool(map, "clear_clipboard_after_capture", c.ClearClipboardAfterCapture);
            c.PreprocessText = GetBool(map, "preprocess_text", c.PreprocessText);
            c.ToolbarEnable = GetBool(map, "toolbar_enable", c.ToolbarEnable);
            c.ToolbarDragThreshold = GetInt(map, "toolbar_drag_threshold", c.ToolbarDragThreshold);

            c.HistoryMax = GetInt(map, "history_max", c.HistoryMax);
            c.HistoryWidth = GetInt(map, "history_width", c.HistoryWidth);
            c.HistoryHeight = GetInt(map, "history_height", c.HistoryHeight);
            c.HistoryPos = GetStrAllowEmpty(map, "history_pos", c.HistoryPos);
            c.ContextEnable = GetBool(map, "context_enable", c.ContextEnable);
            c.ContextMaxItems = GetInt(map, "context_max_items", c.ContextMaxItems);
            c.ContextMaxChars = GetInt(map, "context_max_chars", c.ContextMaxChars);
            c.ReuseTranslation = GetBool(map, "reuse_translation", c.ReuseTranslation);
            c.IsolateByOrigin = GetBool(map, "isolate_by_origin", c.IsolateByOrigin);

            c.Service = GetStr(map, "service", c.Service).ToLowerInvariant();
            c.EnabledServices = GetStrAllowEmpty(map, "enabled_services", c.EnabledServices);
            c.Proxy = GetStr(map, "proxy", c.Proxy);
            c.TargetLang = GetStr(map, "target_lang", c.TargetLang);
            c.GoogleApi = GetStr(map, "google_api", c.GoogleApi);
            c.GoogleApiList = GetStrAllowEmpty(map, "google_api_list", c.GoogleApiList);
            c.CnkiTokenUrl = GetStr(map, "cnki_token_url", c.CnkiTokenUrl);
            c.CnkiApi = GetStr(map, "cnki_api", c.CnkiApi);
            c.CnkiMaxChars = GetInt(map, "cnki_max_chars", c.CnkiMaxChars);
            c.BingApi = GetStr(map, "bing_api", c.BingApi);
            c.TencentApi = GetStr(map, "tencent_api", c.TencentApi);
            c.YoudaoApi = GetStr(map, "youdao_api", c.YoudaoApi);
            c.YoudaoAppKey = GetStrAllowEmpty(map, "youdao_appkey", c.YoudaoAppKey);
            c.YoudaoSecret = GetStrAllowEmpty(map, "youdao_secret", c.YoudaoSecret);
            c.YoudaoMode = GetStr(map, "youdao_mode", c.YoudaoMode).ToLowerInvariant();
            c.YoudaoLlmApi = GetStr(map, "youdao_llm_api", c.YoudaoLlmApi);
            c.StashSeparator = GetStr(map, "stash_separator", c.StashSeparator);
            c.LocalEnable = GetBool(map, "local_enable", c.LocalEnable);
            c.LocalPort = GetInt(map, "local_port", c.LocalPort);
            c.LocalToken = GetStrAllowEmpty(map, "local_token", c.LocalToken);
            return c;
        }

        /// <summary>把某个键写回配置文件（命中则整行替换，否则追加）。用于在弹窗里切换服务后持久化。</summary>
        public static void SetValue(string path, string key, string value)
        {
            try
            {
                List<string> lines = new List<string>();
                if (File.Exists(path)) lines.AddRange(File.ReadAllLines(path, Encoding.UTF8));

                bool found = false;
                for (int i = 0; i < lines.Count; i++)
                {
                    string line = lines[i];
                    if (line.Length > 0 && line[0] == '\uFEFF') line = line.Substring(1);
                    string t = line.TrimStart();
                    if (t.Length == 0 || t[0] == '#' || t[0] == ';') continue;
                    int eq = line.IndexOf('=');
                    if (eq <= 0) continue;
                    if (string.Equals(line.Substring(0, eq).Trim(), key, StringComparison.OrdinalIgnoreCase))
                    {
                        lines[i] = key + "=" + value;
                        found = true;
                        break;
                    }
                }
                if (!found) lines.Add(key + "=" + value);
                WriteAtomic(path, lines.ToArray());
            }
            catch { }
        }

        /// <summary>读取配置文件里的原始键值（跳过注释与空行），供配置界面展示。</summary>
        public static Dictionary<string, string> ReadRaw(string path)
        {
            Dictionary<string, string> map = new Dictionary<string, string>();
            ParseInto(map, path);
            return map;
        }

        /// <summary>内置默认值表（解析 Defaults 模板）：配置界面用它展示文件中缺失的键。</summary>
        public static Dictionary<string, string> DefaultsMap()
        {
            Dictionary<string, string> map = new Dictionary<string, string>();
            ParseLines(map, Defaults.Replace("\r\n", "\n").Split('\n'));
            return map;
        }

        /// <summary>把配置文件解析进 map（跳过注释与空行，去掉 BOM）。</summary>
        static void ParseInto(Dictionary<string, string> map, string file)
        {
            if (!File.Exists(file)) return;
            ParseLines(map, File.ReadAllLines(file, Encoding.UTF8));
        }

        static void ParseLines(Dictionary<string, string> map, string[] rawLines)
        {
            for (int i = 0; i < rawLines.Length; i++)
            {
                string line = rawLines[i];
                if (line.Length > 0 && line[0] == '\uFEFF') line = line.Substring(1); // 去掉记事本可能写入的 BOM
                line = line.Trim();
                if (line.Length == 0 || line[0] == '#' || line[0] == ';') continue;
                int eq = line.IndexOf('=');
                if (eq <= 0) continue;
                map[line.Substring(0, eq).Trim().ToLowerInvariant()] = line.Substring(eq + 1).Trim();
            }
        }

        /// <summary>原子写文件：先写临时文件再 File.Replace 覆盖并保留 .bak，避免写到一半损坏配置。</summary>
        static void WriteAtomic(string path, string[] lines)
        {
            string tmp = path + ".tmp";
            File.WriteAllLines(tmp, lines, new UTF8Encoding(false));
            if (File.Exists(path)) File.Replace(tmp, path, path + ".bak");
            else File.Move(tmp, path);
        }

        public string Endpoint()
        {
            string b = ApiBase.TrimEnd('/');
            string p = ApiPath;
            if (p.Length == 0) p = "/chat/completions";
            if (p[0] != '/') p = "/" + p;
            return b + p;
        }

        /// <summary>
        /// 解析 <see cref="EnabledServices"/> 为弹窗底部要显示的服务 id 列表：
        /// 只保留已知服务并按 <see cref="KnownServices"/> 的顺序输出，保证胶囊顺序稳定；
        /// 全部无效/留空时回退为全部服务（底部至少有一个可切换的入口）。
        /// </summary>
        public string[] EnabledServiceList()
        {
            List<string> list = new List<string>();
            string[] parts = (EnabledServices ?? "").Split(new char[] { ',', ';', '|', ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
            for (int i = 0; i < KnownServices.Length; i++)
            {
                for (int j = 0; j < parts.Length; j++)
                {
                    if (string.Equals(parts[j].Trim(), KnownServices[i], StringComparison.OrdinalIgnoreCase))
                    {
                        list.Add(KnownServices[i]);
                        break;
                    }
                }
            }
            if (list.Count == 0) list.AddRange(KnownServices);
            return list.ToArray();
        }

        static string GetStr(Dictionary<string, string> m, string k, string d)
        {
            string v;
            if (m.TryGetValue(k, out v) && v.Length > 0) return v;
            return d;
        }

        /// <summary>与 GetStr 类似，但允许显式留空（空值即“关闭该项”）。</summary>
        static string GetStrAllowEmpty(Dictionary<string, string> m, string k, string d)
        {
            string v;
            if (m.TryGetValue(k, out v)) return v;
            return d;
        }

        static bool GetBool(Dictionary<string, string> m, string k, bool d)
        {
            string v;
            if (!m.TryGetValue(k, out v)) return d;
            v = v.Trim().ToLowerInvariant();
            if (v == "1" || v == "true" || v == "yes" || v == "on") return true;
            if (v == "0" || v == "false" || v == "no" || v == "off") return false;
            return d;
        }

        static int GetInt(Dictionary<string, string> m, string k, int d)
        {
            string v;
            int r;
            if (m.TryGetValue(k, out v) && int.TryParse(v, NumberStyles.Integer, CultureInfo.InvariantCulture, out r)) return r;
            return d;
        }

        static double GetDouble(Dictionary<string, string> m, string k, double d)
        {
            string v;
            double r;
            if (m.TryGetValue(k, out v) && double.TryParse(v, NumberStyles.Float, CultureInfo.InvariantCulture, out r)) return r;
            return d;
        }
    }
}