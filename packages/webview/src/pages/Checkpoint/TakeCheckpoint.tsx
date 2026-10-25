import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle } from 'lucide-react';
import type {
  CheckpointScopeMode,
  CheckpointScopeObject,
  CheckpointScopeResponse,
  CheckpointTakeResponse,
  OrgCheckpoint,
  SalesforceOrg,
} from '@sandforge/shared';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { useFocusOnChange } from '../../hooks/useFocusOnChange';
import { useLatestRef } from '../../hooks/useLatestRef';
import { useOperationCancel } from '../../hooks/useOperationCancel';
import { useOperationProgress } from '../../hooks/useOperationProgress';
import { WRITE_RUN_TIMEOUT_MS } from '../../hooks/writeRunTimeout';
import { Button } from '../../components/ui/Button';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { Input } from '../../components/ui/Input';
import { ProgressAnnouncer, ProgressBar } from '../../components/ui/ProgressBar';
import { listWords } from '../../utils/listWords';
import {
  dateTimeFormat,
  formatDate,
  formatDurationSec,
  formatFileSize,
  formatNumber,
} from '../../utils/formatters';
import {
  CHECKPOINT_KEEP_DAYS,
  CHECKPOINT_NAME_MAX,
  isCheckpointName,
  objectsWithRecords,
  recordsHeld,
  refusedBeforeScope,
  roughSeconds,
} from './checkpointFacts';

/** What `checkpoint:scope` answers. */
type ScopeAnswer = CheckpointScopeResponse['payload'];

/**
 * How long the scope of a take is waited for: a describe of every object the
 * org holds, 25 to a call, and a count of each, 5 to a call — about half a
 * minute on a Developer Edition, more on an org of a thousand objects.
 */
const SCOPE_TIMEOUT_MS = 10 * 60_000;

/**
 * How long the picks rest before their scope is asked for: each ask reads
 * the org's describes and counts, and a click is rarely the last one.
 */
const PICKS_SETTLE_MS = 600;

/** Objects listed at once; the filter reaches the others. */
const LISTED_OBJECTS = 50;

/** The names offered beside the field, and whether one keeps the checkpoint until it is deleted. */
const NAME_CHIPS: ReadonlyArray<{ key: string; keep: boolean; testId: string }> = [
  { key: 'checkpoint.take.chip.beforeUat', keep: false, testId: 'before-uat' },
  { key: 'checkpoint.take.chip.beforeDemo', keep: false, testId: 'before-demo' },
  { key: 'checkpoint.take.chip.cleanBaseline', keep: true, testId: 'clean-baseline' },
];

/** The date and time a checkpoint is called by default, in the panel's language. */
function defaultName(): string {
  return dateTimeFormat({ dateStyle: 'medium', timeStyle: 'short' }).format(new Date());
}

/** `value`, once it has stopped changing for `ms`. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** Props for {@link TakeCheckpoint}. */
export interface TakeCheckpointProps {
  /** The org to take a checkpoint of: a sandbox, a scratch org or a Developer Edition. */
  org: SalesforceOrg;
  /** Leave the take: Cancel before it runs, Done once it is kept. */
  onClose: () => void;
  /** A checkpoint was kept: the list is read again. */
  onTaken: () => void;
}

/**
 * Take a checkpoint of an org: what it is called and how long it is kept,
 * what it keeps, and what it costs, said before it runs — then the take, with
 * its progress and Stop, and what it kept.
 *
 * Nothing is read from the org's records until the take is asked for: the
 * scope reads its describes and counts only, and the extension refuses there,
 * before any record is read, what the take would be refused (a production
 * org, a user without View All Data and Modify All Data, too many records, too
 * few API requests left today, a SandForge run writing to the org).
 */
export const TakeCheckpoint: React.FC<TakeCheckpointProps> = ({ org, onClose, onTaken }) => {
  const { t } = useTranslation();
  const orgName = org.alias || org.username;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const headingId = useId();

  const [name, setName] = useState(defaultName);
  const [keep, setKeep] = useState(false);
  const [mode, setMode] = useState<CheckpointScopeMode>('everything');
  const [picked, setPicked] = useState<string[]>([]);
  const settledPicks = useSettled(picked, PICKS_SETTLE_MS);

  const everything = useBridgeQuery<ScopeAnswer>(
    'checkpoint:scope',
    { orgId: org.id, mode: 'everything' },
    { timeoutMs: SCOPE_TIMEOUT_MS },
  );
  const pickedScope = useBridgeQuery<ScopeAnswer>(
    'checkpoint:scope',
    { orgId: org.id, mode: 'picked', objects: settledPicks },
    { timeoutMs: SCOPE_TIMEOUT_MS, skip: mode !== 'picked' || settledPicks.length === 0 },
  );

  // A take goes on in the extension until it ends, and answers then: its
  // progress events never reset the wait.
  const take = useBridgeMutation<CheckpointTakeResponse['payload']>('checkpoint:take', {
    timeoutMs: WRITE_RUN_TIMEOUT_MS,
    runOutlivesWait: true,
  });
  // The take runs under the id of the request that started it, as Seed's and
  // Sync's runs do: its progress is read by that id, and Stop sends it on
  // `execution:abort`, as Live Operations' Cancel does.
  const { getProgress } = useOperationProgress();
  const progress = take.loading && take.requestId ? getProgress(take.requestId) : undefined;
  const stop = useOperationCancel(take.loading ? take.requestId : null, {
    title: t('common.runCancelRefused'),
    message: t('common.runCancelRefusedDetail'),
  });

  const taken = take.data?.checkpoint;
  const announceTaken = useLatestRef(onTaken);
  useEffect(() => {
    if (taken) announceTaken.current();
  }, [taken, announceTaken]);

  const phase = taken ? 'taken' : take.loading ? 'running' : 'asking';
  useFocusOnChange(headingRef, phase, { onMount: true });

  // The scope a take of the current choice reads: the picks' own once they
  // have settled and been answered, never an earlier pick's.
  const picksAnswered =
    mode === 'picked' &&
    settledPicks === picked &&
    picked.length > 0 &&
    !pickedScope.loading &&
    pickedScope.data !== null;
  const answer: ScopeAnswer | null =
    mode === 'everything'
      ? everything.loading
        ? null
        : everything.data
      : picksAnswered
        ? pickedScope.data
        : null;
  // What "Only the objects I pick" offers is the scope of everything: when
  // that could not be read there is nothing to pick from, and its failure is
  // the one to say.
  const scopeQuery =
    mode === 'everything' || (everything.data === null && everything.error !== null)
      ? everything
      : pickedScope;
  const nameValid = isCheckpointName(name);
  const canTake =
    answer !== null && answer.refusal === undefined && nameValid && !take.loading && !taken;

  const startTake = (): void => {
    if (!canTake) return;
    take.mutate({
      orgId: org.id,
      name: name.trim(),
      mode,
      ...(mode === 'picked' ? { objects: picked } : {}),
      keepDays: keep ? 0 : CHECKPOINT_KEEP_DAYS,
    });
  };

  return (
    <section
      className="flex flex-col gap-4 rounded-sm border border-subtle bg-surface-1 p-4"
      aria-labelledby={headingId}
      data-testid="checkpoint-take"
    >
      <h2
        id={headingId}
        ref={headingRef}
        tabIndex={-1}
        className="text-base font-semibold text-text-primary"
      >
        {phase === 'running'
          ? t('checkpoint.take.running', { name: name.trim() })
          : t('checkpoint.take.title', { org: orgName })}
      </h2>

      {taken ? (
        <TakeResult checkpoint={taken} onDone={onClose} />
      ) : take.loading ? (
        <TakeRun
          step={progress?.currentStep}
          processed={progress?.processedRecords ?? 0}
          total={progress?.totalRecords ?? 0}
          stopRequested={stop.requested}
          onStop={stop.cancel}
        />
      ) : (
        <>
          {take.error &&
            (take.errorCode === 'CANCELLED' ? (
              <p
                role="status"
                className="text-sm text-text-primary"
                data-testid="checkpoint-take-stopped"
              >
                {t('checkpoint.take.stopped')}
              </p>
            ) : (
              <ErrorBanner
                message={take.error}
                code={take.errorCode}
                data-testid="checkpoint-take-error"
              />
            ))}

          <NameField name={name} valid={nameValid} keep={keep} onName={setName} onKeep={setKeep} />

          <fieldset className="flex flex-col gap-2" data-testid="checkpoint-scope">
            <legend className="mb-1 text-sm font-medium text-text-primary">
              {t('checkpoint.take.whatItKeeps')}
            </legend>
            <label className="flex items-start gap-2 text-sm text-text-primary">
              <input
                type="radio"
                name="checkpoint-scope-mode"
                checked={mode === 'everything'}
                onChange={() => setMode('everything')}
                data-testid="checkpoint-scope-everything"
              />
              <span>{t('checkpoint.take.everything')}</span>
            </label>
            <label className="flex items-start gap-2 text-sm text-text-primary">
              <input
                type="radio"
                name="checkpoint-scope-mode"
                checked={mode === 'picked'}
                onChange={() => setMode('picked')}
                data-testid="checkpoint-scope-picked"
              />
              <span>{t('checkpoint.take.picked')}</span>
            </label>

            {everything.data && !refusedBeforeScope(everything.data) && (
              <ScopeObjects
                answer={everything.data}
                picking={mode === 'picked'}
                picked={picked}
                onPick={setPicked}
              />
            )}
            <p className="text-xs text-text-secondary">{t('checkpoint.take.leftOutAlways')}</p>
            {answer && answer.leftOut.length > 0 && (
              <details className="text-xs text-text-primary" data-testid="checkpoint-left-out">
                <summary className="cursor-pointer">
                  {t('checkpoint.take.seeLeftOut', {
                    count: answer.leftOut.length,
                    formatted: formatNumber(answer.leftOut.length),
                  })}
                </summary>
                <ul className="mt-1 flex max-h-48 flex-col gap-0.5 overflow-y-auto">
                  {answer.leftOut.map((object) => (
                    <li key={object.objectApiName}>
                      <span className="font-mono">{object.objectApiName}</span>
                      {' — '}
                      {object.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </fieldset>

          <BeforeItRuns
            orgName={orgName}
            username={org.username}
            answer={answer}
            keep={keep}
            reading={scopeQuery.loading || (mode === 'picked' && settledPicks !== picked)}
            nothingPicked={mode === 'picked' && picked.length === 0}
            error={scopeQuery.error}
            errorCode={scopeQuery.errorCode}
            onRetry={scopeQuery.refetch}
          />

          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              onClick={startTake}
              disabled={!canTake}
              data-testid="checkpoint-take-start"
            >
              {t('checkpoint.take.start')}
            </Button>
            <Button variant="secondary" onClick={onClose} data-testid="checkpoint-take-cancel">
              {t('common.cancel')}
            </Button>
          </div>
        </>
      )}
    </section>
  );
};

/** Props for the name of a take. */
interface NameFieldProps {
  name: string;
  valid: boolean;
  keep: boolean;
  onName: (name: string) => void;
  onKeep: (keep: boolean) => void;
}

/** What the checkpoint is called, with names to pick from, and whether it expires. */
const NameField: React.FC<NameFieldProps> = ({ name, valid, keep, onName, onKeep }) => {
  const { t } = useTranslation();
  const inputId = useId();
  const chipsId = useId();
  return (
    <div className="flex flex-col gap-2">
      <Input
        id={inputId}
        label={t('checkpoint.name')}
        value={name}
        maxLength={CHECKPOINT_NAME_MAX}
        onChange={(event) => onName(event.target.value)}
        error={valid ? undefined : t('checkpoint.nameRule')}
        data-testid="checkpoint-take-name"
      />
      <div role="group" aria-labelledby={chipsId} className="flex flex-wrap items-center gap-2">
        <span id={chipsId} className="text-xs text-text-secondary">
          {t('checkpoint.take.chips')}
        </span>
        {NAME_CHIPS.map((chip) => (
          <Button
            key={chip.key}
            variant="secondary"
            size="sm"
            onClick={() => {
              onName(t(chip.key));
              if (chip.keep) onKeep(true);
            }}
            data-testid={`checkpoint-chip-${chip.testId}`}
          >
            {t(chip.key)}
          </Button>
        ))}
      </div>
      <label className="flex items-center gap-2 text-sm text-text-primary">
        <input
          type="checkbox"
          checked={keep}
          onChange={(event) => onKeep(event.target.checked)}
          data-testid="checkpoint-take-keep"
        />
        <span>{t('checkpoint.keep')}</span>
      </label>
    </div>
  );
};

/** Props for the objects of a scope. */
interface ScopeObjectsProps {
  /** The scope of everything people work in: the objects a checkpoint can hold. */
  answer: ScopeAnswer;
  /** "Only the objects I pick": the list is the picker. */
  picking: boolean;
  picked: string[];
  onPick: (picked: string[]) => void;
}

/**
 * The objects a take of everything people work in holds — the ones holding
 * records, the empty ones it holds so that what is created there later is
 * caught, those of each managed package — and, with "Only the objects I
 * pick", the same objects to pick from: only those a checkpoint can hold.
 */
const ScopeObjects: React.FC<ScopeObjectsProps> = ({ answer, picking, picked, onPick }) => {
  const { t } = useTranslation();
  const filterId = useId();
  const [filter, setFilter] = useState('');
  const { objects } = answer;
  const holding = objects.filter((object) => object.records > 0).length;
  const empty = objects.length - holding;
  const packages = useMemo(() => {
    const counts = new Map<string, number>();
    for (const object of objects) {
      if (object.namespace) counts.set(object.namespace, (counts.get(object.namespace) ?? 0) + 1);
    }
    return [...counts].sort(([a], [b]) => a.localeCompare(b));
  }, [objects]);
  // The objects holding records first, the most first: what a take spends its time on.
  const ordered = useMemo(
    () =>
      [...objects].sort(
        (a, b) => b.records - a.records || a.objectApiName.localeCompare(b.objectApiName),
      ),
    [objects],
  );
  const needle = filter.trim().toLowerCase();
  const matching = needle
    ? ordered.filter(
        (object) =>
          object.label.toLowerCase().includes(needle) ||
          object.objectApiName.toLowerCase().includes(needle),
      )
    : ordered;
  const listed = matching.slice(0, LISTED_OBJECTS);

  const toggle = (object: CheckpointScopeObject): void => {
    onPick(
      picked.includes(object.objectApiName)
        ? picked.filter((apiName) => apiName !== object.objectApiName)
        : [...picked, object.objectApiName],
    );
  };

  const list = (
    <div className="mt-2 flex flex-col gap-2">
      <ul
        className="flex flex-col gap-0.5 text-xs text-text-primary"
        data-testid="checkpoint-scope-facts"
      >
        <li>
          {t('checkpoint.take.holdRecords', { count: holding, formatted: formatNumber(holding) })}
        </li>
        {empty > 0 && (
          <li>
            {t('checkpoint.take.emptyObjects', { count: empty, formatted: formatNumber(empty) })}
          </li>
        )}
        {packages.map(([namespace, count]) => (
          <li key={namespace}>
            {t('checkpoint.take.ofPackage', { count, formatted: formatNumber(count), namespace })}
          </li>
        ))}
      </ul>
      <div className="max-w-xs">
        <Input
          id={filterId}
          type="search"
          label={t('checkpoint.take.filter')}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          data-testid="checkpoint-object-filter"
        />
      </div>
      <ul
        className="flex max-h-64 flex-col gap-0.5 overflow-y-auto rounded-sm border border-subtle p-1"
        data-testid="checkpoint-object-list"
      >
        {listed.map((object) => {
          const label = (
            <>
              <span className="flex-1 text-text-primary">{object.label}</span>
              {object.label !== object.objectApiName && (
                <span className="font-mono text-text-primary">{object.objectApiName}</span>
              )}
              <span className="text-text-primary">
                {t('checkpoint.list.records', {
                  count: object.records,
                  formatted: formatNumber(object.records),
                })}
              </span>
            </>
          );
          return (
            <li key={object.objectApiName}>
              {picking ? (
                <label className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-xs">
                  <input
                    type="checkbox"
                    checked={picked.includes(object.objectApiName)}
                    onChange={() => toggle(object)}
                    data-testid={`checkpoint-pick-${object.objectApiName}`}
                  />
                  {label}
                </label>
              ) : (
                <div className="flex items-center gap-2 px-2 py-1 text-xs">{label}</div>
              )}
            </li>
          );
        })}
      </ul>
      {matching.length === 0 && (
        <p className="text-xs text-text-secondary">{t('checkpoint.take.noMatch')}</p>
      )}
      {matching.length > listed.length && (
        <p className="text-xs text-text-secondary" data-testid="checkpoint-more-objects">
          {t('checkpoint.take.moreObjects', {
            shown: formatNumber(listed.length),
            total: formatNumber(matching.length),
          })}
        </p>
      )}
      {picking && (
        <p
          aria-live="polite"
          className="text-xs text-text-secondary"
          data-testid="checkpoint-picked"
        >
          {picked.length === 0
            ? t('checkpoint.take.pickedNone')
            : t('checkpoint.take.pickedCount', {
                count: picked.length,
                formatted: formatNumber(picked.length),
              })}
        </p>
      )}
    </div>
  );

  if (picking) return list;
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs text-text-primary" data-testid="checkpoint-scope-summary">
        {t('checkpoint.take.objects', {
          count: objects.length,
          formatted: formatNumber(objects.length),
        })}
        {' · '}
        {t('checkpoint.take.aboutRecords', {
          count: answer.estimate.records,
          formatted: formatNumber(answer.estimate.records),
        })}
      </p>
      <details data-testid="checkpoint-see-objects">
        <summary className="cursor-pointer text-xs text-text-primary">
          {t('checkpoint.take.seeObjects')}
        </summary>
        {list}
      </details>
    </div>
  );
};

/** Props for what a take costs. */
interface BeforeItRunsProps {
  orgName: string;
  username: string;
  /** The scope of the current choice, once answered. */
  answer: ScopeAnswer | null;
  keep: boolean;
  /** The scope of the current choice is being read. */
  reading: boolean;
  /** "Only the objects I pick", and none picked yet. */
  nothingPicked: boolean;
  error: string | null;
  errorCode: string | null;
  onRetry: () => void;
}

/**
 * What the take costs and means, said before its button is enabled: time,
 * API requests against what the org has left today, room on this machine and
 * how long it is kept; that it holds the values in clear; the objects whose
 * deleted records come back only with their parent; the fields it cannot
 * hold; and, when the extension would refuse the take, why.
 */
const BeforeItRuns: React.FC<BeforeItRunsProps> = ({
  orgName,
  username,
  answer,
  keep,
  reading,
  nothingPicked,
  error,
  errorCode,
  onRetry,
}) => {
  const { t } = useTranslation();
  const objects = answer?.objects ?? [];
  const withParent = objects
    .filter((object) => !object.undeletable && object.records > 0)
    .map((object) => object.objectApiName);
  const encrypted = objects.flatMap((object) =>
    object.leftOutFields
      .filter((field) => field.reason === 'encrypted')
      .map((field) => `${object.objectApiName}.${field.field}`),
  );
  const hidden = objects.reduce(
    (sum, object) => sum + object.leftOutFields.filter((field) => field.reason === 'fls').length,
    0,
  );
  const until = formatDate(new Date(Date.now() + CHECKPOINT_KEEP_DAYS * 86_400_000));

  let body: React.ReactNode;
  if (error && !reading) {
    body = (
      <div className="flex flex-col items-start gap-2">
        <ErrorBanner message={error} code={errorCode} data-testid="checkpoint-scope-error" />
        <Button
          variant="secondary"
          size="sm"
          onClick={onRetry}
          data-testid="checkpoint-scope-retry"
        >
          {t('common.retry')}
        </Button>
      </div>
    );
  } else if (nothingPicked) {
    body = <p className="text-xs text-text-secondary">{t('checkpoint.take.pickedNone')}</p>;
  } else if (answer === null || reading) {
    body = (
      <p
        role="status"
        className="text-xs text-text-secondary"
        data-testid="checkpoint-scope-reading"
      >
        {t('checkpoint.take.reading', { org: orgName })}
      </p>
    );
  } else if (refusedBeforeScope(answer)) {
    // Refused before its scope was read, the take has no cost to say: the
    // refusal alone, as the command line prints it.
    body = (
      <p
        role="alert"
        className="text-xs font-medium text-text-primary"
        data-testid="checkpoint-refusal"
      >
        {answer.refusal.message}
      </p>
    );
  } else {
    const cost = {
      time: formatDurationSec(roughSeconds(answer.estimate.seconds)),
      requests: formatNumber(answer.estimate.apiRequests),
      left: formatNumber(answer.estimate.apiRequestsLeft),
      size: formatFileSize(answer.estimate.bytes),
    };
    body = (
      <div className="flex flex-col gap-1.5 text-xs text-text-primary">
        {answer.refusal && (
          <p
            role="alert"
            className="font-medium text-text-primary"
            data-testid="checkpoint-refusal"
          >
            {answer.refusal.message}
          </p>
        )}
        <p data-testid="checkpoint-cost">
          {keep
            ? t('checkpoint.take.costKept', cost)
            : t('checkpoint.take.cost', { ...cost, until })}
        </p>
        <p>{t('checkpoint.take.inClear')}</p>
        <p>{t('checkpoint.take.askToStop', { org: orgName })}</p>
        {withParent.length > 0 && (
          <p data-testid="checkpoint-with-parent">
            {t('checkpoint.take.withParent', { objects: listWords(withParent, t) })}
          </p>
        )}
        {encrypted.length > 0 && (
          <p data-testid="checkpoint-encrypted">
            {t('checkpoint.take.encrypted', {
              count: encrypted.length,
              fields: listWords(encrypted, t),
              user: username,
            })}
          </p>
        )}
        {hidden > 0 && (
          <p data-testid="checkpoint-hidden">
            {t('checkpoint.take.hidden', {
              count: hidden,
              formatted: formatNumber(hidden),
              user: username,
            })}
          </p>
        )}
      </div>
    );
  }

  return (
    <Card data-testid="checkpoint-before-it-runs">
      <CardHeader title={t('checkpoint.take.beforeItRuns')} />
      <CardBody>{body}</CardBody>
    </Card>
  );
};

/** Props for a take under way. */
interface TakeRunProps {
  /** What the take is reading, as the extension says it. */
  step?: string;
  processed: number;
  total: number;
  stopRequested: boolean;
  onStop: () => void;
}

/** A take under way: what it reads, how far it is, and Stop. A stopped take is not kept. */
const TakeRun: React.FC<TakeRunProps> = ({ step, processed, total, stopRequested, onStop }) => {
  const { t } = useTranslation();
  const said = step ?? t('checkpoint.take.starting');
  const counted = `${formatNumber(processed)} / ${formatNumber(total)}`;
  return (
    <div className="flex flex-col gap-3" data-testid="checkpoint-take-run">
      <p className="text-sm text-text-primary" data-testid="checkpoint-take-step">
        {said}
        {total > 0 && ` — ${counted}`}
      </p>
      {total > 0 ? (
        <ProgressBar
          value={processed}
          max={total}
          ariaLabel={t('checkpoint.take.progress')}
          valueText={counted}
        />
      ) : (
        <ProgressBar indeterminate ariaLabel={t('checkpoint.take.progress')} />
      )}
      <ProgressAnnouncer message={said} testId="checkpoint-take-announcer" />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          onClick={onStop}
          disabled={stopRequested}
          data-testid="checkpoint-take-stop"
        >
          {t('checkpoint.take.stop')}
        </Button>
        {stopRequested && (
          <span role="status" className="text-xs text-text-secondary">
            {t('checkpoint.take.stopping')}
          </span>
        )}
      </div>
    </div>
  );
};

/** What a take kept, and what moved while it read. */
const TakeResult: React.FC<{ checkpoint: OrgCheckpoint; onDone: () => void }> = ({
  checkpoint,
  onDone,
}) => {
  const { t } = useTranslation();
  const records = recordsHeld(checkpoint);
  const objects = objectsWithRecords(checkpoint);
  const { changed, deleted, created } = checkpoint.movedWhileTaken;
  const moved = changed + deleted + created;
  const recordsHeldText = t('checkpoint.list.records', {
    count: records,
    formatted: formatNumber(records),
  });
  const objectsText = t('checkpoint.take.objects', {
    count: objects,
    formatted: formatNumber(objects),
  });
  return (
    <div className="flex flex-col gap-3" data-testid="checkpoint-take-result">
      <p
        className="flex items-start gap-2 text-sm text-text-primary"
        data-testid="checkpoint-taken"
      >
        <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-status-success" aria-hidden="true" />
        <span>
          {t('checkpoint.take.taken', {
            name: checkpoint.name,
            records: recordsHeldText,
            objects: objectsText,
            size: formatFileSize(checkpoint.bytes),
          })}
        </span>
      </p>
      {moved > 0 && (
        <p
          className="flex items-start gap-2 text-sm text-text-primary"
          data-testid="checkpoint-moved"
        >
          <AlertTriangle
            className="mt-0.5 h-4 w-4 shrink-0 text-status-warning"
            aria-hidden="true"
          />
          <span>
            {t('checkpoint.take.moved', { count: moved, formatted: formatNumber(moved) })}
          </span>
        </p>
      )}
      <div>
        <Button variant="primary" onClick={onDone} data-testid="checkpoint-take-done">
          {t('checkpoint.take.done')}
        </Button>
      </div>
    </div>
  );
};
