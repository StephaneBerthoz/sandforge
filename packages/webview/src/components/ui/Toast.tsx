import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../theme';

/** Toast notification level. */
export type ToastLevel = 'info' | 'success' | 'warning' | 'error';

/** Toast component props. */
export interface ToastProps {
  id: string;
  level: ToastLevel;
  title: string;
  message: string;
  onDismiss: (id: string) => void;
  autoDismissMs?: number;
  actions?: { label: string; onClick: () => void }[];
}

const levelClasses: Record<ToastLevel, string> = {
  info: 'border-l-[var(--vscode-editorInfo-foreground,#3794ff)]',
  success: 'border-l-emerald-500',
  warning: 'border-l-[var(--vscode-editorWarning-foreground,#cca700)]',
  error: 'border-l-[var(--vscode-errorForeground,#f48771)]',
};

const levelIcons: Record<ToastLevel, string> = {
  info: 'i',
  success: '\u2713',
  warning: '!',
  error: '\u2717',
};

/** Toast notification component. */
export const Toast: React.FC<ToastProps> = ({
  id,
  level,
  title,
  message,
  onDismiss,
  autoDismissMs,
  actions,
}) => {
  const { t } = useTranslation();
  useEffect(() => {
    if (!autoDismissMs) return;
    const timer = setTimeout(() => onDismiss(id), autoDismissMs);
    return () => clearTimeout(timer);
  }, [id, autoDismissMs, onDismiss]);

  return (
    <div
      role="alert"
      className={cn(
        'flex gap-2 p-3 rounded border-l-4',
        'bg-[var(--vscode-editorWidget-background,#252526)]',
        'text-[var(--vscode-editor-foreground,#d4d4d4)]',
        'border border-[var(--vscode-panel-border,#3c3c3c)]',
        'shadow-lg',
        levelClasses[level],
      )}
    >
      <span className="shrink-0 text-sm font-bold">{levelIcons[level]}</span>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-semibold">{title}</p>
        <p className="text-xs text-[var(--vscode-descriptionForeground,#868686)] mt-0.5">
          {message}
        </p>
        {actions && actions.length > 0 && (
          <div className="flex gap-2 mt-2">
            {actions.map((action) => (
              <button
                key={action.label}
                className="text-xs text-[var(--vscode-textLink-foreground,#3794ff)] hover:underline"
                onClick={action.onClick}
              >
                {action.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <button
        className="shrink-0 text-xs text-[var(--vscode-descriptionForeground,#868686)] hover:text-[var(--vscode-editor-foreground,#d4d4d4)]"
        onClick={() => onDismiss(id)}
        aria-label={t('common.dismiss', 'Dismiss')}
      >
        \u2715
      </button>
    </div>
  );
};
