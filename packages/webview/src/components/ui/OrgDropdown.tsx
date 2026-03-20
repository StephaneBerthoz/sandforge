import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../theme';
import type { SalesforceOrg } from '@sandforge/shared';

/** Props for the OrgDropdown component. */
export interface OrgDropdownProps {
  /** Currently selected org ID. */
  value: string;
  /** Callback when an org is selected. */
  onChange: (orgId: string) => void;
  /** List of available orgs. */
  orgs: SalesforceOrg[];
  /** Accessible label for the dropdown. */
  ariaLabel: string;
  /** data-testid for the root element. */
  testId?: string;
  /** Additional CSS classes. */
  className?: string;
}

/** CSS class for org status indicator dot. */
function statusDotColor(status: string): string {
  switch (status) {
    case 'connected':
      return 'bg-green-500';
    case 'refreshing':
      return 'bg-yellow-500';
    default:
      return 'bg-red-500';
  }
}

/**
 * Custom styled dropdown for org selection.
 * Shows the selected org with status dot, alias, and username.
 * Opens a dropdown list on click with keyboard and click-outside support.
 */
export const OrgDropdown: React.FC<OrgDropdownProps> = ({
  value,
  onChange,
  orgs,
  ariaLabel,
  testId = 'org-dropdown',
  className,
}) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedOrg = orgs.find((o) => o.id === value);

  /** Sort orgs: connected first, then alphabetically by alias. */
  const sortedOrgs = [...orgs].sort((a, b) => {
    if (a.status === 'connected' && b.status !== 'connected') return -1;
    if (a.status !== 'connected' && b.status === 'connected') return 1;
    return (a.alias || a.username).localeCompare(b.alias || b.username);
  });

  /** Close dropdown on click outside. */
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  /** Close dropdown on Escape key. */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    },
    [open],
  );

  /** Select an org and close. */
  const handleSelect = useCallback(
    (orgId: string) => {
      onChange(orgId);
      setOpen(false);
    },
    [onChange],
  );

  return (
    <div ref={containerRef} className={cn('relative', className)} onKeyDown={handleKeyDown}>
      {/* Trigger button */}
      <button
        type="button"
        data-testid={testId}
        aria-label={ariaLabel}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cn(
          'w-full flex items-center gap-2 text-sm font-semibold cursor-pointer',
          'focus:outline-none',
          selectedOrg ? 'text-text-primary' : 'text-text-muted',
        )}
      >
        {selectedOrg && (
          <div className={cn('w-2 h-2 rounded-full shrink-0', statusDotColor(selectedOrg.status))} />
        )}
        <span className="truncate flex-1 text-left">
          {selectedOrg ? (selectedOrg.alias || selectedOrg.username) : t('forge.selectOrg')}
        </span>
        <ChevronDown
          size={14}
          className={cn('text-text-muted shrink-0 transition-transform', open && 'rotate-180')}
        />
      </button>

      {/* Dropdown panel */}
      {open && (
        <div
          className={cn(
            'absolute z-50 top-full left-0 right-0 mt-1',
            'rounded-md border border-subtle bg-surface-1 shadow-lg',
            'max-h-48 overflow-y-auto py-1',
          )}
          data-testid={`${testId}-panel`}
        >
          {/* Empty option */}
          <button
            type="button"
            data-testid={`${testId}-option-empty`}
            onClick={() => handleSelect('')}
            className="w-full text-left px-3 py-1.5 text-sm text-text-muted hover:bg-surface-2 transition-colors"
          >
            {t('forge.selectOrg')}
          </button>
          {sortedOrgs.map((org) => (
            <button
              key={org.id}
              type="button"
              data-testid={`${testId}-option-${org.id}`}
              onClick={() => handleSelect(org.id)}
              className={cn(
                'w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 transition-colors',
                org.id === value
                  ? 'bg-forge/10 text-forge'
                  : 'text-text-secondary hover:bg-surface-2',
              )}
            >
              <div className={cn('w-2 h-2 rounded-full shrink-0', statusDotColor(org.status))} />
              <span className="truncate">{org.alias || org.username}</span>
              {org.alias && (
                <span className="text-[10px] text-text-muted truncate ml-auto">{org.username}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
