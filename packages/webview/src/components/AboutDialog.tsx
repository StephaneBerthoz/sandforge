import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Logo } from './ui/Logo';
import { cn } from '../theme';

/** Props for the AboutDialog component. */
export interface AboutDialogProps {
  /** Whether the dialog is open. */
  isOpen: boolean;
  /** Callback when the dialog is closed. */
  onClose: () => void;
}

/** Konami code sequence: Up Up Down Down Left Right Left Right B A */
const KONAMI_CODE = [
  'ArrowUp', 'ArrowUp',
  'ArrowDown', 'ArrowDown',
  'ArrowLeft', 'ArrowRight',
  'ArrowLeft', 'ArrowRight',
  'KeyB', 'KeyA',
];

/**
 * About dialog showing SandForge branding, version info, and credits.
 * Includes a Konami code easter egg that triggers the MojitoOverlay.
 */
export const AboutDialog: React.FC<AboutDialogProps> = ({ isOpen, onClose }) => {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [showEasterEgg, setShowEasterEgg] = useState(false);
  const konamiIndex = useRef(0);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (isOpen && !dialog.open) {
      dialog.showModal();
    } else if (!isOpen && dialog.open) {
      dialog.close();
    }
  }, [isOpen]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handleClose = (): void => onClose();
    dialog.addEventListener('close', handleClose);
    return () => dialog.removeEventListener('close', handleClose);
  }, [onClose]);

  const handleKonamiKey = useCallback((e: KeyboardEvent): void => {
    if (e.code === KONAMI_CODE[konamiIndex.current]) {
      konamiIndex.current += 1;
      if (konamiIndex.current === KONAMI_CODE.length) {
        setShowEasterEgg(true);
        konamiIndex.current = 0;
      }
    } else {
      konamiIndex.current = 0;
    }
  }, []);

  useEffect(() => {
    if (!isOpen) {
      konamiIndex.current = 0;
      setShowEasterEgg(false);
      return;
    }
    window.addEventListener('keydown', handleKonamiKey);
    return () => window.removeEventListener('keydown', handleKonamiKey);
  }, [isOpen, handleKonamiKey]);

  const handleCloseEasterEgg = useCallback((): void => {
    setShowEasterEgg(false);
  }, []);

  return (
    <>
      <dialog
        ref={dialogRef}
        data-testid="about-dialog"
        className={cn(
          'rounded-lg p-0 backdrop:bg-black/50',
          'bg-[var(--vscode-editor-background,#1e1e1e)]',
          'text-[var(--vscode-editor-foreground,#d4d4d4)]',
          'border border-[var(--vscode-panel-border,#3c3c3c)]',
          'shadow-xl max-w-sm w-full',
        )}
        aria-labelledby="about-dialog-title"
        onClick={(e) => {
          if (e.target === dialogRef.current) onClose();
        }}
      >
        <div className="p-6 flex flex-col items-center text-center gap-4" role="document">
          <Logo size="large" />

          <div>
            <h2
              id="about-dialog-title"
              className="text-lg font-bold"
            >
              SandForge v1.0.0
            </h2>
            <p className="text-xs text-[var(--vscode-descriptionForeground,#868686)] mt-1">
              {t('onboarding.bienvenueDesc', 'Forge your Salesforce sandboxes with confidence.')}
            </p>
          </div>

          {/* Links */}
          <div className="flex flex-wrap justify-center gap-3 text-xs">
            <a
              href="https://sandforge.dev/docs"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--vscode-textLink-foreground,#3794ff)] hover:underline"
            >
              {t('help.documentation', 'Documentation')}
            </a>
          </div>

          {/* Credits */}
          <div className="border-t border-[var(--vscode-panel-border,#3c3c3c)] pt-3 w-full">
            <p className="text-xs text-[var(--vscode-descriptionForeground,#868686)]">
              {t('about.credits', 'Crafted with passion by the SandForge team')}
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="mt-2 px-4 py-1.5 text-sm rounded font-medium bg-[var(--vscode-button-background,#0e639c)] text-[var(--vscode-button-foreground,#fff)] hover:bg-[var(--vscode-button-hoverBackground,#1177bb)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--vscode-focusBorder,#007fd4)]"
          >
            {t('common.close')}
          </button>
        </div>
      </dialog>

      {showEasterEgg && (
        <MojitoOverlayLazy onClose={handleCloseEasterEgg} />
      )}
    </>
  );
};

/**
 * Lazy wrapper for the MojitoOverlay easter egg.
 * Uses React.lazy to only import the overlay when triggered.
 */
const MojitoOverlayLazy: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const LazyOverlay = React.lazy(
    () => import('./EasterEgg/MojitoOverlay').then((m) => ({ default: m.MojitoOverlay })),
  );

  return (
    <React.Suspense fallback={null}>
      <LazyOverlay onClose={onClose} />
    </React.Suspense>
  );
};
