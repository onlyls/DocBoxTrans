import type { HistoryRecord } from "../../utils/history";

export interface HistoryGroup {
  key: string;
  variants: HistoryRecord[];
}

/** 以附件和原文合并展示，保留传入顺序作为卡片与译文版本的默认顺序。 */
export function groupHistoryRecords(records: readonly HistoryRecord[]): HistoryGroup[] {
  const groups = new Map<string, HistoryGroup>();
  for (const record of records) {
    const key = JSON.stringify([record.itemId ?? null, record.sourceText]);
    let group = groups.get(key);
    if (!group) {
      group = { key, variants: [] };
      groups.set(key, group);
    }
    group.variants.push(record);
  }
  return [...groups.values()];
}
