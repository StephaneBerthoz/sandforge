import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ScenarioPack,
  SeedExecutionResult,
  SeedScenarioPreparation,
  SeedScenarioPrepareResponse,
  SeedScenarioSaveResponse,
} from '@sandforge/shared';
import { isDevelopmentOrg } from '@sandforge/shared';
import { useBridgeMutation } from '../../../hooks/useBridgeMutation';
import { useOperationProgress } from '../../../hooks/useOperationProgress';
import { useSendMessage } from '../../../hooks/useMessageBus';
import { WRITE_RUN_TIMEOUT_MS } from '../../../hooks/writeRunTimeout';
import { buildMessage } from '../../../bridge/messageHelpers';
import { useOrgStore } from '../../../stores/useOrgStore';
import type { ObjectProgress } from '../Step7_Execute';
import { samePack, type ScenarioPicked, type ScenarioSource } from './scenarioPacks';

/**
 * Where a scenario is: its review — read, edited, saved —, the confirmation
 * of the org it is written to, its run, then its results.
 */
export type ScenarioPhase = 'review' | 'confirm' | 'executing' | 'results';

/** What saving the pack under review answered. */
export type ScenarioSaveOutcome = SeedScenarioSaveResponse['payload']['outcome'];

/** State and actions of a scenario's seed. */
export interface ScenarioSeedState {
  phase: ScenarioPhase;
  /** The pack as it now reads, edits included. */
  pack: ScenarioPack;
  source: ScenarioSource;
  /**
   * Why the pack cannot go on to its seed as it reads: one drafted or edited
   * is saved in the workspace first, since its test file is written from it
   * after the run, and the run's companion file keeps only its fingerprint.
   */
  mustSave: boolean;
  /** Take an edit of the pack: its review goes on with it, unsaved. */
  edit: (pack: ScenarioPack) => void;
  save: (overwrite?: boolean) => void;
  saving: boolean;
  saved: ScenarioSaveOutcome | null;
  /** On to the confirmation; nothing is read of an org before an org is chosen. */
  toConfirm: () => void;
  backToReview: () => void;
  orgId: string;
  selectOrg: (orgId: string) => void;
  seed: number;
  setSeed: (seed: number) => void;
  /** The article field the body goes to; undefined for the first the org offers. */
  bodyField: string | undefined;
  setBodyField: (field: string | undefined) => void;
  /** The pack compiled for the org chosen, once read. */
  preparation: SeedScenarioPreparation | null;
  /** Why the pack cannot be compiled for it. */
  issues: string[];
  preparing: boolean;
  /** Start the seed, compiled with what the preparation answered. */
  execute: () => void;
  isRunning: boolean;
  /** The run's id once it reported progress, which is when it can be stopped. */
  operationId: string | null;
  cancel: () => void;
  objectProgress: ObjectProgress[];
  overallPercent: number;
  elapsedMs: number;
  result: SeedExecutionResult | undefined;
  error: string | null;
  setError: (error: string | null) => void;
}

/**
 * A scenario pack from its review to its results: nothing is written to an
 * org before the review, the confirmation of what the run writes — read of
 * the org chosen, with its own case statuses — and Start. The run is a
 * seed's run, held to its gates on the extension's side, and stopped as one.
 */
export function useScenarioSeed(picked: ScenarioPicked): ScenarioSeedState {
  const [phase, setPhase] = useState<ScenarioPhase>('review');
  const [pack, setPack] = useState<ScenarioPack>(picked.pack);
  const [source, setSource] = useState<ScenarioSource>(picked.source);
  /** The pack as its source holds it: an edit since is unsaved. */
  const [kept, setKept] = useState<ScenarioPack | null>(
    picked.source.kind === 'draft' ? null : picked.pack,
  );
  const [saved, setSaved] = useState<ScenarioSaveOutcome | null>(null);
  // The org selected in the panel, when it is one a seed may be aimed at
  // without being asked for: connected, and no production org.
  const [orgId, setOrgId] = useState(() => {
    const { orgs, selectedOrgId } = useOrgStore.getState();
    const panelOrg = orgs.find((org) => org.id === selectedOrgId);
    return panelOrg && panelOrg.status === 'connected' && isDevelopmentOrg(panelOrg)
      ? panelOrg.id
      : '';
  });
  const [seed, setSeed] = useState(1);
  const [bodyField, setBodyField] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  const mustSave = kept === null || !samePack(kept, pack);

  const saveMutation = useBridgeMutation<SeedScenarioSaveResponse['payload']>('seed:scenario:save');
  const { mutate: saveMutate, data: saveAnswer } = saveMutation;
  /** The pack a save was asked for: what is kept once it is saved, not an edit made since. */
  const askedToSave = useRef<ScenarioPack | null>(null);
  const save = useCallback(
    (overwrite = false) => {
      setSaved(null);
      askedToSave.current = pack;
      saveMutate({ pack, ...(overwrite ? { overwrite: true } : {}) });
    },
    [pack, saveMutate],
  );
  useEffect(() => {
    const outcome = saveAnswer?.outcome;
    if (!outcome) return;
    setSaved(outcome);
    const asked = askedToSave.current;
    if (outcome.kind === 'saved' && asked) {
      setKept(asked);
      setSource({ kind: 'workspace', path: outcome.path, relativePath: outcome.relativePath });
    }
  }, [saveAnswer]);

  const edit = useCallback((next: ScenarioPack) => {
    setPack(next);
    setSaved(null);
  }, []);

  const prepareMutation =
    useBridgeMutation<SeedScenarioPrepareResponse['payload']>('seed:scenario:prepare');
  const { mutate: prepare, reset: resetPrepare } = prepareMutation;
  // Read again whenever the org, the seed or the body field changes: what
  // the run writes is what was read last, never a figure of another org.
  useEffect(() => {
    if (phase !== 'confirm' || !orgId) return;
    prepare({
      orgId,
      pack,
      seed,
      ...(bodyField !== undefined ? { articleBodyField: bodyField } : {}),
    });
  }, [phase, orgId, pack, seed, bodyField, prepare]);

  const preparation =
    phase === 'confirm' || phase === 'executing' || phase === 'results'
      ? (prepareMutation.data?.preparation ?? null)
      : null;
  const issues = prepareMutation.data?.issues ?? [];

  const executeMutation = useBridgeMutation<SeedExecutionResult>('seed:scenario:execute', {
    responseType: 'seed:execute:response',
    errorType: 'seed:error',
    // A run goes on in the extension until it ends, and answers then.
    timeoutMs: WRITE_RUN_TIMEOUT_MS,
    runOutlivesWait: true,
  });
  const isRunning = executeMutation.loading;

  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!isRunning) return undefined;
    const started = Date.now();
    timer.current = setInterval(() => setElapsedMs(Date.now() - started), 250);
    return () => {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
    };
  }, [isRunning]);

  useEffect(() => {
    if (executeMutation.data) setPhase('results');
  }, [executeMutation.data]);
  useEffect(() => {
    if (executeMutation.error) setError(executeMutation.error);
  }, [executeMutation.error]);
  useEffect(() => {
    if (saveMutation.error) setError(saveMutation.error);
  }, [saveMutation.error]);
  useEffect(() => {
    if (prepareMutation.error) setError(prepareMutation.error);
  }, [prepareMutation.error]);

  const execute = useCallback(() => {
    if (!preparation || !orgId || mustSave) return;
    setError(null);
    setElapsedMs(0);
    setPhase('executing');
    executeMutation.mutate({ orgId, pack, options: preparation.options });
  }, [preparation, orgId, mustSave, pack, executeMutation]);

  const { getProgress } = useOperationProgress();
  const runId = executeMutation.requestId;
  const progress = (isRunning && runId !== null ? getProgress(runId) : undefined) ?? null;
  const operationId = progress ? runId : null;
  const sendMessage = useSendMessage();
  const cancel = useCallback(() => {
    if (!operationId) return;
    sendMessage(buildMessage<{ operationId: string }>('execution:abort', { operationId }));
  }, [operationId, sendMessage]);

  const objectProgress: ObjectProgress[] = useMemo(() => {
    const objects = preparation?.objects ?? [];
    const current = progress
      ? objects.findIndex((o) => progress.currentStep.endsWith(` ${o.objectApiName}`))
      : -1;
    let before = 0;
    return objects.map((object, index): ObjectProgress => {
      const total = object.recordCount;
      let status: ObjectProgress['status'] = isRunning ? 'running' : 'pending';
      let completed = 0;
      if (current !== -1 && progress) {
        if (index < current) {
          status = 'done';
          completed = total;
        } else if (index === current) {
          completed = Math.min(total, Math.max(0, progress.processedRecords - before));
        } else {
          status = 'pending';
        }
      }
      before += total;
      return { objectApiName: object.objectApiName, total, completed, failed: 0, status };
    });
  }, [preparation, progress, isRunning]);

  return {
    phase,
    pack,
    source,
    mustSave,
    edit,
    save,
    saving: saveMutation.loading,
    saved,
    toConfirm: useCallback(() => {
      if (mustSave) return;
      setError(null);
      setPhase('confirm');
    }, [mustSave]),
    backToReview: useCallback(() => {
      resetPrepare();
      setPhase('review');
    }, [resetPrepare]),
    orgId,
    selectOrg: setOrgId,
    seed,
    setSeed,
    bodyField,
    setBodyField,
    preparation,
    issues,
    preparing: prepareMutation.loading,
    execute,
    isRunning,
    operationId,
    cancel,
    objectProgress,
    overallPercent: progress ? progress.percentage : executeMutation.data ? 100 : 0,
    elapsedMs,
    result: executeMutation.data ?? undefined,
    error,
    setError,
  };
}
