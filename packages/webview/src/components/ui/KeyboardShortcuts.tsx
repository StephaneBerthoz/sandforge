import React, { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { cn } from '../../theme';

/** A single keyboard shortcut entry. */
interface ShortcutEntry {
  keys: string[];
  descriptionKey: string;
  fallback: string;
}

/** A group of related shortcuts. */
interface ShortcutGroup {
  titleKey: string;
  fallback: string;
  shortcuts: ShortcutEntry[];
}

/** All keyboard shortcuts grouped by category. */
const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    titleKey: 'shortcuts.navigation',
    fallback: 'Navigation',
    shortcuts: [
      {
        keys: ['Ctrl', 'K'],
        descriptionKey: 'shortcuts.commandPalette',
        fallback: 'Command Palette',
      },
      {
        keys: ['Ctrl', 'B'],
        descriptionKey: 'shortcuts.toggleSidebar',
        fallback: 'Toggle Sidebar',
      },
      {
        keys: ['?'],
        descriptionKey: 'shortcuts.showShortcuts',
        fallback: 'Show Keyboard Shortcuts',
      },
      {
        keys: ['Esc'],
        descriptionKey: 'shortcuts.closeOverlay',
        fallback: 'Close Overlay / Dialog',
      },
    ],
  },
  {
    titleKey: 'shortcuts.quickNav',
    fallback: 'Quick Navigation',
    shortcuts: [
      { keys: ['Ctrl', '1'], descriptionKey: 'shortcuts.ctrlModule1', fallback: 'Go to Monitor' },
      { keys: ['Ctrl', '2'], descriptionKey: 'shortcuts.ctrlModule2', fallback: 'Go to Seed' },
      { keys: ['Ctrl', '3'], descriptionKey: 'shortcuts.ctrlModule3', fallback: 'Go to Sync' },
      { keys: ['Ctrl', '4'], descriptionKey: 'shortcuts.ctrlModule4', fallback: 'Go to Compare' },
      { keys: ['Ctrl', '5'], descriptionKey: 'shortcuts.ctrlModule5', fallback: 'Go to DataOps' },
      {
        keys: ['Ctrl', '6'],
        descriptionKey: 'shortcuts.ctrlModule6',
        fallback: 'Go to Automation',
      },
    ],
  },
  {
    titleKey: 'shortcuts.modules',
    fallback: 'Modules',
    shortcuts: [
      { keys: ['G', 'H'], descriptionKey: 'shortcuts.goHome', fallback: 'Go to Home' },
      { keys: ['G', 'M'], descriptionKey: 'shortcuts.goMonitor', fallback: 'Go to Monitor' },
      { keys: ['G', 'S'], descriptionKey: 'shortcuts.goSeed', fallback: 'Go to Seed' },
      { keys: ['G', 'Y'], descriptionKey: 'shortcuts.goSync', fallback: 'Go to Sync' },
      { keys: ['G', 'C'], descriptionKey: 'shortcuts.goCompare', fallback: 'Go to Compare' },
      { keys: ['G', 'D'], descriptionKey: 'shortcuts.goDataOps', fallback: 'Go to DataOps' },
      { keys: ['G', 'A'], descriptionKey: 'shortcuts.goAutomation', fallback: 'Go to Automation' },
    ],
  },
  {
    titleKey: 'shortcuts.actions',
    fallback: 'Actions',
    shortcuts: [
      { keys: ['Ctrl', 'S'], descriptionKey: 'shortcuts.saveSettings', fallback: 'Save Settings' },
      {
        keys: ['Ctrl', 'Enter'],
        descriptionKey: 'shortcuts.execute',
        fallback: 'Execute current action',
      },
      { keys: ['Esc'], descriptionKey: 'shortcuts.cancel', fallback: 'Cancel / Close' },
      {
        keys: ['Ctrl', 'Shift', 'P'],
        descriptionKey: 'shortcuts.openSettings',
        fallback: 'Open Settings',
      },
    ],
  },
];

/** Props for the KeyboardShortcuts overlay. */
export interface KeyboardShortcutsProps {
  className?: string;
}

/** Renders a single key cap with styled appearance. */
const KeyCap: React.FC<{ label: string }> = ({ label }) => (
  <kbd
    className={cn(
      'inline-flex items-center justify-center',
      'min-w-[24px] h-6 px-1.5',
      'text-[11px] font-mono font-medium',
      'rounded border',
    )}
    style={{
      background: 'var(--sf-bg-input, #262635)',
      borderColor: 'var(--sf-border, rgba(255,255,255,0.10))',
      color: 'var(--sf-text-primary, #F2F2F2)',
      boxShadow: '0 1px 0 var(--sf-border, rgba(255,255,255,0.10))',
    }}
  >
    {label}
  </kbd>
);

/**
 * Full-screen keyboard shortcut overlay.
 * Toggles with the `?` key (only when not typing in an input).
 * Closes with Escape.
 */
export const KeyboardShortcuts: React.FC<KeyboardShortcutsProps> = ({ className }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInput =
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

      if (e.key === '?' && !isInput && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setOpen((prev) => !prev);
        return;
      }

      if (e.key === 'Escape' && open) {
        e.preventDefault();
        setOpen(false);
      }
    },
    [open],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  if (!open) return null;

  return (
    <div
      className={cn('fixed inset-0 z-[9998] flex items-center justify-center', className)}
      data-testid="keyboard-shortcuts-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t('shortcuts.title', 'Keyboard Shortcuts')}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0"
        style={{ background: 'rgba(0, 0, 0, 0.6)', backdropFilter: 'blur(4px)' }}
        onClick={() => setOpen(false)}
        data-testid="keyboard-shortcuts-backdrop"
      />

      {/* Dialog */}
      <div
        className="relative z-10 w-full max-w-2xl max-h-[80vh] overflow-y-auto rounded-xl"
        style={{
          background: 'var(--sf-bg-card, #12121A)',
          border: '1px solid var(--sf-border, rgba(255,255,255,0.10))',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-6 py-4 border-b"
          style={{ borderColor: 'var(--sf-border, rgba(255,255,255,0.10))' }}
        >
          <h2
            className="text-base font-semibold"
            style={{ color: 'var(--sf-text-primary, #F2F2F2)' }}
          >
            {t('shortcuts.title', 'Keyboard Shortcuts')}
          </h2>
          <button
            className="p-1 rounded hover:bg-surface-2 transition-colors"
            onClick={() => setOpen(false)}
            aria-label={t('common.close', 'Close')}
            data-testid="keyboard-shortcuts-close"
          >
            <X className="w-4 h-4" style={{ color: 'var(--sf-text-secondary, #A3A3A3)' }} />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-6">
          {SHORTCUT_GROUPS.map((group) => (
            <div key={group.titleKey}>
              <h3
                className="text-xs font-semibold uppercase tracking-wider mb-3"
                style={{ color: 'var(--sf-accent, #E8A838)' }}
              >
                {t(group.titleKey, group.fallback)}
              </h3>
              <div className="space-y-2">
                {group.shortcuts.map((shortcut) => (
                  <div
                    key={shortcut.descriptionKey}
                    className="flex items-center justify-between py-1"
                  >
                    <span
                      className="text-xs"
                      style={{ color: 'var(--sf-text-secondary, #A3A3A3)' }}
                    >
                      {t(shortcut.descriptionKey, shortcut.fallback)}
                    </span>
                    <div className="flex items-center gap-1">
                      {shortcut.keys.map((key, i) => (
                        <React.Fragment key={key}>
                          {i > 0 && (
                            <span
                              className="text-[10px] mx-0.5"
                              style={{ color: 'var(--sf-text-muted, #6B6B7B)' }}
                            >
                              +
                            </span>
                          )}
                          <KeyCap label={key} />
                        </React.Fragment>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Footer hint */}
        <div
          className="px-6 py-3 text-center border-t"
          style={{
            borderColor: 'var(--sf-border, rgba(255,255,255,0.10))',
            color: 'var(--sf-text-muted, #6B6B7B)',
          }}
        >
          <span className="text-[11px]">
            {t('shortcuts.pressToClose', 'Press')} <KeyCap label="?" /> {t('shortcuts.or', 'or')}{' '}
            <KeyCap label="Esc" /> {t('shortcuts.toClose', 'to close')}
          </span>
        </div>
      </div>
    </div>
  );
};
