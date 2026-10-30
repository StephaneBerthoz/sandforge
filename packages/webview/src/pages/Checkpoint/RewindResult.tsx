import React, { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle, XCircle } from 'lucide-react';
import type {
  OrgCheckpoint,
  RewindFilesResult,
  RewindRecreatedObject,
  RewindResidualReason,
  RewindResult as RewindOutcome,
  RewindUndoCannotReason,
} from '@sandforge/shared';
import { Button } from '../../components/ui/Button';
import {
  RestoredResult,
  UndeletedResult,
  type RestoredResultWords,
  type UndeletedResultWords,
} from '../../components/ui/RestoredResults';
import { listWords } from '../../utils/listWords';
import { formatDate, formatNumber, formatStoredDate } from '../../utils/formatters';
import { ForgeRunRemovalResult } from '../Forge/ForgeRunRemovalView';
import { StopComparingFields } from './StopComparingFields';
import { undoCannotReasonOf } from './checkpointFacts';
import {
  automationObjects,
  changedDuringRewind,
  deletedStatus,
  keptChangedSinceRewind,
  notRewound,
  remadeDeleted,
  residualGroups,
  residualTotal,
} from './rewindPreviewFacts';

/**
 * The words of a rewind's result for records Undo couldn't bring back, by reason: each
 * its own sentence.
 */
const UNDO_CANNOT_RESULT_KEYS: Readonly<Record<RewindUndoCannotReason, string>> = {
  onlyWithParent: 'checkpoint.result.undoCannot',
  deletedBeforeParent: 'checkpoint.result.undoCannotBeforeParent',
};

/** What a run was: a rewind to the checkpoint, or the undo of the org's last rewind. */
export type RunKind = 'rewind' | 'undo';

/** What each group of what still differs is called, and how each of its objects is said. */
const RESIDUAL_KEYS: Readonly<Record<RewindResidualReason, { title: string; line: string }>> = {
  automation: {
    title: 'checkpoint.result.residual.automation.title',
    line: 'checkpoint.result.residual.automation.line',
  },
  changedDuringRewind: {
    title: 'checkpoint.result.residual.changedDuringRewind.title',
    line: 'checkpoint.result.residual.changedDuringRewind.line',
  },
  changedSincePreview: {
    title: 'checkpoint.result.residual.changedSincePreview.title',
    line: 'checkpoint.result.residual.changedSincePreview.line',
  },
  refused: {
    title: 'checkpoint.result.residual.refused.title',
    line: 'checkpoint.result.residual.refused.line',
  },
  notInBin: {
    title: 'checkpoint.result.residual.notInBin.title',
    line: 'checkpoint.result.residual.notInBin.line',
  },
  goneForGood: {
    title: 'checkpoint.result.residual.goneForGood.title',
    line: 'checkpoint.result.residual.goneForGood.line',
  },
  kept: {
    title: 'checkpoint.result.residual.kept.title',
    line: 'checkpoint.result.residual.kept.line',
  },
};

/** What a rewind brought back from the recycle bin is said in. */
const REWIND_UNDELETED: UndeletedResultWords = {
  title: 'checkpoint.result.undeleted.title',
  undeleted: 'checkpoint.result.undeleted.line',
  alreadyBack: 'checkpoint.result.undeleted.alreadyBack',
  goneForGood: 'checkpoint.result.undeleted.gone',
  refused: 'checkpoint.result.refused',
  notReached: 'checkpoint.result.notReached',
};

/** What an undo brought back from the recycle bin of what the rewind deleted. */
const UNDO_UNDELETED: UndeletedResultWords = {
  ...REWIND_UNDELETED,
  title: 'checkpoint.result.undo.undeletedTitle',
};

/** What a rewind gave its checkpoint values back is said in. */
const REWIND_RESTORED: RestoredResultWords = {
  title: 'checkpoint.result.restored.title',
  restored: 'checkpoint.result.restored.line',
  keptChanged: 'checkpoint.result.restored.keptChanged',
  alreadyGone: 'checkpoint.result.restored.gone',
  refused: 'checkpoint.result.refused',
  notKept: 'checkpoint.result.restored.notKept',
  notReached: 'checkpoint.result.notReached',
  restoredWithout: 'checkpoint.result.restored.without',
};

/** What an undo gave back the values it held before the rewind of what the rewind wrote over. */
const UNDO_RESTORED: RestoredResultWords = {
  ...REWIND_RESTORED,
  title: 'checkpoint.result.undo.restoredTitle',
  restored: 'checkpoint.result.undo.restoredLine',
  keptChanged: 'checkpoint.result.undo.keptChanged',
};

/**
 * What a rewind made again with new Ids, object by object: those the recycle
 * bin no longer gave back, and of them what the org refused, in its words, or
 * a stop left.
 */
const RecreatedResult: React.FC<{
  recreated: readonly RewindRecreatedObject[];
  orgName: string;
}> = ({ recreated, orgName }) => {
  const { t } = useTranslation();
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-1"
      data-testid="checkpoint-result-recreated"
    >
      <h3 id={headingId} className="text-sm font-semibold">
        {t('checkpoint.result.recreated.title', { org: orgName })}
      </h3>
      <ul className="ml-4 list-disc">
        {recreated.map((object) => (
          <li
            key={object.objectApiName}
            data-testid={`checkpoint-result-recreated-${object.objectApiName}`}
          >
            {t('checkpoint.result.recreated.line', {
              object: object.objectApiName,
              created: formatNumber(object.created),
              planned: formatNumber(object.planned),
            })}
            {object.refused > 0 &&
              ` · ${t('checkpoint.result.refused', { org: orgName, n: formatNumber(object.refused) })}` +
                (object.reasons[0] ? ` (${object.reasons[0]})` : '')}
            {(object.notReached ?? 0) > 0 &&
              ` · ${t('checkpoint.result.notReached', { n: formatNumber(object.notReached ?? 0) })}`}
          </li>
        ))}
      </ul>
    </section>
  );
};

/**
 * What a rewind brought back for a moment, object by object: records the
 * checkpoint does not hold, deleted since with records it holds, which
 * Salesforce gives back with them only. Deleted again once those came back,
 * with what came back with them; a stopped rewind may have left some in the
 * org, which Rewind again deletes.
 */
const CarriersResult: React.FC<{
  carriers: NonNullable<RewindOutcome['carriers']>;
  orgName: string;
  stopped: boolean;
}> = ({ carriers, orgName, stopped }) => {
  const { t } = useTranslation();
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-1"
      data-testid="checkpoint-result-carriers"
    >
      <h3 id={headingId} className="text-sm font-semibold">
        {t('checkpoint.result.carriers.title', { org: orgName })}
      </h3>
      <ul className="ml-4 list-disc">
        {carriers.map((object) => (
          <li
            key={object.objectApiName}
            data-testid={`checkpoint-result-carriers-${object.objectApiName}`}
          >
            {t('checkpoint.result.carriers.line', {
              count: object.count,
              formatted: formatNumber(object.count),
              object: object.objectApiName,
            })}
          </li>
        ))}
      </ul>
      <p
        data-testid={
          stopped
            ? 'checkpoint-result-carriers-stopped'
            : 'checkpoint-result-carriers-deleted-again'
        }
      >
        {stopped
          ? t('checkpoint.result.carriers.stopped', { org: orgName })
          : t('checkpoint.result.carriers.deletedAgain')}
      </p>
    </section>
  );
};

/** What a rewind did to the links between files and records, by part, in the order it says them. */
const REWIND_FILES_KEYS: ReadonlyArray<{ part: keyof RewindFilesResult; key: string }> = [
  { part: 'unlinked', key: 'checkpoint.result.files.unlinked' },
  { part: 'relinked', key: 'checkpoint.result.files.relinked' },
  { part: 'linksUpdated', key: 'checkpoint.result.files.linksUpdated' },
  { part: 'linksRefused', key: 'checkpoint.result.files.linksRefused' },
];

/**
 * What an undo did to them: it removed the links the rewind put back, put
 * back those it removed, and gave back the sharing from before the rewind.
 */
const UNDO_FILES_KEYS: ReadonlyArray<{ part: keyof RewindFilesResult; key: string }> = [
  { part: 'unlinked', key: 'checkpoint.result.undo.files.unlinked' },
  { part: 'relinked', key: 'checkpoint.result.undo.files.relinked' },
  { part: 'linksUpdated', key: 'checkpoint.result.undo.files.linksUpdated' },
  { part: 'linksRefused', key: 'checkpoint.result.files.linksRefused' },
];

/**
 * What a rewind, or its undo, did to the links between files and records,
 * only the parts that apply: the files themselves are among what it deleted
 * and brought back, as `ContentDocument`.
 */
const FilesResult: React.FC<{ files: RewindFilesResult; kind: RunKind; orgName: string }> = ({
  files,
  kind,
  orgName,
}) => {
  const { t } = useTranslation();
  const headingId = useId();
  const lines = (kind === 'rewind' ? REWIND_FILES_KEYS : UNDO_FILES_KEYS).filter(
    ({ part }) => files[part] > 0,
  );
  if (lines.length === 0) return null;
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-1"
      data-testid="checkpoint-result-files"
    >
      <h3 id={headingId} className="text-sm font-semibold">
        {t('checkpoint.result.files.title', { org: orgName })}
      </h3>
      <ul className="ml-4 list-disc">
        {lines.map(({ part, key }) => (
          <li key={part} data-testid={`checkpoint-result-files-${part}`}>
            {t(key, { count: files[part], formatted: formatNumber(files[part]), org: orgName })}
          </li>
        ))}
      </ul>
    </section>
  );
};

/** Props for {@link RewindResult}. */
export interface RewindResultProps {
  kind: RunKind;
  /** The org rewound, as the page names it. */
  orgName: string;
  /** The checkpoint it was rewound to. */
  checkpoint: OrgCheckpoint;
  result: RewindOutcome;
  /** The names of the users the confirmed preview read, by Id. */
  userNames: Readonly<Record<string, string>>;
  /** Undo the rewind just made: its typed confirmation is the page's. */
  onUndo?: () => void;
  /** Read the org afresh for another rewind, which acts on a preview. */
  onRewindAgain: () => void;
  /** The checkpoint stops comparing fields: the list reads it again. */
  onIgnored: (checkpoint: OrgCheckpoint) => void;
  /** Back to the org's checkpoints. */
  onDone: () => void;
}

/**
 * What a rewind, or the undo of one, did, read again from the org once it was
 * through: that the org is back at the checkpoint, nothing differing among
 * the objects and fields it holds; or what still differs, grouped by why —
 * what the org's automation set again on save, which the checkpoint can stop
 * comparing, what someone else changed during the rewind, left as they made
 * it, what changed since the preview, what the org refused and what the
 * recycle bin no longer holds — then object by object what it brought back,
 * and of it what came back for a moment to bring records of the checkpoint
 * back, what it made again with new Ids, gave back and deleted, what it
 * cost, and until when it can be undone. An undo says what it sent back to
 * the recycle bin on its own that had gone there with a record the rewind
 * brought back for a moment, which stays there.
 *
 * A rewind limited to some objects was compared on them alone: it says they
 * are back, and apart, what still differs in the objects it left as they
 * are, which never makes it partial; Rewind again then rewinds them.
 */
export const RewindResult: React.FC<RewindResultProps> = ({
  kind,
  orgName,
  checkpoint,
  result,
  userNames,
  onUndo,
  onRewindAgain,
  onIgnored,
  onDone,
}) => {
  const { t } = useTranslation();
  // The checkpoint as it is once fields stopped being compared here: the
  // dialog opens again on what it now leaves out.
  const [current, setCurrent] = useState(checkpoint);
  const [stopping, setStopping] = useState<string[] | null>(null);
  const [stopped, setStopped] = useState<string[]>([]);
  const groups = residualGroups(result);
  const settled = result.status === 'success';
  const rewinding = kind === 'rewind';
  // What an undo deleted of what the rewind made again, never sent back.
  const deletedAgain = rewinding ? 0 : remadeDeleted(result);
  // A rewind that wrote nothing brought nothing back for a moment.
  const carriers = rewinding && result.status !== 'failure' ? (result.carriers ?? []) : [];
  const carriedAlone = rewinding ? [] : (result.carriedAlone ?? []);
  const automation = automationObjects(result);
  // What a rewind limited to some objects left of the others: read again
  // after its last pass only, so a run that ended before says nothing of it.
  const scope = rewinding ? result.scope : undefined;
  const others = notRewound(result);
  const othersRead = result.status === 'success' || result.status === 'partial';
  const undoUntil = rewinding && result.undo ? result.undo : undefined;
  const until = undoUntil
    ? (formatStoredDate(undoUntil.until, (d) => formatDate(d)) ?? t('common.dateUnknown'))
    : null;

  return (
    <div className="flex flex-col gap-3 text-xs text-text-primary" data-testid="checkpoint-result">
      <Headline
        kind={kind}
        orgName={orgName}
        checkpoint={checkpoint}
        result={result}
        userNames={userNames}
      />
      {scope && (others.records > 0 || othersRead) && (
        <p data-testid="checkpoint-result-not-rewound">
          {others.records > 0
            ? t('checkpoint.result.notRewound', {
                count: others.records,
                formatted: formatNumber(others.records),
                objects: listWords(others.objects, t),
                name: checkpoint.name,
              })
            : t('checkpoint.result.notRewoundNone', { name: checkpoint.name })}
        </p>
      )}

      {groups.length > 0 && (
        <div className="flex flex-col gap-2" data-testid="checkpoint-result-residual">
          {groups.map((group) => (
            <ResidualSection
              key={group.reason}
              group={group}
              orgName={orgName}
              userNames={userNames}
              {...(group.reason === 'automation' && rewinding
                ? { onStopComparing: () => setStopping(automation) }
                : {})}
            />
          ))}
        </div>
      )}
      {stopped.length > 0 && (
        <p role="status" data-testid="checkpoint-result-stopped-comparing">
          {t('checkpoint.result.stoppedComparing', {
            fields: listWords(stopped, t),
            org: orgName,
          })}
        </p>
      )}

      {result.undeleted.length > 0 && (
        <UndeletedResult
          undeleted={result.undeleted}
          org={orgName}
          words={rewinding ? REWIND_UNDELETED : UNDO_UNDELETED}
          testId="checkpoint-result-undeleted"
        />
      )}
      {carriers.length > 0 && (
        <CarriersResult
          carriers={carriers}
          orgName={orgName}
          stopped={result.status === 'cancelled'}
        />
      )}
      {rewinding && (result.recreated?.length ?? 0) > 0 && (
        <RecreatedResult recreated={result.recreated ?? []} orgName={orgName} />
      )}
      {result.restored.length > 0 && (
        <RestoredResult
          restored={result.restored}
          org={orgName}
          words={rewinding ? REWIND_RESTORED : UNDO_RESTORED}
          testId="checkpoint-result-restored"
        />
      )}
      {deletedAgain > 0 && (
        <p data-testid="checkpoint-result-remade">
          {t('checkpoint.result.undo.remade', {
            count: deletedAgain,
            formatted: formatNumber(deletedAgain),
            org: orgName,
          })}
        </p>
      )}
      {carriedAlone.map((object) => (
        <p
          key={object.objectApiName}
          data-testid={`checkpoint-result-carried-alone-${object.objectApiName}`}
        >
          {t('checkpoint.result.undo.carriedAlone', {
            count: object.count,
            formatted: formatNumber(object.count),
            object: object.objectApiName,
            org: orgName,
          })}
        </p>
      ))}
      {result.deleted.length > 0 && (
        <ForgeRunRemovalResult
          result={{ status: deletedStatus(result.deleted, result.status), objects: result.deleted }}
          org={orgName}
          subject={rewinding ? 'rewind' : 'rewindUndo'}
          // A checkpoint that holds files deletes those attached since: a
          // file attached to what it deleted stays because the checkpoint
          // holds it, or because it is attached outside it too.
          {...(rewinding && checkpoint.files !== undefined
            ? { filesLeftKey: 'runRemoval.rewind.resultFilesLeftHeld' }
            : {})}
        />
      )}
      {result.files && <FilesResult files={result.files} kind={kind} orgName={orgName} />}

      <p className="text-text-secondary" data-testid="checkpoint-result-requests">
        {t('checkpoint.result.requests', {
          used: formatNumber(result.apiRequests.used),
          left: formatNumber(result.apiRequests.leftToday),
        })}
      </p>

      {undoUntil && until !== null && (
        <div className="flex flex-col gap-1" data-testid="checkpoint-result-undo">
          <p>{t('checkpoint.result.undoUntil', { date: until })}</p>
          {undoUntil.cannot.length > 0 && (
            <ul className="ml-4 list-disc" data-testid="checkpoint-result-undo-cannot">
              {undoUntil.cannot.map((item) => {
                const reason = undoCannotReasonOf(item);
                return (
                  <li key={`${item.objectApiName}-${reason}`}>
                    {t(UNDO_CANNOT_RESULT_KEYS[reason], {
                      count: item.count,
                      formatted: formatNumber(item.count),
                      object: item.objectApiName,
                    })}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {undoUntil && onUndo && (
          <Button variant="secondary" onClick={onUndo} data-testid="checkpoint-result-undo-open">
            {t('checkpoint.undo.open')}
          </Button>
        )}
        {rewinding && (!settled || others.records > 0) && (
          <Button
            variant="secondary"
            onClick={onRewindAgain}
            data-testid="checkpoint-result-rewind-again"
          >
            {t('checkpoint.result.rewindAgain')}
          </Button>
        )}
        <Button variant="primary" onClick={onDone} data-testid="checkpoint-result-done">
          {t('checkpoint.take.done')}
        </Button>
      </div>

      {stopping && (
        <StopComparingFields
          checkpoint={current}
          objects={stopping}
          onClose={() => setStopping(null)}
          onSaved={(saved, fields) => {
            setCurrent(saved);
            setStopped(fields);
            setStopping(null);
            onIgnored(saved);
          }}
        />
      )}
    </div>
  );
};

/** Props for the first line of a result. */
interface HeadlineProps {
  kind: RunKind;
  orgName: string;
  checkpoint: OrgCheckpoint;
  result: RewindOutcome;
  userNames: Readonly<Record<string, string>>;
}

/**
 * What a result says first: where the org stands now, by how the run ended;
 * of a rewind limited to some objects, where they stand, compared alone.
 */
const Headline: React.FC<HeadlineProps> = ({ kind, orgName, checkpoint, result, userNames }) => {
  const { t } = useTranslation();
  const org = orgName;
  const name = checkpoint.name;
  const left = residualTotal(result);
  const limitedTo = kind === 'rewind' ? result.scope?.objects : undefined;
  const objects = limitedTo ? listWords(limitedTo, t) : '';
  let text: string;
  if (kind === 'undo') {
    const kept = keptChangedSinceRewind(result);
    text =
      result.status === 'success'
        ? t('checkpoint.result.undo.success', { org })
        : result.status === 'cancelled'
          ? t('checkpoint.result.undo.cancelled', { org })
          : result.status === 'failure'
            ? t('checkpoint.result.undo.failure', { org })
            : kept > 0
              ? t('checkpoint.result.undo.partial', {
                  count: kept,
                  formatted: formatNumber(kept),
                  org,
                })
              : t('checkpoint.result.undo.partialListed', { org });
  } else if (result.status === 'success') {
    text = limitedTo
      ? t('checkpoint.result.successObjects', { objects, org, name })
      : t('checkpoint.result.success', { org, name });
  } else if (result.status === 'cancelled') {
    const stopped = t('checkpoint.result.cancelled', { org, name });
    text = result.undo ? `${stopped} ${t('checkpoint.result.cancelledUndo', { org })}` : stopped;
  } else if (result.status === 'failure') {
    text = t('checkpoint.result.failure', { org, name });
  } else if (result.status === 'unstable') {
    const changers = changedDuringRewind(result, userNames).filter((each) => each.userId !== '');
    const people = changers.map((each) => {
      const who = each.name ?? each.userId;
      return t('checkpoint.result.changedBy', {
        count: each.count,
        formatted: formatNumber(each.count),
        name: who,
      });
    });
    text =
      people.length > 0
        ? t('checkpoint.result.unstable', { org, people: listWords(people, t) })
        : t('checkpoint.result.unstableUnnamed', { org });
  } else if (limitedTo) {
    text =
      left > 0
        ? t('checkpoint.result.partialObjects', {
            count: left,
            formatted: formatNumber(left),
            objects,
            org,
            name,
          })
        : t('checkpoint.result.partialListedObjects', { objects, org, name });
  } else {
    text =
      left > 0
        ? t('checkpoint.result.partial', { count: left, formatted: formatNumber(left), org, name })
        : t('checkpoint.result.partialListed', { org, name });
  }
  const Icon =
    result.status === 'success'
      ? CheckCircle
      : result.status === 'failure'
        ? XCircle
        : AlertTriangle;
  const tone =
    result.status === 'success'
      ? 'text-status-success'
      : result.status === 'failure'
        ? 'text-status-error'
        : 'text-status-warning';
  return (
    <p className="flex items-start gap-2 text-sm" data-testid="checkpoint-result-headline">
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${tone}`} aria-hidden="true" />
      <span>{text}</span>
    </p>
  );
};

/** Props for one group of what still differs. */
interface ResidualSectionProps {
  group: ReturnType<typeof residualGroups>[number];
  orgName: string;
  userNames: Readonly<Record<string, string>>;
  /** Fields the org's automation set again: offered to stop comparing. */
  onStopComparing?: () => void;
}

/** What still differs for one reason, object by object, in the org's words for a refusal. */
const ResidualSection: React.FC<ResidualSectionProps> = ({
  group,
  orgName,
  userNames,
  onStopComparing,
}) => {
  const { t } = useTranslation();
  const headingId = useId();
  const keys = RESIDUAL_KEYS[group.reason];
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-1"
      data-testid={`checkpoint-result-residual-${group.reason}`}
    >
      <h3 id={headingId} className="text-xs font-semibold">
        {t(keys.title, { org: orgName })}
      </h3>
      <ul className="ml-4 list-disc">
        {group.residuals.map((residual) => {
          const user = residual.by ? (userNames[residual.by] ?? residual.by) : '';
          return (
            <li
              key={`${residual.objectApiName}-${residual.by ?? ''}-${residual.message ?? ''}`}
              data-testid={`checkpoint-result-residual-${group.reason}-${residual.objectApiName}`}
            >
              {t(keys.line, {
                count: residual.count,
                formatted: formatNumber(residual.count),
                object: residual.objectApiName,
                user,
              })}
              {residual.message && (
                <span className="block wrap-break-word text-text-secondary">
                  {residual.message}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {onStopComparing && (
        <div>
          <Button
            variant="secondary"
            size="sm"
            onClick={onStopComparing}
            data-testid="checkpoint-result-stop-comparing"
          >
            {t('checkpoint.result.stopComparing')}
          </Button>
        </div>
      )}
    </section>
  );
};
