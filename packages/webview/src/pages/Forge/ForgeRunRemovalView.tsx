import React, { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type {
  ForgeUndoMark,
  ForgeUndoObjectResult,
  ForgeUndoResult,
  ForgeUndoStatus,
} from '@sandforge/shared';
import { cn } from '../../theme';
import { formatNumber } from '../../utils/formatters';

/**
 * What a removal takes back — a Forge run, or a Frozen load — which is all
 * its result's words change with: the removal is the same.
 */
export type RemovalSubject = 'run' | 'load';

/** What a removal's result says first, by what it took back and how it ended. */
const RESULT_TITLE_KEYS: Record<RemovalSubject, Record<ForgeUndoStatus, string>> = {
  run: {
    success: 'forge.history.resultSuccess',
    partial: 'forge.history.resultPartial',
    failure: 'forge.history.resultFailure',
    cancelled: 'forge.history.resultCancelled',
  },
  load: {
    success: 'frozen.removal.resultSuccess',
    partial: 'frozen.removal.resultPartial',
    failure: 'frozen.removal.resultFailure',
    // Says nothing of what was taken back.
    cancelled: 'forge.history.resultCancelled',
  },
};

/** What a record kept for a change since is said to have changed since. */
const CHANGED_KEYS: Record<RemovalSubject, string> = {
  run: 'forge.history.resultChanged',
  load: 'frozen.removal.resultChanged',
};

/** The colour of that first line. */
const RESULT_TITLE_CLASSES: Record<ForgeUndoStatus, string> = {
  success: 'text-status-success',
  partial: 'text-status-warning',
  failure: 'text-status-error',
  cancelled: 'text-status-warning',
};

/** A count in a sentence: the plural the count picks, the number as the reader writes it. */
function counted(
  t: TFunction,
  key: string,
  count: number,
  extra: Record<string, string> = {},
): string {
  return t(key, { count, formatted: formatNumber(count), ...extra });
}

/** What became of one object's records, the counts that are not zero, in reading order. */
function outcomeParts(
  t: TFunction,
  object: ForgeUndoObjectResult,
  subject: RemovalSubject,
): string[] {
  const parts: string[] = [];
  if (object.deleted > 0) parts.push(counted(t, 'forge.history.resultDeleted', object.deleted));
  if (object.alreadyGone > 0) {
    parts.push(counted(t, 'forge.history.resultGone', object.alreadyGone));
  }
  if (object.keptChanged > 0) {
    parts.push(counted(t, CHANGED_KEYS[subject], object.keptChanged));
  }
  if (object.keptDependents > 0) {
    parts.push(
      object.heldBy.length > 0
        ? counted(t, 'forge.history.resultHeld', object.keptDependents, {
            objects: object.heldBy.join(', '),
          })
        : counted(t, 'forge.history.resultHeldUnread', object.keptDependents),
    );
  }
  if (object.refused > 0) parts.push(counted(t, 'forge.history.resultRefused', object.refused));
  return parts;
}

/** Props for {@link ForgeRunRemovalPlan}. */
export interface ForgeRunRemovalPlanProps {
  /** How many records of each object the removal takes, in the order it takes them. */
  plan: ReadonlyArray<{ objectApiName: string; count: number }>;
  /** Records the run or load linked to, which the removal leaves where they are. */
  linked: number;
}

/**
 * What a removal would take, object by object in the order it takes them,
 * and the linked records it leaves: the counts a confirmation names.
 */
export const ForgeRunRemovalPlan: React.FC<ForgeRunRemovalPlanProps> = ({ plan, linked }) => {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1.5" data-testid="forge-removal-plan">
      <ul className="flex flex-col gap-0.5">
        {plan.map((object) => (
          <li
            key={object.objectApiName}
            data-testid={`forge-removal-plan-${object.objectApiName}`}
            className="font-mono"
          >
            {counted(t, 'forge.history.removeObject', object.count, {
              object: object.objectApiName,
            })}
          </li>
        ))}
      </ul>
      {linked > 0 && (
        <p data-testid="forge-removal-linked">{counted(t, 'forge.history.removeLinked', linked)}</p>
      )}
    </div>
  );
};

/** Props for {@link ForgeRunRemovalResult}. */
export interface ForgeRunRemovalResultProps {
  /** What the removal did. */
  result: Pick<ForgeUndoResult, 'status' | 'objects'>;
  /** The org it removed from, as the user knows it. */
  org: string;
  /** What it took back: a Forge run unless said. */
  subject?: RemovalSubject;
}

/**
 * What a removal did, object by object — deleted, already gone, kept because
 * changed since the run or because records that stay depend on them, refused
 * — with what the org said about the refusals.
 */
export const ForgeRunRemovalResult: React.FC<ForgeRunRemovalResultProps> = ({
  result,
  org,
  subject = 'run',
}) => {
  const { t } = useTranslation();
  const headingId = useId();
  // Said once for the removal: the same objects go unchecked under every
  // object that has them.
  const unchecked = [...new Set(result.objects.flatMap((object) => object.unchecked))];
  return (
    <section
      aria-labelledby={headingId}
      data-testid="forge-removal-result"
      className="flex flex-col gap-1 mt-1.5 text-[11px]"
    >
      <h4
        id={headingId}
        className={cn('text-[11px] font-semibold', RESULT_TITLE_CLASSES[result.status])}
      >
        {t(RESULT_TITLE_KEYS[subject][result.status], { org })}
      </h4>
      <ul className="flex flex-col gap-1">
        {result.objects.map((object) => (
          <li
            key={object.objectApiName}
            data-testid={`forge-removal-result-${object.objectApiName}`}
            className="text-text-secondary"
          >
            <span className="font-mono text-text-primary">{object.objectApiName}</span>
            {': '}
            {outcomeParts(t, object, subject).join(' · ')}
            {object.reasons.length > 0 && (
              <ul className="ml-3 mt-0.5 list-disc list-inside break-words">
                {object.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
      {unchecked.length > 0 && (
        <p data-testid="forge-removal-unchecked" className="text-text-secondary">
          {t('forge.history.resultUnchecked', { objects: unchecked.join(', ') })}
        </p>
      )}
    </section>
  );
};

/** Props for {@link ForgeRunRemovalMark}. */
export interface ForgeRunRemovalMarkProps {
  /** What the history entry remembers of the removal. */
  mark: ForgeUndoMark;
  /** When the removal ended, written as the panel writes its dates. */
  date: string;
}

/** The line a run whose records were removed carries in place of the action. */
export const ForgeRunRemovalMark: React.FC<ForgeRunRemovalMarkProps> = ({ mark, date }) => {
  const { t } = useTranslation();
  const parts = [
    mark.deleted > 0 ? counted(t, 'forge.history.resultDeleted', mark.deleted) : undefined,
    mark.alreadyGone > 0 ? counted(t, 'forge.history.resultGone', mark.alreadyGone) : undefined,
    mark.kept > 0 ? counted(t, 'forge.history.resultKept', mark.kept) : undefined,
    mark.refused > 0 ? counted(t, 'forge.history.resultRefused', mark.refused) : undefined,
  ].filter((part): part is string => part !== undefined);
  return (
    <p data-testid="forge-removal-mark" className="text-[10px] text-text-secondary">
      {t('forge.history.removedOn', { date })} {parts.join(' · ')}
    </p>
  );
};
