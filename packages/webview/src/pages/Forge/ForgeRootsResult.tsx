import React, { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { FileDown, ListChecks } from 'lucide-react';
import type { ForgeReadRecords, ForgeRunRoots } from '@sandforge/shared';
import { Button } from '../../components/ui/Button';
import { uiLocale } from '../../utils/formatters';

/** A count in the panel's language. */
const n = (value: number): string => value.toLocaleString(uiLocale());

/** A date the run kept, in the panel's language; as kept when it reads as none. */
function dateWords(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime())
    ? at
    : date.toLocaleString(uiLocale(), { dateStyle: 'medium', timeStyle: 'short' });
}

/** Where the roots came from: the query, its simulation, the run retried, or ids named one by one. */
function chosenWords(t: TFunction, roots: ForgeRunRoots): string {
  const values = {
    count: roots.asked,
    formatted: n(roots.asked),
    object: roots.objectApiName,
    cap: n(roots.cap),
    at: dateWords(roots.readAt),
  };
  switch (roots.from) {
    case 'query':
      return t('forgeRun.rootsResult.fromQuery', values);
    case 'plan':
      return t(
        roots.ofTheRunRetried
          ? 'forgeRun.rootsResult.fromRetried'
          : 'forgeRun.rootsResult.fromPlan',
        values,
      );
    case 'records':
      return t('forgeRun.rootsResult.fromRecords', values);
  }
}

/** How the records of one object came in, as its line says it. */
function objectWords(t: TFunction, object: ForgeReadRecords): string | undefined {
  const origin = object.origin;
  if (!origin) return undefined;
  const parts: string[] = [];
  if (origin.roots > 0)
    parts.push(t('forgeRun.rootsResult.origin.roots', { rows: n(origin.roots) }));
  if (origin.under > 0)
    parts.push(t('forgeRun.rootsResult.origin.under', { rows: n(origin.under) }));
  if (origin.named > 0)
    parts.push(t('forgeRun.rootsResult.origin.named', { rows: n(origin.named) }));
  const line = t('forgeRun.rootsResult.origin.object', {
    object: object.objectApiName,
    rows: n(object.read),
    how: parts.join(', '),
  });
  return object.readUnder && object.readUnder.length > 0
    ? `${line} ${t('forgeRun.rootsResult.origin.readUnder', { objects: object.readUnder.join(', ') })}`
    : line;
}

/** Props for {@link ForgeRootsResult}. */
export interface ForgeRootsResultProps {
  roots: ForgeRunRoots;
  /** The requests reading what the roots reach sent the source (`ForgeExecutionResult.reads`). */
  reads?: { source: number };
  /** What the run read of each object, with how it came in. */
  readByObject?: ForgeReadRecords[];
  /** A simulation: nothing was written, and the counts say what would be. */
  simulated: boolean;
  /** The source org, as the user knows it. */
  source: string;
  /**
   * Save the roots with their copies in the target as a CSV file
   * (`rootsCsv`): offered when given, of a run that names its roots.
   */
  onExport?: () => void;
}

/**
 * What a clone from the records a query chose did of them, on its results:
 * where they came from — the query, read now, or its simulation's, taken up —
 * and when; how many it wrote of those it read, linked to a record the
 * target held, and refused, each with its reason; those the source no longer
 * holds, which are no failure; then what reading what they reach sent the
 * source, and per object how its records came in: as roots, under a record
 * of the clone, or named by one — a parent read by id brings its other
 * children, which "read under" says. Given `onExport`, it offers the roots
 * with their copies in the target as a CSV file.
 */
export const ForgeRootsResult: React.FC<ForgeRootsResultProps> = ({
  roots,
  reads,
  readByObject,
  simulated,
  source,
  onExport,
}) => {
  const { t } = useTranslation();
  const titleId = useId();
  const complete = roots.failed.length === 0;
  const objects = (readByObject ?? [])
    .map((object) => ({ object, words: objectWords(t, object) }))
    .filter((entry): entry is { object: ForgeReadRecords; words: string } => !!entry.words);

  return (
    <section
      data-testid="forge-roots-result"
      aria-labelledby={titleId}
      className="flex flex-col gap-2 rounded-md border border-subtle bg-surface-1 px-3 py-3 text-xs text-text-primary"
    >
      <h3 id={titleId} className="flex items-center gap-2 text-sm font-semibold">
        <ListChecks size={14} aria-hidden="true" className="text-hue-forge" />
        {t('forgeRun.rootsResult.title')}
      </h3>
      <p data-testid="forge-roots-result-chosen" className="text-text-secondary">
        {chosenWords(t, roots)}
      </p>
      {roots.readAgain && (
        <p data-testid="forge-roots-result-read-again" className="text-text-secondary">
          {t('forgeRun.rootsResult.readAgain', {
            count: roots.readAgain.roots,
            formatted: n(roots.readAgain.roots),
            read: n(roots.read),
            at: dateWords(roots.readAgain.readAt),
          })}
        </p>
      )}
      <p
        data-testid="forge-roots-result-written"
        className={
          complete
            ? 'text-text-primary'
            : 'rounded-md border border-status-warning/40 bg-status-warning/10 px-2 py-1'
        }
      >
        {t(simulated ? 'forgeRun.rootsResult.wouldWrite' : 'forgeRun.rootsResult.written', {
          written: n(roots.written),
          read: n(roots.read),
        })}
        {roots.linked > 0 &&
          ` ${t('forgeRun.rootsResult.linked', { count: roots.linked, formatted: n(roots.linked) })}`}
        {(roots.withTheirAccount ?? 0) > 0 &&
          ` ${t('forgeRun.rootsResult.withTheirAccount', {
            count: roots.withTheirAccount,
            formatted: n(roots.withTheirAccount ?? 0),
          })}`}
      </p>
      {roots.gone.length > 0 && (
        <p data-testid="forge-roots-result-gone" className="text-text-secondary">
          {t('forgeRun.rootsResult.gone', {
            count: roots.gone.length,
            formatted: n(roots.gone.length),
            source,
          })}
        </p>
      )}
      {roots.failed.length > 0 && (
        <div data-testid="forge-roots-result-failed">
          <p>
            {t('forgeRun.rootsResult.failed', {
              count: roots.failed.length,
              formatted: n(roots.failed.length),
            })}
          </p>
          <ul className="mt-1 flex flex-col gap-0.5 font-mono">
            {roots.failed.slice(0, 20).map((failure) => (
              <li key={failure.id}>
                {failure.id}: {failure.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {reads && (
        <p data-testid="forge-roots-result-reads" className="text-text-secondary">
          {t('forgeRun.rootsResult.reads', {
            count: reads.source,
            formatted: n(reads.source),
            source,
          })}
        </p>
      )}
      {objects.length > 0 && (
        <ul data-testid="forge-roots-result-objects" className="flex flex-col gap-1">
          {objects.map(({ object, words }) => (
            <li key={object.objectApiName}>{words}</li>
          ))}
        </ul>
      )}
      {onExport && (
        <div>
          <Button
            variant="secondary"
            size="sm"
            icon={<FileDown size={14} />}
            onClick={onExport}
            data-testid="forge-roots-result-export"
          >
            {t('forgeRun.rootsResult.export')}
          </Button>
        </div>
      )}
    </section>
  );
};
