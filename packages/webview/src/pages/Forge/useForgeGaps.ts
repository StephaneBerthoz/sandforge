import { useCallback, useMemo, useRef, useState } from 'react';
import type {
  BaseMessage,
  ForgeConfig,
  ForgeGapsResponse,
  ForgeGraph,
  ForgeTargetGaps,
} from '@sandforge/shared';
import { sendBridgeMessage } from '../../bridge/sendBridgeMessage';
import { useMessageListener } from '../../hooks/useMessageBus';
import { useForgeStore } from '../../stores/useForgeStore';

/** What a read of the target's gaps came to, its gaps aside: those are in the store. */
export interface ForgeGapsReadSummary {
  /** The gaps read. */
  count: number;
  /** Those that refuse rows. */
  blocking: number;
  /** Validation rules whose formula the bound left unread. */
  formulasNotRead: number;
  /** What the target would not give, with its reason. */
  unread: ForgeTargetGaps['unread'];
  /** The requests the read sent to the target. */
  requests: number;
}

/** Review's read of what the target's metadata holds against the rows. */
export interface ForgeGapsRead {
  /** A read is under way. */
  pending: boolean;
  /** What the last read came to; null before it answered. */
  read: ForgeGapsReadSummary | null;
  /** Why the read could not run at all, from `forge:gaps:error`. */
  error: string | null;
  /** Ask the extension for the gaps of a run of `graph` under `config`. */
  request: (config: ForgeConfig, graph: ForgeGraph) => void;
}

/**
 * The read of the target's gaps from its metadata — its validation and
 * duplicate rules, the fields only it requires, its lookup filters, its API
 * budget — asked as Review opens, with the automation, and kept in the store
 * as the metadata's gaps (`setGaps('metadata', …)`), apart from what a
 * simulation or a rehearsal finds.
 *
 * Only the answer to the last request counts: one that comes back for an
 * earlier config — Review left and opened again for another run — would put
 * that run's gaps on this one.
 */
export function useForgeGaps(): ForgeGapsRead {
  const setGaps = useForgeStore((s) => s.setGaps);
  const asked = useRef<string | null>(null);
  const [pending, setPending] = useState(false);
  const [read, setRead] = useState<ForgeGapsReadSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const request = useCallback((config: ForgeConfig, graph: ForgeGraph) => {
    asked.current = sendBridgeMessage<{ graph: ForgeGraph; config: ForgeConfig }>(
      'forge:gaps:request',
      { graph, config },
    );
    setPending(true);
    setError(null);
  }, []);

  useMessageListener<ForgeGapsResponse>(
    'forge:gaps:response',
    useCallback(
      (msg) => {
        if (asked.current === null || msg.correlationId !== asked.current) return;
        const { gaps, unread, requests } = msg.payload.gaps;
        // What it could not read goes with it: the Gaps tab tells a read that
        // found nothing from one that could not look.
        setGaps('metadata', gaps, unread);
        setRead({
          count: gaps.length,
          blocking: gaps.filter((gap) => gap.severity === 'blocking').length,
          formulasNotRead: gaps.filter((gap) => gap.detail?.formula === 'notRead').length,
          unread,
          requests,
        });
        setPending(false);
      },
      [setGaps],
    ),
  );

  useMessageListener<BaseMessage & { payload: { message: string } }>(
    'forge:gaps:error',
    useCallback((msg) => {
      if (asked.current === null || msg.correlationId !== asked.current) return;
      setError(msg.payload.message);
      setPending(false);
    }, []),
  );

  return useMemo(() => ({ pending, read, error, request }), [pending, read, error, request]);
}
