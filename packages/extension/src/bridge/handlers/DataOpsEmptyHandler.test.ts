import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseMessage, DataOpsEmptyRunResult, ForgeTargetAutomation } from '@sandforge/shared';

import { DataOpsEmptyHandler } from './DataOpsEmptyHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import type { OrgLockOutcome } from '../../modules/checkpoint/OrgCheckpointStore.js';
import { EmptyJournalStore } from '../../modules/dataops/empty/emptyJournal.js';
import { EmptyPreviewStore } from '../../modules/dataops/empty/emptyPreviews.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { MemoryEmptyOrg, SALES, emptySalesSpecs, fakeId } from '../../test/memoryEmptyOrg.js';
import { inboundRequest } from '../../test/mockFactories.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * Emptying objects through the handler the Cleanup page and the command
 * line will send to: a dry run kept under its id, a run that acts on it and
 * is listed, audited and stoppable, its undo, and the refusals each meets —
 * on the memory org that deletes, cascades and keeps a recycle bin as the
 * platform does.
 */

const NOTHING_FIRES = async (
  _orgId: string,
  objects: readonly string[],
): Promise<ForgeTargetAutomation> => ({
  objectsRead: [...objects],
  objects: [],
  unread: [],
  conditionsNotRead: 0,
  conditionsBound: 0,
  requests: 0,
});

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sandforge-empty-handler-'));
  vi.mocked(getJsforceConnection).mockReset();
  vi.mocked(getJsforceConnection).mockResolvedValue({} as never);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function depsOf(
  orgType = 'Sandbox',
  guard = new ProductionGuard(),
  registered: Record<string, unknown> = { alias: 'dev', username: 'admin@example.invalid' },
): HandlerDeps {
  const configStore = new ConfigStore(new InMemoryConfigStoreBackend());
  configStore.initialize();
  let id = 0;
  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() },
    orgManager: {
      getOrg: vi.fn(() => ({ id: 'org-1', orgType, ...registered })),
    },
    orgRegistry: {},
    configStore,
    nextId: () => String(++id),
    infraServices: { productionGuard: guard },
  } as unknown as HandlerDeps;
}

function handlerOn(
  org: MemoryEmptyOrg,
  deps: HandlerDeps,
  previews?: EmptyPreviewStore,
): DataOpsEmptyHandler {
  const handler = new DataOpsEmptyHandler(deps);
  let held = false;
  handler.setStores({
    journals: new EmptyJournalStore(join(root, 'empty')),
    ...(previews ? { previews } : {}),
    lock: (organizationId): OrgLockOutcome => {
      if (held) throw new Error('the lock is taken twice');
      held = true;
      return { lock: { organizationId, release: () => (held = false) } };
    },
  });
  handler.setOrgOf(() => org);
  handler.setTargetAutomation({ read: NOTHING_FIRES });
  return handler;
}

function request(type: string, payload: Record<string, unknown>, id = `req-${type}`) {
  return inboundRequest({ id, type, timestamp: Date.now(), payload });
}

function posted(deps: HandlerDeps): Array<BaseMessage & { payload?: Record<string, unknown> }> {
  return vi
    .mocked(deps.broker.postToWebview)
    .mock.calls.map((call) => call[0] as BaseMessage & { payload?: Record<string, unknown> });
}

function answer<T>(deps: HandlerDeps, type: string): T {
  return posted(deps)
    .filter((message) => message.type === type)
    .at(-1)?.payload as T;
}

const CONTACTS = { mode: 'objects', objects: ['Contact'] };

describe('DataOpsEmptyHandler', () => {
  it('answers the scope from the global describe alone, every object left out with why', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs());
    const deps = depsOf();
    await handlerOn(org, deps).handle(
      request('dataops:empty:scope', { orgId: 'org-1', mode: 'org' }),
    );

    const scope = answer<{
      objects: string[];
      leftOut: Array<{ objectApiName: string; reason: string }>;
    }>(deps, 'dataops:empty:scope:response');
    expect(scope.objects).toContain('Account');
    expect(scope.leftOut).toContainEqual(
      expect.objectContaining({ objectApiName: 'ApexClass', reason: 'metadata' }),
    );
    expect(org.sent).toEqual([]);
  });

  it('says with the scope whether the user may delete for good, as the org answers it now', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs());
    const deps = depsOf();
    const handler = handlerOn(org, deps);
    await handler.handle(request('dataops:empty:scope', { orgId: 'org-1', mode: 'org' }, 'a'));
    expect(
      answer<{ hardDelete: unknown; tier: string }>(deps, 'dataops:empty:scope:response'),
    ).toMatchObject({ hardDelete: { permitted: false }, tier: 'development' });

    // Granted since: the next scope reads it again rather than keeping the first answer.
    org.hardDeletePermitted = true;
    await handler.handle(request('dataops:empty:scope', { orgId: 'org-1', mode: 'org' }, 'b'));
    expect(
      answer<{ hardDelete: unknown }>(deps, 'dataops:empty:scope:response').hardDelete,
    ).toEqual({ permitted: true });
    expect(org.sent).toEqual([]);
  });

  it('lists what may be picked in a sandbox marked Staging, whose whole it refuses', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs());
    const deps = depsOf();
    vi.mocked(deps.orgManager.getOrg).mockReturnValue({
      id: 'org-1',
      orgType: 'Sandbox',
      staging: true,
      alias: 'uat',
      username: 'admin@example.invalid',
    } as never);
    const handler = handlerOn(org, deps);

    // Nothing picked yet: the objects a pick is made among.
    await handler.handle(
      request('dataops:empty:scope', { orgId: 'org-1', mode: 'objects', objects: [] }, 'a'),
    );
    const scope = answer<{ candidates: string[]; objects: string[]; tier: string }>(
      deps,
      'dataops:empty:scope:response',
    );
    expect(scope.candidates).toContain('Account');
    expect(scope.objects).toEqual([]);
    expect(scope.tier).toBe('staging');

    await handler.handle(request('dataops:empty:scope', { orgId: 'org-1', mode: 'org' }, 'b'));
    expect(answer<{ code: string }>(deps, 'dataops:error').code).toBe('STAGING_ORG');
    expect(org.sent).toEqual([]);
  });

  it('keeps the dry run under its id, and a run on it deletes, is audited, and is answered with its result', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs());
    const deps = depsOf();
    const handler = handlerOn(org, deps);
    await handler.handle(
      request('dataops:empty:preview', {
        orgId: 'org-1',
        request: CONTACTS,
        deleteMode: 'recycle',
      }),
    );
    const preview = answer<{
      previewId: string;
      refusals: unknown[];
      preview: { total: { records: number } };
    }>(deps, 'dataops:empty:preview:response');
    expect(preview.refusals).toEqual([]);
    expect(preview.preview.total.records).toBe(3);

    await handler.handle(
      request('dataops:empty:run', { orgId: 'org-1', previewId: preview.previewId }, 'run-1'),
    );

    const result = answer<{ operationId: string; result: DataOpsEmptyRunResult }>(
      deps,
      'dataops:empty:run:response',
    );
    expect(result.operationId).toBe('run-1');
    expect(result.result.status).toBe('success');
    expect(org.live('Contact')).toEqual([]);
    expect(new AuditTrailStore(deps.configStore).list().entries[0]).toMatchObject({
      action: 'cleanup_delete',
      module: 'dataops',
      outcome: 'success',
      guard: 'allowed',
      objects: [{ objectApiName: 'Contact', deleted: 3 }],
      details: { empty: 'run', mode: 'objects', deleteMode: 'recycle' },
    });

    // A preview is acted on once.
    await handler.handle(
      request('dataops:empty:run', { orgId: 'org-1', previewId: preview.previewId }, 'run-2'),
    );
    expect(answer<{ code: string }>(deps, 'dataops:error').code).toBe('PREVIEW_GONE');
  });

  it('brings back with its undo what the run deleted, audited apart', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs());
    const deps = depsOf();
    const handler = handlerOn(org, deps);
    await handler.handle(
      request('dataops:empty:preview', {
        orgId: 'org-1',
        request: CONTACTS,
        deleteMode: 'recycle',
      }),
    );
    const { previewId } = answer<{ previewId: string }>(deps, 'dataops:empty:preview:response');
    await handler.handle(request('dataops:empty:run', { orgId: 'org-1', previewId }, 'run-1'));
    const { result } = answer<{ result: DataOpsEmptyRunResult }>(
      deps,
      'dataops:empty:run:response',
    );

    await handler.handle(
      request('dataops:empty:undo', { orgId: 'org-1', runId: result.runId }, 'undo-1'),
    );

    expect(
      answer<{ result: { status: string } }>(deps, 'dataops:empty:undo:response').result.status,
    ).toBe('success');
    expect(org.live('Contact')).toHaveLength(3);
    // An action of its own: under `cleanup_delete`, a delete's, it read as
    // three records a cleanup created.
    expect(new AuditTrailStore(deps.configStore).list().entries[0]).toMatchObject({
      action: 'empty_undo',
      outcome: 'success',
      objects: [{ objectApiName: 'Contact', created: 3 }],
      details: { empty: 'undo', runId: result.runId },
    });
  });

  it('acts on a preview kept on disk from another window, as after a reload, and on it once', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs());
    const previews = new EmptyPreviewStore(join(root, 'previews'));
    const before = depsOf();
    await handlerOn(org, before, previews).handle(
      request('dataops:empty:preview', {
        orgId: 'org-1',
        request: CONTACTS,
        deleteMode: 'recycle',
      }),
    );
    const { previewId } = answer<{ previewId: string }>(before, 'dataops:empty:preview:response');

    // The window reloaded: a new handler, nothing of the preview in its memory.
    const after = depsOf();
    const reloaded = handlerOn(org, after, previews);
    await reloaded.handle(request('dataops:empty:run', { orgId: 'org-1', previewId }, 'run-1'));
    expect(
      answer<{ result: DataOpsEmptyRunResult }>(after, 'dataops:empty:run:response').result.status,
    ).toBe('success');
    expect(org.live('Contact')).toEqual([]);

    await reloaded.handle(request('dataops:empty:run', { orgId: 'org-1', previewId }, 'run-2'));
    expect(answer<{ code: string }>(after, 'dataops:error').code).toBe('PREVIEW_GONE');
  });

  it('acts on no preview past its day, in the window as on disk', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs());
    const deps = depsOf();
    const handler = handlerOn(org, deps);
    await handler.handle(
      request('dataops:empty:preview', {
        orgId: 'org-1',
        request: CONTACTS,
        deleteMode: 'recycle',
      }),
    );
    const { previewId } = answer<{ previewId: string }>(deps, 'dataops:empty:preview:response');
    const now = Date.now();
    const later = vi.spyOn(Date, 'now').mockReturnValue(now + 24 * 60 * 60_000 + 1_000);
    try {
      await handler.handle(request('dataops:empty:run', { orgId: 'org-1', previewId }, 'run-1'));
    } finally {
      later.mockRestore();
    }
    expect(answer<{ code: string }>(deps, 'dataops:error').code).toBe('PREVIEW_GONE');
    expect(org.live('Contact')).toHaveLength(3);
  });

  it('acts on no preview of another registered org', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs());
    const previews = new EmptyPreviewStore(join(root, 'previews'));
    const deps = depsOf();
    await handlerOn(org, deps, previews).handle(
      request('dataops:empty:preview', {
        orgId: 'org-1',
        request: CONTACTS,
        deleteMode: 'recycle',
      }),
    );
    const { previewId } = answer<{ previewId: string }>(deps, 'dataops:empty:preview:response');
    const other = depsOf();
    await handlerOn(org, other, previews).handle(
      request('dataops:empty:run', { orgId: 'org-2', previewId }, 'run-1'),
    );
    expect(answer<{ code: string }>(other, 'dataops:error').code).toBe('PREVIEW_GONE');
    expect(org.live('Contact')).toHaveLength(3);
  });

  it('is a write to the org while a run deletes, its own act left out, and none once it ended', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs());
    const deps = depsOf();
    const handler = handlerOn(org, deps);
    await handler.handle(
      request('dataops:empty:preview', {
        orgId: 'org-1',
        request: CONTACTS,
        deleteMode: 'recycle',
      }),
    );
    const { previewId } = answer<{ previewId: string }>(deps, 'dataops:empty:preview:response');
    // The preview reads: it is no write.
    expect(handler.isWritingTo('org-1')).toBe(false);
    const seen: Array<[boolean, boolean, boolean]> = [];
    org.beforeDelete = () => {
      seen.push([
        handler.isWritingTo('org-1'),
        handler.isWritingTo('org-1', 'run-1'),
        handler.isWritingTo('org-2'),
      ]);
    };

    await handler.handle(request('dataops:empty:run', { orgId: 'org-1', previewId }, 'run-1'));

    expect(seen[0]).toEqual([true, false, false]);
    expect(handler.isWritingTo('org-1')).toBe(false);
  });

  it('runs on the work of the people its preview named, ticked on the page', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs());
    org.memory.edit('Contact', SALES.contactAlone, { Title: 'x' }, fakeId('005', 77));
    const deps = depsOf();
    const handler = handlerOn(org, deps);
    await handler.handle(
      request('dataops:empty:preview', {
        orgId: 'org-1',
        request: CONTACTS,
        deleteMode: 'recycle',
        fromPage: true,
      }),
    );
    const preview = answer<{
      previewId: string;
      refusals: Array<{ code: string; message: string }>;
      peopleActive: { people: number; who?: Array<{ userId: string }> };
    }>(deps, 'dataops:empty:preview:response');
    // Eighteen characters, as the API gives every other id.
    expect(preview.peopleActive.who?.map((person) => person.userId)).toEqual([fakeId('005', 77)]);
    expect(preview.refusals.map((refusal) => refusal.code)).toContain('PEOPLE_ACTIVE');

    await handler.handle(
      request(
        'dataops:empty:run',
        {
          orgId: 'org-1',
          previewId: preview.previewId,
          acceptAutomation: true,
          acceptPeopleActive: true,
          fromPage: true,
        },
        'run-1',
      ),
    );
    expect(
      answer<{ result: DataOpsEmptyRunResult }>(deps, 'dataops:empty:run:response').result.status,
    ).toBe('success');
  });

  it('names an org with no alias of its own by its name, never by the username its alias holds', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs());
    const deps = depsOf('Sandbox', new ProductionGuard(), {
      alias: 'admin@example.invalid',
      username: 'admin@example.invalid',
      orgId: '00D000000000001AAA',
      organizationName: 'Example Sandbox',
    });
    await handlerOn(org, deps).handle(
      request('dataops:empty:preview', {
        orgId: 'org-1',
        request: { mode: 'org' },
        deleteMode: 'recycle',
        fromPage: true,
      }),
    );
    const preview = answer<{ orgName: string; refusals: Array<{ message: string }> }>(
      deps,
      'dataops:empty:preview:response',
    );
    expect(preview.orgName).toBe('Example Sandbox');
    expect(JSON.stringify(preview)).not.toContain('admin@example.invalid');
  });

  it('refuses a production org, its Production Guard override set, and never asks the guard', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs());
    const guard = new ProductionGuard();
    guard.setProductionOverride('org-1', true);
    const check = vi.spyOn(guard, 'check');
    const deps = depsOf('Production', guard);
    const handler = handlerOn(org, deps);

    await handler.handle(
      request('dataops:empty:preview', {
        orgId: 'org-1',
        request: CONTACTS,
        deleteMode: 'recycle',
      }),
    );

    expect(answer<{ code: string }>(deps, 'dataops:error').code).toBe('PRODUCTION');
    expect(check).not.toHaveBeenCalled();
    expect(org.sent).toEqual([]);
  });

  it('stops a run under way on its cancel, before its next call, and records it cancelled', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs());
    const deps = depsOf();
    const handler = handlerOn(org, deps);
    await handler.handle(
      request('dataops:empty:preview', {
        orgId: 'org-1',
        request: { mode: 'objects', objects: ['Contact', 'Opportunity'] },
        deleteMode: 'recycle',
      }),
    );
    const { previewId } = answer<{ previewId: string }>(deps, 'dataops:empty:preview:response');
    org.beforeDelete = (_via, objectApiName) => {
      // The call the org has is let finish; the next one is never sent.
      if (objectApiName === 'Contact') {
        void handler.handle(request('dataops:empty:cancel', { operationId: 'run-1' }));
      }
    };

    await handler.handle(request('dataops:empty:run', { orgId: 'org-1', previewId }, 'run-1'));

    expect(answer<{ cancelled: boolean }>(deps, 'dataops:empty:cancel:response').cancelled).toBe(
      true,
    );
    expect(
      answer<{ result: DataOpsEmptyRunResult }>(deps, 'dataops:empty:run:response').result.status,
    ).toBe('cancelled');
    expect(org.live('Contact')).toEqual([]);
    expect(org.live('Opportunity')).toContain(SALES.opportunityAlone);
    expect(org.sent.map((sent) => sent.objectApiName)).toEqual(['Contact']);
    expect(new AuditTrailStore(deps.configStore).list().entries[0]).toMatchObject({
      outcome: 'cancelled',
      details: { empty: 'run', cancelled: true },
    });
  });

  it('refuses a malformed request before it reads anything', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs());
    const deps = depsOf();
    await handlerOn(org, deps).handle(
      request('dataops:empty:run', {
        orgId: 'org-1',
        previewId: 'ep-1',
        resumeRunId: 'em-20261112-100000-abcd',
      }),
    );
    expect(answer<{ code: string }>(deps, 'dataops:error').code).toBe('INVALID_PAYLOAD');
    expect(getJsforceConnection).not.toHaveBeenCalled();
  });
});
