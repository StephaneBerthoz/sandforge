import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { History } from 'lucide-react';
import { isDevelopmentOrg } from '@sandforge/shared';
import type {
  CheckpointDeleteResponse,
  CheckpointKeepResponse,
  CheckpointListResponse,
  CheckpointRenameResponse,
  CheckpointRewindResponse,
  CheckpointUndoResponse,
  OrgCheckpoint,
  RewindDiff,
  SalesforceOrg,
} from '@sandforge/shared';
import { useOrgStore, selectSelectedOrg } from '../../stores/useOrgStore';
import { useAppStore } from '../../stores/useAppStore';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { useLatestRef } from '../../hooks/useLatestRef';
import { WRITE_RUN_TIMEOUT_MS } from '../../hooks/writeRunTimeout';
import { sendBridgeMessage } from '../../bridge/sendBridgeMessage';
import { PageHeader } from '../../components/ui/PageHeader';
import { EmptyState } from '../../components/ui/EmptyState';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { OrgDropdown } from '../../components/ui/OrgDropdown';
import { Button } from '../../components/ui/Button';
import { DangerConfirm } from '../../components/ui/DangerConfirm';
import { Skeleton } from '../../components/ui/Skeleton';
import { formatNumber } from '../../utils/formatters';
import { CheckpointList } from './CheckpointList';
import { RewindPreview, RewindRun, StopComparingFields, TakeCheckpoint } from './checkpointParts';
import { usableCheckpoints } from './checkpointFacts';
import type { RewindAcceptances } from './RewindPreview';
import type { RunShown } from './RewindRun';

/** Where the page opens for the org Home named: a take, or what a rewind to one checkpoint would do. */
type Arrival = { take: true } | { preview: string } | null;

/** A rewind or an undo the page started, with the checkpoint it is of. */
type PageRun = RunShown & { checkpoint: OrgCheckpoint };

/** An undo being confirmed: of which rewind, to which checkpoint, and what it could not bring back, when known. */
interface UndoAsked {
  checkpoint: OrgCheckpoint;
  rewindId: string;
  cannot: ReadonlyArray<{ objectApiName: string; count: number }>;
}

/**
 * The Checkpoints page: the checkpoints of an org kept on this machine, read
 * without contacting the org, Take a checkpoint, and what a rewind to one
 * would do.
 *
 * A checkpoint is the state of an org's data at a moment. It is offered for
 * a sandbox, a scratch org or a Developer Edition only: on a production org
 * the page says so and offers nothing — the extension refuses a take of one
 * whatever the registry says, after reading the org itself.
 */
export const CheckpointPage: React.FC = () => {
  const { t } = useTranslation();
  const orgs = useOrgStore((s) => s.orgs);
  const currentOrg = useOrgStore(selectSelectedOrg);
  const selectOrgLocal = useOrgStore((s) => s.selectOrg);
  const navigate = useAppStore((s) => s.navigate);
  const navigationIntent = useAppStore((s) => s.navigationIntent);
  const clearNavigationIntent = useAppStore((s) => s.clearNavigationIntent);

  // Home's "Take a checkpoint" opens the page on a take of the org it named,
  // and its "Rewind…" on the preview of that org's latest checkpoint, that
  // once: the org picked here afterwards opens on its list.
  const [arrival, setArrival] = useState<Arrival>(() =>
    navigationIntent?.route !== 'checkpoint'
      ? null
      : navigationIntent.takeCheckpoint === true
        ? { take: true }
        : navigationIntent.previewCheckpointId !== undefined
          ? { preview: navigationIntent.previewCheckpointId }
          : null,
  );
  const [arrivedFor] = useState(currentOrg?.id);
  useEffect(() => {
    if (navigationIntent?.route === 'checkpoint') clearNavigationIntent();
  }, [navigationIntent, clearNavigationIntent]);
  const orgId = currentOrg?.id;
  useEffect(() => {
    if (orgId !== arrivedFor) setArrival(null);
  }, [orgId, arrivedFor]);

  // The org picked here is the org picked everywhere: the status bar, the
  // sidebar and the other panels follow it, as they follow Monitor's.
  const selectOrg = useCallback(
    (id: string) => {
      selectOrgLocal(id);
      sendBridgeMessage('org:select', { orgId: id });
    },
    [selectOrgLocal],
  );

  if (orgs.length === 0) {
    return (
      <div className="p-(--sf-space-4)" data-testid="checkpoint-page">
        <EmptyState
          icon={<History className="h-8 w-8" aria-hidden="true" />}
          title={t('checkpoint.noOrgs')}
          description={t('checkpoint.concept')}
          actionLabel={t('emptyState.connectOrg')}
          onAction={() => navigate('orgs')}
        />
      </div>
    );
  }

  const connected = orgs.filter((org) => org.status === 'connected');
  let body: React.ReactNode;
  if (!currentOrg) {
    body = <p className="text-sm text-text-primary">{t('checkpoint.noOrg')}</p>;
  } else if (!isDevelopmentOrg(currentOrg)) {
    body = (
      <p
        className="rounded-sm border border-subtle bg-surface-1 p-3 text-sm text-text-primary"
        data-testid="checkpoint-production"
      >
        {t('checkpoint.production')}
      </p>
    );
  } else {
    // One org's checkpoints at a time, started over for another org: its
    // list, a take under way and their answers are that org's alone.
    body = (
      <OrgCheckpoints
        key={currentOrg.id}
        org={currentOrg}
        arrival={currentOrg.id === arrivedFor ? arrival : null}
      />
    );
  }

  return (
    <div
      className="flex flex-col gap-(--sf-space-4) p-(--sf-space-4)"
      data-testid="checkpoint-page"
    >
      <PageHeader
        title={t('nav.checkpoint')}
        subtitle={t('moduleSummary.checkpoint')}
        icon="history"
        actions={
          connected.length > 0 ? (
            <OrgDropdown
              value={currentOrg?.id ?? ''}
              onChange={selectOrg}
              orgs={connected}
              ariaLabel={t('checkpoint.orgPicker')}
              testId="checkpoint-org"
            />
          ) : undefined
        }
      />
      {body}
    </div>
  );
};

/** Props for {@link OrgCheckpoints}. */
interface OrgCheckpointsProps {
  /** A sandbox, a scratch org or a Developer Edition. */
  org: SalesforceOrg;
  /** Open on a take, or on the preview of a checkpoint, rather than on the list. */
  arrival: Arrival;
}

/**
 * The checkpoints of one org: its list, read from this machine, what can be
 * done to each — rewound to, kept, renamed, its fields compared or not,
 * deleted — a take, and a rewind with what it did, which its Undo takes
 * back.
 *
 * A rewind and an undo are asked here, under the org's name typed to confirm
 * them, and run in the extension under the id of their request: the run
 * shows what it does and how far it is, with Stop, and what it did once
 * through. Either goes on in the extension if the page is left, as Live
 * Operations shows; the list read again says what it did to the checkpoint.
 */
const OrgCheckpoints: React.FC<OrgCheckpointsProps> = ({ org, arrival }) => {
  const { t } = useTranslation();
  const orgName = org.alias || org.username;
  const listHeadingRef = useRef<HTMLHeadingElement>(null);
  const [taking, setTaking] = useState(arrival !== null && 'take' in arrival);
  // The checkpoint whose preview is open, and the one whose Rewind… takes
  // the keyboard back once it is left.
  const [previewing, setPreviewing] = useState<string | null>(
    arrival !== null && 'preview' in arrival ? arrival.preview : null,
  );
  const [leftPreview, setLeftPreview] = useState<string | undefined>(undefined);
  const [run, setRun] = useState<PageRun | null>(null);
  const [undoAsked, setUndoAsked] = useState<UndoAsked | null>(null);
  const [undoAcceptsAutomation, setUndoAcceptsAutomation] = useState(false);
  const [stopComparing, setStopComparing] = useState<OrgCheckpoint | null>(null);

  const listQuery = useBridgeQuery<CheckpointListResponse['payload']>('checkpoint:list', {
    orgId: org.id,
  });
  const deletion = useBridgeMutation<CheckpointDeleteResponse['payload']>('checkpoint:delete');
  const keeping = useBridgeMutation<CheckpointKeepResponse['payload']>('checkpoint:keep');
  const renaming = useBridgeMutation<CheckpointRenameResponse['payload']>('checkpoint:rename');
  // A rewind and an undo go on in the extension until they end, and answer
  // then, a stopped one too: their progress events never reset the wait.
  const rewinding = useBridgeMutation<CheckpointRewindResponse['payload']>('checkpoint:rewind', {
    timeoutMs: WRITE_RUN_TIMEOUT_MS,
    runOutlivesWait: true,
  });
  const undoing = useBridgeMutation<CheckpointUndoResponse['payload']>('checkpoint:undo', {
    timeoutMs: WRITE_RUN_TIMEOUT_MS,
    runOutlivesWait: true,
  });

  // Each change is read back from the store, which is what lists it: a
  // checkpoint deleted, kept or renamed elsewhere meanwhile shows too. A
  // rewind or an undo that ended, or was refused, is read back the same
  // way: it changed the checkpoint's last rewind and what Undo can reach.
  const refetchList = useLatestRef(() => listQuery.refetch());
  useEffect(() => {
    if (deletion.data || keeping.data || renaming.data) refetchList.current();
  }, [deletion.data, keeping.data, renaming.data, refetchList]);
  const rewound = rewinding.data ?? rewinding.error;
  useEffect(() => {
    if (rewound !== null) refetchList.current();
  }, [rewound, refetchList]);
  const undone = undoing.data ?? undoing.error;
  useEffect(() => {
    if (undone !== null) refetchList.current();
  }, [undone, refetchList]);
  // A deleted row takes the focus its Delete held with it: the list's heading
  // takes it, so the keyboard stays in the list.
  const deleted = deletion.data;
  useEffect(() => {
    if (deleted) listHeadingRef.current?.focus();
  }, [deleted]);

  const failed = [deletion, keeping, renaming].find((mutation) => mutation.error !== null);
  const changeError = failed ? (
    <ErrorBanner
      message={failed.error ?? ''}
      code={failed.errorCode}
      onDismiss={failed.reset}
      data-testid="checkpoint-change-error"
    />
  ) : null;

  // Undo is asked for from a rewind's result, or from the list's line of the
  // org's last rewind; it starts unticked every time.
  const askUndo = (asked: UndoAsked): void => {
    setUndoAcceptsAutomation(false);
    setUndoAsked(asked);
  };
  const confirmUndo = (): void => {
    if (!undoAsked) return;
    undoing.mutate({
      checkpointId: undoAsked.checkpoint.checkpointId,
      rewindId: undoAsked.rewindId,
      acceptAutomation: undoAcceptsAutomation,
    });
    setRun({ kind: 'undo', rewindId: undoAsked.rewindId, checkpoint: undoAsked.checkpoint });
    setPreviewing(null);
    setUndoAsked(null);
  };
  const undoConfirm = (
    <DangerConfirm
      open={undoAsked !== null}
      onClose={() => setUndoAsked(null)}
      onConfirm={confirmUndo}
      title={t('checkpoint.undo.title', { org: orgName })}
      description={t('checkpoint.undo.description', { org: orgName })}
      confirmText={orgName}
    >
      {undoAsked && undoAsked.cannot.length > 0 && (
        <ul className="mb-2 ml-4 list-disc" data-testid="checkpoint-undo-cannot">
          {undoAsked.cannot.map((item) => (
            <li key={item.objectApiName}>
              {t('checkpoint.result.undoCannot', {
                count: item.count,
                formatted: formatNumber(item.count),
                object: item.objectApiName,
              })}
            </li>
          ))}
        </ul>
      )}
      {/* Never ticked unasked: without it, an org that runs automation as
          the undo writes refuses it before it writes, and says what runs. */}
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={undoAcceptsAutomation}
          onChange={(event) => setUndoAcceptsAutomation(event.target.checked)}
          data-testid="checkpoint-undo-accept-automation"
        />
        <span>{t('checkpoint.undo.acceptAutomation', { org: orgName })}</span>
      </label>
    </DangerConfirm>
  );

  if (taking) {
    return (
      <TakeCheckpoint
        org={org}
        onClose={() => setTaking(false)}
        onTaken={() => refetchList.current()}
      />
    );
  }
  if (run) {
    const mutation = run.kind === 'rewind' ? rewinding : undoing;
    const leave = (): void => {
      setRun(null);
      rewinding.reset();
      undoing.reset();
    };
    return (
      <>
        <RewindRun
          orgName={orgName}
          checkpoint={run.checkpoint}
          run={run}
          state={{
            loading: mutation.loading,
            requestId: mutation.requestId,
            result: mutation.data?.result ?? null,
            error: mutation.error,
            errorCode: mutation.errorCode,
          }}
          onUndo={(rewindId, cannot) => askUndo({ checkpoint: run.checkpoint, rewindId, cannot })}
          onRewindAgain={() => {
            leave();
            setLeftPreview(undefined);
            setPreviewing(run.checkpoint.checkpointId);
          }}
          onIgnored={() => refetchList.current()}
          onDone={() => {
            leave();
            setLeftPreview(run.checkpoint.checkpointId);
          }}
        />
        {undoConfirm}
      </>
    );
  }
  // A preview opens once the list has said the checkpoint is there and can
  // be rewound to: one Home named that was deleted since leaves the list.
  const previewed =
    previewing !== null && listQuery.data
      ? usableCheckpoints(listQuery.data.checkpoints).find(
          (entry) => entry.checkpointId === previewing,
        )
      : undefined;
  if (previewed) {
    const rewind = (acceptances: RewindAcceptances, diff: RewindDiff): void => {
      rewinding.mutate({ checkpointId: previewed.checkpointId, ...acceptances });
      setRun({ kind: 'rewind', diff, checkpoint: previewed.checkpoint });
      setPreviewing(null);
    };
    return (
      <RewindPreview
        org={org}
        checkpoint={previewed.checkpoint}
        onClose={() => {
          setLeftPreview(previewed.checkpointId);
          setPreviewing(null);
        }}
        onRewind={rewind}
      />
    );
  }
  if (listQuery.data === null && listQuery.error) {
    return (
      <div className="flex flex-col items-start gap-2">
        <ErrorBanner
          message={listQuery.error}
          code={listQuery.errorCode}
          data-testid="checkpoint-list-error"
        />
        <Button
          variant="secondary"
          size="sm"
          onClick={listQuery.refetch}
          data-testid="checkpoint-list-retry"
        >
          {t('common.retry')}
        </Button>
      </div>
    );
  }
  if (listQuery.data === null) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true" data-testid="checkpoint-list-loading">
        <Skeleton variant="rect" height="64px" />
        <Skeleton variant="rect" height="64px" />
      </div>
    );
  }

  const entries = listQuery.data.checkpoints;
  if (entries.length === 0) {
    return (
      <>
        {changeError}
        <EmptyState
          icon={<History className="h-8 w-8" aria-hidden="true" />}
          title={t('checkpoint.empty.title', { org: orgName })}
          description={t('checkpoint.empty.description', { org: orgName })}
          actionLabel={t('checkpoint.take.open')}
          onAction={() => setTaking(true)}
        />
      </>
    );
  }
  return (
    <section
      className="flex flex-col gap-3"
      aria-labelledby="checkpoint-list-heading"
      aria-busy={listQuery.loading || undefined}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2
          id="checkpoint-list-heading"
          ref={listHeadingRef}
          tabIndex={-1}
          className="text-base font-semibold text-text-primary"
        >
          {t('checkpoint.list.title', { org: orgName })}
        </h2>
        <Button
          variant="primary"
          onClick={() => setTaking(true)}
          data-testid="checkpoint-take-open"
        >
          {t('checkpoint.take.open')}
        </Button>
      </div>
      {changeError}
      <CheckpointList
        entries={entries}
        orgName={orgName}
        onRename={(checkpointId, name) => renaming.mutate({ checkpointId, name })}
        onKeep={(checkpointId, keep) => keeping.mutate({ checkpointId, keep })}
        onDelete={(checkpointId) => deletion.mutate({ checkpointIds: [checkpointId] })}
        onRewind={(checkpointId) => {
          setLeftPreview(undefined);
          setPreviewing(checkpointId);
        }}
        onUndo={(entry) => {
          if (entry.undo) {
            askUndo({ checkpoint: entry.checkpoint, rewindId: entry.undo.rewindId, cannot: [] });
          }
        }}
        onStopComparing={setStopComparing}
        focusRewind={leftPreview}
      />
      {undoConfirm}
      {stopComparing && (
        <StopComparingFields
          checkpoint={stopComparing}
          onClose={() => setStopComparing(null)}
          onSaved={() => {
            setStopComparing(null);
            refetchList.current();
          }}
        />
      )}
    </section>
  );
};
