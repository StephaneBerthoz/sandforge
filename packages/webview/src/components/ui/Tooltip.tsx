import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { cn } from '../../theme';

/** Tooltip component props. */
export interface TooltipProps {
  /** Text content displayed inside the tooltip. */
  content: string;
  /** The element that triggers the tooltip on hover. */
  children: React.ReactElement;
  /** Which side of the trigger the tooltip appears on. */
  side?: 'top' | 'bottom';
  /** Additional CSS class for the tooltip bubble. */
  className?: string;
  /** When true, the tooltip shows a dismiss (x) button and is interactive. */
  dismissible?: boolean;
  /** Callback fired when the dismiss button is clicked. */
  onDismiss?: (e: React.MouseEvent) => void;
}

/** Simple tooltip matching VSCode theme with optional dismiss button. */
export const Tooltip: React.FC<TooltipProps> = ({
  content,
  children,
  side = 'top',
  className,
  dismissible = false,
  onDismiss,
}) => {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>();

  const show = () => {
    clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setVisible(true), 300);
  };

  const hide = () => {
    clearTimeout(timeoutRef.current);
    setVisible(false);
  };

  useEffect(() => {
    return () => clearTimeout(timeoutRef.current);
  }, []);

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {visible && (
        <span
          role="tooltip"
          aria-live="polite"
          className={cn(
            'absolute z-50 px-2 py-1 text-xs rounded shadow-lg whitespace-nowrap',
            dismissible ? 'pointer-events-auto' : 'pointer-events-none',
            'bg-[var(--vscode-editorHoverWidget-background,#2d2d30)]',
            'text-[var(--vscode-editorHoverWidget-foreground,#d4d4d4)]',
            'border border-[var(--vscode-editorHoverWidget-border,#454545)]',
            side === 'top'
              ? 'bottom-full left-1/2 -translate-x-1/2 mb-1'
              : 'top-full left-1/2 -translate-x-1/2 mt-1',
            className,
          )}
        >
          <span className="flex items-center gap-1.5">
            <span>{content}</span>
            {dismissible && onDismiss && (
              <button
                type="button"
                onClick={onDismiss}
                className="inline-flex items-center justify-center w-3 h-3 rounded-sm hover:bg-[var(--vscode-toolbar-hoverBackground,#5a5d5e)] transition-colors"
                aria-label={t('common.dismiss', 'Dismiss')}
                data-testid="tooltip-dismiss"
              >
                <X className="w-2.5 h-2.5" />
              </button>
            )}
          </span>
        </span>
      )}
    </span>
  );
};
