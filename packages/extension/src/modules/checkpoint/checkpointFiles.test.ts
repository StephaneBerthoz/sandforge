import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { nodeBackupFiles } from '../dataops/BackupRecordStore.js';
import { filesDocumentsFileOf, filesLinksFileOf } from './OrgCheckpointStore.js';
import {
  FILE_IDS_PER_READ,
  anchorOf,
  documentsRead,
  fileLinkChangedLineSchema,
  fileLinkClassFileOf,
  fileLinkLineSchema,
  heldFileDocuments,
  heldFileLinks,
  heldPrefixesOf,
  linksCountRead,
  linksOfObjectRead,
  linksOfRecordsRead,
} from './checkpointFiles.js';
import { compressedSnapshotFiles } from './compressedSnapshotFiles.js';

/*
 * The contract of a checkpoint's files beside the take that reads them
 * (`takeCheckpoint.test.ts`): what a link anchors, the statements the take
 * sends, where a preview spools its links, and the annex read back.
 */

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A checkpoint's folder of its own, empty. */
function folder(): { dir: string; filesDir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sandforge-files-'));
  dirs.push(dir);
  return { dir, filesDir: join(dir, 'files') };
}

/** Every line of an async source. */
async function all<T>(lines: AsyncIterable<T>): Promise<T[]> {
  const read: T[] = [];
  for await (const line of lines) read.push(line);
  return read;
}

const LINK = {
  Id: '06A000000000001AAA',
  ContentDocumentId: '069000000000001AAA',
  LinkedEntityId: '001000000000001AAA',
  ShareType: 'V',
  Visibility: 'AllUsers',
};

/** The global describe of an org, as far as anchoring reads it. */
const GLOBAL = [
  { name: 'Account', keyPrefix: '001' },
  { name: 'Contact', keyPrefix: '003' },
  { name: 'Opportunity', keyPrefix: '006' },
  { name: 'User', keyPrefix: '005' },
  { name: 'Group', keyPrefix: '00G' },
  { name: 'ContentWorkspace', keyPrefix: '058' },
  { name: 'AggregateResult', keyPrefix: null },
];

describe('anchorOf', () => {
  it('anchors a link to a record of an object the checkpoint holds, and to nothing a link to a user, a group, a library or an object it does not hold', () => {
    const prefixes = heldPrefixesOf(GLOBAL, ['account', 'Contact']);
    const to = (id: string) => anchorOf({ LinkedEntityId: id }, prefixes);

    expect(to('001000000000001AAA')).toBe('Account');
    expect(to('003000000000001')).toBe('Contact');
    // The owner of a file, a public group, a library: nothing a rewind puts back.
    expect(to('005000000000001AAA')).toBeUndefined();
    expect(to('00G000000000001AAA')).toBeUndefined();
    expect(to('058000000000001AAA')).toBeUndefined();
    // A record of an object the checkpoint does not hold.
    expect(to('006000000000001AAA')).toBeUndefined();
    expect(to('')).toBeUndefined();
  });

  it('tells no object of a prefix the describe does not give', () => {
    expect([...heldPrefixesOf(GLOBAL, ['AggregateResult', 'Account']).keys()]).toEqual(['001']);
  });
});

describe('the statements a take reads its files by', () => {
  it('reads the links of an object’s records through the records, by one statement or by lists of their ids', () => {
    expect(linksOfObjectRead('Contact')).toEqual({
      objectApiName: 'Contact',
      soql:
        'SELECT Id, ContentDocumentId, LinkedEntityId, ShareType, Visibility FROM ' +
        'ContentDocumentLink WHERE LinkedEntityId IN (SELECT Id FROM Contact)',
      scanAll: false,
    });
    expect(linksCountRead('Contact').soql).toBe(
      'SELECT COUNT() FROM ContentDocumentLink WHERE LinkedEntityId IN (SELECT Id FROM Contact)',
    );
    expect(linksOfRecordsRead('Contact', ['003000000000001AAA', '003000000000002AAA']).soql).toBe(
      'SELECT Id, ContentDocumentId, LinkedEntityId, ShareType, Visibility FROM ' +
        "ContentDocumentLink WHERE LinkedEntityId IN ('003000000000001AAA', '003000000000002AAA')",
    );
  });

  it('reads files by their ids, the one way another user’s file is seen without Query All Files', () => {
    expect(documentsRead(['069000000000001AAA']).soql).toBe(
      "SELECT Id, LatestPublishedVersionId, ContentSize FROM ContentDocument WHERE Id IN ('069000000000001AAA')",
    );
    expect(FILE_IDS_PER_READ).toBe(200);
  });

  it('refuses an id that is no id, and an object name that is none, before a statement is made of it', () => {
    expect(() => documentsRead(["069000000000001' OR Id != '"])).toThrow('Not a record id');
    expect(() => linksOfObjectRead('Account) OR (Id')).toThrow();
  });
});

describe('a preview’s spools of links', () => {
  it('names each class of links as the classes of an object are named, under the object of a link', () => {
    expect(fileLinkClassFileOf('/previews/pv-1', 'linkAdded')).toBe(
      join('/previews/pv-1', 'ContentDocumentLink.linkAdded.ndjson'),
    );
    expect(fileLinkClassFileOf('/previews/pv-1', 'linkRemoved')).toBe(
      join('/previews/pv-1', 'ContentDocumentLink.linkRemoved.ndjson'),
    );
  });

  it('reads a link whose sharing changed with the sharing it has now, and refuses one without it', () => {
    const changed = { ...LINK, ShareType: 'C', now: { ShareType: 'V', Visibility: 'AllUsers' } };

    expect(fileLinkChangedLineSchema.parse(changed)).toEqual(changed);
    expect(fileLinkChangedLineSchema.safeParse(LINK).success).toBe(false);
    expect(fileLinkLineSchema.safeParse({ ...LINK, ShareType: 'V; DROP' }).success).toBe(false);
  });
});

describe('the annex, read back', () => {
  it('gives back each link and file as it was written, compressed', async () => {
    const at = folder();
    const files = compressedSnapshotFiles(nodeBackupFiles(at.dir));
    await files.mkdir(at.filesDir);
    await files.writeFile(filesLinksFileOf(at), `${JSON.stringify(LINK)}\n`);
    const file = {
      Id: '069000000000001AAA',
      LatestPublishedVersionId: '068000000000001AAA',
      ContentSize: 12,
      anchored: true,
    };
    await files.writeFile(filesDocumentsFileOf(at), `${JSON.stringify(file)}\n`);

    expect(await all(heldFileLinks(at))).toEqual([LINK]);
    expect(await all(heldFileDocuments(at))).toEqual([file]);
  });

  it('takes a checkpoint whose annex is not there, or holds a line that does not parse, for a damaged one', async () => {
    const at = folder();
    const files = compressedSnapshotFiles(nodeBackupFiles(at.dir));

    await expect(all(heldFileLinks(at))).rejects.toMatchObject({ code: 'damaged' });
    await files.mkdir(at.filesDir);
    await files.writeFile(filesLinksFileOf(at), `${JSON.stringify({ ...LINK, Id: 'nope' })}\n`);
    await expect(all(heldFileLinks(at))).rejects.toMatchObject({ code: 'damaged' });
    await files.writeFile(filesLinksFileOf(at), 'not json\n');
    await expect(all(heldFileLinks(at))).rejects.toMatchObject({ code: 'damaged' });
  });
});
