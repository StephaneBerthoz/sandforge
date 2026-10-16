import { describe, it, expect } from 'vitest';
import { readSyncRecordTypes } from './syncRecordTypes.js';
import { RECORD_TYPES_SOQL } from './RecordTypeMapper.js';

/** An org answering each query from `answers`, or refusing one it has no answer for. */
function org(answers: Record<string, Array<Record<string, unknown>>>) {
  const asked: string[] = [];
  return {
    asked,
    query: async (soql: string) => {
      asked.push(soql);
      const records = answers[soql];
      if (!records) throw new Error(`INVALID_FIELD: No such column 'IsPersonType'`);
      return { records, done: true };
    },
    queryMore: async () => ({ records: [], done: true }),
  };
}

const PERSON_TYPES =
  "SELECT Id FROM RecordType WHERE SobjectType = 'Account' AND IsPersonType = true";

describe('readSyncRecordTypes', () => {
  it('maps each source record type to the target’s of the same object and API name', async () => {
    const source = org({
      [RECORD_TYPES_SOQL]: [
        { Id: '0120000000000A1AAA', Name: 'Main', DeveloperName: 'Main', SobjectType: 'Case' },
        { Id: '0120000000000B1AAA', Name: 'Main', DeveloperName: 'Main', SobjectType: 'Account' },
        { Id: '0120000000000C1AAA', Name: 'Old', DeveloperName: 'Old', SobjectType: 'Case' },
      ],
    });
    const target = org({
      [RECORD_TYPES_SOQL]: [
        { Id: '0120000000000B2AAA', Name: 'Main', DeveloperName: 'Main', SobjectType: 'Account' },
        { Id: '0120000000000A2AAA', Name: 'Main', DeveloperName: 'Main', SobjectType: 'Case' },
      ],
      [PERSON_TYPES]: [{ Id: '0120000000000P2AAA' }],
    });

    const types = await readSyncRecordTypes(source, target);

    expect(types.mappings).toEqual([
      { sourceId: '0120000000000A1AAA', targetId: '0120000000000A2AAA', developerName: 'Main' },
      { sourceId: '0120000000000B1AAA', targetId: '0120000000000B2AAA', developerName: 'Main' },
    ]);
    expect(types.source.map((t) => t.developerName)).toEqual(['Main', 'Main', 'Old']);
    expect([...(types.personTypes ?? [])]).toEqual(['0120000000000P2']);
  });

  it('leaves the person account types out where the target has none to read', async () => {
    const rows = {
      [RECORD_TYPES_SOQL]: [
        { Id: '0120000000000A1AAA', Name: 'Main', DeveloperName: 'Main', SobjectType: 'Case' },
      ],
    };

    const types = await readSyncRecordTypes(org(rows), org(rows));

    expect(types.personTypes).toBeUndefined();
    expect(types.mappings).toHaveLength(1);
  });

  it('fails when an org will not give its record types, rather than send the source’s ids', async () => {
    await expect(readSyncRecordTypes(org({}), org({ [RECORD_TYPES_SOQL]: [] }))).rejects.toThrow(
      /IsPersonType|No such column/,
    );
  });
});
