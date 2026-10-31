import React from 'react';
import { useTranslation } from 'react-i18next';
import type { SalesforceOrg } from '@sandforge/shared';
import { guardTierOf, registeredOrgType } from '@sandforge/shared';
import { cn } from '../../theme';
import { orgTypeLabel } from '../../utils/orgFormatters';

/** Props for the OrgBadge component. */
export interface OrgBadgeProps {
  /**
   * The org, as the store holds it. The badge used to be handed its type as a
   * bare string and wrote PROD, SBX, SCR or STG in English whatever the
   * language, while the side panel and the pickers named the same org by its
   * translated type: one org, two labels from one page to the next.
   */
  org: SalesforceOrg;
  /** Additional CSS classes. */
  className?: string;
}

const statusColors: Record<string, string> = {
  connected: 'bg-(--sf-success)',
  expired: 'bg-(--sf-warning)',
  error: 'bg-(--sf-error)',
};

/**
 * The fill of the type label. It writes in the editor background, which each
 * severity token is sized to read against on every measured theme but
 * Solarized Light: white on the raw errorForeground read 2.5:1 on Dark+.
 *
 * Keyed on the type the org is read with (`registeredOrgType`), the one
 * {@link orgTypeLabel} names: a Developer Edition org an earlier build
 * registered as a production org wore a red PROD. A sandbox marked Staging,
 * which Production Guard asks about, is told apart from the others.
 */
function typeFillOf(org: SalesforceOrg): string {
  if (guardTierOf(org) === 'staging') return 'bg-status-warning';
  const orgType = registeredOrgType(org.orgType, org.metadata?.edition);
  if (orgType === 'Production') return 'bg-status-error';
  if (orgType === 'Scratch') return 'bg-status-success';
  return 'bg-status-info';
}

/**
 * Displays a Salesforce org connection badge with status indicator,
 * alias, org type label, and optional instance URL.
 */
export const OrgBadge: React.FC<OrgBadgeProps> = ({ org, className }) => {
  const { t, i18n } = useTranslation();
  const { status, instanceUrl } = org;
  const dotClass = statusColors[status] ?? statusColors.error;
  // A status the catalogue has no word for is read as the host wrote it.
  const statusKey = `common.orgStatus_${status}`;
  const statusLabel = i18n.exists(statusKey) ? t(statusKey) : status;

  /** Truncate instance URL to hostname only. */
  const truncatedUrl = instanceUrl
    ? instanceUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')
    : undefined;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-(--sf-space-2) px-(--sf-space-2) py-(--sf-space-1)',
        'rounded-(--sf-radius-md)',
        'bg-(--sf-bg-card)',
        'border border-(--sf-border-subtle)',
        // `length:` says it is a size: bare, the value compiled to a text colour.
        'text-(length:--sf-font-size)',
        className,
      )}
      data-testid="org-badge"
    >
      {/* Status dot. A bare span may not carry a label: axe refused it on the
          Seed page as soon as an org was picked, and a screen reader skipped
          it. As an image, the dot's label is what is read for its colour. */}
      <span
        className={cn('inline-block w-2 h-2 rounded-full shrink-0', dotClass)}
        data-testid="org-badge-status-dot"
        role="img"
        aria-label={t('a11y.orgStatus', { status: statusLabel })}
      />

      {/* Alias */}
      <span
        className="font-semibold text-(--sf-text-primary) truncate"
        data-testid="org-badge-alias"
      >
        {org.alias || org.username}
      </span>

      {/* Org type badge: the label the side panel and the pickers give it. */}
      <span
        className={cn(
          'inline-flex items-center px-1.5 py-0.5 whitespace-nowrap',
          'text-[10px] font-bold leading-none',
          'rounded-(--sf-radius-sm)',
          'text-(--sf-bg-primary)',
          typeFillOf(org),
        )}
        data-testid="org-badge-type"
      >
        {orgTypeLabel(org, t)}
      </span>

      {/* Instance URL */}
      {truncatedUrl && (
        <span
          className="text-text-secondary text-(length:--sf-font-size-sm) truncate max-w-[160px]"
          data-testid="org-badge-url"
          title={instanceUrl}
        >
          {truncatedUrl}
        </span>
      )}
    </span>
  );
};
