import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { AgentDefinition, BaseMessage } from '@sandforge/shared';
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

import { ScenarioTestFile } from './ScenarioTestFile';

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

const AGENT: AgentDefinition = {
  id: '16j000000000001AAA',
  name: 'Retail_Service_Agent',
  label: 'Retail Service Agent',
  topics: [
    {
      name: 'Order_Issues',
      label: 'Orders',
      described: true,
      actions: [{ name: 'Identify_Customer', described: true }],
      unnamedActions: 0,
    },
    { name: 'Off_Topic', described: true, actions: [], unnamedActions: 0 },
  ],
  unnamedTopics: 0,
  variables: [],
};

const TOPICS = [
  { key: 'damaged-parcel', label: 'Damaged parcel' },
  { key: 'refund', label: 'Refund' },
];

const renderSection = (stale = false) =>
  render(
    <ScenarioTestFile
      runId="run-1"
      orgId="org-dev"
      packId="retail-orders"
      topics={TOPICS}
      stale={stale}
    />,
  );

describe('ScenarioTestFile', () => {
  beforeEach(() => mockPostMessage.mockClear());

  it('says an org without an agent has no test file yet, and offers no file to write', () => {
    renderSection();
    expect(sent('seed:scenario:agents')[0]?.payload).toEqual({ orgId: 'org-dev' });
    answer('seed:scenario:agents', 'seed:scenario:agents:response', {
      orgId: 'org-dev',
      agents: { kind: 'no-agent', reason: 'none', message: 'none' },
      project: { kind: 'dx', dir: '/ws' },
    });

    expect(screen.getByTestId('scenario-tests-no-agent').textContent).toContain(
      'This org has no Agentforce agent: create one, then write the test file from this run.',
    );
    expect(screen.queryByTestId('btn-scenario-tests-write')).toBeNull();
  });

  it('writes nothing until each topic of the scenario is matched to one of the agent’s, and says so', () => {
    renderSection();
    answer('seed:scenario:agents', 'seed:scenario:agents:response', {
      orgId: 'org-dev',
      agents: { kind: 'agents', agents: [AGENT] },
      project: { kind: 'dx', dir: '/ws' },
    });

    const write = screen.getByTestId('btn-scenario-tests-write') as HTMLButtonElement;
    expect(write.disabled).toBe(true);
    expect(
      screen.getByText('Match each topic of the scenario to a topic of the agent.'),
    ).toBeTruthy();

    fireEvent.change(screen.getByTestId('scenario-tests-map-damaged-parcel'), {
      target: { value: 'Order_Issues' },
    });
    expect(write.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('scenario-tests-map-refund'), {
      target: { value: 'Order_Issues' },
    });
    expect(write.disabled).toBe(false);
  });

  it('sends the choice made — topics, actions, the guard topic proposed — and shows the commands to run', () => {
    renderSection();
    answer('seed:scenario:agents', 'seed:scenario:agents:response', {
      orgId: 'org-dev',
      agents: { kind: 'agents', agents: [AGENT] },
      project: { kind: 'dx', dir: '/ws' },
    });
    for (const topic of TOPICS) {
      fireEvent.change(screen.getByTestId(`scenario-tests-map-${topic.key}`), {
        target: { value: 'Order_Issues' },
      });
    }
    fireEvent.click(screen.getByTestId('scenario-tests-action-refund-Identify_Customer'));

    fireEvent.click(screen.getByTestId('btn-scenario-tests-write'));

    expect(sent('seed:scenario:test-file')[0]?.payload).toEqual({
      runId: 'run-1',
      choice: {
        agent: 'Retail_Service_Agent',
        runner: 'testing-center',
        topics: [
          { packTopic: 'damaged-parcel', agentTopic: 'Order_Issues', actions: [] },
          { packTopic: 'refund', agentTopic: 'Order_Issues', actions: ['Identify_Customer'] },
        ],
        guardTopic: 'Off_Topic',
      },
    });
    answer('seed:scenario:test-file', 'seed:scenario:test-file:response', {
      runId: 'run-1',
      outcome: {
        kind: 'written',
        path: '/ws/specs/a.yaml',
        specPath: 'specs/a.yaml',
        apiName: 'A',
        commands: { create: 'sf agent test create --spec specs/a.yaml', run: 'sf agent test run' },
        leftOut: [],
      },
    });
    expect(screen.getByTestId('scenario-tests-create').textContent).toBe(
      'sf agent test create --spec specs/a.yaml',
    );
    expect(screen.getByTestId('scenario-tests-outcome').textContent).toContain(
      'SandForge never deploys the test nor runs it',
    );
  });

  it('writes over a file there only when asked to', () => {
    renderSection();
    answer('seed:scenario:agents', 'seed:scenario:agents:response', {
      orgId: 'org-dev',
      agents: { kind: 'agents', agents: [AGENT] },
      project: { kind: 'folder', dir: '/ws' },
    });
    for (const topic of TOPICS) {
      fireEvent.change(screen.getByTestId(`scenario-tests-map-${topic.key}`), {
        target: { value: 'Order_Issues' },
      });
    }
    fireEvent.click(screen.getByTestId('btn-scenario-tests-write'));
    answer('seed:scenario:test-file', 'seed:scenario:test-file:response', {
      runId: 'run-1',
      outcome: { kind: 'exists', path: '/ws/specs/a.yaml', specPath: 'specs/a.yaml' },
    });

    fireEvent.click(screen.getByTestId('btn-scenario-tests-overwrite'));

    expect(sent('seed:scenario:test-file').pop()?.payload).toMatchObject({ overwrite: true });
    // Outside a DX project the file is written, and the page says the CLI needs one.
    expect(screen.getAllByText(/is not a Salesforce DX project/).length).toBeGreaterThan(0);
  });

  it('says of a removed run that its file names cases that are gone', () => {
    renderSection(true);
    expect(screen.getByTestId('scenario-tests-stale').textContent).toContain(
      'its test file names cases that are gone',
    );
  });
});
