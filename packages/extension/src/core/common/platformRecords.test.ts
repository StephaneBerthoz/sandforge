import { describe, it, expect, vi } from 'vitest';
import {
  directAccountContactRelations,
  draftStartOf,
  existingSellingModelOptions,
  recordsByNaturalKey,
  statusCategories,
  type SoqlQuery,
} from './platformRecords.js';

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
