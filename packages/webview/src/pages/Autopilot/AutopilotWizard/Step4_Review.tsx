import React from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AnonymizationSummary,
  AutopilotLookupLeftEmpty,
  AutopilotPlanScope,
  ComplianceFrameworkType,
  ExpectedPersonalData,
} from '@sandforge/shared';
import { Button } from '../../../components/ui/Button';
import { ErrorBanner } from '../../../components/ui/ErrorBanner';
import { uiLocale } from '../../../utils/formatters';
import { CompliancePicker } from './CompliancePicker';

/** Step4Review component props. */
export interface Step4ReviewProps {
  /** Source org ID */
  readonly sourceOrgId: string;
  /** Target org ID */
  readonly targetOrgId: string;
  /** Selected object API names */
  readonly selectedObjects: string[];
  /** Total records to transfer */
  readonly totalRecords: number;
  /** Estimated API calls */
  readonly estimatedApiCalls: number;
  /** Estimated duration in minutes */
  readonly estimatedDurationMin: number;
  /** Number of execution waves in the generated plan */
  readonly waves: number;
  /** PII fields detected by the generated plan */
  readonly piiFields: number;
  /** Fields the plan will anonymize */
  readonly anonymizedFields: number;
  /** Selected compliance framework */
  readonly complianceFramework: ComplianceFrameworkType;
  /** Another framework picked: the plan is built again for it. */
  readonly onFrameworkChange: (framework: ComplianceFrameworkType) => void;
  /** Whether the run neutralizes emails and phone numbers before it writes them. */
  readonly neutralizeContactPoints: boolean;
  /** Tick or untick the neutralization. */
  readonly onNeutralizeChange: (on: boolean) => void;
  /** Whether the plan is being built again, after another framework was picked. */
  readonly planning?: boolean;
  /** Whether execution is in progress */
  readonly isExecuting: boolean;
  /** Last execution error (e.g. production guard declined), if any */
  readonly error?: string | null;
  /** What the plan copies of each object and what it leaves out, as the scan found it. */
  readonly scope?: AutopilotPlanScope;
  /** The person objects whose names, emails or phones no rule anonymizes. */
  readonly notCovered?: AnonymizationSummary['notCovered'];
  /** Callback to start execution */
  readonly onExecute: () => void;
}

/**
 * The review step, the last: the plan's numbers, the neutralization of emails
 * and phone numbers — on unless unticked — and, behind a disclosure, the
 * compliance framework the plan anonymizes by.
 */
export const Step4Review: React.FC<Step4ReviewProps> = ({
  sourceOrgId,
  targetOrgId,
  selectedObjects,
  totalRecords,
  estimatedApiCalls,
  estimatedDurationMin,
  waves,
  piiFields,
  anonymizedFields,
  complianceFramework,
  onFrameworkChange,
  neutralizeContactPoints,
  onNeutralizeChange,
  planning = false,
  isExecuting,
  error,
  scope,
  notCovered,
  onExecute,
}) => {
  const { t } = useTranslation();
  const contactPointsHintId = React.useId();

  /** Why a lookup is left empty, in the interface language. */
  const reasonOf = (lookup: AutopilotLookupLeftEmpty): string => {
    const why =
      lookup.reason === 'depth'
        ? t('autopilot.step4.scope.reasonDepth', { depth: scope?.maxDepth ?? 0 })
        : lookup.reason === 'objects'
          ? t('autopilot.step4.scope.reasonObjects', { objects: scope?.maxObjects ?? 0 })
          : t('autopilot.step4.scope.reasonStandard');
    return lookup.required ? `${why} — ${t('autopilot.step4.scope.required')}` : why;
  };

  /** What a framework expects anonymized, in the interface language. */
  const personal = (kind: ExpectedPersonalData): string =>
    kind === 'name'
      ? t('autopilot.step4.personal.name')
      : kind === 'email'
        ? t('autopilot.step4.personal.email')
        : t('autopilot.step4.personal.phone');

  /** Format numbers with locale separators. */
  const fmt = (n: number): string => n.toLocaleString(uiLocale());

  /** The selected objects copied whole: those no bound cut short. */
  const cutNames = new Set((scope?.cutShort ?? []).map((cut) => cut.objectApiName));
  const wholeTables = (scope?.selected ?? []).filter((name) => !cutNames.has(name));

  /**
   * The name of a compliance framework: the regulations by their acronyms,
   * which no language translates, and "custom" and "none" in the interface
   * language. Both were written in English in all six.
   */
  const frameworkLabel = (fw: ComplianceFrameworkType): string => {
    const labels: Record<ComplianceFrameworkType, string> = {
      gdpr: 'GDPR',
      ccpa: 'CCPA',
      hipaa: 'HIPAA',
      pci_dss: 'PCI-DSS',
      custom: t('autopilot.step3.custom'),
      none: t('autopilot.step3.none'),
    };
    return labels[fw];
  };

  return (
    <div className="flex flex-col gap-(--sf-space-4)" data-testid="step4-review">
      <p className="text-sm text-text-secondary">{t('autopilot.step4.description')}</p>

      {error && <ErrorBanner message={error} code={null} data-testid="autopilot-execute-error" />}

      {/* Emails and phone numbers, neutralized unless unticked, as a Forge
          run's are: the compliance step this replaces defaulted to copying
          them as read into the target. */}
      <div
        className="flex flex-col gap-(--sf-space-2) p-3 rounded-sm border border-(--sf-border) bg-(--sf-bg-primary)"
        data-testid="step4-contact-points"
      >
        <label className="flex items-start gap-2 text-sm text-text-primary cursor-pointer">
          <input
            type="checkbox"
            checked={neutralizeContactPoints}
            onChange={(e) => onNeutralizeChange(e.target.checked)}
            aria-describedby={contactPointsHintId}
            className="mt-0.5 accent-(--sf-accent)"
            data-testid="step4-contact-points-toggle"
          />
          {t('autopilot.step4.contactPoints')}
        </label>
        <p id={contactPointsHintId} className="text-xs text-text-secondary">
          {t('autopilot.step4.contactPointsHint')}
        </p>
      </div>

      <details
        className="flex flex-col gap-2 p-3 rounded-sm border border-(--sf-border) bg-(--sf-bg-primary)"
        data-testid="step4-compliance-advanced"
      >
        <summary className="text-sm font-medium text-text-primary cursor-pointer">
          {t('autopilot.step4.advancedCompliance')}
        </summary>
        <div className="pt-(--sf-space-2)">
          <CompliancePicker selectedFramework={complianceFramework} onSelect={onFrameworkChange} />
        </div>
      </details>
      {planning && (
        <p role="status" className="text-xs text-text-secondary" data-testid="step4-planning">
          {t('autopilot.status.planning')}
        </p>
      )}

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <StatCard
          label={t('autopilot.step4.totalObjects')}
          value={String(selectedObjects.length)}
          testId="stat-objects"
        />
        <StatCard
          label={t('autopilot.step4.totalRecords')}
          value={fmt(totalRecords)}
          testId="stat-records"
        />
        <StatCard
          label={t('autopilot.step4.estimatedDuration')}
          value={`~${estimatedDurationMin} min`}
          testId="stat-duration"
        />
        <StatCard
          label={t('autopilot.step4.estimatedApiCalls')}
          value={fmt(estimatedApiCalls)}
          testId="stat-api-calls"
        />
        <StatCard label={t('autopilot.step4.waves')} value={String(waves)} testId="stat-waves" />
        <StatCard
          label={t('autopilot.step4.piiFields')}
          value={fmt(piiFields)}
          testId="stat-pii-fields"
        />
        <StatCard
          label={t('autopilot.step4.anonymizedFields')}
          value={fmt(anonymizedFields)}
          testId="stat-anonymized-fields"
        />
        <StatCard
          label={t('autopilot.step4.complianceFramework')}
          value={frameworkLabel(complianceFramework)}
          testId="stat-compliance"
        />
        <StatCard
          label={t('autopilot.step4.anonymization')}
          value={
            complianceFramework === 'none'
              ? t('autopilot.step4.noAnonymization')
              : t('autopilot.step4.autoDetect')
          }
          testId="stat-anonymization"
        />
      </div>

      {(notCovered ?? []).length > 0 && (
        <div role="alert" className="flex flex-col gap-1 text-xs" data-testid="step4-not-covered">
          {(notCovered ?? []).map((object) => (
            <p key={object.objectApiName} className="text-status-warning">
              {t('autopilot.step4.notCovered', {
                object: object.objectApiName,
                missing: object.missing.map(personal).join(', '),
              })}
            </p>
          ))}
        </div>
      )}

      {scope && (
        <div
          className="flex flex-col gap-2 p-3 rounded-sm border border-(--sf-border) bg-(--sf-bg-primary)"
          data-testid="step4-scope"
        >
          <span className="text-sm font-medium text-text-primary">
            {t('autopilot.step4.scope.title')}
          </span>
          {wholeTables.length > 0 && (
            <p className="text-xs text-text-secondary">
              {t('autopilot.step4.scope.selected', { objects: wholeTables.join(', ') })}
            </p>
          )}
          {/* A selected table larger than a run copies of one is copied
              from its first records by Id, which the plan said in the log
              alone: the count above showed the bound beside millions. */}
          {(scope.cutShort ?? []).map((cut) => (
            <p
              key={cut.objectApiName}
              className="text-xs text-status-warning"
              data-testid="step4-scope-cut-short"
            >
              {cut.total !== undefined
                ? t('autopilot.step4.scope.cutShort', {
                    object: cut.objectApiName,
                    copied: fmt(cut.copied),
                    total: fmt(cut.total),
                  })
                : t('autopilot.step4.scope.cutShortUncounted', {
                    object: cut.objectApiName,
                    copied: fmt(cut.copied),
                  })}
            </p>
          ))}
          {scope.parents.length > 0 && (
            <div className="flex flex-col gap-0.5 text-xs text-text-secondary">
              <span>{t('autopilot.step4.scope.parents')}</span>
              <ul className="flex flex-col gap-0.5 pl-3" data-testid="step4-scope-parents">
                {scope.parents.map((parent) => (
                  <li key={parent.objectApiName}>
                    {parent.objectApiName}: {fmt(parent.records)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {scope.standardNeeded.map((needed) => (
            <p key={needed.neededBy} className="text-xs text-text-secondary">
              {t('autopilot.step4.scope.standardNeeded', {
                object: needed.objectApiName,
                field: needed.neededBy,
              })}
            </p>
          ))}
          {(scope.followedByDefault ?? []).map((followed) => (
            <p
              key={followed.objectApiName}
              className="text-xs text-text-secondary"
              data-testid="step4-scope-followed-by-default"
            >
              {t('autopilot.step4.scope.followedByDefault', {
                object: followed.objectApiName,
                fields: followed.referencedBy.join(', '),
              })}
            </p>
          ))}
          {scope.leftEmpty.length > 0 && (
            <div className="flex flex-col gap-0.5 text-xs text-text-secondary">
              <span>{t('autopilot.step4.scope.leftEmpty')}</span>
              <ul className="flex flex-col gap-0.5 pl-3" data-testid="step4-scope-left-empty">
                {scope.leftEmpty.map((lookup) => (
                  <li key={`${lookup.objectApiName}.${lookup.fieldApiName}>${lookup.target}`}>
                    {lookup.objectApiName}.{lookup.fieldApiName} → {lookup.target}:{' '}
                    {reasonOf(lookup)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {scope.currencies && (
            <p className="text-xs text-text-secondary" data-testid="step4-scope-currencies">
              {t('autopilot.step4.scope.currencies', {
                currencies: scope.currencies.notInTarget.join(', '),
                writtenIn: scope.currencies.writtenIn,
                objects: scope.currencies.objects.join(', '),
              })}
            </p>
          )}
        </div>
      )}

      <div className="flex flex-col gap-2 p-3 rounded-sm border border-(--sf-border) bg-(--sf-bg-primary)">
        <span className="text-sm font-medium text-text-primary">
          {t('autopilot.step4.connectionSummary')}
        </span>
        <div className="flex items-center gap-2 text-xs text-text-secondary">
          <span>
            {t('autopilot.step4.source')}: {sourceOrgId}
          </span>
          <span className="text-text-primary">&rarr;</span>
          <span>
            {t('autopilot.step4.target')}: {targetOrgId}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-2 p-3 rounded-sm border border-(--sf-border) bg-(--sf-bg-primary)">
        <span className="text-sm font-medium text-text-primary">
          {t('autopilot.step4.selectedObjects')}
        </span>
        <div className="flex flex-wrap gap-1">
          {selectedObjects.map((obj) => (
            <span
              key={obj}
              className="px-2 py-0.5 text-xs rounded-sm bg-(--sf-bg-input) text-text-primary"
            >
              {obj}
            </span>
          ))}
        </div>
      </div>

      {/* Said before the write, as the FAQ said it alone: no list of what a
          run writes is kept, and nothing in SandForge takes it back. */}
      <p
        id="step4-no-way-back"
        className="text-xs text-text-secondary"
        data-testid="step4-no-way-back"
      >
        {t('common.noWayBack')}
      </p>
      <div className="flex justify-end pt-2">
        <Button
          variant="primary"
          size="md"
          onClick={onExecute}
          loading={isExecuting}
          disabled={isExecuting || planning}
          aria-describedby="step4-no-way-back"
          data-testid="execute-button"
        >
          {isExecuting ? t('autopilot.step4.executing') : t('autopilot.step4.execute')}
        </Button>
      </div>
    </div>
  );
};

/** StatCard — displays a single stat value with label. */
interface StatCardProps {
  /** Stat label */
  readonly label: string;
  /** Stat value */
  readonly value: string;
  /** Test ID */
  readonly testId: string;
}

/** Stat card component for the review step. */
const StatCard: React.FC<StatCardProps> = ({ label, value, testId }) => (
  <div className="flex flex-col gap-1 p-3 rounded-sm bg-surface-2" data-testid={testId}>
    <span className="text-xs text-text-secondary">{label}</span>
    <span className="text-lg font-semibold text-text-primary">{value}</span>
  </div>
);
