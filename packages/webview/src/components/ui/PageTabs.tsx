import React from 'react';
import { cn } from '../../theme';
import { Icon } from './Icon';

/** Single tab definition for PageTabs. */
export interface PageTab {
  /** Unique tab identifier. */
  id: string;
  /** Display label. */
  label: string;
  /** Optional codicon name for tab icon. */
  icon?: string;
  /** Optional badge count displayed next to the label. */
  badge?: number;
}

/** Props for the PageTabs component. */
export interface PageTabsProps {
  /** List of tabs to display. */
  tabs: PageTab[];
  /** ID of the currently active tab. */
  activeTab: string;
  /** Callback fired when a tab is selected. */
  onTabChange: (tabId: string) => void;
  /** Additional CSS classes. */
  className?: string;
}

/**
 * Full-width horizontal tab bar for module pages.
 * Renders codicon icons, labels, and optional badge counts with
 * an accent underline on the active tab.
 */
export const PageTabs: React.FC<PageTabsProps> = ({ tabs, activeTab, onTabChange, className }) => {
  /**
   * Arrow keys walk the tabs, as `role="tablist"` promises they will.
   *
   * The sibling `Tabs` component makes the same promise and now keeps it the
   * same way; the two disagreed, and neither moved on an arrow key.
   */
  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (tabs.length === 0) return;
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    let next: (typeof tabs)[number] | undefined;
    if (step !== 0) {
      const at = tabs.findIndex((t) => t.id === activeTab);
      const from = at === -1 ? 0 : at;
      next = tabs[(from + step + tabs.length) % tabs.length];
    } else if (event.key === 'Home') {
      next = tabs[0];
    } else if (event.key === 'End') {
      next = tabs[tabs.length - 1];
    }
    if (!next) return;

    event.preventDefault();
    onTabChange(next.id);
    // By position, not by a selector built from a caller-supplied id: see the
    // same handler in `Tabs.tsx`.
    const at = tabs.findIndex((t) => t.id === next.id);
    const list = event.currentTarget.parentElement;
    const buttons = list?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    buttons?.[at]?.focus();
  };

  return (
    <div
      className={cn(
        'flex w-full border-b border-[var(--sf-border)]',
        'bg-[var(--sf-bg-primary)]',
        className,
      )}
      role="tablist"
      data-testid="page-tabs"
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeTab;

        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            // No `aria-controls` here on purpose. The sibling `Tabs` renders
            // its panels and can name them; this bar is rendered on its own
            // and the page puts its content elsewhere, with no matching id.
            // An `aria-controls` pointing at nothing is worse than none —
            // axe calls it critical, and it is right to.
            id={`page-tab-btn-${tab.id}`}
            // Roving: one stop in the page's tab order, arrows for the rest.
            tabIndex={isActive ? 0 : -1}
            onKeyDown={handleKeyDown}
            className={cn(
              'relative flex items-center gap-[var(--sf-space-2)]',
              'px-[var(--sf-space-4)] py-[var(--sf-space-3)]',
              // `length:` says it is a size: bare, the value compiled to a text colour.
              'text-[length:var(--sf-font-size)] font-medium',
              'border-b-2 -mb-px',
              'transition-colors',
              'cursor-pointer',
              'bg-transparent border-x-0 border-t-0',
              isActive
                ? 'border-[var(--sf-accent)] text-[var(--sf-text-primary)]'
                : 'border-transparent text-[var(--sf-text-secondary)] hover:text-[var(--sf-text-primary)]',
            )}
            style={{ transitionDuration: 'var(--sf-transition-fast)' }}
            onClick={() => onTabChange(tab.id)}
            data-testid={`page-tab-${tab.id}`}
          >
            {tab.icon && (
              <Icon
                name={tab.icon}
                className={cn(
                  'text-[14px]',
                  isActive ? 'text-[var(--sf-text-primary)]' : 'text-[var(--sf-text-secondary)]',
                )}
              />
            )}

            <span>{tab.label}</span>

            {tab.badge !== undefined && tab.badge > 0 && (
              <span
                className={cn(
                  'inline-flex items-center justify-center',
                  'min-w-[18px] h-[18px] px-1',
                  'text-[10px] font-bold leading-none rounded-full',
                  'bg-[var(--sf-button-bg)] text-[var(--sf-button-fg)]',
                )}
                data-testid={`page-tab-badge-${tab.id}`}
              >
                {tab.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
};
