import React, { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Dices } from 'lucide-react';
import type { WholeOrgSampleResult, WholeOrgSampleWritten } from '@sandforge/shared';
import { uiLocale } from '../../utils/formatters';
import { drawWords, percentOf, sampleNumber as n } from './sampleWords';

/** How the records of one object came into the sample, as its line says it. */
function howWords(t: TFunction, object: WholeOrgSampleWritten): string {
  if (object.whole) return t('forgeRun.sampleResult.how.whole');
  const parts: string[] = [];
  if (object.roots > 0) parts.push(t('forgeRun.sampleResult.how.drawn', { rows: n(object.roots) }));
  if (object.below > 0) parts.push(t('forgeRun.sampleResult.how.below', { rows: n(object.below) }));
  if (object.asParents > 0) {
    parts.push(t('forgeRun.sampleResult.how.asParents', { rows: n(object.asParents) }));
  }
  return parts.join(', ');
}

/** The line of one object: what was written of what the sample kept, and what was not. */
function objectWords(t: TFunction, object: WholeOrgSampleWritten, source: string): string {
  const how = howWords(t, object);
  const said = [
    t(how ? 'forgeRun.sampleResult.object' : 'forgeRun.sampleResult.objectBare', {
      object: object.objectApiName,
      written: n(object.written),
      kept: n(object.kept),
      how,
      rows: n(object.sourceRows),
      source,
    }),
  ];
  if (object.goneSinceTheSample > 0) {
    said.push(
      t('forgeRun.sampleResult.gone', {
        count: object.goneSinceTheSample,
        formatted: n(object.goneSinceTheSample),
        source,
      }),
    );
  }
  if (object.changedSinceTheSample > 0) {
    said.push(
      t('forgeRun.sampleResult.changed', {
        count: object.changedSinceTheSample,
        formatted: n(object.changedSinceTheSample),
      }),
    );
  }
  return said.join(' ');
}

/** Props for {@link ForgeSampleResult}. */
export interface ForgeSampleResultProps {
  sample: WholeOrgSampleResult;
  /** The source org, as the user knows it. */
  source: string;
}

/**
 * What a run of a sample of the whole org wrote, on its results: how the
 * sample was drawn and the plan it wrote by its SHA-256; whether every
 * record of the plan was written or linked, which its `success` says, and
 * otherwise what is short and why — held back for a record they need that
 * changed since the plan, a failure, or not written for an error —, apart
 * from the records gone from the source since the plan, which are no
 * failure; then, per object, what was written of what the sample kept, how
 * those records came in, and of what the source held; and the lookups
 * written empty, their record outside the sample.
 */
export const ForgeSampleResult: React.FC<ForgeSampleResultProps> = ({ sample, source }) => {
  const { t } = useTranslation();
  const titleId = useId();
  const gone = sample.objects.reduce((sum, object) => sum + object.goneSinceTheSample, 0);
  const changed = sample.objects.reduce((sum, object) => sum + object.changedSinceTheSample, 0);
  const short = sample.objects.reduce(
    (sum, object) =>
      sum +
      Math.max(
        0,
        object.kept - object.written - object.goneSinceTheSample - object.changedSinceTheSample,
      ),
    0,
  );
  const drawnAt = new Date(sample.drawnAt);
  const verdict: string[] = [];
  if (changed > 0) {
    verdict.push(
      t('forgeRun.sampleResult.verdict.changed', { count: changed, formatted: n(changed) }),
    );
  }
  if (short > 0) {
    verdict.push(t('forgeRun.sampleResult.verdict.short', { count: short, formatted: n(short) }));
  }
  // A record gone from the source since the plan is no failure, and none of
  // the plan's was written short of it: every one still there was.
  if (verdict.length === 0) {
    verdict.push(
      gone > 0
        ? t('forgeRun.sampleResult.verdict.completeGone', { source })
        : t('forgeRun.sampleResult.verdict.complete'),
    );
  }
  if (gone > 0) {
    verdict.push(
      t('forgeRun.sampleResult.verdict.gone', { count: gone, formatted: n(gone), source }),
    );
  }
  const complete = changed === 0 && short === 0;

  return (
    <section
      data-testid="forge-sample-result"
      aria-labelledby={titleId}
      className="flex flex-col gap-2 rounded-md border border-subtle bg-surface-1 px-3 py-3 text-xs text-text-primary"
    >
      <h3 id={titleId} className="flex items-center gap-2 text-sm font-semibold">
        <Dices size={14} aria-hidden="true" className="text-hue-forge" />
        {t('forgeRun.sampleResult.title')}
      </h3>
      <p data-testid="forge-sample-result-drawn" className="text-text-secondary">
        {t('forgeRun.sampleResult.drawn', {
          seed: n(sample.seed),
          draw: drawWords(t, sample.draw),
          share: percentOf(sample.share),
          sha: sample.sha256.slice(0, 12),
          at: Number.isNaN(drawnAt.getTime())
            ? sample.drawnAt
            : drawnAt.toLocaleString(uiLocale(), { dateStyle: 'medium', timeStyle: 'short' }),
        })}
      </p>
      <p
        data-testid="forge-sample-result-verdict"
        className={
          complete
            ? 'text-text-primary'
            : 'rounded-md border border-status-warning/40 bg-status-warning/10 px-2 py-1'
        }
      >
        {verdict.join(' ')}
      </p>
      {/* Hundreds of objects scroll within the box, which the keyboard
          reaches to scroll it: no line of it is a control. */}
      <div
        role="region"
        aria-label={t('forgeRun.sampleResult.byObject')}
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- the list of objects scrolls, and none of its lines is a control to reach it by: the region takes the focus itself, so the keyboard can scroll it.
        tabIndex={0}
        className="max-h-72 overflow-y-auto rounded-md border border-subtle px-2 py-1 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-(--sf-accent)"
      >
        <ul data-testid="forge-sample-result-objects" className="flex flex-col gap-1">
          {sample.objects.map((object) => (
            <li key={object.objectApiName}>{objectWords(t, object, source)}</li>
          ))}
        </ul>
      </div>
      {sample.leftEmpty && sample.leftEmpty.length > 0 && (
        <p data-testid="forge-sample-result-left-empty">
          {t('forgeRun.wholeOrgDryRun.sample.leftEmpty', {
            fields: sample.leftEmpty
              .map(({ objectApiName, field, rows }) => `${objectApiName}.${field} (${n(rows)})`)
              .join(', '),
          })}
        </p>
      )}
    </section>
  );
};
