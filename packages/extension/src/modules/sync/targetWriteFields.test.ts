import { describe, it, expect } from 'vitest';
import { targetWriteFieldsOf } from './targetWriteFields.js';

describe('targetWriteFieldsOf', () => {
  it('reads the writable fields, the lookups among them and the record types from one describe', () => {
    const fields = targetWriteFieldsOf({
      fields: [
        { name: 'Id', createable: false, type: 'id' },
        { name: 'Name', createable: true, type: 'string' },
        { name: 'ParentId', createable: true, type: 'reference' },
        { name: 'CreatedById', createable: false, type: 'reference' },
        { name: 'RecordTypeId', createable: true, type: 'reference' },
      ],
      recordTypeInfos: [
        {
          active: true,
          available: false,
          defaultRecordTypeMapping: false,
          developerName: 'Partner',
          master: false,
          name: 'Partner',
          recordTypeId: '012Fk00000RtDeFIAV',
          urls: {},
        },
      ],
    });

    expect([...fields.creatable].sort()).toEqual(['Name', 'ParentId', 'RecordTypeId']);
    expect([...fields.references].sort()).toEqual(['ParentId', 'RecordTypeId']);
    expect(fields.recordTypes?.map((r) => [r.developerName, r.available])).toEqual([
      ['Partner', false],
    ]);
  });

  it('reads no record type from a describe that carries none', () => {
    expect(
      targetWriteFieldsOf({ fields: [{ name: 'Name', createable: true }] }).recordTypes,
    ).toEqual([]);
  });
});
