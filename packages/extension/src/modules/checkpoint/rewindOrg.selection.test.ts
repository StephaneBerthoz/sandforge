import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RewindSelectionPlan } from '@sandforge/shared';

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { type MemoryChild } from '../../test/memoryRemovalOrg.js';
import {
  COLLEAGUE,
  PRICE_BOOK_HELD,
  SINCE,
  STAMP_FIELDS,
  T0,
  RewindTestOrg,
  account,
  book,
  clock,
  contact,
  id,
  line,
  opportunity,
  previewed,
  removeTaken,
  resultOf,
  rewound,
  taken,
  writable,
  type Taken,
} from '../../test/rewindTestOrg.js';
import { previewDirOf } from './OrgCheckpointStore.js';
import { planSelection, snapshotRowsOf } from './rewindPlan.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * A rewind limited to some objects, on the memory org, one case for each
 * rule of the plan's table (`rewindPlan`, "A rewind of some objects"): what
 * the plan of the selection says before the rewind — the page's
 * `checkpoint:plan-selection` — and what the rewind then writes and names.
 */

beforeEach(() => {
  clock.now = T0;
});

afterEach(() => {
  removeTaken();
  vi.mocked(getJsforceConnection).mockReset();
});

const caseOf = (n: number): string => id('500', n);

/**
 * Accounts and their child accounts, contacts and deals under them, a deal's
 * products, and cases that look a contact up: an account's delete takes its
 * contacts and deals along, a deal's its products; a contact's delete
 * empties the lookup of a case, and an account's that of its child accounts.
 */
const FIELDS: Record<string, unknown[]> = {
  Account: [
    ...STAMP_FIELDS,
    writable('Name'),
    writable('ParentId', 'reference', { referenceTo: ['Account'] }),
  ],
  Contact: [
    ...STAMP_FIELDS,
    writable('LastName'),
    writable('AccountId', 'reference', { referenceTo: ['Account'] }),
  ],
  Opportunity: [
    ...STAMP_FIELDS,
    writable('Name'),
    writable('AccountId', 'reference', { referenceTo: ['Account'] }),
    writable('Pricebook2Id', 'reference', { referenceTo: ['Pricebook2'] }),
  ],
  OpportunityLineItem: [
    ...STAMP_FIELDS,
    writable('Quantity', 'double'),
    writable('OpportunityId', 'reference', { referenceTo: ['Opportunity'], updateable: false }),
  ],
  Case: [
    ...STAMP_FIELDS,
    writable('Subject'),
    writable('ContactId', 'reference', { referenceTo: ['Contact'] }),
  ],
};

const CHILDREN: Record<string, MemoryChild[]> = {
  Account: [
    { childSObject: 'Contact', field: 'AccountId', cascadeDelete: true },
    { childSObject: 'Opportunity', field: 'AccountId', cascadeDelete: true },
    { childSObject: 'Account', field: 'ParentId' },
  ],
  Contact: [{ childSObject: 'Case', field: 'ContactId' }],
  Opportunity: [
    { childSObject: 'OpportunityLineItem', field: 'OpportunityId', cascadeDelete: true },
  ],
};

const OBJECTS = ['Account', 'Contact', 'Opportunity', 'OpportunityLineItem', 'Case'];

function org(): RewindTestOrg {
  const made = new RewindTestOrg({ fields: FIELDS, children: CHILDREN });
  made.heldByChildren.push(PRICE_BOOK_HELD);
  return made;
}

/** What the org holds long before the checkpoint. */
function atCheckpoint(o: RewindTestOrg): void {
  o.add('Account', { Id: account(1), Name: 'One' });
  o.add('Account', { Id: account(2), Name: 'Two' });
  o.add('Contact', { Id: contact(1), LastName: 'One', AccountId: account(2) });
  o.add('Contact', { Id: contact(2), LastName: 'Two', AccountId: account(2) });
  o.add('Contact', { Id: contact(3), LastName: 'Three', AccountId: account(1) });
  o.add('Opportunity', {
    Id: opportunity(1),
    Name: 'Deal',
    AccountId: account(1),
    Pricebook2Id: book(1),
  });
  o.add('OpportunityLineItem', { Id: line(1), Quantity: 1, OpportunityId: opportunity(1) });
  o.add('Opportunity', {
    Id: opportunity(2),
    Name: 'Bare deal',
    AccountId: account(1),
    Pricebook2Id: book(1),
  });
  o.add('Case', { Id: caseOf(1), Subject: 'Broken', ContactId: contact(3) });
}

/** The checkpoint, then what a colleague did since, a second a step. */
async function since(steps: (o: RewindTestOrg) => void): Promise<Taken> {
  const t = await taken(atCheckpoint, org(), OBJECTS);
  clock.now = SINCE;
  steps(t.org);
  return t;
}

/** What the page is told of the selection `objects`, planned from the preview `previewId`. */
async function planOf(
  t: Taken,
  previewId: string,
  readAt: string,
  objects: readonly string[],
  acceptOutside = false,
): Promise<RewindSelectionPlan> {
  return planSelection({
    checkpoint: t.checkpoint,
    previewDir: previewDirOf(t.folder, previewId),
    readAt,
    objects: new Set(objects),
    acceptOutside,
    heldRows: snapshotRowsOf(t.checkpoint, t.folder),
  });
}

const liveIdsOf = (t: Taken, objectApiName: string): string[] =>
  t.org
    .all(objectApiName)
    .map((row) => row.Id)
    .sort();
const binIdsOf = (t: Taken, objectApiName: string): string[] =>
  t.org
    .inBin(objectApiName)
    .map((row) => row.Id)
    .sort();

describe('a rewind limited to some objects, rule by rule', () => {
  it('leaves the contacts deleted with their account when the accounts are not picked, names Account to add, and brings nothing back', async () => {
    const t = await since((o) => o.trash('Account', account(2), COLLEAGUE));
    const diff = await previewed(t);

    const plan = await planOf(t, diff.previewId, diff.readAt, ['Contact']);
    expect(plan.left).toEqual([
      { objectApiName: 'Contact', reason: 'needsUnpickedParent', count: 2 },
    ]);
    expect(plan.needs).toEqual([{ objectApiName: 'Account', records: 2 }]);
    expect(plan.acts).toEqual([]);

    const undeletes = t.org.soapCalls;
    const result = resultOf(
      await rewound(t, diff.previewId, { request: { objects: ['Contact'] } }),
    );
    expect(t.org.soapCalls - undeletes).toBeLessThanOrEqual(2);
    expect(binIdsOf(t, 'Contact')).toEqual([contact(1), contact(2)]);
    expect(result.status).toBe('partial');
    expect(result.residual).toEqual([
      expect.objectContaining({ objectApiName: 'Contact', reason: 'kept', count: 2 }),
    ]);
    expect(result.residual[0].message).toContain('Rewind Account with it');
    expect(result.scope).toEqual({
      objects: ['Contact'],
      notRewound: { objects: ['Account'], records: 1 },
    });
  });

  it('brings the contacts back with their account once Account is added, as the plan said', async () => {
    const t = await since((o) => o.trash('Account', account(2), COLLEAGUE));
    const diff = await previewed(t);

    const plan = await planOf(t, diff.previewId, diff.readAt, ['Account', 'Contact']);
    expect(plan.needs).toEqual([]);
    expect(plan.acts).toEqual([
      expect.objectContaining({ objectApiName: 'Contact', picked: true, toBringBack: 2 }),
      expect.objectContaining({ objectApiName: 'Account', picked: true, toBringBack: 1 }),
    ]);

    const result = resultOf(
      await rewound(t, diff.previewId, { request: { objects: ['Account', 'Contact'] } }),
    );
    expect(result.status).toBe('success');
    expect(liveIdsOf(t, 'Contact')).toEqual([contact(1), contact(2), contact(3)]);
  });

  it('leaves the products deleted with their deal, which Salesforce undeletes only with it, when the deals are not picked', async () => {
    const t = await since((o) => o.trash('Opportunity', opportunity(1), COLLEAGUE));
    const diff = await previewed(t);

    const plan = await planOf(t, diff.previewId, diff.readAt, ['OpportunityLineItem']);
    expect(plan.left).toEqual([
      { objectApiName: 'OpportunityLineItem', reason: 'needsUnpickedParent', count: 1 },
    ]);
    expect(plan.needs).toEqual([{ objectApiName: 'Opportunity', records: 1 }]);

    const result = resultOf(
      await rewound(t, diff.previewId, { request: { objects: ['OpportunityLineItem'] } }),
    );
    expect(binIdsOf(t, 'OpportunityLineItem')).toEqual([line(1)]);
    expect(result.residual[0]?.message).toContain('Rewind Opportunity with it');
  });

  it('keeps an account made since that contacts made since hang from, unless deleting them was accepted, naming Contact', async () => {
    const t = await since((o) => {
      o.add('Account', { Id: account(4), Name: 'New', LastModifiedById: COLLEAGUE });
      o.add('Contact', {
        Id: contact(4),
        LastName: 'New',
        AccountId: account(4),
        LastModifiedById: COLLEAGUE,
      });
    });
    const diff = await previewed(t);

    const plan = await planOf(t, diff.previewId, diff.readAt, ['Account']);
    expect(plan.left).toEqual([
      { objectApiName: 'Account', reason: 'outsideNotAccepted', count: 1 },
    ]);
    expect(plan.needs).toEqual([{ objectApiName: 'Contact', records: 1 }]);
    expect(plan.acts).toEqual([]);
    const accepted = await planOf(t, diff.previewId, diff.readAt, ['Account'], true);
    expect(accepted.left).toEqual([]);
    expect(accepted.acts).toEqual([
      expect.objectContaining({ objectApiName: 'Account', toDelete: 1 }),
    ]);

    const kept = resultOf(await rewound(t, diff.previewId, { request: { objects: ['Account'] } }));
    expect(liveIdsOf(t, 'Account')).toContain(account(4));
    expect(kept.residual[0]?.message).toContain('records of Contact created since hang from it');

    const again = await previewed(t);
    const gone = resultOf(
      await rewound(t, again.previewId, {
        request: { objects: ['Account'], acceptOutside: true },
      }),
    );
    expect(gone.status).toBe('success');
    expect(liveIdsOf(t, 'Account')).not.toContain(account(4));
    // Taken along with its account, which Undo brings back with it.
    expect(binIdsOf(t, 'Contact')).toEqual([contact(4)]);
  });

  it('keeps an account made since that a contact of the checkpoint was moved under, naming Contact to move it back first', async () => {
    const t = await since((o) => {
      o.add('Account', { Id: account(4), Name: 'New', LastModifiedById: COLLEAGUE });
      o.edit('Contact', contact(1), { AccountId: account(4) }, COLLEAGUE);
    });
    const diff = await previewed(t);

    const plan = await planOf(t, diff.previewId, diff.readAt, ['Account']);
    expect(plan.left).toEqual([{ objectApiName: 'Account', reason: 'holdsLeft', count: 1 }]);
    expect(plan.needs).toEqual([{ objectApiName: 'Contact', records: 1 }]);
    expect(plan.acts).toEqual([]);

    const result = resultOf(
      await rewound(t, diff.previewId, { request: { objects: ['Account'] } }),
    );
    expect(result.deleted.reduce((sum, o) => sum + o.deleted, 0)).toBe(0);
    expect(liveIdsOf(t, 'Account')).toContain(account(4));
    expect(result.residual[0]?.message).toContain('Rewind Contact with it');
  });

  it('gives a case its subject back but leaves its contact lookup, which names a contact this rewind leaves in the bin', async () => {
    const t = await since((o) => {
      o.edit('Case', caseOf(1), { Subject: 'Fixed' }, COLLEAGUE);
      // The org empties the case's lookup as it deletes the contact (P-D4).
      o.trash('Contact', contact(3), COLLEAGUE);
    });
    const diff = await previewed(t);

    const plan = await planOf(t, diff.previewId, diff.readAt, ['Case']);
    expect(plan.left).toEqual([{ objectApiName: 'Case', reason: 'needsUnpickedParent', count: 1 }]);
    expect(plan.needs).toEqual([{ objectApiName: 'Contact', records: 1 }]);
    expect(plan.acts).toEqual([expect.objectContaining({ objectApiName: 'Case', toGiveBack: 1 })]);

    const sent = t.org.updates.length;
    const result = resultOf(await rewound(t, diff.previewId, { request: { objects: ['Case'] } }));
    const caseUpdates = t.org.updates.slice(sent).filter((u) => u.objectApiName === 'Case');
    expect(caseUpdates.flatMap((u) => u.records)).toEqual([{ Id: caseOf(1), Subject: 'Broken' }]);
    const [held] = t.org.all('Case');
    expect(held).toMatchObject({ Subject: 'Broken', ContactId: null });
    expect(binIdsOf(t, 'Contact')).toEqual([contact(3)]);
    expect(result.residual[0]?.message).toContain('Rewind Contact with it');
  });

  it('gives a deal back but for the price book its products made since hold in place, naming OpportunityLineItem', async () => {
    const t = await since((o) => {
      o.edit('Opportunity', opportunity(2), { Name: 'Renamed', Pricebook2Id: book(2) }, COLLEAGUE);
      o.add('OpportunityLineItem', {
        Id: line(5),
        Quantity: 2,
        OpportunityId: opportunity(2),
        LastModifiedById: COLLEAGUE,
      });
    });
    const diff = await previewed(t);

    const plan = await planOf(t, diff.previewId, diff.readAt, ['Opportunity']);
    expect(plan.left).toEqual([
      { objectApiName: 'Opportunity', reason: 'heldByUnpicked', count: 1 },
    ]);
    expect(plan.needs).toEqual([{ objectApiName: 'OpportunityLineItem', records: 1 }]);

    const result = resultOf(
      await rewound(t, diff.previewId, { request: { objects: ['Opportunity'] } }),
    );
    expect(t.org.all('Opportunity').find((row) => row.Id === opportunity(2))).toMatchObject({
      Name: 'Bare deal',
      Pricebook2Id: book(2),
    });
    expect(liveIdsOf(t, 'OpportunityLineItem')).toContain(line(5));
    expect(result.residual).toEqual([
      expect.objectContaining({ objectApiName: 'Opportunity', reason: 'kept', count: 1 }),
    ]);
    expect(result.residual[0].message).toContain('Rewind OpportunityLineItem with it');
  });

  it('deletes again the contacts made since that come back with an account it brings back, though contacts are not picked', async () => {
    const t = await since((o) => {
      o.add('Contact', {
        Id: contact(5),
        LastName: 'Made',
        AccountId: account(2),
        LastModifiedById: COLLEAGUE,
      });
      clock.now += 1_000;
      o.trash('Account', account(2), COLLEAGUE);
    });
    const diff = await previewed(t);

    const plan = await planOf(t, diff.previewId, diff.readAt, ['Account']);
    expect(plan.acts).toEqual([
      expect.objectContaining({ objectApiName: 'Contact', picked: false, toDelete: 1 }),
      expect.objectContaining({ objectApiName: 'Account', picked: true, toBringBack: 1 }),
    ]);

    const result = resultOf(
      await rewound(t, diff.previewId, { request: { objects: ['Account'] } }),
    );
    expect(result.status).toBe('success');
    expect(result.passes).toBe(2);
    expect(binIdsOf(t, 'Contact')).toEqual([contact(5)]);
    // The contacts of the checkpoint came back with it, as the org brings them.
    expect(liveIdsOf(t, 'Contact')).toEqual([contact(1), contact(2), contact(3)]);
  });

  it('makes a case again without its contact lookup when the contact stays in the bin, contacts not picked', async () => {
    const t = await since((o) => {
      o.trash('Contact', contact(3), COLLEAGUE);
      clock.now += 1_000;
      o.trash('Case', caseOf(1), COLLEAGUE);
      // Gone from the recycle bin: only made again, with a new Id.
      o.purge(caseOf(1));
    });
    const diff = await previewed(t);

    const plan = await planOf(t, diff.previewId, diff.readAt, ['Case']);
    expect(plan.acts).toEqual([expect.objectContaining({ objectApiName: 'Case', toRecreate: 1 })]);
    expect(plan.left).toEqual([{ objectApiName: 'Case', reason: 'needsUnpickedParent', count: 1 }]);
    expect(plan.needs).toEqual([{ objectApiName: 'Contact', records: 1 }]);

    const made = t.org.creates.length;
    const result = resultOf(
      await rewound(t, diff.previewId, {
        request: { objects: ['Case'], acceptRecreate: true },
      }),
    );
    expect(t.org.creates.slice(made).flatMap((c) => c.records)).toEqual([{ Subject: 'Broken' }]);
    expect(result.recreated).toEqual([
      expect.objectContaining({ objectApiName: 'Case', created: 1 }),
    ]);
    expect(t.org.all('Case')).toEqual([expect.objectContaining({ Subject: 'Broken' })]);
    expect(binIdsOf(t, 'Contact')).toEqual([contact(3)]);
  });

  it('writes nothing to a case whose contact lookup it empties by deleting the contact made since: the org empties it', async () => {
    const t = await since((o) => {
      o.add('Contact', { Id: contact(6), LastName: 'New', LastModifiedById: COLLEAGUE });
      o.edit('Case', caseOf(1), { ContactId: contact(6) }, COLLEAGUE);
    });
    const diff = await previewed(t);
    const sent = t.org.updates.length;

    const result = resultOf(
      await rewound(t, diff.previewId, { request: { objects: ['Contact'] } }),
    );
    expect(result.status).toBe('success');
    expect(t.org.updates.slice(sent).filter((u) => u.objectApiName === 'Case')).toEqual([]);
    expect(t.org.all('Case')[0]).toMatchObject({ ContactId: null });
    expect(result.scope?.notRewound).toEqual({ objects: ['Case'], records: 1 });
  });
});

describe('the verify of a rewind limited to some objects', () => {
  it('ends success when the objects picked match, a difference in one not picked counted apart, never partial', async () => {
    const t = await since((o) => {
      o.edit('Account', account(1), { Name: 'Renamed' }, COLLEAGUE);
      o.edit('Contact', contact(3), { LastName: 'Renamed' }, COLLEAGUE);
    });
    const diff = await previewed(t);

    const result = resultOf(
      await rewound(t, diff.previewId, { request: { objects: ['Account'] } }),
    );
    expect(result.status).toBe('success');
    expect(result.residual).toEqual([]);
    expect(result.scope).toEqual({
      objects: ['Account'],
      notRewound: { objects: ['Contact'], records: 1 },
    });
    expect(t.org.all('Contact').find((row) => row.Id === contact(3))).toMatchObject({
      LastName: 'Renamed',
    });
  });

  it('says no scope of a rewind of every object', async () => {
    const t = await since((o) => o.edit('Account', account(1), { Name: 'Renamed' }, COLLEAGUE));
    const diff = await previewed(t);

    const result = resultOf(await rewound(t, diff.previewId));
    expect(result.status).toBe('success');
    expect(result).not.toHaveProperty('scope');
  });
});
