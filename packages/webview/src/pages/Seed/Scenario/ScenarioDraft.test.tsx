import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { BaseMessage, SalesforceOrg } from '@sandforge/shared';
import { RETAIL_ORDERS_PACK } from '@sandforge/shared';
import '../../../i18n';

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

import { ScenarioDraft } from './ScenarioDraft';

function sent(type: string): Array<BaseMessage & { payload: Record<string, unknown> }> {
  return mockPostMessage.mock.calls
    .map(
      (call) =>
        (call[0] as { payload: BaseMessage & { payload: Record<string, unknown> } }).payload,
    )
    .filter((message) => message.type === type);
}

function answer(requestType: string, type: string, payload: unknown): void {
  const request = sent(requestType).pop();
  if (!request) throw new Error(`no '${requestType}' was sent`);
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          id: `resp-${Math.random()}`,
          type,
          timestamp: Date.now(),
          correlationId: request.id,
          payload,
        },
      }),
    );
  });
}

const DEV = {
  id: 'org-dev',
  alias: 'DEV',
  orgType: 'Scratch',
  status: 'connected',
} as unknown as SalesforceOrg;

describe('ScenarioDraft', () => {
  beforeEach(() => mockPostMessage.mockClear());

  it('says what leaves, and shows the text as it will be sent, its address masked', () => {
    render(<ScenarioDraft orgs={[DEV]} onDrafted={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByText(/Never a record\./)).toBeTruthy();
    fireEvent.change(screen.getByTestId('scenario-draft-text'), {
      target: { value: 'Write to jane@gmail.com' },
    });

    fireEvent.click(screen.getByTestId('btn-scenario-draft-preview'));
    answer('ai:scenario-draft', 'ai:scenario-draft:response', {
      success: true,
      sentText: 'Write to jane@gmail.example',
    });

    expect(screen.getByTestId('scenario-draft-masked').textContent).toContain(
      'Write to jane@gmail.example',
    );
  });

  it('tells the draft the Case picklists and the agent of the org picked', () => {
    render(<ScenarioDraft orgs={[DEV]} onDrafted={vi.fn()} onBack={vi.fn()} />);
    fireEvent.change(screen.getByTestId('scenario-draft-text'), { target: { value: 'A shop' } });
    fireEvent.change(screen.getByTestId('scenario-draft-org'), { target: { value: 'org-dev' } });
    answer('seed:scenario:agents', 'seed:scenario:agents:response', {
      orgId: 'org-dev',
      agents: {
        kind: 'agents',
        agents: [
          {
            id: '16j000000000001AAA',
            name: 'Retail_Service_Agent',
            topics: [{ name: 'Order_Issues', described: true, actions: [], unnamedActions: 0 }],
            unnamedTopics: 0,
            variables: [{ name: 'CaseId' }],
          },
        ],
      },
      project: { kind: 'none' },
      casePicklists: { Status: ['New', 'Closed'] },
    });
    fireEvent.change(screen.getByTestId('scenario-draft-agent'), {
      target: { value: 'Retail_Service_Agent' },
    });

    fireEvent.click(screen.getByTestId('btn-scenario-draft-start'));

    // Its topics' names, never its ids or its variables.
    expect(sent('ai:scenario-draft').pop()?.payload).toEqual({
      text: 'A shop',
      language: 'en_US',
      casePicklists: { Status: ['New', 'Closed'] },
      agent: { topics: [{ name: 'Order_Issues', actions: [] }] },
    });
  });

  it('shows which topics a stopped draft wrote, and opens the review once the pack is whole', () => {
    const onDrafted = vi.fn();
    render(<ScenarioDraft orgs={[DEV]} onDrafted={onDrafted} onBack={vi.fn()} />);
    fireEvent.change(screen.getByTestId('scenario-draft-text'), { target: { value: 'A shop' } });
    fireEvent.click(screen.getByTestId('btn-scenario-draft-start'));
    fireEvent.click(screen.getByTestId('btn-scenario-draft-stop'));
    expect(sent('ai:tool:cancel')).toHaveLength(1);

    const { topics, ...rest } = RETAIL_ORDERS_PACK;
    answer('ai:scenario-draft', 'ai:scenario-draft:response', {
      success: false,
      code: 'CANCELLED',
      draft: {
        ...rest,
        topics: topics.map((topic, i) =>
          i === 0 ? topic : { key: topic.key, label: topic.label, utterances: topic.utterances },
        ),
      },
    });
    const partial = screen.getByTestId('scenario-draft-partial');
    expect(partial.textContent).toContain(`${topics[0].label}Written`);
    expect(partial.textContent).toContain(`${topics[1].label}Incomplete`);
    expect(onDrafted).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('btn-scenario-draft-resume'));
    answer('ai:scenario-draft', 'ai:scenario-draft:response', {
      success: true,
      pack: RETAIL_ORDERS_PACK,
    });
    expect(onDrafted).toHaveBeenCalledWith(RETAIL_ORDERS_PACK);
  });
});
