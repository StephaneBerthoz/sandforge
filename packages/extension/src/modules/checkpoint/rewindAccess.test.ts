import { describe, expect, it } from 'vitest';

import { grantsOf } from './checkpointAccess.js';
import type { CheckpointGrants } from './checkpointGuard.js';
import { OrgReadStopped, type DescribeAnswer } from './compositeQueries.js';
import { ORG_ACCESS, actAccessOf, notHeldWords, type ActAccessInput } from './rewindAccess.js';

/*
 * What an act on a checkpoint may read and write of each object, as its
 * guard read the user's permissions at that act: the take's rules
 * (`checkpointAccess.ts`) applied again, the objects no longer held named
 * with why, and the objects a delete takes records of along that the user
 * is not proven to see.
 */

const USER = '005000000000001AAA';
const OTHER = '005000000000009AAA';

/** A reference field to `target`, as a describe lists it. */
const lookup = (name: string, target: string) => ({
  name,
  type: 'reference',
  referenceTo: [target],
});

/** The describes of a small org: cases and their comments, accounts and their contacts and tasks. */
const DESCRIBES: Record<string, unknown> = {
  Case: {
    name: 'Case',
    fields: [lookup('AccountId', 'Account')],
    childRelationships: [{ childSObject: 'CaseComment', field: 'ParentId', cascadeDelete: true }],
  },
  CaseComment: { name: 'CaseComment', fields: [lookup('ParentId', 'Case')] },
  Account: {
    name: 'Account',
    fields: [],
    childRelationships: [
      { childSObject: 'Contact', field: 'AccountId', cascadeDelete: true },
      { childSObject: 'Task', field: 'WhatId', cascadeDelete: true },
    ],
  },
};

/** A reader that answers the describes of {@link DESCRIBES}, each a call, and counts what it was asked. */
function readerOf(describes: Record<string, unknown> = DESCRIBES): ActAccessInput['reader'] & {
  asked: string[];
} {
  let calls = 0;
  const asked: string[] = [];
  return {
    asked,
    calls: () => calls,
    describe: (name: string): Promise<DescribeAnswer> => {
      calls++;
      asked.push(name);
      return Promise.resolve({ body: describes[name] });
    },
  };
}

/** The grants of a user without View All Data and Modify All Data, as the guard reads them. */
function perObject(
  rows: Record<string, { viewAll?: boolean; modifyAll?: boolean }>,
  requests = 3,
): CheckpointGrants {
  return {
    kind: 'perObject',
    viewAllData: false,
    modifyAllData: false,
    objects: grantsOf(
      Object.entries(rows).map(([object, held]) => ({
        SobjectType: object,
        PermissionsViewAllRecords: held.viewAll ?? held.modifyAll ?? false,
        PermissionsModifyAllRecords: held.modifyAll ?? false,
      })),
    ),
    requests,
  };
}

/** A checkpoint of `objects`, taken by `takenBy`. */
const checkpointOf = (objects: string[], takenBy = USER) => ({
  objects: objects.map((objectApiName) => ({ objectApiName })),
  takenBy: { userId: takenBy },
});

describe('actAccessOf', () => {
  it('holds every object with View All Data and Modify All Data, reading nothing more', async () => {
    const reader = readerOf();

    const access = await actAccessOf({
      grants: { kind: 'org' },
      username: 'tester@example.com',
      checkpoint: checkpointOf(['Account', 'Task']),
      reader,
    });

    expect(access).toBe(ORG_ACCESS);
    expect(access.heldAs('Task')).toBe('org');
    expect(await access.unseenOf(['Task'])).toEqual([]);
    expect(access.diffAccess()).toEqual({ kind: 'org' });
    expect(reader.asked).toEqual([]);
  });

  it('holds an object with Modify All by its own row, one with no row through every record it hangs from, describing only those, and counts the guard’s reads and the describes', async () => {
    const reader = readerOf();

    const access = await actAccessOf({
      grants: perObject({ Account: { modifyAll: true }, Case: { modifyAll: true } }, 3),
      userId: USER,
      username: 'tester@example.com',
      checkpoint: checkpointOf(['Account', 'Case', 'CaseComment']),
      reader,
    });

    expect(access.kind).toBe('perObject');
    expect(access.userKey).toBe(USER.slice(0, 15));
    expect(access.heldAs('Account')).toBe('object');
    expect(access.heldAs('CaseComment')).toBe('parent');
    expect([...access.notHeld]).toEqual([]);
    // The comments, then the cases they hang from: one call each here.
    expect(reader.asked).toEqual(['CaseComment', 'Case']);
    expect(access.diffAccess()).toEqual({ kind: 'perObject', requests: 3 + 2 });
  });

  it('names each object the user no longer holds whole, with why, in the words of the user who took it', async () => {
    const access = await actAccessOf({
      grants: perObject({ Account: { modifyAll: true }, Contact: { viewAll: true }, Case: {} }),
      userId: USER,
      username: 'tester@example.com',
      checkpoint: checkpointOf(['Account', 'Contact', 'Case', 'CaseComment', 'Task']),
      reader: readerOf(),
    });

    expect(Object.fromEntries(access.notHeld)).toEqual({
      Contact: 'tester@example.com no longer has View All and Modify All on Contact',
      Case: 'tester@example.com no longer has View All and Modify All on Case',
      CaseComment:
        'tester@example.com no longer has View All and Modify All on every record CaseComment ' +
        'hangs from (Case, which ParentId names, is not held whole)',
      Task:
        "tester@example.com doesn't have View All Data and Modify All Data, which tasks and " +
        'events need: Salesforce has no View All for activities',
    });
    expect(access.heldAs('Contact')).toBeUndefined();
    expect(access.heldAs('Account')).toBe('object');
  });

  it('says another user acting on a checkpoint they did not take does not have what it needs, never that they no longer have it', async () => {
    const access = await actAccessOf({
      grants: perObject({ Account: { modifyAll: true }, Contact: {} }),
      userId: USER,
      username: 'tester@example.com',
      checkpoint: checkpointOf(['Account', 'Contact'], OTHER),
      reader: readerOf(),
    });

    expect(access.notHeld.get('Contact')).toBe(
      "tester@example.com doesn't have View All and Modify All on Contact",
    );
  });

  it('names, of the objects a delete takes along, those the user is not proven to see whole: tasks always, an object without View All, one whose parents are not held', async () => {
    const reader = readerOf();
    const access = await actAccessOf({
      grants: perObject({ Account: { modifyAll: true }, Contact: { modifyAll: true }, Lead: {} }),
      userId: USER,
      username: 'tester@example.com',
      checkpoint: checkpointOf(['Account']),
      reader,
    });

    expect(await access.unseenOf(['Contact', 'Task', 'Lead', 'CaseComment'])).toEqual([
      'Task',
      'Lead',
      'CaseComment',
    ]);
    // The comments and the cases they hang from, described once an act.
    const asked = reader.asked.length;
    expect(await access.unseenOf(['CaseComment'])).toEqual(['CaseComment']);
    expect(reader.asked).toHaveLength(asked);
    expect(access.requests()).toBe(3 + asked);
  });

  it('leaves an object that could not be described unproven, and stops as the act is stopped', async () => {
    const broken = await actAccessOf({
      grants: perObject({ Case: { modifyAll: true } }),
      userId: USER,
      username: 'tester@example.com',
      checkpoint: checkpointOf(['CaseComment']),
      reader: readerOf({}),
    });
    expect(broken.notHeld.get('CaseComment')).toBe(
      'tester@example.com no longer has View All and Modify All on every record CaseComment ' +
        'hangs from (it could not be described)',
    );

    const stopped = {
      calls: () => 0,
      describe: (): Promise<DescribeAnswer> => Promise.reject(new OrgReadStopped()),
    };
    await expect(
      actAccessOf({
        grants: perObject({ Case: { modifyAll: true } }),
        userId: USER,
        username: 'tester@example.com',
        checkpoint: checkpointOf(['CaseComment']),
        reader: stopped,
      }),
    ).rejects.toBeInstanceOf(OrgReadStopped);
  });
});

describe('notHeldWords', () => {
  it('says what each reason lacks, the object named', () => {
    expect(
      notHeldWords('Product2', { reason: 'catalog' }, 'tester@example.com', 'no longer has'),
    ).toBe(
      "tester@example.com doesn't have View All Data and Modify All Data, which products and " +
        'price books need: Salesforce has no View All or Modify All for them',
    );
    expect(
      notHeldWords(
        'ContentDocument',
        { reason: 'filesNotProven' },
        'tester@example.com',
        'no longer has',
      ),
    ).toContain('which files need');
    expect(
      notHeldWords(
        'Setting__c',
        { reason: 'settingNotProven' },
        'tester@example.com',
        "doesn't have",
      ),
    ).toContain('which custom settings need');
    expect(
      notHeldWords('Account', { reason: 'noModifyAll' }, 'tester@example.com', 'no longer has'),
    ).toBe('tester@example.com no longer has View All and Modify All on Account');
  });
});
