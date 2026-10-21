import type React from 'react';

/**
 * The keys of a `role="tablist"`, as the tab pattern defines them: Left and
 * Right move to the previous and the next tab and wrap at the ends, Home and
 * End go to the first and the last. A disabled tab is stepped over.
 *
 * @returns The id of the tab the key moves to, or null for any other key.
 */
export function tabForKey(
  key: string,
  ids: readonly string[],
  current: string,
  disabled: ReadonlySet<string> = new Set(),
): string | null {
  const selectable = ids.filter((id) => !disabled.has(id));
  if (selectable.length === 0) return null;
  const step = key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : 0;
  if (step !== 0) {
    const at = selectable.indexOf(current);
    const from = at === -1 ? 0 : at;
    return selectable[(from + step + selectable.length) % selectable.length] ?? null;
  }
  if (key === 'Home') return selectable[0] ?? null;
  if (key === 'End') return selectable[selectable.length - 1] ?? null;
  return null;
}

/**
 * Handle a key pressed on a tab: select the tab it moves to and hand it the
 * focus. Only the selected tab is in the page's Tab order (each bar gives it
 * `tabIndex={0}` and the others `-1`), so the focus has to follow the
 * selection or it lands nowhere. The tab is found by its position among the
 * list's tabs rather than by a selector built from its id: an id is the
 * caller's, and `CSS.escape` is not everywhere (jsdom has none).
 */
export function handleTabListKeyDown(
  event: React.KeyboardEvent<HTMLElement>,
  ids: readonly string[],
  current: string,
  select: (id: string) => void,
  disabled?: ReadonlySet<string>,
): void {
  const next = tabForKey(event.key, ids, current, disabled);
  if (next === null) return;
  event.preventDefault();
  select(next);
  const list = event.currentTarget.closest('[role="tablist"]');
  list?.querySelectorAll<HTMLElement>('[role="tab"]')[ids.indexOf(next)]?.focus();
}
