import { describe, it, expect, vi } from 'vitest';

import { consultProductionGuard, strongerDecision } from './consultProductionGuard.js';
import { ProductionGuard, withGivenAnswer } from './ProductionGuard.js';
import type { OperationRequest } from './ProductionGuard.js';

const request = (over: Partial<OperationRequest> = {}): OperationRequest => ({
  orgId: '00D000000000001AAA',
  orgTier: 'development',
  operation: 'insert',
  objectName: 'Account',
  recordCount: 10,
  module: 'sync',
  ...over,
});

describe('consultProductionGuard', () => {
  it('lets a sandbox write through without asking anyone', async () => {
    const guard = new ProductionGuard({ requestConfirmation: vi.fn() });

    const { decision } = await consultProductionGuard(guard, request());

    expect(decision).toBe('allowed');
  });

  it('records a production write a person confirmed as confirmed', async () => {
    const ask = vi.fn().mockResolvedValue(true);
    const guard = new ProductionGuard({ requestConfirmation: ask });

    const { decision } = await consultProductionGuard(guard, request({ orgTier: 'production' }));

    expect(ask).toHaveBeenCalledTimes(1);
    expect(decision).toBe('confirmed');
  });

  it('asks about the tier of the org the run writes to', async () => {
    // The question always said the run wrote to a production org, whichever
    // tier had asked for it.
    const ask = vi.fn().mockResolvedValue(true);
    const guard = new ProductionGuard({ requestConfirmation: ask });

    await consultProductionGuard(guard, request({ orgTier: 'staging', operation: 'delete' }));
    await consultProductionGuard(guard, request({ orgTier: 'production' }));

    expect(ask.mock.calls.map(([, tier]) => tier)).toEqual(['staging', 'production']);
  });

  it('records a production write a person turned down as declined', async () => {
    const guard = new ProductionGuard({ requestConfirmation: vi.fn().mockResolvedValue(false) });

    const { decision } = await consultProductionGuard(guard, request({ orgTier: 'production' }));

    expect(decision).toBe('declined');
  });

  it('records a delete on production as refused, and asks no one', async () => {
    const ask = vi.fn();
    const guard = new ProductionGuard({ requestConfirmation: ask });

    const { check, decision } = await consultProductionGuard(
      guard,
      request({ orgTier: 'production', operation: 'delete' }),
    );

    expect(decision).toBe('refused');
    expect(check.blockedReason).toContain('Deleting records is not allowed');
    expect(ask).not.toHaveBeenCalled();
  });

  it('does not say anyone confirmed a write when there was no one to ask', async () => {
    // A command-line runner builds the guard without a confirmation UI: the
    // guard lets the production write through, and nobody confirmed it.
    const guard = new ProductionGuard();

    const { decision } = await consultProductionGuard(guard, request({ orgTier: 'production' }));

    expect(decision).toBe('allowed');
  });

  it('takes an approval given beforehand as the answer, shows nothing, and records it confirmed', async () => {
    const ask = vi.fn();
    const guard = new ProductionGuard({ requestConfirmation: ask });

    const { decision } = await withGivenAnswer({ approved: true }, () =>
      consultProductionGuard(guard, request({ orgTier: 'production' })),
    );

    expect(ask).not.toHaveBeenCalled();
    expect(decision).toBe('confirmed');
  });

  it('records a person as having answered even on a host with no confirmation UI', async () => {
    const guard = new ProductionGuard();

    const { decision } = await withGivenAnswer({ approved: true }, () =>
      consultProductionGuard(guard, request({ orgTier: 'production' })),
    );

    expect(decision).toBe('confirmed');
  });

  it('declines, without showing anything, a question nobody approved beforehand', async () => {
    const ask = vi.fn().mockResolvedValue(true);
    const guard = new ProductionGuard({ requestConfirmation: ask });

    const { decision } = await withGivenAnswer({ approved: false }, () =>
      consultProductionGuard(guard, request({ orgTier: 'production' })),
    );

    expect(ask).not.toHaveBeenCalled();
    expect(decision).toBe('declined');
  });

  it('refuses what it refuses, an approval given beforehand or not', async () => {
    const guard = new ProductionGuard({ requestConfirmation: vi.fn() });

    const { decision } = await withGivenAnswer({ approved: true }, () =>
      consultProductionGuard(guard, request({ orgTier: 'production', operation: 'delete' })),
    );

    expect(decision).toBe('refused');
  });

  it('keeps an approval given to one run from answering another run under way', async () => {
    // A Sync started from its page while a pipeline's Sync step runs must
    // still be asked: the answer belongs to the pipeline's run alone.
    const ask = vi.fn().mockResolvedValue(false);
    const guard = new ProductionGuard({ requestConfirmation: ask });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const pipelineRun = withGivenAnswer({ approved: true }, async () => {
      await held;
      return consultProductionGuard(guard, request({ orgTier: 'production' }));
    });
    const pageRun = consultProductionGuard(guard, request({ orgTier: 'production' }));
    release();

    expect((await pageRun).decision).toBe('declined');
    expect((await pipelineRun).decision).toBe('confirmed');
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('lets nothing the approved run left behind answer a question once that run has ended', async () => {
    // A timer or listener made during the pipeline's Sync step carries its
    // async context; a run it starts later, unattended, must be asked.
    const ask = vi.fn().mockResolvedValue(false);
    const guard = new ProductionGuard({ requestConfirmation: ask });
    let ended = false;
    let fired: (decision: string) => void = () => undefined;
    const later = new Promise<string>((resolve) => {
      fired = resolve;
    });

    await withGivenAnswer({ approved: true }, async () => {
      // Scheduled from inside the approved run, fired once it has ended.
      const tick = (): void => {
        if (!ended) {
          setTimeout(tick, 1);
          return;
        }
        void consultProductionGuard(guard, request({ orgTier: 'production' })).then(
          ({ decision }) => fired(decision),
        );
      };
      setTimeout(tick, 1);
    });
    ended = true;

    expect(await later).toBe('declined');
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('asks the guard to judge the run once, as the run is described', async () => {
    const guard = new ProductionGuard();
    const check = vi.spyOn(guard, 'check');
    const run = request();

    await consultProductionGuard(guard, run);

    expect(check).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith(run);
  });
});

describe('strongerDecision', () => {
  it('sums a run up by the most that happened to any of its batches', () => {
    expect(strongerDecision(undefined, 'allowed')).toBe('allowed');
    expect(strongerDecision('allowed', 'confirmed')).toBe('confirmed');
    expect(strongerDecision('confirmed', 'allowed')).toBe('confirmed');
    expect(strongerDecision('confirmed', 'declined')).toBe('declined');
    expect(strongerDecision('refused', 'declined')).toBe('refused');
  });
});
