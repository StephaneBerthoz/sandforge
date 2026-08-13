import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DataOpsHandler } from './DataOpsHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import type { BaseMessage } from '@sandforge/shared';

/**
 * A backup must be able to leave the machine.
 *
 * dataops:backup writes every object's record array into ConfigStore, which is
 * backed by VSCode globalState. There was no export channel of any kind, so a
 * backup existed only inside one editor installation: not archivable, not
 * transferable, not inspectable outside the extension.
 */

function createDeps(): HandlerDeps & { posted: Record<string, unknown>[] } {
  const values = new Map<string, unknown>();
  const posted: Record<string, unknown>[] = [];
  return {
    log: vi.fn(),
    broker: {
      postToWebview: (m: Record<string, unknown>) => posted.push(m),
    } as unknown as HandlerDeps['broker'],
    stateSync: {} as HandlerDeps['stateSync'],
    orgManager: { getOrg: vi.fn() } as unknown as HandlerDeps['orgManager'],
    orgRegistry: {} as unknown as HandlerDeps['orgRegistry'],
    configStore: {
      get: <T>(key: string) => values.get(key) as T | undefined,
      set: (key: string, value: unknown) => values.set(key, value),
      getKeysByPrefix: (prefix: string) =>
        Array.from(values.keys()).filter((k) => k.startsWith(prefix)),
    } as unknown as HandlerDeps['configStore'],
    secretVault: {} as HandlerDeps['secretVault'],
    authProvider: {} as HandlerDeps['authProvider'],
    sfdxBridge: {} as HandlerDeps['sfdxBridge'],
    nextId: () => 'gen',
    posted,
  } as HandlerDeps & { posted: Record<string, unknown>[] };
}

function msg(type: string, payload: Record<string, unknown>): BaseMessage {
  return { id: 'req-1', type, timestamp: Date.now(), payload } as BaseMessage;
}

describe('backup:export', () => {
  let deps: ReturnType<typeof createDeps>;

  beforeEach(() => {
    deps = createDeps();
    // Exactly what dataops:backup persists: a meta record plus one key per object.
    deps.configStore.set('backup:op-1', {
      orgId: 'org-1',
      timestamp: '2026-01-01T00:00:00Z',
      totalRecords: 2,
      objects: [{ objectApiName: 'Account', recordCount: 2 }],
    });
    deps.configStore.set('backup:op-1:Account', [{ Id: '001a' }, { Id: '001b' }]);
  });

  it('serializes the stored records into a downloadable document', async () => {
    await new DataOpsHandler(deps).handle(
      msg('backup:export', { orgId: 'org-1', operationId: 'op-1' }),
    );

    const result = deps.posted.find((m) => m.type === 'backup:export:result') as
      | { payload: { filename: string; data: string } }
      | undefined;
    expect(result).toBeDefined();
    expect(result?.payload.filename).toContain('op-1');

    const doc = JSON.parse(result!.payload.data) as {
      totalRecords: number;
      objects: Record<string, unknown[]>;
    };
    // The records themselves must travel, not just the summary — a manifest
    // that cannot restore anything is not a backup export.
    expect(doc.totalRecords).toBe(2);
    expect(doc.objects.Account).toHaveLength(2);
  });

  it('refuses to export a backup belonging to another org', async () => {
    await new DataOpsHandler(deps).handle(
      msg('backup:export', { orgId: 'org-OTHER', operationId: 'op-1' }),
    );

    expect(deps.posted.some((m) => m.type === 'backup:export:result')).toBe(false);
    expect(deps.posted.some((m) => m.type === 'dataops:error')).toBe(true);
  });
});
