import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import '../../i18n';
import type { ForgeConfig } from '@sandforge/shared';
import { useForgeStore } from '../../stores/useForgeStore';
import { useForgeRunGateStore } from './runGate';
import { ForgeRunGateNotice } from './ForgeRunGateNotice';
import { sampleBudgetTerms, wholeOrgGraph } from './testing/wholeOrg';

const sentRuns = vi.hoisted(() => [] as Array<{ type: string; payload: unknown }>);
vi.mock('../../bridge/sendBridgeMessage', () => ({
  sendBridgeMessage: (type: string, payload: unknown) => {
    sentRuns.push({ type, payload });
    return `wv-${String(sentRuns.length)}`;
  },
}));

/** A clone of the whole org, as Review holds it. */
const WHOLE_ORG: ForgeConfig = {
  inputMode: 'org',
  depth: 'all',
  sourceOrgId: 'org-src',
  targetOrgId: 'org-tgt',
  anonymizePII: false,
  skipEmpty: false,
  batchSize: 'auto',
};

/** Review on a clone of the whole org, the stop of its last run kept. */
function onReview(config: ForgeConfig = WHOLE_ORG): void {
  useForgeStore.getState().setConfig(config);
  useForgeStore.getState().setGraph(wholeOrgGraph());
  useForgeStore.getState().setPhase('review');
}

/*
 * A refusal of a sample says what to do in words, and the notice does it:
 * a target that has less room than the sample was fitted to, or a plan of
 * another setup, is simulated again from the notice; a clone of every record
 * refused for its storage is offered the sample that fits instead.
 */
describe('ForgeRunGateNotice, of a sample of the whole org', () => {
  beforeEach(() => {
    sentRuns.length = 0;
    useForgeStore.getState().reset();
    act(() => useForgeRunGateStore.getState().clear());
  });

  it('simulates again a sample whose target moved since its plan, and forgets the stop', () => {
    onReview({ ...WHOLE_ORG, sample: { seed: 2 } });
    act(() =>
      useForgeRunGateStore.getState().setStop({
        code: 'STORAGE_EXCEEDED',
        storage: { estimateMB: 3.5, remainingMB: 4 },
        sample: { fittedMB: 3.6, holdsMB: 2.8 },
      }),
    );
    render(<ForgeRunGateNotice />);

    fireEvent.click(screen.getByTestId('forge-run-gate-simulate-again'));

    const [run] = sentRuns;
    expect(run.type).toBe('forge:execute');
    expect((run.payload as { config: ForgeConfig }).config).toEqual({
      ...WHOLE_ORG,
      sample: { seed: 2 },
      dryRun: true,
    });
    expect(useForgeStore.getState().phase).toBe('execution');
    expect(useForgeStore.getState().simulation).toBe(true);
    expect(useForgeRunGateStore.getState().stop).toBeNull();
  });

  it('simulates again a run whose plan was drawn for another setup', () => {
    onReview({ ...WHOLE_ORG, sample: {} });
    act(() =>
      useForgeRunGateStore
        .getState()
        .setStop({ code: 'SAMPLE_PLAN_MISMATCH', sample: { plan: 'otherSetup' } }),
    );
    render(<ForgeRunGateNotice />);

    expect(screen.getByTestId('forge-run-gate-simulate-again').textContent).toBe('Simulate again');
  });

  it('offers nothing to simulate for a stop whose words ask for something else', () => {
    onReview({ ...WHOLE_ORG, sample: {} });
    act(() =>
      useForgeRunGateStore
        .getState()
        .setStop({ code: 'SAMPLE_CANNOT_FIT', sample: { heaviest: ['Case'] } }),
    );
    render(<ForgeRunGateNotice />);

    expect(screen.queryByTestId('forge-run-gate-simulate-again')).toBeNull();
  });

  it('simulates nothing from the results a retry stopped on', () => {
    onReview({ ...WHOLE_ORG, sample: {} });
    useForgeStore.getState().setPhase('results');
    act(() =>
      useForgeRunGateStore.getState().setStop({
        code: 'STORAGE_EXCEEDED',
        sample: { fittedMB: 3.6, holdsMB: 2.8 },
      }),
    );
    render(<ForgeRunGateNotice />);

    expect(screen.queryByTestId('forge-run-gate-simulate-again')).toBeNull();
  });

  it('offers a sample that fits to a clone of every record refused for its storage, set once taken', () => {
    onReview();
    useForgeStore.getState().setFileCopy({ enabled: true });
    act(() =>
      useForgeRunGateStore
        .getState()
        .setStop(
          { code: 'STORAGE_EXCEEDED', storage: { estimateMB: 412, remainingMB: 4.5 } },
          { checkpointAsked: false, sampleOffer: sampleBudgetTerms() },
        ),
    );
    render(<ForgeRunGateNotice />);

    expect(screen.getByTestId('forge-run-gate-sample-offer').textContent).toBe(
      'A sample that fits would take about 3.2 MB of it.',
    );
    fireEvent.click(screen.getByTestId('forge-run-gate-copy-sample'));

    expect(useForgeStore.getState().config?.sample).toEqual({});
    expect(useForgeStore.getState().fileCopy.enabled).toBe(false);
    expect(useForgeRunGateStore.getState().stop).toBeNull();
    expect(sentRuns).toEqual([]);
  });

  it('offers no sample to a run that copies one already', () => {
    onReview({ ...WHOLE_ORG, sample: {} });
    act(() =>
      useForgeRunGateStore
        .getState()
        .setStop(
          { code: 'STORAGE_EXCEEDED', storage: { estimateMB: 412, remainingMB: 4.5 } },
          { checkpointAsked: false, sampleOffer: sampleBudgetTerms() },
        ),
    );
    render(<ForgeRunGateNotice />);

    expect(screen.queryByTestId('forge-run-gate-sample-offer')).toBeNull();
  });
});
