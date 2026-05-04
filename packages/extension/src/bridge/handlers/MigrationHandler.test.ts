import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MigrationHandler } from './MigrationHandler';
import type { HandlerDeps } from './HandlerTypes';
import type { BaseMessage } from '@sandforge/shared';

function createMockDeps(): HandlerDeps {
  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
    stateSync: {} as HandlerDeps['stateSync'],
    orgManager: {} as HandlerDeps['orgManager'],
    orgRegistry: {} as HandlerDeps['orgRegistry'],
    configStore: {} as HandlerDeps['configStore'],
    secretVault: {} as HandlerDeps['secretVault'],
    authProvider: {} as HandlerDeps['authProvider'],
    sfdxBridge: {} as HandlerDeps['sfdxBridge'],
    nextId: vi.fn().mockReturnValue('test-id'),
  };
}

function createMsg(
  type: string,
  payload: Record<string, unknown> = {},
): BaseMessage & { payload: Record<string, unknown> } {
  return { id: 'req-77', type, timestamp: Date.now(), payload };
}

describe('MigrationHandler', () => {
  let handler: MigrationHandler;
  let deps: HandlerDeps;

  beforeEach(() => {
    deps = createMockDeps();
    handler = new MigrationHandler(deps);
  });

  it('returns false for unknown message types', async () => {
    expect(await handler.handle(createMsg('unknown:type'))).toBe(false);
  });

  it('handles migration:import error when no file reader with correlationId', async () => {
    const result = await handler.handle(
      createMsg('migration:import', { filePath: '/tmp/config.json' }),
    );
    expect(result).toBe(true);

    const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(response.type).toBe('migration:import:response');
    expect(response.correlationId).toBe('req-77');
    expect(response.payload.success).toBe(false);
    expect(response.payload.error).toContain('Migration services not available');
  });

  it('handles migration:import-sfdmu error when no file reader with correlationId', async () => {
    const result = await handler.handle(
      createMsg('migration:import-sfdmu', { filePath: '/tmp/export.json' }),
    );
    expect(result).toBe(true);

    const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(response.type).toBe('migration:import-sfdmu:response');
    expect(response.correlationId).toBe('req-77');
    expect(response.payload.success).toBe(false);
    expect(response.payload.error).toContain('Migration services not available');
  });
});
