/** How long a control is waited for before the wait is given up. */
const DRAW_WAIT_MS = 5000;

/** Whether the focus is nowhere: the control that held it went with its screen. */
function focusIsFree(): boolean {
  const focused = document.activeElement;
  return focused === null || focused === document.body;
}

/**
 * Hand the focus to a control as soon as it is drawn inside `root`, if the
 * focus is still nowhere by then.
 *
 * A screen drawn back in place of another may draw its controls only once its
 * data is in — the Seed gallery asks for its templates again each time it is
 * shown — and a focus handed over at once found nothing to land on. The wait
 * ends when the control is found, when the user has put the focus somewhere,
 * or after a few seconds.
 *
 * @returns A function that stops waiting.
 */
export function focusWhenDrawn(
  root: HTMLElement,
  find: () => HTMLElement | null,
  timeoutMs: number = DRAW_WAIT_MS,
): () => void {
  /** True once there is nothing more to wait for. */
  const attempt = (): boolean => {
    if (!focusIsFree()) return true;
    const control = find();
    if (!control) return false;
    control.focus();
    return true;
  };
  if (attempt()) return () => undefined;
  const watcher = new MutationObserver(() => {
    if (attempt()) stop();
  });
  const timer = setTimeout(() => stop(), timeoutMs);
  function stop(): void {
    watcher.disconnect();
    clearTimeout(timer);
  }
  watcher.observe(root, { childList: true, subtree: true });
  return stop;
}
