import React from 'react';
import { useTranslation } from 'react-i18next';
import { useOrgStore } from '../../../stores/useOrgStore';
import { Select } from '../../../components/ui/Select';
import { OrgBadge } from '../../../components/ui/OrgBadge';
import { Button } from '../../../components/ui/Button';

/** Props for the QuickSyncOrgStep component. */
export interface QuickSyncOrgStepProps {
  /** Currently selected source org ID. */
  sourceOrgId: string;
  /** Currently selected target org ID. */
  targetOrgId: string;
  /** Callback when source org changes. */
  onSourceChange: (orgId: string) => void;
  /** Callback when target org changes. */
  onTargetChange: (orgId: string) => void;
  /** Callback to proceed to next step. */
  onNext: () => void;
  /** Whether the Next button should be enabled. */
  canGoNext: boolean;
}

/**
 * Quick Sync Screen 1: Source and target org selection.
 *
 * Shows two org picker dropdowns side by side with an arrow between them
 * and OrgBadge previews for selected orgs.
 */
export const QuickSyncOrgStep: React.FC<QuickSyncOrgStepProps> = ({
  sourceOrgId,
  targetOrgId,
  onSourceChange,
  onTargetChange,
  onNext,
  canGoNext,
}) => {
  const { t } = useTranslation();
  const orgs = useOrgStore((s) => s.orgs);

  const orgOptions = orgs.map((org) => ({
    value: org.id,
    label: `${org.alias || org.username} ${String(org.orgType).toLowerCase().includes('production') ? '[PROD]' : '[SBX]'}`,
  }));

  const sourceOrg = orgs.find((o) => o.id === sourceOrgId);
  const targetOrg = orgs.find((o) => o.id === targetOrgId);

  return (
    <div className="flex flex-col gap-4" data-testid="quick-sync-org-step">
      <p className="text-xs text-[var(--vscode-descriptionForeground,#868686)]">
        {t('quickSync.selectOrgs')}
      </p>

      <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-3">
        <Select
          label={t('quickSync.sourceOrg')}
          options={orgOptions}
          value={sourceOrgId}
          onChange={(e) => onSourceChange(e.target.value)}
          placeholder={t('quickSync.sourceOrg')}
          data-testid="quick-sync-source-select"
        />

        <span
          className="codicon codicon-arrow-right text-lg text-[var(--vscode-descriptionForeground,#868686)] pb-1.5"
          aria-hidden="true"
        />

        <Select
          label={t('quickSync.targetOrg')}
          options={orgOptions}
          value={targetOrgId}
          onChange={(e) => onTargetChange(e.target.value)}
          placeholder={t('quickSync.targetOrg')}
          data-testid="quick-sync-target-select"
        />
      </div>

      {(sourceOrg || targetOrg) && (
        <div className="flex items-center gap-3" data-testid="quick-sync-org-badges">
          {sourceOrg && (
            <OrgBadge
              alias={sourceOrg.alias || sourceOrg.username}
              orgType={String(sourceOrg.orgType)}
              status={sourceOrg.status}
              instanceUrl={sourceOrg.instanceUrl}
            />
          )}
          {sourceOrg && targetOrg && (
            <span
              className="codicon codicon-arrow-right text-[var(--vscode-text-secondary)]"
              aria-hidden="true"
            />
          )}
          {targetOrg && (
            <OrgBadge
              alias={targetOrg.alias || targetOrg.username}
              orgType={String(targetOrg.orgType)}
              status={targetOrg.status}
              instanceUrl={targetOrg.instanceUrl}
            />
          )}
        </div>
      )}

      <div className="flex justify-end">
        <Button
          variant="primary"
          onClick={onNext}
          disabled={!canGoNext}
          data-testid="quick-sync-org-next"
        >
          {t('quickSync.next')}
        </Button>
      </div>
    </div>
  );
};
