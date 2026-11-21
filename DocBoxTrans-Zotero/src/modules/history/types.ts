/** 面板排序方式（各面板共享）：time=按翻译时间（最新在前，默认）；source=按原文前后顺序。 */
type SortMode = "time" | "source";

/** 面板过滤范围：file=仅单个附件（阅读器），item=整篇文献（含各附件）。 */
type ScopeKind = "file" | "item";

interface PaneScope {
  kind: ScopeKind;
  id?: number;
}

/** 本面板的筛选关键词/标签（按 root 隔离，不跨面板共享）。 */
interface PaneFilter {
  text: string;
  tag: string;
}

export type { SortMode, ScopeKind, PaneScope, PaneFilter };
