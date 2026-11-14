import React, { useId, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import {
  forgeRunGateStopOf,
  type ForgeWholeOrgAllowanceCheck,
  type ForgeWholeOrgDryRun as WholeOrgDryRun,
  type ForgeWholeOrgRefusal,
  type ForgeWholeOrgStorageCheck,
  type WholeOrgSampleBudget,
} from '@sandforge/shared';
import { formatEstimateSec, uiLocale } from '../../utils/formatters';
import { Button } from '../../components/ui/Button';
import { gateStopSentence } from './ForgeRunGateNotice';
import { leftOutReasonLabel } from './forgeLeftOut';
import { ForgeWholeOrgSample } from './ForgeWholeOrgSample';
import { mbOf } from './sampleWords';

/** Props for {@link ForgeWholeOrgDryRunResult}. */
export interface ForgeWholeOrgDryRunResultProps {
  dry: WholeOrgDryRun;
  /** The two orgs, as the user knows them. */
  source: string;
  target: string;
  /** The run was to take a checkpoint first, which its requests count. */
  checkpointAsked: boolean;
  /**
   * Of a dry run of every record past the data storage the target has left,
   * what a sample of the whole org may take of it: offered instead.
   */
  sampleOffer?: WholeOrgSampleBudget | null;
  /** Take the offer: back to Review, a sample that fits chosen. */
  onCopySample?: () => void;
}

/** A number in the interface language. */
function n(value: number): string {
  return value.toLocaleString(uiLocale());
}

/** What an allowance of the day comes to: what the run takes against what is left, or why that is not known. */
export function allowanceWords(t: TFunction, check: ForgeWholeOrgAllowanceCheck): string {
  if (check.verdict === 'unread') {
    return t('forgeRun.wholeOrgDryRun.allowanceUnread', {
      estimate: n(check.estimate),
      reason: check.unread,
    });
  }
  return t(`forgeRun.wholeOrgDryRun.allowance.${check.verdict}`, {
    estimate: n(check.estimate),
    remaining: n(check.remaining),
    max: n(check.max),
  });
}

/** What a storage comes to, in MB: what the run takes against what is left, or why that is not known. */
function storageWords(t: TFunction, check: ForgeWholeOrgStorageCheck): string {
  const estimate = n(Math.round(check.estimateMB * 10) / 10);
  if (check.verdict === 'unread') {
    return t('forgeRun.wholeOrgDryRun.storageUnread', { estimate, reason: check.unread });
  }
  return t(`forgeRun.wholeOrgDryRun.storage.${check.verdict}`, {
    estimate,
    remaining: n(check.remainingMB),
    max: n(check.maxMB),
  });
}

/**
 * A refusal the run would meet, in the interface language when it is one the
 * page has words for — a stop of the gate, read as the page reads a run's
 * stop — and in the host's words otherwise.
 */
function refusalWords(
  t: TFunction,
  refusal: ForgeWholeOrgRefusal,
  checkpointAsked: boolean,
): string {
  const stop = forgeRunGateStopOf({
    code: refusal.code,
    ...(refusal.storage ? { storage: refusal.storage } : {}),
    ...(refusal.api ? { api: refusal.api } : {}),
    ...(refusal.readBound ? { readBound: refusal.readBound } : {}),
    ...(refusal.sample ? { sample: refusal.sample } : {}),
    ...(refusal.refusal ? { reason: refusal.refusal.code } : {}),
  });
  return stop ? gateStopSentence(t, stop, { checkpointAsked, wholeOrg: true }) : refusal.message;
}

/**
 * What the dry run of a clone of the whole org said, on its results: it
 * stops at the run's write gate once the source is counted, reading no row
 * and writing nothing, and says what the run would write of each object, what
 * it would take of both orgs — their API requests, the target's Bulk API
 * batches, its data and file storage —, how long it would write, what it
 * leaves out, the personal fields it copies as they are, and every refusal
 * the run would meet, each said as the run's own stop would be.
 */
export const ForgeWholeOrgDryRunResult: React.FC<ForgeWholeOrgDryRunResultProps> = ({
  dry,
  source,
  target,
  checkpointAsked,
  sampleOffer,
  onCopySample,
}) => {
  const { t } = useTranslation();
  const tableId = useId();
  const refused = dry.wouldBeRefused.length > 0;
  const written = dry.wouldInsert.filter(({ rows }) => rows > 0);
  const personalFields = dry.personalAsIs.reduce((sum, { fields }) => sum + fields.length, 0);
  const leftOutObjects = dry.leftOut.objects.length;
  const leftOutReasons = useMemo(
    () =>
      dry.leftOut.counts
        .map(({ reason, count }) => `${leftOutReasonLabel(t, reason)} (${n(count)})`)
        .join(', '),
    [dry.leftOut.counts, t],
  );
  const heldBack = dry.leftOut.rows?.heldBack ?? [];
  const heldBackRows = heldBack.reduce((sum, { rows }) => sum + rows, 0);
  // What the run holds back one by one, for a record type the target has
  // none of or under a record held back, and what it leaves aside, its parent
  // not in the source: counted out as the run will not write them, and said.
  const rowsOf = (
    kind: 'recordTypeNotInTarget' | 'withoutParent' | 'noParentInSource' | 'outsideFilter',
    id: string,
    key: string,
    label: string,
  ) => {
    const entries = dry.leftOut.rows?.[kind] ?? [];
    const rows = entries.reduce((sum, entry) => sum + entry.rows, 0);
    return rows > 0
      ? [
          {
            id,
            label: t(label),
            value: t(key, {
              count: rows,
              formatted: n(rows),
              objects: entries.map(({ objectApiName }) => objectApiName).join(', '),
            }),
          },
        ]
      : [];
  };

  const facts: Array<{ id: string; label: string; value: string }> = [
    {
      id: 'target-requests',
      label: t('forgeRun.wholeOrgDryRun.targetRequests', { org: target }),
      value: allowanceWords(t, dry.targetRequests),
    },
    {
      id: 'source-requests',
      label: t('forgeRun.wholeOrgDryRun.sourceRequests', { org: source }),
      value: allowanceWords(t, dry.sourceRequests),
    },
    ...(dry.bulkBatches
      ? [
          {
            id: 'bulk-batches',
            label: t('forgeRun.wholeOrgDryRun.bulkBatches', { org: target }),
            value: allowanceWords(t, dry.bulkBatches),
          },
        ]
      : []),
    {
      id: 'storage',
      label: t('forgeRun.wholeOrgDryRun.dataStorage', { org: target }),
      value: storageWords(t, dry.storage),
    },
    {
      id: 'files',
      label: t('forgeRun.wholeOrgDryRun.files'),
      value: !dry.files
        ? t('forgeRun.wholeOrgDryRun.filesNone')
        : 'unmeasured' in dry.files
          ? t('forgeRun.wholeOrgDryRun.filesUnmeasured')
          : `${t('forgeRun.wholeOrgDryRun.filesCount', {
              count: dry.files.count,
              formatted: n(dry.files.count),
            })} ${storageWords(t, dry.files.check)}`,
    },
    {
      id: 'left-out',
      label: t('forgeRun.wholeOrgDryRun.leftOut'),
      value:
        leftOutObjects === 0
          ? t('forgeRun.wholeOrgDryRun.leftOutNone')
          : `${t('forgeRun.wholeOrgDryRun.leftOutObjects', {
              count: leftOutObjects,
              formatted: n(leftOutObjects),
            })} ${leftOutReasons}`,
    },
    ...(heldBackRows > 0
      ? [
          {
            id: 'held-back',
            label: t('forgeRun.wholeOrgDryRun.heldBack'),
            value: t('forgeRun.wholeOrgDryRun.heldBackRows', {
              count: heldBackRows,
              formatted: n(heldBackRows),
              objects: heldBack.map(({ objectApiName }) => objectApiName).join(', '),
            }),
          },
        ]
      : []),
    ...rowsOf(
      'recordTypeNotInTarget',
      'type-not-in-target',
      'forgeRun.wholeOrgDryRun.typeNotInTargetRows',
      'forgeRun.wholeOrgDryRun.typeNotInTarget',
    ),
    ...rowsOf(
      'withoutParent',
      'held-under',
      'forgeRun.wholeOrgDryRun.heldUnderRows',
      'forgeRun.wholeOrgDryRun.heldUnder',
    ),
    ...rowsOf(
      'noParentInSource',
      'left-aside',
      'forgeRun.wholeOrgDryRun.leftAsideRows',
      'forgeRun.wholeOrgDryRun.leftAside',
    ),
    // Of a sample, what a lookup it needs names outside its object's filter:
    // dropped by the plan, never sent.
    ...rowsOf(
      'outsideFilter',
      'outside-filter',
      'forgeRun.wholeOrgDryRun.outsideFilterRows',
      'forgeRun.wholeOrgDryRun.outsideFilter',
    ),
    {
      id: 'personal',
      label: t('forgeRun.wholeOrgDryRun.personalAsIs'),
      value:
        personalFields === 0
          ? t('forgeRun.wholeOrgDryRun.personalNone')
          : t('forgeRun.wholeOrgDryRun.personalFields', {
              count: personalFields,
              formatted: n(personalFields),
              objects: dry.personalAsIs.map(({ objectApiName }) => objectApiName).join(', '),
            }),
    },
  ];

  return (
    <section
      data-testid="forge-whole-org-dry-run"
      aria-labelledby={`${tableId}-title`}
      className="flex flex-col gap-3 rounded-md border border-subtle bg-surface-1 px-3 py-3 text-xs text-text-primary"
    >
      <h3 id={`${tableId}-title`} className="text-sm font-semibold">
        {t(dry.sample ? 'forgeRun.wholeOrgDryRun.titleSample' : 'forgeRun.wholeOrgDryRun.title')}
      </h3>
      {/* A sample's draw reads every root's id and what they reach: not the
          few ids a run of every record reads past its counts. */}
      <p className="text-text-secondary">
        {t(
          dry.sample ? 'forgeRun.wholeOrgDryRun.stoppedSample' : 'forgeRun.wholeOrgDryRun.stopped',
        )}
      </p>
      {/* What the sample drew, said first: the counts below are its plan's. */}
      {dry.sample && <ForgeWholeOrgSample sample={dry.sample} source={source} target={target} />}
      {/* Every record past what the target has left: a sample that fits, offered. */}
      {!dry.sample && sampleOffer && (
        <div
          data-testid="forge-whole-org-dry-run-sample-offer"
          className="flex flex-wrap items-center gap-2 rounded-md border border-status-warning/40 bg-status-warning/10 px-3 py-2"
        >
          <p className="flex-1">
            {t('forgeRun.wholeOrgDryRun.sampleOffer', { target, mb: mbOf(sampleOffer.bytes) })}
          </p>
          {onCopySample && (
            <Button
              variant="secondary"
              size="sm"
              data-testid="forge-whole-org-dry-run-copy-sample"
              onClick={onCopySample}
            >
              {t('forgeRun.review.sample.offerAction')}
            </Button>
          )}
        </div>
      )}
      <p data-testid="forge-whole-org-dry-run-records">
        {t('forgeRun.wholeOrgDryRun.records', {
          count: dry.totalRows,
          formatted: n(dry.totalRows),
          objects: n(written.length),
          duration: formatEstimateSec(dry.durationSeconds),
          target,
        })}
      </p>
      <div
        data-testid="forge-whole-org-dry-run-verdict"
        className={`flex items-start gap-2 rounded-md border px-3 py-2 ${
          refused ? 'border-status-warning/40 bg-status-warning/10' : 'border-subtle bg-surface-2'
        }`}
      >
        {refused ? (
          <ShieldAlert
            size={14}
            aria-hidden="true"
            className="mt-0.5 shrink-0 text-status-warning"
          />
        ) : (
          <ShieldCheck size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-hue-forge" />
        )}
        <div className="flex flex-col gap-1">
          <p className="font-medium">
            {refused
              ? t('forgeRun.wholeOrgDryRun.refused', { count: dry.wouldBeRefused.length })
              : t('forgeRun.wholeOrgDryRun.goesThrough')}
          </p>
          {refused && (
            <ul className="list-disc pl-4" data-testid="forge-whole-org-dry-run-refusals">
              {dry.wouldBeRefused.map((refusal, index) => (
                <li key={`${refusal.code}-${String(index)}`} data-code={refusal.code}>
                  {refusalWords(t, refusal, checkpointAsked)}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-[minmax(10rem,auto)_1fr]">
        {facts.map((fact) => (
          <React.Fragment key={fact.id}>
            <dt className="text-text-secondary">{fact.label}</dt>
            <dd data-testid={`forge-whole-org-dry-run-${fact.id}`}>{fact.value}</dd>
          </React.Fragment>
        ))}
      </dl>
      {written.length > 0 && (
        // Hundreds of objects scroll within the box, which the keyboard
        // reaches to scroll it: no line of it is a control.
        <div
          role="region"
          aria-labelledby={`${tableId}-caption`}
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- the list of objects scrolls, and none of its rows is a control to reach it by: the region takes the focus itself, so the keyboard can scroll it.
          tabIndex={0}
          data-testid="forge-whole-org-dry-run-objects"
          className="max-h-72 overflow-y-auto rounded-md border border-subtle focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-(--sf-accent)"
        >
          <table className="w-full text-left">
            <caption id={`${tableId}-caption`} className="px-2 py-1.5 text-left font-semibold">
              {t('forgeRun.wholeOrgDryRun.byObject')}
            </caption>
            <thead className="sticky top-0 bg-surface-2">
              <tr>
                <th scope="col" className="px-2 py-1 font-medium">
                  {t('forgeRun.wholeOrgDryRun.object')}
                </th>
                <th scope="col" className="px-2 py-1 text-right font-medium">
                  {t('forgeRun.wholeOrgDryRun.recordsColumn')}
                </th>
                <th scope="col" className="px-2 py-1 text-right font-medium">
                  {t('forgeRun.wholeOrgDryRun.jobsColumn')}
                </th>
                <th scope="col" className="px-2 py-1 text-right font-medium">
                  {t('forgeRun.wholeOrgDryRun.restColumn')}
                </th>
              </tr>
            </thead>
            <tbody>
              {written.map((object) => (
                <tr key={object.objectApiName} className="border-t border-subtle">
                  <td className="px-2 py-1 font-mono">{object.objectApiName}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{n(object.rows)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{n(object.jobs)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{n(object.byRest)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
};
