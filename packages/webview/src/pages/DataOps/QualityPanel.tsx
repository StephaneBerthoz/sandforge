import React, { useEffect, useId, useMemo, useState } from 'react';
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
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { Button } from '../../components/ui/Button';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { Input } from '../../components/ui/Input';
import { QualityObjectResult } from './QualityObjectResult';

/** Objects listed at once; the filter reaches the others. */
export const LISTED_OBJECTS = 50;

/** An object of the org, as `seed:describe-global` lists it. */
interface OrgObject {
  apiName: string;
  label: string;
}

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
export function mergeObjectResults(
  previous: readonly DataQualityObjectResult[],
  incoming: readonly DataQualityObjectResult[],
): DataQualityObjectResult[] {
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
  const filterId = useId();
  const staleId = useId();

  const objectsQuery = useBridgeQuery<{ objects: OrgObject[] }>(
    'seed:describe-global',
    { orgId },
    { responseType: 'seed:describe-global:response', errorType: 'seed:error' },
  );
  const scan = useBridgeMutation<DataQualityScanResult>('dataops:quality-scan', {
    responseType: 'dataops:quality-scan:response',
    errorType: 'dataops:error',
    // A describe and four or five aggregate queries per object, one object
    // after the other: well past the 30 s default on a slow org.
    timeoutMs: 300_000,
  });

  const [filter, setFilter] = useState('');
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

  const objects = useMemo(() => objectsQuery.data?.objects ?? [], [objectsQuery.data]);
  const matching = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return needle
      ? objects.filter(
          (o) => o.label.toLowerCase().includes(needle) || o.apiName.toLowerCase().includes(needle),
        )
      : objects;
  }, [objects, filter]);
  const listed = matching.slice(0, LISTED_OBJECTS);
  const full = selected.length >= QUALITY_SCAN_MAX_OBJECTS;
  const staleDays = parseStaleDays(staleInput);

  const toggle = (apiName: string): void => {
    setSelected((current) =>
      current.includes(apiName) ? current.filter((n) => n !== apiName) : [...current, apiName],
    );
  };

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

      <fieldset className="flex flex-col gap-2" data-testid="quality-objects">
        <legend className="mb-1 text-xs font-medium text-text-primary">
          {t('dataops.qualityScan.objectsLegend', { max: QUALITY_SCAN_MAX_OBJECTS })}
        </legend>
        {objectsQuery.error && (
          <ErrorBanner message={objectsQuery.error} data-testid="quality-objects-error" />
        )}
        {objectsQuery.loading && (
          <p role="status" className="text-xs text-text-secondary">
            {t('dataops.qualityScan.loadingObjects')}
          </p>
        )}
        {objects.length > 0 && (
          <>
            <div className="max-w-xs">
              <Input
                id={filterId}
                type="search"
                label={t('dataops.qualityScan.filterObjects')}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                data-testid="quality-object-filter"
              />
            </div>
            <ul
              className="flex max-h-64 flex-col gap-0.5 overflow-y-auto rounded border border-[var(--sf-border)] p-1"
              data-testid="quality-object-list"
            >
              {listed.map((o) => {
                const checked = selected.includes(o.apiName);
                return (
                  <li key={o.apiName}>
                    <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-[var(--sf-bg-hover)]">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!checked && full}
                        onChange={() => toggle(o.apiName)}
                        data-testid={`quality-object-option-${o.apiName}`}
                      />
                      <span className="flex-1 text-text-primary">{o.label}</span>
                      {/* Primary, not secondary: the row's hover fill takes
                          secondary text under AA on the dark default theme. */}
                      {o.label !== o.apiName && (
                        <span className="font-mono text-text-primary">{o.apiName}</span>
                      )}
                    </label>
                  </li>
                );
              })}
            </ul>
            {matching.length === 0 && (
              <p className="text-xs text-text-secondary">
                {t('dataops.qualityScan.noObjectMatch')}
              </p>
            )}
            {matching.length > listed.length && (
              <p className="text-xs text-text-secondary" data-testid="quality-more-objects">
                {t('dataops.qualityScan.moreObjects', {
                  shown: listed.length,
                  total: matching.length,
                })}
              </p>
            )}
          </>
        )}
        <p
          aria-live="polite"
          className="text-xs text-text-secondary"
          data-testid="quality-selected"
        >
          {t('dataops.qualityScan.selected', {
            part: selected.length,
            max: QUALITY_SCAN_MAX_OBJECTS,
          })}
          {selected.length > 0 && `: ${selected.join(', ')}`}
        </p>
      </fieldset>

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
