import React from 'react';
import { useTranslation } from 'react-i18next';
import type { SalesforceOrg } from '@sandforge/shared';
import { OrgSafetyTier } from '@sandforge/shared';
import { cn } from '../../../theme';

/** Step1Connect component props. */
export interface Step1ConnectProps {
  /** Available Salesforce orgs */
  readonly orgs: SalesforceOrg[];
  /** Currently selected source org ID */
  readonly sourceOrgId: string;
  /** Currently selected target org ID */
  readonly targetOrgId: string;
  /** Callback when source org is selected */
  readonly onSourceSelect: (orgId: string) => void;
  /** Callback when target org is selected */
  readonly onTargetSelect: (orgId: string) => void;
}

/** Tier color mapping for org cards (keyed by OrgSafetyTier values). */
const tierColors: Record<OrgSafetyTier, string> = {
  [OrgSafetyTier.LOW]: 'border-green-600',
  [OrgSafetyTier.MEDIUM]: 'border-amber-500',
  [OrgSafetyTier.HIGH]: 'border-orange-600',
  [OrgSafetyTier.CRITICAL]: 'border-red-600',
};

/** Step 1: Select source and target orgs. */
export const Step1Connect: React.FC<Step1ConnectProps> = ({
  orgs,
  sourceOrgId,
  targetOrgId,
  onSourceSelect,
  onTargetSelect,
}) => {
  const { t } = useTranslation();

  const renderOrgSelector = (
    label: string,
    selectedId: string,
    onSelect: (id: string) => void,
    disabledId: string,
    testIdPrefix: string,
  ): React.ReactNode => (
    <div className="flex flex-col gap-[var(--sf-space-2)]" data-testid={`${testIdPrefix}-selector`}>
      <span className="text-sm font-medium text-[var(--vscode-editor-foreground,#d4d4d4)]">
        {label}
      </span>
      <div className="grid grid-cols-1 gap-2 max-h-48 overflow-y-auto">
        {orgs.map((org) => {
          const isSelected = org.id === selectedId;
          const isDisabled = org.id === disabledId;
          const tierClass = org.safetyTier
            ? tierColors[org.safetyTier]
            : 'border-[var(--vscode-panel-border,#3c3c3c)]';

          return (
            <button
              key={org.id}
              className={cn(
                'flex items-center gap-3 p-3 rounded border-2 text-left transition-colors',
                isSelected
                  ? 'bg-[var(--vscode-list-activeSelectionBackground,#094771)] border-[var(--vscode-focusBorder,#007fd4)]'
                  : `bg-[var(--vscode-editor-background,#1e1e1e)] ${tierClass} hover:bg-[var(--vscode-list-hoverBackground,#2a2d2e)]`,
                isDisabled && 'opacity-40 cursor-not-allowed',
              )}
              onClick={() => !isDisabled && onSelect(org.id)}
              disabled={isDisabled}
              data-testid={`${testIdPrefix}-org-${org.id}`}
            >
              <div
                className={cn(
                  'w-2.5 h-2.5 rounded-full shrink-0',
                  org.status === 'connected' ? 'bg-green-500' : 'bg-gray-500',
                )}
              />
              <div className="flex flex-col min-w-0">
                <span className="text-sm font-medium text-[var(--vscode-editor-foreground,#d4d4d4)] truncate">
                  {org.alias || org.username}
                </span>
                <span className="text-xs text-[var(--vscode-descriptionForeground,#868686)] truncate">
                  {org.instanceUrl}
                </span>
              </div>
              {org.safetyTier && (
                <span className="ml-auto text-xs text-[var(--vscode-descriptionForeground,#868686)]">
                  {org.safetyTier}
                </span>
              )}
            </button>
          );
        })}
        {orgs.length === 0 && (
          <p className="text-sm text-[var(--vscode-descriptionForeground,#868686)] py-4 text-center">
            {t('autopilot.step1.noOrgs')}
          </p>
        )}
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-[var(--sf-space-4)]" data-testid="step1-connect">
      <p className="text-sm text-[var(--vscode-descriptionForeground,#868686)]">
        {t('autopilot.step1.description')}
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-[var(--sf-space-4)]">
        {renderOrgSelector(
          t('autopilot.step1.sourceOrg'),
          sourceOrgId,
          onSourceSelect,
          targetOrgId,
          'source',
        )}
        {renderOrgSelector(
          t('autopilot.step1.targetOrg'),
          targetOrgId,
          onTargetSelect,
          sourceOrgId,
          'target',
        )}
      </div>
    </div>
  );
};
