import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ForgeConfig, ForgeGraph } from '@sandforge/shared';
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
