import { describe, it, expect, vi } from 'vitest';
import type { BaseMessage } from '@sandforge/shared';

import type { HandlerDeps } from './HandlerTypes.js';
import { runGuardedRemoval } from './guardedRemoval.js';
import type { GuardedRemoval } from './guardedRemoval.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';

function deps(orgType: string, guard?: ProductionGuard): HandlerDeps {
  const configStore = new ConfigStore(new InMemoryConfigStoreBackend());
  configStore.initialize();
  let id = 0;
  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() },
    orgManager: { getOrg: vi.fn(() => ({ orgType, alias: 'dev' })) },
    configStore,
    nextId: () => String(++id),
    ...(guard ? { infraServices: { productionGuard: guard } } : {}),
  } as unknown as HandlerDeps;
}

/** A delete of two contacts that deletes both. */
function removal(over: Partial<GuardedRemoval> = {}): GuardedRemoval {
  return {
    orgId: 'org-1',
    operation: 'delete',
    objectNames: ['Contact'],
    recordCount: 2,
    action: 'cleanup_delete',
    description: 'Delete 2 Contact record(s)',
    origin: 'dataops:cleanup:delete',
    run: vi.fn(async (onObject) => {
      const counts = { done: 2, failed: 0, errors: [] };
      onObject('Contact', counts);
      return [{ objectApiName: 'Contact', counts }];
    }),
    ...over,
  };
}

const posted = (d: HandlerDeps): string[] =>
  vi.mocked(d.broker.postToWebview).mock.calls.map((c) => (c[0] as BaseMessage).type);

describe('runGuardedRemoval', () => {
  it('runs on a sandbox, announces the run and records it with the guard’s decision', async () => {
    const d = deps('Sandbox', new ProductionGuard());

    const result = await runGuardedRemoval(d, removal());

    expect(result).toMatchObject({
      ran: true,
      guard: 'allowed',
      outcome: { status: 'success', done: 2 },
    });
    expect(posted(d)).toEqual(['operation:started', 'operation:progress', 'operation:completed']);
    expect(new AuditTrailStore(d.configStore).list().entries).toEqual([
      expect.objectContaining({
        action: 'cleanup_delete',
        module: 'dataops',
        outcome: 'success',
        guard: 'allowed',
        objects: [{ objectApiName: 'Contact', created: 0, updated: 0, deleted: 2, failed: 0 }],
      }),
    ]);
  });

  it('refuses a delete on production before anything runs, and records the stop', async () => {
    const d = deps('Production', new ProductionGuard());
    const run = removal();

    const result = await runGuardedRemoval(d, run);

    expect(result).toMatchObject({ ran: false, guard: 'refused' });
    expect(result.ran === false && result.message).toMatch(
      /^Operation blocked by Production Guard: /,
    );
    expect(run.run).not.toHaveBeenCalled();
    expect(posted(d)).toEqual([]);
    expect(new AuditTrailStore(d.configStore).list().entries[0]).toMatchObject({
      outcome: 'stopped',
      guard: 'refused',
    });
  });

  it('stops when a person turns the production confirmation down', async () => {
    const guard = new ProductionGuard({ requestConfirmation: vi.fn().mockResolvedValue(false) });
    const d = deps('Production', guard);
    const run = removal({ operation: 'update', action: 'subject_erase' });

    const result = await runGuardedRemoval(d, run);

    expect(result).toMatchObject({
      ran: false,
      guard: 'declined',
      message: 'Operation cancelled by user (production confirmation declined).',
    });
    expect(run.run).not.toHaveBeenCalled();
  });

  it('records an erasure in place as updates', async () => {
    const d = deps('Sandbox', new ProductionGuard());

    await runGuardedRemoval(d, removal({ operation: 'update', action: 'subject_erase' }));

    expect(new AuditTrailStore(d.configStore).list().entries[0].objects).toEqual([
      { objectApiName: 'Contact', created: 0, updated: 2, deleted: 0, failed: 0 },
    ]);
  });

  it('records a run that stopped half way as failed, with what it had written', async () => {
    const d = deps('Sandbox', new ProductionGuard());
    const run = removal({
      objectNames: ['Contact', 'Lead'],
      run: async (onObject) => {
        onObject('Contact', { done: 2, failed: 0, errors: [] });
        throw new Error('INVALID_SESSION_ID: Session expired or invalid');
      },
    });

    const result = await runGuardedRemoval(d, run);

    expect(result).toMatchObject({
      ran: true,
      error: 'INVALID_SESSION_ID: Session expired or invalid',
      outcome: { status: 'failure', done: 2 },
    });
    expect(posted(d)).toContain('operation:failed');
    expect(new AuditTrailStore(d.configStore).list().entries[0]).toMatchObject({
      outcome: 'failure',
      objects: [{ objectApiName: 'Contact', deleted: 2 }],
    });
  });

  it('keeps no value and no Id in the audit trail', async () => {
    const d = deps('Sandbox', new ProductionGuard());

    await runGuardedRemoval(
      d,
      removal({
        run: async (onObject) => {
          const counts = {
            done: 1,
            failed: 1,
            errors: [{ objectApiName: 'Contact', message: 'DUPLICATE_VALUE: jane@example.com' }],
          };
          onObject('Contact', counts);
          return [{ objectApiName: 'Contact', counts }];
        },
      }),
    );

    expect(JSON.stringify(d.configStore.get('audit:trail'))).not.toContain('jane@example.com');
  });
});
