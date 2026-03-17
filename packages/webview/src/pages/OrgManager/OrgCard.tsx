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
}

const statusBadgeVariant: Record<string, BadgeVariant> = {
  connected: 'success',
  expired: 'warning',
  error: 'error',
  refreshing: 'info',
};


/** Status indicator dot color. */
const statusDotColor: Record<string, string> = {
  connected: 'bg-emerald-400',
  expired: 'bg-yellow-400',
  error: 'bg-red-400',
  refreshing: 'bg-blue-400',
};

/** Card displaying a single Salesforce org with prominent environment type. */
export const OrgCard: React.FC<OrgCardProps> = ({
  org,
  selected,
  onSelect,
  onEdit,
  onDisconnect,
}) => {
  const { t } = useTranslation();
  const typeStyle = ORG_TYPE_STYLES[org.orgType] ?? ORG_TYPE_STYLE_DEFAULT;
  const envLabel = orgTypeLabel(org);

  return (
    <div
      className={cn(
        'rounded-lg border p-3 cursor-pointer transition-all',
        'bg-[var(--vscode-editor-background,#1e1e1e)]',
        selected
          ? 'border-[var(--vscode-focusBorder,#007fd4)] ring-1 ring-[var(--vscode-focusBorder,#007fd4)]'
          : 'border-[var(--vscode-panel-border,#3c3c3c)] hover:border-[var(--vscode-focusBorder,#007fd4)]',
      )}
      onClick={() => onSelect(org.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onSelect(org.id); }}
      data-testid={`org-card-${org.id}`}
    >
      {/* Row 1: Env badge + alias + status */}
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'px-2 py-0.5 text-[10px] font-bold rounded border shrink-0',
            typeStyle,
          )}
          data-testid={`org-type-badge-${org.id}`}
        >
          {envLabel}
        </span>
        <span className="text-sm font-semibold text-[var(--vscode-editor-foreground,#d4d4d4)] truncate flex-1">
          {org.alias}
        </span>
        <div className="flex items-center gap-1.5 shrink-0">
          <span className={cn('w-2 h-2 rounded-full', statusDotColor[org.status] ?? 'bg-gray-400')} />
          <Badge variant={statusBadgeVariant[org.status] ?? 'default'}>
            {t(`org.status_${org.status}`)}
          </Badge>
        </div>
      </div>

      {/* Row 2: Username + instance */}
      <div className="mt-1.5 flex items-center gap-3 text-[11px] text-[var(--vscode-descriptionForeground,#868686)]">
        <span className="truncate">{org.username}</span>
        <span className="opacity-40">|</span>
        <span className="truncate">{org.instanceUrl}</span>
      </div>

      {/* Row 3: Tags */}
      {org.tags.length > 0 && (
        <div className="mt-2 flex gap-1 flex-wrap">
          {org.tags.map((tag) => (
            <span
              key={tag}
              className="px-1.5 py-0.5 text-[10px] rounded bg-[var(--vscode-badge-background,#4d4d4d)] text-[var(--vscode-badge-foreground,#fff)]"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Row 4: Actions */}
      <div className="mt-2 flex gap-2 justify-end">
        <button
          className="text-xs text-[var(--vscode-textLink-foreground,#3794ff)] hover:underline"
          onClick={(e) => { e.stopPropagation(); onEdit(org); }}
        >
          {t('common.edit')}
        </button>
        <button
          className="text-xs text-[var(--vscode-errorForeground,#f48771)] hover:underline"
          onClick={(e) => { e.stopPropagation(); onDisconnect(org.id); }}
        >
          {t('org.disconnect')}
        </button>
      </div>
    </div>
  );
};
