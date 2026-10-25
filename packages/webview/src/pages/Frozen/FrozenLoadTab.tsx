import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, Play, ShieldCheck, Square } from 'lucide-react';
import type {
  ErrorHint,
  ForgeFieldRefusal,
  FrozenFieldRemoval,
  FrozenLoadPlanInfo,
  FrozenLoadProgress,
  FrozenLoadReportInfo,
  FrozenLoadResponse,
  FrozenVerifyVerdict,
} from '@sandforge/shared';
import { translateError } from '@sandforge/shared';
import { useOrgStore } from '../../stores/useOrgStore';
import { useFrozenStore } from '../../stores/useFrozenStore';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import type { BadgeVariant } from '../../components/ui/Badge';
import { Card, CardBody } from '../../components/ui/Card';
import { DataTable } from '../../components/ui/DataTable';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { ErrorExplanation } from '../../components/ui/ErrorExplanation';
import { KPICard } from '../../components/ui/KPICard';
import { OrgDropdown } from '../../components/ui/OrgDropdown';
import { ProgressBar } from '../../components/ui/ProgressBar';
import { useOperationCancel } from '../../hooks/useOperationCancel';
import { useFrozenMutation } from './useFrozenBridge';
import { FrozenLoadRemoval } from './FrozenLoadRemoval';
import { TakeCheckpointNow } from '../../components/ui/TakeCheckpointNow';
import { failureReasons, purgeFailureReasons } from './frozenFailureReasons';
import type { FrozenFailureReason } from './frozenFailureReasons';
import { unresolvedCycleLookups, unresolvedLinks } from './frozenUnresolvedLinks';
import { WRITE_RUN_TIMEOUT_MS } from '../../hooks/writeRunTimeout';

/** Props for the load tab. */
export interface FrozenLoadTabProps {
  /** Refetch the module status after a mutation completed. */
  onRefetchStatus: () => void;
}

/**
 * The mark of a progress line: a step, a step done, one that failed — an
 * object, a reload's purge, the placeholders or a pass a write of its own
 * threw at among them, and a check before the first write that refused the
 * load — or one a cancel stopped part way: an object while it was written, a
 * reload's purge, the placeholders, a pass after the inserts. Stopped is a
 * warning, as a load that ended with errors is. Marked as a step, what the
 * cancel stopped read as still going; marked done, as done whole beside what
 * was.
 */
const PROGRESS_VARIANTS: Record<FrozenLoadProgress['status'], BadgeVariant> = {
  started: 'info',
  done: 'success',
  error: 'error',
  stopped: 'warning',
};

/** What refused a field records went in without, as the report names it. */
const REFUSED_BY_KEYS: Readonly<Record<ForgeFieldRefusal, string>> = {
  'validation-rule': 'runResults.writtenWithoutFields.byValidationRule',
  'restricted-picklist': 'runResults.writtenWithoutFields.byRestrictedPicklist',
  'lookup-filter': 'runResults.writtenWithoutFields.byLookupFilter',
};

/** Sum a numeric field across per-object load results. */
function sumPerObject(
  report: FrozenLoadReportInfo,
  pick: (o: FrozenLoadReportInfo['perObject'][number]) => number,
): number {
  return report.perObject.reduce((sum, o) => sum + pick(o), 0);
}

/**
 * Whether a load changed the org: it inserted a record, or its reload purged
 * one — deleted or deactivated it. Pass 2 and the statuses only update what
 * the load itself inserted.
 */
function loadWrote(report: FrozenLoadReportInfo): boolean {
  const purged = [
    ...Object.values(report.purge.deleted),
    ...Object.values(report.purge.deactivated),
  ];
  return sumPerObject(report, (o) => o.inserted) > 0 || purged.some((count) => count > 0);
}

/**
 * The fields the target encrypts that a load leaves out, or would, as the
 * dataset may hold their masks, each with the records that held a value; ''
 * when it leaves out none.
 */
function maybeMasks(removals: readonly FrozenFieldRemoval[] | undefined): string {
  return (removals ?? [])
    .filter((removal) => removal.reason === 'may-hold-masks')
    .map((removal) => `${removal.objectApiName}.${removal.field} (${removal.affectedRecords})`)
    .join(', ');
}

/** The rows of a table of failure reasons, one per object, status code and message. */
function reasonRows(reasons: readonly FrozenFailureReason[]): Array<Record<string, unknown>> {
  return reasons.map((reason) => ({
    key: `${reason.objectApiName}\u0000${reason.statusCode}\u0000${reason.message}`,
    object: reason.objectApiName,
    statusCode: reason.statusCode,
    message: reason.message,
    count: reason.count,
    // What the reason means and what to do, as the other modules say it: the
    // table showed the platform's code and the org's words alone.
    hint: translateError(
      reason.statusCode ? `${reason.statusCode}: ${reason.message}` : reason.message,
    ),
  }));
}

/**
 * Per object, what a reload purged of the records earlier loads created —
 * deleted, or deactivated where the configuration names a field for it — in
 * the order the purge reached them.
 */
function purgedRows(purge: FrozenLoadReportInfo['purge']): Array<Record<string, unknown>> {
  const objects = new Set([...Object.keys(purge.deleted), ...Object.keys(purge.deactivated)]);
  return [...objects].map((objectApiName) => ({
    key: objectApiName,
    object: objectApiName,
    deleted: purge.deleted[objectApiName] ?? 0,
    deactivated: purge.deactivated[objectApiName] ?? 0,
  }));
}

/**
 * Load tab: target sandbox + pilot toggle, entry guards visibility,
 * per-phase progress, the full load report (removals, placeholders,
 * anti-duplicate skips) and the chained post-load verdict.
 */
export const FrozenLoadTab: React.FC<FrozenLoadTabProps> = ({ onRefetchStatus }) => {
  const { t } = useTranslation();
  const orgs = useOrgStore((s) => s.orgs);
  const selectedOrgId = useOrgStore((s) => s.selectedOrgId);
  const status = useFrozenStore((s) => s.status);
  const config = useFrozenStore((s) => s.config);
  const progress = useFrozenStore((s) => s.progress);
  const clearProgress = useFrozenStore((s) => s.clearProgress);
  const loadReport = useFrozenStore((s) => s.loadReport);
  const setLoadReport = useFrozenStore((s) => s.setLoadReport);
  const verdict = useFrozenStore((s) => s.verdict);
  const setVerdict = useFrozenStore((s) => s.setVerdict);
  const lastError = useFrozenStore((s) => s.lastError);

  const targetOrgId = useFrozenStore((s) => s.targetOrgId);
  const setTargetOrgId = useFrozenStore((s) => s.setTargetOrgId);
  const [pilot, setPilot] = useState(false);
  const [reload, setReload] = useState(false);
  const [writeEncrypted, setWriteEncrypted] = useState(false);
  // A dataset whose manifest does not say its extraction left out the
  // encrypted fields it read masked may hold their masks: its load leaves out
  // the fields the target encrypts unless told to write them.
  const encryptedUnchecked =
    status?.manifest != null && status.manifest.coverage?.encryptedNotKept === undefined;

  // A load goes on in the extension until it ends, and answers then: held to
  // thirty minutes, a large one lost its page and its Cancel while it wrote.
  const loadMutation = useFrozenMutation<FrozenLoadResponse['payload']>('frozen:load', {
    timeoutMs: WRITE_RUN_TIMEOUT_MS,
    runOutlivesWait: true,
  });
  // Read before anything is written: the target is asked what the load reads
  // before its first write, and the purge a reload would run is planned.
  const previewMutation = useFrozenMutation<{ plan: FrozenLoadPlanInfo }>('frozen:load:preview', {
    timeoutMs: 600_000,
  });
  // The load runs under the id of the request that started it: Cancel sends
  // it on `execution:abort`, as Live Operations' Cancel does, and the load
  // stops before its next write. The page had no Cancel, and could not have
  // named the load: its id was minted where the page never saw it.
  const loadRequestId = loadMutation.requestId;
  const { requested: cancelRequested, cancel: cancelLoad } = useOperationCancel(loadRequestId, {
    title: t('frozen.load.cancelRefused'),
    message: t('frozen.load.cancelRefusedDetail'),
  });
  const verifyMutation = useFrozenMutation<{ verdict: FrozenVerifyVerdict }>('frozen:verify', {
    responseType: 'frozen:verify:result',
    timeoutMs: 300_000,
  });

  useEffect(() => {
    if (loadMutation.data?.report) {
      setLoadReport(loadMutation.data.report);
      onRefetchStatus();
    }
  }, [loadMutation.data, setLoadReport, onRefetchStatus]);

  // A load that ends on an error — cancelled, or failed part way — keeps in
  // its mapping what it wrote, and the card below offers to remove it once
  // the status is read again. Read once per error: one the store kept from
  // before this tab was shown was read for by the tab that heard it.
  const seenError = useRef(lastError);
  useEffect(() => {
    if (lastError === seenError.current) return;
    seenError.current = lastError;
    if (lastError?.source === 'frozen:load') onRefetchStatus();
  }, [lastError, onRefetchStatus]);

  const effectiveTarget = targetOrgId || selectedOrgId || '';
  const connectedOrgs = orgs.filter((o) => o.status === 'connected');
  // A verification checks the last load into the org it is asked about.
  // Offered once any org had a load, Verify on an org no load went into
  // ended in NO_LOAD; the extension's refusal stays behind this.
  const loadedIntoTarget =
    status?.lastLoads.some((load) => load.orgId === effectiveTarget) === true;
  const noLoadIntoTarget = status !== null && effectiveTarget !== '' && !loadedIntoTarget;
  const targetName = orgs.find((o) => o.id === effectiveTarget)?.alias ?? effectiveTarget;

  const loadOptions = (): Record<string, unknown> => ({
    targetOrgId: effectiveTarget,
    ...(pilot ? { pilot: true } : {}),
    ...(reload ? { reload: true } : {}),
    ...(encryptedUnchecked && writeEncrypted ? { writeEncrypted: true } : {}),
  });

  const handleLoad = (): void => {
    clearProgress();
    setLoadReport(null);
    setVerdict(null);
    previewMutation.reset();
    loadMutation.mutate(loadOptions());
  };

  const plan = previewMutation.data?.plan;
  const planMasks = maybeMasks(plan?.removals);
  const reportMasks = maybeMasks(loadReport?.alignment.removals);
  const planOrg = plan ? (orgs.find((o) => o.id === plan.orgId)?.alias ?? plan.orgId) : '';
  const planColumns = plan
    ? [
        { key: 'objectApiName', header: t('frozen.control.object'), sortable: true },
        { key: 'fromFiles', header: t('frozen.preview.fromFiles'), align: 'right' as const },
        { key: 'toInsert', header: t('frozen.preview.toInsert'), align: 'right' as const },
        { key: 'reusedByKeys', header: t('frozen.preview.reusedByKeys'), align: 'right' as const },
        {
          key: 'reusedFromCatalog',
          header: t('frozen.preview.reusedFromCatalog'),
          align: 'right' as const,
        },
        {
          key: 'fieldsDropped',
          header: t('frozen.preview.fieldsDropped'),
          align: 'right' as const,
        },
        {
          key: 'picklistsRewritten',
          header: t('frozen.preview.picklistsRewritten'),
          align: 'right' as const,
        },
        // Said only when some are: most datasets send every record they hold.
        ...(plan.perObject.some((o) => o.notSent > 0)
          ? [{ key: 'notSent', header: t('frozen.preview.notSent'), align: 'right' as const }]
          : []),
        ...(plan.mode.reload
          ? [
              { key: 'toPurge', header: t('frozen.preview.toPurge'), align: 'right' as const },
              {
                key: 'toDeactivate',
                header: t('frozen.preview.toDeactivate'),
                align: 'right' as const,
              },
            ]
          : []),
      ]
    : [];

  const latestProgress = progress.length > 0 ? progress[progress.length - 1] : null;

  const removalRows = (loadReport?.alignment.removals ?? []).map((r) => ({
    key: `${r.objectApiName}.${r.field}`,
    field: `${r.objectApiName}.${r.field}`,
    reason: r.reason,
    affectedRecords: r.affectedRecords,
  }));

  const placeholderRows = (loadReport?.placeholders ?? []).map((p) => ({
    key: `${p.objectApiName}.${p.field}`,
    field: `${p.objectApiName}.${p.field}`,
    placeholder: `${p.placeholderObjectApiName} — ${p.placeholderName}`,
    affectedRecords: p.affectedRecords,
  }));

  const skippedRows = (loadReport?.perObject ?? []).flatMap((o) =>
    o.skippedDuplicates.map((s) => ({
      key: `${o.objectApiName}:${s.referenceId}`,
      object: o.objectApiName,
      referenceId: s.referenceId,
      errors: s.errors.join('; '),
    })),
  );

  // Why the failed records failed: the count said how many, and nothing why.
  const failureRows = reasonRows(failureReasons(loadReport?.perObject ?? []));

  // The records the target refused on fields it named and took once written
  // again without them, or with the value their picklist rule declares: per
  // object and field, what refused it, in what words, and how many.
  const withoutFieldRows = (loadReport?.perObject ?? []).flatMap((o) =>
    (o.writtenWithoutFields?.fields ?? []).map((f) => ({
      key: `${o.objectApiName}\u0000${f.field}\u0000${f.reason}`,
      field: `${o.objectApiName}.${f.field}`,
      refusedBy: t(REFUSED_BY_KEYS[f.refusedBy]),
      written:
        f.replacedWith === undefined
          ? t('frozen.report.writtenWithoutFields.leftOut')
          : t('frozen.report.writtenWithoutFields.replacedWith', { value: f.replacedWith }),
      reason: f.reason,
      rows: f.rows,
    })),
  );

  // What a reload purged of the loads before it, what it left in place, and
  // why the target kept what it would not let go. Shown nowhere, a reload
  // whose only errors were in its purge read "Completed with errors" over a
  // report that named none.
  const purgeRows = loadReport ? purgedRows(loadReport.purge) : [];
  const purgeFailureRows = reasonRows(purgeFailureReasons(loadReport?.purge.failures ?? []));
  const leftUnrecorded = Object.entries(loadReport?.purge.leftUnrecorded ?? {});
  // Never sent to be deleted, the platform deleting none of them: refused,
  // they ended every reload with errors.
  const keptByThePlatform = Object.entries(loadReport?.purge.keptByThePlatform ?? {});

  // The links the load owed after its inserts and did not make, and what
  // each cost: a lookup left empty on a record it wrote — or nothing more
  // than the record holding it, which it did not write. Counted nowhere, a
  // load whose only errors were there read "Completed with errors" over a
  // report that named none.
  const unresolved = loadReport ? unresolvedLinks(loadReport) : [];
  const leftEmptyRows = unresolved
    .filter((link) => link.cause !== 'record-not-loaded')
    .map((link) => ({
      key: `${link.objectApiName}\u0000${link.field}\u0000${link.cause}\u0000${link.message}`,
      object: link.objectApiName,
      field: link.field,
      why:
        link.cause === 'target-not-loaded'
          ? t('frozen.report.unresolved.targetNotLoaded')
          : link.message,
      count: link.count,
    }));
  const lostWithTheirRecord = unresolved.filter((link) => link.cause === 'record-not-loaded');

  const reasonColumns = [
    { key: 'object', header: t('frozen.control.object'), sortable: true },
    {
      key: 'statusCode',
      header: t('frozen.report.statusCode'),
      render: (row: Record<string, unknown>) =>
        row.statusCode ? <code className="font-mono">{String(row.statusCode)}</code> : '—',
    },
    {
      key: 'message',
      header: t('frozen.report.reason'),
      render: (row: Record<string, unknown>) => {
        const hint = row.hint as ErrorHint | null;
        return (
          <div className="flex flex-col gap-1">
            <span className="wrap-break-word">{String(row.message)}</span>
            {hint && <ErrorExplanation hint={hint} />}
          </div>
        );
      },
    },
    {
      key: 'count',
      header: t('frozen.report.affected'),
      align: 'right' as const,
    },
  ];

  return (
    <div className="flex flex-col gap-4" data-testid="frozen-load-tab">
      {lastError && (
        <ErrorBanner message={lastError.message} code={lastError.code} data-testid="frozen-error" />
      )}

      {/* ── Entry guards ──────────────────────────────────────────────── */}
      <Card className="border border-subtle bg-surface-1">
        <CardBody className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-text-primary">{t('frozen.guards.title')}</h2>
          <div className="flex flex-wrap gap-2" data-testid="frozen-guards">
            <Badge variant="info">
              <ShieldCheck className="w-3 h-3 mr-1" />
              {t('frozen.guards.sandboxOnly')}
            </Badge>
            <Badge variant={(config?.protectedOrgIds?.length ?? 0) > 0 ? 'success' : 'default'}>
              {t('frozen.guards.protectedEnvs', {
                count: config?.protectedOrgIds?.length ?? 0,
              })}
            </Badge>
            <Badge variant={status?.mockDetectionConfigured ? 'success' : 'warning'}>
              {status?.mockDetectionConfigured
                ? t('frozen.guards.mocksConfigured')
                : t('frozen.guards.mocksNotConfigured')}
            </Badge>
          </div>
        </CardBody>
      </Card>

      {/* ── Target + options ──────────────────────────────────────────── */}
      <Card className="border border-subtle bg-surface-1">
        <CardBody className="flex flex-col gap-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] text-text-secondary">{t('frozen.load.targetOrg')}</span>
              <OrgDropdown
                value={effectiveTarget}
                onChange={setTargetOrgId}
                orgs={connectedOrgs}
                ariaLabel={t('frozen.load.targetOrg')}
                testId="frozen-load-target"
              />
            </label>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 text-xs text-text-secondary">
                <input
                  type="checkbox"
                  checked={pilot}
                  onChange={(e) => setPilot(e.target.checked)}
                  data-testid="frozen-load-pilot"
                />
                {t('frozen.load.pilot')}
              </label>
              <label className="flex items-center gap-2 text-xs text-text-secondary">
                <input
                  type="checkbox"
                  checked={reload}
                  onChange={(e) => setReload(e.target.checked)}
                  data-testid="frozen-load-reload"
                />
                {t('frozen.load.reload')}
              </label>
            </div>
          </div>
          {encryptedUnchecked && (
            <div className="flex flex-col gap-1">
              <label className="flex items-center gap-2 text-xs text-text-secondary">
                <input
                  type="checkbox"
                  checked={writeEncrypted}
                  onChange={(e) => setWriteEncrypted(e.target.checked)}
                  aria-describedby="frozen-load-write-encrypted-hint"
                  data-testid="frozen-load-write-encrypted"
                />
                {t('frozen.load.writeEncrypted')}
              </label>
              <p id="frozen-load-write-encrypted-hint" className="text-[11px] text-text-secondary">
                {t('frozen.load.writeEncryptedHint')}
              </p>
            </div>
          )}
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              icon={<Play className="w-3 h-3" />}
              loading={loadMutation.loading}
              disabled={!effectiveTarget || !status?.manifest}
              onClick={handleLoad}
              data-testid="frozen-load-run"
            >
              {pilot ? t('frozen.load.runPilot') : t('frozen.load.run')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<Eye className="w-3 h-3" />}
              loading={previewMutation.loading}
              disabled={!effectiveTarget || !status?.manifest || loadMutation.loading}
              onClick={() => previewMutation.mutate(loadOptions())}
              data-testid="frozen-load-preview"
            >
              {t('frozen.load.preview')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              loading={verifyMutation.loading}
              disabled={!effectiveTarget || !loadedIntoTarget}
              focusableWhenDisabled
              aria-describedby={noLoadIntoTarget ? 'frozen-verify-no-load' : undefined}
              onClick={() => verifyMutation.mutate({ targetOrgId: effectiveTarget })}
              data-testid="frozen-verify-run"
            >
              {t('frozen.verify.run')}
            </Button>
            {loadMutation.loading && loadRequestId && (
              <Button
                variant="danger"
                size="sm"
                icon={<Square className="w-3 h-3" />}
                disabled={cancelRequested}
                focusableWhenDisabled
                onClick={cancelLoad}
                data-testid="frozen-load-cancel"
              >
                {t('common.cancelRun')}
              </Button>
            )}
          </div>
          {noLoadIntoTarget && (
            <p
              id="frozen-verify-no-load"
              className="text-[11px] text-text-secondary"
              data-testid="frozen-verify-no-load"
            >
              {t('frozen.verify.noLoad', { org: targetName })}
            </p>
          )}
          {loadMutation.loading && cancelRequested && (
            <p
              className="text-[11px] text-text-secondary"
              role="status"
              data-testid="frozen-load-stopping"
            >
              {t('frozen.load.stopping')}
            </p>
          )}
          {loadMutation.error && (
            <ErrorBanner message={loadMutation.error} code={loadMutation.errorCode} />
          )}
          {verifyMutation.error && (
            <ErrorBanner message={verifyMutation.error} code={verifyMutation.errorCode} />
          )}
        </CardBody>
      </Card>

      {/* ── What the load would do, nothing written ───────────────────── */}
      {plan && (
        <Card className="border border-subtle bg-surface-1">
          <CardBody>
            <div className="flex flex-col gap-2" data-testid="frozen-preview">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-semibold text-text-primary">
                  {t('frozen.preview.title', { org: planOrg })}
                </h2>
                {plan.mode.pilot && <Badge variant="info">{t('frozen.load.pilot')}</Badge>}
                {plan.mode.reload && <Badge variant="info">{t('frozen.load.reload')}</Badge>}
              </div>
              <p className="text-[11px] text-text-secondary">{t('frozen.preview.hint')}</p>
              {plan.mode.reload && !plan.mode.pilot && (
                <p className="text-[11px] text-text-secondary" data-testid="frozen-preview-reload">
                  {t('frozen.preview.earlierLoads', { count: plan.earlierLoads })}
                </p>
              )}
              <DataTable
                columns={planColumns}
                data={plan.perObject.map((o) => ({ ...o }))}
                keyExtractor={(row) => String(row.objectApiName)}
              />
              {plan.excludedObjects.length > 0 && (
                <div data-testid="frozen-preview-excluded">
                  <p className="text-[11px] text-text-secondary">
                    {t('frozen.report.excludedObjects')}
                  </p>
                  <ul className="flex flex-col gap-0.5">
                    {plan.excludedObjects.map((o) => (
                      <li key={o.objectApiName} className="text-[11px] text-text-secondary">
                        {o.objectApiName}: {o.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {planMasks !== '' && (
                <p
                  className="text-[11px] text-status-warning"
                  data-testid="frozen-preview-may-hold-masks"
                >
                  {t('frozen.load.mayHoldMasks', { fields: planMasks })}
                </p>
              )}
              {(plan.heldForExcludedParents?.length ?? 0) > 0 && (
                <p
                  className="text-[11px] text-text-secondary"
                  data-testid="frozen-preview-held-for-excluded"
                >
                  {t('frozen.preview.heldForExcludedParents', {
                    objects: (plan.heldForExcludedParents ?? [])
                      .map((held) => `${held.objectApiName} (${held.count})`)
                      .join(', '),
                  })}
                </p>
              )}
              {plan.placeholders.length > 0 && (
                <p
                  className="text-[11px] text-text-secondary"
                  data-testid="frozen-preview-placeholders"
                >
                  {t('frozen.preview.placeholders', {
                    fields: plan.placeholders
                      .map((p) => `${p.objectApiName}.${p.field} (${p.affectedRecords})`)
                      .join(', '),
                  })}
                </p>
              )}
              {plan.requiredDefaults.length > 0 && (
                <p
                  className="text-[11px] text-text-secondary"
                  data-testid="frozen-preview-defaults"
                >
                  {t('frozen.preview.defaults', {
                    fields: plan.requiredDefaults
                      .map((d) => `${d.objectApiName}.${d.field} (${d.affectedRecords})`)
                      .join(', '),
                  })}
                </p>
              )}
              {/* One value for every record of a unique field is refused from
                  the second record on: run on a client sandbox, the second
                  territory given the same default name was. */}
              {plan.requiredDefaults.some((d) => d.perRecord) && (
                <p
                  className="text-[11px] text-text-secondary"
                  data-testid="frozen-preview-defaults-per-record"
                >
                  {t('frozen.preview.defaultsPerRecord', {
                    fields: plan.requiredDefaults
                      .filter((d) => d.perRecord)
                      .map(
                        (d) =>
                          `${d.objectApiName}.${d.field}${d.example ? ` (“${d.example}”…)` : ''}`,
                      )
                      .join(', '),
                  })}
                </p>
              )}
              {plan.personContacts > 0 && (
                <p
                  className="text-[11px] text-text-secondary"
                  data-testid="frozen-preview-person-contacts"
                >
                  {t('frozen.preview.personContacts', { count: plan.personContacts })}
                </p>
              )}
              {plan.recordTypeIssues > 0 && (
                <p className="text-[11px] text-text-secondary">
                  {t('frozen.preview.recordTypeIssues', { count: plan.recordTypeIssues })}
                </p>
              )}
              {Object.keys(plan.leftUnrecorded ?? {}).length > 0 && (
                <p className="text-[11px] text-text-secondary">
                  {t('frozen.report.purge.leftUnrecorded', {
                    objects: Object.entries(plan.leftUnrecorded ?? {})
                      .map(([objectApiName, records]) => `${objectApiName} (${records})`)
                      .join(', '),
                  })}
                </p>
              )}
              {Object.keys(plan.keptByThePlatform ?? {}).length > 0 && (
                <p
                  className="text-[11px] text-text-secondary"
                  data-testid="frozen-preview-kept-by-platform"
                >
                  {t('frozen.report.purge.keptByThePlatform', {
                    objects: Object.entries(plan.keptByThePlatform ?? {})
                      .map(([objectApiName, records]) => `${objectApiName} (${records})`)
                      .join(', '),
                  })}
                </p>
              )}
              {/* What a preview cannot evaluate, beside what it counts: run on
                  a client sandbox, three loads in a row were each refused by
                  the next validation rule of the accounts. */}
              {plan.validationRulesUnread && (
                <p
                  className="text-[11px] text-status-warning"
                  data-testid="frozen-preview-rules-unread"
                >
                  {t('frozen.preview.validationRulesUnread', {
                    reason: plan.validationRulesUnread,
                  })}
                </p>
              )}
              {plan.perObject
                .filter((o) => (o.validationRules?.length ?? 0) > 0)
                .map((o) => (
                  <div
                    key={o.objectApiName}
                    data-testid={`frozen-preview-rules-${o.objectApiName}`}
                  >
                    <p className="text-[11px] text-status-warning">
                      {t('frozen.preview.validationRules', {
                        object: o.objectApiName,
                        count: o.validationRules?.length ?? 0,
                      })}
                    </p>
                    <ul className="mt-1 flex flex-col gap-0.5">
                      {(o.validationRules ?? []).map((rule) => (
                        <li key={rule.name} className="text-[10px] text-text-secondary">
                          <code>{rule.name}</code>
                          {rule.field ? ` (${rule.field})` : ''}
                          {rule.message ? ` — ${rule.message}` : ''}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              {/* Named, not listed: run on a large client sandbox, the preview
                  listed fourteen rules of one object, most of them guards no
                  insert meets. */}
              {plan.perObject
                .filter((o) => (o.validationRulesOnChange?.length ?? 0) > 0)
                .map((o) => (
                  <p
                    key={o.objectApiName}
                    className="text-[11px] text-text-secondary"
                    data-testid={`frozen-preview-rules-on-change-${o.objectApiName}`}
                  >
                    {t('frozen.preview.validationRulesOnChange', {
                      object: o.objectApiName,
                      count: o.validationRulesOnChange?.length ?? 0,
                      rules: (o.validationRulesOnChange ?? []).join(', '),
                      // The formula's own words, the same in every language.
                      functions: 'ISCHANGED, PRIORVALUE, NOT(ISNEW())',
                    })}
                  </p>
                ))}
              {/* A placeholder goes in with its name alone, and one refused
                  stops the load. */}
              {[
                ...new Map(
                  plan.placeholders
                    .filter((p) => (p.validationRules?.length ?? 0) > 0)
                    .map((p) => [p.placeholderObjectApiName, p.validationRules ?? []]),
                ),
              ].map(([objectApiName, rules]) => (
                <div
                  key={objectApiName}
                  data-testid={`frozen-preview-placeholder-rules-${objectApiName}`}
                >
                  <p className="text-[11px] text-status-warning">
                    {t('frozen.preview.placeholderValidationRules', {
                      object: objectApiName,
                      count: rules.length,
                    })}
                  </p>
                  <ul className="mt-1 flex flex-col gap-0.5">
                    {rules.map((rule) => (
                      <li key={rule.name} className="text-[10px] text-text-secondary">
                        <code>{rule.name}</code>
                        {rule.field ? ` (${rule.field})` : ''}
                        {rule.message ? ` — ${rule.message}` : ''}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </CardBody>
        </Card>
      )}

      {/* ── Last load into the selected target, and taking it back ────── */}
      <FrozenLoadRemoval
        records={status?.loadRecords?.find((load) => load.orgId === effectiveTarget)}
        onAnswered={onRefetchStatus}
        busy={loadMutation.loading}
      />

      {/* ── Progress ──────────────────────────────────────────────────── */}
      {progress.length > 0 && (
        <Card className="border border-subtle bg-surface-1">
          <CardBody>
            <div className="flex flex-col gap-2" data-testid="frozen-load-progress">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-text-primary">
                  {t('frozen.load.progress')}
                </h2>
                {latestProgress && (
                  <span className="text-[10px] text-text-secondary tabular-nums">
                    {latestProgress.progress}%
                  </span>
                )}
              </div>
              {latestProgress && (
                <div data-testid="frozen-load-progress-bar">
                  <ProgressBar
                    value={latestProgress.progress}
                    size="sm"
                    ariaLabel={t('frozen.load.progress')}
                    barClassName="bg-hue-cyan"
                  />
                </div>
              )}
              <ul className="flex flex-col gap-0.5 max-h-40 overflow-y-auto">
                {progress.slice(-20).map((event, index) => (
                  <li
                    key={index}
                    className="flex items-center gap-2 text-[11px] text-text-secondary"
                  >
                    <Badge variant={PROGRESS_VARIANTS[event.status]}>
                      {t(`frozen.loadPhase.${event.phase}`)}
                    </Badge>
                    <span className="truncate">
                      {event.objectName ? `${event.objectName} — ` : ''}
                      {event.message}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </CardBody>
        </Card>
      )}

      {/* ── Load report ───────────────────────────────────────────────── */}
      {loadReport && (
        <Card className="border border-subtle bg-surface-1">
          <CardBody>
            <div className="flex flex-col gap-3" data-testid="frozen-load-report">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold text-text-primary">
                  {t('frozen.report.title')}
                </h2>
                <Badge variant={loadReport.status === 'completed' ? 'success' : 'warning'}>
                  {t(`frozen.report.status.${loadReport.status}`)}
                </Badge>
                <span className="text-[10px] text-text-secondary">
                  {Math.round(loadReport.durationMs / 1000)}s
                </span>
              </div>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <KPICard
                  icon="database"
                  label={t('frozen.report.inserted')}
                  value={sumPerObject(loadReport, (o) => o.inserted)}
                  variant="success"
                />
                <KPICard
                  icon="history"
                  label={t('frozen.report.reused')}
                  value={sumPerObject(loadReport, (o) => o.reused)}
                />
                <KPICard
                  icon="debug-step-over"
                  label={t('frozen.report.skipped')}
                  value={sumPerObject(loadReport, (o) => o.skippedDuplicates.length)}
                  variant="warning"
                />
                <KPICard
                  icon="error"
                  label={t('frozen.report.failed')}
                  value={sumPerObject(loadReport, (o) => o.failed.length)}
                  variant={
                    sumPerObject(loadReport, (o) => o.failed.length) > 0 ? 'error' : 'default'
                  }
                />
              </div>

              {failureRows.length > 0 && (
                <div data-testid="frozen-report-failures">
                  <span className="text-xs font-medium text-text-primary">
                    {t('frozen.report.failedReasons')}
                  </span>
                  <DataTable
                    columns={reasonColumns}
                    data={failureRows}
                    keyExtractor={(row) => row.key as string}
                  />
                </div>
              )}

              {/* In the target, each without a value the dataset holds: which field, what refused it, and how many. */}
              {withoutFieldRows.length > 0 && (
                <div data-testid="frozen-report-written-without-fields">
                  <span className="text-xs font-medium text-text-primary">
                    {t('frozen.report.writtenWithoutFields.title')}
                  </span>
                  <p className="text-[11px] text-text-secondary">
                    {t('frozen.report.writtenWithoutFields.hint')}
                  </p>
                  <DataTable
                    columns={[
                      { key: 'field', header: t('frozen.report.field'), sortable: true },
                      {
                        key: 'refusedBy',
                        header: t('frozen.report.writtenWithoutFields.refusedBy'),
                      },
                      { key: 'written', header: t('frozen.report.writtenWithoutFields.written') },
                      { key: 'reason', header: t('frozen.report.reason') },
                      {
                        key: 'rows',
                        header: t('frozen.report.affected'),
                        align: 'right' as const,
                      },
                    ]}
                    data={withoutFieldRows}
                    keyExtractor={(row) => row.key}
                  />
                </div>
              )}

              {/* Each object the load did not send, and why: the target lacks it, or takes no insert of it. */}
              {loadReport.alignment.excludedObjects.length > 0 && (
                <div data-testid="frozen-report-excluded">
                  <p className="text-[11px] text-text-secondary">
                    {t('frozen.report.excludedObjects')}
                  </p>
                  <ul className="flex flex-col gap-0.5">
                    {loadReport.alignment.excludedObjects.map((o) => (
                      <li key={o.objectApiName} className="text-[11px] text-text-secondary">
                        {o.objectApiName}: {o.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* A reload's purge of what earlier loads created: what went, what stayed, and why. */}
              {purgeRows.length +
                purgeFailureRows.length +
                leftUnrecorded.length +
                keptByThePlatform.length >
                0 && (
                <div className="flex flex-col gap-2" data-testid="frozen-report-purge">
                  <span className="text-xs font-medium text-text-primary">
                    {t('frozen.report.purge.title')}
                  </span>
                  {purgeRows.length > 0 && (
                    <DataTable
                      columns={[
                        { key: 'object', header: t('frozen.control.object'), sortable: true },
                        {
                          key: 'deleted',
                          header: t('frozen.report.purge.deleted'),
                          align: 'right' as const,
                        },
                        {
                          key: 'deactivated',
                          header: t('frozen.report.purge.deactivated'),
                          align: 'right' as const,
                        },
                      ]}
                      data={purgeRows}
                      keyExtractor={(row) => row.key as string}
                    />
                  )}
                  {leftUnrecorded.length > 0 && (
                    <p
                      className="text-[11px] text-text-secondary"
                      data-testid="frozen-report-purge-left"
                    >
                      {t('frozen.report.purge.leftUnrecorded', {
                        objects: leftUnrecorded
                          .map(([objectApiName, records]) => `${objectApiName} (${records})`)
                          .join(', '),
                      })}
                    </p>
                  )}
                  {keptByThePlatform.length > 0 && (
                    <p
                      className="text-[11px] text-text-secondary"
                      data-testid="frozen-report-purge-kept"
                    >
                      {t('frozen.report.purge.keptByThePlatform', {
                        objects: keptByThePlatform
                          .map(([objectApiName, records]) => `${objectApiName} (${records})`)
                          .join(', '),
                      })}
                    </p>
                  )}
                  {purgeFailureRows.length > 0 && (
                    <div data-testid="frozen-report-purge-failures">
                      <span className="text-xs font-medium text-text-primary">
                        {t('frozen.report.purge.failedReasons')}
                      </span>
                      <DataTable
                        columns={reasonColumns}
                        data={purgeFailureRows}
                        keyExtractor={(row) => row.key as string}
                      />
                    </div>
                  )}
                </div>
              )}

              {removalRows.length > 0 && (
                <div data-testid="frozen-report-removals">
                  <span className="text-xs font-medium text-text-primary">
                    {t('frozen.report.removals')}
                  </span>
                  {reportMasks !== '' && (
                    <p
                      className="text-[11px] text-status-warning"
                      data-testid="frozen-report-may-hold-masks"
                    >
                      {t('frozen.load.mayHoldMasks', { fields: reportMasks })}
                    </p>
                  )}
                  <DataTable
                    columns={[
                      { key: 'field', header: t('frozen.report.field'), sortable: true },
                      { key: 'reason', header: t('frozen.report.reason') },
                      {
                        key: 'affectedRecords',
                        header: t('frozen.report.affected'),
                        align: 'right' as const,
                      },
                    ]}
                    data={removalRows}
                    keyExtractor={(row) => row.key as string}
                  />
                </div>
              )}

              {placeholderRows.length > 0 && (
                <div data-testid="frozen-report-placeholders">
                  <span className="text-xs font-medium text-text-primary">
                    {t('frozen.report.placeholders')}
                  </span>
                  <DataTable
                    columns={[
                      { key: 'field', header: t('frozen.report.field'), sortable: true },
                      { key: 'placeholder', header: t('frozen.report.placeholder') },
                      {
                        key: 'affectedRecords',
                        header: t('frozen.report.affected'),
                        align: 'right' as const,
                      },
                    ]}
                    data={placeholderRows}
                    keyExtractor={(row) => row.key as string}
                  />
                </div>
              )}

              {skippedRows.length > 0 && (
                <div data-testid="frozen-report-skipped">
                  <span className="text-xs font-medium text-text-primary">
                    {t('frozen.report.skippedList')}
                  </span>
                  <DataTable
                    columns={[
                      { key: 'object', header: t('frozen.control.object'), sortable: true },
                      { key: 'referenceId', header: 'referenceId' },
                      { key: 'errors', header: t('frozen.report.errors') },
                    ]}
                    data={skippedRows}
                    keyExtractor={(row) => row.key as string}
                  />
                </div>
              )}

              <p className="text-[11px] text-text-secondary" data-testid="frozen-report-postload">
                {t('frozen.report.postLoad', {
                  pass2: loadReport.pass2.resolved,
                  pass2Unresolved: unresolvedCycleLookups(loadReport),
                  personContact: loadReport.personContact.restored,
                  personContactSent: loadReport.personContact.sent?.length ?? 0,
                  personContactUnresolved: loadReport.personContact.unresolved.length,
                })}
              </p>
              {/* Per object and lookup: what stays empty on the records the load wrote, and why. */}
              {unresolved.length > 0 && (
                <div className="flex flex-col gap-2" data-testid="frozen-report-unresolved">
                  <span className="text-xs font-medium text-text-primary">
                    {t('frozen.report.unresolved.title')}
                  </span>
                  {leftEmptyRows.length > 0 && (
                    <DataTable
                      columns={[
                        { key: 'object', header: t('frozen.control.object'), sortable: true },
                        { key: 'field', header: t('frozen.report.unresolved.lookup') },
                        { key: 'why', header: t('frozen.report.reason') },
                        {
                          key: 'count',
                          header: t('frozen.report.unresolved.leftEmpty'),
                          align: 'right' as const,
                        },
                      ]}
                      data={leftEmptyRows}
                      keyExtractor={(row) => row.key}
                    />
                  )}
                  {lostWithTheirRecord.length > 0 && (
                    <p
                      className="text-[11px] text-text-secondary"
                      data-testid="frozen-report-unresolved-lost"
                    >
                      {t('frozen.report.unresolved.lostWithTheirRecord', {
                        links: lostWithTheirRecord
                          .map((link) => `${link.objectApiName}.${link.field} (${link.count})`)
                          .join(', '),
                      })}
                    </p>
                  )}
                </div>
              )}
              {/* Never sent, so neither inserted nor failed: said on their own. */}
              {(loadReport.leftToThePlatform?.length ?? 0) > 0 && (
                <p
                  className="text-[11px] text-text-secondary"
                  data-testid="frozen-report-left-to-the-platform"
                >
                  {t('frozen.report.leftToThePlatform', {
                    objects: (loadReport.leftToThePlatform ?? [])
                      .map((left) => `${left.objectApiName} (${left.count})`)
                      .join(', '),
                  })}
                </p>
              )}
              {/* Never sent either: a dataset extracted before feed items kept their type. */}
              {(loadReport.untypedFeedItems?.length ?? 0) > 0 && (
                <p
                  className="text-[11px] text-text-secondary"
                  data-testid="frozen-report-untyped-feed-items"
                >
                  {t('frozen.report.untypedFeedItems', {
                    objects: (loadReport.untypedFeedItems ?? [])
                      .map((left) => `${left.objectApiName} (${left.count})`)
                      .join(', '),
                  })}
                </p>
              )}
              {/* Never sent: what they cannot go in without, excludedObjects leaves out. */}
              {(loadReport.heldForExcludedParents?.length ?? 0) > 0 && (
                <p
                  className="text-[11px] text-text-secondary"
                  data-testid="frozen-report-held-for-excluded"
                >
                  {t('frozen.report.heldForExcludedParents', {
                    objects: (loadReport.heldForExcludedParents ?? [])
                      .map((held) => `${held.objectApiName} (${held.count})`)
                      .join(', '),
                  })}
                </p>
              )}
              {loadReport.statuses &&
                loadReport.statuses.restored + loadReport.statuses.refused.length > 0 && (
                  <div data-testid="frozen-report-statuses">
                    <p className="text-[11px] text-text-secondary">
                      {t('frozen.report.statuses', {
                        restored: loadReport.statuses.restored,
                        refused: loadReport.statuses.refused.length,
                      })}
                    </p>
                    <ul className="flex flex-col gap-0.5">
                      {loadReport.statuses.refused.map((r) => (
                        <li
                          key={`${r.objectApiName}-${r.referenceId}`}
                          className="text-[11px] text-status-error"
                        >
                          {r.objectApiName} {r.referenceId} → {r.status}: {r.detail}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              {/* The target as the load filled it, kept before the testers
                  start: the org the report is of, whichever is picked now. */}
              <TakeCheckpointNow
                orgId={loadReport.orgId}
                wrote={loadWrote(loadReport)}
                testId="frozen-report-checkpoint-now"
              />
            </div>
          </CardBody>
        </Card>
      )}

      {/* ── Post-load verdict ─────────────────────────────────────────── */}
      {verdict && (
        <Card className="border border-subtle bg-surface-1">
          <CardBody>
            <div className="flex flex-col gap-2" data-testid="frozen-verify-result">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold text-text-primary">
                  {t('frozen.verify.title')}
                </h2>
                <Badge
                  variant={
                    verdict.status === 'passed'
                      ? 'success'
                      : verdict.status === 'unstable' || verdict.status === 'partial'
                        ? 'warning'
                        : 'error'
                  }
                >
                  {t(`frozen.verify.status.${verdict.status}`)}
                </Badge>
                <span className="text-[10px] text-text-secondary">
                  {t('frozen.verify.attempts', { count: verdict.attempts })}
                </span>
              </div>
              <DataTable
                columns={[
                  { key: 'name', header: t('frozen.control.check'), sortable: true },
                  {
                    key: 'passed',
                    header: t('frozen.control.result'),
                    render: (row: Record<string, unknown>) => (
                      <Badge variant={row.passed ? 'success' : 'error'}>
                        {row.passed ? t('frozen.control.pass') : t('frozen.control.fail')}
                      </Badge>
                    ),
                  },
                  { key: 'detail', header: t('frozen.control.detail') },
                ]}
                data={verdict.checks.map((c) => ({
                  name: c.name,
                  passed: c.passed,
                  detail: c.detail,
                }))}
                keyExtractor={(row) => row.name as string}
              />
            </div>
          </CardBody>
        </Card>
      )}
    </div>
  );
};
