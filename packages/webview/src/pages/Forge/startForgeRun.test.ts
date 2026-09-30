import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ForgeConfig, ForgeGraph } from '@sandforge/shared';
import { useForgeStore } from '../../stores/useForgeStore';
import { startForgeRun } from './startForgeRun';

const mockSendBridgeMessage = vi.fn((type: string, payload?: unknown) => {
  void payload;
  return type === 'forge:execute' ? 'wv-run-1' : 'wv-other';
});
vi.mock('../../bridge/sendBridgeMessage', () => ({
  sendBridgeMessage: (type: string, payload?: unknown) => mockSendBridgeMessage(type, payload),
}));

const CONFIG: ForgeConfig = {
  inputMode: 'record',
  recordId: '001000000000001AAA',
  depth: 'direct',
  sourceOrgId: 'org-src',
  targetOrgId: 'org-tgt',
  anonymizePII: true,
  skipEmpty: false,
  batchSize: 'auto',
};

/** An account and its contacts, the contacts' email to anonymize, the cases left out. */
const GRAPH: ForgeGraph = {
  nodes: [
    {
      objectApiName: 'Account',
      recordCount: 1,
      fieldCount: 50,
      status: 'idle',
      progress: 0,
      included: true,
      piiFields: [],
      anonymizeFields: [],
      level: 0,
      successCount: 0,
      failureCount: 0,
      errors: [],
      createableFieldCount: 40,
      estimatedSizeMB: 0.01,
      estimatedApiCalls: 1,
      batchStrategy: 'auto',
    },
    {
      objectApiName: 'Contact',
      recordCount: 2,
      fieldCount: 60,
      status: 'idle',
      progress: 0,
      included: true,
      piiFields: ['Email'],
      anonymizeFields: ['Email'],
      level: 1,
      successCount: 0,
      failureCount: 0,
      errors: [],
      createableFieldCount: 45,
      estimatedSizeMB: 0.01,
      estimatedApiCalls: 1,
      batchStrategy: 'auto',
    },
    {
      objectApiName: 'Case',
      recordCount: 3,
      fieldCount: 70,
      status: 'idle',
      progress: 0,
      included: false,
      leftOutByUser: true,
      piiFields: [],
      anonymizeFields: [],
      level: 1,
      successCount: 0,
      failureCount: 0,
      errors: [],
      createableFieldCount: 50,
      estimatedSizeMB: 0.01,
      estimatedApiCalls: 1,
      batchStrategy: 'auto',
    },
  ],
  edges: [],
  totalRecords: 6,
  estimatedSizeMB: 0.03,
  estimatedDurationSeconds: 3,
};

/** What the last `forge:execute` carried. */
function executePayload(): Record<string, unknown> | undefined {
  const call = mockSendBridgeMessage.mock.calls.filter(([type]) => type === 'forge:execute').pop();
  return call?.[1] as Record<string, unknown> | undefined;
}

describe('startForgeRun', () => {
  beforeEach(() => {
    mockSendBridgeMessage.mockClear();
    useForgeStore.getState().reset();
    useForgeStore.getState().setConfig(CONFIG);
    useForgeStore.getState().setGraph(GRAPH);
    useForgeStore.getState().setAnonymizationRule('email', 'hash');
    useForgeStore.getState().setPhase('review');
  });

  it('sends the graph as it stands, the config and the anonymization methods, and shows the run', () => {
    expect(startForgeRun()).toBe(true);

    expect(executePayload()).toEqual({
      graph: GRAPH,
      config: CONFIG,
      anonymizationRules: useForgeStore.getState().anonymizationRules,
    });
    expect(useForgeStore.getState().anonymizationRules.email).toBe('hash');
    const state = useForgeStore.getState();
    expect(state.phase).toBe('execution');
    expect(state.executionRequestId).toBe('wv-run-1');
    expect(state.reviewSkipped).toBe(false);
  });

  it('sends the files once their copy is on and accepted as they are', () => {
    useForgeStore.getState().setFileCopy({ enabled: true, maxFileSizeMB: 4, acceptedAsIs: true });

    startForgeRun();

    expect(executePayload()?.files).toEqual({ maxFileSizeMB: 4, acceptedAsIs: true });
  });

  it('sends nothing while the files of an anonymized run wait to be accepted as they are', () => {
    useForgeStore.getState().setFileCopy({ enabled: true, acceptedAsIs: false });

    expect(startForgeRun()).toBe(false);

    expect(executePayload()).toBeUndefined();
    expect(useForgeStore.getState().phase).toBe('review');
  });

  it('sends nothing without a graph', () => {
    useForgeStore.getState().awaitDirectRun('wv-discover-1');

    expect(startForgeRun({ reviewSkipped: true })).toBe(false);

    expect(mockSendBridgeMessage).not.toHaveBeenCalled();
    expect(useForgeStore.getState().reviewSkipped).toBe(false);
  });

  it('says of a run it started with no stop on Review that the review was skipped', () => {
    startForgeRun({ reviewSkipped: true });

    expect(useForgeStore.getState().reviewSkipped).toBe(true);
    expect(useForgeStore.getState().phase).toBe('execution');
  });

  it('starts the run on nodes put back to idle, keeping what discovery found wrong', () => {
    useForgeStore.getState().updateNodeStatus('Account', 'done', 100);

    startForgeRun();

    const account = useForgeStore.getState().graph?.nodes[0];
    expect(account?.status).toBe('idle');
    expect(account?.progress).toBe(0);
  });
});
