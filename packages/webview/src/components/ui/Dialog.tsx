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

  // The element that held the keyboard as the dialog opened: the button that asked.
  const openerRef = useRef<Element | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      openerRef.current = document.activeElement;
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  // Closed by Escape or by `open`, the browser gives the keyboard back to the
  // element that had it when the dialog opened. Most parents close it by not
  // drawing it any more, as Cancel or Save is pressed, and a dialog taken off
  // the page open gives nothing back: the keyboard was left on <body>. Once
  // it is gone, the button that asked takes it back, while that button is
  // still on the page and nothing else took it. Checked once the dialog is
  // off the page: while it is on it, open and modal, the rest of the page is
  // inert, and a development build's rehearsal of the unmount leaves it on.
  useEffect(() => {
    const dialog = dialogRef.current;
    return () => {
      const opener = openerRef.current;
      const active = document.activeElement;
      if (
        dialog !== null &&
        !dialog.isConnected &&
        dialog.open &&
        opener instanceof HTMLElement &&
        opener.isConnected &&
        (active === null || active === document.body)
      ) {
        opener.focus();
      }
    };
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handleClose = () => onClose();
    dialog.addEventListener('close', handleClose);
    return () => dialog.removeEventListener('close', handleClose);
  }, [onClose]);

  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- a native <dialog> opened with showModal() closes on Escape by itself; this only adds the mouse shortcut of clicking the backdrop.
    <dialog
      ref={dialogRef}
      className={cn(
        'rounded-lg p-0 backdrop:bg-black/50',
        'bg-(--vscode-editor-background,#1e1e1e)',
        'text-(--vscode-editor-foreground,#d4d4d4)',
        'border border-(--vscode-panel-border,#3c3c3c)',
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
          <p id={descId} className="text-xs text-(--vscode-descriptionForeground,#868686) mb-3">
            {description}
          </p>
        )}
        <div className="mt-2">{children}</div>
        {footer && <div className="mt-4 flex justify-end gap-2">{footer}</div>}
      </div>
    </dialog>
  );
};
