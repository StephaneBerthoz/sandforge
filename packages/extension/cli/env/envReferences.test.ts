import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EnvResourceState, EnvSeedDraw, EnvState } from '@sandforge/shared';

vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { SasReferenceIdMappingStore } from '../../src/modules/frozendataset/SasReferenceIdMappingStore.js';
import type { EnvFileResource } from './envFile.js';
import { createdByResource, drawnIdsOf, drawnOf } from './envReferences.js';
import { newEnvState, openEnvStore, type EnvStore } from './envState.js';

/*
 * The ids a seed relation drawing its parents from another resource is
 * handed: read from what that resource's last run keeps, whatever its kind —
 * a seed's summary, a clone's summary through its remap table, a Frozen
 * load's mapping — never by a query; at most 2,000, or a `limit`.
 */

const ORG_ID = '00D000000000009RAA';
const ENV = 'refs';
const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

let dir: string;
let store: EnvStore;
let journalDir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sandforge-env-refs-'));
  mkdirSync(join(dir, 'project', '.git'), { recursive: true });
  journalDir = join(dir, 'journal');
  const opened = openEnvStore({ journalDir, fileFolder: join(dir, 'project') });
  if (!('store' in opened)) throw new Error(opened.refusal);
  store = opened.store;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const where = { organizationId: ORG_ID, env: ENV, target: 'TGT' };

/** A state holding one resource, its one run as given. */
function stateWith(
  name: string,
  resource: Pick<EnvResourceState, 'kind' | 'status'> & { run: EnvResourceState['runs'][number] },
): EnvState {
  const state = newEnvState({
    env: ENV,
    org: { organizationId: ORG_ID, kind: 'scratch', username: 'user@example.invalid' },
    fileDigest: 'a'.repeat(64),
    sandforgeVersion: '1.68.0',
  });
  return {
    ...state,
    resources: {
      [name]: {
        kind: resource.kind,
        fingerprint: 'b'.repeat(64),
        dependsOn: [],
        status: resource.status,
        runs: [resource.run],
      },
    },
  };
}

const AT = '2026-10-25T09:00:00.000Z';

/** A seed's summary, as the run printed it: two accounts. */
function seedSummary(truncated?: true): string {
  return JSON.stringify({
    tool: 'sandforge-seed',
    target: 'TGT',
    seed: 1,
    startedAt: AT,
    finishedAt: AT,
    emails: { checks: [] },
    elapsedMs: 1,
    dryRun: false,
    result: {
      operationId: 'env-refs-accounts-1-x',
      status: 'success',
      objectResults: [
        {
          objectApiName: 'Account',
          recordsCreated: 2,
          recordsFailed: 0,
          createdIds: [id('001', 1), id('001', 2)],
          errors: [],
          ...(truncated ? { truncated } : {}),
        },
      ],
      totalRecordsCreated: 2,
      totalRecordsFailed: 0,
    },
  });
}

describe('the records a resource created', () => {
  it('reads a seed’s from the summary its run printed, in the order it wrote them', async () => {
    await store.writeFile(ORG_ID, ENV, 'runs/accounts/1.summary.json', seedSummary());
    const state = stateWith('accounts', {
      kind: 'seed',
      status: 'applied',
      run: {
        n: 1,
        script: 'sandforge-seed',
        summary: 'runs/accounts/1.summary.json',
        startedAt: AT,
        objects: [],
      },
    });

    expect(await createdByResource(state, 'accounts', where, { store, journalDir })).toEqual({
      created: new Map([['Account', [id('001', 1), id('001', 2)]]]),
    });
  });

  it('refuses a seed’s summary that names the first of its records alone, its run file gone', async () => {
    await store.writeFile(ORG_ID, ENV, 'runs/accounts/1.summary.json', seedSummary(true));
    const state = stateWith('accounts', {
      kind: 'seed',
      status: 'applied',
      run: {
        n: 1,
        script: 'sandforge-seed',
        runId: 'env-refs-accounts-1-x',
        summary: 'runs/accounts/1.summary.json',
        startedAt: AT,
        objects: [],
      },
    });

    expect(await createdByResource(state, 'accounts', where, { store, journalDir })).toEqual({
      refusal:
        'accounts: its summary names the first of the records it created alone, and its run file is gone',
    });
  });

  it('reads a clone’s through the remap table of its summary: the records it created, never those it linked to', async () => {
    await store.writeFile(
      ORG_ID,
      ENV,
      'runs/cloned/1.summary.json',
      JSON.stringify({
        tool: 'sandforge-clone',
        version: 1,
        source: 'SRC',
        target: 'TGT',
        dryRun: false,
        elapsedMs: 1,
        result: {
          remapTable: {
            [id('001', 91)]: id('001', 1),
            [id('001', 92)]: id('001', 2),
            [id('001', 93)]: id('001', 3),
          },
          existingSourceIds: [id('001', 93)],
          updatedSourceIds: [],
          createdByObject: [
            { objectApiName: 'Account', sourceIds: [id('001', 91), id('001', 92), id('001', 93)] },
          ],
        },
      }),
    );
    const state = stateWith('cloned', {
      kind: 'forge',
      status: 'applied',
      run: {
        n: 1,
        script: 'sandforge-clone',
        summary: 'runs/cloned/1.summary.json',
        startedAt: AT,
        objects: [],
      },
    });

    expect(await createdByResource(state, 'cloned', where, { store, journalDir })).toEqual({
      created: new Map([['Account', [id('001', 1), id('001', 2)]]]),
    });
  });

  it('reads a Frozen load’s from its mapping in the sas: what it created, never what it linked to', async () => {
    const sas = await store.prepareFolder(ORG_ID, ENV, 'frozen/claims');
    await new SasReferenceIdMappingStore(sas, { orgId: ORG_ID }).persist(
      new Map([
        ['Account-000001', id('001', 1)],
        ['Account-000002', id('001', 2)],
        ['Pricebook2-000001', id('01s', 1)],
      ]),
      {
        created: [{ objectApiName: 'Account', referenceIds: ['Account-000001', 'Account-000002'] }],
        startedAt: new Date(AT),
      },
    );
    const state = stateWith('claims', {
      kind: 'frozen',
      status: 'applied',
      run: { n: 1, script: 'sandforge-frozen', sas: 'frozen/claims', startedAt: AT, objects: [] },
    });

    expect(await createdByResource(state, 'claims', where, { store, journalDir })).toEqual({
      created: new Map([['Account', [id('001', 1), id('001', 2)]]]),
    });
  });

  it('refuses a resource not applied to the org whole: never run, taken back, partial', async () => {
    const run = { n: 1, script: 'sandforge-seed' as const, startedAt: AT, objects: [] };
    const read = (status: EnvResourceState['status']) =>
      createdByResource(stateWith('accounts', { kind: 'seed', status, run }), 'accounts', where, {
        store,
        journalDir,
      });

    expect(await createdByResource(undefined, 'accounts', where, { store, journalDir })).toEqual({
      refusal: 'accounts has not created its records in this org yet',
    });
    expect(await read('destroyed')).toEqual({
      refusal: 'accounts has not created its records in this org yet',
    });
    expect(await read('partial')).toEqual({
      refusal: 'accounts is partial, not applied whole: apply it again first',
    });
    expect(await read('applied')).toEqual({
      refusal: 'accounts: its run keeps no record of what it created',
    });
  });
});

describe('the parents a draw is handed', () => {
  const draw: EnvSeedDraw = {
    at: 0,
    relation: {
      childObject: 'Contact',
      lookupField: 'AccountId',
      parentObject: 'Account',
      distribution: { mode: 'perParent', count: 1 },
    },
    from: 'accounts',
  };
  const accounts = (n: number) =>
    new Map([['Account', Array.from({ length: n }, (_, k) => id('001', k + 1))]]);

  it('hands the records of its parent object the resource created, the first first, at most its limit', () => {
    expect(drawnIdsOf(draw, accounts(3))).toEqual({
      ids: [id('001', 1), id('001', 2), id('001', 3)],
    });
    expect(drawnIdsOf({ ...draw, limit: 2 }, accounts(3))).toEqual({
      ids: [id('001', 1), id('001', 2)],
    });
    expect(drawnIdsOf({ ...draw, limit: 2_000 }, accounts(2_500))).toMatchObject({
      ids: { length: 2_000 },
    });
  });

  it('refuses a resource that created none of them, and more than a relation’s parents hold with no limit', () => {
    expect(drawnIdsOf(draw, new Map([['Contact', [id('003', 1)]]]))).toEqual({
      refusal:
        'the relation on Contact.AccountId draws its parents from the Account records accounts created, and it created none: it created Contact',
    });
    expect(drawnIdsOf(draw, accounts(2_001))).toEqual({
      refusal:
        "the relation on Contact.AccountId draws its parents from the 2001 Account records accounts created, more than the 2000 a relation's parents hold: give the relation a limit, and its parents are the first 2000 or fewer",
    });
  });

  it('hands none while the resource it draws from runs in the same apply, and counts the parents of one that ran', async () => {
    await store.writeFile(ORG_ID, ENV, 'runs/accounts/1.summary.json', seedSummary());
    const state = stateWith('accounts', {
      kind: 'seed',
      status: 'applied',
      run: {
        n: 1,
        script: 'sandforge-seed',
        summary: 'runs/accounts/1.summary.json',
        startedAt: AT,
        objects: [],
      },
    });
    const resource: EnvFileResource = {
      name: 'contacts',
      kind: 'seed',
      dependsOn: ['accounts'],
      fingerprint: '',
      run: {
        template: {
          id: 't',
          name: 't',
          description: 't',
          strategy: 'faker',
          objects: [],
          version: 1,
          tags: [],
          createdAt: AT,
          updatedAt: AT,
        },
        acceptAutomation: false,
        draws: [draw],
      },
    };

    const before = await drawnOf(resource, state, new Set(['accounts']), where, {
      store,
      journalDir,
    });
    const after = await drawnOf(resource, state, new Set(), where, { store, journalDir });

    expect(before).toEqual({
      ids: new Map(),
      draws: [{ lookup: 'Contact.AccountId', from: 'accounts', object: 'Account' }],
      refusals: [],
    });
    expect(after).toEqual({
      ids: new Map([[0, [id('001', 1), id('001', 2)]]]),
      draws: [{ lookup: 'Contact.AccountId', from: 'accounts', object: 'Account', parents: 2 }],
      refusals: [],
    });
    // Positive control: the summary is what it read.
    writeFileSync(store.fileOf(ORG_ID, ENV, 'runs/accounts/1.summary.json'), seedSummary(true));
    expect(
      (await drawnOf(resource, state, new Set(), where, { store, journalDir })).refusals,
    ).toEqual([
      expect.stringContaining(
        'whose records cannot be read: accounts: its summary names the first',
      ),
    ]);
  });
});
