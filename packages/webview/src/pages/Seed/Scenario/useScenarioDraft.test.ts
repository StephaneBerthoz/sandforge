import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { BaseMessage, ScenarioPackDraft } from '@sandforge/shared';
import { RETAIL_ORDERS_PACK } from '@sandforge/shared';

const mockPostMessage = vi.fn();
const stableApi = {
  postMessage: (...args: unknown[]) => mockPostMessage(...args),
  getState: () => undefined,
  setState: () => undefined,
};
vi.mock('../../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => stableApi,
  getVscodeApi: () => stableApi,
}));

import { useScenarioDraft } from './useScenarioDraft';

function sent(type: string): Array<BaseMessage & { payload: Record<string, unknown> }> {
  return mockPostMessage.mock.calls
    .map(
      (call) =>
        (call[0] as { payload: BaseMessage & { payload: Record<string, unknown> } }).payload,
    )
    .filter((message) => message.type === type);
}

function answer(payload: unknown, request = sent('ai:scenario-draft').pop()): void {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          id: `resp-${Math.random()}`,
          type: 'ai:scenario-draft:response',
          timestamp: Date.now(),
          correlationId: request?.id,
          payload,
        },
      }),
    );
  });
}

/** A draft stopped after its first topic: the plan whole, one topic written. */
function stoppedDraft(): ScenarioPackDraft {
  const { topics, ...rest } = RETAIL_ORDERS_PACK;
  return {
    ...rest,
    topics: topics.map((topic, index) =>
      index === 0 ? topic : { key: topic.key, label: topic.label, utterances: topic.utterances },
    ),
  };
}

describe('useScenarioDraft', () => {
  beforeEach(() => mockPostMessage.mockClear());

  it('asks for the text as it will leave without reaching a model', () => {
    const { result } = renderHook(() => useScenarioDraft());
    act(() => result.current.preview('Mail me at jane@gmail.com'));

    expect(sent('ai:scenario-draft')[0]?.payload).toEqual({
      text: 'Mail me at jane@gmail.com',
      language: 'en_US',
      maskOnly: true,
    });
    answer({ success: true, sentText: 'Mail me at jane@acme.example' });
    expect(result.current.sentText).toBe('Mail me at jane@acme.example');
  });

  it('stops the call in flight and keeps the topics written before, to go on from them', () => {
    const { result } = renderHook(() => useScenarioDraft());
    act(() => result.current.draft({ text: 'An online shop', language: 'en_US' }));
    const request = sent('ai:scenario-draft')[0];
    expect(result.current.busy).toBe(true);

    act(() => result.current.stop());
    expect(sent('ai:tool:cancel')[0]?.payload).toEqual({ requestId: request.id });
    // Still waiting: the answer to the stop carries what was written.
    expect(result.current.busy).toBe(true);
    answer(
      { success: false, code: 'CANCELLED', sentText: 'An online shop', draft: stoppedDraft() },
      request,
    );

    expect(result.current.stopped).toBe(true);
    expect(result.current.pack).toBeNull();
    expect(result.current.partial?.topics[1]).not.toHaveProperty('article');

    act(() => result.current.draft({ text: 'An online shop', language: 'en_US', resume: true }));
    expect(sent('ai:scenario-draft').pop()?.payload.draft).toEqual(stoppedDraft());
  });

  it('gives the pack once every call answered, and says a failure in its own words with the fields', () => {
    const { result } = renderHook(() => useScenarioDraft());
    act(() => result.current.draft({ text: 'An online shop', language: 'en_US' }));
    answer({
      success: false,
      error: 'The AI reply is JSON, but not in the expected format',
      issues: ['topics[2].article.facts[0]: too long'],
      failedAt: { call: 'topic', topicKey: 'refund' },
    });
    expect(result.current.failure).toEqual({
      error: 'The AI reply is JSON, but not in the expected format',
      issues: ['topics[2].article.facts[0]: too long'],
    });

    act(() => result.current.draft({ text: 'An online shop', language: 'en_US' }));
    answer({ success: true, sentText: 'An online shop', pack: RETAIL_ORDERS_PACK });
    expect(result.current.pack).toEqual(RETAIL_ORDERS_PACK);
    expect(result.current.failure).toBeNull();
  });

  it('says when no provider is set up', () => {
    const { result } = renderHook(() => useScenarioDraft());
    act(() => result.current.draft({ text: 'An online shop', language: 'en_US' }));
    answer({ success: false, code: 'AI_NOT_CONFIGURED', error: 'AI is not configured' });

    expect(result.current.notConfigured).toBe(true);
    expect(result.current.failure).toBeNull();
  });
});
