/**
 * What a rewind limited to some objects sends against its estimate, on an
 * org shaped as the one gate G-Z03 rewound (19/11): an Autopilot run's
 * checkpoint first held Account, Contact and the AccountContactRelation the
 * platform writes with each contact; the run made 24 accounts and 1,000
 * contacts under them, a relation with each. A rewind limited to Contact
 * deletes the contacts on their own, their relations with them. Its estimate
 * said 25 requests where it sent 89, then 173 where it sent 84.
 *
 * The removal asks each relationship of an object once whether any record
 * points through it, past one read of its records, and reads for each 200
 * only those that answer one: a contact lists some twenty relationships the
 * check reads, and on such an org the relation alone holds records.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  baseRecords,
  CHILDREN,
  clock,
  FIELDS,
  id,
  PREVIEWED,
  removeTaken,
  request,
  resultOf,
  rewound,
  RewindTestOrg,
  SINCE,
  STAMP_FIELDS,
  taken,
  writable,
} from '../../test/rewindTestOrg.js';
import { previewCheckpoint } from './previewCheckpoint.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

const RELATION = 'AccountContactRelation';

/** The objects people work in under a contact that hold nothing on such an org. */
const EMPTY_UNDER_CONTACT = Array.from({ length: 20 }, (_, n) => `Contact_Child_${n}__c`);

/** An org whose contacts list a relation to their account and twenty relationships that hold nothing. */
function gateOrg(): RewindTestOrg {
  return new RewindTestOrg({
    fields: {
      ...FIELDS,
      [RELATION]: [
        ...STAMP_FIELDS,
        writable('AccountId', 'reference', { referenceTo: ['Account'] }),
        writable('ContactId', 'reference', { referenceTo: ['Contact'] }),
      ],
      ...Object.fromEntries(
        EMPTY_UNDER_CONTACT.map((name) => [
          name,
          [...STAMP_FIELDS, writable('Contact__c', 'reference', { referenceTo: ['Contact'] })],
        ]),
      ),
    },
    children: {
      ...CHILDREN,
      Account: [
        ...(CHILDREN.Account ?? []),
        { childSObject: RELATION, field: 'AccountId', cascadeDelete: true },
      ],
      Contact: [
        { childSObject: RELATION, field: 'ContactId', cascadeDelete: true },
        ...EMPTY_UNDER_CONTACT.map((name) => ({
          childSObject: name,
          field: 'Contact__c',
          cascadeDelete: true,
        })),
      ],
    },
  });
}

afterEach(() => {
  removeTaken();
});

/**
 * The checkpoint of Account, Contact and their relation, then 24 accounts and
 * 1,000 contacts under them made since, a relation with each; of the
 * contact's empty relationships, the first `pointing` hold one record of the
 * org's, under a contact it held: something points through them.
 */
async function madeSince(pointing = 0) {
  const t = await taken(
    (org) => {
      baseRecords(org);
      EMPTY_UNDER_CONTACT.slice(0, pointing).forEach((name, n) => {
        org.add(name, { Id: id('a0A', n + 1), Contact__c: id('003', 1) });
      });
    },
    gateOrg(),
    ['Account', 'Contact', RELATION],
  );
  clock.now = SINCE - 1_000;
  for (let n = 0; n < 24; n++) t.org.add('Account', { Id: id('001', 100 + n), Name: 'Run' });
  clock.now = SINCE;
  for (let n = 0; n < 1_000; n++) {
    const under = id('001', 100 + (n % 24));
    t.org.add('Contact', { Id: id('003', 100 + n), LastName: 'Run', AccountId: under });
    t.org.add(RELATION, {
      Id: id('07k', 100 + n),
      AccountId: under,
      ContactId: id('003', 100 + n),
    });
  }
  return t;
}

/** A rewind limited to Contact, its preview's estimate, and what it sent; with `left`, the requests the org has left today. */
async function rewindOfContacts(pointing = 0, left?: number) {
  const t = await madeSince(pointing);
  if (left !== undefined) t.org.limits = { Max: 15_000, Remaining: left };
  clock.now = PREVIEWED;
  const asked = { objects: ['Contact'], acceptOutside: true };
  const preview = await previewCheckpoint(
    { org: t.org, store: t.store },
    { ...request(t), ...asked },
  );
  if (!preview.previewed) throw new Error(preview.refusal.message);
  const result = resultOf(await rewound(t, preview.diff.previewId, { request: asked }));
  return { t, result, estimated: preview.estimate.apiRequests, sent: result.apiRequests.used };
}

describe('what a rewind limited to some objects sends against its estimate', () => {
  it('estimates a rewind of contacts alone close to what it sends, a relationship that holds nothing read once', async () => {
    const { t, result, estimated, sent } = await rewindOfContacts();

    expect(result.deleted.find((object) => object.objectApiName === 'Contact')?.deleted).toBe(
      1_000,
    );
    // The accounts are not rewound: they stay.
    expect(t.org.all('Account').map((row) => row.Id)).toContain(id('001', 100));
    expect({ sent, estimated, close: Math.abs(estimated - sent) <= 3 }).toEqual({
      sent,
      estimated,
      close: true,
    });
  });

  it('estimates it close to what it sends when relationships hold records of the org, read for each 200', async () => {
    const { estimated, sent } = await rewindOfContacts(5);
    const quiet = await rewindOfContacts(0);

    // Five relationships read for each of the five reads of 200 contacts.
    expect(sent - quiet.sent).toBeGreaterThanOrEqual(25);
    expect({ sent, estimated, close: Math.abs(estimated - sent) <= 3 }).toEqual({
      sent,
      estimated,
      close: true,
    });
  });

  it('lets the rewind through its own gate on an org that has a few more requests left than it sends', async () => {
    // Priced as the preview first priced it, the gate would refuse it for
    // twice what it sends.
    const { sent } = await rewindOfContacts();
    removeTaken();

    const { result } = await rewindOfContacts(0, sent + 5);

    expect(result.deleted.find((object) => object.objectApiName === 'Contact')?.deleted).toBe(
      1_000,
    );
  });
});
