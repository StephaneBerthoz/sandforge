import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import * as Dialog from '@radix-ui/react-dialog';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '../../theme';
import { fadeIn, slideUp } from '../../motion/presets';

/** Variant styles for different confirmation dialog types. */
const variantStyles = {
  danger: { accent: 'text-red-400', border: 'border-red-500/50', btnBg: 'bg-red-500 hover:bg-red-600' },
  warning: { accent: 'text-monitor', border: 'border-monitor/50', btnBg: 'bg-monitor hover:bg-yellow-600' },
  info: { accent: 'text-sync', border: 'border-sync/50', btnBg: 'bg-sync hover:bg-blue-600' },
} as const;

/** Supported dialog variant types. */
export type ConfirmVariant = keyof typeof variantStyles;

/** DangerConfirm component props. */
export interface DangerConfirmProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description: string;
  confirmText: string;
  className?: string;
  /** Visual variant: danger (red), warning (yellow), or info (blue). Defaults to danger. */
  variant?: ConfirmVariant;
}

/** Danger confirmation dialog requiring typed text to proceed. */
export const DangerConfirm: React.FC<DangerConfirmProps> = ({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmText,
  className,
  variant = 'danger',
}) => {
  const { t } = useTranslation();
  const [typed, setTyped] = useState('');
  const isMatch = typed === confirmText;
  const inputRef = useRef<HTMLInputElement>(null);
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

  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus();
    }
  }, [open]);

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild>
              <motion.div
                className="fixed inset-0 z-50 flex items-center justify-center glass-overlay"
                variants={fadeIn}
                initial="hidden"
                animate="visible"
                exit="hidden"
                onClick={handleClose}
                data-testid="danger-overlay"
              >
                <Dialog.Content asChild onOpenAutoFocus={(e) => e.preventDefault()}>
                  <motion.div
                    className={cn(
                      'rounded-lg p-4 max-w-md w-full',
                      'bg-[var(--vscode-editor-background,#1e1e1e)]',
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
                    <Dialog.Title className={cn('text-base font-semibold', styles.accent)} data-testid="danger-title">
                      {title}
                    </Dialog.Title>
                    <Dialog.Description className="text-xs text-[var(--vscode-descriptionForeground,#868686)] mt-2">
                      {description}
                    </Dialog.Description>
                    <p className="text-xs text-[var(--vscode-editor-foreground,#d4d4d4)] mt-3">
                      Type <code className={cn('px-1 py-0.5 rounded bg-[var(--vscode-input-background,#3c3c3c)] font-mono', styles.accent)}>{confirmText}</code> to confirm:
                    </p>
                    <input
                      ref={inputRef}
                      type="text"
                      value={typed}
                      onChange={(e) => setTyped(e.target.value)}
                      onKeyDown={handleInputKeyDown}
                      className={cn(
                        'w-full mt-2 px-2 py-1.5 text-sm rounded',
                        'bg-[var(--vscode-input-background,#3c3c3c)]',
                        'text-[var(--vscode-input-foreground,#d4d4d4)]',
                        'border border-[var(--vscode-input-border,#3c3c3c)]',
                        'focus:outline-none focus:border-[var(--vscode-focusBorder,#007fd4)]',
                      )}
                      placeholder={confirmText}
                      aria-label={t('common.confirm')}
                      data-testid="danger-input"
                    />
                    <div className="flex justify-end gap-2 mt-4">
                      <button
                        className="px-3 py-1.5 text-sm rounded bg-[var(--vscode-button-secondaryBackground,#3a3d41)] text-[var(--vscode-button-secondaryForeground,#fff)] hover:bg-[var(--vscode-button-secondaryHoverBackground,#45494e)]"
                        onClick={handleClose}
                      >
                        {t('common.cancel')}
                      </button>
                      <button
                        className={cn(
                          'px-3 py-1.5 text-sm rounded font-medium',
                          isMatch
                            ? `${styles.btnBg} text-white cursor-pointer`
                            : 'bg-[var(--vscode-input-background,#3c3c3c)] text-[var(--vscode-disabledForeground,#6b6b6b)] cursor-not-allowed',
                        )}
                        onClick={handleConfirm}
                        disabled={!isMatch}
                        data-testid="danger-confirm-btn"
                      >
                        {t('common.confirm')}
                      </button>
                    </div>
                  </motion.div>
                </Dialog.Content>
              </motion.div>
            </Dialog.Overlay>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
};
