import React from 'react';
import { cn } from '../../theme';
import { Icon, type IconName } from './Icon';
import { handleTabListKeyDown } from './tabListKeys';

/** Single tab definition for PageTabs. */
export interface PageTab {
  /** Unique tab identifier. */
  id: string;
  /** Display label. */
  label: string;
  /** Optional name of the tab's icon. */
  icon?: IconName;
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
 * Renders icons, labels, and optional badge counts with
 * an accent underline on the active tab.
 */
export const PageTabs: React.FC<PageTabsProps> = ({ tabs, activeTab, onTabChange, className }) => {
  /**
   * Arrow keys walk the tabs, as `role="tablist"` promises they will: the
   * keys every tab bar of the panel shares (`tabListKeys`).
   */
  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void =>
    handleTabListKeyDown(
      event,
      tabs.map((t) => t.id),
      activeTab,
      onTabChange,
    );

  return (
    <div
      className={cn('flex w-full border-b border-(--sf-border)', 'bg-(--sf-bg-primary)', className)}
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
              'relative flex items-center gap-(--sf-space-2)',
              'px-(--sf-space-4) py-(--sf-space-3)',
              // `length:` says it is a size: bare, the value compiled to a text colour.
              'text-(length:--sf-font-size) font-medium',
              'border-b-2 -mb-px',
              'transition-colors',
              'cursor-pointer',
              'bg-transparent border-x-0 border-t-0',
              isActive
                ? 'border-(--sf-accent) text-(--sf-text-primary)'
                : 'border-transparent text-(--sf-text-secondary) hover:text-(--sf-text-primary)',
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
                  isActive ? 'text-(--sf-text-primary)' : 'text-(--sf-text-secondary)',
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
                  'bg-(--sf-button-bg) text-(--sf-button-fg)',
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
