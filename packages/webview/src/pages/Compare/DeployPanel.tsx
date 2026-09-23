import React, { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DEPLOY_MAX_TESTS, DEPLOY_WAIT_MINUTES, orgTypeToGuardTier } from '@sandforge/shared';
import type {
  CompareReport,
  CompareResult,
  DeploymentCandidate,
  DeploymentReport,
  DeployTestLevel,
  DiffRiskLevel,
  NotDeployableReason,
  SalesforceOrg,
} from '@sandforge/shared';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { useOperationProgress } from '../../hooks/useOperationProgress';
import { Badge } from '../../components/ui/Badge';
import type { BadgeVariant } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { DangerConfirm } from '../../components/ui/DangerConfirm';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { Input } from '../../components/ui/Input';
import { DeploymentReportView } from './DeploymentReportView';
import {
  advisedTestLevel,
  candidateKey,
  parseTestNames,
  suggestDeployment,
} from './deploymentSuggestion';

/**
 * How long the page waits for a validation: the extension may ask the source
 * twice, then follows the deployment, each within its own bound, and answers
 * once it gives up. A minute past that is the page's margin.
 */
const VALIDATE_TIMEOUT_MS =
  (2 * DEPLOY_WAIT_MINUTES.retrieve + DEPLOY_WAIT_MINUTES.deploy + 1) * 60_000;
/** How long the page waits for a deployment, on the same terms. */
const DEPLOY_TIMEOUT_MS = (DEPLOY_WAIT_MINUTES.deploy + 1) * 60_000;

/** The names listed under each reason before the rest are counted. */
const NAMES_SHOWN = 20;

const riskBadge: Record<DiffRiskLevel, BadgeVariant> = {
  none: 'default',
  low: 'success',
  medium: 'info',
  high: 'warning',
  critical: 'error',
};

/** The order the reasons are listed in: what the user can act on last. */
const REASON_ORDER: readonly NotDeployableReason[] = [
  'only_in_target',
  'managed',
  'permissions_in_part',
  'type_not_deployable',
  'unreadable',
  'not_compared',
];

/** Props for {@link DeployPanel}. */
export interface DeployPanelProps {
  /** The comparison the deployment is drawn from; its orgs are the source and the target. */
  result: CompareResult;
  /** What the risk card computed of it. */
  report: CompareReport;
  /** The registered orgs, to name the two and to know the target's type. */
  orgs: readonly SalesforceOrg[];
}

/** An org as the page names it. */
function orgLabel(org: SalesforceOrg | undefined, fallback: string): string {
  return org?.alias || org?.username || fallback;
}

/**
 * The Deploy tab: pick what differs in the source, validate it in the target,
 * then deploy the validation.
 *
 * Nothing is deployed that was not validated first. The extension keeps the
 * package each successful validation checked, and the deployment names that
 * validation: the page never describes what to deploy, so what the target
 * takes is what it checked. A deployment asks for the target's name to be
 * typed, and the Production Guard refuses a production target whatever the
 * page says.
 */
export const DeployPanel: React.FC<DeployPanelProps> = ({ result, report, orgs }) => {
  const { t } = useTranslation();
  const testNamesId = useId();

  const source = orgs.find((o) => o.id === result.sourceOrgId);
  const target = orgs.find((o) => o.id === result.targetOrgId);
  const sourceLabel = orgLabel(source, t('compare.source'));
  const targetLabel = orgLabel(target, t('compare.target'));
  // The guard's own reading: an org SandForge does not know is production.
  const targetRefused = orgTypeToGuardTier(target?.orgType ?? '') === 'production';

  const suggestion = useMemo(() => suggestDeployment(result.diffs, report), [result, report]);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [chosenLevel, setChosenLevel] = useState<DeployTestLevel | null>(null);
  const [testNamesText, setTestNamesText] = useState('');
  const [validatedKey, setValidatedKey] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const validation = useBridgeMutation<{ report: DeploymentReport }>(
    'compare:validate-deployment',
    { timeoutMs: VALIDATE_TIMEOUT_MS },
  );
  const deployment = useBridgeMutation<{ report: DeploymentReport }>('compare:deploy', {
    timeoutMs: DEPLOY_TIMEOUT_MS,
  });
  const { getProgress } = useOperationProgress();

  const pickedCandidates = suggestion.deployable.filter((c) => picked.has(candidateKey(c)));
  const advised = advisedTestLevel(pickedCandidates);
  const testLevel = chosenLevel ?? advised;
  const tests = parseTestNames(testNamesText);
  const testsProblem =
    testLevel !== 'RunSpecifiedTests'
      ? undefined
      : tests.invalid.length > 0
        ? t('compare.deployment.testNamesInvalid', { names: tests.invalid.join(', ') })
        : tests.tooMany
          ? t('compare.deployment.testNamesTooMany', { max: DEPLOY_MAX_TESTS })
          : tests.names.length === 0
            ? t('compare.deployment.testNamesMissing')
            : undefined;
  const runTests = testLevel === 'RunSpecifiedTests' ? tests.names : [];
  // What a validation answers for: the components and the tests, as sent.
  const currentKey = JSON.stringify([pickedCandidates.map(candidateKey), testLevel, runTests]);

  const busy = validation.loading || deployment.loading;
  const validated = validation.data?.report;
  const deployed = deployment.data?.report;
  const stale = validated !== undefined && validatedKey !== currentKey;
  const canDeploy =
    validated?.success === true &&
    validated.deployId !== undefined &&
    !stale &&
    !targetRefused &&
    !busy &&
    deployed === undefined;

  const runningId = validation.loading
    ? validation.requestId
    : deployment.loading
      ? deployment.requestId
      : null;
  const progress = runningId !== null ? getProgress(runningId) : undefined;

  const toggle = (c: DeploymentCandidate): void => {
    const key = candidateKey(c);
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const validate = (): void => {
    if (pickedCandidates.length === 0 || testsProblem || targetRefused) return;
    deployment.reset();
    setValidatedKey(currentKey);
    validation.mutate({
      sourceOrgId: result.sourceOrgId,
      targetOrgId: result.targetOrgId,
      components: pickedCandidates.map((c) => ({
        componentType: c.componentType,
        fullName: c.fullName,
      })),
      testLevel,
      ...(testLevel === 'RunSpecifiedTests' ? { runTests } : {}),
    });
  };

  const deploy = (): void => {
    setConfirmOpen(false);
    if (!canDeploy || validated?.deployId === undefined) return;
    deployment.mutate({ validationId: validated.deployId, targetOrgId: result.targetOrgId });
  };

  const byReason = REASON_ORDER.map(
    (reason) =>
      [reason, suggestion.notDeployable.filter((c) => c.notDeployable === reason)] as const,
  ).filter(([, candidates]) => candidates.length > 0);

  return (
    <section className="flex flex-col gap-4" data-testid="compare-deploy">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold text-text-primary">
          {t('compare.deployment.title', { source: sourceLabel, target: targetLabel })}
        </h2>
        <p className="text-xs text-text-secondary">
          {t('compare.deployment.intro', { source: sourceLabel, target: targetLabel })}
        </p>
      </div>

      {targetRefused && (
        <p
          className="rounded border border-status-error/50 px-3 py-2 text-xs text-status-error"
          data-testid="deploy-target-refused"
        >
          {t('compare.deployment.targetRefused', { target: targetLabel })}
        </p>
      )}

      <fieldset className="flex flex-col gap-2" data-testid="deploy-candidates">
        <legend className="mb-1 text-xs font-medium text-text-primary">
          {t('compare.deployment.pickLegend', {
            picked: pickedCandidates.length,
            total: suggestion.deployable.length,
          })}
        </legend>
        {suggestion.deployable.length === 0 ? (
          <p className="text-xs text-text-secondary" data-testid="deploy-none-deployable">
            {t('compare.deployment.noneDeployable')}
          </p>
        ) : (
          <>
            <p className="text-xs text-text-secondary">
              {t('compare.deployment.changeLegend', { source: sourceLabel, target: targetLabel })}
            </p>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setPicked(new Set(suggestion.deployable.map(candidateKey)))}
                disabled={busy}
                data-testid="deploy-pick-all"
              >
                {t('compare.selectAll')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setPicked(new Set())}
                disabled={busy || picked.size === 0}
                data-testid="deploy-pick-none"
              >
                {t('compare.clear')}
              </Button>
            </div>
            <ul
              className="flex max-h-72 flex-col gap-0.5 overflow-y-auto rounded border border-[var(--sf-border)] p-1"
              data-testid="deploy-candidate-list"
            >
              {suggestion.deployable.map((c) => {
                const key = candidateKey(c);
                return (
                  <li key={key}>
                    <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-[var(--sf-bg-hover)]">
                      <input
                        type="checkbox"
                        checked={picked.has(key)}
                        onChange={() => toggle(c)}
                        disabled={busy}
                        data-testid={`deploy-pick-${key}`}
                      />
                      <Badge variant={c.status === 'removed' ? 'success' : 'warning'}>
                        {t(`compare.deployment.change.${c.status}`)}
                      </Badge>
                      {/* Primary, not secondary: the row's hover fill takes
                          secondary text under AA on the dark default theme. */}
                      <span className="text-text-primary">{c.componentType}</span>
                      <span className="flex-1 break-all font-mono text-text-primary">
                        {c.fullName}
                      </span>
                      <Badge variant={riskBadge[c.riskLevel]}>
                        {t(`compare.riskLevel.${c.riskLevel}`)}
                      </Badge>
                    </label>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </fieldset>

      {byReason.length > 0 && (
        <section className="flex flex-col gap-2" data-testid="deploy-not-deployable">
          <h3 className="text-xs font-medium text-text-primary">
            {t('compare.deployment.notDeployableTitle', {
              count: suggestion.notDeployable.length,
            })}
          </h3>
          {byReason.map(([reason, candidates]) => (
            <div
              key={reason}
              className="flex flex-col gap-0.5"
              data-testid={`deploy-reason-${reason}`}
            >
              <p className="text-xs text-text-primary">
                {t(`compare.deployment.reason.${reason}`)} ({candidates.length})
              </p>
              <ul className="flex flex-wrap gap-x-3 gap-y-0.5 pl-3 text-xs text-text-secondary">
                {candidates.slice(0, NAMES_SHOWN).map((c) => (
                  <li key={candidateKey(c)} className="font-mono">
                    {c.componentType} {c.fullName}
                  </li>
                ))}
                {candidates.length > NAMES_SHOWN && (
                  <li>
                    {t('compare.deployment.andMore', { count: candidates.length - NAMES_SHOWN })}
                  </li>
                )}
              </ul>
            </div>
          ))}
        </section>
      )}

      <fieldset className="flex flex-col gap-1" data-testid="deploy-tests">
        <legend className="mb-1 text-xs font-medium text-text-primary">
          {t('compare.deployment.testsLegend', { target: targetLabel })}
        </legend>
        {(['NoTestRun', 'RunLocalTests', 'RunSpecifiedTests'] as const).map((level) => (
          <label key={level} className="flex items-center gap-2 text-xs text-text-primary">
            <input
              type="radio"
              name={`${testNamesId}-level`}
              value={level}
              checked={testLevel === level}
              onChange={() => setChosenLevel(level)}
              disabled={busy}
              data-testid={`deploy-test-level-${level}`}
            />
            {t(`compare.deployment.testLevel.${level}`)}
          </label>
        ))}
        {testLevel === 'RunSpecifiedTests' && (
          <div className="max-w-md pl-5">
            <Input
              id={testNamesId}
              label={t('compare.deployment.testNames')}
              value={testNamesText}
              onChange={(e) => setTestNamesText(e.target.value)}
              error={testsProblem}
              disabled={busy}
              data-testid="deploy-test-names"
            />
          </div>
        )}
        {advised === 'RunLocalTests' && chosenLevel === null && (
          <p className="text-xs text-text-secondary" data-testid="deploy-tests-advised">
            {t('compare.deployment.testsAdvised')}
          </p>
        )}
      </fieldset>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          onClick={validate}
          loading={validation.loading}
          disabled={
            pickedCandidates.length === 0 || testsProblem !== undefined || targetRefused || busy
          }
          data-testid="deploy-validate-btn"
        >
          {t('compare.deployment.validate', { target: targetLabel })}
        </Button>
        {canDeploy && (
          <Button
            variant="danger"
            size="sm"
            onClick={() => setConfirmOpen(true)}
            data-testid="deploy-deploy-btn"
          >
            {t('compare.deployment.deploy', { target: targetLabel })}
          </Button>
        )}
      </div>

      {busy && (
        <p role="status" className="text-xs text-text-secondary" data-testid="deploy-progress">
          {progress
            ? t(`compare.deployment.progress.${progress.currentStep}`, {
                done: progress.processedRecords,
                total: progress.totalRecords,
              })
            : t('compare.deployment.progress.waiting')}
        </p>
      )}

      {validation.error && (
        <ErrorBanner message={validation.error} data-testid="deploy-validation-error" />
      )}
      {stale && (
        <p className="text-xs text-status-warning" data-testid="deploy-validation-stale">
          {t('compare.deployment.stale')}
        </p>
      )}
      {validated && (
        <DeploymentReportView
          report={validated}
          targetLabel={targetLabel}
          data-testid="deploy-validation-report"
        />
      )}

      {deployment.error && (
        <ErrorBanner message={deployment.error} data-testid="deploy-deployment-error" />
      )}
      {deployed && (
        <DeploymentReportView
          report={deployed}
          targetLabel={targetLabel}
          data-testid="deploy-deployment-report"
        />
      )}

      <DangerConfirm
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={deploy}
        title={t('compare.deployment.confirmTitle', { target: targetLabel })}
        // Deploy is offered only while the validation answers for what is
        // picked, so what is picked is what was validated.
        description={t('compare.deployment.confirmDescription', {
          count: pickedCandidates.length,
          id: validated?.deployId ?? '',
          target: targetLabel,
        })}
        confirmText={targetLabel}
        variant="warning"
      />
    </section>
  );
};
