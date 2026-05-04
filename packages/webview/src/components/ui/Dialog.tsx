import React, { useEffect, useId, useRef } from 'react';
import { cn } from '../../theme';

/** Dialog component props. */
export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
  /** When true, uses role="alertdialog" for danger/destructive confirmations. */
  danger?: boolean;
}

/** Modal dialog matching VSCode theme. */
export const Dialog: React.FC<DialogProps> = ({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className,
  danger = false,
}) => {
  const dialogId = useId();
  const titleId = `${dialogId}-title`;
  const descId = `${dialogId}-desc`;
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handleClose = () => onClose();
    dialog.addEventListener('close', handleClose);
    return () => dialog.removeEventListener('close', handleClose);
  }, [onClose]);

  return (
    <dialog
      ref={dialogRef}
      className={cn(
        'rounded-lg p-0 backdrop:bg-black/50',
        'bg-[var(--vscode-editor-background,#1e1e1e)]',
        'text-[var(--vscode-editor-foreground,#d4d4d4)]',
        'border border-[var(--vscode-panel-border,#3c3c3c)]',
        'shadow-xl max-w-md w-full',
        className,
      )}
      role={danger ? 'alertdialog' : undefined}
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onClick={(e) => {
        if (e.target === dialogRef.current) onClose();
      }}
    >
      <div className="p-4" role="document">
        <h2 id={titleId} className="text-base font-semibold mb-1">
          {title}
        </h2>
        {description && (
          <p
            id={descId}
            className="text-xs text-[var(--vscode-descriptionForeground,#868686)] mb-3"
          >
            {description}
          </p>
        )}
        <div className="mt-2">{children}</div>
        {footer && <div className="mt-4 flex justify-end gap-2">{footer}</div>}
      </div>
    </dialog>
  );
};
