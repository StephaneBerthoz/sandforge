import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ForgeConfig, ForgeExecutionResult, ForgeGraph } from '@sandforge/shared';
import { useForgeStore } from '../../stores/useForgeStore';
import { takeGateStop, useForgeRunGateStore } from './runGate';
import { startForgeRun } from './startForgeRun';

vi.mock('../../bridge/sendBridgeMessage', () => ({
  sendBridgeMessage: (type: string) => (type === 'forge:execute' ? 'wv-run-1' : 'wv-other'),
}));

const CONFIG: ForgeConfig = {
  inputMode: 'record',
  recordId: '001000000000001AAA',
  depth: 'direct',
  sourceOrgId: 'org-src',
  targetOrgId: 'org-tgt',
  anonymizePII: false,
  skipEmpty: false,
  batchSize: 'auto',
};

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
  ],
  edges: [],
  totalRecords: 1,
  estimatedSizeMB: 0.01,
  estimatedDurationSeconds: 1,
};

/** What the extension posts for a run, as the window dispatches it to every listener. */
function fromTheExtension(data: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent('message', { data, origin: '' }));
}

/** The error of the run on screen, stopped at its gate with `gate`. */
function stoppedAtTheGate(gate: unknown, correlationId = 'wv-run-1'): Record<string, unknown> {
  return {
    type: 'forge:execute:error',
    id: 'ext-1',
    correlationId,
    payload: {
      message: 'Forge execution was cancelled before it wrote the records it had read.',
      code: (gate as { code?: string }).code ?? 'EXECUTE_ERROR',
      retryable: true,
      gate,
    },
  };
}

describe('a Forge run stopped at its gate', () => {
  beforeEach(() => {
    useForgeStore.getState().reset();
    useForgeRunGateStore.getState().clear();
    useForgeStore.getState().setConfig(CONFIG);
    useForgeStore.getState().setGraph(GRAPH);
    useForgeStore.getState().setPhase('review');
    startForgeRun();
  });

  it('goes back to Review, where it was sent from, saying why rather than showing a failed run', () => {
    fromTheExtension(stoppedAtTheGate({ code: 'WRITE_DECLINED' }));

    const forge = useForgeStore.getState();
    expect(forge.phase).toBe('review');
    expect(forge.runError).toBeNull();
    expect(useForgeRunGateStore.getState().stop).toEqual({ code: 'WRITE_DECLINED' });
  });

  it('goes back to Review from a run Clone directly started too', () => {
    useForgeStore.getState().setPhase('input');
    startForgeRun({ reviewSkipped: true });

    fromTheExtension(stoppedAtTheGate({ code: 'AUTOMATION_DECLINED' }));

    expect(useForgeStore.getState().phase).toBe('review');
    expect(useForgeRunGateStore.getState().stop).toEqual({ code: 'AUTOMATION_DECLINED' });
  });

  it('keeps what a refusal for storage says of the storage', () => {
    fromTheExtension(
      stoppedAtTheGate({
        code: 'STORAGE_EXCEEDED',
        storage: { estimateMB: 66.9, remainingMB: 12 },
      }),
    );

    expect(useForgeRunGateStore.getState().stop).toEqual({
      code: 'STORAGE_EXCEEDED',
      storage: { estimateMB: 66.9, remainingMB: 12 },
    });
  });

  it('keeps what a sample may take beside a refusal of every record for its storage, and nothing beside any other', () => {
    const offer = { bytes: 3_774_873, remainingMB: 5, maxMB: 5, limitedBy: 'storage' };
    const refused = stoppedAtTheGate({
      code: 'STORAGE_EXCEEDED',
      storage: { estimateMB: 412, remainingMB: 5 },
    });
    fromTheExtension({
      ...refused,
      payload: { ...(refused.payload as Record<string, unknown>), sampleOffer: offer },
    });
    expect(useForgeRunGateStore.getState().sampleOffer).toEqual(offer);

    // The next stop keeps its own, and a stop of another kind none.
    startForgeRun();
    const declined = stoppedAtTheGate({ code: 'WRITE_DECLINED' });
    fromTheExtension({
      ...declined,
      payload: { ...(declined.payload as Record<string, unknown>), sampleOffer: offer },
    });
    expect(useForgeRunGateStore.getState().sampleOffer).toBeUndefined();

    // Nor one that does not read as one.
    startForgeRun();
    fromTheExtension({
      ...refused,
      payload: { ...(refused.payload as Record<string, unknown>), sampleOffer: { bytes: 'all' } },
    });
    expect(useForgeRunGateStore.getState().sampleOffer).toBeUndefined();
  });

  it('leaves the error of a run that failed on the execution screen', () => {
    fromTheExtension({
      type: 'forge:execute:error',
      id: 'ext-2',
      correlationId: 'wv-run-1',
      payload: { message: 'INVALID_SESSION_ID', code: 'EXECUTE_ERROR', retryable: true },
    });

    expect(useForgeStore.getState().phase).toBe('execution');
    expect(useForgeStore.getState().runError?.message).toBe('INVALID_SESSION_ID');
    expect(useForgeRunGateStore.getState().stop).toBeNull();
  });

  it("takes no other run's stop, nor one from outside the webview", () => {
    fromTheExtension(stoppedAtTheGate({ code: 'WRITE_DECLINED' }, 'wv-another-panel'));
    takeGateStop(
      new MessageEvent('message', {
        data: stoppedAtTheGate({ code: 'WRITE_DECLINED' }),
        origin: 'https://example.com',
      }),
    );

    expect(useForgeStore.getState().phase).toBe('execution');
    expect(useForgeRunGateStore.getState().stop).toBeNull();
  });

  it('forgets the stop once the next run starts', () => {
    fromTheExtension(stoppedAtTheGate({ code: 'PRODUCTION_TARGET' }));
    expect(useForgeRunGateStore.getState().stop).not.toBeNull();

    startForgeRun();

    expect(useForgeRunGateStore.getState().stop).toBeNull();
  });
});

describe('a retry stopped at its gate', () => {
  /** The run the results show, which failed its only object. */
  const FAILED: ForgeExecutionResult = {
    forgeId: 'forge-failed',
    status: 'failure',
    graph: GRAPH,
    duration: 1000,
    timestamp: '2026-10-01T08:00:00.000Z',
    idRemapCount: 0,
  };

  /** Start a retry of the results on screen, as their Retry failed does. */
  function retry(): void {
    const shown = useForgeStore.getState();
    const from = {
      graph: shown.graph,
      statusesBeyondGraph: shown.statusesBeyondGraph,
      runError: shown.runError,
      stoppedAt: shown.stoppedAt,
      logs: shown.logs,
      runClock: shown.runClock,
    };
    shown.resetNodeStatuses();
    useForgeRunGateStore.getState().clear();
    shown.setExecutionRequestId('wv-run-1');
    shown.markRetry(from);
    shown.setPhase('execution');
  }

  beforeEach(() => {
    useForgeStore.getState().reset();
    useForgeRunGateStore.getState().clear();
    useForgeStore.getState().setConfig(CONFIG);
    useForgeStore.getState().setGraph(GRAPH);
    useForgeStore.getState().setPhase('review');
    startForgeRun();
    useForgeStore.getState().updateNodeStatus('Account', 'error');
    fromTheExtension({
      type: 'forge:execute:response',
      id: 'ext-0',
      correlationId: 'wv-run-1',
      payload: { result: FAILED },
    });
  });

  it('goes back to the results it was started from, the run it retries and what failed in it kept', () => {
    expect(useForgeStore.getState().phase).toBe('results');
    retry();
    expect(useForgeStore.getState().graph?.nodes[0].status).toBe('idle');

    fromTheExtension(stoppedAtTheGate({ code: 'AUTOMATION_DECLINED' }));

    const forge = useForgeStore.getState();
    expect(forge.phase).toBe('results');
    expect(forge.result?.forgeId).toBe('forge-failed');
    expect(forge.runError).toBeNull();
    // What failed is what Retry failed is offered for, again.
    expect(forge.graph?.nodes[0].status).toBe('error');
    expect(forge.retrying).toBeNull();
    expect(useForgeRunGateStore.getState().stop).toEqual({ code: 'AUTOMATION_DECLINED' });
  });

  it('is a retry no more once it answered: the next run stopped at its gate goes back to Review', () => {
    retry();
    fromTheExtension({
      type: 'forge:execute:response',
      id: 'ext-3',
      correlationId: 'wv-run-1',
      payload: { result: { ...FAILED, forgeId: 'forge-retry', status: 'success' } },
    });
    expect(useForgeStore.getState().retrying).toBeNull();

    useForgeStore.getState().setPhase('review');
    startForgeRun();
    fromTheExtension(stoppedAtTheGate({ code: 'WRITE_DECLINED' }));

    expect(useForgeStore.getState().phase).toBe('review');
  });

  describe('a run stopped with a checkpoint in question', () => {
    const stopWith = (payload: Record<string, unknown>): void =>
      takeGateStop(
        new MessageEvent('message', {
          data: {
            type: 'forge:execute:error',
            correlationId: useForgeStore.getState().executionRequestId,
            payload,
          },
        }),
      );

    it('keeps that the run was to take one, as the option stood when it was sent', () => {
      useForgeStore.getState().setCheckpointFirst(true);
      startForgeRun();
      stopWith({ gate: { code: 'API_BUDGET_EXCEEDED' } });
      expect(useForgeRunGateStore.getState().checkpointAsked).toBe(true);
    });

    it('keeps what refused it, and what became of one the error names', () => {
      startForgeRun();
      stopWith({
        gate: { code: 'CHECKPOINT_REFUSED', reason: 'DISK' },
        checkpoint: { state: 'deleted', deleted: 'nothingWritten' },
      });
      const gate = useForgeRunGateStore.getState();
      expect(gate.stop).toEqual({ code: 'CHECKPOINT_REFUSED', reason: 'DISK' });
      expect(gate.checkpointAsked).toBe(false);
      expect(gate.checkpoint).toEqual({ state: 'deleted', deleted: 'nothingWritten' });
      gate.clear();
      expect(useForgeRunGateStore.getState().checkpoint).toBeUndefined();
    });
  });
});

describe('the notice of a stop, brought into view once', () => {
  beforeEach(() => {
    useForgeRunGateStore.getState().clear();
  });

  it('is yet to be brought into view when a run stops, and stays shown once it was', () => {
    useForgeRunGateStore
      .getState()
      .setStop({ code: 'API_BUDGET_EXCEEDED' }, { checkpointAsked: true });
    expect(useForgeRunGateStore.getState().revealed).toBe(false);

    useForgeRunGateStore.getState().markRevealed();

    expect(useForgeRunGateStore.getState()).toMatchObject({
      stop: { code: 'API_BUDGET_EXCEEDED' },
      checkpointAsked: true,
      revealed: true,
    });
  });

  it('is to be brought into view again for the next stop, and forgotten with the stop', () => {
    useForgeRunGateStore.getState().setStop({ code: 'WRITE_DECLINED' });
    useForgeRunGateStore.getState().markRevealed();

    useForgeRunGateStore.getState().clear();
    expect(useForgeRunGateStore.getState()).toMatchObject({ stop: null, revealed: false });

    useForgeRunGateStore.getState().setStop({ code: 'WRITE_DECLINED' });
    useForgeRunGateStore.getState().markRevealed();
    useForgeRunGateStore.getState().setStop({ code: 'PRODUCTION_TARGET' });
    expect(useForgeRunGateStore.getState().revealed).toBe(false);
  });
});
