import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AIForgePlanResponse, ForgePlanProblem } from '@sandforge/shared';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';

/** How long a draft or a check may take before the tab gives up on its answer. */
const DRAFT_TIMEOUT_MS = 120_000;

/** What the check found about one query, against one org. */
export interface ForgeAIVerdict {
  /** The query the verdict is about, trimmed. */
  soql: string;
  /** The org it was checked against. */
  orgId: string;
  /** Nothing was found wrong. */
  success: boolean;
  /** The object after FROM, as the org names it. */
  rootObject?: string;
  /** Its label. */
  rootLabel?: string;
  /** Distinct fields and relationships compared against the describe. */
  fieldsChecked: number;
  /** What was found wrong. */
  problems: ForgePlanProblem[];
  /** The model's own account of the draft, when it wrote one. */
  explanation?: string;
}

/** State and actions of the AI tab. */
export interface ForgeAIPlanState {
  /** The description typed for the model. */
  prompt: string;
  setPrompt: (value: string) => void;
  /** The query discovery would start from: the model's draft, as the user edited it. */
  draft: string;
  setDraft: (value: string) => void;
  /** The last verdict, whichever query and org it was about. */
  verdict: ForgeAIVerdict | null;
  /** The query in the field passed the check against the source org picked now. */
  checked: boolean;
  /** A verdict exists but is about another query or another org than now. */
  stale: boolean;
  /** A draft or a check is waiting for the extension's answer. */
  busy: boolean;
  /** Why nothing could be drafted or checked, or null. */
  error: string | null;
  /** The extension answered that no AI provider is set up. */
  notConfigured: boolean;
  /** Ask the model for a query from the prompt. */
  requestDraft: () => void;
  /** Check the query as it now reads, without asking the model. */
  recheck: () => void;
}

/**
 * The AI tab's state: a description goes to the model through the extension,
 * the query it drafts comes back checked against the source org, and it waits
 * in an editable field. Nothing is discovered from here — the form's Discover
 * button does that, and only for a query whose check passed.
 *
 * @param sourceOrgId - The org the query is to be read from, and checked against.
 */
export function useForgeAIPlan(sourceOrgId: string): ForgeAIPlanState {
  const [prompt, setPrompt] = useState('');
  const [draft, setDraft] = useState('');
  const [verdict, setVerdict] = useState<ForgeAIVerdict | null>(null);
  // A draft is a catalogue read, up to five describes, a model call, one more
  // describe and the org's query plan, one after the other: on a cold cache
  // that outlasts the default 30 s, and the tab would call a draft still on
  // its way a failure.
  const mutation = useBridgeMutation<AIForgePlanResponse['payload']>('ai:forge-plan', {
    timeoutMs: DRAFT_TIMEOUT_MS,
  });
  const { mutate } = mutation;
  /** What the request in flight asked for, and of which org. */
  const sent = useRef<{ kind: 'draft' | 'check'; orgId: string } | null>(null);

  useEffect(() => {
    const data = mutation.data;
    const request = sent.current;
    if (!data || !request || data.soql === undefined) return;
    sent.current = null;
    if (request.kind === 'draft') setDraft(data.soql);
    setVerdict({
      soql: data.soql.trim(),
      orgId: request.orgId,
      success: data.success,
      rootObject: data.rootObject,
      rootLabel: data.rootLabel,
      fieldsChecked: data.fieldsChecked ?? 0,
      problems: data.problems ?? [],
      explanation: data.explanation,
    });
  }, [mutation.data]);

  const requestDraft = useCallback(() => {
    const description = prompt.trim();
    if (!description || !sourceOrgId) return;
    sent.current = { kind: 'draft', orgId: sourceOrgId };
    setVerdict(null);
    mutate({ orgId: sourceOrgId, prompt: description });
  }, [prompt, sourceOrgId, mutate]);

  const recheck = useCallback(() => {
    const query = draft.trim();
    if (!query || !sourceOrgId) return;
    sent.current = { kind: 'check', orgId: sourceOrgId };
    mutate({ orgId: sourceOrgId, soql: query });
  }, [draft, sourceOrgId, mutate]);

  const current = draft.trim();
  const about = verdict !== null && verdict.soql === current && verdict.orgId === sourceOrgId;
  const answer = mutation.data;
  const failure =
    mutation.error ?? (answer && answer.soql === undefined ? (answer.error ?? null) : null);

  return useMemo(
    () => ({
      prompt,
      setPrompt,
      draft,
      setDraft,
      verdict,
      checked: about && verdict !== null && verdict.success,
      stale: verdict !== null && !about,
      busy: mutation.loading,
      error: failure,
      notConfigured: answer?.code === 'AI_NOT_CONFIGURED',
      requestDraft,
      recheck,
    }),
    [prompt, draft, verdict, about, mutation.loading, failure, answer, requestDraft, recheck],
  );
}
