import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../theme';

/** Drawer component props. */
export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  side?: 'left' | 'right';
  children: React.ReactNode;
  className?: string;
}

/** Slide-in side panel with overlay backdrop. */
export const Drawer: React.FC<DrawerProps> = ({
  open,
  onClose,
  title,
  side = 'right',
  children,
  className,
}) => {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (open && panelRef.current) {
      panelRef.current.focus();
    }
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex" data-testid="drawer-root">
      {/* Overlay */}
      <div
        className="fixed inset-0 bg-black/50 transition-opacity"
        aria-hidden="true"
        onClick={onClose}
        data-testid="drawer-overlay"
      />
      {/* Panel */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={cn(
          'fixed top-0 bottom-0 w-80 z-50',
          'bg-[var(--vscode-sideBar-background,#252526)]',
          'border-[var(--vscode-panel-border,#3c3c3c)]',
          'shadow-xl flex flex-col',
          'transition-transform duration-300 ease-in-out',
          side === 'right' && 'right-0 border-l',
          side === 'left' && 'left-0 border-r',
          className,
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--vscode-panel-border,#3c3c3c)]">
          <h2 className="text-sm font-semibold text-[var(--vscode-editor-foreground,#d4d4d4)]">
            {title}
          </h2>
          <button
            type="button"
            aria-label={t('common.close', 'Close')}
            className="p-1 rounded hover:bg-[var(--vscode-toolbar-hoverBackground,#5a5d5e50)] transition-colors"
            onClick={onClose}
          >
            <svg
              className="w-4 h-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
};
