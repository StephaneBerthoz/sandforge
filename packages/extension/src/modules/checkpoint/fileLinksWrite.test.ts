import { describe, expect, it } from 'vitest';

import { MEMORY_ORG_USER } from '../../test/memoryRemovalOrg.js';
import { FILE_LINK, MemoryFileOrg, SHARE_TYPE_REFUSAL, fileId } from '../../test/memoryFileOrg.js';
import type { FileLinkLine } from './checkpointFiles.js';
import {
  SHARE_TYPE_WORDS,
  USER_LINK_WORDS,
  insertFileLinks,
  removeFileLinks,
  shareFileLinks,
} from './fileLinksWrite.js';

/*
 * The writes to the links between files and records, on the memory org that
 * holds files as a scratch org held them in the probes of tour 0 (P-A1 to
 * P-A5): a link is removed for good, inserted again under a new Id, and the
 * sharing type of a link to an account never changes.
 */

const ACCOUNT_1 = '001000000000001AAA';
const ACCOUNT_2 = '001000000000002AAA';
const CASE_1 = '500000000000001AAA';

/** An org of two accounts and a case, holding one file, the session user's, linked to the first account and the case. */
function orgWithFile(): MemoryFileOrg {
  const org = new MemoryFileOrg({}, { now: () => Date.parse('2026-10-28T09:50:00.000Z') });
  org.add('Account', { Id: ACCOUNT_1, Name: 'One' });
  org.add('Account', { Id: ACCOUNT_2, Name: 'Two' });
  org.add('Case', { Id: CASE_1, Subject: 'Broken' });
  org.addFile({
    documentId: fileId(1),
    title: 'Contract',
    links: [{ entityId: ACCOUNT_1 }, { entityId: CASE_1, shareType: 'V' }],
  });
  return org;
}

/** The link of the org between a file and a record, as a diff reads it. */
function linkOf(org: MemoryFileOrg, entityId: string): FileLinkLine {
  const held = org.heldLinks().find((link) => link.LinkedEntityId === entityId);
  if (!held) throw new Error(`no link to ${entityId}`);
  const { Id, ContentDocumentId, LinkedEntityId, ShareType, Visibility } = held;
  return { Id, ContentDocumentId, LinkedEntityId, ShareType, Visibility };
}

describe('removeFileLinks', () => {
  it('removes a link for good, counts one already gone as gone, and tells the journal of each call before it goes and once it answered', async () => {
    const org = orgWithFile();
    const link = linkOf(org, ACCOUNT_1);
    const told: string[] = [];

    const outcome = await removeFileLinks(org, [link, { ...link, Id: '06A000000000099AAA' }], {
      before: async (links) => {
        told.push(`before ${links.length}`);
        expect(org.deletes).toEqual([]);
      },
      after: async ({ done, left }) => {
        told.push(`after ${done.length} ${left.length}`);
      },
    });

    expect(told).toEqual(['before 2', 'after 1 1']);
    expect(outcome).toMatchObject({ done: 1, already: 1, refused: 0, notSent: 0 });
    expect(org.heldLinks().some((held) => held.Id === link.Id)).toBe(false);
  });

  it('never sends the link of a file to a user: its owner’s link the org refuses to remove (P-A3)', async () => {
    const org = orgWithFile();
    const owner = linkOf(org, MEMORY_ORG_USER);

    const outcome = await removeFileLinks(org, [owner]);

    expect(org.deletes).toEqual([]);
    expect(outcome).toMatchObject({ done: 0, notSent: 1, reasons: [USER_LINK_WORDS] });
    expect(outcome.left).toEqual([{ id: owner.Id, reason: USER_LINK_WORDS }]);
    // Sent all the same, the org refuses it and keeps it.
    const answer = (await org.destroy(FILE_LINK, [owner.Id])) as Array<{
      errors: Array<{ statusCode: string }>;
    }>;
    expect(answer[0].errors[0].statusCode).toBe('FIELD_INTEGRITY_EXCEPTION');
  });

  it('sends 200 links a call and stops before the next call once told to, leaving the rest not reached', async () => {
    const org = new MemoryFileOrg({}, { now: () => Date.parse('2026-10-28T09:50:00.000Z') });
    const accounts = Array.from(
      { length: 450 },
      (_, n) => `001${String(n + 10).padStart(12, '0')}AAA`,
    );
    for (const id of accounts) org.add('Account', { Id: id, Name: id });
    org.addFile({
      documentId: fileId(1),
      title: 'Shared',
      links: accounts.map((entityId) => ({ entityId })),
    });
    const links = accounts.map((id) => linkOf(org, id));
    let calls = 0;

    const outcome = await removeFileLinks(org, links, {
      after: async () => {
        calls++;
      },
      stopped: () => calls >= 2,
    });

    expect(org.deletes.map(({ ids }) => ids.length)).toEqual([200, 200]);
    expect(outcome).toMatchObject({ done: 400, notReached: 50, cancelled: true });
  });
});

describe('insertFileLinks', () => {
  it('inserts a link of the checkpoint again under a new id, with its two ends and its sharing, as the org brings none back from the recycle bin (P-A3)', async () => {
    const org = orgWithFile();
    const link = { ...linkOf(org, ACCOUNT_1), ShareType: 'C', Visibility: 'InternalUsers' };
    org.unlink(link.Id);
    // A link deleted on its own is not undeletable.
    const undeleted = (await org.undelete([link.Id])) as Array<{ success: boolean }>;
    expect(undeleted[0].success).toBe(false);

    const outcome = await insertFileLinks(org, [link]);

    expect(outcome).toMatchObject({ done: 1, refused: 0 });
    const [made] = outcome.made;
    expect(made.from).toBe(link.Id);
    expect(made.id).not.toBe(link.Id);
    expect(org.heldLinks().find((held) => held.Id === made.id)).toMatchObject({
      ContentDocumentId: fileId(1),
      LinkedEntityId: ACCOUNT_1,
      ShareType: 'C',
      Visibility: 'InternalUsers',
    });
  });

  it('counts a link the file and the record tie already as linked, and names the record by the id it has now', async () => {
    const org = orgWithFile();
    const there = linkOf(org, ACCOUNT_1);
    const remade = { ...linkOf(org, CASE_1), LinkedEntityId: '500000000000077AAA' };
    org.unlink(linkOf(org, CASE_1).Id);

    const outcome = await insertFileLinks(org, [there, remade], {}, (id) =>
      id === '500000000000077AAA' ? CASE_1 : id,
    );

    expect(outcome).toMatchObject({ done: 1, already: 1, refused: 0 });
    expect(linkOf(org, CASE_1).ContentDocumentId).toBe(fileId(1));
  });
});

describe('shareFileLinks', () => {
  it('gives a link its sharing back, sending only what differs', async () => {
    const org = orgWithFile();
    const now = linkOf(org, CASE_1);

    const outcome = await shareFileLinks(org, [
      { ...now, ShareType: 'C', now: { ShareType: now.ShareType, Visibility: now.Visibility } },
    ]);

    expect(outcome).toMatchObject({ done: 1, refused: 0 });
    expect(org.updates).toEqual([
      { objectApiName: FILE_LINK, records: [{ Id: now.Id, ShareType: 'C' }] },
    ]);
    expect(linkOf(org, CASE_1).ShareType).toBe('C');
  });

  it('never sends the sharing type of a link to an account, which the org refuses to change, and names it; its visibility is sent alone (P-A3)', async () => {
    const org = orgWithFile();
    const now = linkOf(org, ACCOUNT_1);
    const typeOnly = { ...now, ShareType: 'C', now: { ShareType: 'V', Visibility: 'AllUsers' } };
    const both = { ...typeOnly, Visibility: 'InternalUsers' };

    const alone = await shareFileLinks(org, [typeOnly]);
    expect(org.updates).toEqual([]);
    expect(alone).toMatchObject({ done: 0, notSent: 1, reasons: [SHARE_TYPE_WORDS] });

    const shared = await shareFileLinks(org, [both]);
    expect(org.updates.map(({ records }) => records)).toEqual([
      [{ Id: now.Id, Visibility: 'InternalUsers' }],
    ]);
    expect(shared).toMatchObject({ done: 1, refused: 0, reasons: [SHARE_TYPE_WORDS] });
    // Sent, the org refuses it in these words.
    const answer = (await org.update(FILE_LINK, [{ Id: now.Id, ShareType: 'C' }])) as Array<{
      errors: unknown[];
    }>;
    expect(answer[0].errors).toEqual([SHARE_TYPE_REFUSAL]);
  });
});
