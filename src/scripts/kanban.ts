/**
 * 看板娘 Header 开关：写 localStorage[kanban:hidden] + dispatch 事件。
 * Live2DKanban 监听 `kanban:visibility-changed` 事件同步 visible state。
 */
const KEY = "kanban:hidden";

function isHidden(): boolean {
  return localStorage.getItem(KEY) === "1";
}

function reflectKanban(): void {
  const btn = document.querySelector("#kanban-btn");
  if (!(btn instanceof HTMLElement)) return;
  const hidden = isHidden();
  // 同步按钮的 aria-label / aria-pressed / title（i18n 字符串由 Astro 模板注入）
  const label = hidden
    ? btn.dataset.labelShow ?? "Show kanban"
    : btn.dataset.labelHide ?? "Hide kanban";
  btn.setAttribute("aria-label", label);
  btn.setAttribute("aria-pressed", hidden ? "true" : "false");
  btn.setAttribute("title", label);
}

function setupKanban(): void {
  reflectKanban();
  const btn = document.querySelector("#kanban-btn");
  if (!(btn instanceof HTMLElement)) return;
  btn.addEventListener("click", () => {
    if (isHidden()) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, "1");
    reflectKanban();
    // 通知已挂载的 Live2DKanban 实例
    window.dispatchEvent(new CustomEvent("kanban:visibility-changed"));
  });
}

setupKanban();

// Re-run after View Transitions navigation so the button keeps working on new pages.
document.addEventListener("astro:after-swap", setupKanban);
