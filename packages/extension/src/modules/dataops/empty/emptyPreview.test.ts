import { describe, expect, it } from 'vitest';
import { salesOrg } from '../../../test/emptyFixtureOrg';
import { previewEmpty, type EmptyPreviewInput } from './emptyPreview';

const TOOLING = ['ApexClass'];

/** The dry run of `request` on a fresh sales org, and the org, for what it was sent. */
async function preview(
  request: EmptyPreviewInput['request'],
  extra: Partial<EmptyPreviewInput> = {},
): Promise<{ result: Awaited<ReturnType<typeof previewEmpty>>; org: ReturnType<typeof salesOrg> }> {
  const org = salesOrg();
  const result = await previewEmpty(
    { global: org.global(), tooling: TOOLING, request, deleteMode: 'recycle', ...extra },
    org,
  );
  return { result, org };
}

describe('previewEmpty, the whole org', () => {
  it('says the act and its size: every record it deletes, from how many objects', async () => {
    const { result } = await preview({ mode: 'org' });

    expect(result.total).toEqual({ records: 50, objects: 22, uncounted: [] });
    expect(result.passes).toHaveLength(23);
  });

  it('leaves out, with why, every object it does not empty, an object with no recycle bin among them', async () => {
    const { result } = await preview({ mode: 'org' });

    expect(result.leftOut.find((out) => out.objectApiName === 'No_Bin__c')?.reason).toBe(
      'noRecycleBin',
    );
    expect(result.leftOut.find((out) => out.objectApiName === 'User')?.reason).toBe('setup');
    expect(result.leftOut).toHaveLength(18);
  });

  it('orders cases first, then accounts, and price books before products, and says the pairs no undo brings back', async () => {
    const { result } = await preview({ mode: 'org' });
    const names = result.passes.map((pass) => pass.objectApiName);

    expect(names.indexOf('Case')).toBeLessThan(names.indexOf('Account'));
    expect(names.indexOf('Pricebook2')).toBeLessThan(names.indexOf('Product2'));
    expect(result.undo).toBe(true);
    expect(result.undoLost.length).toBeGreaterThan(0);
  });

  it('describes the user whose lookup keeps a contact, to count the portal users it names', async () => {
    const { result, org } = await preview({ mode: 'org' });

    expect(org.described).toContain('User');
    expect(result.blockers).toEqual([
      { objectApiName: 'User', field: 'ContactId', parent: 'Contact', records: { records: 1 } },
    ]);
  });

  it('reads the org and writes nothing: every statement it sends is a count', async () => {
    const { org } = await preview({ mode: 'org' });

    expect(org.sent.every(({ soql }) => soql.startsWith('SELECT COUNT() FROM '))).toBe(true);
  });

  it('prices the passes against the org’s day and puts every deleted record in the recycle bin', async () => {
    const { result } = await preview(
      { mode: 'org' },
      { apiBudget: { max: 15_000, remaining: 14_000 }, dataStorageMB: 5 },
    );

    expect(result.cost.api.verdict).toBe('fits');
    expect(result.cost.binRecords).toBe(50);
    expect(result.cost.bin).toEqual({ documentedCapacity: 125, past: false });
    expect(result.cost.batches).toBeUndefined();
  });
});

describe('previewEmpty, deleting for good', () => {
  it('says no undo brings anything back, counts nothing an undo would lose, and puts nothing in the recycle bin', async () => {
    const { result } = await preview({ mode: 'org' }, { deleteMode: 'hard' });

    expect(result.undo).toBe(false);
    expect(result.undoLost).toEqual([]);
    expect(result.cost.binRecords).toBe(0);
    expect(result.cost.passes.every((pass) => pass.restCalls === 0)).toBe(true);
    expect(result.cost.bulkBatches).toBeGreaterThan(0);
  });

  it('leaves files out, asked for or not, as no job deletes one for good, and counts nothing of them', async () => {
    const { result, org } = await preview({ mode: 'org', files: true }, { deleteMode: 'hard' });

    expect(result.leftOut).toContainEqual({
      objectApiName: 'ContentDocument',
      reason: 'notForGood',
    });
    expect(result.passes.map((pass) => pass.objectApiName)).toContain('Attachment');
    expect(result.passes.map((pass) => pass.objectApiName)).not.toContain('ContentDocument');
    expect(org.sent.some(({ soql }) => soql.includes('FROM ContentDocument'))).toBe(false);
  });
});

describe('previewEmpty, objects picked', () => {
  it('describes what goes along as far as it goes, round after round, and counts it', async () => {
    const { result, org } = await preview({ mode: 'objects', objects: ['Account'] });

    expect(org.described).toEqual(
      expect.arrayContaining(['Contact', 'Opportunity', 'Quote', 'QuoteLineItem']),
    );
    expect(
      result.along.find((object) => object.objectApiName === 'QuoteLineItem')?.records,
    ).toEqual({
      records: 1,
    });
    expect(result.affected).toContain('QuoteLineItem');
    expect(result.affected).toContain('Account');
  });

  it('names the cases whose lookups keep the account, and the activated orders set back to Draft first', async () => {
    const { result } = await preview({ mode: 'objects', objects: ['Account'] });

    expect(result.blockers.map((blocker) => `${blocker.objectApiName}.${blocker.field}`)).toEqual([
      'Case.AccountId',
      'Case.ContactId',
      'User.ContactId',
    ]);
    expect(result.refusals).toEqual([
      { code: 'activatedOrder', objectApiName: 'Order', records: { records: 1 } },
    ]);
  });

  it('counts the records of the account and what goes with it in the act’s size', async () => {
    const { result } = await preview({ mode: 'objects', objects: ['Account'] });

    // 4 accounts; along: 6 relations, 1 asset, 1 member, 5 contacts, 1
    // contract, 1 event, 2 opportunities, 1 role, 2 products, 2 orders, 1
    // order product, 1 quote, 1 line, 3 tasks.
    expect(result.total).toEqual({ records: 32, objects: 15, uncounted: [] });
  });
});
