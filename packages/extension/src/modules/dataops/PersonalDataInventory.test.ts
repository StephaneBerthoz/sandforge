import { describe, it, expect, vi } from 'vitest';
import { PII_SAMPLE_SIZE } from '@sandforge/shared';
import type { PiiInventoryObjectScan } from '@sandforge/shared';

import { PIIDetector } from '../../core/precheck/PIIDetector.js';
import { inventoryPersonalData, SAMPLE_FIELDS_PER_QUERY } from './PersonalDataInventory.js';

/** A contact describe: an email, a phone, a text field, a flag, a lookup. */
const contactDescribe = {
  name: 'Contact',
  label: 'Contact',
  queryable: true,
  fields: [
    { name: 'Id', label: 'Contact ID', type: 'id', filterable: true },
    { name: 'Name', label: 'Full Name', type: 'string', nameField: true, filterable: true },
    { name: 'Email', label: 'Email', type: 'email', filterable: true, updateable: true },
    { name: 'MobilePhone', label: 'Mobile', type: 'phone', filterable: true, updateable: true },
    { name: 'Description', label: 'Notes', type: 'textarea', filterable: false, updateable: true },
    { name: 'HasOptedOutOfEmail', label: 'Email Opt Out', type: 'boolean', filterable: true },
    { name: 'AccountId', label: 'Account ID', type: 'reference', filterable: true },
  ],
};

/** Three sampled contacts: two with an email, none with a mobile, one note quoting an address. */
const sampled = [
  { Id: '003000000000003AAA', Email: 'a@example.com', MobilePhone: null, Description: 'Call back' },
  { Id: '003000000000002AAA', Email: 'b@example.com', MobilePhone: '', Description: null },
  {
    Id: '003000000000001AAA',
    Email: null,
    MobilePhone: null,
    Description: 'Forwarded to c@example.com',
  },
];

function org(records: unknown[] = sampled) {
  const query = vi.fn(async (soql: string) => {
    if (soql.startsWith('SELECT Id')) return { totalSize: records.length, records };
    throw new Error(`unexpected query: ${soql}`);
  });
  return { describe: vi.fn(async () => contactDescribe), query };
}

describe('inventoryPersonalData', () => {
  it('names the fields the detector finds and counts how many sampled records fill them', async () => {
    const conn = org();

    const result = await inventoryPersonalData(conn, new PIIDetector(), {
      orgId: 'org-1',
      objects: ['Contact'],
    });

    const contact = result.objects[0] as PiiInventoryObjectScan;
    expect(contact.status).toBe('scanned');
    expect(contact.sampled).toBe(3);
    const byName = Object.fromEntries(contact.fields.map((f) => [f.fieldApiName, f]));
    expect(byName.Email).toMatchObject({ filled: 2, classification: 'PII', searchedFor: 'email' });
    // Named from its type, empty on every record sampled: shown, as zero.
    expect(byName.MobilePhone).toMatchObject({ filled: 0, searchedFor: 'phone' });
    // Named from its values alone: one of the three holds an address.
    expect(byName.Description).toMatchObject({ detectedBy: 'content', filled: 2, matched: 1 });
    expect(byName.HasOptedOutOfEmail).toBeUndefined();
    expect(contact.nameField).toEqual({ fieldApiName: 'Name', label: 'Full Name' });
  });

  it('puts the fields the sample confirms before those it leaves empty', async () => {
    const result = await inventoryPersonalData(org(), new PIIDetector(), {
      orgId: 'org-1',
      objects: ['Contact'],
    });

    const filled = (result.objects[0] as PiiInventoryObjectScan).fields.map((f) => f.filled);
    expect(filled).toEqual([...filled].sort((a, b) => b - a));
  });

  it('reads a bounded sample, the last records by Id, and says the bound', async () => {
    const conn = org();

    const result = await inventoryPersonalData(conn, new PIIDetector(), {
      orgId: 'org-1',
      objects: ['Contact'],
    });

    expect(result.sampleSize).toBe(PII_SAMPLE_SIZE);
    const [soql] = conn.query.mock.calls[0];
    expect(soql).toMatch(new RegExp(`ORDER BY Id DESC LIMIT ${PII_SAMPLE_SIZE}$`));
    // Text fields and the fields the detector named — not the flag, not the lookup.
    expect(soql).toContain('Description');
    expect(soql).not.toContain('HasOptedOutOfEmail');
    expect(soql).not.toContain('AccountId');
  });

  it('reads a wide object in several queries and puts each record back together', async () => {
    const wide = {
      ...contactDescribe,
      fields: [
        ...contactDescribe.fields,
        ...Array.from({ length: SAMPLE_FIELDS_PER_QUERY }, (_, i) => ({
          name: `Text${i}__c`,
          label: `Text ${i}`,
          type: 'string',
          filterable: true,
          updateable: true,
        })),
      ],
    };
    const query = vi.fn(async (soql: string) => {
      const record: Record<string, unknown> = { Id: '003000000000001AAA' };
      if (soql.includes('Email')) record.Email = 'a@example.com';
      if (soql.includes(`Text${SAMPLE_FIELDS_PER_QUERY - 1}__c`)) {
        record[`Text${SAMPLE_FIELDS_PER_QUERY - 1}__c`] = 'reach me at 06 12 34 56 78';
      }
      return { totalSize: 1, records: [record] };
    });

    const result = await inventoryPersonalData(
      { describe: async () => wide, query },
      new PIIDetector(),
      { orgId: 'org-1', objects: ['Contact'] },
    );

    expect(query).toHaveBeenCalledTimes(2);
    const contact = result.objects[0] as PiiInventoryObjectScan;
    expect(contact.sampled).toBe(1);
    const names = contact.fields.map((f) => f.fieldApiName);
    expect(names).toContain('Email');
    expect(names).toContain(`Text${SAMPLE_FIELDS_PER_QUERY - 1}__c`);
  });

  it('keeps what names and types say when the org refuses the sample, and says why', async () => {
    const conn = {
      describe: vi.fn(async () => contactDescribe),
      query: vi.fn(async () => {
        throw new Error('QUERY_TIMEOUT: Your query request was running for too long.');
      }),
    };

    const result = await inventoryPersonalData(conn, new PIIDetector(), {
      orgId: 'org-1',
      objects: ['Contact'],
    });

    const contact = result.objects[0] as PiiInventoryObjectScan;
    expect(contact.sampleError).toContain('QUERY_TIMEOUT');
    expect(contact.sampled).toBe(0);
    expect(contact.fields.map((f) => f.fieldApiName)).toEqual(
      expect.arrayContaining(['Email', 'MobilePhone']),
    );
  });

  it('fails one object the org will not describe, and reads the others', async () => {
    const conn = {
      describe: vi.fn(async (name: string) => {
        if (name === 'Nope__c') throw new Error('INVALID_TYPE: sObject type is not supported.');
        return contactDescribe;
      }),
      query: vi.fn(async () => ({ totalSize: 0, records: [] })),
    };

    const result = await inventoryPersonalData(conn, new PIIDetector(), {
      orgId: 'org-1',
      objects: ['Nope__c', 'Contact'],
    });

    expect(result.objects[0]).toEqual({
      status: 'failed',
      objectApiName: 'Nope__c',
      message: 'INVALID_TYPE: sObject type is not supported.',
    });
    expect(result.objects[1].status).toBe('scanned');
  });

  it('hands back counts, never a value it read', async () => {
    const result = await inventoryPersonalData(org(), new PIIDetector(), {
      orgId: 'org-1',
      objects: ['Contact'],
    });

    const sent = JSON.stringify(result);
    expect(sent).not.toContain('example.com');
    expect(sent).not.toContain('Call back');
    expect(sent).not.toContain('003000000000001AAA');
  });
});
