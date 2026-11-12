import { describe, expect, it, vi } from 'vitest';
import type { DataOpsEmptyAccess } from '@sandforge/shared';

import { accessNarrowedSince, emptyAccessOf } from './emptyAccess.js';
import type { CheckpointDescribe } from '../../checkpoint/checkpointFields.js';

const ACCOUNT: CheckpointDescribe = {
  name: 'Account',
  fields: [{ name: 'Id', type: 'id' }],
  childRelationships: [{ childSObject: 'Contact', field: 'AccountId', cascadeDelete: true }],
} as CheckpointDescribe;

const CONTACT: CheckpointDescribe = {
  name: 'Contact',
  fields: [
    { name: 'Id', type: 'id' },
    { name: 'AccountId', type: 'reference', referenceTo: ['Account'] },
  ],
  childRelationships: [],
} as CheckpointDescribe;

describe('emptyAccessOf', () => {
  it('reads nothing of a user with View All Data and Modify All Data', async () => {
    const grants = vi.fn();
    const access = await emptyAccessOf({
      permissions: { viewAllData: true, modifyAllData: true, hardDelete: false },
      objects: ['Account', 'Task'],
      grants,
      describe: async () => [],
    });
    expect(access).toEqual({ kind: 'org' });
    expect(grants).not.toHaveBeenCalled();
  });

  it('names, without them, the objects the user is not proven to see whole, tasks always among them', async () => {
    const access = await emptyAccessOf({
      permissions: { viewAllData: false, modifyAllData: false, hardDelete: false },
      objects: ['Account', 'Contact', 'Task', 'Case'],
      grants: async () => ({
        grants: new Map([
          ['account', { viewAll: true, modifyAll: true }],
          ['case', { viewAll: true, modifyAll: false }],
        ]),
      }),
      describe: async (names) => [ACCOUNT, CONTACT].filter((d) => names.includes(d.name)),
    });
    expect(access.kind).toBe('perObject');
    if (access.kind !== 'perObject') return;
    expect(access.unseen.map((object) => [object.objectApiName, object.reason])).toEqual([
      ['Task', 'activities'],
      ['Case', 'noModifyAll'],
    ]);
  });

  it('names every object when the grants could not be read, with the org’s words', async () => {
    const access = await emptyAccessOf({
      permissions: { viewAllData: true, modifyAllData: false, hardDelete: false },
      objects: ['Account'],
      grants: async () => ({ unread: 'INSUFFICIENT_ACCESS: View Setup is needed' }),
      describe: async () => [],
    });
    expect(access).toEqual({
      kind: 'perObject',
      viewAllData: true,
      modifyAllData: false,
      unseen: [
        {
          objectApiName: 'Account',
          reason: 'permissionsUnread',
          detail: 'INSUFFICIENT_ACCESS: View Setup is needed',
        },
      ],
    });
  });
});

describe('accessNarrowedSince', () => {
  it('names the objects a run would read with less than its preview showed', () => {
    const before: DataOpsEmptyAccess = { kind: 'org' };
    const after: DataOpsEmptyAccess = {
      kind: 'perObject',
      viewAllData: false,
      modifyAllData: false,
      unseen: [{ objectApiName: 'Account', reason: 'noModifyAll' }],
    };
    expect(accessNarrowedSince(before, after)).toEqual(['Account']);
    expect(accessNarrowedSince(after, after)).toEqual([]);
    expect(accessNarrowedSince(after, before)).toEqual([]);
  });
});
