import { TranslateError } from "./base";
import { getString } from "../../utils/locale";

/** 增量解析 Chat Completions SSE，忽略推理字段，只输出可见译文。 */
export class ChatCompletionStream {
  private pending = "";
  private data: string[] = [];
  private text = "";
  private done = false;
  private finishReason: string | null = null;
  private atStart = true;

  constructor(private onProgress: (text: string) => void) {}

  feed(chunk: string): void {
    if (!chunk) return;
    if (this.atStart) { chunk = chunk.replace(/^\uFEFF/, ""); this.atStart = false; }
    this.pending += chunk;
    let end: number;
    while ((end = this.pending.search(/[\r\n]/)) >= 0) {
      if (this.pending[end] === "\r" && end === this.pending.length - 1) break;
      const line = this.pending.slice(0, end);
      const separator = this.pending.slice(end, end + 2) === "\r\n" ? 2 : 1;
      this.pending = this.pending.slice(end + separator);
      this.line(line);
    }
  }

  finish(): string {
    if (this.pending) this.line(this.pending.replace(/\r$/, ""));
    this.pending = "";
    this.dispatch();
    if (!this.done && !this.finishReason) throw new TranslateError(getString("status-stream-incomplete"));
    if (this.finishReason && this.finishReason !== "stop") {
      throw new TranslateError(getString("status-stream-incomplete"));
    }
    return this.text;
  }

  private line(line: string): void {
    if (!line) { this.dispatch(); return; }
    if (line.startsWith("data:")) this.data.push(line.slice(5).replace(/^ /, ""));
  }

  private dispatch(): void {
    if (!this.data.length) return;
    const data = this.data.join("\n"); this.data = [];
    if (this.done) return;
    if (data.trim() === "[DONE]") { this.done = true; return; }
    let event: any;
    try { event = JSON.parse(data); } catch {
      throw new TranslateError(getString("status-stream-invalid"));
    }
    if (event?.error) throw new TranslateError(String(event.error.message || getString("status-stream-invalid")));
    const choice = event?.choices?.find((value: any) => value.index == null || value.index === 0);
    if (!choice) return; // 用量统计、心跳或空 choices。
    const content = choice.delta?.content;
    if (typeof content === "string" && content) {
      this.text += content;
      this.onProgress(this.text);
    }
    if (choice.finish_reason != null) this.finishReason = String(choice.finish_reason);
  }
}
