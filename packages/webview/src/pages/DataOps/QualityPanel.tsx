import React, { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  QUALITY_SCAN_DEFAULT_STALE_DAYS,
  QUALITY_SCAN_MAX_OBJECTS,
  QUALITY_SCAN_MAX_STALE_DAYS,
} from '@sandforge/shared';
import type {
  DataQualityObjectResult,
  DataQualityScanBounds,
  DataQualityScanResult,
  DataQualityScanTarget,
} from '@sandforge/shared';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { Button } from '../../components/ui/Button';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { Input } from '../../components/ui/Input';
import { ObjectPicker } from './ObjectPicker';
import { QualityObjectResult } from './QualityObjectResult';

/** Props for {@link QualityPanel}. */
export interface QualityPanelProps {
  /** The org the scan reads. */
  orgId: string;
}

/** What the page shows: the objects of the last answers, and what they were counted with. */
interface Report {
  objects: DataQualityObjectResult[];
  bounds: DataQualityScanBounds;
  staleDays: number;
}

/**
 * The objects of `incoming` in place of their earlier results, the others
 * kept, in the order they were first shown. A change of duplicate key rescans
 * one object; the page must not lose the others to it.
 */
export function mergeObjectResults<T extends { objectApiName: string }>(
  previous: readonly T[],
  incoming: readonly T[],
): T[] {
  const byName = new Map(incoming.map((o) => [o.objectApiName, o]));
  const merged = previous.map((o) => byName.get(o.objectApiName) ?? o);
  const shown = new Set(previous.map((o) => o.objectApiName));
  return [...merged, ...incoming.filter((o) => !shown.has(o.objectApiName))];
}

/** The staleness threshold typed, when it is one the extension accepts. */
export function parseStaleDays(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const days = Number(value.trim());
  return days >= 1 && days <= QUALITY_SCAN_MAX_STALE_DAYS ? days : null;
}

/**
 * The Quality tab: pick a few objects, and the org counts how filled their
 * fields are, which values of a key repeat, and how many records nobody has
 * modified for a while.
 *
 * Read-only. The scan sends describes and aggregate queries; no record is
 * read and nothing is written, so it needs no confirmation and no backup.
 * The object list is the one Seed offers — the org's objects a record can be
 * created in, which is where people type the data whose quality this measures.
 */
export const QualityPanel: React.FC<QualityPanelProps> = ({ orgId }) => {
  const { t } = useTranslation();
  const staleId = useId();

  const scan = useBridgeMutation<DataQualityScanResult>('dataops:quality-scan', {
    responseType: 'dataops:quality-scan:response',
    errorType: 'dataops:error',
    // A describe and four or five aggregate queries per object, one object
    // after the other: well past the 30 s default on a slow org.
    timeoutMs: 300_000,
  });

  const [selected, setSelected] = useState<string[]>([]);
  const [staleInput, setStaleInput] = useState(String(QUALITY_SCAN_DEFAULT_STALE_DAYS));
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [report, setReport] = useState<Report | null>(null);

  useEffect(() => {
    const answer = scan.data;
    if (!answer) return;
    setReport((previous) => ({
      objects: mergeObjectResults(previous?.objects ?? [], answer.objects),
      bounds: answer.bounds,
      staleDays: answer.staleDays,
    }));
  }, [scan.data]);

  const staleDays = parseStaleDays(staleInput);

  const target = (objectApiName: string): DataQualityScanTarget =>
    keys[objectApiName] ? { objectApiName, duplicateKey: keys[objectApiName] } : { objectApiName };

  const runScan = (): void => {
    if (selected.length === 0 || staleDays === null) return;
    // A new scan answers for the objects picked now, not for the ones before.
    setReport(null);
    scan.mutate({ orgId, objects: selected.map(target), staleDays });
  };

  const changeKey = (objectApiName: string, duplicateKey: string): void => {
    if (!report) return;
    setKeys((current) => ({ ...current, [objectApiName]: duplicateKey }));
    // The rest of the page was counted with this threshold; the rescan of one
    // object keeps to it, whatever has been typed since.
    scan.mutate({
      orgId,
      objects: [{ objectApiName, duplicateKey }],
      staleDays: report.staleDays,
    });
  };

  return (
    <div className="flex flex-col gap-3" data-testid="quality-panel">
      <h2 className="text-sm font-semibold text-text-primary">{t('dataops.quality')}</h2>
      <p className="text-xs text-text-secondary">{t('dataops.qualityScan.intro')}</p>

      <ObjectPicker
        orgId={orgId}
        selected={selected}
        onChange={setSelected}
        max={QUALITY_SCAN_MAX_OBJECTS}
        legend={t('dataops.qualityScan.objectsLegend', { max: QUALITY_SCAN_MAX_OBJECTS })}
        testIdPrefix="quality"
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
            data-testid="quality-stale-days"
          />
        </div>
        <Button
          variant="primary"
          size="sm"
          onClick={runScan}
          loading={scan.loading}
          disabled={selected.length === 0 || staleDays === null}
          data-testid="quality-scan-btn"
        >
          {t('dataops.qualityScan.scan')}
        </Button>
      </div>

      <p className="text-xs text-text-secondary">{t('dataops.qualityScan.method')}</p>

      {scan.error && <ErrorBanner message={scan.error} data-testid="quality-scan-error" />}

      {report && (
        <div className="flex flex-col gap-3" data-testid="quality-results">
          {report.objects.map((result) => (
            <QualityObjectResult
              key={result.objectApiName}
              result={result}
              bounds={report.bounds}
              staleDays={report.staleDays}
              requestedKey={keys[result.objectApiName]}
              onKeyChange={(key) => changeKey(result.objectApiName, key)}
              busy={scan.loading}
            />
          ))}
        </div>
      )}
    </div>
  );
};
