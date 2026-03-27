import React from 'react';
import { useTranslation } from 'react-i18next';
import type { SalesforceOrg } from '@sandforge/shared';
import { Select } from '../../../components/ui/Select';
import { OrgBadge } from '../../../components/ui/OrgBadge';
import { Badge } from '../../../components/ui/Badge';
import { Skeleton } from '../../../components/ui/Skeleton';
import { ArrowRight } from 'lucide-react';

/** Props for the CloneSourcePicker component. */
export interface CloneSourcePickerProps {
  /** Currently selected source org ID. */
  sourceOrgId: string;
  /** Target org ID to exclude from source list and display. */
  targetOrgId: string;
  /** All connected orgs. */
  orgs: SalesforceOrg[];
  /** Callback when a source org is selected. */
  onSourceSelected: (orgId: string) => void;
  /** Whether source objects are being loaded. */
  loading?: boolean;
}

/**
 * Two-column picker showing source org (selectable) and target org (read-only),
 * with a directional arrow between them indicating clone direction.
 */
export const CloneSourcePicker: React.FC<CloneSourcePickerProps> = ({
  sourceOrgId,
  targetOrgId,
  orgs,
  onSourceSelected,
  loading = false,
}) => {
  const { t } = useTranslation();

  const availableSourceOrgs = orgs.filter((org) => org.id !== targetOrgId);
  const selectedSourceOrg = orgs.find((org) => org.id === sourceOrgId);
  const targetOrg = orgs.find((org) => org.id === targetOrgId);

  return (
    <div className="flex flex-col gap-[var(--sf-space-3)]" data-testid="clone-source-picker">
      <span className="text-sm font-semibold text-[var(--vscode-editor-foreground,#d4d4d4)]">
        {t('seed.clone.sourcePicker.title')}
      </span>

      <div className="grid grid-cols-[1fr_auto_1fr] items-start gap-[var(--sf-space-4)]">
        {/* Source org column */}
        <div className="flex flex-col gap-[var(--sf-space-2)]" data-testid="clone-source-column">
          <span className="text-xs font-medium text-[var(--vscode-descriptionForeground,#868686)]">
            {t('seed.clone.sourcePicker.sourceLabel')}
          </span>
          <Select
            label={t('seed.clone.sourcePicker.sourceLabel')}
            options={availableSourceOrgs.map((org) => ({
              value: org.id,
              label: `${org.alias || org.username} (${String(org.orgType).toLowerCase()})`,
            }))}
            value={sourceOrgId}
            onChange={(e) => onSourceSelected(e.target.value)}
            placeholder={t('seed.clone.sourcePicker.selectSource')}
            data-testid="clone-source-select"
          />
          {loading && (
            <Skeleton variant="text" width="60%" height="1em" />
          )}
          {selectedSourceOrg && (
            <OrgBadge
              alias={selectedSourceOrg.alias || selectedSourceOrg.username}
              orgType={String(selectedSourceOrg.orgType)}
              status={selectedSourceOrg.status}
              instanceUrl={selectedSourceOrg.instanceUrl}
            />
          )}
        </div>

        {/* Direction arrow */}
        <div
          className="flex items-center justify-center pt-6"
          data-testid="clone-direction-arrow"
          aria-label={t('seed.clone.sourcePicker.direction')}
        >
          <ArrowRight
            size={24}
            className="text-[var(--vscode-focusBorder,#007fd4)]"
          />
        </div>

        {/* Target org column (read-only) */}
        <div className="flex flex-col gap-[var(--sf-space-2)]" data-testid="clone-target-column">
          <span className="text-xs font-medium text-[var(--vscode-descriptionForeground,#868686)]">
            {t('seed.clone.sourcePicker.targetLabel')}
          </span>
          <span className="text-xs text-[var(--vscode-descriptionForeground,#868686)]">
            {t('seed.clone.sourcePicker.targetHint')}
          </span>
          {targetOrg && (
            <OrgBadge
              alias={targetOrg.alias || targetOrg.username}
              orgType={String(targetOrg.orgType)}
              status={targetOrg.status}
              instanceUrl={targetOrg.instanceUrl}
            />
          )}
        </div>
      </div>

      {/* Same-org warning (defensive) */}
      {sourceOrgId && sourceOrgId === targetOrgId && (
        <span data-testid="clone-same-org-warning">
          <Badge variant="warning">
            {t('seed.clone.sourcePicker.sameOrgWarning')}
          </Badge>
        </span>
      )}
    </div>
  );
};
