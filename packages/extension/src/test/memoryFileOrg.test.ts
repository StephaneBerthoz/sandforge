import { describe, expect, it } from 'vitest';
import { MEMORY_ORG_USER, orgStamp, type MemoryRow } from './memoryRemovalOrg.js';
import {
  FILE_DOCUMENT,
  FILE_LINK,
  FILE_VERSION,
  MemoryFileOrg,
  SHARE_TYPE_REFUSAL,
  fileId,
} from './memoryFileOrg.js';

/*
 * The memory org's files against what the probes of tour 0 saw a scratch
 * org do (P-A1 to P-A8, FA4, FA5): each test one probe's answer.
 */

/** The org's clock, which a test moves. */
let clock = Date.parse('2026-10-28T09:50:00.000Z');

const ACCOUNT_1 = '001000000000001AAA';
const ACCOUNT_2 = '001000000000002AAA';
const OTHER_USER = '005000000000077AAA';

/** An org of one account holding one file, the session user's, linked to it. */
function orgWithFile(): MemoryFileOrg {
  clock = Date.parse('2026-10-28T09:50:00.000Z');
  const org = new MemoryFileOrg(
    { Account: [{ childSObject: 'Attachment', field: 'ParentId', cascadeDelete: true }] },
    { now: () => clock },
  );
  org.add('Account', { Id: ACCOUNT_1, Name: 'SFCK-A-P1' });
  org.add('Account', { Id: ACCOUNT_2, Name: 'SFCK-A-P1b' });
  org.addFile({
    documentId: fileId(1),
    title: 'SFCK-A-P1-F',
    size: 11,
    links: [{ entityId: ACCOUNT_1 }],
  });
  return org;
}

/** The links of a file, as `queryAll` reads them by the file. */
async function linksOf(
  org: MemoryFileOrg,
  documentId: string,
  scanAll = true,
): Promise<MemoryRow[]> {
  const soql = `SELECT Id, LinkedEntityId, IsDeleted, SystemModstamp FROM ContentDocumentLink WHERE ContentDocumentId = '${documentId}'`;
  return (await org.query(soql, { scanAll })).records;
}

/** A file's row, read by its id. */
async function fileRow(org: MemoryFileOrg, documentId: string): Promise<MemoryRow | undefined> {
  const soql = `SELECT Id, IsDeleted, Title, LatestPublishedVersionId, LastModifiedDate, SystemModstamp FROM ContentDocument WHERE Id = '${documentId}'`;
  return (await org.queryAll(soql)).records[0];
}

/** Move the org's clock to `at`, an instant. */
function at(instant: string): string {
  clock = Date.parse(instant);
  return orgStamp(clock);
}

describe('MemoryFileOrg', () => {
  it('sends a file’s versions and links to the recycle bin with it and brings them back under their ids, stamped with the delete and the undelete (P-A1)', async () => {
    const org = orgWithFile();
    const before = (await linksOf(org, fileId(1))).map((link) => link.Id).sort();

    const deletedAt = at('2026-10-28T09:50:05.300Z');
    await org.destroy(FILE_DOCUMENT, [fileId(1)]);

    const binned = await linksOf(org, fileId(1));
    expect(binned).toHaveLength(2);
    for (const link of binned)
      expect(link).toMatchObject({ IsDeleted: true, SystemModstamp: deletedAt });
    expect(await linksOf(org, fileId(1), false)).toEqual([]);
    expect(await fileRow(org, fileId(1))).toMatchObject({
      IsDeleted: true,
      LastModifiedDate: deletedAt,
      SystemModstamp: deletedAt,
    });
    expect(org.inBin(FILE_VERSION)).toHaveLength(1);

    const backAt = at('2026-10-28T09:50:09.508Z');
    await org.undelete([fileId(1)]);

    const back = await linksOf(org, fileId(1), false);
    expect(back.map((link) => link.Id).sort()).toEqual(before);
    for (const link of back)
      expect(link).toMatchObject({ IsDeleted: false, SystemModstamp: backAt });
    expect(org.all(FILE_VERSION)).toHaveLength(1);
  });

  it('hides from every read the link of a record in the recycle bin, stamps the file’s SystemModstamp alone, and gives the link back under its id with the record (P-A2)', async () => {
    const org = orgWithFile();
    const [link] = (await linksOf(org, fileId(1))).filter(
      (row) => row.LinkedEntityId === ACCOUNT_1,
    );
    const created = (await fileRow(org, fileId(1)))?.LastModifiedDate;

    const deletedAt = at('2026-10-28T09:50:41.000Z');
    org.trash('Account', ACCOUNT_1);

    expect((await linksOf(org, fileId(1))).map((row) => row.LinkedEntityId)).toEqual([
      MEMORY_ORG_USER,
    ]);
    const byRecord = `SELECT Id FROM ContentDocumentLink WHERE LinkedEntityId = '${ACCOUNT_1}'`;
    expect((await org.queryAll(byRecord)).records).toEqual([]);
    expect(await fileRow(org, fileId(1))).toMatchObject({
      IsDeleted: false,
      LastModifiedDate: created,
      SystemModstamp: deletedAt,
    });

    const backAt = at('2026-10-28T09:50:46.000Z');
    org.untrash(ACCOUNT_1);

    expect((await org.query(byRecord)).records).toEqual([{ Id: link.Id }]);
    expect((await linksOf(org, fileId(1))).find((row) => row.Id === link.Id)?.SystemModstamp).toBe(
      backAt,
    );
    expect((await fileRow(org, fileId(1)))?.SystemModstamp).toBe(backAt);
  });

  it('loses no link in any order a file and its record are deleted and brought back (P-A5)', async () => {
    const orders: Array<[string[], string[]]> = [
      [
        [FILE_DOCUMENT, 'Account'],
        ['Account', FILE_DOCUMENT],
      ],
      [
        ['Account', FILE_DOCUMENT],
        [FILE_DOCUMENT, 'Account'],
      ],
      [
        ['Account', FILE_DOCUMENT],
        ['Account', FILE_DOCUMENT],
      ],
    ];
    for (const [deletes, undeletes] of orders) {
      const org = orgWithFile();
      const idOf = (object: string): string => (object === FILE_DOCUMENT ? fileId(1) : ACCOUNT_1);
      for (const object of deletes) org.trash(object, idOf(object));
      for (const object of undeletes) {
        org.untrash(idOf(object));
        if (object === 'Account' && undeletes[0] === 'Account') {
          // The record back, its file still in the bin: the link reads deleted.
          expect(
            (await linksOf(org, fileId(1))).find((row) => row.LinkedEntityId === ACCOUNT_1),
          ).toMatchObject({ IsDeleted: true });
        }
      }

      const live = await linksOf(org, fileId(1), false);
      expect(live.map((row) => row.LinkedEntityId).sort(), `${deletes} then ${undeletes}`).toEqual(
        [ACCOUNT_1, MEMORY_ORG_USER].sort(),
      );
    }
  });

  it('removes a link for good, refuses its undelete and its owner’s removal, gives one inserted again a new Id, and stamps nothing of the file (P-A3, P-A4)', async () => {
    const org = orgWithFile();
    const stamp = (await fileRow(org, fileId(1)))?.SystemModstamp;
    at('2026-10-28T09:51:13.000Z');
    const added = org.link(fileId(1), ACCOUNT_2);
    const owner = (await linksOf(org, fileId(1))).find(
      (row) => row.LinkedEntityId === MEMORY_ORG_USER,
    );

    const removed = (await org.destroy(FILE_LINK, [added, String(owner?.Id)])) as Array<{
      success: boolean;
      errors: Array<{ statusCode: string }>;
    }>;
    const undeleted = (await org.undelete([added])) as Array<{
      errors: Array<{ message: string }>;
    }>;
    const again = org.link(fileId(1), ACCOUNT_2);

    expect(removed.map((answer) => answer.success)).toEqual([true, false]);
    expect(removed[1].errors[0].statusCode).toBe('FIELD_INTEGRITY_EXCEPTION');
    expect(undeleted[0].errors[0].message).toBe('Entity type is not undeletable');
    expect((await linksOf(org, fileId(1))).map((row) => row.Id)).not.toContain(added);
    expect(again).not.toBe(added);
    expect((await fileRow(org, fileId(1)))?.SystemModstamp).toBe(stamp);
    expect(() => org.unlink(String(owner?.Id))).toThrow('field integrity exception');
  });

  it('refuses a read of links that names neither their file nor their record, and one naming a date a link does not have (FA4)', async () => {
    const org = orgWithFile();

    await expect(org.query('SELECT Id FROM ContentDocumentLink')).rejects.toMatchObject({
      errorCode: 'MALFORMED_QUERY',
    });
    await expect(
      org.query(
        `SELECT Id, CreatedDate FROM ContentDocumentLink WHERE ContentDocumentId = '${fileId(1)}'`,
      ),
    ).rejects.toMatchObject({ errorCode: 'INVALID_FIELD' });
  });

  it('reads the links of the records of an object through a semi-join, and refuses one when told to (FA5)', async () => {
    const org = orgWithFile();
    const soql =
      'SELECT COUNT() FROM ContentDocumentLink WHERE LinkedEntityId IN (SELECT Id FROM Account)';

    expect((await org.query(soql)).totalSize).toBe(1);
    org.refuseSemiJoin = {
      errorCode: 'QUERY_TIMEOUT',
      message: 'Your query request was running for too long.',
    };
    await expect(org.query(soql)).rejects.toMatchObject({ errorCode: 'QUERY_TIMEOUT' });
  });

  it('shows another user’s file only to a read that names its id, even linked to a record the user sees, unless the user has Query All Files (P-A7)', async () => {
    const org = orgWithFile();
    org.addFile({
      documentId: fileId(7),
      title: 'SFCK-A-P7-F',
      ownerId: OTHER_USER,
      links: [{ entityId: ACCOUNT_1 }],
    });
    const unnamed = 'SELECT Id FROM ContentDocument';

    expect((await org.queryAll(unnamed)).records.map((row) => row.Id)).toEqual([fileId(1)]);
    expect((await fileRow(org, fileId(7)))?.Id).toBe(fileId(7));
    // Its link, read through the record, is there.
    const byRecord = `SELECT ContentDocumentId FROM ContentDocumentLink WHERE LinkedEntityId = '${ACCOUNT_1}'`;
    expect((await org.query(byRecord)).records.map((row) => row.ContentDocumentId).sort()).toEqual(
      [fileId(1), fileId(7)].sort(),
    );
    org.queryAllFiles = true;
    expect((await org.query(unnamed)).records).toHaveLength(2);
  });

  it('refuses to delete a version, and makes a new one the file’s latest with its title, stamping the file and the version before (P-A6)', async () => {
    const org = orgWithFile();
    const first = String((await fileRow(org, fileId(1)))?.LatestPublishedVersionId);

    const at2 = at('2026-10-28T09:52:44.000Z');
    const second = org.newVersion(fileId(1), 'SFCK-A-P6-F v2');
    const refused = (await org.destroy(FILE_VERSION, [second])) as Array<{
      errors: Array<{ statusCode: string }>;
    }>;

    expect(await fileRow(org, fileId(1))).toMatchObject({
      Title: 'SFCK-A-P6-F v2',
      LatestPublishedVersionId: second,
      SystemModstamp: at2,
    });
    expect(org.all(FILE_VERSION).find((version) => version.Id === first)).toMatchObject({
      IsLatest: false,
      SystemModstamp: at2,
    });
    expect(refused[0].errors[0].statusCode).toBe('INSUFFICIENT_ACCESS_OR_READONLY');
  });

  it('counts the live files alone in its file storage, and a file brought back again (P-A8)', async () => {
    const org = orgWithFile();
    expect(org.fileStorageBytes()).toBe(11);
    org.trash(FILE_DOCUMENT, fileId(1));
    expect(org.fileStorageBytes()).toBe(0);
    org.untrash(fileId(1));
    expect(org.fileStorageBytes()).toBe(11);
  });

  it('brings an attachment back alone, or with its record, as a child its record’s delete takes along (P-A9)', async () => {
    const org = orgWithFile();
    org.add('Attachment', { Id: '00P000000000001AAA', ParentId: ACCOUNT_1, Name: 'sfck-a-p9.txt' });
    org.add('Attachment', {
      Id: '00P000000000002AAA',
      ParentId: ACCOUNT_1,
      Name: 'sfck-a-p9b.txt',
    });

    org.trash('Attachment', '00P000000000001AAA');
    org.untrash('00P000000000001AAA');
    org.trash('Account', ACCOUNT_1);
    expect(org.all('Attachment')).toEqual([]);
    org.untrash(ACCOUNT_1);

    expect(
      org
        .all('Attachment')
        .map((row) => row.Id)
        .sort(),
    ).toEqual(['00P000000000001AAA', '00P000000000002AAA']);
  });

  it('inserts a link again under a new id, its file not stamped, and refuses one between a file and a record a live link ties already (P-A3, P-A4)', async () => {
    const org = orgWithFile();
    const stampBefore = (await fileRow(org, fileId(1)))?.SystemModstamp;
    at('2026-10-28T09:51:13.000Z');

    const answers = (await org.create(FILE_LINK, [
      {
        ContentDocumentId: fileId(1),
        LinkedEntityId: ACCOUNT_2,
        ShareType: 'C',
        Visibility: 'InternalUsers',
      },
      { ContentDocumentId: fileId(1), LinkedEntityId: ACCOUNT_1, ShareType: 'V' },
    ])) as Array<{ success: boolean; id?: string; errors: Array<{ statusCode: string }> }>;

    expect(answers[0].success).toBe(true);
    expect(answers[1]).toMatchObject({
      success: false,
      errors: [{ statusCode: 'DUPLICATE_VALUE' }],
    });
    const inserted = org.heldLinks().find((link) => link.Id === answers[0].id);
    expect(inserted).toMatchObject({
      LinkedEntityId: ACCOUNT_2,
      ShareType: 'C',
      Visibility: 'InternalUsers',
    });
    expect((await fileRow(org, fileId(1)))?.SystemModstamp).toBe(stampBefore);
  });

  it('gives a link its visibility, and refuses to change the sharing type of a link to an account in the words the org answered (P-A3)', async () => {
    const org = orgWithFile();
    const link = org.heldLinks().find((held) => held.LinkedEntityId === ACCOUNT_1);
    if (!link) throw new Error('no link to the account');

    const answers = (await org.update(FILE_LINK, [
      { Id: link.Id, Visibility: 'InternalUsers' },
      { Id: link.Id, ShareType: 'C' },
    ])) as Array<{ success: boolean; errors: unknown[] }>;

    expect(answers[0].success).toBe(true);
    expect(answers[1]).toEqual({ id: link.Id, success: false, errors: [SHARE_TYPE_REFUSAL] });
    expect(org.heldLinks().find((held) => held.Id === link.Id)).toMatchObject({
      ShareType: 'V',
      Visibility: 'InternalUsers',
    });
  });
});
