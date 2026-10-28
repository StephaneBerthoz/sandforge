import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { MEMORY_ORG_USER } from '../../test/memoryRemovalOrg.js';
import {
  COLLEAGUE,
  ORG_ID,
  PREVIEWED,
  RewindTestOrg,
  SINCE,
  STAMP_FIELDS,
  T0,
  LONG_AGO,
  clock,
  previewed,
  resultOf,
  rewound,
  undone,
  writable,
  type Taken,
} from '../../test/rewindTestOrg.js';
import { openCheckpointStore } from './OrgCheckpointStore.js';
import { takeCheckpoint } from './takeCheckpoint.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({ getJsforceConnection: vi.fn() }));

/*
 * Custom settings rewound on the memory org, held to what P-C2 found of two
 * deployed side by side on a Developer Edition: a hierarchy's org default,
 * profile and user rows each one per owner, an insert or an undelete of a
 * second refused `DUPLICATE_VALUE`; a list's insert of a name taken refused
 * `FIELD_INTEGRITY_EXCEPTION`, but its undelete taken back over a live row of
 * the same name, the list then holding two.
 */

const HIERARCHY = 'Hier__c';
const LIST = 'List__c';
const PROFILE = '00e000000000001AAA';

const hier = (n: number): string => `a0A${String(n).padStart(12, '0')}AAA`;
const row = (n: number): string => `a0B${String(n).padStart(12, '0')}AAA`;

const OWNER = writable('SetupOwnerId', 'reference', {
  referenceTo: ['Organization', 'Profile', 'User'],
});

/** The objects the org describes: an account, and the two custom settings as P-C2 described them. */
const SETTINGS_FIELDS: Record<string, unknown[]> = {
  Account: [...STAMP_FIELDS, writable('Name')],
  [HIERARCHY]: [
    ...STAMP_FIELDS,
    writable('Name', 'string', { length: 80 }),
    OWNER,
    writable('Value__c'),
  ],
  [LIST]: [
    ...STAMP_FIELDS,
    writable('Name', 'string', { nillable: false, length: 38 }),
    OWNER,
    writable('Value__c'),
  ],
};

const key = (id: unknown): string => String(id).slice(0, 15);

/** See the file's comment. */
class SettingsOrg extends RewindTestOrg {
  /** Each name a list held twice, live, after a write. */
  readonly heldTwice: string[] = [];
  /** The undeletes the org refused, by id. */
  readonly refusedUndeletes: string[] = [];

  constructor() {
    super({ fields: SETTINGS_FIELDS, children: {} });
    for (const access of this.all('UserPermissionAccess')) {
      access.PermissionsCustomizeApplication = true;
    }
    this.refuseCreate = (objectApiName, record) => {
      if (objectApiName === HIERARCHY && this.ownerHeld(record.SetupOwnerId)) {
        return { statusCode: 'DUPLICATE_VALUE', message: 'duplicate value found: SetupOwnerId' };
      }
      if (objectApiName === LIST && this.all(LIST).some((live) => live.Name === record.Name)) {
        return {
          statusCode: 'FIELD_INTEGRITY_EXCEPTION',
          message: `There is already an item in this list with the name ${String(record.Name)}`,
        };
      }
      return undefined;
    };
  }

  override async describeGlobal(): Promise<unknown> {
    const global = (await super.describeGlobal()) as { sobjects: Array<{ name: string }> };
    return {
      sobjects: global.sobjects.map((object) =>
        object.name === HIERARCHY || object.name === LIST
          ? { ...object, customSetting: true }
          : object,
      ),
    };
  }

  /** Whether a live row of the hierarchy has `owner`. */
  private ownerHeld(owner: unknown): boolean {
    return this.all(HIERARCHY).some((live) => key(live.SetupOwnerId) === key(owner));
  }

  /** Each name two live rows of the list share, noted. */
  private noteTwice(): void {
    const names = this.all(LIST).map((live) => String(live.Name));
    for (const name of new Set(names)) {
      if (names.filter((other) => other === name).length > 1) this.heldTwice.push(name);
    }
  }

  override async undelete(ids: string[]): Promise<unknown> {
    const refused = new Map<string, unknown>();
    for (const id of ids) {
      const binned = this.inBin(HIERARCHY).find((held) => key(held.Id) === key(id));
      if (binned && this.ownerHeld(binned.SetupOwnerId)) {
        refused.set(id, {
          id,
          success: false,
          errors: [
            {
              statusCode: 'DUPLICATE_VALUE',
              message:
                'duplicate value found: <unknown> duplicates value on record with id: <unknown>',
            },
          ],
        });
        this.refusedUndeletes.push(id);
      }
    }
    const sent = ids.filter((id) => !refused.has(id));
    const answers =
      sent.length > 0 ? ((await super.undelete(sent)) as unknown[]) : (this.soapCalls++, []);
    this.noteTwice();
    let at = 0;
    return ids.map((id) => refused.get(id) ?? answers[at++]);
  }

  override async update(
    objectApiName: string,
    records: Array<Record<string, unknown>>,
  ): Promise<unknown> {
    const answer = await super.update(objectApiName, records);
    this.noteTwice();
    return answer;
  }
}

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The rows of the two settings the org held long before the checkpoint. */
function settingRows(org: SettingsOrg): void {
  org.add('Account', { Id: '001000000000001AAA', Name: 'Northwind' });
  org.add(HIERARCHY, { Id: hier(1), SetupOwnerId: ORG_ID, Value__c: 'org default' });
  org.add(HIERARCHY, { Id: hier(2), SetupOwnerId: PROFILE, Value__c: 'profile' });
  org.add(LIST, { Id: row(1), Name: 'W1', SetupOwnerId: ORG_ID, Value__c: 'x1' });
  org.add(LIST, { Id: row(2), Name: 'W2', SetupOwnerId: ORG_ID, Value__c: 'x2' });
}

/** A checkpoint of the settings' org, which it is taken of. */
type SettingsTaken = Taken & { org: SettingsOrg };

/** A checkpoint of everything people work in and every custom setting, taken at T0. */
async function takenWithSettings(org = new SettingsOrg()): Promise<SettingsTaken> {
  const dir = mkdtempSync(join(tmpdir(), 'sandforge-settings-'));
  dirs.push(dir);
  const opened = openCheckpointStore({ root: join(dir, 'store'), locksDir: join(dir, 'locks') });
  if ('refusal' in opened) throw new Error(`no store: ${opened.refusal.reason}`);
  clock.now = LONG_AGO;
  settingRows(org);
  clock.now = T0;
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
      mode: 'everything',
      customSettings: 'all',
      name: 'Before UAT',
    },
  );
  if (!outcome.taken) throw new Error(`refused: ${outcome.refusal.message}`);
  return {
    org,
    store: opened.store,
    checkpoint: outcome.checkpoint,
    folder: opened.store.folderOf(ORG_ID, outcome.checkpoint.checkpointId),
    atCheckpoint: { live: {}, bin: {} },
  };
}

/** The live rows of a setting, as the code that reads it does: by key and value, Ids beside. */
function rowsOf(org: SettingsOrg, objectApiName: string): Array<Record<string, unknown>> {
  return org
    .all(objectApiName)
    .map(({ Id, Name, SetupOwnerId, Value__c }) => ({
      Id,
      ...(objectApiName === LIST ? { Name } : { SetupOwnerId }),
      Value__c,
    }))
    .sort((a, b) => String(a.Id).localeCompare(String(b.Id)));
}

/** The settings' org default and profile rows deleted since, each made again by a colleague. */
function hierarchyRemade(org: SettingsOrg): void {
  clock.now = SINCE;
  org.edit(HIERARCHY, hier(1), { Value__c: 'changed' }, COLLEAGUE);
  org.trash(HIERARCHY, hier(1), COLLEAGUE);
  org.add(HIERARCHY, {
    Id: hier(3),
    SetupOwnerId: ORG_ID,
    Value__c: 'org default again',
    LastModifiedById: COLLEAGUE,
  });
  org.trash(HIERARCHY, hier(2), COLLEAGUE);
  org.add(HIERARCHY, {
    Id: hier(4),
    SetupOwnerId: PROFILE,
    Value__c: 'profile again',
    LastModifiedById: COLLEAGUE,
  });
  org.add(HIERARCHY, {
    Id: hier(5),
    SetupOwnerId: MEMORY_ORG_USER,
    Value__c: 'user',
    LastModifiedById: COLLEAGUE,
  });
}

/** A list row deleted since, and another deleted and its name given to a new row. */
function listRenamed(org: SettingsOrg): void {
  clock.now = SINCE;
  org.trash(LIST, row(1), COLLEAGUE);
  org.trash(LIST, row(2), COLLEAGUE);
  org.add(LIST, {
    Id: row(3),
    Name: 'W2',
    SetupOwnerId: ORG_ID,
    Value__c: 'y2',
    LastModifiedById: COLLEAGUE,
  });
}

describe('a rewind of custom settings held by name', () => {
  it('keeps each custom setting with its kind, and asks the guard for Customize Application at every act', async () => {
    const t = await takenWithSettings();

    expect(
      t.checkpoint.objects.map(({ objectApiName, customSetting }) => [
        objectApiName,
        customSetting,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ['Account', undefined],
        [HIERARCHY, 'hierarchy'],
        [LIST, 'list'],
      ]),
    );

    for (const access of t.org.all('UserPermissionAccess')) {
      access.PermissionsCustomizeApplication = false;
    }
    clock.now = PREVIEWED;
    await expect(previewed(t)).rejects.toThrow(
      "tester@example.com needs Customize Application to keep and rewind custom settings, and doesn't have it",
    );
  });

  it('brings back a hierarchy’s org default and profile rows that rows made since took the owner of, by deleting those first, in two passes, never sending an undelete the org refuses', async () => {
    const t = await takenWithSettings();
    hierarchyRemade(t.org);
    const diff = await previewed(t);

    const result = resultOf(await rewound(t, diff.previewId));

    expect(result.status).toBe('success');
    expect(result.passes).toBe(2);
    expect(result.residual).toEqual([]);
    expect(rowsOf(t.org, HIERARCHY)).toEqual([
      { Id: hier(1), SetupOwnerId: ORG_ID, Value__c: 'org default' },
      { Id: hier(2), SetupOwnerId: PROFILE, Value__c: 'profile' },
    ]);
    expect(
      t.org
        .inBin(HIERARCHY)
        .map((held) => held.Id)
        .sort(),
    ).toEqual([hier(3), hier(4), hier(5)]);
    // The first pass held them back, rather than send the undelete the org refuses.
    expect(t.org.refusedUndeletes).toEqual([]);
  });

  it('leaves a hierarchy row in the recycle bin, named, while the row that took its owner stays', async () => {
    const t = await takenWithSettings();
    hierarchyRemade(t.org);
    const diff = await previewed(t);
    t.org.refuse.set(hier(3), 'ENTITY_IS_LOCKED: this row is locked');

    const result = resultOf(await rewound(t, diff.previewId));

    expect(result.status).toBe('partial');
    expect(result.residual).toContainEqual(
      expect.objectContaining({
        objectApiName: HIERARCHY,
        reason: 'kept',
        ids: [hier(1)],
        message: expect.stringContaining('holds its owner or its name') as unknown,
      }),
    );
    expect(rowsOf(t.org, HIERARCHY).map((live) => live.Id)).toEqual([hier(2), hier(3)]);
    expect(t.org.refusedUndeletes).toEqual([]);
  });

  it('brings back a list’s row whose name a row made since took only once that row is deleted, the list never holding two rows of one name', async () => {
    const t = await takenWithSettings();
    listRenamed(t.org);
    const diff = await previewed(t);

    const result = resultOf(await rewound(t, diff.previewId));

    expect(result.status).toBe('success');
    expect(result.passes).toBe(2);
    expect(rowsOf(t.org, LIST)).toEqual([
      { Id: row(1), Name: 'W1', Value__c: 'x1' },
      { Id: row(2), Name: 'W2', Value__c: 'x2' },
    ]);
    expect(t.org.inBin(LIST).map((held) => held.Id)).toEqual([row(3)]);
    expect(t.org.heldTwice).toEqual([]);

    // Back under their Ids: a preview read now finds nothing to rewind.
    clock.now += 60_000;
    const again = await previewed(t);
    const list = again.objects.find((object) => object.objectApiName === LIST);
    expect(
      list === undefined || (list.toBringBack.inBin === 0 && list.toDelete.createdSince === 0),
    ).toBe(true);
  });

  it('leaves a list’s row in the recycle bin, named, rather than bring it back beside a row of its name made after the preview', async () => {
    const t = await takenWithSettings();
    clock.now = SINCE;
    t.org.trash(LIST, row(2), COLLEAGUE);
    const diff = await previewed(t);
    clock.now = PREVIEWED + 10_000;
    t.org.add(LIST, {
      Id: row(3),
      Name: 'W2',
      SetupOwnerId: ORG_ID,
      Value__c: 'y2',
      LastModifiedById: COLLEAGUE,
    });

    const result = resultOf(await rewound(t, diff.previewId));

    expect(result.status).toBe('partial');
    expect(rowsOf(t.org, LIST)).toEqual([
      { Id: row(1), Name: 'W1', Value__c: 'x1' },
      { Id: row(3), Name: 'W2', Value__c: 'y2' },
    ]);
    expect(t.org.heldTwice).toEqual([]);
    expect(result.residual).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ objectApiName: LIST, reason: 'kept', ids: [row(2)] }),
        expect.objectContaining({
          objectApiName: LIST,
          reason: 'changedSincePreview',
          ids: [row(3)],
        }),
      ]),
    );
  });

  it('is undone to the list as it was before it: the row it deleted back, those it brought back in the bin again', async () => {
    const t = await takenWithSettings();
    listRenamed(t.org);
    const diff = await previewed(t);
    const result = resultOf(await rewound(t, diff.previewId));
    expect(result.status).toBe('success');

    const undo = await undone(t, result.rewindId);

    expect(undo.status).toBe('success');
    expect(rowsOf(t.org, LIST)).toEqual([{ Id: row(3), Name: 'W2', Value__c: 'y2' }]);
    expect(
      t.org
        .inBin(LIST)
        .map((held) => held.Id)
        .sort(),
    ).toEqual([row(1), row(2)]);
    // The row it brought back went to the bin before the row of its name
    // came back: the list never held two rows of one name.
    expect(t.org.heldTwice).toEqual([]);
  });

  it('is undone to the hierarchy as it was before it: the rows that took the owners since come back once the rows it brought back have gone and freed them, none refused, no owner left without a row', async () => {
    const t = await takenWithSettings();
    hierarchyRemade(t.org);
    const diff = await previewed(t);
    const result = resultOf(await rewound(t, diff.previewId));
    expect(result.status).toBe('success');

    const undo = await undone(t, result.rewindId);

    expect(undo.status).toBe('success');
    expect(t.org.refusedUndeletes).toEqual([]);
    expect(undo.undeleted).toEqual([
      expect.objectContaining({ objectApiName: HIERARCHY, planned: 3, undeleted: 3, refused: 0 }),
    ]);
    expect(rowsOf(t.org, HIERARCHY)).toEqual([
      { Id: hier(3), SetupOwnerId: ORG_ID, Value__c: 'org default again' },
      { Id: hier(4), SetupOwnerId: PROFILE, Value__c: 'profile again' },
      { Id: hier(5), SetupOwnerId: MEMORY_ORG_USER, Value__c: 'user' },
    ]);
    expect(
      t.org
        .inBin(HIERARCHY)
        .map((held) => held.Id)
        .sort(),
    ).toEqual([hier(1), hier(2)]);
  });

  it('is undone without sending to the bin before the rows come back what the rest of the checkpoint holds: a record it deleted comes back before the records it brought back go', async () => {
    const t = await takenWithSettings();
    hierarchyRemade(t.org);
    clock.now = SINCE;
    t.org.add('Account', {
      Id: '001000000000002AAA',
      Name: 'Made since',
      LastModifiedById: COLLEAGUE,
    });
    t.org.trash('Account', '001000000000001AAA', COLLEAGUE);
    const diff = await previewed(t);
    const result = resultOf(await rewound(t, diff.previewId));
    expect(result.status).toBe('success');
    const sent: string[] = [];
    const undelete = t.org.undelete.bind(t.org);
    const destroy = t.org.destroy.bind(t.org);
    t.org.undelete = async (ids: string[]) => {
      sent.push(...ids.map((id) => `undelete ${key(id)}`));
      return undelete(ids);
    };
    t.org.destroy = async (objectApiName: string, ids: string[]) => {
      sent.push(...ids.map((id) => `delete ${key(id)}`));
      return destroy(objectApiName, ids);
    };

    const undo = await undone(t, result.rewindId);

    expect(undo.status).toBe('success');
    // The account made since, which the rewind deleted, came back before the
    // account it brought back went; the settings' rows, after theirs.
    const at = (what: string): number => sent.indexOf(what);
    expect(at(`undelete ${key('001000000000002AAA')}`)).toBeLessThan(
      at(`delete ${key('001000000000001AAA')}`),
    );
    expect(at(`delete ${key(hier(1))}`)).toBeLessThan(at(`undelete ${key(hier(3))}`));
    expect(rowsOf(t.org, 'Account').map((live) => live.Id)).toEqual(['001000000000002AAA']);
  });
});
