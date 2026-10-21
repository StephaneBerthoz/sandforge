import React, { useState } from 'react';
import { cn } from '../../theme';
import { handleTabListKeyDown } from './tabListKeys';

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
   * ends wrap: `tabListKeys`, which every tab bar of the panel shares.
   */
  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void =>
    handleTabListKeyDown(
      event,
      tabs.map((t) => t.id),
      current,
      handleClick,
      new Set(tabs.filter((t) => t.disabled).map((t) => t.id)),
    );

  return (
    <div
      className={cn('flex border-b border-(--vscode-panel-border,#3c3c3c)', className)}
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
              ? 'border-(--vscode-focusBorder,#007fd4) text-(--vscode-editor-foreground,#d4d4d4)'
              : 'border-transparent text-(--vscode-descriptionForeground,#868686) hover:text-(--vscode-editor-foreground,#d4d4d4)',
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
