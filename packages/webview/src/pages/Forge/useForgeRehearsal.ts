import { useCallback, useMemo, useRef, useState } from 'react';
import type {
  BaseMessage,
  ForgeRehearsal,
  ForgeRehearsalProgress,
  ForgeRehearseProgressMessage,
  ForgeRehearseRequest,
  ForgeRehearseResponse,
} from '@sandforge/shared';
import { sendBridgeMessage } from '../../bridge/sendBridgeMessage';
import { useMessageListener } from '../../hooks/useMessageBus';
import { useForgeStore } from '../../stores/useForgeStore';

/** Where a rehearsal Review asked for stands. */
export type ForgeRehearsalStatus = 'idle' | 'running' | 'done' | 'declined' | 'error';

/** Review's rehearsal of the run it holds. */
export interface ForgeRehearsalState {
  status: ForgeRehearsalStatus;
  /** How far the rehearsal under way has got; null before it said. */
  progress: ForgeRehearsalProgress | null;
  /** The verdicts of the last rehearsal; null before one answered. */
  result: ForgeRehearsal | null;
  /** Why the last rehearsal could not run. */
  error: string | null;
  /** Rehearse the graph and config the store holds, as Execute would run them. */
  rehearse: () => void;
}

/**
 * Review's rehearsal: the run the store holds sent as `forge:rehearse:request`
 * — the graph, the config, the method per category — and its verdicts kept in
 * the store as the rehearsal's gaps (`setGaps('rehearsal', …)`), apart from
 * what the metadata and a simulation found.
 *
 * Only the answers to the last request count: one that comes back for a
 * rehearsal asked before would put that run's verdicts on this one.
 */
export function useForgeRehearsal(): ForgeRehearsalState {
  const setGaps = useForgeStore((s) => s.setGaps);
  const asked = useRef<string | null>(null);
  const [status, setStatus] = useState<ForgeRehearsalStatus>('idle');
  const [progress, setProgress] = useState<ForgeRehearsalProgress | null>(null);
  const [result, setResult] = useState<ForgeRehearsal | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rehearse = useCallback(() => {
    const { graph, config, anonymizationRules } = useForgeStore.getState();
    if (!graph || !config) return;
    asked.current = sendBridgeMessage<ForgeRehearseRequest['payload']>('forge:rehearse:request', {
      graph,
      config,
      anonymizationRules,
    });
    setStatus('running');
    setProgress(null);
    setError(null);
  }, []);

  useMessageListener<ForgeRehearseProgressMessage>(
    'forge:rehearse:progress',
    useCallback((msg) => {
      if (asked.current !== null && msg.correlationId === asked.current) setProgress(msg.payload);
    }, []),
  );

  useMessageListener<ForgeRehearseResponse>(
    'forge:rehearse:response',
    useCallback(
      (msg) => {
        if (asked.current === null || msg.correlationId !== asked.current) return;
        setGaps('rehearsal', msg.payload.rehearsal.gaps);
        setResult(msg.payload.rehearsal);
        setStatus('done');
        setProgress(null);
      },
      [setGaps],
    ),
  );

  useMessageListener<BaseMessage & { payload: { message: string; code?: string } }>(
    'forge:rehearse:error',
    useCallback((msg) => {
      if (asked.current === null || msg.correlationId !== asked.current) return;
      // Declined at its question, the rehearsal sent nothing: said as such,
      // never as a failure.
      setStatus(msg.payload.code === 'REHEARSAL_DECLINED' ? 'declined' : 'error');
      setError(msg.payload.message);
      setProgress(null);
    }, []),
  );

  return useMemo(
    () => ({ status, progress, result, error, rehearse }),
    [status, progress, result, error, rehearse],
  );
}
