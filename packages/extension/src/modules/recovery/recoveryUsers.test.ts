import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RecoveryUsersRunPayload, UsersPlanAnswer } from '@sandforge/shared';

import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { SasPathGuard, findRepoRoot } from '../frozendataset/SasPathGuard.js';
import { UsersRunStore, type UsersRunRecord } from '../users/usersRunStore.js';
import {
  ObservedUsersRunStore,
  USERS_RUN_NOT_FOUND,
  USERS_RUN_REPLACED,
  awaitingAddressesOf,
  changingUsersOf,
  choicesKeyOf,
  planSignatureOf,
  readSavedTesters,
  recoveryTestersKey,
  recoveryUsersOf,
  replacedRunOf,
  saveTesters,
  usersAuditObjectsOf,
  usersDoneOf,
} from './recoveryUsers.js';

const ORG = '00Dxx0000001234EAA';

/** The repository the stores must stay out of: this one. */
const guard = new SasPathGuard(findRepoRoot(process.cwd()));
const PROFILE = '00exx0000001234AAA';

/** One user a run holds, its address as the run left it. */
function held(username: string, userId: string, address?: 'awaiting' | 'restored') {
  return {
    applied: {
      username,
      userId,
      before: { isActive: false, isFrozen: true, profileId: PROFILE },
      done: [
        { what: 'active' as const, from: false, to: true },
        { what: 'frozen' as const, from: true, to: false },
      ],
      created: { permissionSetAssignments: [], groupMembers: [] },
      ...(address !== undefined ? { address } : {}),
    },
    after: { isActive: true, isFrozen: false, profileId: PROFILE },
    accesses: [],
    inFile: true,
  };
}

function record(run: number, users: UsersRunRecord['users'], replaces?: number): UsersRunRecord {
  return {
    version: 1,
    organizationId: ORG,
    run,
    ...(replaces !== undefined ? { replaces } : {}),
    status: 'success',
    startedAt: '2026-11-18T09:00:00.000Z',
    endedAt: '2026-11-18T09:01:00.000Z',
    emailsToPeople: 0,
    users,
  };
}

const JANE = '005xx0000001234AAA';
const PAUL = '005xx0000005678AAA';

function plan(over: Partial<UsersPlanAnswer> = {}): UsersPlanAnswer {
  return {
    org: { organizationId: ORG, kind: 'sandbox', alias: 'UAT', username: 'admin@acme.test.uat' },
    users: [
      {
        username: 'jane.qa@acme.test.uat',
        userId: JANE,
        address: 'invalid',
        changes: [
          { what: 'email', to: 'awaiting' },
          { what: 'active', from: false, to: true },
          { what: 'frozen', from: true, to: false },
        ],
        emailsToPeople: 1,
      },
      { username: 'paul.qa@acme.test.uat', userId: PAUL, changes: [] },
    ],
    emailsToPeople: 1,
    apiRequests: 9,
    ...over,
  };
}

describe('the users read in the sandbox, as the page lists them', () => {
  it('says an address under .invalid awaiting its click when a run of this org asked it back', () => {
    const awaiting = awaitingAddressesOf([
      record(2, [held('Paul.QA@acme.test.uat', PAUL)]),
      record(1, [
        held('jane.qa@acme.test.uat', JANE, 'awaiting'),
        held('paul.qa@acme.test.uat', PAUL, 'awaiting'),
      ]),
    ]);
    // Run 2, the newest to hold paul, asked nothing of his address.
    expect([...awaiting]).toEqual(['jane.qa@acme.test.uat']);

    const users = recoveryUsersOf(
      [
        {
          userId: JANE,
          username: 'jane.qa@acme.test.uat',
          address: 'invalid',
          active: true,
          frozen: false,
          profile: 'QA',
        },
        {
          userId: PAUL,
          username: 'paul.qa@acme.test.uat',
          address: 'invalid',
          active: false,
          frozen: true,
        },
        {
          userId: '005xx0000009999AAA',
          username: 'ops@acme.test.uat',
          address: 'valid',
          active: false,
          frozen: false,
        },
      ],
      awaiting,
    );
    expect(users.map((user) => [user.username, user.address])).toEqual([
      ['jane.qa@acme.test.uat', 'awaiting'],
      ['paul.qa@acme.test.uat', 'invalid'],
      ['ops@acme.test.uat', 'restored'],
    ]);
    // The person is never named: the extension does not read it.
    expect(users.every((user) => user.name === undefined)).toBe(true);
    expect(users[0]?.profile).toBe('QA');
  });
});

describe('the testers kept for a sandbox', () => {
  it('are filed by the host a refresh keeps, else by the entry, and read back as kept', () => {
    const configStore = new ConfigStore(new InMemoryConfigStoreBackend());
    configStore.initialize();
    const key = recoveryTestersKey('acme--uat.sandbox.my.salesforce.com', 'entry-uat');
    expect(key).toBe('recoveryTesters:host:acme--uat.sandbox.my.salesforce.com');
    expect(recoveryTestersKey(undefined, 'entry-uat')).toBe('recoveryTesters:entry:entry-uat');

    const config = { users: [{ username: 'jane.qa@acme.test.uat', email: 'restore' as const }] };
    const saved = saveTesters(configStore, key, config, new Date('2026-11-18T09:00:00.000Z'));
    expect(readSavedTesters(configStore, key)).toEqual(saved);
    expect(
      readSavedTesters(configStore, recoveryTestersKey(undefined, 'entry-uat')),
    ).toBeUndefined();

    // What does not read as a list is no list.
    configStore.set(key, { config: { users: [] }, savedAt: 'yesterday' }, 'recovery');
    expect(readSavedTesters(configStore, key)).toBeUndefined();
  });
});

describe('a run of the page', () => {
  let root: string;
  let store: UsersRunStore;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sandforge-recovery-users-'));
    store = new UsersRunStore({ root, guard });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('replaces a run the command line keeps, and refuses one not kept or replaced already', async () => {
    await store.begin(ORG, {
      status: 'success',
      startedAt: '2026-11-18T09:00:00.000Z',
      emailsToPeople: 0,
      users: [],
    });
    await store.begin(ORG, {
      replaces: 1,
      status: 'success',
      startedAt: '2026-11-18T10:00:00.000Z',
      emailsToPeople: 0,
      users: [],
    });
    expect(await replacedRunOf(store, ORG, 2)).toMatchObject({ record: { run: 2 } });
    expect(await replacedRunOf(store, ORG, 1)).toMatchObject({
      refusal: { code: USERS_RUN_REPLACED },
    });
    expect(await replacedRunOf(store, ORG, 7)).toMatchObject({
      refusal: { code: USERS_RUN_NOT_FOUND },
    });
  });

  it('answers a simulation for the same choices alone, acceptances included', () => {
    const payload: RecoveryUsersRunPayload = {
      orgId: 'entry-uat',
      config: { users: [{ username: 'jane.qa@acme.test.uat', email: 'restore' }] },
      acceptUserEmails: true,
      acceptEmails: false,
      acceptAutomation: false,
    };
    expect(choicesKeyOf(payload)).toBe(choicesKeyOf({ ...payload }));
    expect(choicesKeyOf(payload)).not.toBe(choicesKeyOf({ ...payload, acceptEmails: true }));
    expect(choicesKeyOf(payload)).not.toBe(choicesKeyOf({ ...payload, replaces: 2 }));
  });

  it('takes two plans for the same run when they say the same, whatever they cost to read', () => {
    expect(planSignatureOf(plan())).toBe(planSignatureOf(plan({ apiRequests: 12 })));
    // One more person emailed: the org changed.
    expect(planSignatureOf(plan())).not.toBe(planSignatureOf(plan({ emailsToPeople: 2 })));
    expect(changingUsersOf(plan())).toBe(1);
  });

  it('counts a user done once the org took or refused each of its changes', () => {
    const one = held('jane.qa@acme.test.uat', JANE);
    expect(usersDoneOf(record(1, [one]), plan())).toBe(0);
    const refused = {
      ...one,
      applied: {
        ...one.applied,
        refused: [
          {
            change: { what: 'email' as const, to: 'awaiting' as const },
            code: 'FIELD_INTEGRITY_EXCEPTION',
            message: 'refused',
          },
        ],
      },
    };
    expect(usersDoneOf(record(1, [refused]), plan())).toBe(1);
  });

  it('records per object what a run did, counts alone', () => {
    const objects = usersAuditObjectsOf({
      org: plan().org,
      run: 2,
      status: 'partial',
      users: [
        {
          ...held('jane.qa@acme.test.uat', JANE).applied,
          done: [
            { what: 'active', from: false, to: true },
            { what: 'frozen', from: true, to: false },
            { what: 'permissionSet', name: 'QA_Tools', to: 'added' },
            { what: 'group', name: 'QA_Team', type: 'Regular', to: 'removed' },
          ],
          created: { permissionSetAssignments: ['0Paxx0000001234AAA'], groupMembers: [] },
          refused: [
            {
              change: { what: 'email', to: 'awaiting' },
              code: 'FIELD_INTEGRITY_EXCEPTION',
              message: 'refused',
            },
          ],
        },
      ],
      emailsToPeople: 0,
      apiRequests: 12,
    });
    expect(objects).toEqual([
      { objectApiName: 'User', created: 0, updated: 1, deleted: 0, failed: 1 },
      { objectApiName: 'UserLogin', created: 0, updated: 1, deleted: 0, failed: 0 },
      { objectApiName: 'PermissionSetAssignment', created: 1, updated: 0, deleted: 0, failed: 0 },
      { objectApiName: 'GroupMember', created: 0, updated: 0, deleted: 1, failed: 0 },
    ]);
    expect(JSON.stringify(objects)).not.toContain('jane');
  });

  it('is told of each run file written, as the run writes it after a step', async () => {
    const written: number[] = [];
    const observed = new ObservedUsersRunStore({ root, guard }, (each) => written.push(each.run));
    const begun = await observed.begin(ORG, {
      status: 'running',
      startedAt: '2026-11-18T09:00:00.000Z',
      emailsToPeople: 0,
      users: [],
    });
    await observed.write({ ...begun, status: 'success' });
    expect(written).toEqual([1]);
    expect((await store.read(ORG, 1))?.status).toBe('success');
  });
});
