import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../theme';
import { useNotificationStore } from '../../stores/useNotificationStore';
import type { Notification } from '../../stores/useNotificationStore';

const MAX_VISIBLE_TOASTS = 3;

const levelStyles: Record<Notification['level'], string> = {
  info: 'border-l-(--vscode-notificationsInfoIcon-foreground,#75beff)',
  success: 'border-l-status-success',
  warning: 'border-l-(--vscode-notificationsWarningIcon-foreground,#cca700)',
  error: 'border-l-(--vscode-notificationsErrorIcon-foreground,#f14c4c)',
};

/**
 * Whether a toast stays until it is dismissed, and is shown whole.
 *
 * An error is something to act on: pages handed theirs the same five seconds
 * as a confirmation, and a message past two lines lost its end to the clamp —
 * often the part that said what to do. A toast given no time to go away stays
 * too, and is not cut short either.
 */
function staysUp(n: Notification): boolean {
  return n.level === 'error' || !n.autoDismissMs;
}

/** A title or a message, ended as a sentence when it is not one already. */
function asSentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?:。！？]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** One sentence a live region says, keyed so that the same words said twice are heard twice. */
interface Spoken {
  key: number;
  text: string;
}

/**
 * Floating toast notifications that auto-appear on new notifications.
 *
 * What a screen reader hears is each new toast, once: two regions that stay
 * mounted, a polite one and an assertive one for errors, are handed the words
 * of each toast as it arrives. The toasts sat in one atomic live region, each
 * a status of its own: every new toast read out again the errors still on
 * screen, and an error was as polite as a confirmation. Drawn after the page,
 * a toast is last in the Tab order: Alt+N takes the focus to the newest one
 * that stays up, and dismissing it gives the focus back.
 */
export const FloatingToasts: React.FC = () => {
  const { t } = useTranslation();
  const notifications = useNotificationStore((s) => s.notifications);
  const removeNotification = useNotificationStore((s) => s.removeNotification);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const visible = notifications.slice(0, MAX_VISIBLE_TOASTS);

  // The toasts already said: one is said when it first shows, never again.
  const said = useRef<Set<string>>(new Set());
  const spokenCount = useRef(0);
  const [polite, setPolite] = useState<Spoken | null>(null);
  const [assertive, setAssertive] = useState<Spoken | null>(null);
  useEffect(() => {
    const fresh = visible.filter((n) => !said.current.has(n.id));
    if (fresh.length === 0) return;
    for (const n of fresh) said.current.add(n.id);
    const words = (n: Notification): string =>
      [n.title, n.message, staysUp(n) ? t('a11y.toastShortcut') : '']
        .filter(Boolean)
        .map(asSentence)
        .join(' ');
    const errors = fresh.filter((n) => n.level === 'error');
    const others = fresh.filter((n) => n.level !== 'error');
    if (errors.length > 0) {
      spokenCount.current += 1;
      setAssertive({ key: spokenCount.current, text: errors.map(words).join(' ') });
    }
    if (others.length > 0) {
      spokenCount.current += 1;
      setPolite({ key: spokenCount.current, text: others.map(words).join(' ') });
    }
  }, [visible, t]);

  /*
   * Alt+N: the newest toast that stays up takes the focus, on its first
   * control. The element the focus came from is kept, to go back to once
   * that toast is dismissed.
   */
  const toastsRef = useRef<HTMLDivElement>(null);
  const focusCameFrom = useRef<HTMLElement | null>(null);
  const newestStayingId = visible.find(staysUp)?.id ?? null;
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.key.toLowerCase() !== 'n') return;
      if (newestStayingId === null) return;
      const toast = toastsRef.current?.querySelector<HTMLElement>(
        `[data-toast-id="${newestStayingId}"]`,
      );
      const control = toast?.querySelector<HTMLElement>('a[href], button');
      if (!control) return;
      e.preventDefault();
      const active = document.activeElement;
      if (active instanceof HTMLElement && !toastsRef.current?.contains(active)) {
        focusCameFrom.current = active;
      }
      control.focus();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [newestStayingId]);

  /** Remove a toast; one the focus was in gives the focus back where it came from. */
  const dismiss = (id: string): void => {
    const toast = toastsRef.current?.querySelector(`[data-toast-id="${id}"]`);
    const held = toast?.contains(document.activeElement) === true;
    removeNotification(id);
    if (held && focusCameFrom.current?.isConnected) focusCameFrom.current.focus();
  };

  // Effect 1: Set up timers for new notifications + clean orphans
  useEffect(() => {
    for (const n of visible) {
      if (!staysUp(n) && !timersRef.current.has(n.id)) {
        const timer = setTimeout(() => {
          removeNotification(n.id);
          timersRef.current.delete(n.id);
        }, n.autoDismissMs);
        timersRef.current.set(n.id, timer);
      }
    }
    // Clean up timers for notifications no longer visible
    const visibleIds = new Set(visible.map((n) => n.id));
    for (const [id, timer] of timersRef.current.entries()) {
      if (!visibleIds.has(id)) {
        clearTimeout(timer);
        timersRef.current.delete(id);
      }
    }
  }, [visible, removeNotification]);

  // Effect 2: Unmount-only cleanup
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  return (
    <>
      {/* Live regions with no role: always there and mostly empty, they are
          neither a status nor an alert of the page, only what is said. */}
      <div aria-live="polite" aria-atomic="true" className="sr-only" data-testid="toasts-said">
        {polite && <span key={polite.key}>{polite.text}</span>}
      </div>
      <div
        aria-live="assertive"
        aria-atomic="true"
        className="sr-only"
        data-testid="toasts-said-errors"
      >
        {assertive && <span key={assertive.key}>{assertive.text}</span>}
      </div>
      <div
        ref={toastsRef}
        className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-72 pointer-events-none"
        data-testid="floating-toasts"
      >
        {visible.map((n) => (
          <div
            key={n.id}
            data-toast-id={n.id}
            className={cn(
              'pointer-events-auto rounded-sm px-3 py-2 border-l-4 shadow-lg',
              'bg-(--vscode-notifications-background,#252526)',
              'text-(--vscode-notifications-foreground,#cccccc)',
              'border border-(--vscode-notifications-border,#3c3c3c)',
              levelStyles[n.level],
            )}
            data-testid={`floating-toast-${n.id}`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold truncate">{n.title}</p>
                <p className={cn('text-xs mt-0.5', !staysUp(n) && 'line-clamp-2')}>{n.message}</p>
                {n.actions && n.actions.length > 0 && (
                  <div className="flex gap-2 mt-1.5">
                    {n.actions.map((action) =>
                      // An action sent by the extension has a URL and no
                      // callback: VS Code opens the link in the browser, which
                      // is the only thing a webview can do with it. A button
                      // would have dismissed the toast and done nothing else.
                      action.url ? (
                        <a
                          key={action.command}
                          href={action.url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[10px] font-semibold px-2 py-0.5 rounded-sm bg-(--vscode-button-background,#0e639c) text-(--vscode-button-foreground,#ffffff) hover:bg-(--vscode-button-hoverBackground,#1177bb) transition-colors"
                          data-testid={`toast-action-${action.command}`}
                        >
                          {action.label}
                        </a>
                      ) : (
                        <button
                          key={action.command}
                          className="text-[10px] font-semibold px-2 py-0.5 rounded-sm bg-(--vscode-button-background,#0e639c) text-(--vscode-button-foreground,#ffffff) hover:bg-(--vscode-button-hoverBackground,#1177bb) transition-colors"
                          onClick={() => {
                            action.onAction?.();
                            dismiss(n.id);
                          }}
                          data-testid={`toast-action-${action.command}`}
                        >
                          {action.label}
                        </button>
                      ),
                    )}
                  </div>
                )}
              </div>
              <button
                className="text-xs shrink-0"
                onClick={() => dismiss(n.id)}
                aria-label={t('common.dismiss', 'Dismiss')}
              >
                {'\u2715'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
};
