import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  openCheckpointStore,
  type OrgCheckpointStore,
} from '../modules/checkpoint/OrgCheckpointStore.js';
import { heldFileLinks } from '../modules/checkpoint/checkpointFiles.js';
import { readReplayAnnex } from '../modules/checkpoint/replay/replayAnnex.js';
import { SnapshotIndex } from '../modules/checkpoint/snapshotIndex.js';
import {
  SOURCE_ORG_ID,
  TARGET_ORG_ID,
  ReplayTargetOrg,
  fabricateCheckpoint,
  idOf,
  settingFields,
} from './replayOrgs.js';

/*
 * The two ends of a replay in miniature: a checkpoint's folder that the
 * store and the snapshot read as a take's, and another org that reads and
 * refuses as an org does.
 */

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function storeIn(): OrgCheckpointStore {
  const dir = mkdtempSync(join(tmpdir(), 'sandforge-replay-orgs-'));
  dirs.push(dir);
  const opened = openCheckpointStore({ root: join(dir, 'store'), locksDir: join(dir, 'locks') });
  if ('refusal' in opened) throw new Error(opened.refusal.reason);
  return opened.store;
}

describe('a fabricated checkpoint', () => {
  it('is listed as a checkpoint the store can use, its records read back from its compressed snapshot', async () => {
    const store = storeIn();
    const account = idOf('001', 1);

    const { checkpoint, folder } = await fabricateCheckpoint(store, {
      objects: [{ objectApiName: 'Account', rows: [{ Id: account, Name: 'Acme' }] }],
    });

    expect(await store.list()).toMatchObject([
      { checkpointId: checkpoint.checkpointId, valid: true },
    ]);
    const index = await SnapshotIndex.read(folder, checkpoint.snapshotId, 'Account');
    expect(index.format).toBe(2);
    const rows = [];
    for await (const row of index.records()) rows.push(row);
    expect(rows).toEqual([expect.objectContaining({ Id: account, Name: 'Acme' })]);
    expect(checkpoint.org.organizationId).toBe(SOURCE_ORG_ID);
    expect(await readReplayAnnex(folder)).toBeUndefined();
  });

  it('keeps its annex, counted in its file, and the links of its files, as a take of 1.81 does', async () => {
    const store = storeIn();
    const link = {
      Id: idOf('06A', 1),
      ContentDocumentId: idOf('069', 1),
      LinkedEntityId: idOf('001', 1),
      ShareType: 'V',
      Visibility: 'AllUsers',
    };

    const { checkpoint, folder } = await fabricateCheckpoint(store, {
      objects: [{ objectApiName: 'Account', rows: [{ Id: idOf('001', 1), Name: 'Acme' }] }],
      annex: { recordTypes: [], users: [], queues: [] },
      files: {
        links: [link],
        documents: [
          { Id: idOf('069', 1), LatestPublishedVersionId: null, ContentSize: 10, anchored: true },
        ],
      },
    });

    expect(checkpoint.replayAnnex).toEqual({
      recordTypes: 0,
      users: 0,
      queues: 0,
      standardPricebook: false,
    });
    expect((await readReplayAnnex(folder))?.organizationId).toBe(SOURCE_ORG_ID);
    const links = [];
    for await (const each of heldFileLinks(folder)) links.push(each);
    expect(links).toEqual([link]);
  });
});

describe('the other org', () => {
  it('answers a describe of an object it has, and refuses one of an object it has not', async () => {
    const org = new ReplayTargetOrg();
    const access = org.access();

    expect((await access.describe('x', 'Account')).fields.map((field) => field.name)).toContain(
      'IsPersonAccount',
    );
    await expect(access.describe('x', 'Gadget__c')).rejects.toMatchObject({
      errorCode: 'NOT_FOUND',
    });
    expect((await access.describe('x', 'ContentDocument')).createable).toBe(false);
  });

  it('refuses the columns and objects an org without person accounts, or of one currency, does not have', async () => {
    const access = new ReplayTargetOrg({ personAccounts: false }).access();

    await expect(
      access.query('x', 'SELECT Id, IsPersonType FROM RecordType'),
    ).rejects.toMatchObject({ errorCode: 'INVALID_FIELD' });
    await expect(
      access.query('x', 'SELECT IsoCode, IsActive FROM CurrencyType'),
    ).rejects.toMatchObject({
      errorCode: 'INVALID_TYPE',
    });
    expect((await access.describe('x', 'Account')).fields.map((field) => field.name)).not.toContain(
      'CurrencyIsoCode',
    );
  });

  it('reads its active currencies, users, record types and queues as an org answers them', async () => {
    const org = new ReplayTargetOrg({ currencies: ['USD', 'EUR'] })
      .addRecordType({
        id: idOf('012', 1),
        sobjectType: 'Account',
        developerName: 'PersonAccount',
        isPersonType: true,
      })
      .addQueue(idOf('00G', 1), 'Escalations', ['Case']);
    const access = org.access();

    const active = await access.query('x', 'SELECT IsoCode, IsActive FROM CurrencyType');
    expect(active.filter((row) => row.IsActive === true).map((row) => row.IsoCode)).toEqual([
      'USD',
      'EUR',
    ]);
    expect(
      await access.query('x', "SELECT Id, DeveloperName FROM Group WHERE Type = 'Queue'"),
    ).toEqual([{ Id: idOf('00G', 1), DeveloperName: 'Escalations' }]);
    expect(await access.query('x', 'SELECT QueueId, SobjectType FROM QueueSobject')).toEqual([
      { QueueId: idOf('00G', 1), SobjectType: 'Case' },
    ]);
    expect(await access.query('x', 'SELECT Id, IsPersonType FROM RecordType')).toEqual([
      { Id: idOf('012', 1), IsPersonType: true },
    ]);
    expect(org.organizationId).toBe(TARGET_ORG_ID);
  });

  it('writes what an org takes, and refuses what an org refuses, in its words', async () => {
    const org = new ReplayTargetOrg({ currencies: ['USD'] })
      .addUser({ id: idOf('005', 7), username: 'idle@example.com', isActive: false })
      .addRecordType({
        id: idOf('012', 1),
        sobjectType: 'Account',
        developerName: 'Hidden',
        available: false,
      })
      .withObject('Hier__c', settingFields('hierarchy'));
    const writer = org.writer();
    const insert = async (objectApiName: string, record: Record<string, unknown>) =>
      (await writer.insert('x', objectApiName, [record]))[0];

    expect(await insert('Account', { Name: 'Acme', CurrencyIsoCode: 'USD' })).toMatchObject({
      success: true,
    });
    const refusedWith = async (objectApiName: string, record: Record<string, unknown>) =>
      (await insert(objectApiName, record)).errors[0]?.split(':')[0];
    expect(await refusedWith('Account', { Name: 'Acme', OwnerId: idOf('005', 6) })).toBe(
      'INVALID_CROSS_REFERENCE_KEY',
    );
    expect(await refusedWith('Account', { Name: 'Acme', OwnerId: idOf('005', 7) })).toBe(
      'INACTIVE_OWNER_OR_USER',
    );
    expect(await refusedWith('Account', { Name: 'Acme', RecordTypeId: idOf('012', 1) })).toBe(
      'INVALID_CROSS_REFERENCE_KEY',
    );
    expect(await refusedWith('Account', { Name: 'Acme', CurrencyIsoCode: 'GBP' })).toBe(
      'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST',
    );
    expect(await refusedWith('Account', { Industry: 'Energy' })).toBe('REQUIRED_FIELD_MISSING');
    expect(await refusedWith('Contact', { LastName: 'One', AccountId: idOf('001', 99) })).toBe(
      'INVALID_CROSS_REFERENCE_KEY',
    );
    expect(await refusedWith('ContentDocument', { Title: 'Contract' })).toBe(
      'INVALID_TYPE_FOR_OPERATION',
    );
    expect(await insert('Hier__c', { SetupOwnerId: TARGET_ORG_ID })).toMatchObject({
      success: true,
    });
    expect(await refusedWith('Hier__c', { SetupOwnerId: TARGET_ORG_ID })).toBe('DUPLICATE_VALUE');
  });

  it('writes the direct relation of a contact inserted with an account, in the same save, when told', async () => {
    const org = new ReplayTargetOrg({ directRelations: true });
    const writer = org.writer();
    const [account] = await writer.insert('x', 'Account', [{ Name: 'Acme' }]);
    const [contact, alone] = await writer.insert('x', 'Contact', [
      { LastName: 'One', AccountId: account?.id },
      { LastName: 'Two' },
    ]);

    const relations = org.org.all('AccountContactRelation');
    expect(relations).toHaveLength(1);
    expect(relations[0]).toMatchObject({
      AccountId: account?.id,
      ContactId: contact?.id,
      IsDirect: true,
      CreatedDate: org.org.all('Contact').find((row) => row.Id === contact?.id)?.CreatedDate,
    });
    expect(alone?.success).toBe(true);
    expect(new ReplayTargetOrg().org.all('AccountContactRelation')).toEqual([]);
  });
});
