import { describe, it, expect, vi } from 'vitest';

// The background composition's guard asks through VS Code's modal; its
// strings stay as the guard words them.
vi.mock('vscode', () => ({
  window: { showWarningMessage: vi.fn(), showInformationMessage: vi.fn() },
  l10n: {
    t: (message: string, ...args: unknown[]): string =>
      message.replace(/\{(\d+)\}/g, (_m, i: string) => String(args[Number(i)] ?? '')),
  },
}));

import * as vscode from 'vscode';
import { OrgSafetyTier, type BaseMessage, type SalesforceOrg } from '@sandforge/shared';

import type { HandlerDeps } from './HandlerTypes.js';
import { runGuardedRemoval } from './guardedRemoval.js';
import type { GuardedRemoval } from './guardedRemoval.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import { LiveOperationTracker } from '../../modules/monitor/LiveOperationTracker.js';
import { deleteRecords } from '../../modules/dataops/RecordRemoval.js';
import { createBackgroundComposition } from '../../composition/backgroundComposition.js';
import { OrgManager } from '../../core/connection/OrgManager.js';
import { OrgRegistry } from '../../core/connection/OrgRegistry.js';
import type { SecretVault } from '../../core/storage/SecretVault.js';

function deps(orgType: string, guard?: ProductionGuard, edition?: string): HandlerDeps {
  const configStore = new ConfigStore(new InMemoryConfigStoreBackend());
  configStore.initialize();
  let id = 0;
  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() },
    orgManager: { getOrg: vi.fn(() => ({ orgType, alias: 'dev', metadata: { edition } })) },
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

  it('runs a cleanup on a Developer Edition org, which an earlier build registered as production', async () => {
    // A Trailhead playground says IsSandbox false: DataOps Cleanup and a DSR
    // erase were refused there as deletes in production.
    for (const orgType of ['Developer', 'Production']) {
      const d = deps(orgType, new ProductionGuard(), 'Developer Edition');
      const run = removal();

      const result = await runGuardedRemoval(d, run);

      expect(result).toMatchObject({ ran: true, guard: 'allowed' });
      expect(run.run).toHaveBeenCalledTimes(1);
    }
  });

  it('still refuses a delete on a production org of any other edition', async () => {
    const d = deps('Production', new ProductionGuard(), 'Enterprise Edition');
    const run = removal();

    expect(await runGuardedRemoval(d, run)).toMatchObject({ ran: false, guard: 'refused' });
    expect(run.run).not.toHaveBeenCalled();
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

  it('refuses to delete without a Production Guard, and records the refusal', async () => {
    // Every other write path refuses without its guard; this one deleted on,
    // to a production org as readily as to a scratch one.
    const d = deps('Production');
    const run = removal();

    const result = await runGuardedRemoval(d, run);

    expect(result).toMatchObject({ ran: false, code: 'NOT_INITIALIZED' });
    expect(result.ran === false && result.message).toMatch(/^Production Guard is not initialized/);
    expect(run.run).not.toHaveBeenCalled();
    expect(posted(d)).toEqual([]);
    expect(new AuditTrailStore(d.configStore).list().entries).toEqual([
      expect.objectContaining({
        action: 'cleanup_delete',
        outcome: 'stopped',
        objects: [],
        details: { code: 'NOT_INITIALIZED' },
      }),
    ]);
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

  describe('a run Live Operations lists and stops', () => {
    /** A sandbox's deps with the registry composition gives every handler. */
    function listed(): { d: HandlerDeps; registry: BackgroundOperationRegistry } {
      const d = deps('Sandbox', new ProductionGuard());
      const registry = new BackgroundOperationRegistry();
      d.infraServices = { ...d.infraServices, backgroundRegistry: registry } as never;
      return { d, registry };
    }

    /** 450 contacts, three calls of 200: Cancel comes while the first is answered. */
    const ids = Array.from({ length: 450 }, (_, i) => `003${String(i).padStart(12, '0')}`);

    it('is listed while it deletes, under the id it is recorded with', async () => {
      const { d, registry } = listed();
      const tracker = new LiveOperationTracker();
      let whileDeleting: unknown;

      const result = await runGuardedRemoval(
        d,
        removal({
          run: async (onObject) => {
            whileDeleting = {
              listed: tracker.getAll().map((op) => ({ ...op })),
              running: registry.getRunning().map((op) => op.operationId),
            };
            const counts = { done: 2, failed: 0, errors: [] };
            onObject('Contact', counts);
            return [{ objectApiName: 'Contact', counts }];
          },
        }),
        tracker,
      );

      expect(whileDeleting).toEqual({
        listed: [
          expect.objectContaining({
            operationId: result.operationId,
            module: 'dataops',
            description: 'Delete 2 Contact record(s)',
            status: 'running',
          }),
        ],
        running: [result.operationId],
      });
      expect(tracker.get(result.operationId)?.status).toBe('completed');
      expect(registry.get(result.operationId)?.status).toBe('completed');
      tracker.dispose();
    });

    it('stops before its next call once cancelled, says so, and records it cancelled with what it deleted', async () => {
      const { d, registry } = listed();
      const tracker = new LiveOperationTracker();
      const destroy = vi.fn(async (_object: string, batch: string[]) => {
        // Live Operations' Cancel, through the registry entry.
        for (const op of registry.getRunning()) registry.abort(op.operationId);
        return batch.map((id) => ({ success: true, id }));
      });

      const result = await runGuardedRemoval(
        d,
        removal({
          recordCount: ids.length,
          run: async (onObject, signal) => {
            const counts = await deleteRecords({ destroy } as never, 'Contact', ids, signal);
            onObject('Contact', counts);
            return [{ objectApiName: 'Contact', counts }];
          },
        }),
        tracker,
      );

      expect(destroy).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ ran: true, cancelled: true, outcome: { done: 200 } });
      expect(result.ran && result.error).toBe(
        'Cancelled: 200 record(s) deleted before the cancel; the rest were left as they are.',
      );
      expect(tracker.get(result.operationId)?.status).toBe('cancelled');
      expect(posted(d)).not.toContain('operation:failed');
      expect(new AuditTrailStore(d.configStore).list().entries).toEqual([
        expect.objectContaining({
          action: 'cleanup_delete',
          outcome: 'cancelled',
          objects: [expect.objectContaining({ objectApiName: 'Contact', deleted: 200 })],
        }),
      ]);
      tracker.dispose();
    });

    it('records a run cancelled before its first call as stopped, under the code that says so', async () => {
      const { d, registry } = listed();

      const result = await runGuardedRemoval(
        d,
        removal({
          run: async (onObject, signal) => {
            for (const op of registry.getRunning()) registry.abort(op.operationId);
            const counts = await deleteRecords(
              { destroy: vi.fn() } as never,
              'Contact',
              ids,
              signal,
            );
            onObject('Contact', counts);
            return [{ objectApiName: 'Contact', counts }];
          },
        }),
      );

      expect(result).toMatchObject({ ran: true, cancelled: true, outcome: { done: 0 } });
      expect(new AuditTrailStore(d.configStore).list().entries).toEqual([
        expect.objectContaining({ outcome: 'stopped', details: { code: 'RUN_CANCELLED' } }),
      ]);
    });
  });
});

describe('runGuardedRemoval on a sandbox marked Staging', () => {
  /*
   * The panel's path, as a run met it live: the org as the registry holds it,
   * the guard of the background composition, and its modal. No type
   * Salesforce gives an org is a staging one: before the mark, a sandbox was
   * a development org, and no delete there asked anything — a full copy
   * holding real data included.
   */
  const SANDBOX: SalesforceOrg = {
    id: 'org-1',
    alias: 'UAT',
    username: 'admin@example.test.uat',
    instanceUrl: 'https://example--uat.sandbox.my.salesforce.com',
    orgId: 'org-1',
    orgType: 'Sandbox',
    sandboxType: 'Full',
    authMethod: 'oauth_web',
    safetyTier: OrgSafetyTier.MEDIUM,
    appearance: { color: '#4a9eff', icon: 'cloud', position: 0 },
    metadata: { apiVersion: '62.0', edition: 'Enterprise Edition', features: [] },
    status: 'connected',
    lastConnected: '2026-10-01T00:00:00.000Z',
    tags: [],
  };

  /** The org registered, marked as given, and the background composition's guard. */
  function onThePanelPath(staging: boolean): HandlerDeps {
    const configStore = new ConfigStore(new InMemoryConfigStoreBackend());
    configStore.initialize();
    const orgManager = new OrgManager();
    const registry = new OrgRegistry(configStore, {} as SecretVault, orgManager);
    registry.updateOrgMetadata({ ...SANDBOX, ...(staging ? { staging: true } : {}) });
    const { productionGuard } = createBackgroundComposition({
      configStore,
      orgNameOf: (orgId) => orgManager.getOrg(orgId)?.alias,
    });
    let id = 0;
    return {
      log: vi.fn(),
      broker: { postToWebview: vi.fn() },
      orgManager,
      configStore,
      nextId: () => String(++id),
      infraServices: { productionGuard },
    } as unknown as HandlerDeps;
  }

  it('asks before a delete, naming the staging org, and its Cancel stops the removal before anything is deleted, recorded as declined', async () => {
    // Cancel, or the modal closed: no button chosen.
    vi.mocked(vscode.window.showWarningMessage)
      .mockReset()
      .mockResolvedValue(undefined as never);
    const d = onThePanelPath(true);
    const run = removal();

    const result = await runGuardedRemoval(d, run);

    expect(result).toMatchObject({ ran: false, guard: 'declined' });
    expect(run.run).not.toHaveBeenCalled();
    expect(posted(d)).toEqual([]);
    const [title, options] = vi.mocked(vscode.window.showWarningMessage).mock.calls[0] as [
      string,
      { modal: boolean; detail: string },
    ];
    expect(title).toBe('SandForge: operation to confirm');
    expect(options.modal).toBe(true);
    expect(options.detail).toContain('Delete 2 records (Contact) in the staging org "UAT".');
    expect(new AuditTrailStore(d.configStore).list().entries).toEqual([
      expect.objectContaining({ outcome: 'stopped', guard: 'declined' }),
    ]);
  });

  it('runs once the question is answered Execute, recorded as confirmed', async () => {
    vi.mocked(vscode.window.showWarningMessage)
      .mockReset()
      .mockResolvedValue('Execute' as never);
    const d = onThePanelPath(true);
    const run = removal();

    expect(await runGuardedRemoval(d, run)).toMatchObject({ ran: true, guard: 'confirmed' });
    expect(run.run).toHaveBeenCalledTimes(1);
  });

  it('asks nothing before the same delete in a sandbox not marked, which runs', async () => {
    vi.mocked(vscode.window.showWarningMessage).mockReset();
    const d = onThePanelPath(false);
    const run = removal();

    expect(await runGuardedRemoval(d, run)).toMatchObject({ ran: true, guard: 'allowed' });
    expect(run.run).toHaveBeenCalledTimes(1);
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });
});
