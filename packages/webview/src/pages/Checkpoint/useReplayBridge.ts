import { useCallback, useMemo, useState } from 'react';
import type {
  BaseMessage,
  FrozenLoadPlanInfo,
  FrozenLoadProgress,
  FrozenLoadReportInfo,
  FrozenReplayInfo,
  FrozenVerifyVerdict,
} from '@sandforge/shared';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { useMessageListener } from '../../hooks/useMessageBus';
import { WRITE_RUN_TIMEOUT_MS } from '../../hooks/writeRunTimeout';
import type { FrozenErrorPayload } from '../Frozen/frozenErrorWords';

/** How long a simulation may read the other org: its describes, users, types, catalogue and gates. */
const PREVIEW_TIMEOUT_MS = 600_000;

/** How long a verification may count what a replay wrote. */
const VERIFY_TIMEOUT_MS = 300_000;

/**
 * A replay's request refused or failed, as the extension answered it: its
 * English, its code, and what it names beside them — a refusal's `params`,
 * the figures of a gate — for the page to say it in its own language.
 */
export type ReplayErrorPayload = FrozenErrorPayload & {
  params?: Record<string, unknown>;
};

/** What a replay's simulation answered. */
export interface ReplayPreviewAnswer {
  plan: FrozenLoadPlanInfo;
  replay?: FrozenReplayInfo;
}

/** What a replay answered once it ended. */
export interface ReplayLoadAnswer {
  report: FrozenLoadReportInfo;
  replay?: FrozenReplayInfo;
}

/** One request of a replay, its answer, and the error payload correlated to it. */
export interface ReplayRequestState<T> {
  run: (payload: Record<string, unknown>) => void;
  data: T | null;
  loading: boolean;
  /** The host's words of a failure, a timeout's included. */
  error: string | null;
  /** What the extension sent with its error, when it was the extension's. */
  errorPayload: ReplayErrorPayload | null;
  requestId: string | null;
  reset: () => void;
}

/**
 * A request of the Frozen load a replay goes through, listening on its own
 * error channel: its error payload is kept whole, correlated to the request,
 * so the page words a refusal by its code and what it names — a payload taken
 * by type alone would let another panel's error stand for this one's.
 */
function useReplayRequest<T>(
  requestType: string,
  options: {
    responseType?: string;
    errorType: string;
    timeoutMs: number;
    runOutlivesWait?: boolean;
  },
): ReplayRequestState<T> {
  const mutation = useBridgeMutation<T>(requestType, options);
  const [errorPayload, setErrorPayload] = useState<{
    requestId: string;
    payload: ReplayErrorPayload;
  } | null>(null);
  useMessageListener(options.errorType, (message: BaseMessage) => {
    if (mutation.requestId === null || message.correlationId !== mutation.requestId) return;
    const payload = (message as BaseMessage & { payload?: ReplayErrorPayload }).payload;
    if (payload) setErrorPayload({ requestId: mutation.requestId, payload });
  });
  const { mutate, reset: resetMutation } = mutation;
  const run = useCallback(
    (payload: Record<string, unknown>) => {
      setErrorPayload(null);
      mutate(payload);
    },
    [mutate],
  );
  const reset = useCallback(() => {
    setErrorPayload(null);
    resetMutation();
  }, [resetMutation]);
  return useMemo(
    () => ({
      run,
      data: mutation.data,
      loading: mutation.loading,
      error: mutation.error,
      errorPayload:
        mutation.error !== null && errorPayload?.requestId === mutation.requestId
          ? errorPayload.payload
          : null,
      requestId: mutation.requestId,
      reset,
    }),
    [run, reset, mutation.data, mutation.loading, mutation.error, mutation.requestId, errorPayload],
  );
}

/** The bridge of a replay, as the page drives it. */
export interface ReplayBridge {
  /** `frozen:load:preview` with the replay: what it would do, nothing written. */
  preview: ReplayRequestState<ReplayPreviewAnswer>;
  /** `frozen:load` with the replay: run under the id of its request, with Stop. */
  load: ReplayRequestState<ReplayLoadAnswer>;
  /** `frozen:verify` with the replay: what the last replay into the org wrote, counted. */
  verify: ReplayRequestState<{ verdict: FrozenVerifyVerdict }>;
  /** The last progress the replay under way said, by its phase. */
  progress: FrozenLoadProgress | null;
  /**
   * The verdict of the verification the replay's load chained after it, or of
   * the one Verify asked: the last one answered.
   */
  verdict: FrozenVerifyVerdict | null;
}

/**
 * The Frozen load's requests a replay of a checkpoint goes through — its
 * simulation, its run, its verification —, the progress its run reports
 * under the id of its request, and the verdict the run chains after it. Each
 * is told apart by the id of the request that started it: every panel hears
 * every push message.
 */
export function useReplayBridge(): ReplayBridge {
  const preview = useReplayRequest<ReplayPreviewAnswer>('frozen:load:preview', {
    errorType: 'frozen:load:preview:error',
    timeoutMs: PREVIEW_TIMEOUT_MS,
  });
  // A replay goes on in the extension until it ends, and answers then.
  const load = useReplayRequest<ReplayLoadAnswer>('frozen:load', {
    errorType: 'frozen:load:error',
    timeoutMs: WRITE_RUN_TIMEOUT_MS,
    runOutlivesWait: true,
  });
  const verify = useReplayRequest<{ verdict: FrozenVerifyVerdict }>('frozen:verify', {
    responseType: 'frozen:verify:result',
    errorType: 'frozen:verify:error',
    timeoutMs: VERIFY_TIMEOUT_MS,
  });
  const [progress, setProgress] = useState<{
    requestId: string;
    progress: FrozenLoadProgress;
  } | null>(null);
  const [chained, setChained] = useState<{
    requestId: string;
    verdict: FrozenVerifyVerdict;
  } | null>(null);
  useMessageListener('frozen:load:progress', (message: BaseMessage) => {
    if (load.requestId === null || message.correlationId !== load.requestId) return;
    const payload = (message as BaseMessage & { payload?: FrozenLoadProgress }).payload;
    if (payload) setProgress({ requestId: load.requestId, progress: payload });
  });
  // The verification a replay's load chains after it answers under the
  // load's id, once the load has answered.
  useMessageListener('frozen:verify:result', (message: BaseMessage) => {
    if (load.requestId === null || message.correlationId !== load.requestId) return;
    const verdict = (message as BaseMessage & { payload?: { verdict?: FrozenVerifyVerdict } })
      .payload?.verdict;
    if (verdict) setChained({ requestId: load.requestId, verdict });
  });
  const ownProgress = progress?.requestId === load.requestId ? progress.progress : null;
  const ownChained = chained?.requestId === load.requestId ? chained.verdict : null;
  return {
    preview,
    load,
    verify,
    progress: ownProgress,
    verdict: verify.data?.verdict ?? ownChained,
  };
}
