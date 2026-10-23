import React, { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { SyncRestoreObjectResult, SyncUndeleteObjectResult } from '@sandforge/shared';
import { formatNumber } from '../../utils/formatters';

/**
 * The keys of what {@link RestoredResult} says. The title takes `{{org}}`;
 * the line of an object takes `{{object}}`, `{{restored}}` and `{{planned}}`;
 * each count left takes `{{n}}` and `{{org}}`.
 */
export interface RestoredResultWords {
  title: string;
  restored: string;
  keptChanged: string;
  alreadyGone: string;
  refused: string;
  notKept: string;
  notReached: string;
  restoredWithout: string;
}

/**
 * The keys of what {@link UndeletedResult} says. The title takes `{{org}}`;
 * the line of an object takes `{{object}}`, `{{undeleted}}` and `{{planned}}`;
 * each count left takes `{{n}}` and `{{org}}`.
 */
export interface UndeletedResultWords {
  title: string;
  undeleted: string;
  alreadyBack: string;
  goneForGood: string;
  refused: string;
  notReached: string;
}

/** One object's line, said: what it did, what it left, and the org's reasons. */
interface ObjectLine {
  objectApiName: string;
  line: string;
  left: string[];
  reasons: string[];
}

/** A count, and the key that says it when it is not zero. */
type CountSaid = readonly [count: number, key: string];

/** What an object left, said: each count that is not zero, in its words, in the order given. */
function leftSaid(t: TFunction, org: string, counts: readonly CountSaid[]): string[] {
  return counts.flatMap(([count, key]) =>
    count > 0 ? [t(key, { n: formatNumber(count), org })] : [],
  );
}

/**
 * The part both results share: a heading naming the section, then one line
 * per object, what it left after a middle dot, and the org's reasons beneath.
 */
const ObjectResults: React.FC<{ title: string; lines: ObjectLine[]; testId: string }> = ({
  title,
  lines,
  testId,
}) => {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      data-testid={testId}
      className="flex flex-col gap-1 mt-1.5 text-[11px]"
    >
      <h4 id={headingId} className="text-[11px] font-semibold text-text-primary">
        {title}
      </h4>
      <ul className="flex flex-col gap-1">
        {lines.map((object) => (
          <li
            key={object.objectApiName}
            data-testid={`${testId}-${object.objectApiName}`}
            className="text-text-secondary"
          >
            {object.line}
            {object.left.length > 0 && ` · ${object.left.join(' · ')}`}
            {object.reasons.length > 0 && (
              <ul className="ml-3 mt-0.5 list-disc list-inside wrap-break-word">
                {object.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
};

/** Props for {@link RestoredResult}. */
export interface RestoredResultProps {
  restored: readonly SyncRestoreObjectResult[];
  /** The org written to, as the user knows it. */
  org: string;
  words: RestoredResultWords;
  /** Test id of the section, and the start of each object's. */
  testId: string;
}

/**
 * What a removal or a rewind gave back of what was written over, per object:
 * the records holding their earlier values again, and those it left, with
 * why — changed since, gone, refused, no longer kept, not reached, given back
 * but for fields the org no longer takes. The words are the caller's, so
 * that the removal of a Sync run and a rewind each say these counts their own
 * way.
 */
export const RestoredResult: React.FC<RestoredResultProps> = ({ restored, org, words, testId }) => {
  const { t } = useTranslation();
  const lines = restored.map((object): ObjectLine => ({
    objectApiName: object.objectApiName,
    line: t(words.restored, {
      object: object.objectApiName,
      restored: formatNumber(object.restored),
      planned: formatNumber(object.planned),
    }),
    left: leftSaid(t, org, [
      [object.keptChanged, words.keptChanged],
      [object.alreadyGone, words.alreadyGone],
      [object.refused, words.refused],
      [object.notKept, words.notKept],
      [object.notReached ?? 0, words.notReached],
      [object.restoredWithout ?? 0, words.restoredWithout],
    ]),
    reasons: object.reasons,
  }));
  return <ObjectResults title={t(words.title, { org })} lines={lines} testId={testId} />;
};

/** Props for {@link UndeletedResult}. */
export interface UndeletedResultProps {
  undeleted: readonly SyncUndeleteObjectResult[];
  /** The org written to, as the user knows it. */
  org: string;
  words: UndeletedResultWords;
  /** Test id of the section, and the start of each object's. */
  testId: string;
}

/**
 * What a removal or a rewind brought back from the recycle bin, per object:
 * the records back in the org, and those it left deleted, with why — back
 * already, gone for good, refused, not reached. The words are the caller's,
 * as for {@link RestoredResult}.
 */
export const UndeletedResult: React.FC<UndeletedResultProps> = ({
  undeleted,
  org,
  words,
  testId,
}) => {
  const { t } = useTranslation();
  const lines = undeleted.map((object): ObjectLine => ({
    objectApiName: object.objectApiName,
    line: t(words.undeleted, {
      object: object.objectApiName,
      undeleted: formatNumber(object.undeleted),
      planned: formatNumber(object.planned),
    }),
    left: leftSaid(t, org, [
      [object.alreadyBack, words.alreadyBack],
      [object.goneForGood, words.goneForGood],
      [object.refused, words.refused],
      [object.notReached ?? 0, words.notReached],
    ]),
    reasons: object.reasons,
  }));
  return <ObjectResults title={t(words.title, { org })} lines={lines} testId={testId} />;
};
