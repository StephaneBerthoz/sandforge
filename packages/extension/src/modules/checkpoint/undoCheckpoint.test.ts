import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForgeTargetAutomation, OrgCheckpoint, RewindResult } from '@sandforge/shared';

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import {
  MEMORY_ORG_USER,
  type MemoryChild,
  type MemoryOrgRequest,
  type MemoryRow,
} from '../../test/memoryRemovalOrg.js';
import { MemoryRestoreOrg } from '../../test/memoryRestoreOrg.js';
import {
  openCheckpointStore,
  type CheckpointFolder,
  type OrgCheckpointStore,
} from './OrgCheckpointStore.js';
import { previewCheckpoint } from './previewCheckpoint.js';
import { rewindOrg } from './rewindOrg.js';
import { takeCheckpoint, type TakeOrg } from './takeCheckpoint.js';
import {
  UndoStopped,
  undoCheckpoint,
  type UndoCheckpointDeps,
  type UndoCheckpointOutcome,
  type UndoCheckpointRequest,
} from './undoCheckpoint.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * The undo of a rewind, as the panel and the command line ask for one, on the
 * memory org the bricks run on: a checkpoint taken of it, a colleague's work
 * since, the preview and the rewind that took it back, then the undo — its
 * guard and gates, the undo itself, and the checkpoint told it was undone.
 */

const ORG_ID = '00D000000000001AAA';
const AUTOMATED_PROCESS = '005000000000002AAA';
const COLLEAGUE = '005000000000003AAA';

const T0 = Date.parse('2026-10-22T14:05:12.731Z');
const LONG_AGO = Date.parse('2026-10-01T09:00:00.000Z');
const SINCE = T0 + 60_000;
const PREVIEWED = T0 + 120_000;
const REWOUND = T0 + 180_000;
const UNDONE = T0 + 600_000;

let clock = T0;

const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;
const account = (n: number): string => id('001', n);
const contact = (n: number): string => id('003', n);

const STAMP_FIELDS = [
  { name: 'Id', label: 'Id', type: 'id', permissionable: false },
  { name: 'SystemModstamp', label: 'System Modstamp', type: 'datetime', permissionable: false },
  { name: 'CreatedDate', label: 'Created Date', type: 'datetime', permissionable: false },
  {
    name: 'CreatedById',
    label: 'Created By',
    type: 'reference',
    referenceTo: ['User'],
    permissionable: false,
  },
  {
    name: 'LastModifiedDate',
    label: 'Last Modified Date',
    type: 'datetime',
    permissionable: false,
  },
  {
    name: 'LastModifiedById',
    label: 'Last Modified By',
    type: 'reference',
    referenceTo: ['User'],
    permissionable: false,
  },
  { name: 'IsDeleted', label: 'Deleted', type: 'boolean', permissionable: false },
];

function writable(name: string, type = 'string', extra: Record<string, unknown> = {}) {
  return { name, label: name, type, createable: true, updateable: true, nillable: true, ...extra };
}

const FIELDS: Record<string, unknown[]> = {
  Account: [...STAMP_FIELDS, writable('Name')],
  Contact: [
    ...STAMP_FIELDS,
    writable('LastName'),
    writable('AccountId', 'reference', { referenceTo: ['Account'] }),
  ],
};

const CHILDREN: Record<string, MemoryChild[]> = {
  Account: [{ childSObject: 'Contact', field: 'AccountId', cascadeDelete: true }],
};

/** The memory org as a take, a preview, a rewind and an undo read it, on a Developer Edition org. */
class UndoTestOrg extends MemoryRestoreOrg implements TakeOrg {
  limits = { Max: 15_000, Remaining: 14_000 };
  /** Its daily email limits, as `/limits` lists them: none unless told. */
  emailLimits: Record<string, { Max: number; Remaining: number }> = {};
  /** Whether each read of its clock moves it a second, as time passes during a rewind. */
  ticking = false;
  /** Told of each update, once it is made. */
  afterUpdate?: (objectApiName: string) => void;

  constructor() {
    super(CHILDREN, { now: () => clock });
    clock = LONG_AGO;
    for (const [name, fields] of Object.entries(FIELDS)) this.changeSchema(name, fields);
    this.add('Organization', {
      Id: ORG_ID,
      IsSandbox: false,
      OrganizationType: 'Developer Edition',
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

  override async serverTime(): Promise<string> {
    if (this.ticking) clock += 1_000;
    return super.serverTime();
  }

  override async update(
    objectApiName: string,
    records: Array<Record<string, unknown>>,
  ): Promise<unknown> {
    const answer = await super.update(objectApiName, records);
    this.afterUpdate?.(objectApiName);
    return answer;
  }
}

/** Everything the memory org answered: its REST requests, a composite one, and its SOAP calls. */
function spent(org: MemoryRestoreOrg): number {
  return org.requests + org.soapCalls;
}

/** What the org holds of what a test compares, live and in the recycle bin: no stamp. */
function stateOf(org: MemoryRestoreOrg): Record<string, unknown> {
  const pick = (row: MemoryRow): Record<string, unknown> => ({
    Id: row.Id,
    Name: row.Name ?? null,
    LastName: row.LastName ?? null,
    AccountId: row.AccountId ?? null,
  });
  const sorted = (rows: MemoryRow[]): unknown[] =>
    rows.map(pick).sort((a, b) => String(a.Id).localeCompare(String(b.Id)));
  return {
    live: { Account: sorted(org.all('Account')), Contact: sorted(org.all('Contact')) },
    bin: { Account: sorted(org.inBin('Account')), Contact: sorted(org.inBin('Contact')) },
  };
}

interface Rewound {
  org: UndoTestOrg;
  store: OrgCheckpointStore;
  folder: CheckpointFolder;
  /** The checkpoint, as the rewind left it: its last rewind named. */
  checkpoint: OrgCheckpoint;
  rewind: RewindResult;
  /** The org as the colleague left it, before the rewind: what the undo returns it to. */
  beforeRewind: Record<string, unknown>;
}

const dirs: string[] = [];

beforeEach(() => {
  clock = T0;
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.mocked(getJsforceConnection).mockReset();
});

const named = {
  orgName: 'DEV-ED',
  registered: { orgType: 'Developer' as const },
  username: 'tester@example.com',
};

/**
 * A checkpoint of Account and Contact taken at T0; then a colleague renames
 * an account, creates one with a contact under it, and deletes another —
 * then empties it from the recycle bin when `emptied`; when `carried`, moves
 * a contact of the checkpoint under an account made since, then deletes that
 * account, the contact with it; then the preview and the rewind that take it
 * all back, making the emptied account and its contact again, and bringing
 * the account made since back for a moment to bring the contact back.
 */
async function rewound(emptied = false, carried = false): Promise<Rewound> {
  const dir = mkdtempSync(join(tmpdir(), 'sandforge-undo-'));
  dirs.push(dir);
  const opened = openCheckpointStore({ root: join(dir, 'store'), locksDir: join(dir, 'locks') });
  if ('refusal' in opened) throw new Error(`no store: ${opened.refusal.reason}`);
  const store = opened.store;
  const org = new UndoTestOrg();
  clock = LONG_AGO;
  org.add('Account', { Id: account(1), Name: 'Account one' });
  org.add('Account', { Id: account(2), Name: 'Account two' });
  org.add('Contact', { Id: contact(1), LastName: 'One', AccountId: account(2) });
  if (carried) org.add('Contact', { Id: contact(2), LastName: 'Two', AccountId: account(1) });
  clock = T0;
  vi.mocked(getJsforceConnection).mockResolvedValue({
    query: (soql: string, options?: { scanAll?: boolean }) => org.query(soql, options),
    queryMore: (nextRecordsUrl: string) => org.queryMore(nextRecordsUrl),
    describe: (objectApiName: string) => org.describe(objectApiName),
  } as never);
  const take = await takeCheckpoint(
    {
      org,
      store,
      handler: {
        log: () => undefined,
        orgManager: { getOrg: () => ({ orgType: 'Developer' }) } as never,
        orgRegistry: {} as never,
      },
      now: () => new Date(T0),
    },
    {
      orgId: 'org-1',
      alias: 'DEV-ED',
      instanceUrl: 'https://example.my.salesforce.com',
      mode: 'picked',
      objects: ['Account', 'Contact'],
      name: 'Before UAT',
      ...named,
    },
  );
  if (!take.taken) throw new Error(`refused: ${take.refusal.message}`);
  const folder = store.folderOf(ORG_ID, take.checkpoint.checkpointId);

  clock = SINCE;
  org.edit('Account', account(1), { Name: 'Renamed' }, COLLEAGUE);
  org.add('Account', { Id: account(3), Name: 'New one', LastModifiedById: COLLEAGUE });
  org.add('Contact', {
    Id: contact(3),
    LastName: 'New',
    AccountId: account(3),
    LastModifiedById: COLLEAGUE,
  });
  org.trash('Account', account(2), COLLEAGUE);
  if (emptied) org.empty(account(2));
  if (carried) {
    org.add('Account', { Id: account(4), Name: 'Carrier', LastModifiedById: COLLEAGUE });
    org.edit('Contact', contact(2), { AccountId: account(4) }, COLLEAGUE);
    clock = SINCE + 30_000;
    org.trash('Account', account(4), COLLEAGUE);
  }
  const beforeRewind = stateOf(org);

  clock = PREVIEWED;
  const preview = await previewCheckpoint(
    { org, store },
    { checkpoint: take.checkpoint, folder, ...named },
  );
  if (!preview.previewed) throw new Error(preview.refusal.message);
  clock = REWOUND;
  org.ticking = true;
  const outcome = await rewindOrg(
    { org, undelete: (ids) => org.undelete(ids), store },
    {
      checkpoint: take.checkpoint,
      folder,
      ...named,
      previewId: preview.diff.previewId,
      acceptAutomation: false,
      acceptNoUndo: false,
      acceptRecreate: emptied,
      acceptOutside: false,
      acceptUnseen: false,
    },
  );
  org.ticking = false;
  if (!outcome.rewound) throw new Error(`refused: ${outcome.refusal.message}`);
  expect(outcome.result.status).toBe('success');
  const read = await store.read(take.checkpoint.checkpointId);
  if (!read?.checkpoint) throw new Error('the checkpoint is gone');
  return { org, store, folder, checkpoint: read.checkpoint, rewind: outcome.result, beforeRewind };
}

/** The undo of `r`'s rewind, ten minutes after its checkpoint was taken unless the clock is later. */
async function undone(
  r: Rewound,
  options: { deps?: Partial<UndoCheckpointDeps>; request?: Partial<UndoCheckpointRequest> } = {},
): Promise<UndoCheckpointOutcome> {
  clock = Math.max(clock, UNDONE);
  r.org.ticking = true;
  const read = await r.store.read(r.checkpoint.checkpointId);
  if (!read?.checkpoint) throw new Error('the checkpoint is gone');
  try {
    return await undoCheckpoint(
      { org: r.org, undelete: (ids) => r.org.undelete(ids), store: r.store, ...options.deps },
      {
        checkpoint: read.checkpoint,
        folder: r.folder,
        ...named,
        rewindId: r.rewind.rewindId,
        acceptAutomation: false,
        ...options.request,
      },
    );
  } finally {
    r.org.ticking = false;
  }
}

function resultOf(outcome: UndoCheckpointOutcome): RewindResult {
  if (!outcome.undone) throw new Error(`refused: ${outcome.refusal.message}`);
  return outcome.result;
}

/** The checkpoint's last rewind, as its file says it now. */
async function lastRewindOf(r: Rewound) {
  return (await r.store.read(r.checkpoint.checkpointId))?.checkpoint?.lastRewind;
}

/** What the org was sent to write, from now on. */
function writesOf(org: UndoTestOrg): () => { updates: number; deletes: number; undeletes: number } {
  const before = { updates: org.updates.length, deletes: org.deletes.length, soap: org.soapCalls };
  return () => ({
    updates: org.updates.length - before.updates,
    deletes: org.deletes.length - before.deletes,
    undeletes: org.soapCalls - before.soap,
  });
}

/** A read of the org's automation that sends nothing, finding what `found` says. */
function automationOf(
  found: Partial<ForgeTargetAutomation> = {},
  asked: string[][] = [],
): (objects: readonly string[]) => Promise<ForgeTargetAutomation> {
  return (objects) => {
    asked.push([...objects].sort());
    return Promise.resolve({
      objectsRead: [...objects],
      objects: [],
      unread: [],
      conditionsNotRead: 0,
      conditionsBound: 0,
      requests: 3,
      ...found,
    });
  };
}

describe('undoCheckpoint, on the memory org', () => {
  it('takes the rewind back: the org as the colleague left it before the rewind, the checkpoint’s last rewind marked undone, and every request it sent counted', async () => {
    const r = await rewound();
    const asked = spent(r.org);

    const result = resultOf(await undone(r));

    expect(stateOf(r.org)).toEqual(r.beforeRewind);
    expect(result).toMatchObject({
      checkpointId: r.checkpoint.checkpointId,
      rewindId: r.rewind.rewindId,
      status: 'success',
      residual: [],
      passes: 1,
    });
    // An undo's own result says no undo of its own.
    expect(result.undo).toBeUndefined();
    // What the rewind deleted comes back parents first: the contact created
    // since under an account created since went with the account, and comes
    // back with it.
    expect(
      result.undeleted.map(({ objectApiName, undeleted }) => [objectApiName, undeleted]),
    ).toEqual([['Account', 1]]);
    expect(result.apiRequests.used).toBe(spent(r.org) - asked);
    expect(result.apiRequests.leftToday).toBe(14_000 - result.apiRequests.used);
    const last = await lastRewindOf(r);
    expect(last).toMatchObject({ rewindId: r.rewind.rewindId, undoneAt: expect.any(String) });
    // The list offers it no more.
    expect((await r.store.list()).map((entry) => entry.undo)).toEqual([undefined]);
  });

  it('names apart what it deleted of what the rewind made again, the bin no longer giving it back, and says so as it runs', async () => {
    const r = await rewound(true);
    expect(
      r.rewind.recreated?.map(({ objectApiName, created }) => [objectApiName, created]),
    ).toEqual([
      ['Account', 1],
      ['Contact', 1],
    ]);
    const steps: string[] = [];

    const result = resultOf(
      await undone(r, { deps: { onProgress: ({ step }) => steps.push(step) } }),
    );

    expect(result.status).toBe('success');
    expect(stateOf(r.org).live).toEqual((r.beforeRewind as { live: unknown }).live);
    expect(result.remade).toEqual([
      { objectApiName: 'Account', count: 1 },
      { objectApiName: 'Contact', count: 1 },
    ]);
    expect(steps.filter((step) => step.startsWith('Sending back'))).not.toEqual([]);
    for (const step of steps.filter((each) => each.startsWith('Sending back'))) {
      expect(step).toMatch(
        /^Sending back to the recycle bin what the rewind brought back, and deleting again what it made again: /,
      );
    }
  });

  it('says what it sent back to the recycle bin on its own that had gone there with an account the rewind brought back for a moment, which stays there', async () => {
    const r = await rewound(false, true);
    expect(r.rewind.carriers).toEqual([{ objectApiName: 'Account', count: 1 }]);

    const result = resultOf(await undone(r));

    expect(result.status).toBe('success');
    expect(result.carriedAlone).toEqual([{ objectApiName: 'Contact', count: 1 }]);
    expect(stateOf(r.org).live).toEqual((r.beforeRewind as { live: unknown }).live);
    // Back in the bin on its own, under the account the checkpoint gave it.
    expect(r.org.inBin('Contact').find((row) => row.Id === contact(2))?.AccountId).toBe(account(1));
  });

  it('names a record a colleague changed again during the undo, by that colleague, and is unstable', async () => {
    const r = await rewound();
    r.org.afterUpdate = (objectApiName) => {
      if (objectApiName !== 'Account') return;
      r.org.afterUpdate = undefined;
      r.org.edit('Account', account(1), { Name: 'Changed during the undo' }, COLLEAGUE);
    };

    const result = resultOf(await undone(r));

    expect(result.status).toBe('unstable');
    expect(result.residual).toEqual([
      {
        objectApiName: 'Account',
        reason: 'changedDuringRewind',
        by: COLLEAGUE,
        count: 1,
        ids: [account(1)],
      },
    ]);
    expect((await lastRewindOf(r))?.undoneAt).toBeDefined();
  });

  it('names a record the undo’s own user changed again on save as kept by the automation, and is partial', async () => {
    const r = await rewound();
    r.org.afterUpdate = (objectApiName) => {
      if (objectApiName !== 'Account') return;
      r.org.afterUpdate = undefined;
      r.org.edit('Account', account(1), { Name: 'Set again on save' }, AUTOMATED_PROCESS);
    };

    const result = resultOf(await undone(r));

    expect(result.status).toBe('partial');
    expect(result.residual).toEqual([
      { objectApiName: 'Account', reason: 'automation', count: 1, ids: [account(1)] },
    ]);
  });
});

describe('undoCheckpoint: what it refuses before it writes', () => {
  it('refuses a production org with the guard’s words, writing nothing', async () => {
    const r = await rewound();
    r.org.edit('Organization', ORG_ID, { OrganizationType: 'Enterprise Edition' });
    const before = stateOf(r.org);
    const writes = writesOf(r.org);

    const outcome = await undone(r);

    expect(outcome).toMatchObject({
      undone: false,
      refusal: {
        code: 'PRODUCTION',
        message: expect.stringContaining(
          'SandForge never takes a checkpoint of, or rewinds',
        ) as unknown,
      },
    });
    expect(stateOf(r.org)).toEqual(before);
    expect(writes()).toEqual({ updates: 0, deletes: 0, undeletes: 0 });
    expect((await lastRewindOf(r))?.undoneAt).toBeUndefined();
  });

  it('refuses while a take, a rewind or another undo of the org holds its lock, or a run writes to it', async () => {
    const r = await rewound();
    const before = stateOf(r.org);
    const held = r.store.lock(ORG_ID, 'rewind');
    if (!('lock' in held)) throw new Error('the org’s lock is held');
    try {
      expect(await undone(r)).toMatchObject({
        undone: false,
        refusal: {
          code: 'RUN_WRITING',
          message: expect.stringMatching(
            /^A rewind is writing to DEV-ED \(process \d+ on .+\): undo the rewind once it has ended\./,
          ) as unknown,
        },
      });
    } finally {
      held.lock.release();
    }
    expect(
      await undone(r, { deps: { runWriting: () => 'A Sync run is writing to DEV-ED.' } }),
    ).toEqual({
      undone: false,
      refusal: { code: 'RUN_WRITING', message: 'A Sync run is writing to DEV-ED.' },
    });
    expect(stateOf(r.org)).toEqual(before);
    // The lock is let go once refused.
    const after = r.store.lock(ORG_ID, 'take');
    expect('lock' in after).toBe(true);
    if ('lock' in after) after.lock.release();
  });

  it('refuses when the org runs automation as the undo writes, or cannot say what it runs, unless accepted', async () => {
    const r = await rewound();
    const before = stateOf(r.org);
    const asked: string[][] = [];
    const blind = automationOf(
      { unread: [{ part: 'flows', reason: 'Tooling API timed out' }] },
      asked,
    );

    const outcome = await undone(r, { deps: { readAutomation: blind } });

    expect(outcome).toMatchObject({
      undone: false,
      refusal: {
        code: 'AUTOMATION',
        message:
          'DEV-ED: what runs as the undo writes could not all be read, so automation may run. ' +
          'The emails it sends as the undo writes were not counted against its daily limits, as ' +
          "what sends them was not read (the org's flows: Tooling API timed out). Undo refused; " +
          'accept that it runs to undo the rewind all the same. No record was written.',
      },
    });
    // What it read is what the undo writes: what the rewind deleted, wrote over and brought back.
    expect(asked).toEqual([['Account', 'Contact']]);
    expect(stateOf(r.org)).toEqual(before);
    expect((await lastRewindOf(r))?.undoneAt).toBeUndefined();

    const accepted = resultOf(
      await undone(r, { deps: { readAutomation: blind }, request: { acceptAutomation: true } }),
    );
    expect(accepted.status).toBe('success');
    expect(stateOf(r.org)).toEqual(r.beforeRewind);
  });

  it('says, refusing its automation unaccepted, that the emails of a package’s flow on what it gives back were not counted: an undo has no preview to have said it', async () => {
    const r = await rewound();
    const before = stateOf(r.org);
    // A flow a package runs after an account is saved: no user reads it.
    const packaged = automationOf({
      objects: [
        {
          objectApiName: 'Account',
          flows: [
            {
              apiName: 'survey_kit__Account_feedback',
              label: 'Account feedback',
              timing: 'afterSave',
              startsOn: 'update',
              condition: 'unreadable',
              permissions: [],
              messages: [],
            },
          ],
          triggers: [],
        },
      ],
    });

    const outcome = await undone(r, { deps: { readAutomation: packaged } });

    expect(outcome).toEqual({
      undone: false,
      refusal: {
        code: 'AUTOMATION',
        message:
          'DEV-ED: 1 flow(s), trigger(s) or rule(s) of Account run as the undo brings records ' +
          'back, gives them their values back or sends them back to the recycle bin. The ' +
          'emails it sends as the undo writes were not counted against its daily limits, as ' +
          'what sends them was not read (the definition of Account feedback (package ' +
          'survey_kit, whose flows the org lets no one read) on Account). Undo refused; accept ' +
          'that it runs to undo the rewind all the same. No record was written.',
      },
    });
    expect(stateOf(r.org)).toEqual(before);
    const accepted = resultOf(
      await undone(r, { deps: { readAutomation: packaged }, request: { acceptAutomation: true } }),
    );
    expect(accepted.status).toBe('success');
  });

  it('refuses an undo whose writes would make the org send more emails than it has left today, whatever is accepted, and writes nothing (B11, H1)', async () => {
    const r = await rewound();
    const before = stateOf(r.org);
    // A flow that emails an account's owner as it is updated: the undo gives
    // the account the rewind renamed back its name from before.
    const sending = automationOf({
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
    r.org.emailLimits = { SingleEmail: { Max: 15, Remaining: 0 } };

    const outcome = await undone(r, {
      deps: { readAutomation: sending },
      request: { acceptAutomation: true },
    });

    expect(outcome).toMatchObject({
      undone: false,
      refusal: {
        code: 'EMAILS',
        message: expect.stringMatching(
          /^This undo would make DEV-ED send about 1 single emails, 0 of 15 left today: .*then undo the rewind again\. No record was written\.$/,
        ) as unknown,
      },
    });
    expect(stateOf(r.org)).toEqual(before);
    expect((await lastRewindOf(r))?.undoneAt).toBeUndefined();
  });

  it('refuses an undo that would take more requests than the org has left today', async () => {
    const r = await rewound();
    const before = stateOf(r.org);
    r.org.limits = { Max: 15_000, Remaining: 8 };

    const outcome = await undone(r);

    expect(outcome).toMatchObject({
      undone: false,
      refusal: {
        code: 'API_BUDGET',
        message: expect.stringMatching(
          /^This undo takes about \d+ API requests; DEV-ED has 8 of its 15000 left today/,
        ) as unknown,
      },
    });
    expect(stateOf(r.org)).toEqual(before);
  });
});

describe('undoCheckpoint: stopped', () => {
  it('stopped before it writes, throws and leaves the rewind offered; stopped part way, leaves it offered too, and the next undo takes up the rest', async () => {
    const r = await rewound();
    const before = stateOf(r.org);
    const early = new AbortController();
    early.abort();
    await expect(undone(r, { deps: { signal: early.signal } })).rejects.toBeInstanceOf(UndoStopped);
    expect(stateOf(r.org)).toEqual(before);
    expect((await lastRewindOf(r))?.undoneAt).toBeUndefined();

    // Stopped once the undo wrote: after its first update.
    const midway = new AbortController();
    r.org.afterUpdate = () => {
      r.org.afterUpdate = undefined;
      midway.abort();
    };
    const part = resultOf(await undone(r, { deps: { signal: midway.signal } }));
    expect(part.status).toBe('cancelled');
    expect((await lastRewindOf(r))?.undoneAt).toBeUndefined();
    expect((await r.store.list())[0]?.undo?.rewindId).toBe(r.rewind.rewindId);

    const rest = resultOf(await undone(r));
    expect(rest.status).toBe('success');
    expect(stateOf(r.org)).toEqual(r.beforeRewind);
    expect((await lastRewindOf(r))?.undoneAt).toBeDefined();
  });
});
