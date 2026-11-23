pref("__prefsPrefix__.enableAuto", true);
pref("__prefsPrefix__.enablePopup", true);
pref("__prefsPrefix__.translateSource", "llm");
pref("__prefsPrefix__.targetLanguage", "zh-CN");
pref("__prefsPrefix__.fontSize", "12");
pref("__prefsPrefix__.showServiceSelector", true);
// Versioned model profiles, visible service IDs and deleted service names.
pref("__prefsPrefix__.services.config", "");

pref("__prefsPrefix__.reuseTranslation", true);
pref("__prefsPrefix__.preprocessText", true);
pref("__prefsPrefix__.llm.stream", true);

pref("__prefsPrefix__.contextEnable", false);
pref("__prefsPrefix__.contextMaxItems", 4);
pref("__prefsPrefix__.contextMaxChars", 1500);

pref("__prefsPrefix__.combineAddShortcut", "Alt+Shift+A");
pref("__prefsPrefix__.combineTranslateShortcut", "Alt+Shift+S");

pref("__prefsPrefix__.llm.endpoint", "https://api.deepseek.com/v1/chat/completions");
pref("__prefsPrefix__.llm.apiKey", "");
pref("__prefsPrefix__.llm.model", "deepseek-chat");
pref("__prefsPrefix__.llm.temperature", "0.2");
pref(
  "__prefsPrefix__.llm.systemPrompt",
  "你是面向各学科的专业学术翻译助手。请将用户提供的文本准确、完整地翻译成{targetLanguage}。根据原文及上下文判断所属领域，使用该领域通行的术语，保持术语、缩写与表达一致，不预设学科背景。忠实保留原文的含义、逻辑、语气及不确定性，不增删信息，不补充解释或推测。保留原有段落、换行、列表、公式、符号、数值、单位及引用标记；专有名词和缩写按通行译法处理，必要时保留原文。只输出译文本身，不要添加说明、标题、标注或重复原文。",
);

pref("__prefsPrefix__.youdao.appKey", "");
pref("__prefsPrefix__.youdao.secret", "");
pref("__prefsPrefix__.youdao.mode", "auto");

pref("__prefsPrefix__.bing.endpoint", "");
pref("__prefsPrefix__.google.endpoint", "");
pref("__prefsPrefix__.google.proxy", "");
pref("__prefsPrefix__.tencent.endpoint", "");
pref("__prefsPrefix__.cnki.tokenUrl", "");
pref("__prefsPrefix__.cnki.api", "");
pref("__prefsPrefix__.cnki.maxChars", 500);
