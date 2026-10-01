import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { BaseMessage, ForgeConfig, ForgeGraph } from '@sandforge/shared';
import '../../i18n';
import { ForgeDiscovery } from './ForgeDiscovery';
import { useForgeStore } from '../../stores/useForgeStore';

/**
 * Clone directly: the discovery, then the run of what it found, with no stop
 * on the discovery and Review screens.
 */

/** Every message the panel posted, envelope stripped. */
const mockPostMessage = vi.fn();
vi.mock('../../hooks/useVSCodeApi', () => {
  const api = {
    postMessage: (...args: unknown[]) => mockPostMessage(...args),
    getState: () => undefined,
    setState: () => undefined,
  };
  return { getVscodeApi: () => api, useVSCodeApi: () => api };
});

vi.mock('../../components/graph/LiveGraph', () => ({
  LiveGraph: () => <div data-testid="live-graph" />,
}));

const CONFIG: ForgeConfig = {
  inputMode: 'record',
  recordId: '003000000000001AAA',
  depth: 'direct',
  sourceOrgId: 'org-src',
  targetOrgId: 'org-tgt',
  anonymizePII: true,
  skipEmpty: false,
  batchSize: 'auto',
};

/** A Contact as discovery returns it with anonymization on: every PII field selected. */
const DISCOVERED: ForgeGraph = {
  nodes: [
    {
      objectApiName: 'Contact',
      recordCount: 1,
      fieldCount: 40,
      status: 'idle',
      progress: 0,
      included: true,
      piiFields: ['Email', 'Title', 'Description'],
      anonymizeFields: ['Email', 'Title', 'Description'],
      level: 0,
      successCount: 0,
      failureCount: 0,
      errors: [],
      createableFieldCount: 30,
      estimatedSizeMB: 0,
      estimatedApiCalls: 1,
      batchStrategy: 'auto',
    },
  ],
  edges: [],
  totalRecords: 1,
  estimatedSizeMB: 0,
  estimatedDurationSeconds: 1,
};

/** The messages of `type` the panel posted. */
function posted(type: string): Array<BaseMessage & { payload?: unknown }> {
  return mockPostMessage.mock.calls
    .map(([envelope]) => (envelope as { payload: BaseMessage & { payload?: unknown } }).payload)
    .filter((message) => message.type === type);
}

/** The request of the discovery the Clone directly waits on. */
const DISCOVERY = 'wv-discover-1';

/** The extension answering a discovery, or refusing it: by default, the Clone directly's. */
function extensionSays(
  type: string,
  payload: Record<string, unknown>,
  correlationId: string = DISCOVERY,
): void {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { id: `ext-${type}`, type, timestamp: Date.now(), correlationId, payload },
      }),
    );
  });
}

describe('ForgeDiscovery — Clone directly', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
    const store = useForgeStore.getState();
    store.reset();
    store.setConfig(CONFIG);
    store.awaitDirectRun(DISCOVERY);
    store.setPhase('discovery');
  });

  it('says, while it discovers, that the clone starts as soon as discovery answers', () => {
    render(<ForgeDiscovery />);

    expect(screen.getByTestId('forge-discovery-direct').textContent).toBe(
      'The clone starts as soon as discovery answers.',
    );
  });

  it('starts the run on the answer, sent as Review sends it by default, and draws no graph', () => {
    render(<ForgeDiscovery />);

    extensionSays('forge:discover:response', { graph: DISCOVERED });

    const [execute] = posted('forge:execute');
    const state = useForgeStore.getState();
    expect(execute.payload).toEqual({
      graph: DISCOVERED,
      config: CONFIG,
      anonymizationRules: state.anonymizationRules,
    });
    expect(state.phase).toBe('execution');
    expect(state.executionRequestId).toBe(execute.id);
    expect(state.reviewSkipped).toBe(true);
    expect(state.directDiscoveryId).toBeNull();
    expect(screen.queryByTestId('live-graph')).toBeNull();
    expect(screen.queryByTestId('forge-table-view')).toBeNull();
  });

  it('runs the fields the kept preset names, as Review would have shown them', () => {
    useForgeStore.getState().setAnonymizationPresetId('preset:gdpr-default');
    render(<ForgeDiscovery />);

    extensionSays('forge:discover:response', { graph: DISCOVERED });

    const [execute] = posted('forge:execute');
    const { graph } = execute.payload as { graph: ForgeGraph };
    expect(graph.nodes[0].anonymizeFields).toEqual(['Email']);
  });

  it('takes the answer and the error of its own discovery only', () => {
    render(<ForgeDiscovery />);

    extensionSays('forge:discover:response', { graph: DISCOVERED }, 'wv-discover-other');
    extensionSays('forge:discover:error', { message: 'Not this one' }, 'wv-discover-other');

    expect(posted('forge:execute')).toEqual([]);
    expect(useForgeStore.getState().directDiscoveryId).toBe(DISCOVERY);
    expect(useForgeStore.getState().graph).toBeNull();
    // Still discovering, for the Clone directly: no other discovery's graph or error shown.
    expect(screen.getByTestId('forge-discovery-direct')).toBeDefined();
    expect(screen.queryByText('Not this one')).toBeNull();
  });

  it('stops on a discovery that fails, with its error, and Retry discovers without running', () => {
    render(<ForgeDiscovery />);

    extensionSays('forge:discover:error', { message: 'INVALID_SESSION_ID: session expired' });

    expect(screen.getByTestId('forge-discovery-empty').textContent).toContain('INVALID_SESSION_ID');
    expect(posted('forge:execute')).toEqual([]);
    expect(useForgeStore.getState().directDiscoveryId).toBeNull();

    fireEvent.click(screen.getByTestId('forge-retry-discovery'));
    // Discovering again: the error of the Clone directly went with it.
    expect(screen.getByTestId('forge-discovery-loading')).toBeDefined();
    const [retry] = posted('forge:discover');
    extensionSays('forge:discover:response', { graph: DISCOVERED }, retry.id);

    expect(posted('forge:discover')).toHaveLength(1);
    expect(posted('forge:execute')).toEqual([]);
    expect(screen.getByTestId('forge-discovery')).toBeDefined();
    expect(screen.queryByTestId('forge-discovery-error')).toBeNull();
    expect(useForgeStore.getState().phase).toBe('discovery');
  });

  it('starts no run once it is left with its discovery', () => {
    render(<ForgeDiscovery />);

    fireEvent.click(screen.getByTestId('forge-discovery-cancel'));

    expect(posted('forge:abort')).toHaveLength(1);
    expect(useForgeStore.getState().phase).toBe('input');
    expect(useForgeStore.getState().directDiscoveryId).toBeNull();
  });

  it('shows, as it comes back, the error its discovery ended on while it was away', () => {
    // The screen away as the discovery failed: nothing to show it.
    extensionSays('forge:discover:error', { message: 'INVALID_SESSION_ID: session expired' });

    render(<ForgeDiscovery />);

    expect(screen.queryByTestId('forge-discovery-loading')).toBeNull();
    expect(screen.getByTestId('forge-discovery-empty').textContent).toContain('INVALID_SESSION_ID');
    expect(screen.getByTestId('forge-retry-discovery')).toBeDefined();
  });

  it('leaves a plain discovery on its graph, for Review', () => {
    useForgeStore.getState().awaitDiscovery(DISCOVERY);
    render(<ForgeDiscovery />);

    extensionSays('forge:discover:response', { graph: DISCOVERED });

    expect(posted('forge:execute')).toEqual([]);
    expect(screen.getByTestId('forge-discovery')).toBeDefined();
    expect(screen.queryByTestId('forge-discovery-direct')).toBeNull();
  });
});
