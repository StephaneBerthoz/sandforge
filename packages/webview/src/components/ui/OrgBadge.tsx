import React from 'react';
import { cn } from '../../theme';

/** Props for the OrgBadge component. */
export interface OrgBadgeProps {
  /** Salesforce org alias. */
  alias: string;
  /** Type of the Salesforce org. */
  orgType: string;
  /** Connection status of the org. */
  status: string;
  /** Optional Salesforce instance URL. */
  instanceUrl?: string;
  /** Additional CSS classes. */
  className?: string;
}

const statusColors: Record<string, string> = {
  connected: 'bg-[var(--sf-success)]',
  expired: 'bg-[var(--sf-warning)]',
  error: 'bg-[var(--sf-error)]',
};

const orgTypeConfig: Record<string, { label: string; bg: string }> = {
  Production: { label: 'PROD', bg: 'bg-[var(--sf-error)]' },
  Sandbox: { label: 'SBX', bg: 'bg-[var(--sf-info)]' },
  Scratch: { label: 'SCR', bg: 'bg-[var(--sf-success)]' },
};

/**
 * Displays a Salesforce org connection badge with status indicator,
 * alias, org type label, and optional instance URL.
 */
export const OrgBadge: React.FC<OrgBadgeProps> = ({
  alias,
  orgType,
  status,
  instanceUrl,
  className,
}) => {
  const dotClass = statusColors[status] ?? statusColors.error;
  const typeInfo = orgTypeConfig[orgType] ?? {
    label: orgType.slice(0, 3).toUpperCase(),
    bg: 'bg-[var(--sf-info)]',
  };

  /** Truncate instance URL to hostname only. */
  const truncatedUrl = instanceUrl
    ? instanceUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')
    : undefined;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-[var(--sf-space-2)] px-[var(--sf-space-2)] py-[var(--sf-space-1)]',
        'rounded-[var(--sf-radius-md)]',
        'bg-[var(--sf-bg-card)]',
        'border border-[var(--sf-border-subtle)]',
        'text-[var(--sf-font-size)]',
        className,
      )}
      data-testid="org-badge"
    >
      {/* Status dot */}
      <span
        className={cn('inline-block w-2 h-2 rounded-full shrink-0', dotClass)}
        data-testid="org-badge-status-dot"
        aria-label={`Status: ${status}`}
      />

      {/* Alias */}
      <span
        className="font-semibold text-[var(--sf-text-primary)] truncate"
        data-testid="org-badge-alias"
      >
        {alias}
      </span>

      {/* Org type badge */}
      <span
        className={cn(
          'inline-flex items-center px-1.5 py-0.5',
          'text-[10px] font-bold leading-none',
          'rounded-[var(--sf-radius-sm)]',
          'text-white',
          typeInfo.bg,
        )}
        data-testid="org-badge-type"
      >
        {typeInfo.label}
      </span>

      {/* Instance URL */}
      {truncatedUrl && (
        <span
          className="text-[var(--sf-text-muted)] text-[var(--sf-font-size-sm)] truncate max-w-[160px]"
          data-testid="org-badge-url"
          title={instanceUrl}
        >
          {truncatedUrl}
        </span>
      )}
    </span>
  );
};
