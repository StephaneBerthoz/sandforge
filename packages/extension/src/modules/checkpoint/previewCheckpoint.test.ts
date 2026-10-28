import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForgeTargetAutomation, OrgCheckpoint } from '@sandforge/shared';

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import {
  MEMORY_ORG_USER,
  MemoryRemovalOrg,
  type MemoryChild,
  type MemoryOrgRequest,
} from '../../test/memoryRemovalOrg.js';
import { workedObjects } from '../dataops/RecordRemoval.js';
import {
  openCheckpointStore,
  previewDirOf,
  type CheckpointFolder,
  type OrgCheckpointStore,
} from './OrgCheckpointStore.js';
import { objectsWrittenBy, previewCheckpoint, type PreviewDeps } from './previewCheckpoint.js';
import { diffEstimate, relationshipsOf, rewindEstimate } from './rewindEstimate.js';
import { takeCheckpoint, type TakeOrg } from './takeCheckpoint.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * The preview of a rewind, on the memory org the bricks run on: a checkpoint
 * taken of it as a take takes one, changes made since by two users, then the
 * preview — its guard, the day's limits, Tr, the diff, what the org runs, the
 * estimate and the refusal it would meet. The org counts a composite as one
 * request and every SOAP call apart, as the orgs were seen to.
 */

const ORG_ID = '00D000000000001AAA';
const AUTOMATED_PROCESS = '005000000000002AAA';
const COLLEAGUE = '005000000000003AAA';

/** T0 on the org's clock, with its milliseconds. */
const T0 = Date.parse('2026-10-22T14:05:12.731Z');
/** Long before the checkpoint: the records and the fields the org held. */
const LONG_AGO = Date.parse('2026-10-01T09:00:00.000Z');

let clock = T0;

const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;
const account = (n: number): string => id('001', n);
const contact = (n: number): string => id('003', n);
const task = (n: number): string => id('00T', n);
const opportunity = (n: number): string => id('006', n);

/** The audit fields and the id, as the org describes them: no one writes them. */
const STAMP_FIELDS = [
  { name: 'Id', type: 'id', permissionable: false },
  { name: 'SystemModstamp', type: 'datetime', permissionable: false },
  { name: 'CreatedDate', type: 'datetime', permissionable: false },
  { name: 'CreatedById', type: 'reference', referenceTo: ['User'], permissionable: false },
  { name: 'LastModifiedDate', type: 'datetime', permissionable: false },
  { name: 'LastModifiedById', type: 'reference', referenceTo: ['User'], permissionable: false },
  { name: 'IsDeleted', type: 'boolean', permissionable: false },
];

function writable(name: string, type = 'string', extra: Record<string, unknown> = {}) {
  return { name, type, createable: true, updateable: true, nillable: true, ...extra };
}

const FIELDS: Record<string, unknown[]> = {
  Account: [...STAMP_FIELDS, writable('Name'), writable('Industry')],
  Contact: [
    ...STAMP_FIELDS,
    writable('LastName'),
    writable('AccountId', 'reference', { referenceTo: ['Account'] }),
  ],
  Task: [...STAMP_FIELDS, writable('Subject')],
  Lead: [...STAMP_FIELDS, writable('LastName')],
  Opportunity: [
    ...STAMP_FIELDS,
    writable('Name'),
    writable('AccountId', 'reference', { referenceTo: ['Account'] }),
  ],
};

/** An account's contacts and opportunities go with it; opportunities are outside the checkpoint. */
const CHILDREN: Record<string, MemoryChild[]> = {
  Account: [
    { childSObject: 'Contact', field: 'AccountId', cascadeDelete: true },
    { childSObject: 'Opportunity', field: 'AccountId', cascadeDelete: true },
  ],
};

/** The objects the checkpoint holds, picked: the opportunities are left outside it. */
const PICKED = ['Account', 'Contact', 'Task', 'Lead'];

/**
 * The memory org as a take and a preview read it: a global describe of
 * objects a person works in, `/limits`, the org's own record and its user's
 * permissions, on a Developer Edition org.
 */
class PreviewTestOrg extends MemoryRemovalOrg implements TakeOrg {
  limits = { Max: 15_000, Remaining: 14_000 };
  /** Its daily email limits, as `/limits` lists them: none unless told. */
  emailLimits: Record<string, { Max: number; Remaining: number }> = {};

  constructor(says: { sandbox?: boolean; edition?: string } = {}) {
    super(CHILDREN, { now: () => clock });
    clock = LONG_AGO;
    for (const [name, fields] of Object.entries(FIELDS)) this.changeSchema(name, fields);
    this.add('Organization', {
      Id: ORG_ID,
      IsSandbox: says.sandbox ?? false,
      OrganizationType: says.edition ?? 'Developer Edition',
    });
    this.add('UserPermissionAccess', {
      Id: '0Up000000000001AAA',
      PermissionsViewAllData: true,
      PermissionsModifyAllData: true,
      PermissionsViewEncryptedData: false,
    });
    this.add('User', { Id: AUTOMATED_PROCESS, UserType: 'AutomatedProcess' });
    this.add('User', { Id: MEMORY_ORG_USER, Name: 'Ada Admin' });
    this.add('User', { Id: COLLEAGUE, Name: 'Grace Tester' });
  }

  override async describeGlobal(): Promise<unknown> {
    this.requests++;
    return {
      sobjects: Object.keys(FIELDS).map((name) => ({
        name,
        label: name,
        queryable: true,
        createable: true,
        updateable: true,
        deletable: true,
        layoutable: true,
      })),
    };
  }

  override async request(request: MemoryOrgRequest): Promise<unknown> {
    if (request.method === 'GET' && request.url.endsWith('/limits')) {
      this.requests++;
      return { DailyApiRequests: this.limits, ...this.emailLimits };
    }
    return super.request(request);
  }
}

/** Everything the memory org answered: its REST requests, a composite one, and its SOAP calls. */
function spent(org: MemoryRemovalOrg): number {
  return org.requests + org.soapCalls;
}

const dirs: string[] = [];

beforeEach(() => {
  clock = T0;
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.mocked(getJsforceConnection).mockReset();
});

interface Taken {
  org: PreviewTestOrg;
  store: OrgCheckpointStore;
  checkpoint: OrgCheckpoint;
  folder: CheckpointFolder;
}

/**
 * Records long before the checkpoint, then the checkpoint, taken at T0 of the
 * picked objects as a take takes it, through a snapshot handler reading the
 * same org.
 */
async function taken(org = new PreviewTestOrg()): Promise<Taken> {
  const dir = mkdtempSync(join(tmpdir(), 'sandforge-preview-'));
  dirs.push(dir);
  const opened = openCheckpointStore({ root: join(dir, 'store'), locksDir: join(dir, 'locks') });
  if ('refusal' in opened) throw new Error(`no store: ${opened.refusal.reason}`);
  clock = LONG_AGO;
  for (const n of [1, 2, 3]) org.add('Account', { Id: account(n), Name: `Account ${n}` });
  org.add('Contact', { Id: contact(1), LastName: 'One', AccountId: account(2) });
  org.add('Contact', { Id: contact(2), LastName: 'Two', AccountId: account(2) });
  org.add('Contact', { Id: contact(3), LastName: 'Three', AccountId: account(1) });
  org.add('Task', { Id: task(1), Subject: 'Call back' });
  org.add('Task', { Id: task(2), Subject: 'Write' });
  clock = T0;
  vi.mocked(getJsforceConnection).mockResolvedValue({
    query: (soql: string, options?: { scanAll?: boolean }) => org.query(soql, options),
    queryMore: (nextRecordsUrl: string) => org.queryMore(nextRecordsUrl),
    describe: (objectApiName: string) => org.describe(objectApiName),
  } as never);
  const outcome = await takeCheckpoint(
    {
      org,
      store: opened.store,
      handler: {
        log: () => undefined,
        orgManager: { getOrg: () => ({ orgType: 'Developer' }) } as never,
        orgRegistry: {} as never,
      },
      now: () => new Date(T0),
    },
    {
      orgId: 'org-1',
      orgName: 'DEV-ED',
      alias: 'DEV-ED',
      username: 'tester@example.com',
      instanceUrl: 'https://example.my.salesforce.com',
      registered: { orgType: 'Developer' },
      mode: 'picked',
      objects: PICKED,
      name: 'Before UAT',
    },
  );
  if (!outcome.taken) throw new Error(`refused: ${outcome.refusal.message}`);
  const { checkpoint } = outcome;
  return {
    org,
    store: opened.store,
    checkpoint,
    folder: opened.store.folderOf(ORG_ID, checkpoint.checkpointId),
  };
}

/** What two users did since: every class a rewind acts on, and something outside the checkpoint. */
function changedSince(org: PreviewTestOrg): void {
  clock = T0 + 60_000;
  org.edit('Account', account(1), { Name: 'Renamed' }, COLLEAGUE);
  org.add('Account', { Id: account(4), Name: 'New one', LastModifiedById: MEMORY_ORG_USER });
  org.add('Account', { Id: account(5), Name: 'New two', LastModifiedById: MEMORY_ORG_USER });
  // Its contacts go with it.
  org.trash('Account', account(2));
  org.edit('Task', task(1), { Subject: 'Called' });
  // Deleted alone, then emptied from the bin: gone for good.
  org.trash('Contact', contact(3));
  org.purge(contact(3));
  clock = T0 + 61_000;
  // Outside the checkpoint, under an account created since.
  org.add('Opportunity', { Id: opportunity(1), Name: 'Deal', AccountId: account(4) });
  clock = T0 + 120_000;
}

/** A read of the org's automation that sends nothing and finds nothing, keeping what it was asked. */
function automationRead(
  asked: string[][],
): (objects: readonly string[]) => Promise<ForgeTargetAutomation> {
  return (objects) => {
    asked.push([...objects]);
    return Promise.resolve({
      objectsRead: [...objects],
      objects: [],
      unread: [],
      conditionsNotRead: 0,
      conditionsBound: 0,
      requests: 0,
    } satisfies ForgeTargetAutomation);
  };
}

const request = (t: Taken) => ({
  checkpoint: t.checkpoint,
  folder: t.folder,
  orgName: 'DEV-ED',
  registered: { orgType: 'Developer' },
  username: 'tester@example.com',
});

/** The relationships of every object as the org describes them, with the checkpoint's bounds. */
async function relationshipsOfOrg(org: PreviewTestOrg, checkpoint: OrgCheckpoint) {
  const worked = new Set((await workedObjects(org)).keys());
  const inCheckpoint = new Set(checkpoint.objects.map((o) => o.objectApiName.toLowerCase()));
  const relationships = new Map<string, ReturnType<typeof relationshipsOf>>();
  for (const name of ['Account', 'Contact']) {
    relationships.set(name, relationshipsOf(await org.describe(name), { inCheckpoint, worked }));
  }
  return relationships;
}

describe('previewCheckpoint', () => {
  it('sends the org exactly what the estimate counts: the guard and the day’s limits, then every part of the diff', async () => {
    const t = await taken();
    changedSince(t.org);
    const before = spent(t.org);

    const outcome = await previewCheckpoint(
      { org: t.org, store: t.store, readAutomation: automationRead([]) },
      request(t),
    );

    if (!outcome.previewed) throw new Error(outcome.refusal.message);
    const sent = spent(t.org) - before;
    // The scenario reaches every part of the read: a record given back of
    // two objects, two created since with a record outside the checkpoint
    // under one, an account brought back with the two contacts that went
    // with it, a contact gone from the bin, made again, and two users.
    const byObject = new Map(outcome.diff.objects.map((o) => [o.objectApiName, o]));
    expect(byObject.get('Account')).toMatchObject({
      toDelete: { createdSince: 2 },
      toGiveBack: { records: 1 },
      toBringBack: { inBin: 1 },
      outside: [{ objectApiName: 'Opportunity', count: 1, parents: 1 }],
    });
    expect(byObject.get('Contact')).toMatchObject({
      toBringBack: { withParent: 2 },
      toRecreate: 1,
      cannotUndo: [],
    });
    expect(byObject.get('Task')).toMatchObject({ toGiveBack: { records: 1 } });
    expect(Object.keys(outcome.diff.userNames).sort()).toEqual([MEMORY_ORG_USER, COLLEAGUE].sort());

    const relationships = await relationshipsOfOrg(t.org, t.checkpoint);
    const read = diffEstimate({ objects: t.checkpoint.objects, diff: outcome.diff, relationships });
    // The guard of a Developer Edition org reads its Organization record, its
    // edition and the user's permissions; then the day's limits; then the
    // diff, its clock included.
    expect(sent).toBe(3 + 1 + read.apiRequests);
  });

  it('prices the rewind with the relationships the diff described, never at the most one object was seen to read', async () => {
    const t = await taken();
    changedSince(t.org);

    const outcome = await previewCheckpoint(
      { org: t.org, store: t.store, readAutomation: automationRead([]) },
      request(t),
    );

    if (!outcome.previewed) throw new Error(outcome.refusal.message);
    const relationships = await relationshipsOfOrg(t.org, t.checkpoint);
    const priced = rewindEstimate({
      objects: t.checkpoint.objects,
      diff: outcome.diff,
      automationRequests: 0,
      relationships,
    });
    expect(outcome.estimate).toEqual({ ...priced, apiRequestsLeft: 14_000 });
    expect(outcome.estimate.apiRequests).toBeLessThan(
      rewindEstimate({ objects: t.checkpoint.objects, diff: outcome.diff, automationRequests: 0 })
        .apiRequests,
    );
  });

  it('reads what the org runs on every object the rewind writes to, and its requests price the rewind', async () => {
    const t = await taken();
    changedSince(t.org);
    const asked: string[][] = [];
    const read = automationRead(asked);
    const reads: PreviewDeps['readAutomation'] = async (objects) => ({
      ...(await read(objects)),
      requests: 9,
    });

    const outcome = await previewCheckpoint(
      { org: t.org, store: t.store, readAutomation: reads },
      request(t),
    );

    if (!outcome.previewed) throw new Error(outcome.refusal.message);
    expect(asked).toEqual([objectsWrittenBy(outcome.diff)]);
    expect(new Set(asked[0])).toEqual(new Set(['Account', 'Contact', 'Task']));
    expect(outcome.automation?.requests).toBe(9);
    const without = await previewCheckpoint(
      { org: t.org, store: t.store, readAutomation: automationRead([]) },
      request(t),
    );
    if (!without.previewed) throw new Error(without.refusal.message);
    expect(outcome.estimate.apiRequests - without.estimate.apiRequests).toBe(9);
  });

  it('reads nothing of what the org runs when the rewind would write nothing, and says nothing of it', async () => {
    const t = await taken();
    const asked: string[][] = [];

    const outcome = await previewCheckpoint(
      { org: t.org, store: t.store, readAutomation: automationRead(asked) },
      request(t),
    );

    if (!outcome.previewed) throw new Error(outcome.refusal.message);
    expect(outcome.diff.objects).toEqual([]);
    expect(asked).toEqual([]);
    expect(outcome.automation).toBeUndefined();
    expect(outcome.refusal).toBeUndefined();
  });

  it('answers the diff when what the org runs could not be read, naming each part unread', async () => {
    const t = await taken();
    changedSince(t.org);

    const outcome = await previewCheckpoint(
      {
        org: t.org,
        store: t.store,
        readAutomation: () => Promise.reject(new Error('Tooling API timed out')),
      },
      request(t),
    );

    if (!outcome.previewed) throw new Error(outcome.refusal.message);
    expect(outcome.diff.objects.length).toBeGreaterThan(0);
    expect(outcome.automation?.unread).toEqual([
      { part: 'flows', reason: 'Tooling API timed out' },
      { part: 'triggers', reason: 'Tooling API timed out' },
      { part: 'processes', reason: 'Tooling API timed out' },
      { part: 'workflowRules', reason: 'Tooling API timed out' },
    ]);
  });

  it('refuses a production org with the guard’s words, having read nothing but what the guard asked', async () => {
    const t = await taken();
    changedSince(t.org);
    t.org.edit('Organization', ORG_ID, { OrganizationType: 'Enterprise Edition' });
    const before = spent(t.org);

    const outcome = await previewCheckpoint({ org: t.org, store: t.store }, request(t));

    expect(outcome).toEqual({
      previewed: false,
      refusal: expect.objectContaining({ code: 'PRODUCTION' }) as unknown,
    });
    // The Organization record and its edition: neither the limits nor the clock.
    expect(spent(t.org) - before).toBe(2);
  });

  it('refuses an org that is no longer the checkpoint’s, as a refreshed sandbox is', async () => {
    const t = await taken();
    const other = {
      ...t.checkpoint,
      org: { ...t.checkpoint.org, organizationId: '00D000000000009AAA' },
    };

    const outcome = await previewCheckpoint(
      { org: t.org, store: t.store },
      { ...request(t), checkpoint: other },
    );

    expect(outcome).toMatchObject({ previewed: false, refusal: { code: 'OTHER_ORG' } });
  });

  it('says the rewind would be refused while a take of the org holds its lock, or a run writes to it', async () => {
    const t = await taken();
    changedSince(t.org);

    const held = t.store.lock(ORG_ID, 'take');
    if (!('lock' in held)) throw new Error('lock not taken');
    try {
      const locked = await previewCheckpoint({ org: t.org, store: t.store }, request(t));
      expect(locked).toMatchObject({
        previewed: true,
        refusal: {
          code: 'RUN_WRITING',
          message: expect.stringContaining('rewind once it has ended'),
        },
      });
    } finally {
      held.lock.release();
    }

    const writing = await previewCheckpoint(
      {
        org: t.org,
        store: t.store,
        runWriting: (organizationId) =>
          organizationId === ORG_ID ? 'A SandForge run is writing to DEV-ED.' : undefined,
      },
      request(t),
    );
    expect(writing).toMatchObject({
      previewed: true,
      refusal: { code: 'RUN_WRITING', message: 'A SandForge run is writing to DEV-ED.' },
    });
  });

  it('says the rewind would be refused past the requests the org has left today', async () => {
    const t = await taken();
    changedSince(t.org);
    t.org.limits = { Max: 15_000, Remaining: 30 };

    const outcome = await previewCheckpoint({ org: t.org, store: t.store }, request(t));

    expect(outcome).toMatchObject({
      previewed: true,
      estimate: { apiRequestsLeft: 30 },
      refusal: { code: 'API_BUDGET' },
    });
  });

  it('counts the emails the rewind’s writes make the org send, against what it has left of each daily limit, and says a rewind past them would be refused, with no request more (B11, H1)', async () => {
    const t = await taken();
    changedSince(t.org);
    // A flow that emails an account's owner as it is updated.
    const sending: PreviewDeps['readAutomation'] = async (objects) => ({
      ...(await automationRead([])(objects)),
      objects: [
        {
          objectApiName: 'Account',
          flows: [
            {
              apiName: 'Account_changed',
              label: 'Account changed',
              timing: 'afterSave',
              startsOn: 'update',
              condition: 'read',
              permissions: [],
              messages: [{ kind: 'email', name: 'Tell owner', limit: 'SingleEmail' }],
            },
          ],
          triggers: [],
        },
      ],
    });
    t.org.emailLimits = { SingleEmail: { Max: 15, Remaining: 1 } };
    const asked = vi.spyOn(t.org, 'request');

    const outcome = await previewCheckpoint(
      { org: t.org, store: t.store, readAutomation: sending },
      request(t),
    );

    if (!outcome.previewed) throw new Error(outcome.refusal.message);
    // The account renamed since, and the one deleted since, brought back and given its values.
    expect(outcome.emails).toEqual([
      {
        limit: 'SingleEmail',
        emails: 2,
        objects: [
          {
            objectApiName: 'Account',
            write: 'update',
            records: 2,
            perRecord: 1,
            sentBy: ['Account changed'],
          },
        ],
        verdict: 'exceeds',
        remaining: 1,
        max: 15,
      },
    ]);
    expect(outcome.refusal).toMatchObject({ code: 'EMAILS' });
    // The limits were read once, with the day's requests.
    expect(asked.mock.calls.filter(([{ url }]) => url.endsWith('/limits'))).toHaveLength(1);
    const without = await previewCheckpoint(
      { org: t.org, store: t.store, readAutomation: automationRead([]) },
      request(t),
    );
    if (!without.previewed) throw new Error(without.refusal.message);
    expect(without.emails).toBeUndefined();
    expect(without.refusal).toBeUndefined();
  });

  it('keeps its reads under the preview’s own folder, named by the id the diff carries', async () => {
    const t = await taken();
    changedSince(t.org);

    const outcome = await previewCheckpoint(
      { org: t.org, store: t.store, now: () => new Date('2026-10-22T14:07:00.000Z') },
      request(t),
    );

    if (!outcome.previewed) throw new Error(outcome.refusal.message);
    expect(outcome.diff.previewId).toMatch(/^pv-20261022-140700-[a-z0-9]{4}$/);
    expect(existsSync(previewDirOf(t.folder, outcome.diff.previewId))).toBe(true);
    expect(outcome.diff.readAt).toBe(new Date(T0 + 120_000).toISOString());
  });
});

describe('objectsWrittenBy', () => {
  it('names the objects with records to delete, give back or bring back, and no other', () => {
    const object = (objectApiName: string, extra: Record<string, unknown>) => ({
      objectApiName,
      toDelete: { createdSince: 0, broughtBackSince: 0, comesBackWithParent: 0 },
      toGiveBack: { records: 0, fields: 0, clearedLookups: 0 },
      toBringBack: { inBin: 0, withParent: 0, deletedWhileTaken: 0 },
      cannotUndo: [],
      outside: [],
      touched: 0,
      unexplained: 0,
      lastChangedBy: {},
      notCompared: [],
      ...extra,
    });

    expect(
      objectsWrittenBy({
        objects: [
          object('Account', {
            toDelete: { createdSince: 0, broughtBackSince: 0, comesBackWithParent: 1 },
          }),
          object('Contact', { touched: 4, unexplained: 2 }),
          object('Case', { toBringBack: { inBin: 0, withParent: 0, deletedWhileTaken: 1 } }),
          object('Task', { toGiveBack: { records: 1, fields: 1, clearedLookups: 0 } }),
        ],
      }),
    ).toEqual(['Account', 'Case', 'Task']);
  });

  it('names an object whose records come back for a moment, to be deleted again, in none of the numbers: the rewind reads its automation, and refuses without the box what runs on them', () => {
    const object = (objectApiName: string, toBringBack: Record<string, number>) => ({
      objectApiName,
      toDelete: { createdSince: 0, broughtBackSince: 0, comesBackWithParent: 0 },
      toGiveBack: { records: 0, fields: 0, clearedLookups: 0 },
      toBringBack: { inBin: 0, withParent: 0, deletedWhileTaken: 0, ...toBringBack },
      cannotUndo: [],
      outside: [],
      touched: 0,
      unexplained: 0,
      lastChangedBy: {},
      notCompared: [],
    });

    expect(
      objectsWrittenBy({
        objects: [object('Account', { carriers: 1 }), object('Contact', { withParent: 1 })],
      }),
    ).toEqual(['Account', 'Contact']);
  });
});
