import React from 'react';
import { useTranslation } from 'react-i18next';
import type { SalesforceOrg } from '@sandforge/shared';
import { cn } from '../../theme';
import { ORG_TYPE_STYLES, ORG_TYPE_STYLE_DEFAULT } from '../../theme/orgStyles';
import { orgTypeLabel } from '../../utils/orgFormatters';
import { Badge } from '../../components/ui/Badge';
import type { BadgeVariant } from '../../components/ui/Badge';

/** OrgCard component props. */
export interface OrgCardProps {
  org: SalesforceOrg;
  selected?: boolean;
  onSelect: (id: string) => void;
  onEdit: (org: SalesforceOrg) => void;
  onDisconnect: (id: string) => void;
  /** Offered on an expired or failed org, whose badge alone left no way forward. */
  onReconnect?: (org: SalesforceOrg) => void;
}

const statusBadgeVariant: Record<string, BadgeVariant> = {
  connected: 'success',
  expired: 'warning',
  error: 'error',
  refreshing: 'info',
};

/** Status indicator dot color. */
const statusDotColor: Record<string, string> = {
  connected: 'bg-status-success',
  expired: 'bg-status-warning',
  error: 'bg-status-error',
  refreshing: 'bg-status-info',
};

/** Card displaying a single Salesforce org with prominent environment type. */
export const OrgCard: React.FC<OrgCardProps> = ({
  org,
  selected,
  onSelect,
  onEdit,
  onDisconnect,
  onReconnect,
}) => {
  const { t } = useTranslation();
  const typeStyle = ORG_TYPE_STYLES[org.orgType] ?? ORG_TYPE_STYLE_DEFAULT;
  const envLabel = orgTypeLabel(org, t);
  const canReconnect = onReconnect && (org.status === 'expired' || org.status === 'error');

  return (
    <div
      className={cn(
        'rounded-lg border p-3 cursor-pointer transition-all',
        'bg-(--sf-bg-primary)',
        selected
          ? 'border-(--sf-accent) ring-1 ring-(--sf-accent)'
          : 'border-(--sf-border) hover:border-(--sf-accent)',
      )}
      onClick={() => onSelect(org.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onSelect(org.id);
      }}
      data-testid={`org-card-${org.id}`}
    >
      {/* Row 1: Env badge + alias + status */}
      <div className="flex items-center gap-2">
        <span
          className={cn('px-2 py-0.5 text-[10px] font-bold rounded-sm border shrink-0', typeStyle)}
          data-testid={`org-type-badge-${org.id}`}
        >
          {envLabel}
        </span>
        <span className="text-sm font-semibold text-text-primary truncate flex-1">{org.alias}</span>
        <div className="flex items-center gap-1.5 shrink-0">
          <span
            className={cn(
              'w-2 h-2 rounded-full',
              statusDotColor[org.status] ?? 'bg-text-secondary',
            )}
          />
          <Badge variant={statusBadgeVariant[org.status] ?? 'default'}>
            {t(`org.status_${org.status}`)}
          </Badge>
        </div>
      </div>

      {/* Row 2: Username + instance */}
      <div className="mt-1.5 flex items-center gap-3 text-[11px] text-text-secondary">
        <span className="truncate">{org.username}</span>
        <span aria-hidden="true">|</span>
        <span className="truncate">{org.instanceUrl}</span>
      </div>

      {/* Row 3: Tags */}
      {org.tags.length > 0 && (
        <div className="mt-2 flex gap-1 flex-wrap">
          {org.tags.map((tag) => (
            <span
              key={tag}
              className="px-1.5 py-0.5 text-[10px] rounded-sm bg-(--sf-badge-bg) text-(--sf-badge-fg)"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Row 4: Actions */}
      <div className="mt-2 flex gap-2 justify-end">
        {canReconnect && (
          <button
            className="text-xs text-(--sf-text-link) hover:underline"
            onClick={(e) => {
              e.stopPropagation();
              onReconnect(org);
            }}
            data-testid={`org-reconnect-${org.id}`}
          >
            {t('monitor.tryReconnect')}
          </button>
        )}
        <button
          className="text-xs text-(--sf-text-link) hover:underline"
          onClick={(e) => {
            e.stopPropagation();
            onEdit(org);
          }}
        >
          {t('common.edit')}
        </button>
        <button
          className="text-xs text-status-error hover:underline"
          onClick={(e) => {
            e.stopPropagation();
            onDisconnect(org.id);
          }}
        >
          {t('org.disconnect')}
        </button>
      </div>
    </div>
  );
};
