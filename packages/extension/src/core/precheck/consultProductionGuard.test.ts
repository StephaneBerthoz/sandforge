import { describe, it, expect, vi } from 'vitest';

import { consultProductionGuard, strongerDecision } from './consultProductionGuard.js';
import { ProductionGuard } from './ProductionGuard.js';
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
    expect(check.blockedReason).toContain('delete is not allowed');
    expect(ask).not.toHaveBeenCalled();
  });

  it('does not say anyone confirmed a write when there was no one to ask', async () => {
    // A command-line runner builds the guard without a confirmation UI: the
    // guard lets the production write through, and nobody confirmed it.
    const guard = new ProductionGuard();

    const { decision } = await consultProductionGuard(guard, request({ orgTier: 'production' }));

    expect(decision).toBe('allowed');
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
