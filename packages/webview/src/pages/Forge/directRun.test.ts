import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ForgeConfig, ForgeGraph } from '@sandforge/shared';
import { useForgeStore } from '../../stores/useForgeStore';
import { adoptDiscoveredGraph, sendDiscovery } from './directRun';

const mockSendBridgeMessage = vi.fn((type: string, payload?: unknown) => {
  void payload;
  return type === 'forge:execute' ? 'wv-run-1' : 'wv-other';
});
vi.mock('../../bridge/sendBridgeMessage', () => ({
  sendBridgeMessage: (type: string, payload?: unknown) => mockSendBridgeMessage(type, payload),
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

/** The request of the discovery the Clone directly waits on. */
const DISCOVERY = 'wv-discover-1';

/** The extension posting `type`, answering `correlationId`, with no screen to take it. */
function extensionSays(type: string, payload: unknown, correlationId: unknown = DISCOVERY): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { id: `ext-${type}`, type, timestamp: Date.now(), correlationId, payload },
    }),
  );
}

/** What the run was sent, if it was. */
function executed(): Record<string, unknown> | undefined {
  const call = mockSendBridgeMessage.mock.calls.find(([type]) => type === 'forge:execute');
  return call?.[1] as Record<string, unknown> | undefined;
}

describe('directRun — the answer to a Clone directly, page or no page', () => {
  beforeEach(() => {
    mockSendBridgeMessage.mockClear();
    const store = useForgeStore.getState();
    store.reset();
    store.setConfig(CONFIG);
    store.awaitDirectRun(DISCOVERY);
    store.setPhase('discovery');
  });

  it('starts the run as its discovery answers, with no screen open to take the answer', () => {
    extensionSays('forge:discover:response', { graph: DISCOVERED });

    expect(executed()).toEqual({
      graph: DISCOVERED,
      config: CONFIG,
      anonymizationRules: useForgeStore.getState().anonymizationRules,
    });
    const state = useForgeStore.getState();
    expect(state.phase).toBe('execution');
    expect(state.executionRequestId).toBe('wv-run-1');
    expect(state.reviewSkipped).toBe(true);
    expect(state.directDiscoveryId).toBeNull();
  });

  it('takes no answer to another discovery, nor one with no graph', () => {
    extensionSays('forge:discover:response', { graph: DISCOVERED }, 'wv-discover-other');
    extensionSays('forge:discover:response', { graph: DISCOVERED }, null);
    extensionSays('forge:discover:response', { graph: null });

    expect(executed()).toBeUndefined();
    expect(useForgeStore.getState().directDiscoveryId).toBe(DISCOVERY);
    expect(useForgeStore.getState().phase).toBe('discovery');
  });

  it('takes nothing once no Clone directly waits, nor any discovery', () => {
    useForgeStore.getState().settleDirectRun();

    extensionSays('forge:discover:response', { graph: DISCOVERED });

    expect(executed()).toBeUndefined();
    expect(useForgeStore.getState().graph).toBeNull();
  });

  it('keeps the error its discovery ended on for the screen, and starts nothing', () => {
    extensionSays('forge:discover:error', { message: 'INVALID_SESSION_ID: session expired' });
    extensionSays('forge:discover:response', { graph: DISCOVERED });

    expect(executed()).toBeUndefined();
    const state = useForgeStore.getState();
    expect(state.directDiscoveryError).toBe('INVALID_SESSION_ID: session expired');
    expect(state.directDiscoveryId).toBeNull();
    expect(state.phase).toBe('discovery');
  });

  it('starts nothing for a Clone directly left before its discovery answered', () => {
    useForgeStore.getState().settleDirectRun();
    useForgeStore.getState().setPhase('input');

    extensionSays('forge:discover:response', { graph: DISCOVERED });

    expect(executed()).toBeUndefined();
    expect(useForgeStore.getState().phase).toBe('input');
  });

  it('ignores a message from another origin', () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://example.invalid',
        data: {
          id: 'ext-forged',
          type: 'forge:discover:response',
          correlationId: DISCOVERY,
          payload: { graph: DISCOVERED },
        },
      }),
    );

    expect(executed()).toBeUndefined();
  });
});

describe('directRun — the answer to the discovery the screen waits on, page or no page', () => {
  beforeEach(() => {
    mockSendBridgeMessage.mockClear();
    const store = useForgeStore.getState();
    store.reset();
    store.setConfig(CONFIG);
    store.awaitDiscovery(DISCOVERY);
    store.setPhase('discovery');
  });

  it('puts its graph in the store as Review will send it, with no screen open, and starts no run', () => {
    useForgeStore.getState().setAnonymizationPresetId('preset:gdpr-default');

    extensionSays('forge:discover:response', { graph: DISCOVERED });

    const state = useForgeStore.getState();
    expect(state.graph?.nodes[0].anonymizeFields).toEqual(['Email']);
    expect(state.discoveryId).toBeNull();
    expect(state.phase).toBe('discovery');
    expect(executed()).toBeUndefined();
  });

  it('keeps the error its discovery ended on for the screen, with no screen open', () => {
    extensionSays('forge:discover:error', { message: 'INVALID_SESSION_ID: session expired' });
    extensionSays('forge:discover:response', { graph: DISCOVERED });

    const state = useForgeStore.getState();
    expect(state.discoveryError).toBe('INVALID_SESSION_ID: session expired');
    expect(state.discoveryId).toBeNull();
    expect(state.graph).toBeNull();
  });

  it('takes no answer or error of another discovery, nor an answer with no graph', () => {
    extensionSays('forge:discover:response', { graph: DISCOVERED }, 'wv-discover-other');
    extensionSays('forge:discover:response', { graph: DISCOVERED }, null);
    extensionSays('forge:discover:error', { message: 'Not this one' }, 'wv-discover-other');
    extensionSays('forge:discover:response', { graph: null });

    const state = useForgeStore.getState();
    expect(state.graph).toBeNull();
    expect(state.discoveryError).toBeNull();
    expect(state.discoveryId).toBe(DISCOVERY);
  });

  it('never puts the graph of a discovery replaced by a newer one in place of the newer one’s', () => {
    const newer = 'wv-discover-2';
    const newerGraph: ForgeGraph = { ...DISCOVERED, totalRecords: 7 };
    useForgeStore.getState().awaitDiscovery(newer);

    // The replaced one answers before the newer one, then after it.
    extensionSays('forge:discover:response', { graph: DISCOVERED });
    expect(useForgeStore.getState().graph).toBeNull();
    extensionSays('forge:discover:response', { graph: newerGraph }, newer);
    extensionSays('forge:discover:response', { graph: DISCOVERED });
    extensionSays('forge:discover:error', { message: 'Aborted' });

    expect(useForgeStore.getState().graph).toBe(newerGraph);
    expect(useForgeStore.getState().discoveryError).toBeNull();
  });

  it('takes nothing of a discovery left for the input screen', () => {
    useForgeStore.getState().settleDiscovery();
    useForgeStore.getState().setPhase('input');

    extensionSays('forge:discover:response', { graph: DISCOVERED });
    extensionSays('forge:discover:error', { message: 'Aborted' });

    expect(useForgeStore.getState().graph).toBeNull();
    expect(useForgeStore.getState().discoveryError).toBeNull();
  });

  it('ignores a message from another origin', () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://example.invalid',
        data: {
          id: 'ext-forged',
          type: 'forge:discover:response',
          correlationId: DISCOVERY,
          payload: { graph: DISCOVERED },
        },
      }),
    );

    expect(useForgeStore.getState().graph).toBeNull();
    expect(useForgeStore.getState().discoveryId).toBe(DISCOVERY);
  });
});

describe('sendDiscovery', () => {
  beforeEach(() => {
    useForgeStore.getState().reset();
    useForgeStore.getState().setPhase('discovery');
  });

  it('waits on the discovery it sends, a Clone directly’s only when it is asked to be', () => {
    const send = vi.fn();

    sendDiscovery(send, CONFIG);
    const [plain] = send.mock.calls[0] as [{ id: string; type: string; payload: unknown }];
    expect(plain.type).toBe('forge:discover');
    expect(plain.payload).toEqual({ config: CONFIG });
    expect(useForgeStore.getState().discoveryId).toBe(plain.id);
    expect(useForgeStore.getState().directDiscoveryId).toBeNull();

    sendDiscovery(send, CONFIG, true);
    const [direct] = send.mock.calls[1] as [{ id: string }];
    expect(useForgeStore.getState().directDiscoveryId).toBe(direct.id);
    expect(useForgeStore.getState().discoveryId).toBeNull();
  });
});

describe('adoptDiscoveredGraph', () => {
  beforeEach(() => {
    useForgeStore.getState().reset();
  });

  it('narrows the fields to anonymize to the preset the run kept', () => {
    useForgeStore.getState().setConfig(CONFIG);
    useForgeStore.getState().setAnonymizationPresetId('preset:gdpr-default');

    adoptDiscoveredGraph(DISCOVERED);

    expect(useForgeStore.getState().graph?.nodes[0].anonymizeFields).toEqual(['Email']);
  });

  it('leaves the graph as discovered for a run that does not anonymize', () => {
    useForgeStore.getState().setConfig({ ...CONFIG, anonymizePII: false });
    useForgeStore.getState().setAnonymizationPresetId('preset:gdpr-default');

    adoptDiscoveredGraph(DISCOVERED);

    expect(useForgeStore.getState().graph).toBe(DISCOVERED);
  });
});
