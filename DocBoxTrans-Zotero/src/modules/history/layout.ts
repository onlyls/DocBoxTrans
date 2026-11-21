import { config } from "../../../package.json";

/**
 * 给「翻译记录」面板定高，使面板占满分区下方空白，并保持「顶栏/底栏固定、只有列表内部滚动」。
 *
 * 关键点：可用高度必须与「容器当前滚动位置」无关，否则当面板位于可视区下方时（条目面板里上方
 * 还有信息/摘要等分区，初始化滚动在顶部）会算出负数 → 不设高度 → 整块分区随容器滚动，顶栏/底栏
 * 全被滚走。这里改用 Zotero 自己也算的偏移：容器内容坐标系内的偏移 =
 * 面板顶部 − 容器顶部 + scrollTop，可用高度 = 容器可视高度 − 该偏移。
 */
function fitPaneHeight(root: HTMLElement) {
  const list = root.querySelector(
    `.${config.addonRef}-history-list`,
  ) as HTMLElement | null;
  if (!list) return;
  list.style.maxHeight = "";
  list.style.flex = "1 1 auto";
  // 「本次翻译结果」区：不参与收缩（flex:0 0 auto），高度只随文本自适应，
  // 上限取面板高度的 45%；超过上限时在该区内部滚动，避免长译文吃满整块面板
  const current = root.querySelector(
    `.${config.addonRef}-history-current`,
  ) as HTMLElement | null;
  const resetCurrent = () => {
    if (current) current.style.maxHeight = "";
  };
  try {
    const win = root.ownerGlobal as unknown as Window;
    const rect = root.getBoundingClientRect();
    // 未挂载 / 分区收起（未渲染）时 rect 全为 0：先清空高度约束，等下次重渲染/补算再定
    if (!root.isConnected || rect.height <= 0) {
      root.style.height = "";
      resetCurrent();
      return;
    }
    // 分区标题行的高度（退化为「占满整个容器」时需要扣除）
    const headH =
      (
        root
          .closest("item-pane-custom-section")
          ?.querySelector(".head") as HTMLElement | null
      )?.clientHeight ?? 0;

    let avail = 0;
    const view = findViewContainer(root);
    if (view && view.clientHeight > 0) {
      const viewRect = view.getBoundingClientRect();
      // 面板顶部在容器内容中的偏移（scrollTop 抵消，与当前滚动位置无关）
      const topInContent = rect.top - viewRect.top + view.scrollTop;
      avail = view.clientHeight - topInContent - 8;
      if (avail <= 0) {
        // 上方分区已占满容器（面板整块在可视区下方）：退化为「占满整个容器」的高度，
        // 仍保证顶栏/底栏固定、列表内部滚动
        avail = view.clientHeight - headH - 8;
      }
    } else {
      // 找不到容器时按窗口估算（阅读器侧栏一般能命中容器）
      avail = win.innerHeight - rect.top - headH - 8;
    }
    if (!Number.isFinite(avail) || avail <= 0) {
      // 容器尚未完成布局：清空约束，交给 scheduleFit 在布局稳定后补算
      root.style.height = "";
      resetCurrent();
      return;
    }
    const px = Math.max(160, Math.round(avail));
    root.style.height = `${px}px`;
    if (current) current.style.maxHeight = `${Math.round(px * 0.45)}px`;
  } catch {
    root.style.height = "";
    resetCurrent();
  }
}

/** 分区视图容器（Zotero 的 `.zotero-view-item`，条目面板与阅读器侧栏都存在）。 */
function findViewContainer(root: HTMLElement): HTMLElement | null {
  try {
    return root.closest(".zotero-view-item") as HTMLElement | null;
  } catch {
    return null;
  }
}

interface LayoutBinding {
  win: Window;
  run: () => void;
  observer?: ResizeObserver;
  frame?: number;
  timer?: number;
}

const bindings = new WeakMap<HTMLElement, LayoutBinding>();

/** 同一帧内的多次刷新共用一次布局计算，并在布局稳定后再补算一次。 */
function scheduleFit(root: HTMLElement) {
  const binding = bindings.get(root);
  if (!binding) return;
  const { win } = binding;
  try {
    binding.frame ??= win.requestAnimationFrame(() => {
      binding.frame = undefined;
      binding.run();
    });
  } catch {
    // 不支持动画帧时仍保留延迟计算。
  }
  try {
    binding.timer ??= win.setTimeout(() => {
      binding.timer = undefined;
      binding.run();
    }, 180);
  } catch {
    // 窗口正在关闭时停止调度。
  }
}

/** 绑定并保留清理句柄，避免面板反复打开后残留监听器。 */
function bindResize(root: HTMLElement) {
  if (bindings.has(root)) return;
  const win = (root.ownerGlobal ?? root.ownerDocument.defaultView) as Window | null;
  if (!win) return;
  const binding: LayoutBinding = {
    win,
    run: () => {
      if (bindings.get(root) === binding && root.isConnected) fitPaneHeight(root);
    },
  };
  bindings.set(root, binding);
  try {
    win.addEventListener("resize", binding.run);
    const target = findViewContainer(root) ?? win.document.documentElement;
    const RO = (win as unknown as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    if (RO && target) {
      binding.observer = new RO(binding.run);
      binding.observer.observe(target);
    }
  } catch {
    // 缺少观察器时仍可在渲染和窗口缩放时计算高度。
  }
}

function disposePaneLayout(root: HTMLElement) {
  const binding = bindings.get(root);
  if (!binding) return;
  bindings.delete(root);
  const cleanup = [
    () => binding.win.removeEventListener("resize", binding.run),
    () => binding.observer?.disconnect(),
    () => { if (binding.frame != null) binding.win.cancelAnimationFrame(binding.frame); },
    () => { if (binding.timer != null) binding.win.clearTimeout(binding.timer); },
  ];
  for (const release of cleanup) {
    try { release(); } catch {
      // 已关闭的窗口可能失效，仍需释放其余句柄。
    }
  }
}

export { fitPaneHeight, scheduleFit, bindResize, disposePaneLayout };
