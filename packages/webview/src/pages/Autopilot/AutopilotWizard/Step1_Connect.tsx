import React, { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { SalesforceOrg } from '@sandforge/shared';
import { OrgSafetyTier } from '@sandforge/shared';
import { cn } from '../../../theme';
import { SeedInsteadHint } from '../../../components/ui/SeedInsteadHint';

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

/**
 * Tier color mapping for org cards (keyed by OrgSafetyTier values). The scale
 * has one step more than the severities: high sits in the orange between
 * warning and error.
 */
const tierColors: Record<OrgSafetyTier, string> = {
  [OrgSafetyTier.LOW]: 'border-status-success',
  [OrgSafetyTier.MEDIUM]: 'border-status-warning',
  [OrgSafetyTier.HIGH]: 'border-hue-orange',
  [OrgSafetyTier.CRITICAL]: 'border-status-error',
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
  const idBase = useId();

  /*
   * Which org is picked, and which is connected, were told by a tint and a
   * dot: a screen reader heard two identical lists of org names, and could
   * not tell which org would be written to. Each list is a group named by its
   * label, each org a button pressed when picked, its status said.
   */
  const renderOrgSelector = (
    label: string,
    selectedId: string,
    onSelect: (id: string) => void,
    disabledId: string,
    testIdPrefix: string,
  ): React.ReactNode => (
    <div className="flex flex-col gap-(--sf-space-2)" data-testid={`${testIdPrefix}-selector`}>
      <span
        id={`${idBase}-${testIdPrefix}-label`}
        className="text-sm font-medium text-text-primary"
      >
        {label}
      </span>
      <div
        role="group"
        aria-labelledby={`${idBase}-${testIdPrefix}-label`}
        className="grid grid-cols-1 gap-2 max-h-48 overflow-y-auto"
      >
        {orgs.map((org) => {
          const isSelected = org.id === selectedId;
          const isDisabled = org.id === disabledId;
          const tierClass = org.safetyTier ? tierColors[org.safetyTier] : 'border-(--sf-border)';

          return (
            <button
              key={org.id}
              className={cn(
                'flex items-center gap-3 p-3 rounded-sm border-2 text-left transition-colors',
                isSelected
                  ? 'bg-status-info/10 border-(--sf-accent)'
                  : `bg-(--sf-bg-primary) ${tierClass} hover:bg-(--sf-bg-hover)`,
                'disabled:opacity-40 disabled:cursor-not-allowed',
              )}
              onClick={() => !isDisabled && onSelect(org.id)}
              disabled={isDisabled}
              aria-pressed={isSelected}
              data-testid={`${testIdPrefix}-org-${org.id}`}
            >
              <div
                aria-hidden="true"
                className={cn(
                  'w-2.5 h-2.5 rounded-full shrink-0',
                  org.status === 'connected' ? 'bg-status-success' : 'bg-text-secondary',
                )}
              />
              <div className="flex flex-col min-w-0">
                <span className="text-sm font-medium text-text-primary truncate">
                  {org.alias || org.username}
                </span>
                <span className="sr-only">
                  {t('a11y.orgStatus', { status: t(`org.status_${org.status}`) })}
                </span>
                <span className="text-xs text-text-primary truncate">{org.instanceUrl}</span>
              </div>
              {org.safetyTier && (
                <span className="ml-auto text-xs text-text-primary">{org.safetyTier}</span>
              )}
            </button>
          );
        })}
        {orgs.length === 0 && (
          <p className="text-sm text-text-secondary py-4 text-center">
            {t('autopilot.step1.noOrgs')}
          </p>
        )}
      </div>
    </div>
  );

  // Autopilot copies objects from one org into another: with one org, the
  // second list offers only that org, disabled.
  const connectedCount = orgs.filter((org) => org.status === 'connected').length;

  return (
    <div className="flex flex-col gap-(--sf-space-4)" data-testid="step1-connect">
      <p className="text-sm text-text-secondary">{t('autopilot.step1.description')}</p>
      {connectedCount < 2 && <SeedInsteadHint testId="autopilot-seed-instead" />}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-(--sf-space-4)">
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
