import type { TranslateTask } from "../utils/task";
import { getString } from "../utils/locale";
import { primaryTranslateLabel } from "./translationActions";

export function primaryActionLabel(task: TranslateTask | undefined, count: number): string {
  return task?.status === "processing" ? getString("popup-cancel") : primaryTranslateLabel(count);
}

export function taskStatusText(task?: TranslateTask): string {
  if (!task) return "";
  if (task.status === "processing") return task.partialResult ? getString("status-translating") : "";
  if (task.status === "cancelled") return task.partialResult ? getString("status-cancelled-partial") : "";
  if (task.status === "fail") return task.partialResult ? task.error || getString("status-request-error") : "";
  return "";
}
