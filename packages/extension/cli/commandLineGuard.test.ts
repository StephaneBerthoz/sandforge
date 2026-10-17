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
