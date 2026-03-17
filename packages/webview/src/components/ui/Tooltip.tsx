import React, { useState, useRef, useEffect } from 'react';
import { cn } from '../../theme';

/** Tooltip component props. */
export interface TooltipProps {
  content: string;
  children: React.ReactElement;
  side?: 'top' | 'bottom';
  className?: string;
}

/** Simple tooltip matching VSCode theme. */
export const Tooltip: React.FC<TooltipProps> = ({
  content,
  children,
  side = 'top',
  className,
}) => {
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
            'absolute z-50 px-2 py-1 text-xs rounded shadow-lg whitespace-nowrap pointer-events-none',
            'bg-[var(--vscode-editorHoverWidget-background,#2d2d30)]',
            'text-[var(--vscode-editorHoverWidget-foreground,#d4d4d4)]',
            'border border-[var(--vscode-editorHoverWidget-border,#454545)]',
            side === 'top' ? 'bottom-full left-1/2 -translate-x-1/2 mb-1' : 'top-full left-1/2 -translate-x-1/2 mt-1',
            className,
          )}
        >
          {content}
        </span>
      )}
    </span>
  );
};
