import React, { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CLEANUP_ACTION_LIMIT,
  COMPLIANCE_MAX_OBJECTS,
  QUALITY_SCAN_DEFAULT_STALE_DAYS,
  QUALITY_SCAN_MAX_STALE_DAYS,
} from '@sandforge/shared';
import type {
  CleanupObjectResult as CleanupResult,
  CleanupRecommendation,
  CleanupScanResult,
  DataQualityScanTarget,
  RemovalOutcome,
  RemovalPlanObject,
} from '@sandforge/shared';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { useLatestRef } from '../../hooks/useLatestRef';
import { Button } from '../../components/ui/Button';
import { DangerConfirm } from '../../components/ui/DangerConfirm';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { Input } from '../../components/ui/Input';
import { formatNumber } from '../../utils/formatters';
import { CleanupObjectResult } from './CleanupObjectResult';
import { ObjectPicker } from './ObjectPicker';
import { mergeObjectResults, parseStaleDays } from './QualityPanel';
import { RemovalOutcomeView, RemovalPlanView } from './RemovalPlanView';

/** How long an export or a delete may wait on the host: the Save dialog and the guard wait on a person. */
const WAIT_ON_A_PERSON_MS = 600_000;

/** Props for {@link CleanupPanel}. */
export interface CleanupPanelProps {
  /** The org the scan reads and a delete writes. */
  orgId: string;
}

/** What `dataops:cleanup:delete` answers. */
interface DeleteAnswer {
  objectApiName: string;
  dryRun: boolean;
  plan: RemovalPlanObject;
  truncated: boolean;
  outcome?: RemovalOutcome;
}

/** What `dataops:cleanup:export` answers. */
interface ExportAnswer {
  objectApiName: string;
  records: number;
  truncated: boolean;
  saved:
    | { status: 'saved'; path: string }
    | { status: 'cancelled' }
    | { status: 'error'; message: string };
}

/** What the page shows: the objects of the last answers, and what they were counted with. */
interface Report {
  objects: CleanupResult[];
  staleDays: number;
  orphanThreshold: number;
  duplicateGroupLimit: number;
}

/** The recommendation a delete is being reviewed for. */
interface Review {
  objectApiName: string;
  label: string;
  recommendation: CleanupRecommendation;
  /** The label of the lookup or the key a recommendation names, as the scan read it. */
  fieldLabel: string;
}

/** The label of the field a recommendation names, from the scan it came from. */
function fieldLabelOf(result: CleanupResult, recommendation: CleanupRecommendation): string {
  if (recommendation.kind === 'stale' || result.status !== 'scanned') return '';
  if (recommendation.kind === 'orphans') {
    return (
      result.orphans.find((o) => o.fieldApiName === recommendation.fieldApiName)?.label ??
      recommendation.fieldApiName
    );
  }
  return result.duplicates?.keyLabel ?? recommendation.keyField;
}

/**
 * The Cleanup tab: for the objects picked, the records a cleanup would look at
 * — not modified for a number of days, orphans of a lookup the business
 * relies on, copies of a repeated value — each exported to a file or deleted.
 *
 * The scan counts and writes nothing. A delete starts with a review — how
 * many records, and what the org deletes along with them — and goes through a
 * typed confirmation and Production Guard. It reads at most
 * {@link CLEANUP_ACTION_LIMIT} records per run.
 */
export const CleanupPanel: React.FC<CleanupPanelProps> = ({ orgId }) => {
  const { t } = useTranslation();
  const staleId = useId();
  const reviewHeadingId = useId();
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const number = (n: number): string => formatNumber(n);

  const scan = useBridgeMutation<CleanupScanResult>('dataops:cleanup:scan', {
    responseType: 'dataops:cleanup:scan:response',
    errorType: 'dataops:error',
    timeoutMs: 300_000,
  });
  const exportRecords = useBridgeMutation<ExportAnswer>('dataops:cleanup:export', {
    responseType: 'dataops:cleanup:export:response',
    errorType: 'dataops:error',
    timeoutMs: WAIT_ON_A_PERSON_MS,
  });
  const plan = useBridgeMutation<DeleteAnswer>('dataops:cleanup:delete', {
    responseType: 'dataops:cleanup:delete:response',
    errorType: 'dataops:error',
    timeoutMs: 300_000,
  });
  const remove = useBridgeMutation<DeleteAnswer>('dataops:cleanup:delete', {
    responseType: 'dataops:cleanup:delete:response',
    errorType: 'dataops:error',
    timeoutMs: WAIT_ON_A_PERSON_MS,
  });

  const [selected, setSelected] = useState<string[]>([]);
  const [staleInput, setStaleInput] = useState(String(QUALITY_SCAN_DEFAULT_STALE_DAYS));
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [report, setReport] = useState<Report | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const answer = scan.data;
  useEffect(() => {
    if (!answer) return;
    setReport((previous) => ({
      objects: mergeObjectResults(previous?.objects ?? [], answer.objects),
      staleDays: answer.staleDays,
      orphanThreshold: answer.orphanThreshold,
      duplicateGroupLimit: answer.bounds.duplicateGroupLimit,
    }));
  }, [answer]);

  const staleDays = parseStaleDays(staleInput);
  const target = (objectApiName: string): DataQualityScanTarget =>
    keys[objectApiName] ? { objectApiName, duplicateKey: keys[objectApiName] } : { objectApiName };

  const closeReview = (): void => {
    setReview(null);
    plan.reset();
    remove.reset();
  };

  const runScan = (): void => {
    if (selected.length === 0 || staleDays === null) return;
    // A new scan answers for the objects picked now, not for the ones before.
    setReport(null);
    closeReview();
    scan.mutate({ orgId, objects: selected.map(target), staleDays });
  };

  const rescan = (objectApiName: string, duplicateKey?: string): void => {
    if (!report) return;
    const object = duplicateKey ? { objectApiName, duplicateKey } : target(objectApiName);
    // The rest of the page was counted with this threshold; keep to it.
    scan.mutate({ orgId, objects: [object], staleDays: report.staleDays });
  };

  const changeKey = (objectApiName: string, duplicateKey: string): void => {
    setKeys((current) => ({ ...current, [objectApiName]: duplicateKey }));
    closeReview();
    rescan(objectApiName, duplicateKey);
  };

  const startReview = (result: CleanupResult, recommendation: CleanupRecommendation): void => {
    remove.reset();
    setReview({
      objectApiName: result.objectApiName,
      label: result.status === 'scanned' ? result.label : result.objectApiName,
      recommendation,
      fieldLabel: fieldLabelOf(result, recommendation),
    });
    plan.mutate({ orgId, objectApiName: result.objectApiName, recommendation, dryRun: true });
  };

  // The review opens where the user can reach it: focus goes to its heading.
  const reviewing = review !== null;
  useEffect(() => {
    if (reviewing) reviewHeading.current?.focus();
  }, [reviewing]);

  const confirmDelete = (): void => {
    setConfirmOpen(false);
    if (!review) return;
    remove.mutate({
      orgId,
      objectApiName: review.objectApiName,
      recommendation: review.recommendation,
      dryRun: false,
    });
  };

  // After a delete the counts on screen are yesterday's: the object is counted again.
  const recount = useLatestRef((objectApiName: string) => rescan(objectApiName));
  const deleted = remove.data;
  useEffect(() => {
    if (deleted?.outcome) recount.current(deleted.objectApiName);
  }, [deleted, recount]);

  const recommendationText = (current: Review): string => {
    const { recommendation } = current;
    switch (recommendation.kind) {
      case 'stale':
        return t('dataops.cleanupScan.reviewStale', {
          object: current.label,
          days: number(recommendation.days),
        });
      case 'orphans':
        return t('dataops.cleanupScan.reviewOrphans', {
          object: current.label,
          field: current.fieldLabel,
        });
      default:
        return t('dataops.cleanupScan.reviewDuplicates', {
          object: current.label,
          field: current.fieldLabel,
        });
    }
  };

  const planned = plan.data?.dryRun ? plan.data : null;
  const toDelete = planned && !planned.plan.refused ? planned.plan.records : 0;
  const exportStatus = exportRecords.data;
  const busy = scan.loading || plan.loading || remove.loading || exportRecords.loading;

  return (
    <div className="flex flex-col gap-3" data-testid="cleanup-panel">
      <h2 className="text-sm font-semibold text-text-primary">{t('dataops.cleanup')}</h2>
      <p className="text-xs text-text-secondary">{t('dataops.cleanupScan.intro')}</p>

      <ObjectPicker
        orgId={orgId}
        selected={selected}
        onChange={setSelected}
        max={COMPLIANCE_MAX_OBJECTS}
        legend={t('dataops.cleanupScan.objectsLegend', { max: COMPLIANCE_MAX_OBJECTS })}
        testIdPrefix="cleanup"
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-40">
          <Input
            id={staleId}
            type="number"
            min={1}
            max={QUALITY_SCAN_MAX_STALE_DAYS}
            label={t('dataops.qualityScan.staleDays')}
            value={staleInput}
            onChange={(e) => setStaleInput(e.target.value)}
            error={
              staleDays === null
                ? t('dataops.qualityScan.staleDaysInvalid', { max: QUALITY_SCAN_MAX_STALE_DAYS })
                : undefined
            }
            data-testid="cleanup-stale-days"
          />
        </div>
        <Button
          variant="primary"
          size="sm"
          onClick={runScan}
          loading={scan.loading}
          disabled={selected.length === 0 || staleDays === null}
          data-testid="cleanup-scan-btn"
        >
          {t('dataops.cleanupScan.scan')}
        </Button>
      </div>

      <p className="text-xs text-text-secondary">
        {t('dataops.cleanupScan.method', { limit: number(CLEANUP_ACTION_LIMIT) })}
      </p>

      {scan.error && <ErrorBanner message={scan.error} data-testid="cleanup-scan-error" />}

      <p aria-live="polite" className="text-xs" data-testid="cleanup-export-status">
        {exportStatus?.saved.status === 'saved' &&
          t('dataops.cleanupScan.exported', {
            count: exportStatus.records,
            formatted: number(exportStatus.records),
            path: exportStatus.saved.path,
          })}
        {exportStatus?.saved.status === 'saved' &&
          exportStatus.truncated &&
          ` ${t('dataops.cleanupScan.exportTruncated', { limit: number(CLEANUP_ACTION_LIMIT) })}`}
        {exportStatus?.saved.status === 'cancelled' && t('dataops.dsr.exportCancelled')}
        {exportStatus?.saved.status === 'error' && exportStatus.saved.message}
      </p>
      {exportRecords.error && (
        <ErrorBanner message={exportRecords.error} data-testid="cleanup-export-error" />
      )}

      {review && (
        <section
          aria-labelledby={reviewHeadingId}
          className="flex flex-col gap-2 rounded-lg border border-status-warning p-3"
          data-testid="cleanup-review"
        >
          <h3
            id={reviewHeadingId}
            ref={reviewHeading}
            tabIndex={-1}
            className="text-sm font-semibold text-text-primary focus:outline-none"
          >
            {recommendationText(review)}
          </h3>
          {plan.loading && (
            <p role="status" className="text-xs text-text-secondary">
              {t('dataops.cleanupScan.reviewing')}
            </p>
          )}
          {plan.error && <ErrorBanner message={plan.error} data-testid="cleanup-review-error" />}
          {planned && (
            <>
              <RemovalPlanView mode="delete" plan={[planned.plan]} />
              {planned.truncated && (
                <p className="text-xs text-status-warning" data-testid="cleanup-review-truncated">
                  {t('dataops.cleanupScan.deleteTruncated', {
                    limit: number(CLEANUP_ACTION_LIMIT),
                  })}
                </p>
              )}
            </>
          )}
          {remove.error && (
            <ErrorBanner message={remove.error} data-testid="cleanup-delete-error" />
          )}
          {remove.data?.outcome && (
            <RemovalOutcomeView mode="delete" outcome={remove.data.outcome} />
          )}
          <div className="flex flex-wrap gap-2">
            {planned && !remove.data?.outcome && (
              <Button
                variant="danger"
                size="sm"
                onClick={() => setConfirmOpen(true)}
                disabled={toDelete === 0}
                loading={remove.loading}
                data-testid="cleanup-delete-btn"
              >
                {t('dataops.cleanupScan.deleteRecords', {
                  count: toDelete,
                  formatted: number(toDelete),
                })}
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              onClick={closeReview}
              data-testid="cleanup-review-close"
            >
              {t('common.close')}
            </Button>
          </div>
          <DangerConfirm
            open={confirmOpen}
            onClose={() => setConfirmOpen(false)}
            onConfirm={confirmDelete}
            title={t('dataops.cleanupScan.confirmTitle', {
              count: toDelete,
              formatted: number(toDelete),
            })}
            description={t('dataops.cleanupScan.confirmDescription')}
            confirmText={t('dataops.cleanupScan.confirmWord')}
          />
        </section>
      )}

      {report && (
        <div className="flex flex-col gap-3" data-testid="cleanup-results">
          {report.objects.map((result) => (
            <CleanupObjectResult
              key={result.objectApiName}
              result={result}
              staleDays={report.staleDays}
              orphanThreshold={report.orphanThreshold}
              duplicateGroupLimit={report.duplicateGroupLimit}
              onKeyChange={(key) => changeKey(result.objectApiName, key)}
              onExport={(recommendation) =>
                exportRecords.mutate({ orgId, objectApiName: result.objectApiName, recommendation })
              }
              onReview={(recommendation) => startReview(result, recommendation)}
              busy={busy}
            />
          ))}
        </div>
      )}
    </div>
  );
};
