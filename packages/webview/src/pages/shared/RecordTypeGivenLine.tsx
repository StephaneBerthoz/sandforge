import React, { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type {
  MutedAutomation,
  MutedAutomationStillRunning,
  RecordTypeGiven,
  RecordTypeGivenBasis,
  RecordTypeNamed,
  WithoutRecordTypeWhy,
} from '@sandforge/shared';
import { listWords } from '../../utils/listWords';

/**
 * When a line speaks: `predicted`, before the run — a simulation, a preview —,
 * of what the describe of the user the run writes as says the target gives;
 * `written`, after it, of what the records created were read back holding.
 */
export type RecordTypeGivenStage = 'predicted' | 'written';

/** The reasons a record went without a record type, in the order a line says them. */
const WHY_ORDER: readonly WithoutRecordTypeWhy[] = [
  'masterInSource',
  'notRead',
  'decidedDefault',
  'dropped',
];

/** Why the records went without one, said of them all. */
const WHY_KEYS: Readonly<Record<WithoutRecordTypeWhy, string>> = {
  masterInSource: 'runResults.recordTypeGiven.why.masterInSource',
  notRead: 'runResults.recordTypeGiven.why.notRead',
  decidedDefault: 'runResults.recordTypeGiven.why.decidedDefault',
  dropped: 'runResults.recordTypeGiven.why.dropped',
};

/** Why some of them went without one, said with how many, where they went for more than one reason. */
const WHY_COUNTED_KEYS: Readonly<Record<WithoutRecordTypeWhy, string>> = {
  masterInSource: 'runResults.recordTypeGiven.whyCounted.masterInSource',
  notRead: 'runResults.recordTypeGiven.whyCounted.notRead',
  decidedDefault: 'runResults.recordTypeGiven.whyCounted.decidedDefault',
  dropped: 'runResults.recordTypeGiven.whyCounted.dropped',
};

/** Why the describe says the target gives that type. */
const GIVEN_KEYS: Readonly<Record<RecordTypeGivenBasis, string>> = {
  userDefault: 'runResults.recordTypeGiven.given.userDefault',
  onlyOneOpen: 'runResults.recordTypeGiven.given.onlyOneOpen',
};

/** What still ran of the target's automation, by its kind, in the words the mute's own lists say it. */
const KIND_KEYS: Readonly<Record<MutedAutomationStillRunning['kind'], string>> = {
  flow: 'automationMute.kind.flow',
  trigger: 'automationMute.kind.trigger',
  process: 'automationMute.kind.process',
  workflowRule: 'automationMute.kind.workflowRule',
};

/** The name the platform gives the type a record created without one stays on, when none other is given. */
const MASTER = 'Master';

/** A record type as a line names it: its DeveloperName, and its label when it says something else. */
function typeName({ developerName, label }: RecordTypeNamed): string {
  return label !== '' && label !== developerName ? `${developerName} (${label})` : developerName;
}

/**
 * What still ran of a run's mute, to name in a line where the records went in
 * with another type than was predicted: only of a run that muted, where
 * what was silenced set no type, and what still ran is all that could. Absent
 * otherwise, and the line says the target's automation without a name.
 */
export function stillRanOf(
  muted: MutedAutomation | undefined,
): readonly MutedAutomationStillRunning[] | undefined {
  return muted?.state === 'muted' ? muted.stillRan : undefined;
}

/** Whether an entry has anything to say: records created without a record type. */
function says(entry: RecordTypeGiven | undefined): entry is RecordTypeGiven {
  return entry !== undefined && entry.rows > 0;
}

/**
 * The line of one object, in the panel's language, and whether it says what
 * a user should look at: the records hold another type than was predicted,
 * none of them was found, or what they hold could not be read.
 */
function lineOf(
  t: TFunction,
  entry: RecordTypeGiven,
  stage: RecordTypeGivenStage,
  stillRan: readonly MutedAutomationStillRunning[] | undefined,
): { text: string; warn: boolean } {
  const object = entry.objectApiName;
  const count = entry.rows;
  const list = (items: readonly string[]): string => listWords(items, (key) => t(key));
  // Every host counts each record under one reason; one it gave none goes as
  // the loader's own records without a reason do, as not read.
  const whys = WHY_ORDER.filter((why) => (entry.why[why] ?? 0) > 0);
  const why =
    whys.length > 1
      ? list(whys.map((one) => t(WHY_COUNTED_KEYS[one], { count: entry.why[one] })))
      : t(WHY_KEYS[whys[0] ?? 'notRead']);
  const lead = t(
    stage === 'predicted'
      ? 'runResults.recordTypeGiven.toCreate'
      : 'runResults.recordTypeGiven.created',
    { count, object, why },
  );
  const { predicted, readBack } = entry;
  const given = predicted
    ? t(GIVEN_KEYS[predicted.basis], { type: typeName(predicted), object })
    : t('runResults.recordTypeGiven.given.master', { object });
  if (stage === 'predicted') {
    return { text: t('runResults.recordTypeGiven.wouldGive', { count, lead, given }), warn: false };
  }
  // Nothing read back: the prediction is all there is, and the line says it
  // as one. Only what the records were read back holding is said as a fact.
  if (!readBack) {
    return { text: t('runResults.recordTypeGiven.gave', { count, lead, given }), warn: false };
  }
  if (readBack.unread !== undefined) {
    return {
      text: t('runResults.recordTypeGiven.unread', {
        count,
        lead,
        given,
        reason: readBack.unread,
      }),
      warn: true,
    };
  }
  const [first, ...others] = readBack.types;
  if (!first)
    return { text: t('runResults.recordTypeGiven.noneFound', { count, lead }), warn: true };
  const read =
    readBack.read < count
      ? t('runResults.recordTypeGiven.readOf', { read: readBack.read, rows: entry.rows })
      : String(readBack.read);
  if (others.length === 0 && first.developerName === (predicted?.developerName ?? MASTER)) {
    return {
      text: t('runResults.recordTypeGiven.readBack', { count, lead, type: typeName(first), read }),
      warn: false,
    };
  }
  // The read back is the truth, and the prediction is said beside it, never
  // in its place: what set another type is the target's automation, named
  // when the run muted it and something still ran on the object.
  const held =
    count === 1
      ? typeName(first)
      : list(
          readBack.types.map((type) =>
            t('runResults.recordTypeGiven.held', { rows: type.rows, type: typeName(type) }),
          ),
        );
  const said = predicted ? typeName(predicted) : MASTER;
  const names = [
    ...new Set(
      (stillRan ?? [])
        .filter((ran) => ran.objectApiName === object)
        .map((ran) => t(KIND_KEYS[ran.kind], { name: ran.name })),
    ),
  ];
  return {
    text:
      names.length > 0
        ? t('runResults.recordTypeGiven.differsNamed', {
            count,
            lead,
            read,
            held,
            said,
            object,
            names: list(names),
          })
        : t('runResults.recordTypeGiven.differs', { count, lead, read, held, said }),
    warn: true,
  };
}

/** Props for {@link RecordTypeGivenLine}. */
export interface RecordTypeGivenLineProps {
  /** What the host says of the object; nothing is shown when absent or of no record. */
  entry: RecordTypeGiven | undefined;
  stage: RecordTypeGivenStage;
  /** What still ran of the run's mute ({@link stillRanOf}), named where another type was set. */
  stillRan?: readonly MutedAutomationStillRunning[] | undefined;
  /** The element the line is: an item of the list it goes in, or a paragraph. */
  as?: 'li' | 'p';
  testId: string;
  className?: string;
}

/**
 * Which record type the target gave the records of one object a run created
 * without one, how many, and why each went without one — on Master in the
 * source, not read, given the default by a decision, or of a type the target
 * lacks or keeps from the user —: before the run, what the describe of the
 * user it writes as says; after it, what the first records created were read
 * back holding, the prediction said beside it only where another type was
 * set, and the target's automation then named; a read that failed in the
 * org's words, the prediction said as one.
 *
 * The page reads what the extension sends and computes no rule: the platform
 * gives a record created without a type the default its describe names, the
 * one other type open to the user when it names Master, or Master — which
 * the describe alone, read by its default, got wrong on a scratch org whose
 * admin had one other Opportunity type open. Nothing is shown of an object
 * whose records all carried their own type: the host sends nothing then.
 */
export const RecordTypeGivenLine: React.FC<RecordTypeGivenLineProps> = ({
  entry,
  stage,
  stillRan,
  as: Element = 'p',
  testId,
  className,
}) => {
  const { t } = useTranslation();
  if (!says(entry)) return null;
  const { text, warn } = lineOf(t, entry, stage, stillRan);
  return (
    <Element
      data-testid={testId}
      data-stage={stage}
      className={`${warn ? 'text-status-warning' : ''} ${className ?? ''}`.trim()}
    >
      {text}
    </Element>
  );
};

/** Props for {@link RecordTypesGivenSection}. */
export interface RecordTypesGivenSectionProps {
  /** Per object, what the host says; nothing is shown when none has a record to say. */
  entries: readonly RecordTypeGiven[] | undefined;
  stage: RecordTypeGivenStage;
  stillRan?: readonly MutedAutomationStillRunning[] | undefined;
  /** Test id of the section; each object's line takes `-<object>`. */
  testId: string;
  className?: string;
}

/**
 * The lines of a run's objects ({@link RecordTypeGivenLine}) under a title,
 * for a page that says its results for the run as a whole: Forge's results,
 * Frozen Dataset's preview and load report.
 */
export const RecordTypesGivenSection: React.FC<RecordTypesGivenSectionProps> = ({
  entries,
  stage,
  stillRan,
  testId,
  className,
}) => {
  const { t } = useTranslation();
  const headingId = useId();
  const said = (entries ?? []).filter(says);
  if (said.length === 0) return null;
  return (
    <section
      aria-labelledby={headingId}
      data-testid={testId}
      className={`rounded-sm border border-subtle px-4 py-2 text-xs text-text-secondary ${className ?? ''}`}
    >
      <h3 id={headingId} className="font-medium text-text-primary">
        {t(
          stage === 'predicted'
            ? 'runResults.recordTypeGiven.titlePredicted'
            : 'runResults.recordTypeGiven.title',
        )}
      </h3>
      <p className="mt-0.5">{t('runResults.recordTypeGiven.hint')}</p>
      <ul className="mt-1 space-y-0.5">
        {said.map((entry) => (
          <RecordTypeGivenLine
            key={entry.objectApiName}
            as="li"
            entry={entry}
            stage={stage}
            stillRan={stillRan}
            testId={`${testId}-${entry.objectApiName}`}
          />
        ))}
      </ul>
    </section>
  );
};
