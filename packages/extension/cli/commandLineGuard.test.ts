import { describe, expect, it } from 'vitest';
import { commandLineGuard } from './commandLineGuard.js';
import type { OperationRequest } from '../src/core/precheck/ProductionGuard.js';

function request(over: Partial<OperationRequest>): OperationRequest {
  return {
    orgId: 'org-001',
    orgTier: 'production',
    operation: 'insert',
    objectName: 'Contact',
    recordCount: 10,
    module: 'dataops',
    ...over,
  };
}

describe('commandLineGuard', () => {
  it('refuses a production write the guard would have asked about, and says why', async () => {
    const lines: string[] = [];
    const guard = commandLineGuard((line) => lines.push(line), 'MY-ALIAS');
    const result = guard.check(request({ orgTier: 'production', operation: 'insert' }));
    expect(result.requiresConfirmation).toBe(true);
    await expect(guard.confirmIfNeeded(result, 'production')).resolves.toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^refused: MY-ALIAS is taken for a production org/);
  });

  it('says, asking nothing, why it declines what it would answer no, as a preview reads it', async () => {
    // A removal's preview asks nothing: it said nothing of the delete of a
    // production org its override lets through, which the removal then
    // ended declined.
    const lines: string[] = [];
    const guard = commandLineGuard((line) => lines.push(line), 'MY-ALIAS');
    guard.setProductionOverride('org-001', true);
    const production = guard.check(request({ orgTier: 'production', operation: 'delete' }));
    const staging = guard.check(request({ orgTier: 'staging', operation: 'delete' }));

    expect(guard.declinedWithoutAsking(production, 'production')).toBe(
      'MY-ALIAS is taken for a production org, and this command writes to none',
    );
    expect(guard.declinedWithoutAsking(staging, 'staging')).toBeUndefined();
    expect(lines).toEqual([]);
    // What it says it declines, it declines.
    await expect(guard.confirmIfNeeded(production, 'production')).resolves.toBe(false);
    expect(lines[0]).toBe(
      `refused: MY-ALIAS is taken for a production org, and this command writes to none (${production.impactSummary})`,
    );
  });

  it('lets a non-production write through, as the command asks its own question', async () => {
    const lines: string[] = [];
    const guard = commandLineGuard((line) => lines.push(line), 'MY-ALIAS');
    const result = guard.check(
      request({ orgTier: 'staging', operation: 'delete', recordCount: 50_000 }),
    );
    expect(result.requiresConfirmation).toBe(true);
    await expect(guard.confirmIfNeeded(result, 'staging')).resolves.toBe(true);
    expect(lines).toEqual([]);
  });

  it('is a guard that can put its question to someone, so a record of the run may say it was answered', () => {
    expect(commandLineGuard(() => undefined, 'MY-ALIAS').canAskForConfirmation).toBe(true);
  });
});
