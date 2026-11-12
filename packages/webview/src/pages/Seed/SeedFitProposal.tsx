import React, { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  BaseMessage,
  SeedFitApplied,
  SeedFitProposal,
  StorageRoomNotCounted,
} from '@sandforge/shared';
import { Button } from '../../components/ui/Button';
import { useMessageListener } from '../../hooks/useMessageBus';
import { formatNumber, roundedUpMegabytes, shareRoundedDown } from '../../utils/formatters';

/**
 * The refusals of a seed a smaller seed answers — its records past the data
 * storage its org has left, or their writes past the day's API requests —
 * which carry the counts that fit. A refusal for the emails or a checkpoint
 * is not one fewer records answers, and carries none.
 */
const FIT_REFUSALS: readonly string[] = ['SEED_STORAGE_EXCEEDED', 'API_BUDGET_EXCEEDED'];

const LIMITED_BY: readonly string[] = ['storage', 'within', 'apiRequests'];
const NOT_COUNTED: readonly string[] = ['trigger', 'notRead', 'share'];
const KEPT_WHOLE: readonly string[] = ['rows', 'byKey'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const isOptional = (value: unknown, is: (v: unknown) => boolean): boolean =>
  value === undefined || is(value);
const isString = (value: unknown): value is string => typeof value === 'string';

/**
 * Whether what a refusal carries as its `fit` is the proposal the extension
 * computes (`SeedFitProposal`), every part the card reads of it there and of
 * its kind: what an extension of another version sends is left unshown
 * rather than shown in part.
 */
export function isSeedFitProposal(value: unknown): value is SeedFitProposal {
  if (!isRecord(value) || !isRecord(value.budget) || !Array.isArray(value.objects)) return false;
  const { budget } = value;
  return (
    isNumber(value.share) &&
    value.share > 0 &&
    value.share <= 1 &&
    isNumber(value.estimateMB) &&
    isOptional(value.cannotFit, isString) &&
    isOptional(value.automationUnread, isString) &&
    ['budgetMB', 'remainingMB', 'maxMB', 'share', 'roundingMB', 'automationMB'].every((key) =>
      isNumber(budget[key]),
    ) &&
    isOptional(budget.withinMB, isNumber) &&
    isString(budget.limitedBy) &&
    LIMITED_BY.includes(budget.limitedBy) &&
    isOptional(
      budget.notCounted,
      (list) =>
        Array.isArray(list) &&
        list.every(
          (entry) =>
            isRecord(entry) &&
            isString(entry.objectApiName) &&
            isString(entry.name) &&
            isString(entry.kind) &&
            NOT_COUNTED.includes(entry.kind),
        ),
    ) &&
    value.objects.length > 0 &&
    value.objects.every(
      (object) =>
        isRecord(object) &&
        isString(object.objectApiName) &&
        Number.isInteger(object.before) &&
        Number.isInteger(object.after) &&
        isOptional(object.keptWhole, (kept) => isString(kept) && KEPT_WHOLE.includes(kept)),
    )
  );
}

/**
 * The counts a seed refused for what its target has left would fit, as the
 * refusal of the request `requestId` carried them; null before it answers,
 * for any other refusal, and once another request goes. Nothing is computed
 * here: the extension fitted the counts from what its gate read.
 *
 * @param requestId - The `seed:execute` request the page sent last; null before one.
 */
export function useSeedFitRefusal(requestId: string | null): SeedFitProposal | null {
  const [offered, setOffered] = useState<{ requestId: string; proposal: SeedFitProposal } | null>(
    null,
  );
  useMessageListener<BaseMessage & { payload?: { code?: unknown; fit?: unknown } }>(
    'seed:error',
    (message) => {
      if (requestId === null || message.correlationId !== requestId) return;
      const { code, fit } = message.payload ?? {};
      if (!isString(code) || !FIT_REFUSALS.includes(code) || !isSeedFitProposal(fit)) return;
      setOffered({ requestId, proposal: fit });
    },
  );
  return offered !== null && offered.requestId === requestId ? offered.proposal : null;
}

/** A seed run at the counts of a fit: those counts, what its request says of the fit, its records. */
export interface FittedSeedRun {
  /** Each object's count, as the fit proposed it. */
  counts: Readonly<Record<string, number>>;
  /** What the request says of the fit, for the audit trail. */
  fit: SeedFitApplied;
  /** The records it sets out to write. */
  records: number;
}

/**
 * The run a person starts from a proposal: its counts — never more than the
 * template asked for — and what the request says of the fit: the share, the
 * bound asked, and the records the template held before it.
 */
export function fittedRunOf(proposal: SeedFitProposal): FittedSeedRun {
  const counts: Record<string, number> = {};
  let before = 0;
  let records = 0;
  for (const object of proposal.objects) {
    const count = Math.min(object.after, object.before);
    counts[object.objectApiName] = count;
    before += object.before;
    records += count;
  }
  const { withinMB } = proposal.budget;
  return {
    counts,
    records,
    fit: { share: proposal.share, before, ...(withinMB !== undefined ? { withinMB } : {}) },
  };
}

/** What a part of the target's automation the room leaves out is, as the card names it. */
const NOT_COUNTED_KEYS: Readonly<Record<StorageRoomNotCounted['kind'], string>> = {
  trigger: 'seed.fit.notCountedTrigger',
  notRead: 'seed.fit.notCountedNotRead',
  share: 'seed.fit.notCountedShare',
};

/** Props for {@link SeedFitProposalCard}. */
export interface SeedFitProposalCardProps {
  /** The counts that fit, as the refusal carried them. */
  proposal: SeedFitProposal;
  /** The org the seed was refused on, as the panel names it. */
  org: string;
  /** Seed the refused seed again at the counts proposed; not offered when nothing fits. */
  onSeed: () => void;
  /** Back to the counts, to set them by hand; absent where the page has its own way back. */
  onChangeCounts?: () => void;
  testId?: string;
}

/**
 * The counts a seed refused for the storage or the API requests its org has
 * left would fit, under the refusal: the share kept of every count, the bound
 * that held it and its terms, the room kept for what the org's flows that
 * still run create under the records — or that it could not be read —, what
 * that room leaves out, each object's count asked and the one that fits, and
 * what they take. "Seed these counts" sends the seed again at those counts,
 * and its gate is met again; nothing is seeded until then. Every figure is
 * the extension's: the card computes none.
 *
 * Two of the five templates of the gallery do not fit a Developer Edition,
 * and a new user who picked one was refused with "lower the record counts",
 * left to work out by hand which counts, children by their parents.
 */
export const SeedFitProposalCard: React.FC<SeedFitProposalCardProps> = ({
  proposal,
  org,
  onSeed,
  onChangeCounts,
  testId = 'seed-fit',
}) => {
  const { t } = useTranslation();
  const headingId = useId();
  const { budget } = proposal;
  const fits = roundedUpMegabytes(budget.budgetMB + budget.automationMB);
  const fitted = fittedRunOf(proposal);

  let bound: string;
  if (budget.limitedBy === 'apiRequests') {
    bound = t('seed.fit.boundRequests', { org });
  } else if (budget.limitedBy === 'within') {
    bound = t('seed.fit.boundWithin', { fits });
  } else {
    bound = t('seed.fit.boundStorage', {
      fits,
      near: shareRoundedDown(budget.share),
      remaining: formatNumber(budget.remainingMB),
      max: formatNumber(budget.maxMB),
      rounding: formatNumber(budget.roundingMB),
      org,
    });
  }

  let room: string;
  if (proposal.automationUnread !== undefined) {
    room = t('seed.fit.roomUnread', { org, reason: proposal.automationUnread });
  } else if (budget.automationMB > 0) {
    room = t('seed.fit.roomKept', { room: roundedUpMegabytes(budget.automationMB), org });
  } else {
    room = t('seed.fit.roomNone', { org });
  }

  const estimate = roundedUpMegabytes(proposal.estimateMB);
  const cannotFit = proposal.cannotFit !== undefined;

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-2 rounded-md border border-subtle bg-surface-1 px-3 py-2 text-xs text-text-primary"
      data-testid={testId}
    >
      <h3 id={headingId} className="text-xs font-semibold">
        {t('seed.fit.title', { org })}
      </h3>

      {cannotFit ? (
        <p data-testid={`${testId}-cannot`}>
          {budget.limitedBy === 'apiRequests'
            ? t('seed.fit.cannotFitRequests', { org })
            : t('seed.fit.cannotFitStorage', { estimate, fits, org })}
        </p>
      ) : (
        <>
          <p data-testid={`${testId}-share`}>
            {t('seed.fit.share', { share: shareRoundedDown(proposal.share) })}
          </p>
          <p data-testid={`${testId}-bound`}>{bound}</p>
          <p data-testid={`${testId}-room`}>{room}</p>
          {(budget.notCounted ?? []).length > 0 && (
            <ul className="flex flex-col gap-0.5" data-testid={`${testId}-not-counted`}>
              {(budget.notCounted ?? []).map((entry) => (
                <li key={`${entry.objectApiName}-${entry.kind}-${entry.name}`}>
                  {t(NOT_COUNTED_KEYS[entry.kind], {
                    name:
                      entry.kind === 'notRead'
                        ? t('common.quoted', { name: entry.name })
                        : entry.name,
                    object: entry.objectApiName,
                  })}
                </li>
              ))}
            </ul>
          )}

          <div className="max-h-64 overflow-auto">
            <table className="w-full border-collapse text-xs" data-testid={`${testId}-objects`}>
              <caption className="sr-only">{t('seed.fit.caption')}</caption>
              <thead>
                <tr>
                  <th scope="col" className="px-1 pb-1 text-left font-medium text-text-secondary">
                    {t('common.object')}
                  </th>
                  <th scope="col" className="px-1 pb-1 text-right font-medium text-text-secondary">
                    {t('seed.fit.before')}
                  </th>
                  <th scope="col" className="px-1 pb-1 text-right font-medium text-text-secondary">
                    {t('seed.fit.after')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {proposal.objects.map((object) => (
                  <tr
                    key={object.objectApiName}
                    className="border-t border-(--sf-border)"
                    data-testid={`${testId}-object-${object.objectApiName}`}
                  >
                    <th scope="row" className="px-1 py-1 text-left font-normal">
                      {object.objectApiName}
                      {object.keptWhole && (
                        <span className="block text-text-secondary">
                          {t(
                            object.keptWhole === 'rows'
                              ? 'seed.fit.keptRows'
                              : 'seed.fit.keptByKey',
                          )}
                        </span>
                      )}
                    </th>
                    <td className="px-1 py-1 text-right tabular-nums">
                      {formatNumber(object.before)}
                    </td>
                    <td className="px-1 py-1 text-right font-semibold tabular-nums">
                      {formatNumber(fitted.counts[object.objectApiName] ?? object.after)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p data-testid={`${testId}-total`}>
            {t(budget.automationMB > 0 ? 'seed.fit.totalWithRoom' : 'seed.fit.total', {
              after: formatNumber(fitted.records),
              before: formatNumber(fitted.fit.before),
              estimate,
            })}
          </p>
        </>
      )}

      <p className="text-text-secondary" data-testid={`${testId}-counted`}>
        {t('seed.fit.counted', { org })}
      </p>

      {(!cannotFit || onChangeCounts) && (
        <div className="flex flex-wrap gap-2">
          {!cannotFit && (
            <Button variant="primary" size="sm" onClick={onSeed} data-testid={`${testId}-seed`}>
              {t('seed.fit.seed')}
            </Button>
          )}
          {onChangeCounts && (
            <Button
              variant="secondary"
              size="sm"
              onClick={onChangeCounts}
              data-testid={`${testId}-change`}
            >
              {t('seed.fit.change')}
            </Button>
          )}
        </div>
      )}
    </section>
  );
};

/** Props for {@link SeedFitResultLine}. */
export interface SeedFitResultLineProps {
  /** The fit the run's counts came from. */
  fitted: FittedSeedRun;
  /** The org the run wrote to, as the panel names it. */
  org: string;
  testId: string;
}

/**
 * What a run's results say of the fit its counts came from: the records it
 * set out to write of those the template asked for, and the share of every
 * count. Said beside the results, which count what it wrote.
 */
export const SeedFitResultLine: React.FC<SeedFitResultLineProps> = ({ fitted, org, testId }) => {
  const { t } = useTranslation();
  return (
    <p className="text-xs text-text-primary" data-testid={testId}>
      {t('seed.fit.fitted', {
        org,
        after: formatNumber(fitted.records),
        before: formatNumber(fitted.fit.before),
        share: shareRoundedDown(fitted.fit.share),
      })}
    </p>
  );
};
