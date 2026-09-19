import React, { useState } from 'react';
import { cn } from '../../theme';

/** Tab definition. */
export interface TabItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
  disabled?: boolean;
}

/** Tabs component props. */
export interface TabsProps {
  tabs: TabItem[];
  activeTab?: string;
  onTabChange?: (tabId: string) => void;
  className?: string;
}

/** Tab navigation matching VSCode theme. */
export const Tabs: React.FC<TabsProps> = ({ tabs, activeTab, onTabChange, className }) => {
  const [internalActive, setInternalActive] = useState(tabs[0]?.id ?? '');
  const current = activeTab ?? internalActive;

  const handleClick = (tabId: string) => {
    if (onTabChange) {
      onTabChange(tabId);
    } else {
      setInternalActive(tabId);
    }
  };

  /**
   * Arrow keys walk the tabs, as the tab pattern says they must.
   *
   * A `role="tablist"` promises that Left and Right move between the tabs and
   * that only one of them is in the page's tab order — a promise this made
   * and did not keep, so a keyboard user tabbed through every tab one at a
   * time and arrow keys did nothing. Disabled tabs are stepped over, and the
   * ends wrap.
   */
  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    const selectable = tabs.filter((t) => !t.disabled);
    if (selectable.length === 0) return;

    let next: TabItem | undefined;
    if (step !== 0) {
      const at = selectable.findIndex((t) => t.id === current);
      const from = at === -1 ? 0 : at;
      next = selectable[(from + step + selectable.length) % selectable.length];
    } else if (event.key === 'Home') {
      next = selectable[0];
    } else if (event.key === 'End') {
      next = selectable[selectable.length - 1];
    }
    if (!next) return;

    event.preventDefault();
    handleClick(next.id);
    // The newly selected tab is the only one in the tab order, so focus has
    // to follow the selection or it lands nowhere. Found by position among
    // the tab buttons rather than by a selector built from the id: an id is
    // caller-supplied, and `CSS.escape` is not everywhere (jsdom has no such
    // thing, and this threw there while the tests still passed).
    const at = tabs.findIndex((t) => t.id === next.id);
    const list = event.currentTarget.parentElement;
    const buttons = list?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    buttons?.[at]?.focus();
  };

  return (
    <div
      className={cn('flex border-b border-[var(--vscode-panel-border,#3c3c3c)]', className)}
      role="tablist"
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={current === tab.id}
          aria-controls={`tabpanel-${tab.id}`}
          id={`tab-${tab.id}`}
          // Roving: one stop in the page's tab order, arrows for the rest.
          tabIndex={current === tab.id ? 0 : -1}
          onKeyDown={handleKeyDown}
          disabled={tab.disabled}
          className={cn(
            'px-3 py-2 text-sm font-medium transition-colors',
            'border-b-2 -mb-px',
            current === tab.id
              ? 'border-[var(--vscode-focusBorder,#007fd4)] text-[var(--vscode-editor-foreground,#d4d4d4)]'
              : 'border-transparent text-[var(--vscode-descriptionForeground,#868686)] hover:text-[var(--vscode-editor-foreground,#d4d4d4)]',
            tab.disabled && 'opacity-50 cursor-not-allowed',
          )}
          onClick={() => !tab.disabled && handleClick(tab.id)}
        >
          {tab.icon && <span className="mr-1.5 inline-flex">{tab.icon}</span>}
          {tab.label}
        </button>
      ))}
    </div>
  );
};
