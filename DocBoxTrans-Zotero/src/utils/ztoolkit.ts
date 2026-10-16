import {
  BasicTool,
  UITool,
  ClipboardHelper,
  KeyboardManager,
  makeHelperTool,
  unregister,
} from "zotero-plugin-toolkit";
import { config } from "../../package.json";

export { createZToolkit };

function createZToolkit() {
  const _ztoolkit = new MyToolkit();
  initZToolkit(_ztoolkit);
  return _ztoolkit;
}

function initZToolkit(_ztoolkit: ReturnType<typeof createZToolkit>) {
  const env = __env__;
  _ztoolkit.basicOptions.log.prefix = `[${config.addonName}]`;
  _ztoolkit.basicOptions.log.disableConsole = env === "production";
  _ztoolkit.UI.basicOptions.ui.enableElementJSONLog = __env__ === "development";
  _ztoolkit.UI.basicOptions.ui.enableElementDOMLog = __env__ === "development";
  _ztoolkit.basicOptions.api.pluginID = config.addonID;
}

export class MyToolkit extends BasicTool {
  UI: UITool;
  Clipboard: typeof ClipboardHelper;
  Keyboard: KeyboardManager;

  constructor() {
    super();
    // 先写入插件 id，KeyboardManager 构造时会据此注册阅读器内的键盘监听
    this.basicOptions.api.pluginID = config.addonID;
    this.UI = new UITool(this);
    this.Clipboard = makeHelperTool(ClipboardHelper, this);
    this.Keyboard = new KeyboardManager(this);
  }

  unregisterAll() {
    unregister(this);
  }
}
