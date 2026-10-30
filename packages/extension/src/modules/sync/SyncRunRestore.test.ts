import { describe, it, expect, beforeEach, vi } from 'vitest';
import { restoreOverwrites, sameValue, type BackupReader } from './SyncRunRestore';
import { MemoryRestoreOrg } from '../../test/memoryRestoreOrg';

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const A1 = fakeId('001', 1);
const A2 = fakeId('001', 2);
const A3 = fakeId('001', 3);
const BACKUP = 'sync-before-run-1';

/** Minutes before now. */
const minutesAgo = (minutes: number): string =>
  new Date(Date.now() - minutes * 60_000).toISOString();

/** A backup store holding, per object of one backup, the records given. */
function backups(held: Record<string, Array<Record<string, unknown>>>): BackupReader {
  return {
    batches: async (operationId, objectApiName, size) => {
      const records = operationId === BACKUP ? held[objectApiName] : undefined;
      if (!records) return null;
      return {
        async *[Symbol.asyncIterator]() {
          for (let at = 0; at < records.length; at += size) yield records.slice(at, at + size);
        },
      };
    },
  };
}

/** The target once a run ten minutes ago wrote over three accounts. */
function target(): MemoryRestoreOrg {
  const org = new MemoryRestoreOrg();
  const at = minutesAgo(10);
  org.add('Account', { Id: A1, Name: 'After 1', Description: 'run', Phone: null }, at);
  org.add('Account', { Id: A2, Name: 'After 2', Description: 'run', Phone: null }, at);
  org.add('Account', { Id: A3, Name: 'After 3', Description: 'run', Phone: null }, at);
  return org;
}

/** What the run kept of them before it wrote: their names and descriptions, A1's phone. */
const BEFORE = {
  Account: [
    { Id: A1, Name: 'Before 1', Description: 'before', Phone: '+33 1 00 00 00 01' },
    { Id: A2, Name: 'Before 2', Description: null },
    { Id: A3, Name: 'Before 3', Description: 'before' },
  ],
};

const PLAN = [{ objectApiName: 'Account', backup: BACKUP, ids: [A1, A2, A3] }];

describe('restoreOverwrites', () => {
  let org: MemoryRestoreOrg;

  beforeEach(() => {
    org = target();
  });

  it('gives each record the values it held before the run, writing only the fields that differ', async () => {
    const outcome = await restoreOverwrites({
      org,
      plan: PLAN,
      backups: backups(BEFORE),
      lastWriteAt: minutesAgo(10),
      includeChanged: false,
    });

    expect(outcome.objects).toEqual([
      {
        objectApiName: 'Account',
        planned: 3,
        restored: 3,
        keptChanged: 0,
        alreadyGone: 0,
        refused: 0,
        notKept: 0,
        reasons: [],
      },
    ]);
    expect(outcome.left).toEqual([]);
    expect(outcome.wrote).toBe(true);
    const byId = new Map(org.all('Account').map((row) => [row.Id, row]));
    expect(byId.get(A1)).toMatchObject({
      Name: 'Before 1',
      Description: 'before',
      Phone: '+33 1 00 00 00 01',
    });
    expect(byId.get(A2)).toMatchObject({ Name: 'Before 2', Description: null });
    expect(byId.get(A3)).toMatchObject({ Name: 'Before 3', Description: 'before' });
    // A field the run did not write is not sent: A2 and A3 kept no phone.
    expect(org.updates[0].records.find((record) => record.Id === A3)).toEqual({
      Id: A3,
      Name: 'Before 3',
      Description: 'before',
    });
  });

  it('gives a record back the rest of its values when the org no longer takes one of them, and names it', async () => {
    // The run wrote over an industry and a name; the industry's value from
    // before has been deactivated in the org since.
    org.add(
      'Account',
      { Id: fakeId('001', 9), Name: 'After 9', Industry: 'Energy' },
      minutesAgo(10),
    );
    org.refuseValue.set('Industry', {
      value: 'Retired',
      statusCode: 'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST',
      message: 'bad value for restricted picklist field: Retired',
    });

    const outcome = await restoreOverwrites({
      org,
      plan: [{ objectApiName: 'Account', backup: BACKUP, ids: [fakeId('001', 9)] }],
      backups: backups({
        Account: [{ Id: fakeId('001', 9), Name: 'Before 9', Industry: 'Retired' }],
      }),
      lastWriteAt: minutesAgo(10),
      includeChanged: false,
    });

    expect(outcome.objects[0]).toMatchObject({
      planned: 1,
      restored: 0,
      restoredWithout: 1,
      refused: 0,
      reasons: [
        'Account.Industry: the value from before is no longer taken ' +
          '(INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: bad value for restricted picklist field: ' +
          'Retired) — left as the run wrote it',
      ],
    });
    // Nothing more to send for it: the run can settle.
    expect(outcome.left).toEqual([]);
    expect(org.all('Account').find((row) => row.Id === fakeId('001', 9))).toMatchObject({
      Name: 'Before 9',
      Industry: 'Energy',
    });
  });

  describe('a lookup from before that names a record in the recycle bin, which the org refuses naming no field, as it refuses a record itself deleted', () => {
    const PARENT = fakeId('001', 20);
    /** Accounts the run wrote over, each held under the parent before it; the parent deleted since. */
    const children = [fakeId('001', 21), fakeId('001', 22), fakeId('001', 23)];
    const LEFT_WORDS =
      'Account.ParentId: the value from before is no longer taken ' +
      '(ENTITY_IS_DELETED: entity is deleted) — left as the run wrote it';

    /** The statements the restore sends, in order. */
    function watched(): string[] {
      const sent: string[] = [];
      const query = org.query.bind(org);
      vi.spyOn(org, 'query').mockImplementation(async (soql, options) => {
        sent.push(soql);
        return query(soql, options);
      });
      return sent;
    }

    beforeEach(() => {
      org.add('Account', { Id: PARENT, Name: 'Parent' }, minutesAgo(600));
      for (const id of children) {
        org.add('Account', { Id: id, Name: 'After', ParentId: null }, minutesAgo(10));
      }
      org.trash('Account', PARENT);
    });

    it('gives each record still there its other fields, leaves the lookup as the run wrote it and names it, never counting the record gone', async () => {
      const sent = watched();
      const told: string[] = [];

      const outcome = await restoreOverwrites({
        org,
        plan: [{ objectApiName: 'Account', backup: BACKUP, ids: children }],
        backups: backups({
          Account: children.map((id) => ({ Id: id, Name: 'Before', ParentId: PARENT })),
        }),
        lastWriteAt: minutesAgo(10),
        includeChanged: false,
        counted: (id, as) => told.push(`${id} ${as}`),
      });

      expect(outcome.objects[0]).toMatchObject({
        planned: 3,
        restored: 0,
        restoredWithout: 3,
        alreadyGone: 0,
        refused: 0,
        reasons: [LEFT_WORDS],
      });
      expect(outcome.left).toEqual([]);
      expect(told).toEqual([]);
      for (const id of children) {
        expect(org.all('Account').find((row) => row.Id === id)).toMatchObject({
          Name: 'Before',
          ParentId: null,
        });
      }
      // One read of the refused records, whatever their number, and one
      // update of what is left of them once the lookup is set aside.
      expect(sent).toHaveLength(2);
      expect(sent[1]).toMatch(/^SELECT Id FROM Account WHERE Id IN \(/);
      expect(org.updates.map(({ records }) => records)).toEqual([
        children.map((id) => ({ Id: id, Name: 'Before', ParentId: PARENT })),
        children.map((id) => ({ Id: id, Name: 'Before' })),
      ]);
    });

    it('refuses, naming the lookup, a record still there with nothing else to give back, and offers it again', async () => {
      const [only] = children;
      org.edit('Account', only, { Name: 'Before' });
      org.touch('Account', only, minutesAgo(10));

      const outcome = await restoreOverwrites({
        org,
        plan: [{ objectApiName: 'Account', backup: BACKUP, ids: [only] }],
        backups: backups({ Account: [{ Id: only, Name: 'Before', ParentId: PARENT }] }),
        lastWriteAt: minutesAgo(10),
        includeChanged: false,
      });

      expect(outcome.objects[0]).toMatchObject({
        restored: 0,
        alreadyGone: 0,
        refused: 1,
        reasons: [LEFT_WORDS],
      });
      expect(outcome.objects[0].restoredWithout).toBeUndefined();
      expect(outcome.left).toEqual([only]);
      expect(org.updates).toHaveLength(1);
    });

    it('counts gone a record deleted between its read and its write, read again before it is, and sends it nothing more', async () => {
      const [deleted, ...others] = children;
      const update = org.update.bind(org);
      vi.spyOn(org, 'update').mockImplementationOnce(async (objectApiName, records) => {
        org.trash('Account', deleted);
        return update(objectApiName, records);
      });
      const told: string[] = [];

      const outcome = await restoreOverwrites({
        org,
        plan: [{ objectApiName: 'Account', backup: BACKUP, ids: children }],
        backups: backups({
          Account: [
            { Id: deleted, Name: 'Before', ParentId: PARENT },
            ...others.map((id) => ({ Id: id, Name: 'Before' })),
          ],
        }),
        lastWriteAt: minutesAgo(10),
        includeChanged: false,
        counted: (id, as) => told.push(`${id} ${as}`),
      });

      expect(outcome.objects[0]).toMatchObject({ restored: 2, alreadyGone: 1, refused: 0 });
      expect(outcome.objects[0].restoredWithout).toBeUndefined();
      expect(told.sort()).toEqual(
        [`${deleted} alreadyGone`, ...others.map((id) => `${id} restored`)].sort(),
      );
      expect(org.updates).toHaveLength(1);
    });

    it('of several lookups, sends each alone and leaves the one the org refuses, the others given back', async () => {
      const [one] = children;
      const partner = fakeId('001', 30);
      org.add('Account', { Id: partner, Name: 'Partner' }, minutesAgo(600));

      const outcome = await restoreOverwrites({
        org,
        plan: [{ objectApiName: 'Account', backup: BACKUP, ids: [one] }],
        backups: backups({
          Account: [{ Id: one, Name: 'Before', ParentId: PARENT, Partner__c: partner }],
        }),
        lastWriteAt: minutesAgo(10),
        includeChanged: false,
      });

      expect(outcome.objects[0]).toMatchObject({
        restored: 0,
        restoredWithout: 1,
        alreadyGone: 0,
        refused: 0,
        reasons: [LEFT_WORDS],
      });
      expect(org.all('Account').find((row) => row.Id === one)).toMatchObject({
        Name: 'Before',
        ParentId: null,
        Partner__c: partner,
      });
      expect(org.updates.map(({ records }) => records)).toEqual([
        [{ Id: one, Name: 'Before', ParentId: PARENT, Partner__c: partner }],
        [{ Id: one, ParentId: PARENT }],
        [{ Id: one, Partner__c: partner }],
        [{ Id: one, Name: 'Before' }],
      ]);
    });

    it('sends no read of its own when the org refuses nothing', async () => {
      org.untrash(PARENT);
      const sent = watched();

      const outcome = await restoreOverwrites({
        org,
        plan: [{ objectApiName: 'Account', backup: BACKUP, ids: children }],
        backups: backups({
          Account: children.map((id) => ({ Id: id, Name: 'Before', ParentId: PARENT })),
        }),
        lastWriteAt: minutesAgo(10),
        includeChanged: false,
      });

      expect(outcome.objects[0]).toMatchObject({ restored: 3, alreadyGone: 0 });
      expect(sent).toHaveLength(1);
      expect(org.updates).toHaveLength(1);
    });
  });

  it('says which encrypted fields it could not give back, kept by no run that read them masked', async () => {
    const outcome = await restoreOverwrites({
      org,
      plan: PLAN,
      backups: backups(BEFORE),
      lastWriteAt: minutesAgo(10),
      includeChanged: false,
      unkept: [{ objectApiName: 'Account', fields: ['Tax__c'] }],
    });

    expect(outcome.objects[0].reasons).toEqual([
      "Account.Tax__c: not kept, encrypted — the run's user cannot view encrypted data, and " +
        'read their values from before masked; left as the run wrote them',
    ]);
    // Nothing of that field is sent: the rest is given back as it was.
    expect(org.updates.flatMap(({ records }) => records).some((r) => 'Tax__c' in r)).toBe(false);
  });

  it('leaves a record changed since the run as it is, unless the changed ones are included', async () => {
    org.touch('Account', A2, new Date(Date.now() + 60_000).toISOString());

    const left = await restoreOverwrites({
      org,
      plan: PLAN,
      backups: backups(BEFORE),
      lastWriteAt: minutesAgo(10),
      includeChanged: false,
    });
    expect(left.objects[0]).toMatchObject({ restored: 2, keptChanged: 1 });
    expect(left.left).toEqual([A2]);
    expect(org.all('Account').find((row) => row.Id === A2)).toMatchObject({ Name: 'After 2' });

    const included = await restoreOverwrites({
      org,
      plan: [{ objectApiName: 'Account', backup: BACKUP, ids: [A2] }],
      backups: backups(BEFORE),
      lastWriteAt: minutesAgo(10),
      includeChanged: true,
    });
    expect(included.objects[0]).toMatchObject({ restored: 1, keptChanged: 0 });
    expect(org.all('Account').find((row) => row.Id === A2)).toMatchObject({ Name: 'Before 2' });
  });

  it('writes nothing to a record that holds its values from before already', async () => {
    const outcome = await restoreOverwrites({
      org,
      plan: [{ objectApiName: 'Account', backup: BACKUP, ids: [A1] }],
      backups: backups({ Account: [{ Id: A1, Name: 'After 1', Description: 'run' }] }),
      lastWriteAt: minutesAgo(10),
      includeChanged: false,
    });

    expect(outcome.objects[0]).toMatchObject({ planned: 1, restored: 1 });
    expect(org.updates).toEqual([]);
    expect(outcome.wrote).toBe(false);
  });

  it('counts apart a record gone from the target, one whose values are no longer kept, and one the target refuses', async () => {
    org.refuseUpdate.set(A3, {
      statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
      message: 'Name is locked',
    });
    await org.destroy('Account', [A1]);

    const outcome = await restoreOverwrites({
      org,
      plan: PLAN,
      backups: backups({ Account: BEFORE.Account.filter((record) => record.Id !== A2) }),
      lastWriteAt: minutesAgo(10),
      includeChanged: false,
    });

    expect(outcome.objects[0]).toMatchObject({
      planned: 3,
      restored: 0,
      alreadyGone: 1,
      notKept: 1,
      refused: 1,
      reasons: ['FIELD_CUSTOM_VALIDATION_EXCEPTION: Name is locked'],
    });
    // Only the refused one can be offered again: the others never can be.
    expect(outcome.left).toEqual([A3]);
  });

  it('tells each record it counts given back whole or gone, by the id the plan names it by, and none it refused or left as changed since', async () => {
    const same = fakeId('001', 4);
    const gone = fakeId('001', 5);
    org.add('Account', { Id: same, Name: 'Same', Description: 'run' }, minutesAgo(10));
    org.add('Account', { Id: gone, Name: 'After 5', Description: 'run' }, minutesAgo(10));
    await org.destroy('Account', [gone]);
    org.touch('Account', A2, new Date(Date.now() + 60_000).toISOString());
    org.refuseUpdate.set(A3, {
      statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
      message: 'Name is locked',
    });
    const told: string[] = [];

    const outcome = await restoreOverwrites({
      org,
      plan: [
        { objectApiName: 'Account', backup: BACKUP, ids: [A1.slice(0, 15), A2, A3, same, gone] },
      ],
      backups: backups({
        Account: [
          ...BEFORE.Account,
          { Id: same, Name: 'Same', Description: 'run' },
          { Id: gone, Name: 'Before 5', Description: 'before' },
        ],
      }),
      lastWriteAt: minutesAgo(10),
      includeChanged: false,
      counted: (id, as) => told.push(`${id} ${as}`),
    });

    expect(outcome.objects[0]).toMatchObject({
      planned: 5,
      restored: 2,
      keptChanged: 1,
      refused: 1,
      alreadyGone: 1,
    });
    expect(told.sort()).toEqual(
      [`${A1.slice(0, 15)} restored`, `${same} restored`, `${gone} alreadyGone`].sort(),
    );
  });

  it('counts every record not kept when the backup is gone, and asks the org nothing of them', async () => {
    const outcome = await restoreOverwrites({
      org,
      plan: PLAN,
      backups: backups({}),
      lastWriteAt: minutesAgo(10),
      includeChanged: false,
    });

    expect(outcome.objects[0]).toMatchObject({ planned: 3, notKept: 3, restored: 0 });
    expect(outcome.left).toEqual([]);
    expect(org.updates).toEqual([]);
  });

  it('stops before its next call to the org, the rest offered again', async () => {
    const stop = new AbortController();
    stop.abort();

    const outcome = await restoreOverwrites({
      org,
      plan: PLAN,
      backups: backups(BEFORE),
      lastWriteAt: minutesAgo(10),
      includeChanged: false,
      signal: stop.signal,
    });

    expect(outcome.cancelled).toBe(true);
    expect(outcome.objects[0]).toMatchObject({ planned: 3, notReached: 3 });
    expect(outcome.left).toEqual([A1, A2, A3]);
    expect(org.updates).toEqual([]);
  });

  it('takes a record for changed since when the run says nothing of when it last wrote', async () => {
    const outcome = await restoreOverwrites({
      org,
      plan: PLAN,
      backups: backups(BEFORE),
      includeChanged: false,
    });

    expect(outcome.objects[0]).toMatchObject({ keptChanged: 3, restored: 0 });
  });
});

describe('sameValue', () => {
  it('reads nothing and an empty text alike, a number whatever its form, a date whatever its zone', () => {
    expect(sameValue(null, '')).toBe(true);
    expect(sameValue(undefined, null)).toBe(true);
    expect(sameValue('a', null)).toBe(false);
    expect(sameValue(3, '3.0')).toBe(true);
    expect(sameValue('2026-10-22T08:00:00.000+0000', '2026-10-22T08:00:00Z')).toBe(true);
    expect(sameValue('2026-10-22T08:00:00.000+0000', '2026-10-22T08:00:01Z')).toBe(false);
    expect(sameValue('Before', 'before')).toBe(false);
    expect(sameValue(true, true)).toBe(true);
    expect(sameValue(true, false)).toBe(false);
  });
});
