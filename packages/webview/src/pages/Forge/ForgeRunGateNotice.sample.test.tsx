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

  it('says a drawing refused past its share of the source as the drawing’s, and draws the newest first from the notice', () => {
    // Said as a run past all the source has left, it offered the newest
    // records to a draw that took them already, and no way to ask for them.
    onReview({ ...WHOLE_ORG, sample: { seed: 3 } });
    act(() =>
      useForgeRunGateStore.getState().setStop({
        code: 'API_BUDGET_EXCEEDED',
        api: {
          kind: 'requests',
          org: 'source',
          estimate: 1_200,
          remaining: 9_000,
          drawing: { share: 0.1, draw: 'uniform' },
        },
      }),
    );
    render(<ForgeRunGateNotice />);

    const said = screen.getByTestId('forge-run-gate-reason').textContent ?? '';
    expect(said).toContain('drawing the sample spread over the org');
    expect(said).toContain('more than the 10 % of the 9,000 it has left today');
    expect(said).toContain('Draw the newest records');

    fireEvent.click(screen.getByTestId('forge-run-gate-draw-newest'));

    expect(useForgeStore.getState().config?.sample).toEqual({ seed: 3, draw: 'recent' });
    expect(useForgeRunGateStore.getState().stop).toBeNull();
  });

  it('offers the newest first to no drawing that took them already', () => {
    onReview({ ...WHOLE_ORG, sample: { draw: 'recent' } });
    act(() =>
      useForgeRunGateStore.getState().setStop({
        code: 'API_BUDGET_EXCEEDED',
        api: {
          kind: 'requests',
          org: 'source',
          estimate: 1_200,
          remaining: 9_000,
          drawing: { share: 0.1, draw: 'recent' },
        },
      }),
    );
    render(<ForgeRunGateNotice />);

    const said = screen.getByTestId('forge-run-gate-reason').textContent ?? '';
    expect(said).not.toContain('Draw the newest');
    expect(said).toContain('filter in Review → Controls');
    expect(screen.queryByTestId('forge-run-gate-draw-newest')).toBeNull();
  });

  it.each([
    ['the target’s requests', { kind: 'requests' as const, org: 'target' as const }],
    ['the source’s requests', { kind: 'requests' as const, org: 'source' as const }],
    ['the target’s Bulk API batches', { kind: 'bulkBatches' as const, org: 'target' as const }],
  ])(
    'offers a sample that fits to a clone of every record past %s, and names the filter that narrows an object',
    (_what, api) => {
      // It said to wait or leave objects out: a sample, which takes fewer of
      // them with its records, went unnamed.
      onReview();
      act(() =>
        useForgeRunGateStore.getState().setStop({
          code: 'API_BUDGET_EXCEEDED',
          api: { ...api, estimate: 60_000, remaining: 5_000 },
        }),
      );
      render(<ForgeRunGateNotice />);

      const said = screen.getByTestId('forge-run-gate-reason').textContent ?? '';
      expect(said).toContain('copy a sample of the org that fits the target');
      expect(said).toContain('filter in Review → Controls');
      fireEvent.click(screen.getByTestId('forge-run-gate-copy-sample-budget'));
      expect(useForgeStore.getState().config?.sample).toEqual({});
      expect(useForgeRunGateStore.getState().stop).toBeNull();
    },
  );

  it('names no sample to a run past the requests that copies one already', () => {
    onReview({ ...WHOLE_ORG, sample: {} });
    act(() =>
      useForgeRunGateStore.getState().setStop({
        code: 'API_BUDGET_EXCEEDED',
        api: { kind: 'requests', org: 'target', estimate: 60_000, remaining: 5_000 },
      }),
    );
    render(<ForgeRunGateNotice />);

    const said = screen.getByTestId('forge-run-gate-reason').textContent ?? '';
    expect(said).not.toContain('sample');
    expect(said).toContain('filter in Review → Controls');
    expect(screen.queryByTestId('forge-run-gate-copy-sample-budget')).toBeNull();
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
