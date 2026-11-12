import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type {
  DataOpsEmptyPreview,
  ForgeTargetAutomation,
  OrgTypeAndEdition,
} from '@sandforge/shared';

import {
  AUTOMATED_PROCESS_USER,
  MemoryEmptyOrg,
  NO_HARD_DELETE,
  SALES,
  emptySalesSpecs,
  fakeId,
} from '../../../test/memoryEmptyOrg.js';
import { ProductionGuard } from '../../../core/precheck/ProductionGuard.js';
import { consultProductionGuard } from '../../../core/precheck/consultProductionGuard.js';
import type { OrgLockOutcome } from '../../checkpoint/OrgCheckpointStore.js';
import type { DataOpsAutomationOrg } from '../dataOpsAutomation.js';
import {
  changedSince,
  previewEmptyAct,
  runEmptyAct,
  undoEmptyAct,
  type EmptyActContext,
  type EmptyKeptPreview,
} from './emptyAct.js';
import { EmptyJournalStore } from './emptyJournal.js';
import type { EmptyPreview } from './emptyPreview.js';
import type { EmptyScopeRequest } from './emptyScope.js';

vi.mock('../../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * An emptying from its dry run to its undo, on the memory org that holds to
 * what Salesforce was seen to do: an account's delete takes its contacts,
 * opportunities, orders and tasks along and refuses while a case names it;
 * an activated order refuses its delete until it is a draft again (P8); a
 * restricted lookup refuses the delete of what it names while it lives (G1);
 * what goes with its parent comes back with it (P7), and what went alone
 * before a record it names does not (F41); a hardDelete job is refused to a
 * user without Bulk API Hard Delete, `FEATURENOTENABLED`, and what one
 * deletes reads deleted and never comes back (probes of 12/11).
 */

const SANDBOX: OrgTypeAndEdition = { orgType: 'Sandbox' };

/** What fires on these objects: nothing, as an org without automation answers. */
const NOTHING_FIRES = (objects: readonly string[]): ForgeTargetAutomation => ({
  objectsRead: [...objects],
  objects: [],
  unread: [],
  conditionsNotRead: 0,
  conditionsBound: 0,
  requests: 0,
});

/** What an emptying reads of what fires: nothing, unless a test says. */
function quietOrg(read = NOTHING_FIRES): DataOpsAutomationOrg {
  return {
    readAutomation: async (objects) => read(objects),
    readLimits: async () => ({}),
    readDeliverability: async () => ({ reading: { unread: 'not read in a test' }, requests: 0 }),
    muteOrg: async () => {
      throw new Error('no mute in this test');
    },
  };
}

/** One lock of the org, as the store's: busy while held. */
function oneLock(): { lock: (organizationId: string) => OrgLockOutcome; held: () => boolean } {
  let held = false;
  return {
    lock: (organizationId) => {
      if (held) {
        return {
          busy: {
            pid: 1,
            host: 'here',
            startedAt: new Date().toISOString(),
            acquiredAt: new Date().toISOString(),
            operation: 'rewind',
          } as never,
        };
      }
      held = true;
      return { lock: { organizationId, release: () => (held = false) } };
    },
    held: () => held,
  };
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sandforge-empty-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A context of the act on `org`, Production Guard allowing it unless a test says. */
function contextOf(org: MemoryEmptyOrg, extra: Partial<EmptyActContext> = {}): EmptyActContext {
  return {
    org,
    orgId: 'org-1',
    orgName: 'dev',
    username: 'admin@example.invalid',
    registered: SANDBOX,
    store: new EmptyJournalStore(join(root, 'empty')),
    lock: oneLock().lock,
    automation: quietOrg(),
    askGuard: async () => ({ decision: 'allowed' }),
    operationId: 'op-1',
    tool: 'panel',
    ...extra,
  };
}

/** The dry run of `request`, kept, or the test fails. */
async function previewed(
  context: EmptyActContext,
  request: EmptyScopeRequest,
  deleteMode: 'recycle' | 'hard' = 'recycle',
): Promise<EmptyKeptPreview> {
  const answer = await previewEmptyAct(context, { request, deleteMode, accord: {} });
  if (!answer.previewed) throw new Error(`refused: ${answer.refusal.message}`);
  return answer.kept;
}

const ACCOUNTS_AND_CONTACTS: EmptyScopeRequest = {
  mode: 'objects',
  objects: ['Account', 'Contact'],
};

describe('the shared contract', () => {
  it('sends a preview whose every field the shared type of the page declares', () => {
    expectTypeOf<EmptyPreview>().toExtend<DataOpsEmptyPreview>();
  });
});

describe('production is refused, whatever is set', () => {
  it('refuses an org the registry holds as production, and reads nothing of it', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs());
    const query = vi.spyOn(org, 'query');
    const answer = await previewEmptyAct(
      contextOf(org, { registered: { orgType: 'Production' } }),
      {
        request: ACCOUNTS_AND_CONTACTS,
        deleteMode: 'recycle',
        accord: {},
      },
    );

    expect(answer.previewed).toBe(false);
    expect(!answer.previewed && answer.refusal.code).toBe('PRODUCTION');
    expect(query).not.toHaveBeenCalled();
  });

  it('refuses an org the registry has as a sandbox that says live it is a production org', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs(), {
      production: { edition: 'Enterprise Edition' },
    });
    const answer = await previewEmptyAct(contextOf(org), {
      request: ACCOUNTS_AND_CONTACTS,
      deleteMode: 'recycle',
      accord: {},
    });

    expect(!answer.previewed && answer.refusal.message).toContain(
      'its Organization record says IsSandbox false, edition Enterprise Edition',
    );
  });

  it('never reaches Production Guard for a production org, its override set to let a delete through', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs());
    const context = contextOf(org);
    const kept = await previewed(context, ACCOUNTS_AND_CONTACTS);
    const guard = new ProductionGuard();
    guard.setProductionOverride('org-1', true);
    const check = vi.spyOn(guard, 'check');
    const production = contextOf(org, {
      registered: { orgType: 'Production' },
      askGuard: async (question) => {
        const { decision } = await consultProductionGuard(guard, {
          orgId: 'org-1',
          orgTier: 'production',
          operation: question.operation,
          objectName: question.objectNames.join(', '),
          recordCount: question.recordCount,
          module: 'dataops',
        });
        return { decision };
      },
    });

    const answer = await runEmptyAct(production, { confirmed: kept, accord: {} });

    expect(!answer.ran && answer.refusal.code).toBe('PRODUCTION');
    expect(check).not.toHaveBeenCalled();
    expect(org.sent).toEqual([]);
    expect(org.live('Account')).toHaveLength(2);
  });

  it('refuses the whole of a sandbox marked Staging, and asks Production Guard about objects picked there', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs());
    const staging = { orgType: 'Sandbox', staging: true };
    const whole = await previewEmptyAct(contextOf(org, { registered: staging }), {
      request: { mode: 'org' },
      deleteMode: 'recycle',
      accord: {},
    });
    expect(!whole.previewed && whole.refusal.code).toBe('STAGING_ORG');

    const askGuard = vi.fn(async () => ({ decision: 'declined' as const }));
    const context = contextOf(org, { registered: staging, askGuard });
    const kept = await previewed(context, { mode: 'objects', objects: ['Contact'] });
    const answer = await runEmptyAct(context, { confirmed: kept, accord: {} });

    expect(askGuard).toHaveBeenCalledWith(expect.objectContaining({ operation: 'delete' }));
    expect(!answer.ran && answer.refusal.code).toBe('GUARD');
    expect(org.sent).toEqual([]);
  });
});

describe('a run, and its undo', () => {
  it('empties the objects picked in the preview order, keeps the standard price book, and says what a blocker kept', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs());
    const context = contextOf(org);
    const kept = await previewed(context, {
      mode: 'objects',
      objects: ['Contact', 'Opportunity', 'Pricebook2'],
    });
    // The order not emptied names the custom price book: the preview says it blocks.
    expect(kept.preview.blockers).toContainEqual(
      expect.objectContaining({
        objectApiName: 'Order',
        field: 'Pricebook2Id',
        records: { records: 1 },
      }),
    );
    // An opportunity goes before the price book it names: no undo brings it back after.
    const answer = await runEmptyAct(context, { confirmed: kept, accord: {}, acceptNoUndo: true });

    expect(answer.ran).toBe(true);
    if (!answer.ran) return;
    expect(answer.result.status).toBe('partial');
    expect(org.live('Contact')).toEqual([]);
    expect(org.live('Opportunity')).toEqual([]);
    expect(org.live('Pricebook2')).toEqual([SALES.standardBook, SALES.customBook]);
    const books = answer.result.passes.find((pass) => pass.objectApiName === 'Pricebook2');
    expect(books).toMatchObject({ planned: 1, deleted: 0, refused: 1 });
    expect(books?.reasons.join(' ')).toContain('DELETE_FAILED');
    // Opportunities go before the price book they name, as the platform requires.
    const order = answer.result.passes.map((pass) => pass.objectApiName);
    expect(order.indexOf('Opportunity')).toBeLessThan(order.indexOf('Pricebook2'));
    expect(answer.result.undo).toEqual({ offered: true });
  });

  it('sends what each pass reads at its turn: contacts an account took along are not sent again', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs());
    const context = contextOf(org, { automation: quietOrg() });
    // Account alone is blocked by its case; the case is emptied with it here.
    const kept = await previewed(context, {
      mode: 'objects',
      objects: ['Account', 'Contact', 'Case', 'Order'],
    });
    const answer = await runEmptyAct(context, { confirmed: kept, accord: {}, acceptNoUndo: true });

    expect(answer.ran && answer.result.status).toBe('success');
    const contacts = org.sent
      .filter((sent) => sent.objectApiName === 'Contact')
      .flatMap((s) => s.ids);
    expect(contacts).toEqual([SALES.contactAlone]);
    expect(org.live('Account')).toEqual([]);
    expect(org.live('Contact')).toEqual([]);
  });

  it('sets an activated order back to Draft first, and deletes it', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs());
    const context = contextOf(org);
    const kept = await previewed(context, { mode: 'objects', objects: ['Order'] });
    const answer = await runEmptyAct(context, { confirmed: kept, accord: {} });

    expect(answer.ran && answer.result.status).toBe('success');
    expect(org.live('Order')).toEqual([]);
    expect(org.memory.updates.flatMap((update) => update.records)).toContainEqual({
      Id: SALES.activatedOrder,
      Status: 'Draft',
    });
  });

  it('sets the activated orders going along with an account back to Draft, so that the account goes', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs());
    const context = contextOf(org);
    const kept = await previewed(context, { mode: 'objects', objects: ['Account', 'Case'] });
    expect(kept.preview.toDraftAlong).toEqual([
      { objectApiName: 'Order', condition: 'AccountId != null' },
    ]);
    const answer = await runEmptyAct(context, { confirmed: kept, accord: {}, acceptNoUndo: true });

    expect(answer.ran && answer.result.status).toBe('success');
    expect(org.live('Account')).toEqual([]);
    expect(org.live('Order')).toEqual([]);
  });

  it('leaves what was made after the preview read the org, and says how many', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs());
    const context = contextOf(org);
    const kept = await previewed(context, { mode: 'objects', objects: ['Contact'] });
    org.advance(5_000);
    org.addNow('Contact', { Id: fakeId('003', 50), AccountId: null });
    const answer = await runEmptyAct(context, { confirmed: kept, accord: {} });

    expect(answer.ran).toBe(true);
    if (!answer.ran) return;
    expect(org.live('Contact')).toEqual([fakeId('003', 50)]);
    expect(answer.result.passes.find((pass) => pass.objectApiName === 'Contact')?.madeSince).toBe(
      1,
    );
  });

  it('brings back with Undo, parents first, everything the run deleted and what went along', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs());
    const context = contextOf(org);
    const kept = await previewed(context, {
      mode: 'objects',
      objects: ['Account', 'Contact', 'Case', 'Order'],
    });
    const run = await runEmptyAct(context, { confirmed: kept, accord: {}, acceptNoUndo: true });
    if (!run.ran) throw new Error(run.refusal.message);
    expect(org.live('Opportunity')).toEqual([SALES.opportunityAlone]);

    const undone = await undoEmptyAct(context, { runId: run.result.runId, accord: {} });

    expect(undone.ran).toBe(true);
    if (!undone.ran) return;
    // The case went alone before its account: it stays in the bin for good (F41).
    expect(undone.result.objects.find((o) => o.objectApiName === 'Case')).toMatchObject({
      notInBin: 1,
    });
    expect(org.live('Account').sort()).toEqual([SALES.account1, SALES.account2].sort());
    expect(org.live('Contact').sort()).toEqual(
      [SALES.contact1, SALES.contact2, SALES.contactAlone].sort(),
    );
    // What went along with the accounts came back with them.
    expect(org.live('Opportunity').sort()).toEqual(
      [SALES.opportunity1, SALES.opportunityAlone].sort(),
    );
    expect(org.live('Task')).toContain(SALES.taskOfAccount1);
    expect(undone.result.status).toBe('partial');
    // Done once: a second undo is refused.
    const again = await undoEmptyAct(context, { runId: run.result.runId, accord: {} });
    expect(!again.ran && again.refusal.code).toBe('UNDO_UNAVAILABLE');
  });

  it('names what does not come back: what was emptied from the recycle bin', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs());
    const context = contextOf(org);
    const kept = await previewed(context, { mode: 'objects', objects: ['Contact'] });
    const run = await runEmptyAct(context, { confirmed: kept, accord: {} });
    if (!run.ran) throw new Error(run.refusal.message);
    org.memory.empty(SALES.contactAlone);

    const undone = await undoEmptyAct(context, { runId: run.result.runId, accord: {} });

    expect(undone.ran && undone.result.status).toBe('partial');
    if (!undone.ran) return;
    expect(undone.result.objects).toEqual([
      expect.objectContaining({ objectApiName: 'Contact', undeleted: 2, notInBin: 1 }),
    ]);
  });

  it('names a record another user deleted, which only Modify All Data brings back', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs());
    const context = contextOf(org);
    const kept = await previewed(context, { mode: 'objects', objects: ['Contact'] });
    const run = await runEmptyAct(context, { confirmed: kept, accord: {} });
    if (!run.ran) throw new Error(run.refusal.message);
    // The undo is sent as another user than the one who emptied.
    org.memory.othersDeletionsRefused = true;
    const undelete = org.memory.undelete.bind(org.memory);
    vi.spyOn(org, 'undelete').mockImplementation(async (ids) => {
      const answers = (await undelete([])) as unknown[];
      void answers;
      return ids.map(() => ({
        success: false,
        errors: [
          {
            statusCode: 'INSUFFICIENT_ACCESS_OR_READONLY',
            message: 'insufficient access rights on object id',
          },
        ],
      }));
    });

    const undone = await undoEmptyAct(context, { runId: run.result.runId, accord: {} });

    expect(undone.ran && undone.result.status).toBe('failure');
    if (!undone.ran) return;
    expect(undone.result.objects[0]).toMatchObject({ othersDeletion: 3, undeleted: 0 });
    expect(undone.result.objects[0].reasons[0]).toContain('only Modify All Data');
  });
});

describe('a cancel, and its resume', () => {
  it('stops before the next call, leaves the run open, and refuses another run until it is resumed', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs());
    const stop = new AbortController();
    const context = contextOf(org, { signal: stop.signal });
    const kept = await previewed(contextOf(org), {
      mode: 'objects',
      objects: ['Contact', 'Opportunity'],
    });
    org.beforeDelete = (_via, objectApiName) => {
      if (objectApiName === 'Opportunity') stop.abort();
    };
    const answer = await runEmptyAct(context, { confirmed: kept, accord: {} });

    expect(answer.ran && answer.result.status).toBe('cancelled');
    if (!answer.ran) return;
    const runId = answer.result.runId;

    // Another run is refused while this one is open.
    const other = await previewed(contextOf(org), { mode: 'objects', objects: ['Case'] });
    const refused = await runEmptyAct(contextOf(org), { confirmed: other, accord: {} });
    expect(!refused.ran && refused.refusal.code).toBe('OPEN_RUN');

    // Taken up: what was deleted answers gone, nothing is sent twice.
    org.beforeDelete = undefined;
    const sentBefore = org.sent.length;
    const resumed = await runEmptyAct(contextOf(org), { resumeRunId: runId, accord: {} });

    expect(resumed.ran && resumed.result.status).toBe('success');
    if (!resumed.ran) return;
    expect(resumed.result.resumed).toBe(true);
    expect(org.live('Opportunity')).toEqual([]);
    expect(org.live('Contact')).toEqual([]);
    const resent = org.sent.slice(sentBefore).flatMap((sent) => sent.ids);
    expect(resent).not.toContain(SALES.contactAlone);
  });

  it('brings back with Undo what a run stopped part way had deleted', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs());
    const stop = new AbortController();
    const kept = await previewed(contextOf(org), {
      mode: 'objects',
      objects: ['Contact', 'Opportunity'],
    });
    org.beforeDelete = (_via, objectApiName) => {
      if (objectApiName === 'Opportunity') stop.abort();
    };
    const answer = await runEmptyAct(contextOf(org, { signal: stop.signal }), {
      confirmed: kept,
      accord: {},
    });
    if (!answer.ran) throw new Error(answer.refusal.message);

    const undone = await undoEmptyAct(contextOf(org), { runId: answer.result.runId, accord: {} });

    expect(undone.ran && undone.result.status).toBe('success');
    expect(org.live('Contact')).toHaveLength(3);
  });
});

describe('checkpoint first, and the jobs the org may still run', () => {
  /** The window's checkpoints, as a test holds them: what each step saw of the org. */
  function checkpointsOf(
    org: MemoryEmptyOrg,
    refusal?: { code: 'TOO_MANY_RECORDS'; message: string },
  ) {
    const seen: string[] = [];
    const estimate = {
      state: 'planned' as const,
      estimate: { records: 3, bytes: 300, requests: 4, seconds: 2 } as never,
      objects: ['Contact'],
      added: [],
      notHeld: [],
      keepDays: 7,
      ...(refusal ? { refusal } : {}),
    };
    const taken = {
      state: 'taken' as const,
      checkpointId: 'ck-20261112-100000-a1b2',
      name: 'Before emptying',
      takenAt: '2026-11-12T10:00:00.000Z',
      expiresAt: null,
      objects: ['Contact'],
      records: 3,
      bytes: 300,
    } as never;
    return {
      seen,
      port: {
        scope: vi.fn(async (_ask: { module: string; written: readonly string[] }) => estimate),
        take: vi.fn(async () => {
          seen.push(`take, ${org.sent.length} delete(s) sent`);
          return { taken: true as const, checkpoint: taken };
        }),
        settle: vi.fn(async (_taken: unknown, wrote: boolean) => {
          seen.push(`settle, wrote ${String(wrote)}`);
          return taken;
        }),
      },
    };
  }

  it('takes the checkpoint before the first delete, and keeps it once the run deleted', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs());
    const { seen, port } = checkpointsOf(org);
    const context = contextOf(org, { checkpoints: port });
    const kept = await previewed(context, { mode: 'objects', objects: ['Contact'] });
    const answer = await runEmptyAct(context, {
      confirmed: kept,
      accord: {},
      checkpointFirst: true,
    });

    expect(answer.ran && answer.result.checkpoint).toMatchObject({ state: 'taken' });
    expect(seen).toEqual(['take, 0 delete(s) sent', 'settle, wrote true']);
    expect(port.scope.mock.calls[0][0]).toMatchObject({ module: 'empty', written: ['Contact'] });
  });

  it('is refused, and nothing deleted, past what a checkpoint holds', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs());
    const { port } = checkpointsOf(org, {
      code: 'TOO_MANY_RECORDS',
      message: 'A checkpoint holds 500,000 records at most.',
    });
    const context = contextOf(org, { checkpoints: port });
    const kept = await previewed(context, { mode: 'objects', objects: ['Contact'] });
    const answer = await runEmptyAct(context, {
      confirmed: kept,
      accord: {},
      checkpointFirst: true,
    });

    expect(!answer.ran && answer.refusal.code).toBe('TOO_MANY_RECORDS');
    expect(port.take).not.toHaveBeenCalled();
    expect(org.sent).toEqual([]);
  });

  it('waits for the jobs the org may still be running before it gives anything back', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs());
    org.lost = [{ orgId: 'org-1', objectApiName: 'Contact', jobId: '750000000000001AAA' }];
    const context = contextOf(org);
    const kept = await previewed(context, { mode: 'objects', objects: ['Contact'] });
    await runEmptyAct(context, { confirmed: kept, accord: {} });

    expect(org.waitedFor).toEqual([
      [{ orgId: 'org-1', objectApiName: 'Contact', jobId: '750000000000001AAA' }],
    ]);
  });
});

describe('a delete for good', () => {
  it('is refused before anything is read to a user without Bulk API Hard Delete', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs());
    const context = contextOf(org);
    const answer = await previewEmptyAct(context, {
      request: { mode: 'objects', objects: ['Contact'] },
      deleteMode: 'hard',
      accord: {},
    });
    expect(answer.previewed).toBe(true);
    if (!answer.previewed) return;
    expect(answer.kept.hardDelete).toEqual({ permitted: false });
    expect(answer.refusals.map((refusal) => refusal.code)).toContain('HARD_DELETE_NOT_PERMITTED');

    const run = await runEmptyAct(context, { confirmed: answer.kept, accord: {} });
    expect(!run.ran && run.refusal.code).toBe('HARD_DELETE_NOT_PERMITTED');
    expect(org.sent).toEqual([]);
  });

  it("stops at the job the org refuses, FEATURENOTENABLED, in the org's words, and sends nothing to the bin in its place", async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs(), { hardDelete: true });
    const context = contextOf(org);
    const kept = await previewed(context, { mode: 'objects', objects: ['Contact'] }, 'hard');
    // The right is taken back between the preview and the job.
    org.hardDeletePermitted = false;
    vi.spyOn(org, 'query').mockImplementation(async (soql, options) => {
      if (soql.includes('UserPermissionAccess')) {
        return {
          totalSize: 1,
          done: true,
          records: [
            {
              PermissionsViewAllData: true,
              PermissionsModifyAllData: true,
              PermissionsBulkApiHardDelete: true,
            },
          ],
        };
      }
      return org.memory.query(soql, options);
    });

    const answer = await runEmptyAct(context, { confirmed: kept, accord: {} });

    expect(answer.ran).toBe(true);
    if (!answer.ran) return;
    expect(answer.result.hardRefused).toContain(NO_HARD_DELETE);
    expect(answer.result.status).toBe('failure');
    expect(org.sent.every((sent) => sent.via === 'hardDelete' && sent.ids.length === 0)).toBe(true);
    expect(org.live('Contact')).toHaveLength(3);
    expect(answer.result.undo).toEqual({ offered: false, why: 'hard' });
  });

  it('deletes by job with the right, offers no Undo, and its Undo is refused', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs(), { hardDelete: true });
    const context = contextOf(org);
    const kept = await previewed(context, { mode: 'objects', objects: ['Contact'] }, 'hard');
    const askGuard = vi.fn(async () => ({ decision: 'allowed' as const }));
    const answer = await runEmptyAct({ ...context, askGuard }, { confirmed: kept, accord: {} });

    expect(askGuard).toHaveBeenCalledWith(expect.objectContaining({ operation: 'hardDelete' }));
    expect(answer.ran && answer.result.status).toBe('success');
    if (!answer.ran) return;
    expect(org.sent.map((sent) => sent.via)).toEqual(['hardDelete']);
    expect(org.live('Contact')).toEqual([]);
    const undone = await undoEmptyAct(context, { runId: answer.result.runId, accord: {} });
    expect(!undone.ran && undone.refusal.code).toBe('UNDO_UNAVAILABLE');
  });
});

describe('the guards before the first delete', () => {
  it('refuses while the org is locked by another act, and deletes nothing', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs());
    const lock = oneLock();
    lock.lock(fakeId('00D', 1));
    const context = contextOf(org, { lock: lock.lock });
    const kept = await previewed(context, { mode: 'objects', objects: ['Contact'] });
    const answer = await runEmptyAct(context, { confirmed: kept, accord: {} });

    expect(!answer.ran && answer.refusal.code).toBe('RUN_WRITING');
    expect(org.sent).toEqual([]);
  });

  it('refuses while another run of this machine writes to the org', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs());
    const context = contextOf(org, {
      runWriting: async () => 'A SandForge run is writing to dev.',
    });
    const kept = await previewed(contextOf(org), { mode: 'objects', objects: ['Contact'] });
    const answer = await runEmptyAct(context, { confirmed: kept, accord: {} });

    expect(!answer.ran && answer.refusal.code).toBe('RUN_WRITING');
    expect(org.sent).toEqual([]);
  });

  it('refuses while someone else changed these records in the last hour, and not for the org’s own Automated Process', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs());
    const context = contextOf(org);
    const kept = await previewed(context, { mode: 'objects', objects: ['Contact'] });
    org.memory.edit('Contact', SALES.contactAlone, { Title: 'x' }, AUTOMATED_PROCESS_USER);
    const quiet = await runEmptyAct(context, { confirmed: kept, accord: {} });
    expect(quiet.ran).toBe(true);

    const busy = new MemoryEmptyOrg(emptySalesSpecs());
    const busyContext = contextOf(busy);
    const keptBusy = await previewed(busyContext, { mode: 'objects', objects: ['Contact'] });
    busy.memory.edit('Contact', SALES.contactAlone, { Title: 'x' }, fakeId('005', 77));
    const refused = await runEmptyAct(busyContext, { confirmed: keptBusy, accord: {} });

    expect(!refused.ran && refused.refusal.code).toBe('PEOPLE_ACTIVE');
    expect(!refused.ran && refused.refusal.message).toContain('1 person other than');
    expect(busy.sent).toEqual([]);
  });

  it('refuses records no undo would bring back until it is accepted', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs());
    const context = contextOf(org);
    const kept = await previewed(context, { mode: 'objects', objects: ['Account', 'Case'] });
    expect(kept.preview.undoLost.length).toBeGreaterThan(0);

    const refused = await runEmptyAct(context, { confirmed: kept, accord: {} });
    expect(!refused.ran && refused.refusal.code).toBe('NO_UNDO');
    expect(org.sent).toEqual([]);
  });

  it('refuses what fires unaccepted, and says every refusal at once', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs());
    const fires = (objects: readonly string[]): ForgeTargetAutomation => ({
      ...NOTHING_FIRES(objects),
      objects: [
        {
          objectApiName: 'Contact',
          flows: [
            {
              apiName: 'Guard_Delete',
              label: 'Guard Delete',
              timing: 'beforeSave' as const,
              startsOn: 'delete' as const,
              condition: 'read' as const,
              permissions: [],
            },
          ],
          triggers: [],
        },
      ],
    });
    const context = contextOf(org, { automation: quietOrg(fires) });
    const kept = await previewed(contextOf(org), {
      mode: 'objects',
      objects: ['Account', 'Contact', 'Case'],
    });
    const answer = await runEmptyAct(context, { confirmed: kept, accord: {} });

    expect(answer.ran).toBe(false);
    if (answer.ran) return;
    const codes = [answer.refusal.code, ...(answer.alsoRefused ?? []).map((r) => r.code)];
    expect(codes).toContain('NO_UNDO');
    expect(codes).toContain('AUTOMATION_NOT_ACCEPTED');
    expect(org.sent).toEqual([]);
  });

  it('refuses a run on a preview the org has outgrown: more records go along than it showed', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs());
    const context = contextOf(org);
    const kept = await previewed(context, { mode: 'objects', objects: ['Opportunity'] });
    org.advance(1_000);
    org.addNow('Task', { Id: fakeId('00T', 60), WhatId: SALES.opportunityAlone, WhoId: null });
    const answer = await runEmptyAct(context, { confirmed: kept, accord: {} });

    expect(!answer.ran && answer.refusal.code).toBe('ORG_CHANGED');
    expect(!answer.ran && answer.refusal.message).toContain('Task record(s) now go along');
    expect(org.sent).toEqual([]);
  });

  it('runs on a preview the org changed within: fewer records than it showed', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs());
    const context = contextOf(org);
    const kept = await previewed(context, { mode: 'objects', objects: ['Contact'] });
    org.memory.trash('Contact', SALES.contactAlone);
    const answer = await runEmptyAct(context, { confirmed: kept, accord: {} });

    expect(answer.ran && answer.result.status).toBe('success');
  });
});

describe('changedSince, the rule a run reads its preview again by', () => {
  /** A preview of one pass and what goes along. */
  const preview = (records: number, along: number, lost = 0): EmptyPreview =>
    ({
      mode: 'objects',
      deleteMode: 'recycle',
      passes: [{ objectApiName: 'Account', records: { records }, sent: { records } }],
      along: [{ objectApiName: 'Contact', records: { records: along }, via: [] }],
      undoLost:
        lost > 0
          ? [
              {
                objectApiName: 'Case',
                field: 'AccountId',
                parent: 'Account',
                reason: 'restricted',
                records: { records: lost },
              },
            ]
          : [],
    }) as unknown as EmptyPreview;

  it('takes fewer records, or more records of the objects emptied, for no change: the run never reads what was made since', () => {
    expect(changedSince(preview(10, 5), preview(3, 5))).toEqual([]);
    expect(changedSince(preview(10, 5), preview(12, 5))).toEqual([]);
  });

  it('names more records going along, and more beyond Undo', () => {
    expect(changedSince(preview(10, 5), preview(10, 6))).toHaveLength(1);
    expect(changedSince(preview(10, 5), preview(10, 5, 2))).toEqual([
      'more records would go beyond what Undo brings back',
    ]);
  });
});
