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
import { AutomationMuteBox } from '../../../components/ui/AutomationMuteBox';
import { CheckpointFirstOption } from '../../../components/ui/CheckpointFirstOption';
import { RewindBeforeRun } from '../../../components/ui/RewindBeforeRun';
import { OrgBadge } from '../../../components/ui/OrgBadge';
import { Icon } from '../../../components/ui/Icon';
import { useOrgStore } from '../../../stores/useOrgStore';
import { useAutopilotStore } from '../../../stores/useAutopilotStore';

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
  /**
   * Whether the run mutes the target's automation through its own bypass,
   * the box's toggle, and the target as the user knows it; no box without.
   */
  readonly mute?: { checked: boolean; onChange: (mute: boolean) => void; org: string };
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
  mute,
  planning = false,
  isExecuting,
  error,
  scope,
  notCovered,
  onExecute,
}) => {
  const { t } = useTranslation();
  const contactPointsHintId = React.useId();
  // The orgs as the user knows them: the last panel before the write named
  // them by the ids the store keys them on, a UUID in a real install, on the
  // one screen where the user checks which org is written to.
  const orgs = useOrgStore((s) => s.orgs);
  const sourceOrg = orgs.find((o) => o.id === sourceOrgId);
  const targetOrg = orgs.find((o) => o.id === targetOrgId);
  const targetName = targetOrg?.alias || targetOrg?.username || targetOrgId;
  const checkpointFirst = useAutopilotStore((s) => s.checkpointFirst);
  const setCheckpointFirst = useAutopilotStore((s) => s.setCheckpointFirst);
  const runEnd = useAutopilotStore((s) => s.runEnd);

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

  /*
   * What becomes of the personal data, from both choices: the tile followed
   * the framework alone and said "No anonymization" under the ticked box
   * that neutralizes every email and phone number, beside a second tile
   * naming the framework again.
   */
  const personalData =
    complianceFramework === 'none'
      ? neutralizeContactPoints
        ? t('autopilot.step4.personalDataContactPoints')
        : t('autopilot.step4.personalDataNone')
      : neutralizeContactPoints
        ? t('autopilot.step4.personalDataFrameworkAndContactPoints', {
            framework: frameworkLabel(complianceFramework),
          })
        : frameworkLabel(complianceFramework);

  return (
    <div className="flex flex-col gap-(--sf-space-4)" data-testid="step4-review">
      <p className="text-sm text-text-secondary">{t('autopilot.step4.description')}</p>

      {error && <ErrorBanner message={error} code={null} data-testid="autopilot-execute-error" />}
      {/* A run its error ended comes back here: what became of the checkpoint
          it took first is said with why it ended, the way back of what it
          wrote before it did. */}
      {error && (
        <RewindBeforeRun
          checkpoint={runEnd?.checkpoint}
          orgId={runEnd?.orgId}
          beside="none"
          testId="step4-checkpoint"
        />
      )}

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

      {/* The run's gate reads what the target runs as it starts: the box says
          what muting does, the run's end what it did. */}
      {mute && (
        <AutomationMuteBox
          offer="atStart"
          checked={mute.checked}
          onChange={mute.onChange}
          org={mute.org}
          testId="step4-mute"
        />
      )}

      {/* The run's gate says what it costs in its question, and an Autopilot
          run has no removal: off unless ticked, as it reads whole tables, and
          recommended here, where the choice is made. */}
      <CheckpointFirstOption
        checked={checkpointFirst}
        onChange={setCheckpointFirst}
        orgId={targetOrgId}
        costSaid="question"
        recommendation={t('autopilot.step4.checkpointRecommended')}
        testId="step4-checkpoint-first"
      />

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
      {/* No framework is the default, kept so: the copy is the source as it
          holds it, its emails and phone numbers neutralized as a Sync run
          writes them. Said outside the folded picker, where the default
          could otherwise be read as masking the names too. */}
      {complianceFramework === 'none' && (
        <p className="text-xs text-text-secondary" data-testid="step4-no-framework">
          {t('autopilot.step4.noFrameworkHint', {
            advanced: t('autopilot.step4.advancedCompliance'),
          })}
        </p>
      )}
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
          value={t('autopilot.step4.durationMinutes', { minutes: fmt(estimatedDurationMin) })}
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
          label={t('autopilot.step4.personalData')}
          value={personalData}
          testId="stat-personal-data"
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

      <div
        className="flex flex-col gap-2 p-3 rounded-sm border border-(--sf-border) bg-(--sf-bg-primary)"
        data-testid="step4-orgs"
      >
        <span className="text-sm font-medium text-text-primary">
          {t('autopilot.step4.connectionSummary')}
        </span>
        {/* Each org by its alias, its type — the target's in the colour of
            its tier — and its instance, as its badge names it elsewhere. */}
        <div className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
          <span className="flex items-center gap-1" data-testid="step4-source-org">
            {t('autopilot.step4.source')}
            {sourceOrg ? <OrgBadge org={sourceOrg} /> : <span>{sourceOrgId}</span>}
          </span>
          <Icon name="arrow-right" className="text-text-primary" />
          <span className="flex items-center gap-1" data-testid="step4-target-org">
            {t('autopilot.step4.target')}
            {targetOrg ? <OrgBadge org={targetOrg} /> : <span>{targetOrgId}</span>}
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
        {checkpointFirst ? t('runResults.checkpoint.option.wayBack') : t('common.noWayBack')}
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
          {isExecuting
            ? t('autopilot.step4.executing')
            : t('autopilot.step4.copyInto', { target: targetName })}
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
