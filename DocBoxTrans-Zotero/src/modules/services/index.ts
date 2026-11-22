import type { TranslateService } from "./base";
import { getString } from "../../utils/locale";
import { createLlmService } from "./llm";
import { GoogleService } from "./google";
import { BingService } from "./bing";
import { TencentService } from "./tencent";
import { YoudaoService } from "./youdao";
import { CnkiService } from "./cnki";
import { readServiceConfig, visibleServiceIds } from "../serviceConfig";

/** 服务注册表（顺序即弹窗/偏好里的展示顺序）。 */
const register: TranslateService[] = [
  GoogleService,
  BingService,
  TencentService,
  YoudaoService,
  CnkiService,
];

class TranslationServices {
  getById(id: string): TranslateService | undefined {
    const profile = readServiceConfig().profiles.find(p => p.id === id);
    return profile ? createLlmService(profile) : register.find(s => s.id === id);
  }

  getAll(): TranslateService[] {
    return [...readServiceConfig().profiles.map(createLlmService), ...register];
  }

  getVisible(): TranslateService[] {
    const visible = visibleServiceIds();
    return this.getAll().filter(s => visible.includes(s.id));
  }

  /** 服务 id -> 本地化展示名（如 service-llm → 大模型）。 */
  getDisplayName(id: string): string {
    const data = readServiceConfig();
    const profile = data.profiles.find(p => p.id === id);
    if (profile) return profile.name;
    if (Object.prototype.hasOwnProperty.call(data.deletedNames, id)) return data.deletedNames[id];
    return register.some(s => s.id === id) ? getString(`service-${id}`) : id;
  }
}

export const services = new TranslationServices();
