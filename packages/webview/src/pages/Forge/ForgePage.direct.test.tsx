import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent, within } from '@testing-library/react';
import type { BaseMessage, ForgeGraph, ForgeGraphNode } from '@sandforge/shared';
import '../../i18n';
import { useForgeStore } from '../../stores/useForgeStore';
import { FORGE_GRAPH_MAX_OBJECTS, useForgeViewStore } from '../../stores/useForgeViewStore';
import { ForgePage } from './ForgePage';

/*
 * Clone directly, from the start of the flow to the run: the page with the
 * real store, the input screen, the discovery and the execution.
 */

const mockPostMessage = vi.fn();
const stableApi = {
  postMessage: (...args: unknown[]) => mockPostMessage(...args),
  getState: () => undefined,
  setState: () => undefined,
};
vi.mock('../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => stableApi,
  getVscodeApi: () => stableApi,
}));

vi.mock('../../stores/useOrgStore', () => ({
  useOrgStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      orgs: [
        {
          id: 'org-source',
          alias: 'Source',
          username: 'source@example.test',
          instanceUrl: 'https://source.example.test',
          status: 'connected',
          orgType: 'Sandbox',
          safetyTier: 'low',
        },
        {
          id: 'org-target',
          alias: 'Target',
          username: 'target@example.test',
          instanceUrl: 'https://target.example.test',
          status: 'connected',
          orgType: 'Sandbox',
          safetyTier: 'low',
        },
      ],
      selectedOrgId: 'org-source',
    }),
}));

vi.mock('../../stores/useAppStore', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ navigate: vi.fn(), currentRoute: 'forge', aiAvailable: false }),
}));

vi.mock('../../components/graph/LiveGraph', () => ({
  LiveGraph: () => <div data-testid="live-graph" />,
}));

function node(objectApiName: string, level: number): ForgeGraphNode {
  return {
    objectApiName,
    recordCount: 3,
    fieldCount: 20,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 15,
    estimatedSizeMB: 0,
    estimatedApiCalls: 1,
    batchStrategy: 'auto',
  };
}

/** An account and more related objects than auto draws as a graph. */
const WIDE_GRAPH: ForgeGraph = {
  nodes: [
    node('Account', 0),
    ...Array.from({ length: FORGE_GRAPH_MAX_OBJECTS + 4 }, (_, i) =>
      node(`Related${String(i)}__c`, 1),
    ),
  ],
  edges: [],
  totalRecords: 90,
  estimatedSizeMB: 0.1,
  estimatedDurationSeconds: 30,
};

/** The messages of `type` the page posted. */
function posted(type: string): Array<BaseMessage & { payload?: unknown }> {
  return mockPostMessage.mock.calls
    .map(([envelope]) => (envelope as { payload: BaseMessage & { payload?: unknown } }).payload)
    .filter((message) => message.type === type);
}

/** The extension posting `type`, answering `correlationId` when it names one. */
function host(type: string, payload: Record<string, unknown>, correlationId?: string): void {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { id: `host-${type}`, type, timestamp: Date.now(), correlationId, payload },
      }),
    );
  });
}

beforeEach(() => {
  mockPostMessage.mockClear();
  useForgeStore.getState().reset();
  useForgeViewStore.setState({ setting: 'auto', choice: null });
});

/** The Forge page, a record and a target set, and Clone directly clicked: its discovery under way. */
async function cloneDirectly(): Promise<{ unmount: () => void; discovery: string }> {
  const { unmount } = render(<ForgePage />);
  fireEvent.change(screen.getByTestId('forge-input-record'), {
    target: { value: '001000000000001AAA' },
  });
  fireEvent.click(screen.getByTestId('forge-target-org'));
  fireEvent.click(screen.getByTestId('forge-target-org-option-org-target'));

  fireEvent.click(screen.getByTestId('forge-clone-directly-btn'));

  await screen.findByTestId('forge-discovery-loading');
  const [discover] = posted('forge:discover');
  return { unmount, discovery: discover.id };
}

describe('ForgePage — Clone directly', () => {
  it('goes from the start to the run, with no stop on the graph or on Review', async () => {
    const { discovery } = await cloneDirectly();
    expect(screen.getByTestId('forge-discovery-direct')).toBeDefined();
    expect(posted('forge:discover')).toHaveLength(1);

    host('forge:discover:response', { graph: WIDE_GRAPH }, discovery);

    const execution = await screen.findByTestId('forge-execution');
    expect(screen.queryByTestId('forge-review')).toBeNull();
    expect(screen.queryByTestId('forge-discovery')).toBeNull();
    expect(within(execution).getByTestId('forge-execution-review-skipped')).toBeDefined();
    const [execute] = posted('forge:execute');
    expect(posted('forge:execute')).toHaveLength(1);
    expect((execute.payload as { graph: ForgeGraph }).graph.nodes).toHaveLength(
      WIDE_GRAPH.nodes.length,
    );

    // More objects than auto draws: the run is listed, and each event is followed.
    expect(within(execution).getByTestId('forge-execution-table')).toBeDefined();
    expect(within(execution).queryByTestId('live-graph')).toBeNull();
    host('forge:progress', { objectName: 'Account', status: 'done', progress: 100 }, execute.id);
    expect(screen.getByTestId('forge-execution-status-Account').textContent).toBe('Done');
  });

  it('starts the run while the page is away, and the page comes back on it', async () => {
    const { unmount, discovery } = await cloneDirectly();
    // The palette or a shortcut takes the panel to another page.
    unmount();

    host('forge:discover:response', { graph: WIDE_GRAPH }, discovery);

    // Started with no screen open, as Review would have sent it.
    const [execute] = posted('forge:execute');
    expect(posted('forge:execute')).toHaveLength(1);
    expect(execute.payload).toEqual({
      graph: WIDE_GRAPH,
      config: useForgeStore.getState().config,
      anonymizationRules: useForgeStore.getState().anonymizationRules,
      reviewSkipped: true,
    });
    host('forge:progress', { objectName: 'Account', status: 'done', progress: 100 }, execute.id);

    render(<ForgePage />);

    const execution = await screen.findByTestId('forge-execution');
    expect(within(execution).getByTestId('forge-execution-review-skipped')).toBeDefined();
    expect(screen.getByTestId('forge-execution-status-Account').textContent).toBe('Done');
  });

  it('comes back on the error of a discovery that failed while the page was away', async () => {
    const { unmount, discovery } = await cloneDirectly();
    unmount();

    host('forge:discover:error', { message: 'INVALID_SESSION_ID: session expired' }, discovery);

    render(<ForgePage />);

    const empty = await screen.findByTestId('forge-discovery-empty');
    expect(empty.textContent).toContain('INVALID_SESSION_ID');
    expect(screen.queryByTestId('forge-discovery-loading')).toBeNull();
    expect(posted('forge:execute')).toEqual([]);
  });
});
