import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Play, ShieldCheck } from 'lucide-react';
import type {
  FrozenLoadReportInfo,
  FrozenLoadResponse,
  FrozenVerifyVerdict,
} from '@sandforge/shared';
import { useOrgStore } from '../../stores/useOrgStore';
import { useFrozenStore } from '../../stores/useFrozenStore';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Card, CardBody } from '../../components/ui/Card';
import { DataTable } from '../../components/ui/DataTable';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { KPICard } from '../../components/ui/KPICard';
import { OrgDropdown } from '../../components/ui/OrgDropdown';
import { useFrozenMutation } from './useFrozenBridge';

/** Props for the load tab. */
export interface FrozenLoadTabProps {
  /** Refetch the module status after a mutation completed. */
  onRefetchStatus: () => void;
}

/** Sum a numeric field across per-object load results. */
function sumPerObject(
  report: FrozenLoadReportInfo,
  pick: (o: FrozenLoadReportInfo['perObject'][number]) => number,
): number {
  return report.perObject.reduce((sum, o) => sum + pick(o), 0);
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

  const [targetOrgId, setTargetOrgId] = useState('');
  const [pilot, setPilot] = useState(false);
  const [reload, setReload] = useState(false);

  const loadMutation = useFrozenMutation<FrozenLoadResponse['payload']>('frozen:load', {
    timeoutMs: 1_800_000,
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

  const effectiveTarget = targetOrgId || selectedOrgId || '';
  const connectedOrgs = orgs.filter((o) => o.status === 'connected');

  const handleLoad = (): void => {
    clearProgress();
    setLoadReport(null);
    setVerdict(null);
    loadMutation.mutate({
      targetOrgId: effectiveTarget,
      ...(pilot ? { pilot: true } : {}),
      ...(reload ? { reload: true } : {}),
    });
  };

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

  return (
    <div className="flex flex-col gap-4" data-testid="frozen-load-tab">
      {lastError && (
        <ErrorBanner
          message={`${lastError.code}: ${lastError.message}`}
          data-testid="frozen-error"
        />
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
            <Badge variant={status?.salt.present ? 'success' : 'warning'}>
              {status?.salt.present ? t('frozen.guards.saltOk') : t('frozen.guards.saltMissing')}
            </Badge>
          </div>
        </CardBody>
      </Card>

      {/* ── Target + options ──────────────────────────────────────────── */}
      <Card className="border border-subtle bg-surface-1">
        <CardBody className="flex flex-col gap-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] text-text-muted">{t('frozen.load.targetOrg')}</span>
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
              loading={verifyMutation.loading}
              disabled={!effectiveTarget || !status?.lastLoad}
              onClick={() => verifyMutation.mutate({ targetOrgId: effectiveTarget })}
              data-testid="frozen-verify-run"
            >
              {t('frozen.verify.run')}
            </Button>
          </div>
          {loadMutation.error && <ErrorBanner message={loadMutation.error} />}
          {verifyMutation.error && <ErrorBanner message={verifyMutation.error} />}
        </CardBody>
      </Card>

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
                  <span className="text-[10px] text-text-muted tabular-nums">
                    {latestProgress.progress}%
                  </span>
                )}
              </div>
              {latestProgress && (
                <div className="w-full h-1.5 rounded-full bg-surface-3 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-cyan-400 transition-all"
                    style={{ width: `${latestProgress.progress}%` }}
                    data-testid="frozen-load-progress-bar"
                  />
                </div>
              )}
              <ul className="flex flex-col gap-0.5 max-h-40 overflow-y-auto">
                {progress.slice(-20).map((event, index) => (
                  <li
                    key={index}
                    className="flex items-center gap-2 text-[11px] text-text-secondary"
                  >
                    <Badge
                      variant={
                        event.status === 'error'
                          ? 'error'
                          : event.status === 'done'
                            ? 'success'
                            : 'info'
                      }
                    >
                      {event.phase}
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
                <span className="text-[10px] text-text-muted">
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

              {removalRows.length > 0 && (
                <div data-testid="frozen-report-removals">
                  <span className="text-xs font-medium text-text-primary">
                    {t('frozen.report.removals')}
                  </span>
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

              <p className="text-[11px] text-text-muted" data-testid="frozen-report-postload">
                {t('frozen.report.postLoad', {
                  pass2: loadReport.pass2.resolved,
                  personContact: loadReport.personContact.restored,
                })}
              </p>
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
                      : verdict.status === 'unstable'
                        ? 'warning'
                        : 'error'
                  }
                >
                  {t(`frozen.verify.status.${verdict.status}`)}
                </Badge>
                <span className="text-[10px] text-text-muted">
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
