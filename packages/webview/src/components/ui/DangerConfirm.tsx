import React, { useState, useCallback, useRef } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import * as Dialog from '@radix-ui/react-dialog';
import { AnimatePresence, m } from 'framer-motion';
import { cn } from '../../theme';
import { fadeIn, slideUp } from '../../motion/presets';

/** Variant styles for different confirmation dialog types. */
const variantStyles = {
  // The confirm button fills with the severity token and writes in the editor
  // background: the token is sized to read against that background on every
  // theme, where white on red-500, yellow-500 or blue-500 read 3.8, 1.9 and 3.7:1.
  danger: {
    accent: 'text-status-error',
    border: 'border-status-error/50',
    btnBg: 'bg-status-error',
  },
  warning: {
    accent: 'text-status-warning',
    border: 'border-monitor/50',
    btnBg: 'bg-status-warning',
  },
  info: {
    accent: 'text-status-info',
    border: 'border-sync/50',
    btnBg: 'bg-status-info',
  },
} as const;

/** Supported dialog variant types. */
export type ConfirmVariant = keyof typeof variantStyles;

/** What every confirmation dialog takes, typed or not. */
interface DangerConfirmBaseProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description: string;
  className?: string;
  /** Visual variant: danger (red), warning (yellow), or info (blue). Defaults to danger. */
  variant?: ConfirmVariant;
  /**
   * What the description cannot say in a sentence — the records per object a
   * delete takes, an option that changes what it does — shown under it,
   * above the typed confirmation.
   */
  children?: React.ReactNode;
}

/** A confirmation armed by typing a word: for what deletes, or writes to production. */
interface TypedConfirmProps {
  /** The word to type, which arms the Confirm button. */
  confirmText: string;
  confirmLabel?: undefined;
  dismissLabel?: undefined;
}

/**
 * A plain confirmation, its button saying what it does: for what writes
 * nothing, such as stopping one's own run.
 */
interface PlainConfirmProps {
  confirmText?: undefined;
  /** What the confirm button says: "Stop the run". */
  confirmLabel: string;
  /** What the button that closes the dialog says, when Cancel would read as the action. */
  dismissLabel?: string;
}

/** DangerConfirm component props. */
export type DangerConfirmProps = DangerConfirmBaseProps & (TypedConfirmProps | PlainConfirmProps);

/**
 * Confirmation dialog. Given a `confirmText`, it is armed by typing it; given
 * a `confirmLabel` instead, it is a plain question whose buttons say what
 * each does.
 *
 * Stopping one's own run asked to type the word Cancel — the label of the
 * button beside it, which closes the dialog and stops nothing, and a word
 * typed in Japanese only through an input method — for a stop that writes
 * nothing. Typing is kept for what deletes or writes to production.
 */
export const DangerConfirm: React.FC<DangerConfirmProps> = ({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmText,
  confirmLabel,
  dismissLabel,
  className,
  variant = 'danger',
  children,
}) => {
  const { t } = useTranslation();
  const [typed, setTyped] = useState('');
  // Every opening starts empty. `handleClose` and `handleConfirm` clear the
  // field on the dialog's own exits, but a parent that closes it — a refresh
  // removing what the confirmation was about — runs neither, and the next
  // opening came up already confirmed: one click, nothing typed. Resetting
  // during render, not in an effect, leaves no painted frame in which the
  // stale text still arms the button.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setTyped('');
  }
  const asksToType = confirmText !== undefined;
  const isMatch = !asksToType || typed === confirmText;
  const inputRef = useRef<HTMLInputElement>(null);
  const dismissRef = useRef<HTMLButtonElement>(null);
  const styles = variantStyles[variant];

  const handleConfirm = useCallback(() => {
    if (isMatch) {
      onConfirm();
      setTyped('');
    }
  }, [isMatch, onConfirm]);

  const handleClose = useCallback(() => {
    setTyped('');
    onClose();
  }, [onClose]);

  const handleOpenChange = useCallback(
    (value: boolean) => {
      if (!value) {
        handleClose();
      }
    },
    [handleClose],
  );

  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && isMatch) {
        handleConfirm();
      }
    },
    [isMatch, handleConfirm],
  );

  // The element that held the keyboard as the dialog opened, still holding it
  // when Radix hands the focus out: the button that asked.
  const openerRef = useRef<HTMLElement | null>(null);

  // The field takes the focus when Radix hands it out, once the content is on
  // the page. An effect on `open` ran first, while the portal had not mounted
  // the field yet, and with Radix's own focus turned off the dialog opened
  // with nothing focused: the typed word went nowhere.
  // A plain question gives it to the button that leaves things as they are,
  // so an Enter pressed as it opens stops nothing.
  const focusField = useCallback(
    (event: Event) => {
      event.preventDefault();
      const opener = document.activeElement;
      openerRef.current = opener instanceof HTMLElement && opener !== document.body ? opener : null;
      (asksToType ? inputRef.current : dismissRef.current)?.focus();
    },
    [asksToType],
  );
  // Radix gives the focus back to a Dialog.Trigger, which this dialog never
  // has: Cancel, Escape and Confirm left the keyboard on <body>, and a
  // keyboard user started again from the top of the page. It goes back to
  // the button that asked, while that button is still on the page and
  // nothing else took the keyboard as the dialog closed — the heading of the
  // run its Confirm started keeps it.
  const giveFocusBack = useCallback((event: Event) => {
    event.preventDefault();
    const opener = openerRef.current;
    openerRef.current = null;
    const active = document.activeElement;
    if (opener?.isConnected && (active === null || active === document.body)) opener.focus();
  }, []);

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild>
              <m.div
                className="fixed inset-0 z-50 flex items-center justify-center glass-overlay"
                variants={fadeIn}
                initial="hidden"
                animate="visible"
                exit="hidden"
                onClick={handleClose}
                data-testid="danger-overlay"
              >
                <Dialog.Content
                  asChild
                  onOpenAutoFocus={focusField}
                  onCloseAutoFocus={giveFocusBack}
                >
                  <m.div
                    className={cn(
                      'rounded-lg p-4 max-w-md w-full',
                      'bg-(--vscode-editor-background,#1e1e1e)',
                      styles.border,
                      'border shadow-xl',
                      className,
                    )}
                    variants={slideUp}
                    initial="hidden"
                    animate="visible"
                    exit="hidden"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Dialog.Title
                      className={cn('text-base font-semibold', styles.accent)}
                      data-testid="danger-title"
                    >
                      {title}
                    </Dialog.Title>
                    <Dialog.Description className="text-xs text-(--vscode-descriptionForeground,#868686) mt-2">
                      {description}
                    </Dialog.Description>
                    {children && (
                      <div
                        className="mt-3 text-xs text-(--vscode-editor-foreground,#d4d4d4)"
                        data-testid="danger-details"
                      >
                        {children}
                      </div>
                    )}
                    {asksToType && (
                      <>
                        {/* One translated sentence rather than three glued
                            fragments: languages that put the literal first or
                            last need the <code> to move with it. */}
                        <p className="text-xs text-(--vscode-editor-foreground,#d4d4d4) mt-3">
                          <Trans
                            i18nKey="common.typeToConfirm"
                            t={t}
                            defaults="Type <code>{{text}}</code> to confirm:"
                            values={{ text: confirmText }}
                            components={{
                              code: (
                                <code
                                  className={cn(
                                    'px-1 py-0.5 rounded-sm bg-(--vscode-input-background,#3c3c3c) font-mono',
                                    styles.accent,
                                  )}
                                />
                              ),
                            }}
                          />
                        </p>
                        <input
                          ref={inputRef}
                          type="text"
                          value={typed}
                          onChange={(e) => setTyped(e.target.value)}
                          onKeyDown={handleInputKeyDown}
                          className={cn(
                            'w-full mt-2 px-2 py-1.5 text-sm rounded-sm',
                            'bg-(--vscode-input-background,#3c3c3c)',
                            'text-(--vscode-input-foreground,#d4d4d4)',
                            'border border-(--vscode-input-border,#3c3c3c)',
                            'focus:outline-hidden focus:border-(--vscode-focusBorder,#007fd4)',
                          )}
                          placeholder={confirmText}
                          aria-label={t('common.confirm')}
                          data-testid="danger-input"
                        />
                      </>
                    )}
                    <div className="flex justify-end gap-2 mt-4">
                      <button
                        ref={dismissRef}
                        className="px-3 py-1.5 text-sm rounded-sm bg-(--vscode-button-secondaryBackground,#3a3d41) text-(--vscode-button-secondaryForeground,#fff) hover:bg-(--vscode-button-secondaryHoverBackground,#45494e)"
                        onClick={handleClose}
                        data-testid="danger-dismiss-btn"
                      >
                        {dismissLabel ?? t('common.cancel')}
                      </button>
                      <button
                        className={cn(
                          'px-3 py-1.5 text-sm rounded-sm font-medium cursor-pointer',
                          styles.btnBg,
                          'text-(--sf-bg-primary)',
                          // Until the text matches the button is disabled, and reads as such.
                          'disabled:bg-(--vscode-input-background,#3c3c3c) disabled:text-text-muted disabled:cursor-not-allowed',
                        )}
                        onClick={handleConfirm}
                        disabled={!isMatch}
                        data-testid="danger-confirm-btn"
                      >
                        {confirmLabel ?? t('common.confirm')}
                      </button>
                    </div>
                  </m.div>
                </Dialog.Content>
              </m.div>
            </Dialog.Overlay>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
};
