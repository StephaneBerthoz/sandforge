import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  EnvAuditResult,
  RecoveryPreparationId,
  RecoveryStatus,
  RecoveryStep,
  SalesforceOrg,
} from '@sandforge/shared';
import { orgDisplayName } from '@sandforge/shared';
import { Button } from '../../components/ui/Button';
import { OrgTypeBadge } from '../../components/ui/OrgBadge';
import { ProgressBar } from '../../components/ui/ProgressBar';
import { useAppStore } from '../../stores/useAppStore';
import { formatNumber } from '../../utils/formatters';
import {
  SANDBOX_REFRESH_TEMPLATE_ID,
  instantWords,
  lineOf,
  replayAsksName,
  type LineWords,
} from './recoveryFacts';
import { RecoveryAudit, type AuditStep } from './RecoveryAudit';
import { RecoveryBeforeNext } from './RecoveryBeforeNext';
import { RecoveryError } from './RecoveryError';
import { RecoveryStepRow, type StepMark } from './RecoveryStepRow';
import { RecoveryUsers } from './RecoveryUsers';
import { useRecoveryBridge } from './useRecoveryBridge';

/** What a step shows beside its line, its buttons, and what they answered. */
interface StepParts {
  content?: React.ReactNode;
  actions?: React.ReactNode;
  after?: React.ReactNode;
}

/** An audit the page asked: a step's own reading, or the inventory kept for the next refresh. */
interface AuditAsked {
  for: AuditStep | 'inventory';
}

/** What the refresh step says it rests on: how it was noticed, the org before and after. */
const RefreshFacts: React.FC<{
  refresh: NonNullable<RecoveryStatus['refresh']>;
  alias: string;
}> = ({ refresh, alias }) => {
  const { t } = useTranslation();
  const date = instantWords(refresh.detectedAt);
  const evidence =
    refresh.evidence === 'connection'
      ? t('recovery.refresh.byConnection', { date })
      : refresh.evidence === 'monitor'
        ? t('recovery.refresh.byMonitor', { date })
        : refresh.reportedBy
          ? t('recovery.refresh.byProduction', { date, org: refresh.reportedBy })
          : t('recovery.refresh.byProductionUnnamed', { date });
  const from = refresh.previousOrganizationId;
  const to = refresh.organizationId;
  return (
    <ul
      className="flex flex-col gap-0.5 pl-4 list-disc text-xs text-text-primary"
      data-testid="recovery-refresh-facts"
    >
      <li>{evidence}</li>
      {from && to && <li>{t('recovery.refresh.orgChanged', { from, to })}</li>}
      {from && !to && <li>{t('recovery.refresh.orgBefore', { from, alias })}</li>}
      {refresh.previousInstanceName &&
        refresh.instanceName &&
        refresh.previousInstanceName !== refresh.instanceName && (
          <li>
            {t('recovery.refresh.instanceChanged', {
              from: refresh.previousInstanceName,
              to: refresh.instanceName,
            })}
          </li>
        )}
      <li>
        {refresh.cachesForgotten
          ? t('recovery.refresh.cachesForgotten')
          : t('recovery.refresh.cachesKept', { alias })}
      </li>
    </ul>
  );
};

/** Props of {@link SandboxRecovery}. */
export interface SandboxRecoveryProps {
  /** The sandbox, scratch org or Developer Edition org selected: never a production org. */
  org: SalesforceOrg;
}

/**
 * Where one org stands after its refresh, as the extension deduces it: the
 * facts of the refresh, the progress n of N, the warning that none of it is
 * proven on a refreshed sandbox yet, the ten steps — each with what it runs
 * or opens —, what to keep before the next refresh, and Finish. Without a
 * refresh noticed, what to keep comes first.
 */
export const SandboxRecovery: React.FC<SandboxRecoveryProps> = ({ org }) => {
  const { t } = useTranslation();
  const navigate = useAppStore((s) => s.navigate);
  const alias = orgDisplayName(org);
  const stepsTitleId = useId();
  const bridge = useRecoveryBridge();
  const [status, setStatus] = useState<RecoveryStatus | null>(null);
  const [usersOpen, setUsersOpen] = useState(false);
  const [focusUsers, setFocusUsers] = useState(false);
  const [auditAsked, setAuditAsked] = useState<AuditAsked | null>(null);
  const [audits, setAudits] = useState<Partial<Record<AuditStep, EnvAuditResult>>>({});
  const [finishAsked, setFinishAsked] = useState(false);
  const usersRef = useRef<HTMLDivElement>(null);
  const usersPanelId = useId();

  const askStatus = bridge.status.mutate;
  const readStatus = useCallback(() => askStatus({ orgId: org.id }), [askStatus, org.id]);
  useEffect(() => {
    readStatus();
  }, [readStatus]);

  // The status as the extension said it last: read, or answered to a mark.
  const read = bridge.status.data;
  const acked = bridge.ack.data;
  useEffect(() => {
    if (read) setStatus(read.status);
  }, [read]);
  useEffect(() => {
    if (acked) setStatus(acked.status);
  }, [acked]);

  // An audit answers the step that asked it. The jobs are kept as they are
  // read: the step is done, and the next refresh has its inventory, once the
  // inventory read after the refresh is kept — read again.
  const audited = bridge.audit.data;
  useEffect(() => {
    if (!audited || !auditAsked) return;
    const step: AuditStep = auditAsked.for === 'inventory' ? 'scheduledJobs' : auditAsked.for;
    setAudits((was) => ({ ...was, [step]: audited.audit }));
    if (step === 'scheduledJobs') readStatus();
  }, [audited, auditAsked, readStatus]);

  const noted = bridge.handoff.data;
  useEffect(() => {
    if (noted) readStatus();
  }, [noted, readStatus]);

  useEffect(() => {
    if (!focusUsers || !usersRef.current) return;
    usersRef.current.focus();
    usersRef.current.scrollIntoView?.({ block: 'nearest' });
    setFocusUsers(false);
  }, [focusUsers, usersOpen]);

  if (status === null) {
    if (bridge.status.error) {
      return (
        <RecoveryError
          error={bridge.status.error}
          errorCode={bridge.status.errorCode}
          alias={alias}
          onRetry={readStatus}
          testId="recovery-status-error"
        />
      );
    }
    return (
      <p className="text-sm text-text-secondary" role="status" data-testid="recovery-loading">
        {t('recovery.loading', { alias })}
      </p>
    );
  }

  const words: LineWords = { alias, date: instantWords, count: formatNumber };
  const refresh = status.refresh;

  const askAudit = (asked: AuditStep | 'inventory'): void => {
    const jobs = asked === 'scheduledJobs' || asked === 'inventory';
    setAuditAsked({ for: asked });
    bridge.audit.mutate({
      orgId: org.id,
      asked: {
        deliverability: asked === 'deliverability',
        schedules: jobs,
        endpoints: asked === 'endpoints' ? { productionHosts: [], fields: [] } : false,
      },
      save: jobs,
    });
  };
  const auditBusy = (asked: AuditStep | 'inventory'): boolean =>
    bridge.audit.loading && auditAsked?.for === asked;
  const auditError = (asked: AuditStep | 'inventory'): React.ReactNode =>
    bridge.audit.error && auditAsked?.for === asked ? (
      <RecoveryError
        error={bridge.audit.error}
        errorCode={bridge.audit.errorCode}
        alias={alias}
        onRetry={() => askAudit(asked)}
        testId={`recovery-audit-error-${asked}`}
      />
    ) : null;

  const mark = (step: RecoveryStep, how: StepMark): void => {
    setFinishAsked(false);
    bridge.ack.mutate({ orgId: org.id, what: 'step', step: step.id, mark: how });
  };

  const takeCheckpoint = (nameKey: string): void =>
    navigate('checkpoint', {
      takeCheckpoint: true,
      targetOrgId: org.id,
      checkpointName: t(nameKey),
      checkpointKeepDays: 0,
    });

  const actBefore = (id: RecoveryPreparationId): void => {
    if (id === 'beforeRefreshCheckpoint') takeCheckpoint('recovery.names.beforeRefresh');
    else if (id === 'jobsInventory') askAudit('inventory');
    else if (id === 'testersList') {
      setUsersOpen(true);
      setFocusUsers(true);
    } else navigate('automation', { automationTemplateId: SANDBOX_REFRESH_TEMPLATE_ID });
  };

  const beforeNext = (
    <>
      <RecoveryBeforeNext
        items={status.beforeNextRefresh}
        alias={alias}
        onAct={actBefore}
        busy={new Set(auditBusy('inventory') ? ['jobsInventory' as const] : [])}
      />
      {auditError('inventory')}
    </>
  );

  /**
   * What a step shows beside its line, the buttons of what it runs or opens,
   * and what that answered.
   */
  const partsOf = (step: RecoveryStep): StepParts => {
    const actionable = step.status === 'todo' || step.status === 'done';
    const variant = step.status === 'done' ? 'ghost' : 'secondary';
    switch (step.id) {
      case 'refresh':
        return { content: refresh ? <RefreshFacts refresh={refresh} alias={alias} /> : null };
      case 'users':
        if (step.status === 'skipped') return {};
        return {
          actions: (
            <Button
              size="sm"
              variant={variant}
              aria-expanded={usersOpen}
              aria-controls={usersPanelId}
              onClick={() => setUsersOpen((was) => !was)}
              data-testid="recovery-users-toggle"
            >
              {t(usersOpen ? 'recovery.action.hideUsers' : 'recovery.action.showUsers')}
            </Button>
          ),
          after: (
            <div
              id={usersPanelId}
              ref={usersRef}
              tabIndex={-1}
              hidden={!usersOpen}
              className="border-t border-subtle pt-2 outline-none"
            >
              {usersOpen && (
                <RecoveryUsers
                  orgId={org.id}
                  alias={alias}
                  lastRun={status.lastUsersRun}
                  onChanged={readStatus}
                />
              )}
            </div>
          ),
        };
      case 'masking':
        return actionable
          ? {
              actions: (
                <Button
                  size="sm"
                  variant={variant}
                  onClick={() =>
                    navigate('dataops', { dataopsTab: 'anonymize', targetOrgId: org.id })
                  }
                  data-testid="recovery-open-masking"
                >
                  {t('recovery.action.openMasking')}
                </Button>
              ),
            }
          : {};
      case 'replay': {
        const before = status.checkpointBefore;
        if (!actionable || !before) return {};
        return {
          content: replayAsksName(status) ? (
            <p className="text-xs text-status-warning" data-testid="recovery-replay-staging">
              {t('recovery.line.replay.staging', { alias })}
            </p>
          ) : null,
          actions: (
            <Button
              size="sm"
              variant={variant}
              onClick={() =>
                navigate('checkpoint', {
                  replayCheckpointId: before.checkpointId,
                  targetOrgId: org.id,
                })
              }
              data-testid="recovery-open-replay"
            >
              {t('recovery.action.openReplay')}
            </Button>
          ),
        };
      }
      case 'frozen':
        return actionable && status.frozenManifest
          ? {
              actions: (
                <Button
                  size="sm"
                  variant={variant}
                  onClick={() =>
                    navigate('frozen', { frozenTab: 'load', frozenTargetOrgId: org.id })
                  }
                  data-testid="recovery-open-load"
                >
                  {t('recovery.action.openLoad')}
                </Button>
              ),
            }
          : {};
      case 'testersCheckpoint':
        return actionable
          ? {
              actions: (
                <Button
                  size="sm"
                  variant={variant}
                  onClick={() => takeCheckpoint('recovery.names.testersStart')}
                  data-testid="recovery-take-testers"
                >
                  {t('recovery.action.takeTesters')}
                </Button>
              ),
            }
          : {};
      case 'deliverability':
      case 'endpoints':
      case 'scheduledJobs': {
        if (step.status === 'skipped') return {};
        const audit = audits[step.id];
        const noInventory = step.id === 'scheduledJobs' && step.reason === 'noInventoryBefore';
        return {
          actions: noInventory ? (
            <Button
              size="sm"
              variant="secondary"
              loading={auditBusy('inventory')}
              disabled={bridge.audit.loading}
              onClick={() => askAudit('inventory')}
              data-testid="recovery-keep-inventory"
            >
              {t('recovery.action.keepInventory')}
            </Button>
          ) : (
            <Button
              size="sm"
              variant={variant}
              loading={auditBusy(step.id)}
              disabled={bridge.audit.loading}
              onClick={() => askAudit(step.id as AuditStep)}
              data-testid={`recovery-read-${step.id}`}
            >
              {t(audit ? 'recovery.action.readAgain' : 'recovery.action.read')}
            </Button>
          ),
          after: (
            <>
              {auditError(step.id as AuditStep)}
              {audit && (
                <RecoveryAudit
                  step={step.id as AuditStep}
                  audit={audit}
                  alias={alias}
                  setup={{ myDomainHost: status.myDomainHost, instanceUrl: org.instanceUrl }}
                />
              )}
            </>
          ),
        };
      }
      case 'handoff': {
        if (step.status === 'skipped') return {};
        const written = bridge.handoff.data;
        return {
          actions: (
            <Button
              size="sm"
              variant={variant}
              loading={bridge.handoff.loading}
              onClick={() => bridge.handoff.mutate({ orgId: org.id })}
              data-testid="recovery-write-note"
            >
              {t(written ? 'recovery.action.writeNoteAgain' : 'recovery.action.writeNote')}
            </Button>
          ),
          after: (
            <>
              {written && (
                <p
                  className="text-xs text-text-secondary"
                  role="status"
                  data-testid="recovery-note-written"
                >
                  {t('recovery.handoff.written', { path: written.path })}
                </p>
              )}
              {bridge.handoff.error && (
                <RecoveryError
                  error={bridge.handoff.error}
                  errorCode={bridge.handoff.errorCode}
                  alias={alias}
                  testId="recovery-note-error"
                />
              )}
            </>
          ),
        };
      }
    }
  };

  const finished = finishAsked && acked !== null && !bridge.ack.loading && !bridge.ack.error;

  return (
    <div className="flex flex-col gap-4" data-testid="recovery-sandbox">
      <section
        className="flex flex-col gap-2"
        aria-label={t('recovery.factsLabel', { alias })}
        data-testid="recovery-facts"
      >
        <div className="flex flex-wrap items-center gap-2 text-xs text-text-primary">
          <OrgTypeBadge org={org} testId="recovery-org-type" />
          <span data-testid="recovery-refreshed">
            {refresh
              ? t('recovery.refreshedOn', { date: instantWords(refresh.detectedAt) })
              : t('recovery.notRefreshed')}
          </span>
          <span aria-hidden="true">·</span>
          <span data-testid="recovery-count">
            {t('recovery.stepsDone', { done: status.done, total: status.total })}
          </span>
        </div>
        <ProgressBar
          value={status.done}
          max={Math.max(status.total, 1)}
          size="sm"
          ariaLabel={t('recovery.progressLabel', { alias })}
          valueText={t('recovery.stepsDone', { done: status.done, total: status.total })}
        />
      </section>

      <div
        role="note"
        className="flex flex-col gap-1 rounded-sm border border-(--sf-warning) px-3 py-2 text-xs"
        data-testid="recovery-not-proven"
      >
        <p className="font-semibold text-status-warning">{t('recovery.notProven.title')}</p>
        <p className="text-text-primary">{t('recovery.notProven.body')}</p>
      </div>

      {!refresh && (
        <>
          <p className="text-sm text-text-primary" data-testid="recovery-no-refresh">
            {t('recovery.noRefresh', { alias })}
          </p>
          {beforeNext}
        </>
      )}

      {bridge.ack.error && (
        <RecoveryError
          error={bridge.ack.error}
          errorCode={bridge.ack.errorCode}
          alias={alias}
          testId="recovery-ack-error"
        />
      )}

      <section className="flex flex-col gap-2" aria-labelledby={stepsTitleId}>
        <h2 id={stepsTitleId} className="text-sm font-semibold text-text-primary">
          {t('recovery.stepsTitle')}
        </h2>
        <ol className="flex flex-col gap-2" data-testid="recovery-steps">
          {status.steps.map((step, index) => {
            const line = lineOf(step.id, step.reason, status, words);
            const parts = partsOf(step);
            return (
              <RecoveryStepRow
                key={step.id}
                number={index + 1}
                step={step}
                line={t(line.key, line.params)}
                at={step.at ? instantWords(step.at) : undefined}
                actions={parts.actions}
                after={parts.after}
                onMark={(how) => mark(step, how)}
                marking={bridge.ack.loading}
              >
                {parts.content}
              </RecoveryStepRow>
            );
          })}
        </ol>
      </section>

      {refresh && beforeNext}

      {refresh && (
        <div className="flex flex-col gap-2 border-t border-subtle pt-3">
          <p className="text-xs text-text-secondary">{t('recovery.finishHint', { alias })}</p>
          <div>
            <Button
              size="sm"
              loading={finishAsked && bridge.ack.loading}
              disabled={bridge.ack.loading}
              onClick={() => {
                setFinishAsked(true);
                bridge.ack.mutate({ orgId: org.id, what: 'finish' });
              }}
              data-testid="recovery-finish"
            >
              {t('recovery.finish')}
            </Button>
          </div>
          {finished && (
            <p className="text-xs text-text-primary" role="status" data-testid="recovery-finished">
              {t('recovery.finished', { alias })}
            </p>
          )}
        </div>
      )}
    </div>
  );
};
