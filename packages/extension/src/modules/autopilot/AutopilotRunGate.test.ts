import { describe, it, expect, vi } from 'vitest';
import type { ApiName } from '@sandforge/shared';
import type { WriteConfirmation } from '../../core/precheck/ProductionGuard';
import { autopilotWritePlan, gateAutopilotWrite } from './AutopilotRunGate';

/** A plan of the given objects, one wave each. */
function planOf(...objects: string[]) {
  return {
    waves: objects.map((name, order) => ({ order, objects: [name as ApiName], dependsOn: [] })),
  };
}

describe('autopilotWritePlan', () => {
  it("counts the plan's records per object, the most first, and the storage they take", () => {
    const plan = autopilotWritePlan(
      planOf('Account', 'Contact', 'Empty__c'),
      new Map([
        ['Account', 10],
        ['Contact', 40],
        ['Empty__c', 0],
      ]),
    );

    expect(plan.objects.map((o) => [o.objectApiName, o.rows])).toEqual([
      ['Contact', 40],
      ['Account', 10],
    ]);
    expect(plan.totalRows).toBe(50);
    expect(plan.storageBytes).toBe(50 * 2048);
  });
});

describe('gateAutopilotWrite', () => {
  const roomy = { maxMB: 200, remainingMB: 150 };

  it('refuses a plan past the storage the target has left, before asking anything', async () => {
    // Run for real with plan only, 2.6 million records were planned for a
    // target with 22 MB left, and the run would have gone straight to write.
    const confirm = vi.fn();
    const outcome = await gateAutopilotWrite({
      plan: autopilotWritePlan(planOf('Account'), new Map([['Account', 20_000]])),
      storage: { maxMB: 200, remainingMB: 22 },
      confirmAboveRecords: 2_000,
      org: 'TARGET',
      orgTier: 'development',
      confirm,
    });

    expect(outcome).toMatchObject({ go: false, code: 'STORAGE_EXCEEDED' });
    expect(outcome.go === false && outcome.message).toContain('Nothing was written.');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('asks past the setting, with the counted records per object, and goes on when confirmed', async () => {
    const confirm = vi.fn(async (_question: WriteConfirmation) => 'confirmed' as const);
    const outcome = await gateAutopilotWrite({
      plan: autopilotWritePlan(planOf('Lead'), new Map([['Lead', 2_500]])),
      storage: roomy,
      confirmAboveRecords: 2_000,
      org: 'TARGET',
      orgTier: 'development',
      confirm,
    });

    expect(outcome).toMatchObject({ go: true, asked: true });
    expect(confirm.mock.calls[0][0]).toMatchObject({
      stage: 'write',
      module: 'autopilot',
      objects: [{ objectApiName: 'Lead', rows: 2_500 }],
      total: 2_500,
      aboveRecords: 2_000,
      counted: true,
    });
  });

  it('stops when the question is declined, or when nobody can be asked', async () => {
    const run = (answer: 'declined' | 'unavailable') =>
      gateAutopilotWrite({
        plan: autopilotWritePlan(planOf('Lead'), new Map([['Lead', 2_500]])),
        storage: roomy,
        confirmAboveRecords: 2_000,
        org: 'TARGET',
        orgTier: 'development',
        confirm: async () => answer,
      });

    expect(await run('declined')).toMatchObject({ go: false, code: 'WRITE_DECLINED' });
    expect(await run('unavailable')).toMatchObject({
      go: false,
      code: 'CONFIRMATION_UNAVAILABLE',
    });
  });

  it('asks when the target would not say what storage it has left', async () => {
    const confirm = vi.fn(async () => 'confirmed' as const);
    await gateAutopilotWrite({
      plan: autopilotWritePlan(planOf('Lead'), new Map([['Lead', 3]])),
      storage: { unread: 'INSUFFICIENT_ACCESS' },
      confirmAboveRecords: 2_000,
      org: 'TARGET',
      orgTier: 'development',
      confirm,
    });

    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('lets a small plan that fits through without a question', async () => {
    const confirm = vi.fn();
    const outcome = await gateAutopilotWrite({
      plan: autopilotWritePlan(planOf('Lead'), new Map([['Lead', 3]])),
      storage: roomy,
      confirmAboveRecords: 2_000,
      org: 'TARGET',
      orgTier: 'development',
      confirm,
    });

    expect(outcome).toMatchObject({ go: true, asked: false });
    expect(confirm).not.toHaveBeenCalled();
  });
});
