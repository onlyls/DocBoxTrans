import type { TranslateService } from "./base";
import { getString } from "../../utils/locale";
import { LlmService } from "./llm";
import { GoogleService } from "./google";
import { BingService } from "./bing";
import { TencentService } from "./tencent";
import { YoudaoService } from "./youdao";
import { CnkiService } from "./cnki";

/** 服务注册表（顺序即弹窗/偏好里的展示顺序）。 */
const register: TranslateService[] = [
  LlmService,
  GoogleService,
  BingService,
  TencentService,
  YoudaoService,
  CnkiService,
];

class TranslationServices {
  private readonly list: TranslateService[] = [...register];

  getById(id: string): TranslateService | undefined {
    return this.list.find((s) => s.id === id);
  }

  getAll(): TranslateService[] {
    return [...this.list];
  }

  /** 服务 id -> 本地化展示名（如 service-llm → 大模型）。 */
  getDisplayName(id: string): string {
    return getString(`service-${id}`);
  }
}

export const services = new TranslationServices();
