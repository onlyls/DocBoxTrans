import { config } from "../package.json";
import hooks from "./hooks";
import { createZToolkit } from "./utils/ztoolkit";
import type { TranslateTask } from "./utils/task";

class Addon {
  public data: {
    config: typeof config;
    alive: boolean;
    env: "development" | "production";
    ztoolkit: ZToolkit;
    locale: { current?: any };
    prefs: { window: Window | null };
    translate: { queue: TranslateTask[] };
  };
  public hooks: typeof hooks;

  constructor() {
    this.data = {
      config,
      alive: true,
      env: __env__,
      ztoolkit: createZToolkit(),
      locale: {},
      prefs: { window: null },
      translate: { queue: [] },
    };
    this.hooks = hooks;
  }
}

export default Addon;
