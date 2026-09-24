import { describe, it, expect, vi } from 'vitest';
import {
  RowsLeftToThePlatform,
  directAccountContactRelations,
  draftStartOf,
  existingSellingModelOptions,
  leftToThePlatformNote,
  leftToThePlatformReason,
  leftToThePlatformSummary,
  recordsByNaturalKey,
  standardPriceIds,
  statusCategories,
  writtenByThePlatform,
  type SoqlQuery,
} from './platformRecords.js';

describe('standardPriceIds', () => {
  it('names the entries of the standard price book among those asked about', async () => {
    const query = vi.fn<SoqlQuery>(async () => [{ Id: '01uSTD' }]);

    const found = await standardPriceIds(query, ['01uSTD', '01uCUSTOM']);

    expect(query).toHaveBeenCalledWith(
      "SELECT Id FROM PricebookEntry WHERE Id IN ('01uSTD', '01uCUSTOM') AND Pricebook2.IsStandard = true",
    );
    expect([...found]).toEqual(['01uSTD']);
  });

  it('asks about two hundred entries at a time, and nothing for none', async () => {
    const query = vi.fn<SoqlQuery>(async () => []);

    await standardPriceIds(query, []);
    expect(query).not.toHaveBeenCalled();
    await standardPriceIds(
      query,
      Array.from({ length: 201 }, (_, i) => `01u${String(i).padStart(3, '0')}`),
    );
    expect(query).toHaveBeenCalledTimes(2);
  });
});

describe('writtenByThePlatform', () => {
  it('names a tracked change as a feed item the platform writes itself', () => {
    expect(writtenByThePlatform('FeedItem', { Id: '0D5A', Type: 'TrackedChange' })).toEqual({
      field: 'Type',
      value: 'TrackedChange',
      noun: 'tracked change',
    });
  });

  it('leaves to the insert a post, a feed item of a type it cannot say is refused, and other objects', () => {
    expect(writtenByThePlatform('FeedItem', { Id: '0D5A', Type: 'TextPost' })).toBeUndefined();
    expect(writtenByThePlatform('FeedItem', { Id: '0D5A', Type: 'CallLogPost' })).toBeUndefined();
    expect(writtenByThePlatform('FeedItem', { Id: '0D5A' })).toBeUndefined();
    expect(writtenByThePlatform('Task', { Id: '00TA', Type: 'TrackedChange' })).toBeUndefined();
  });
});

describe('RowsLeftToThePlatform', () => {
  const TRACKED = { field: 'Type', value: 'TrackedChange', noun: 'tracked change' };

  it('keeps a post and leaves out a tracked change, counted once however often it is read', () => {
    const left = new RowsLeftToThePlatform();
    const rows = [
      { Id: '0D5POST', Type: 'TextPost' },
      { Id: '0D5CHANGE', Type: 'TrackedChange' },
    ];

    expect(left.keep('FeedItem', rows)).toEqual([{ Id: '0D5POST', Type: 'TextPost' }]);
    left.keep('FeedItem', rows);

    expect(left.has('0D5CHANGE')).toBe(true);
    expect(left.has('0D5POST')).toBe(false);
    expect(left.counts()).toEqual([
      { objectApiName: 'FeedItem', why: { rows: TRACKED }, count: 1 },
    ]);
  });

  it('leaves out what hangs from a row left out through a lookup it may not leave empty, and what hangs from that', () => {
    const left = new RowsLeftToThePlatform();
    left.keep('FeedItem', [{ Id: '0D5CHANGE', Type: 'TrackedChange' }]);

    const comments = left.keep(
      'FeedComment',
      [
        { Id: '0D7ON', FeedItemId: '0D5CHANGE' },
        { Id: '0D7OFF', FeedItemId: '0D5POST' },
      ],
      ['FeedItemId'],
    );
    const attachments = left.keep(
      'FeedAttachment',
      [{ Id: '0D6ON', FeedEntityId: '0D7ON' }],
      ['FeedEntityId'],
    );

    expect(comments).toEqual([{ Id: '0D7OFF', FeedItemId: '0D5POST' }]);
    expect(attachments).toEqual([]);
    expect(left.counts('FeedComment')).toEqual([
      { objectApiName: 'FeedComment', why: { rows: TRACKED, through: 'FeedItemId' }, count: 1 },
    ]);
    expect(left.counts('FeedAttachment')).toEqual([
      {
        objectApiName: 'FeedAttachment',
        why: { rows: TRACKED, through: 'FeedEntityId' },
        count: 1,
      },
    ]);
  });

  it('keeps a row that names a row left out through a lookup it may leave empty', () => {
    const left = new RowsLeftToThePlatform();
    left.keep('FeedItem', [{ Id: '0D5CHANGE', Type: 'TrackedChange' }]);

    expect(left.keep('Task', [{ Id: '00TA', WhatId: '0D5CHANGE' }])).toEqual([
      { Id: '00TA', WhatId: '0D5CHANGE' },
    ]);
    expect(left.counts('Task')).toEqual([]);
  });

  it('notes a row under the id it is given, when the row carries none of its own', () => {
    const left = new RowsLeftToThePlatform();

    expect(left.leaveOut('FeedItem', 'FeedItem-000001', { Type: 'TrackedChange' })).toEqual({
      rows: TRACKED,
    });
    expect(
      left.leaveOut('FeedComment', 'FeedComment-000001', { FeedItemId: 'FeedItem-000001' }, [
        'FeedItemId',
      ]),
    ).toEqual({ rows: TRACKED, through: 'FeedItemId' });
    expect(left.leaveOut('FeedItem', 'FeedItem-000002', { Type: 'TextPost' })).toBeUndefined();
  });

  it('words a tracked change and what hangs from one, one or several', () => {
    const own = { rows: TRACKED };
    const hanging = { rows: TRACKED, through: 'FeedItemId' };

    expect(leftToThePlatformNote(1, own)).toBe(
      '1 tracked change left out: the platform writes them itself',
    );
    expect(leftToThePlatformNote(2, own)).toBe(
      '2 tracked changes left out: the platform writes them itself',
    );
    expect(leftToThePlatformNote(2, hanging)).toBe(
      '2 left out: FeedItemId names a tracked change, which the platform writes itself',
    );
    expect(leftToThePlatformSummary(1, own)).toBe('Type=TrackedChange (1 record)');
    expect(leftToThePlatformSummary(3, hanging)).toBe('FeedItemId → tracked change (3 records)');
    expect(leftToThePlatformReason(own)).toBe(
      'Not written: the platform writes each tracked change itself, and refuses one a copy sends.',
    );
    expect(leftToThePlatformReason(hanging)).toBe(
      'Not written: FeedItemId may not be left empty, and the tracked change it names is one ' +
        'the platform writes itself, which no copy sends.',
    );
  });
});

describe('directAccountContactRelations', () => {
  it('finds the relation the platform made for each account and contact pair', async () => {
    const query = vi.fn<SoqlQuery>(async () => [
      { Id: '07kDIRECT', AccountId: '001T', ContactId: '003T' },
    ]);

    const found = await directAccountContactRelations(query, [
      { AccountId: '001T', ContactId: '003T' },
      { AccountId: '001OTHER', ContactId: '003T' },
    ]);

    expect(query).toHaveBeenCalledWith(
      "SELECT Id, AccountId, ContactId FROM AccountContactRelation WHERE IsDirect = true AND ContactId IN ('003T')",
    );
    // The second payload joins the same contact to another account: an
    // indirect relation, written like any other record.
    expect([...found]).toEqual([[0, '07kDIRECT']]);
  });

  it('asks nothing when no payload names a contact', async () => {
    const query = vi.fn<SoqlQuery>(async () => []);

    const found = await directAccountContactRelations(query, [{ AccountId: '001T' }]);

    expect(query).not.toHaveBeenCalled();
    expect(found.size).toBe(0);
  });

  it('asks for two hundred contacts at a time', async () => {
    const query = vi.fn<SoqlQuery>(async () => []);
    const payloads = Array.from({ length: 201 }, (_, i) => ({
      AccountId: '001T',
      ContactId: `003C${String(i).padStart(3, '0')}`,
    }));

    await directAccountContactRelations(query, payloads);

    expect(query).toHaveBeenCalledTimes(2);
  });
});

describe('existingSellingModelOptions', () => {
  it('finds the option the target holds for a product and selling model, and no other', async () => {
    const query = vi.fn<SoqlQuery>(async () => [
      { Id: '0iOHELD', Product2Id: '01tHELD', ProductSellingModelId: '0jPONCE' },
    ]);

    const found = await existingSellingModelOptions(query, [
      { Product2Id: '01tNEW', ProductSellingModelId: '0jPONCE' },
      { Product2Id: '01tHELD', ProductSellingModelId: '0jPONCE' },
      // The product the target holds, under a model it has no option for.
      { Product2Id: '01tHELD', ProductSellingModelId: '0jPYEARLY' },
    ]);

    expect(query).toHaveBeenCalledWith(
      'SELECT Id, Product2Id, ProductSellingModelId FROM ProductSellingModelOption ' +
        "WHERE Product2Id IN ('01tNEW', '01tHELD')",
    );
    expect([...found]).toEqual([[1, '0iOHELD']]);
  });

  it('asks nothing when no payload names a product', async () => {
    const query = vi.fn<SoqlQuery>(async () => []);

    const found = await existingSellingModelOptions(query, [{ ProductSellingModelId: '0jP' }]);

    expect(query).not.toHaveBeenCalled();
    expect(found.size).toBe(0);
  });

  it('asks for two hundred products at a time', async () => {
    const query = vi.fn<SoqlQuery>(async () => []);
    const payloads = Array.from({ length: 201 }, (_, i) => ({
      Product2Id: `01tP${String(i).padStart(3, '0')}`,
      ProductSellingModelId: '0jPONCE',
    }));

    await existingSellingModelOptions(query, payloads);

    expect(query).toHaveBeenCalledTimes(2);
  });
});

describe('recordsByNaturalKey', () => {
  const KEY = ['SellingModelType', 'PricingTerm', 'PricingTermUnit'];

  it('names the one record holding the key, and asks once per distinct key', async () => {
    const query = vi.fn<SoqlQuery>(async () => [{ Id: '0jPEXISTING' }]);
    const payload = { SellingModelType: 'OneTime', PricingTerm: 1, PricingTermUnit: 'Months' };

    const found = await recordsByNaturalKey(query, 'ProductSellingModel', KEY, [payload, payload]);

    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      "SELECT Id FROM ProductSellingModel WHERE SellingModelType = 'OneTime' AND PricingTerm = 1 AND PricingTermUnit = 'Months' LIMIT 2",
    );
    expect(found).toEqual(['0jPEXISTING', '0jPEXISTING']);
  });

  it('names nothing when the key matches two records', async () => {
    const query = vi.fn<SoqlQuery>(async () => [{ Id: '0jPA' }, { Id: '0jPB' }]);

    const found = await recordsByNaturalKey(query, 'ProductSellingModel', KEY, [
      { SellingModelType: 'OneTime', PricingTerm: null, PricingTermUnit: null },
    ]);

    expect(query.mock.calls[0][0]).toContain('PricingTerm = null');
    expect(found).toEqual([undefined]);
  });
});

describe('statusCategories', () => {
  it('reads each status with its category and picks a Draft one', async () => {
    const query = vi.fn<SoqlQuery>(async () => [
      { ApiName: 'ST002', StatusCode: 'Activated' },
      { ApiName: 'ST001', StatusCode: 'Draft' },
    ]);

    const categories = await statusCategories(query, 'OrderStatus');

    expect(query).toHaveBeenCalledWith('SELECT ApiName, StatusCode FROM OrderStatus');
    expect(categories?.draft).toBe('ST001');
    expect(categories?.categoryOf.get('ST002')).toBe('Activated');
  });

  it('says nothing when the target cannot answer', async () => {
    const query = vi.fn<SoqlQuery>(async () => {
      throw new Error("sObject type 'ContractStatus' is not supported");
    });

    await expect(statusCategories(query, 'ContractStatus')).resolves.toBeUndefined();
  });
});

describe('draftStartOf', () => {
  const categories = {
    categoryOf: new Map([
      ['ST001', 'Draft'],
      ['ST004', 'Activated'],
    ]),
    draft: 'ST001',
  };

  it('starts a record past Draft as a draft', () => {
    expect(draftStartOf('ST004', categories)).toBe('ST001');
  });

  it('leaves a draft, an empty status and a status the target does not know as they are', () => {
    expect(draftStartOf('ST001', categories)).toBeUndefined();
    expect(draftStartOf('', categories)).toBeUndefined();
    expect(draftStartOf(undefined, categories)).toBeUndefined();
    expect(draftStartOf('ST999', categories)).toBeUndefined();
  });

  it('leaves the record alone when the target has no Draft status to start from', () => {
    expect(draftStartOf('ST004', { ...categories, draft: undefined })).toBeUndefined();
  });
});
