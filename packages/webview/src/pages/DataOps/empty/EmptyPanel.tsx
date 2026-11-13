import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  guardTierOf,
  isDevelopmentOrg,
  type DataOpsEmptyCancelResponse,
  type DataOpsEmptyMode,
  type DataOpsEmptyRunResponse,
  type DataOpsEmptyScopeRequest,
  type DataOpsEmptyScopeResponse,
  type DataOpsEmptyUndoResponse,
} from '@sandforge/shared';
import { useBridgeMutation } from '../../../hooks/useBridgeMutation';
import { useBridgeQuery } from '../../../hooks/useBridgeQuery';
import { useLatestRef } from '../../../hooks/useLatestRef';
import { WRITE_RUN_TIMEOUT_MS } from '../../../hooks/writeRunTimeout';
import { useOrgStore } from '../../../stores/useOrgStore';
import { useNotificationStore } from '../../../stores/useNotificationStore';
import { AutomationMuteBox } from '../../../components/ui/AutomationMuteBox';
import { Button } from '../../../components/ui/Button';
import { CheckpointFirstOption } from '../../../components/ui/CheckpointFirstOption';
import { DangerConfirm } from '../../../components/ui/DangerConfirm';
import { ErrorBanner } from '../../../components/ui/ErrorBanner';
import { formatNumber } from '../../../utils/formatters';
import { NO_BOXES, notPickable, type EmptyBox, type EmptyBoxes } from './emptyFacts';
import { EmptyHistory } from './EmptyHistory';
import { EmptyObjectList } from './EmptyObjectList';
import { EmptyOutcome } from './EmptyOutcome';
import {
  EmptyPreview,
  LeftOutList,
  emptyButtonWords,
  objectsWords,
  recordsWords,
  type EmptyPreviewAnswer,
} from './EmptyPreview';

/**
 * How long a preview is waited for. It reads the org whole, writing nothing:
 * a describe of every object it empties and of every object their records
 * take along, a count of each, what fires, who is at work — many minutes on
 * an org of many objects. Its Stop stops it before its next count.
 */
const PREVIEW_TIMEOUT_MS = 60 * 60_000;

/** The code a refusal of a production org comes with, by the registry or by what the org says. */
const PRODUCTION = 'PRODUCTION';

/** Props for {@link EmptyPanel}. */
export interface EmptyPanelProps {
  /** The org emptied, by its id in the registry. */
  orgId: string;
  /** Its name as the page shows it: the word typed to confirm. */
  orgName: string;
}

/** How each section deletes. */
interface HowAsked {
  hard: boolean;
  checkpointFirst: boolean;
}

/** What the org section empties beyond the objects people work in, and leaves out. */
interface OrgAsked {
  customSettings: boolean;
  files: boolean;
  managedPackages: boolean;
  excluded: string[];
}

/** A preview as asked: what the page compares the options with, to say it no longer holds. */
interface PreviewAsked {
  mode: DataOpsEmptyMode;
  /** The options it was asked with, mute aside, by value. */
  key: string;
  payload: Record<string, unknown>;
}

/** A resume or an undo being confirmed, of which run. */
interface AskedAct {
  act: 'resume' | 'undo';
  runId: string;
}

/** What the page shows below the sections: the outcome of which act. */
type Shown = 'run' | 'undo' | null;

const NO_HOW: HowAsked = { hard: false, checkpointFirst: false };

/** The kinds of object the whole org empties only when asked, each with its box's words. */
const OPT_IN_KEYS = {
  customSettings: 'dataopsEmpty.org.customSettings',
  files: 'dataopsEmpty.org.files',
  managedPackages: 'dataopsEmpty.org.managedPackages',
} as const;

/** The request a section's options make: what the preview, then the run, act on. */
function requestOf(
  mode: DataOpsEmptyMode,
  picked: readonly string[],
  org: OrgAsked,
): DataOpsEmptyScopeRequest {
  if (mode === 'objects') return { mode, objects: [...picked] };
  return {
    mode,
    ...(org.excluded.length > 0 ? { excluded: [...org.excluded] } : {}),
    ...(org.customSettings ? { customSettings: true } : {}),
    ...(org.files ? { files: true } : {}),
    ...(org.managedPackages ? { managedPackages: true } : {}),
  };
}

/** The Stop of what the page started — a preview, a run, an undo — on `dataops:empty:cancel`. */
function useEmptyStop(requestId: string | null): { requested: boolean; stop: () => void } {
  const { t } = useTranslation();
  const cancel = useBridgeMutation<DataOpsEmptyCancelResponse['payload']>('dataops:empty:cancel', {
    responseType: 'dataops:empty:cancel:response',
    errorType: 'dataops:error',
  });
  const addNotification = useNotificationStore((s) => s.addNotification);
  const [requested, setRequested] = useState(false);
  useEffect(() => {
    setRequested(false);
  }, [requestId]);
  const answered = useRef<unknown>(null);
  const reply = cancel.data;
  const failed = cancel.error;
  useEffect(() => {
    const answer = reply ?? failed;
    if (!answer || answered.current === answer) return;
    answered.current = answer;
    // Nothing under that id any more: it ended as the stop was sent.
    if (failed || reply?.cancelled !== true) {
      setRequested(false);
      addNotification({
        level: 'warning',
        title: t('common.runCancelRefused'),
        message: t('common.runCancelRefusedDetail'),
      });
    }
  }, [reply, failed, addNotification, t]);
  const { mutate } = cancel;
  const stop = useCallback(() => {
    if (!requestId) return;
    setRequested(true);
    mutate({ operationId: requestId });
  }, [requestId, mutate]);
  return { requested, stop };
}

/**
 * Cleanup's "Empty objects" and "Empty the org": every record of the objects
 * picked, or of every object people work in less what is left out, deleted
 * to the recycle bin with an Undo, or for good.
 *
 * Never on a production org: not offered when the registry says one, and
 * refused by the extension when the org says one, nothing lifting either.
 * The whole of a sandbox marked Staging is never emptied. Each section reads
 * the org's scope as it opens — what may be picked, what is never touched and
 * why, and whether the user may delete for good, read live — and asks a
 * preview before anything else: the button that empties is in the preview,
 * under all it says, and its confirmation is armed by the org's name and
 * says the act and its size. A run is listed in Live Operations and stopped
 * from here or there; its result offers Undo where Undo is possible, and the
 * org's history says each emptying and undo of the audit trail.
 */
export const EmptyPanel: React.FC<EmptyPanelProps> = ({ orgId, orgName }) => {
  const { t } = useTranslation();
  const objectsHeadingId = useId();
  const orgHeadingId = useId();
  const org = useOrgStore((s) => s.orgs.find((candidate) => candidate.id === orgId));
  const registeredProduction = !isDevelopmentOrg(org);
  const staging = guardTierOf(org) === 'staging';

  const [picked, setPicked] = useState<string[]>([]);
  const [orgAsked, setOrgAsked] = useState<OrgAsked>({
    customSettings: false,
    files: false,
    managedPackages: false,
    excluded: [],
  });
  const [how, setHow] = useState<Record<DataOpsEmptyMode, HowAsked>>({
    objects: NO_HOW,
    org: NO_HOW,
  });
  const [asked, setAsked] = useState<PreviewAsked | null>(null);
  const [boxes, setBoxes] = useState<EmptyBoxes>(NO_BOXES);
  const [mute, setMute] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [askedAct, setAskedAct] = useState<AskedAct | null>(null);
  const [actBoxes, setActBoxes] = useState({
    acceptAutomation: false,
    acceptEmails: false,
    mute: false,
  });
  const [shown, setShown] = useState<Shown>(null);

  /** The org's scope: what may be picked, what the whole org empties, what is left out. */
  // A sandbox marked Staging refuses the whole-org scope: what may be picked
  // there is asked as the scope of no object picked yet.
  const scope = useBridgeQuery<DataOpsEmptyScopeResponse['payload']>(
    'dataops:empty:scope',
    staging
      ? { orgId, mode: 'objects', objects: [] }
      : {
          orgId,
          mode: 'org',
          ...(orgAsked.customSettings ? { customSettings: true } : {}),
          ...(orgAsked.files ? { files: true } : {}),
          ...(orgAsked.managedPackages ? { managedPackages: true } : {}),
        },
    {
      responseType: 'dataops:empty:scope:response',
      errorType: 'dataops:error',
      skip: registeredProduction,
      timeoutMs: 120_000,
    },
  );
  const preview = useBridgeMutation<EmptyPreviewAnswer>('dataops:empty:preview', {
    responseType: 'dataops:empty:preview:response',
    errorType: 'dataops:error',
    timeoutMs: PREVIEW_TIMEOUT_MS,
  });
  const run = useBridgeMutation<DataOpsEmptyRunResponse['payload']>('dataops:empty:run', {
    responseType: 'dataops:empty:run:response',
    errorType: 'dataops:error',
    timeoutMs: WRITE_RUN_TIMEOUT_MS,
    runOutlivesWait: true,
  });
  const undo = useBridgeMutation<DataOpsEmptyUndoResponse['payload']>('dataops:empty:undo', {
    responseType: 'dataops:empty:undo:response',
    errorType: 'dataops:error',
    timeoutMs: WRITE_RUN_TIMEOUT_MS,
    runOutlivesWait: true,
  });
  const previewStop = useEmptyStop(preview.loading ? preview.requestId : null);
  const actRequest = shown === 'undo' ? undo : run;
  const actStop = useEmptyStop(actRequest.loading ? actRequest.requestId : null);
  const busy = preview.loading || run.loading || undo.loading;

  const liveProduction =
    scope.errorCode === PRODUCTION ||
    preview.errorCode === PRODUCTION ||
    run.errorCode === PRODUCTION ||
    undo.errorCode === PRODUCTION;
  const hardDelete = scope.data?.hardDelete;

  /** The preview's request, as the options of `mode` make it now. */
  const payloadOf = useCallback(
    (mode: DataOpsEmptyMode, muted: boolean): { key: string; payload: Record<string, unknown> } => {
      const options = how[mode];
      const base = {
        orgId,
        request: requestOf(mode, picked, orgAsked),
        deleteMode: options.hard ? 'hard' : 'recycle',
        ...(options.checkpointFirst ? { checkpointFirst: true } : {}),
      };
      return {
        key: JSON.stringify(base),
        payload: { ...base, ...(muted ? { muteAutomation: true } : {}), fromPage: true },
      };
    },
    [how, orgId, picked, orgAsked],
  );

  const askPreview = (mode: DataOpsEmptyMode, muted: boolean): void => {
    const { key, payload } = payloadOf(mode, muted);
    setAsked({ mode, key, payload });
    setShown(null);
    run.reset();
    undo.reset();
    preview.mutate(payload);
  };
  const startPreview = (mode: DataOpsEmptyMode): void => {
    setBoxes(NO_BOXES);
    setMute(false);
    askPreview(mode, false);
  };
  const changeMute = (checked: boolean): void => {
    if (!asked) return;
    setMute(checked);
    // What still runs, and sends, changes with the mute: the preview is read again.
    askPreview(asked.mode, checked);
  };
  const readAgain = (): void => {
    if (asked) askPreview(asked.mode, mute);
  };

  const answer = preview.data;
  const stale = asked !== null && payloadOf(asked.mode, mute).key !== asked.key;
  const hardAsked = answer?.preview.deleteMode === 'hard';
  // What the preview named as blocking: the run goes, and those deletes are refused.
  const blockedRecords = (answer?.preview.blockers ?? []).reduce(
    (sum, blocker) => sum + (blocker.records.records ?? 0),
    0,
  );

  const confirmEmpty = (): void => {
    setConfirmOpen(false);
    if (!answer || !asked) return;
    setShown('run');
    run.mutate({
      orgId,
      previewId: answer.previewId,
      ...(boxes.acceptNoUndo ? { acceptNoUndo: true } : {}),
      ...(how[asked.mode].checkpointFirst ? { checkpointFirst: true } : {}),
      // Confirmed once the preview listed what fires: what fires is accepted,
      // the emails as their box says, the mute as its box says.
      acceptAutomation: true,
      ...(boxes.acceptEmails ? { acceptEmails: true } : {}),
      ...(mute ? { muteAutomation: true } : {}),
      fromPage: true,
    });
  };

  const openAct = (act: AskedAct['act'], runId: string): void => {
    setActBoxes({ acceptAutomation: false, acceptEmails: false, mute: false });
    setAskedAct({ act, runId });
  };
  const confirmAct = (): void => {
    if (!askedAct) return;
    const accord = {
      ...(actBoxes.acceptAutomation ? { acceptAutomation: true } : {}),
      ...(actBoxes.acceptEmails ? { acceptEmails: true } : {}),
      ...(actBoxes.mute ? { muteAutomation: true } : {}),
      fromPage: true,
    };
    if (askedAct.act === 'undo') {
      setShown('undo');
      undo.mutate({ orgId, runId: askedAct.runId, ...accord });
    } else {
      setShown('run');
      run.mutate({ orgId, resumeRunId: askedAct.runId, ...accord });
    }
    setAskedAct(null);
  };

  const setBox = (box: EmptyBox, checked: boolean): void =>
    setBoxes((current) => ({ ...current, [box]: checked }));
  const setHowOf = (mode: DataOpsEmptyMode, change: Partial<HowAsked>): void =>
    setHow((current) => ({ ...current, [mode]: { ...current[mode], ...change } }));

  // The history is read again whenever an act ends, however it ends.
  const ended = run.data ?? run.error ?? undo.data ?? undo.error;
  const refetchScope = useLatestRef(() => scope.refetch());
  const runEnded = run.data;
  useEffect(() => {
    if (runEnded) refetchScope.current();
  }, [runEnded, refetchScope]);

  const candidates = useMemo(() => scope.data?.candidates ?? [], [scope.data]);
  const blocked = useMemo(
    () => notPickable(scope.data?.leftOut ?? [], candidates),
    [scope.data, candidates],
  );
  const excludedSet = new Set(orgAsked.excluded);
  const orgObjects = (scope.data?.objects ?? []).filter((name) => !excludedSet.has(name));
  const orgLeftOut = (scope.data?.leftOut ?? []).filter(
    (out) => !excludedSet.has(out.objectApiName),
  );

  if (registeredProduction || liveProduction) {
    return (
      <section
        aria-labelledby={objectsHeadingId}
        className="flex flex-col gap-2 rounded-lg border border-status-error p-3 text-xs text-text-primary"
        data-testid="empty-production"
      >
        <h2 id={objectsHeadingId} className="text-sm font-semibold text-text-primary">
          {t('dataopsEmpty.title')}
        </h2>
        <p role="alert" className="text-status-error" data-testid="empty-production-refusal">
          {t('dataopsEmpty.production', { org: orgName })}
        </p>
      </section>
    );
  }

  /** The hard delete box of a section: greyed out, with why, unless the user may. */
  const hardOption = (mode: DataOpsEmptyMode): React.ReactNode => {
    const permitted = hardDelete?.permitted === true;
    const reason = !hardDelete
      ? t('dataopsEmpty.options.hardReading')
      : hardDelete.unread !== undefined
        ? t('dataopsEmpty.options.hardUnread', { reason: hardDelete.unread })
        : !permitted
          ? t('dataopsEmpty.options.hardNotPermitted', { user: org?.username ?? orgName })
          : t('dataopsEmpty.options.hardPermitted');
    const reasonId = `${mode === 'objects' ? objectsHeadingId : orgHeadingId}-hard`;
    return (
      <div className="flex flex-col gap-1">
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={how[mode].hard && permitted}
            disabled={!permitted || busy}
            onChange={(e) => setHowOf(mode, { hard: e.target.checked })}
            aria-describedby={reasonId}
            data-testid={`empty-${mode}-hard`}
          />
          <span>{t('dataopsEmpty.options.hard')}</span>
        </label>
        <p
          id={reasonId}
          className={permitted ? 'ml-5 text-status-warning' : 'ml-5 text-text-secondary'}
          data-testid={`empty-${mode}-hard-why`}
        >
          {reason}
        </p>
      </div>
    );
  };

  const checkpointOption = (mode: DataOpsEmptyMode): React.ReactNode => (
    <CheckpointFirstOption
      checked={how[mode].checkpointFirst}
      onChange={(checked) => setHowOf(mode, { checkpointFirst: checked })}
      orgId={orgId}
      costSaid="preview"
      estimate={
        asked?.mode === mode && answer?.checkpoint && !stale
          ? { of: answer.checkpoint, lead: t('dataopsEmpty.preview.checkpointLead') }
          : null
      }
      foldDetails
      testId={`empty-${mode}-checkpoint`}
    />
  );

  const previewButton = (mode: DataOpsEmptyMode, disabled: boolean): React.ReactNode => (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="primary"
        size="sm"
        onClick={() => startPreview(mode)}
        loading={preview.loading && asked?.mode === mode}
        disabled={disabled || busy}
        data-testid={`empty-${mode}-preview`}
      >
        {t('dataopsEmpty.previewButton')}
      </Button>
      {preview.loading && asked?.mode === mode && (
        <>
          <span role="status" className="text-text-secondary" data-testid="empty-preview-reading">
            {t('dataopsEmpty.preview.reading', { org: orgName })}
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={previewStop.stop}
            disabled={previewStop.requested}
            data-testid="empty-preview-stop"
          >
            {t('dataopsEmpty.preview.stop')}
          </Button>
        </>
      )}
    </div>
  );

  return (
    <div className="flex flex-col gap-4 text-xs text-text-primary" data-testid="empty-panel">
      {scope.error && (
        <ErrorBanner message={scope.error} code={scope.errorCode} data-testid="empty-scope-error" />
      )}
      {scope.loading && !scope.data && (
        <p role="status" className="text-text-secondary" data-testid="empty-scope-reading">
          {t('dataopsEmpty.scopeReading', { org: orgName })}
        </p>
      )}

      <section
        aria-labelledby={objectsHeadingId}
        className="flex flex-col gap-3 rounded-lg border border-subtle p-3"
        data-testid="empty-objects"
      >
        <h2 id={objectsHeadingId} className="text-sm font-semibold text-text-primary">
          {t('dataopsEmpty.objects.title')}
        </h2>
        <p className="text-text-secondary">{t('dataopsEmpty.objects.intro')}</p>
        {scope.data && (
          <EmptyObjectList
            objects={candidates}
            selected={picked}
            onChange={setPicked}
            legend={t('dataopsEmpty.objects.legend')}
            tickedLine={(count) =>
              t('dataopsEmpty.objects.picked', { count, formatted: formatNumber(count) })
            }
            testIdPrefix="empty-pick"
          />
        )}
        {blocked.length > 0 && (
          <details data-testid="empty-objects-not-pickable">
            <summary className="cursor-pointer">
              {t('dataopsEmpty.objects.notPickable', {
                count: blocked.length,
                formatted: formatNumber(blocked.length),
              })}
            </summary>
            <LeftOutList leftOut={blocked} testId="empty-objects-not-pickable" />
          </details>
        )}
        {hardOption('objects')}
        {checkpointOption('objects')}
        {staging && (
          <p className="text-text-secondary" data-testid="empty-objects-staging">
            {t('dataopsEmpty.objects.staging', { org: orgName })}
          </p>
        )}
        {previewButton('objects', picked.length === 0 || !scope.data)}
      </section>

      <section
        aria-labelledby={orgHeadingId}
        className="flex flex-col gap-3 rounded-lg border border-subtle p-3"
        data-testid="empty-org"
      >
        <h2 id={orgHeadingId} className="text-sm font-semibold text-text-primary">
          {t('dataopsEmpty.org.title')}
        </h2>
        <p className="text-text-secondary">{t('dataopsEmpty.org.intro')}</p>
        {staging ? (
          <p role="note" className="text-status-warning" data-testid="empty-org-staging">
            {t('dataopsEmpty.org.staging', { org: orgName })}
          </p>
        ) : (
          <>
            <fieldset className="flex flex-col gap-1" disabled={busy}>
              <legend className="mb-1 font-medium">{t('dataopsEmpty.org.optIn')}</legend>
              {(Object.keys(OPT_IN_KEYS) as Array<keyof typeof OPT_IN_KEYS>).map((kind) => (
                <label key={kind} className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={orgAsked[kind]}
                    onChange={(e) =>
                      setOrgAsked((current) => ({ ...current, [kind]: e.target.checked }))
                    }
                    data-testid={`empty-org-${kind}`}
                  />
                  <span>{t(OPT_IN_KEYS[kind])}</span>
                </label>
              ))}
            </fieldset>
            {scope.data && (
              <EmptyObjectList
                objects={scope.data.objects}
                selected={orgAsked.excluded}
                onChange={(excluded) => setOrgAsked((current) => ({ ...current, excluded }))}
                legend={t('dataopsEmpty.org.exclude')}
                tickedLine={(count) =>
                  t('dataopsEmpty.org.excluded', { count, formatted: formatNumber(count) })
                }
                testIdPrefix="empty-exclude"
              />
            )}
            {scope.data && (
              <p data-testid="empty-org-objects">
                {t('dataopsEmpty.org.emptied', {
                  count: orgObjects.length,
                  formatted: formatNumber(orgObjects.length),
                })}
              </p>
            )}
            {orgLeftOut.length > 0 && (
              <details data-testid="empty-org-left-out">
                <summary className="cursor-pointer">
                  {t('dataopsEmpty.org.leftOut', {
                    count: orgLeftOut.length,
                    formatted: formatNumber(orgLeftOut.length),
                  })}
                </summary>
                <LeftOutList leftOut={orgLeftOut} testId="empty-org-left-out" />
              </details>
            )}
            {hardOption('org')}
            {checkpointOption('org')}
            {previewButton('org', !scope.data || orgObjects.length === 0)}
          </>
        )}
      </section>

      {preview.error && shown === null && (
        <ErrorBanner
          message={preview.error}
          code={preview.errorCode}
          data-testid="empty-preview-error"
        />
      )}

      {answer && asked && shown === null && (
        <EmptyPreview
          orgId={orgId}
          orgName={orgName}
          answer={answer}
          boxes={boxes}
          onBoxChange={setBox}
          muted={mute}
          onMuteChange={changeMute}
          onReadAgain={readAgain}
          reading={preview.loading}
          stale={stale}
          onEmpty={() => setConfirmOpen(true)}
          onResume={(runId) => openAct('resume', runId)}
          onUndoOpen={(runId) => openAct('undo', runId)}
          busy={run.loading || undo.loading}
        />
      )}

      {shown !== null && (
        <EmptyOutcome
          orgId={orgId}
          orgName={orgName}
          kind={shown}
          state={actRequest}
          run={run.data?.result ?? null}
          undo={undo.data?.result ?? null}
          stopRequested={actStop.requested}
          onStop={actStop.stop}
          onUndo={(runId) => openAct('undo', runId)}
          // An undo asked from the history had no preview here to read again.
          {...(asked ? { onPreviewAgain: readAgain } : {})}
          onDone={() => {
            setShown(null);
            run.reset();
            undo.reset();
            preview.reset();
            setAsked(null);
          }}
        />
      )}

      <EmptyHistory
        orgId={orgId}
        orgName={orgName}
        readAgainOn={ended}
        onUndo={(runId) => openAct('undo', runId)}
        busy={busy}
      />

      {answer && (
        <DangerConfirm
          open={confirmOpen}
          onClose={() => setConfirmOpen(false)}
          onConfirm={confirmEmpty}
          title={t('dataopsEmpty.confirm.title', { org: orgName })}
          description={
            hardAsked
              ? t('dataopsEmpty.confirm.descriptionHard', {
                  records: recordsWords(t, answer.preview.total.records),
                  objects: objectsWords(t, answer.preview.total.objects),
                })
              : t('dataopsEmpty.confirm.description', {
                  records: recordsWords(t, answer.preview.total.records),
                  objects: objectsWords(t, answer.preview.total.objects),
                })
          }
          confirmText={orgName}
          confirmLabel={emptyButtonWords(t, answer)}
        >
          <ul className="ml-4 list-disc" data-testid="empty-confirm-details">
            {hardAsked && (
              <li className="font-medium text-status-error" data-testid="empty-confirm-no-undo">
                {t('dataopsEmpty.confirm.noUndo')}
              </li>
            )}
            {blockedRecords > 0 && (
              <li className="text-status-error" data-testid="empty-confirm-blockers">
                {t('dataopsEmpty.confirm.blockers', { records: recordsWords(t, blockedRecords) })}
              </li>
            )}
            <li>{t('dataopsEmpty.confirm.automation', { org: orgName })}</li>
            {mute && <li data-testid="empty-confirm-muted">{t('dataopsEmpty.confirm.muted')}</li>}
            {asked && how[asked.mode].checkpointFirst && (
              <li data-testid="empty-confirm-checkpoint">{t('dataopsEmpty.confirm.checkpoint')}</li>
            )}
          </ul>
        </DangerConfirm>
      )}

      {askedAct && (
        <DangerConfirm
          open
          onClose={() => setAskedAct(null)}
          onConfirm={confirmAct}
          title={
            askedAct.act === 'undo'
              ? t('dataopsEmpty.undo.title', { org: orgName, runId: askedAct.runId })
              : t('dataopsEmpty.resume.title', { org: orgName, runId: askedAct.runId })
          }
          description={
            askedAct.act === 'undo'
              ? t('dataopsEmpty.undo.description', { org: orgName })
              : t('dataopsEmpty.resume.description', { org: orgName })
          }
          confirmText={orgName}
          confirmLabel={
            askedAct.act === 'undo'
              ? t('dataopsEmpty.undo.button')
              : t('dataopsEmpty.resume.button')
          }
        >
          {/* Never ticked unasked: without it, an org that runs automation as
              the act writes refuses it before it writes, and says what runs. */}
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={actBoxes.acceptAutomation}
              onChange={(e) =>
                setActBoxes((current) => ({ ...current, acceptAutomation: e.target.checked }))
              }
              data-testid="empty-act-accept-automation"
            />
            <span>
              {askedAct.act === 'undo'
                ? t('dataopsEmpty.undo.acceptAutomation', { org: orgName })
                : t('dataopsEmpty.resume.acceptAutomation', { org: orgName })}
            </span>
          </label>
          <label className="mt-2 flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={actBoxes.acceptEmails}
              onChange={(e) =>
                setActBoxes((current) => ({ ...current, acceptEmails: e.target.checked }))
              }
              data-testid="empty-act-accept-emails"
            />
            <span>{t('dataops.automation.acceptEmails', { org: orgName })}</span>
          </label>
          {/* The confirmation reads nothing of the org: what a mute silences
              is read as the act starts, and its result says it. */}
          <AutomationMuteBox
            offer="atStart"
            checked={actBoxes.mute}
            onChange={(checked) => setActBoxes((current) => ({ ...current, mute: checked }))}
            org={orgName}
            testId="empty-act-mute"
            className="mt-2"
          />
        </DangerConfirm>
      )}
    </div>
  );
};
