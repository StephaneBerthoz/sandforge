import React, { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Eye, Play, ShieldCheck, Square } from 'lucide-react';
import { orgDisplayName } from '@sandforge/shared';
import type {
  CheckpointListEntry,
  CheckpointReplayChoices,
  FrozenLoadPlanInfo,
  FrozenLoadReportInfo,
  FrozenReplayInfo,
  FrozenReplayRef,
  OrgCheckpoint,
  SalesforceOrg,
} from '@sandforge/shared';
import { useOrgStore } from '../../stores/useOrgStore';
import { Button } from '../../components/ui/Button';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { OrgDropdown } from '../../components/ui/OrgDropdown';
import { ProgressBar } from '../../components/ui/ProgressBar';
import { AutomationMuteBox } from '../../components/ui/AutomationMuteBox';
import { CheckpointFirstOption } from '../../components/ui/CheckpointFirstOption';
import { DangerConfirm } from '../../components/ui/DangerConfirm';
import { useOperationCancel } from '../../hooks/useOperationCancel';
import {
  formatDate,
  formatNumber,
  formatRelativeTime,
  formatStoredDate,
} from '../../utils/formatters';
import { FrozenLoadAutomation } from '../Frozen/FrozenLoadAutomation';
import { FrozenLoadEmails } from '../Frozen/FrozenLoadEmails';
import { FrozenLoadRemoval } from '../Frozen/FrozenLoadRemoval';
import { frozenErrorWords } from '../Frozen/frozenErrorWords';
import { recordsHeld } from './checkpointFacts';
import { CheckpointsLink } from './CheckpointsLink';
import {
  defaultReplayChoices,
  plannedRecords,
  refusedBesideWords,
  replayAskKey,
  replayChoicesSent,
  replayInto,
  replayLines,
  replayObjectsOf,
  replaySourceDataOf,
  replayTargetsOf,
  type ReplayLine,
} from './replayFacts';
import { ReplayOwners } from './ReplayOwners';
import { useReplayBridge, type ReplayErrorPayload } from './useReplayBridge';

/** How a replay ended, in words, by the status of its load's report. */
const RESULT_STATUS_KEYS: Readonly<Record<FrozenLoadReportInfo['status'], string>> = {
  completed: 'checkpoint.replay.result.completed',
  'completed-with-errors': 'checkpoint.replay.result.completedWithErrors',
  partial: 'checkpoint.replay.result.partial',
};

/** What a verification of a replay found, in words, by its verdict. */
const VERDICT_KEYS: Readonly<Record<'passed' | 'partial' | 'failed' | 'unstable', string>> = {
  passed: 'checkpoint.replay.verdict.passed',
  partial: 'checkpoint.replay.verdict.partial',
  failed: 'checkpoint.replay.verdict.failed',
  unstable: 'checkpoint.replay.verdict.unstable',
};

/** Props for {@link ReplayCheckpoint}. */
export interface ReplayCheckpointProps {
  /** The org the page lists the checkpoint under: its own, or the sandbox it became once refreshed. */
  org: SalesforceOrg;
  /** The checkpoint, as the list read it, with its replays. */
  entry: CheckpointListEntry & { checkpoint: OrgCheckpoint };
  onClose: () => void;
  /** Read the list again: a replay or a removal changed what it says of the replays. */
  onChanged: () => void;
  /** Open what a rewind of the page's org to the checkpoint would do: offered while it still rewinds it. */
  onRewind?: () => void;
}

/** What a simulation answered, with what it was asked: a replay goes after the same. */
interface Simulated {
  key: string;
  targetOrgId: string;
  plan: FrozenLoadPlanInfo;
  replay?: FrozenReplayInfo;
}

/**
 * Replay a checkpoint in another org: its records are created there again,
 * parents before children, with new Ids, from this machine's file alone — the
 * checkpoint's own org is never asked, and may be gone: a sandbox refreshed,
 * a scratch org expired. Nothing the other org holds is changed or deleted. A
 * checkpoint keeps no file's content, so files do not follow, each named.
 *
 * The org: a sandbox, a scratch org or a Developer Edition org that is
 * connected, never a production org; the sandbox the checkpoint was of, once
 * refreshed, first. A sandbox marked Staging, which may hold real data, is
 * offered with its badge, and its replay asks its name typed once simulated,
 * which goes with the replay for the extension to compare. The checkpoint's
 * own org while it still rewinds it is listed and not offered: Rewind brings
 * it back to that moment.
 *
 * The choices — objects, owners, custom settings, masking, emails and phone
 * numbers, replacing the last replay — are simulated first: Replay waits for
 * a simulation of the same choices, and any change asks for another. The
 * simulation says what the replay does and does not, line by line; a
 * refusal says what lifts it. Masking is ticked for a checkpoint of a sandbox
 * that may hold real data, and the extension refuses it unticked; for a
 * sandbox's checkpoint that does not say, the person may untick it and
 * declare it holds none, which the audit trail keeps.
 *
 * The replay runs as a Frozen load does, under the id of its request, with
 * Stop; its gates — what the org runs, its emails, Checkpoint first — are the
 * load's, said of a replay. Its result, its verification and its removal
 * follow, and the replays of the checkpoint are listed, each org's once.
 */
export const ReplayCheckpoint: React.FC<ReplayCheckpointProps> = ({
  org,
  entry,
  onClose,
  onChanged,
  onRewind,
}) => {
  const { t } = useTranslation();
  const orgs = useOrgStore((s) => s.orgs);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const ids = { heading: useId(), objects: useId(), replayHint: useId(), targetLabel: useId() };
  const { checkpoint } = entry;
  const pageOrgName = orgDisplayName(org);
  const targets = replayTargetsOf(orgs, org, entry);
  const [targetOrgId, setTargetOrgId] = useState<string>(targets.refreshed?.id ?? '');
  const [choices, setChoices] = useState<CheckpointReplayChoices>(() =>
    defaultReplayChoices(checkpoint),
  );
  const [replace, setReplace] = useState(false);
  const [muteAutomation, setMuteAutomation] = useState(false);
  const [acceptEmails, setAcceptEmails] = useState(false);
  const [acceptAutomation, setAcceptAutomation] = useState(false);
  const [checkpointFirst, setCheckpointFirst] = useState(false);
  const [simulated, setSimulated] = useState<Simulated | null>(null);
  const [confirmingReplace, setConfirmingReplace] = useState(false);
  const [confirmingStaging, setConfirmingStaging] = useState(false);
  const bridge = useReplayBridge();
  const { preview, load, verify } = bridge;

  // The heading takes the keyboard as the view opens, as a preview's does.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const target = orgs.find((candidate) => candidate.id === targetOrgId);
  const targetName = target ? orgDisplayName(target) : '';
  const intoStaging = targets.staging.includes(targetOrgId);
  const replayRef: FrozenReplayRef = {
    organizationId: entry.organizationId,
    checkpointId: entry.checkpointId,
  };
  const sent = replayChoicesSent(checkpoint, choices);
  const askKey = replayAskKey(targetOrgId, sent, replace);
  const inPlace = targetOrgId !== '' ? replayInto(entry, targetOrgId) : undefined;
  const replaceOffered = inPlace !== undefined && inPlace.inPlace > 0;
  // Unticked with the org it was ticked for: replacing is of that org's replay.
  useEffect(() => {
    if (!replaceOffered) setReplace(false);
  }, [replaceOffered]);

  // The simulation answered: kept with what it was asked. A new one clears
  // the last answer before it is sent, so an answer is the latest's.
  const previewed = preview.data;
  const askedRef = useRef<{ key: string; targetOrgId: string }>({ key: '', targetOrgId: '' });
  useEffect(() => {
    if (previewed) {
      setSimulated({
        ...askedRef.current,
        plan: previewed.plan,
        ...(previewed.replay ? { replay: previewed.replay } : {}),
      });
    }
  }, [previewed]);
  const current = simulated !== null && simulated.key === askKey ? simulated : null;

  // A replay that ended changed what the list says of the checkpoint's replays.
  const ended = load.data ?? load.error;
  const onChangedRef = useRef(onChanged);
  useEffect(() => {
    onChangedRef.current = onChanged;
  }, [onChanged]);
  useEffect(() => {
    if (ended !== null) onChangedRef.current();
  }, [ended]);

  const { requested: stopRequested, cancel: stop } = useOperationCancel(load.requestId, {
    title: t('checkpoint.replay.stopRefused'),
    message: t('checkpoint.replay.stopRefusedDetail'),
  });

  const aliasOf = (orgId: string): string =>
    orgDisplayName(
      orgs.find((candidate) => candidate.id === orgId),
      orgId,
    );
  const wordsOf = (payload: ReplayErrorPayload | null, fallback: string | null): string =>
    (payload?.code === 'REPLAY_STAGING_UNCONFIRMED'
      ? t('checkpoint.replay.stagingUnconfirmed', { target: targetName })
      : undefined) ??
    (payload ? frozenErrorWords(payload, t, aliasOf, 'replay') : undefined) ??
    fallback ??
    '';
  // What else the simulation found the replay would be refused for, beside
  // the fields the other org requires: said with them, as the command line does.
  const refusedBeside = refusedBesideWords(preview.errorPayload, t, aliasOf);

  const requestOf = (): Record<string, unknown> => ({
    targetOrgId,
    replay: { ...replayRef, choices: sent },
    ...(replace ? { reload: true } : {}),
    ...(muteAutomation ? { muteAutomation: true } : {}),
    ...(acceptEmails ? { acceptEmails: true } : {}),
    ...(acceptAutomation ? { acceptAutomation: true } : {}),
    ...(checkpointFirst ? { checkpointFirst: {} } : {}),
  });

  const simulate = (): void => {
    load.reset();
    verify.reset();
    askedRef.current = { key: askKey, targetOrgId };
    preview.run(requestOf());
  };

  const replay = (): void => {
    if (!current) return;
    verify.reset();
    // Into a sandbox marked Staging, the name typed goes with the replay:
    // the extension compares it with the org's, and refuses it otherwise.
    const asked = requestOf();
    load.run({
      ...asked,
      ...(intoStaging
        ? { replay: { ...(asked.replay as object), confirmStaging: targetName } }
        : {}),
      maxRecords: plannedRecords(current.plan),
    });
  };
  const askReplay = (): void => {
    if (intoStaging) setConfirmingStaging(true);
    else if (replace) setConfirmingReplace(true);
    else replay();
  };

  const busy = preview.loading || load.loading;
  const replayHint =
    targetOrgId === ''
      ? t('checkpoint.replay.pickFirst')
      : simulated !== null && current === null
        ? t('checkpoint.replay.changed', { target: targetName })
        : current === null
          ? t('checkpoint.replay.simulateFirst', { target: targetName })
          : null;

  const objects = replayObjectsOf(checkpoint);
  const offeredObjects = objects.filter((object) => !object.fileContent && !object.customSetting);
  const fileObjects = objects.filter((object) => object.fileContent);
  const holdsCustomSettings = objects.some((object) => object.customSetting);
  const excluded = new Set(choices.excluded);
  const setObject = (objectApiName: string, ticked: boolean): void =>
    setChoices((before) => ({
      ...before,
      excluded: ticked
        ? before.excluded.filter((name) => name !== objectApiName)
        : [...before.excluded, objectApiName],
    }));
  const data = replaySourceDataOf(checkpoint.org);
  const takenAge = formatStoredDate(checkpoint.takenAt, (d) => formatRelativeTime(d));
  const refreshedOn =
    targets.refreshed !== undefined && entry.refreshedAt
      ? formatStoredDate(entry.refreshedAt, (d) => formatDate(d))
      : null;

  const resultInfo = load.data?.replay;
  const report = load.data?.report;
  const verdict = bridge.verdict;
  const removalRecords = inPlace?.records;

  const lineList = (lines: readonly ReplayLine[], testId: string): React.ReactNode => (
    <ul className="flex flex-col gap-0.5 text-xs text-text-primary" data-testid={testId}>
      {lines.map((line) => (
        <li key={line.id} data-testid={`${testId}-${line.id}`} className="flex items-start gap-1.5">
          {line.warn && (
            <AlertTriangle
              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-warning"
              aria-hidden="true"
            />
          )}
          <span>{line.text}</span>
        </li>
      ))}
    </ul>
  );

  return (
    <section
      className="flex flex-col gap-3"
      aria-labelledby={ids.heading}
      data-testid="checkpoint-replay"
    >
      <CheckpointsLink onClick={onClose} disabled={load.loading} testId="checkpoint-replay-close" />
      <h2
        id={ids.heading}
        ref={headingRef}
        tabIndex={-1}
        className="text-base font-semibold text-text-primary"
      >
        {t('checkpoint.replay.title', { name: checkpoint.name })}
      </h2>
      <p className="text-xs text-text-secondary" data-testid="checkpoint-replay-facts">
        {t('checkpoint.replay.facts', {
          org: orgDisplayName(checkpoint.org),
          age: takenAge ?? t('common.dateUnknown'),
          records: formatNumber(recordsHeld(checkpoint)),
        })}
      </p>
      <p className="text-sm text-text-primary" data-testid="checkpoint-replay-intro">
        {targetName !== ''
          ? t('checkpoint.replay.intro', { target: targetName })
          : t('checkpoint.replay.introNoTarget')}
      </p>

      <div className="flex flex-col gap-1">
        <span id={ids.targetLabel} className="text-xs font-semibold text-text-primary">
          {t('checkpoint.replay.target.label')}
        </span>
        {targets.offered.length > 0 ? (
          <OrgDropdown
            value={targetOrgId}
            onChange={setTargetOrgId}
            orgs={[...targets.offered, ...(targets.own ? [targets.own] : [])]}
            ariaLabel={t('checkpoint.replay.target.label')}
            testId="checkpoint-replay-target"
            showStaging
            {...(targets.own
              ? {
                  unavailable: {
                    orgId: targets.own.id,
                    note: t('checkpoint.replay.target.ownNote'),
                  },
                }
              : {})}
          />
        ) : (
          <p className="text-xs text-text-primary" data-testid="checkpoint-replay-no-target">
            {t('checkpoint.replay.target.none')}
          </p>
        )}
        {targets.refreshed !== undefined && targetOrgId === targets.refreshed.id && (
          <p className="text-xs text-text-secondary" data-testid="checkpoint-replay-refreshed">
            {refreshedOn !== null
              ? t('checkpoint.replay.target.refreshed', { org: pageOrgName, date: refreshedOn })
              : t('checkpoint.replay.target.refreshedUndated', { org: pageOrgName })}
          </p>
        )}
        {targets.own !== undefined && (
          <p className="text-xs text-text-secondary" data-testid="checkpoint-replay-own">
            {t('checkpoint.replay.target.own', { org: pageOrgName })}
          </p>
        )}
        {intoStaging && (
          <p className="text-xs text-text-primary" data-testid="checkpoint-replay-staging">
            {t('checkpoint.replay.target.stagingPicked', { org: targetName })}
          </p>
        )}
      </div>

      <fieldset
        className="flex flex-col gap-2 rounded-sm border border-subtle bg-surface-1 p-3"
        disabled={load.loading}
        data-testid="checkpoint-replay-choices"
      >
        <legend className="px-1 text-sm font-semibold text-text-primary">
          {t('checkpoint.replay.choices')}
        </legend>
        <fieldset className="flex flex-col gap-1" aria-describedby={ids.objects}>
          <legend className="text-xs font-semibold text-text-primary">
            {t('checkpoint.replay.objects.legend')}
          </legend>
          <p id={ids.objects} className="text-xs text-text-secondary">
            {t('checkpoint.replay.objects.hint')}
          </p>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {offeredObjects.map((object) => (
              <label
                key={object.objectApiName}
                className="flex items-center gap-1.5 text-xs text-text-primary"
              >
                <input
                  type="checkbox"
                  checked={!excluded.has(object.objectApiName)}
                  onChange={(event) => setObject(object.objectApiName, event.target.checked)}
                  data-testid={`checkpoint-replay-object-${object.objectApiName}`}
                />
                <span>
                  {t('checkpoint.replay.objects.object', {
                    object: object.objectApiName,
                    records: formatNumber(object.records),
                  })}
                </span>
              </label>
            ))}
          </div>
          {fileObjects.length > 0 && (
            <p className="text-xs text-text-secondary" data-testid="checkpoint-replay-files">
              {t('checkpoint.replay.objects.files', {
                objects: fileObjects
                  .map((object) => `${object.objectApiName} (${formatNumber(object.records)})`)
                  .join(', '),
              })}
            </p>
          )}
        </fieldset>
        <ReplayOwners
          value={choices.owners}
          onChange={(owners) => setChoices((before) => ({ ...before, owners }))}
          target={targetName}
          testId="checkpoint-replay-owners"
        />
        {holdsCustomSettings && (
          <label className="flex items-start gap-2 text-xs text-text-primary">
            <input
              type="checkbox"
              checked={choices.customSettings}
              onChange={(event) =>
                setChoices((before) => ({ ...before, customSettings: event.target.checked }))
              }
              data-testid="checkpoint-replay-custom-settings"
            />
            <span>{t('checkpoint.replay.customSettings')}</span>
          </label>
        )}
        <div className="flex flex-col gap-1">
          <label className="flex items-start gap-2 text-xs text-text-primary">
            <input
              type="checkbox"
              checked={choices.mask}
              onChange={(event) =>
                setChoices((before) => ({ ...before, mask: event.target.checked }))
              }
              data-testid="checkpoint-replay-mask"
            />
            <span>{t('checkpoint.replay.mask.label')}</span>
          </label>
          <p className="text-xs text-text-secondary" data-testid="checkpoint-replay-mask-why">
            {data.kind === 'real' && data.why === 'staging'
              ? t('checkpoint.replay.mask.staging')
              : data.kind === 'real' && data.why === 'storage'
                ? t('checkpoint.replay.mask.storage', { mb: formatNumber(data.mb) })
                : data.kind === 'unknown'
                  ? t('checkpoint.replay.mask.unknown')
                  : t('checkpoint.replay.mask.free')}
          </p>
          {data.kind === 'unknown' && !choices.mask && (
            <label className="flex items-start gap-2 text-xs text-text-primary">
              <input
                type="checkbox"
                checked={choices.noRealData === true}
                onChange={(event) => {
                  const declared = event.target.checked;
                  setChoices((before) => {
                    const next = { ...before };
                    if (declared) next.noRealData = true;
                    else delete next.noRealData;
                    return next;
                  });
                }}
                data-testid="checkpoint-replay-no-real-data"
              />
              <span>{t('checkpoint.replay.mask.noRealData')}</span>
            </label>
          )}
        </div>
        <label className="flex items-start gap-2 text-xs text-text-primary">
          <input
            type="checkbox"
            checked={choices.contactPoints === 'kept'}
            onChange={(event) =>
              setChoices((before) => ({
                ...before,
                contactPoints: event.target.checked ? 'kept' : 'neutralized',
              }))
            }
            data-testid="checkpoint-replay-keep-contact-points"
          />
          <span>{t('checkpoint.replay.keepContactPoints')}</span>
        </label>
        {replaceOffered && (
          <label className="flex items-start gap-2 text-xs text-text-primary">
            <input
              type="checkbox"
              checked={replace}
              onChange={(event) => setReplace(event.target.checked)}
              data-testid="checkpoint-replay-replace"
            />
            <span>
              {t('checkpoint.replay.replace', {
                target: targetName,
                records: formatNumber(inPlace?.inPlace ?? 0),
              })}
            </span>
          </label>
        )}
      </fieldset>

      {targetOrgId !== '' && (
        <div className="flex flex-col gap-2" data-testid="checkpoint-replay-gates">
          <AutomationMuteBox
            offer="atStart"
            orgId={targetOrgId}
            checked={muteAutomation}
            onChange={setMuteAutomation}
            org={targetName}
            testId="checkpoint-replay-mute"
          />
          {/* Never ticked unasked: unticked, an org that delivers what fires
              refuses the replay before it writes, and the simulation says so. */}
          <label className="flex items-start gap-2 text-xs text-text-primary">
            <input
              type="checkbox"
              checked={acceptEmails}
              onChange={(event) => setAcceptEmails(event.target.checked)}
              data-testid="checkpoint-replay-accept-emails"
            />
            <span>{t('checkpoint.replay.acceptEmails', { target: targetName })}</span>
          </label>
          <label className="flex items-start gap-2 text-xs text-text-primary">
            <input
              type="checkbox"
              checked={acceptAutomation}
              onChange={(event) => setAcceptAutomation(event.target.checked)}
              data-testid="checkpoint-replay-accept-automation"
            />
            <span>{t('checkpoint.replay.acceptAutomation', { target: targetName })}</span>
          </label>
          <CheckpointFirstOption
            checked={checkpointFirst}
            onChange={setCheckpointFirst}
            orgId={targetOrgId}
            costSaid="preview"
            {...(current?.plan.checkpoint
              ? { estimate: { of: current.plan.checkpoint, lead: t('checkpoint.replay.costLead') } }
              : {})}
            testId="checkpoint-replay-checkpoint-first"
          />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          icon={<Eye className="h-3 w-3" />}
          onClick={simulate}
          loading={preview.loading}
          disabled={targetOrgId === '' || busy}
          focusableWhenDisabled
          data-testid="checkpoint-replay-simulate"
        >
          {t('checkpoint.replay.simulate')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          icon={<Play className="h-3 w-3" />}
          onClick={askReplay}
          loading={load.loading}
          disabled={current === null || busy}
          focusableWhenDisabled
          aria-describedby={replayHint !== null ? ids.replayHint : undefined}
          data-testid="checkpoint-replay-run"
        >
          {t('checkpoint.replay.run')}
        </Button>
        {load.loading && load.requestId !== null && (
          <Button
            variant="danger"
            size="sm"
            icon={<Square className="h-3 w-3" />}
            onClick={stop}
            disabled={stopRequested}
            focusableWhenDisabled
            data-testid="checkpoint-replay-stop"
          >
            {t('common.stopRun')}
          </Button>
        )}
      </div>
      {replayHint !== null && (
        <p
          id={ids.replayHint}
          className="text-xs text-text-secondary"
          data-testid="checkpoint-replay-hint"
        >
          {replayHint}
        </p>
      )}

      {preview.error !== null && (
        <div className="flex flex-col items-start gap-2">
          <ErrorBanner
            message={wordsOf(preview.errorPayload, preview.error)}
            code={preview.errorPayload?.code ?? null}
            data-testid="checkpoint-replay-refused"
          />
          {refusedBeside.length > 0 && (
            <div
              className="flex flex-col gap-1 text-xs text-text-secondary"
              data-testid="checkpoint-replay-refused-beside"
            >
              <p>{t('frozen.replay.refusal.alsoRefused')}</p>
              <ul className="list-disc pl-5">
                {refusedBeside.map((words) => (
                  <li key={words} data-testid="checkpoint-replay-refused-beside-item">
                    {words}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {preview.errorPayload?.code === 'REPLAY_SAME_ORG' && onRewind && (
            <Button
              variant="secondary"
              size="sm"
              onClick={onRewind}
              data-testid="checkpoint-replay-rewind-instead"
            >
              {t('checkpoint.list.rewind')}
            </Button>
          )}
        </div>
      )}

      {current && !load.loading && load.data === null && (
        <section
          className="flex flex-col gap-2 rounded-sm border border-subtle bg-surface-1 p-3"
          aria-label={t('checkpoint.replay.plan.title', { target: targetName })}
          data-testid="checkpoint-replay-plan"
        >
          <h3 className="text-sm font-semibold text-text-primary">
            {t('checkpoint.replay.plan.title', { target: targetName })}
          </h3>
          <ObjectsTable plan={current.plan} />
          {current.plan.earlierLoads > 0 && !replace && (
            <p
              className="flex items-start gap-1.5 text-xs text-text-primary"
              data-testid="checkpoint-replay-plan-earlier"
            >
              <AlertTriangle
                className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-warning"
                aria-hidden="true"
              />
              <span>{t('checkpoint.replay.plan.earlier', { target: targetName })}</span>
            </p>
          )}
          {current.replay &&
            lineList(replayLines(current.replay, targetName, t), 'checkpoint-replay-plan-line')}
          {current.plan.automation && (
            <FrozenLoadAutomation
              automation={current.plan.automation}
              org={targetName}
              run="replay"
              testId="checkpoint-replay-plan-automation"
            />
          )}
          {current.plan.emails && (
            <FrozenLoadEmails
              emails={current.plan.emails}
              org={targetName}
              run="replay"
              testId="checkpoint-replay-plan-emails"
            />
          )}
        </section>
      )}

      {load.loading && (
        <div className="flex flex-col gap-1" data-testid="checkpoint-replay-running">
          <p role="status" className="text-xs text-text-primary">
            {stopRequested
              ? t('checkpoint.replay.stopping')
              : bridge.progress?.objectName
                ? t('checkpoint.replay.runningObject', {
                    target: targetName,
                    object: bridge.progress.objectName,
                  })
                : t('checkpoint.replay.running', { target: targetName })}
          </p>
          <ProgressBar
            value={bridge.progress?.progress ?? 0}
            ariaLabel={t('checkpoint.replay.running', { target: targetName })}
            size="sm"
          />
        </div>
      )}

      {load.error !== null && (
        <ErrorBanner
          message={wordsOf(load.errorPayload, load.error)}
          code={load.errorPayload?.code ?? null}
          data-testid="checkpoint-replay-error"
        />
      )}

      {report && (
        <section
          className="flex flex-col gap-2 rounded-sm border border-subtle bg-surface-1 p-3"
          aria-label={t('checkpoint.replay.result.title', { target: targetName })}
          data-testid="checkpoint-replay-result"
        >
          <h3 className="text-sm font-semibold text-text-primary">
            {t('checkpoint.replay.result.title', { target: targetName })}
          </h3>
          <p className="text-xs text-text-primary" data-testid="checkpoint-replay-result-status">
            {t(RESULT_STATUS_KEYS[report.status], { target: targetName })}
          </p>
          <ReportTable report={report} />
          {resultInfo &&
            lineList(replayLines(resultInfo, targetName, t), 'checkpoint-replay-result-line')}
        </section>
      )}

      {(report || removalRecords) && target && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon={<ShieldCheck className="h-3 w-3" />}
              onClick={() => verify.run({ targetOrgId, replay: replayRef })}
              loading={verify.loading}
              disabled={busy || verify.loading}
              focusableWhenDisabled
              data-testid="checkpoint-replay-verify"
            >
              {t('checkpoint.replay.verify')}
            </Button>
            {verdict && (
              <p className="text-xs text-text-primary" data-testid="checkpoint-replay-verdict">
                {t(VERDICT_KEYS[verdict.status], { target: targetName })}
              </p>
            )}
          </div>
          {verify.error !== null && (
            <ErrorBanner
              message={wordsOf(verify.errorPayload, verify.error)}
              code={verify.errorPayload?.code ?? null}
              data-testid="checkpoint-replay-verify-error"
            />
          )}
        </div>
      )}

      {removalRecords && (
        <FrozenLoadRemoval
          records={removalRecords}
          onAnswered={onChanged}
          busy={busy}
          replay={replayRef}
        />
      )}

      {(entry.replays ?? []).length > 0 && (
        <section
          className="flex flex-col gap-1"
          aria-label={t('checkpoint.replay.replays.title')}
          data-testid="checkpoint-replay-replays"
        >
          <h3 className="text-sm font-semibold text-text-primary">
            {t('checkpoint.replay.replays.title')}
          </h3>
          <ul className="flex flex-col gap-1 text-xs text-text-primary">
            {(entry.replays ?? []).map((listed) => {
              const registered = orgs.find((candidate) => candidate.id === listed.target.orgId);
              const name = registered
                ? orgDisplayName(registered)
                : (listed.target.name ?? listed.target.organizationId);
              const date =
                formatStoredDate(listed.replayedAt, (d) => formatDate(d)) ??
                t('common.dateUnknown');
              const offered =
                registered !== undefined &&
                targets.offered.some((candidate) => candidate.id === registered.id);
              return (
                <li
                  key={listed.target.organizationId}
                  className="flex flex-wrap items-center gap-2"
                  data-testid={`checkpoint-replay-replays-${listed.target.organizationId}`}
                >
                  <span>
                    {listed.inPlace > 0
                      ? t('checkpoint.replay.replays.inPlace', {
                          target: name,
                          date,
                          records: formatNumber(listed.inPlace),
                        })
                      : listed.removed
                        ? t('checkpoint.replay.replays.removed', { target: name, date })
                        : t('checkpoint.replay.replays.nothing', { target: name, date })}
                    {registered === undefined
                      ? ` ${t('checkpoint.replay.replays.notConnected')}`
                      : ''}
                  </span>
                  {offered && registered.id !== targetOrgId && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setTargetOrgId(registered.id)}
                      data-testid={`checkpoint-replay-replays-pick-${listed.target.organizationId}`}
                    >
                      {t('checkpoint.replay.replays.pick', { target: name })}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* Typed, as a rewind's is: a sandbox marked Staging may hold real data.
          Asked once the simulation said what the replay creates, and of the
          replacement too when it is ticked. */}
      <DangerConfirm
        open={confirmingStaging}
        onClose={() => setConfirmingStaging(false)}
        onConfirm={() => {
          setConfirmingStaging(false);
          replay();
        }}
        title={t('checkpoint.replay.stagingConfirm.title', {
          name: checkpoint.name,
          target: targetName,
        })}
        description={t('checkpoint.replay.stagingConfirm.description', {
          target: targetName,
          records: formatNumber(current ? plannedRecords(current.plan) : 0),
        })}
        confirmText={targetName}
      >
        {replace && (
          <p data-testid="checkpoint-replay-staging-replace">
            {t('checkpoint.replay.replaceConfirm.description', {
              target: targetName,
              records: formatNumber(
                current?.plan.perObject.reduce((sum, object) => sum + object.toPurge, 0) ?? 0,
              ),
            })}
          </p>
        )}
      </DangerConfirm>

      {/* Typed, as a reload's is: replacing deletes what the last replay created there. */}
      <DangerConfirm
        open={confirmingReplace}
        onClose={() => setConfirmingReplace(false)}
        onConfirm={() => {
          setConfirmingReplace(false);
          replay();
        }}
        title={t('checkpoint.replay.replaceConfirm.title', { target: targetName })}
        description={t('checkpoint.replay.replaceConfirm.description', {
          target: targetName,
          records: formatNumber(
            current?.plan.perObject.reduce((sum, object) => sum + object.toPurge, 0) ?? 0,
          ),
        })}
        confirmText={targetName}
      />
    </section>
  );
};

/** What the replay would create, link, leave out and not send, object by object, as its simulation counts it. */
const ObjectsTable: React.FC<{ plan: FrozenLoadPlanInfo }> = ({ plan }) => {
  const { t } = useTranslation();
  const rows = plan.perObject.filter(
    (object) =>
      object.toInsert + object.reusedByKeys + object.reusedFromCatalog + object.notSent > 0,
  );
  if (rows.length === 0) return null;
  return (
    <div className="overflow-x-auto" data-testid="checkpoint-replay-plan-objects">
      <table className="w-full text-left text-xs text-text-primary">
        <thead>
          <tr>
            <th scope="col" className="py-1 pr-3 font-semibold">
              {t('checkpoint.replay.column.object')}
            </th>
            <th scope="col" className="py-1 pr-3 text-right font-semibold">
              {t('checkpoint.replay.column.toCreate')}
            </th>
            <th scope="col" className="py-1 pr-3 text-right font-semibold">
              {t('checkpoint.replay.column.linked')}
            </th>
            <th scope="col" className="py-1 pr-3 text-right font-semibold">
              {t('checkpoint.replay.column.fieldsDropped')}
            </th>
            <th scope="col" className="py-1 text-right font-semibold">
              {t('checkpoint.replay.column.notSent')}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((object) => (
            <tr
              key={object.objectApiName}
              data-testid={`checkpoint-replay-plan-object-${object.objectApiName}`}
            >
              <td className="py-0.5 pr-3 font-mono">{object.objectApiName}</td>
              <td className="py-0.5 pr-3 text-right">{formatNumber(object.toInsert)}</td>
              <td className="py-0.5 pr-3 text-right">
                {formatNumber(object.reusedByKeys + object.reusedFromCatalog)}
              </td>
              <td className="py-0.5 pr-3 text-right">{formatNumber(object.fieldsDropped)}</td>
              <td className="py-0.5 text-right">{formatNumber(object.notSent)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

/** What the replay created, linked and was refused, object by object, as its load's report counts it. */
const ReportTable: React.FC<{ report: FrozenLoadReportInfo }> = ({ report }) => {
  const { t } = useTranslation();
  if (report.perObject.length === 0) return null;
  return (
    <div className="overflow-x-auto" data-testid="checkpoint-replay-result-objects">
      <table className="w-full text-left text-xs text-text-primary">
        <thead>
          <tr>
            <th scope="col" className="py-1 pr-3 font-semibold">
              {t('checkpoint.replay.column.object')}
            </th>
            <th scope="col" className="py-1 pr-3 text-right font-semibold">
              {t('checkpoint.replay.column.created')}
            </th>
            <th scope="col" className="py-1 pr-3 text-right font-semibold">
              {t('checkpoint.replay.column.linked')}
            </th>
            <th scope="col" className="py-1 text-right font-semibold">
              {t('checkpoint.replay.column.refused')}
            </th>
          </tr>
        </thead>
        <tbody>
          {report.perObject.map((object) => (
            <tr
              key={object.objectApiName}
              data-testid={`checkpoint-replay-result-object-${object.objectApiName}`}
            >
              <td className="py-0.5 pr-3 font-mono">{object.objectApiName}</td>
              <td className="py-0.5 pr-3 text-right">{formatNumber(object.inserted)}</td>
              <td className="py-0.5 pr-3 text-right">{formatNumber(object.reused)}</td>
              <td className="py-0.5 text-right">{formatNumber(object.failed.length)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
