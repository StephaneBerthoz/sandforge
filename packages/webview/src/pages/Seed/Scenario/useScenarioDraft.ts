import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AIScenarioDraftResponse,
  ScenarioCasePicklists,
  ScenarioDraftAgent,
  ScenarioPack,
  ScenarioPackDraft,
} from '@sandforge/shared';
import { buildMessage } from '../../../bridge/messageHelpers';
import { useBridgeMutation } from '../../../hooks/useBridgeMutation';
import { useSendMessage } from '../../../hooks/useMessageBus';

/**
 * How long a draft may take: a plan, then a call for each topic, up to nine
 * calls to the provider, each up to its 8,192 tokens of reply.
 */
const DRAFT_TIMEOUT_MS = 15 * 60 * 1000;

/** What a draft answered: the pack, or how far it went and why it stopped. */
export type ScenarioDraftAnswer = AIScenarioDraftResponse['payload'];

/** State and actions of a scenario's draft. */
export interface ScenarioDraftState {
  /** Ask for the text as it would be sent, its addresses and numbers masked; no model is called. */
  preview: (text: string) => void;
  /** The text as it was, or would be, sent. */
  sentText: string | null;
  /** Draft a pack from the text, or go on with the draft that stopped. */
  draft: (input: {
    text: string;
    language: string;
    casePicklists?: ScenarioCasePicklists;
    agent?: ScenarioDraftAgent;
    resume?: boolean;
  }) => void;
  busy: boolean;
  /**
   * Stop the call in flight: the extension aborts it and answers with the
   * topics written before, which are kept for the draft to go on with.
   */
  stop: () => void;
  /** The pack, once every call answered and it holds together. */
  pack: ScenarioPack | null;
  /** What was written before the draft stopped or failed: no pack, and never compiled. */
  partial: ScenarioPackDraft | null;
  /** Set when the last draft was stopped by the user. */
  stopped: boolean;
  /** Why the last draft failed, in the provider's words or naming the fields a reply broke. */
  failure: { error: string; issues: string[] } | null;
  /** The extension has no AI provider set up. */
  notConfigured: boolean;
  /** The request could not be sent or answered at all. */
  error: string | null;
}

/**
 * A scenario pack drafted by the AI provider from the user's own text: first
 * the text as it leaves — its addresses and numbers rewritten to reach
 * nobody —, then a plan and a call per topic, which Stop interrupts. What was
 * written before a stop or a failure is kept, never as a pack: the draft goes
 * on from it, and nothing is compiled or written to an org from it.
 */
export function useScenarioDraft(): ScenarioDraftState {
  const mutation = useBridgeMutation<ScenarioDraftAnswer>('ai:scenario-draft', {
    timeoutMs: DRAFT_TIMEOUT_MS,
  });
  const masking = useBridgeMutation<ScenarioDraftAnswer>('ai:scenario-draft');
  const { mutate, data, loading, requestId } = mutation;
  const send = useSendMessage();
  const sendRef = useRef(send);
  sendRef.current = send;
  const [partial, setPartial] = useState<ScenarioPackDraft | null>(null);
  const [stopped, setStopped] = useState(false);

  useEffect(() => {
    if (!data) return;
    setStopped(data.code === 'CANCELLED');
    setPartial(data.success ? null : (data.draft ?? null));
  }, [data]);

  const preview = useCallback(
    (text: string) => masking.mutate({ text, language: 'en_US', maskOnly: true }),
    [masking],
  );

  const draft = useCallback<ScenarioDraftState['draft']>(
    (input) => {
      setStopped(false);
      mutate({
        text: input.text,
        language: input.language,
        ...(input.casePicklists ? { casePicklists: input.casePicklists } : {}),
        ...(input.agent ? { agent: input.agent } : {}),
        ...(input.resume && partial ? { draft: partial } : {}),
      });
    },
    [mutate, partial],
  );

  // The answer to a stop carries the topics written before it: the request
  // stays open for it, where a Forge draft's Stop drops what comes after.
  const stop = useCallback(() => {
    if (!loading || requestId === null) return;
    sendRef.current(buildMessage<{ requestId: string }>('ai:tool:cancel', { requestId }));
  }, [loading, requestId]);

  const failed =
    data && !data.success && data.code !== 'CANCELLED' && data.code !== 'AI_NOT_CONFIGURED';

  return {
    preview,
    sentText: data?.sentText ?? masking.data?.sentText ?? null,
    draft,
    busy: loading,
    stop,
    pack: data?.success && data.pack ? data.pack : null,
    partial,
    stopped,
    failure: failed ? { error: data.error ?? '', issues: data.issues ?? [] } : null,
    notConfigured: data?.code === 'AI_NOT_CONFIGURED',
    error: mutation.error ?? masking.error,
  };
}
