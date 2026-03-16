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

  return (
    <div className={cn('flex border-b border-[var(--vscode-panel-border,#3c3c3c)]', className)} role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={current === tab.id}
          aria-controls={`tabpanel-${tab.id}`}
          id={`tab-${tab.id}`}
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
