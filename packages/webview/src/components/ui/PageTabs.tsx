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
            id={`page-tab-btn-${tab.id}`}
            className={cn(
              'relative flex items-center gap-[var(--sf-space-2)]',
              'px-[var(--sf-space-4)] py-[var(--sf-space-3)]',
              'text-[var(--sf-font-size)] font-medium',
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
                  'bg-[var(--sf-accent)] text-[var(--sf-button-fg)]',
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
