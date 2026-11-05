import { describe, expect, it } from 'vitest';
import type { ForgeTargetAutomation } from '@sandforge/shared';

import {
  DUPLICATE_ITEMS_READ,
  duplicateRulesOn,
  maskingDuplicatesSentence,
  readMaskingDuplicates,
  type DuplicatesOrg,
} from './maskingDuplicates.js';

/** The columns each object has, as its describe lists them: another one is refused. */
const COLUMNS: Record<string, readonly string[]> = {
  DuplicateRecordItem: ['Id', 'Name', 'DuplicateRecordSetId', 'RecordId', 'CreatedDate'],
  DuplicateRecordSet: ['Id', 'Name', 'DuplicateRuleId', 'RecordCount', 'CreatedDate'],
};

interface Row {
  Id: string;
  CreatedDate: string;
  DuplicateRecordSetId?: string;
  RecordId?: string;
}

/**
 * An org holding duplicate record sets and items, answering the statements
 * the read sends as Salesforce does: the columns it selects, `CreatedDate >=`
 * a literal to the second, `Id IN`, `LIMIT`; a column the object does not
 * have is refused, as the org refuses it.
 */
function orgOf(tables: { sets: Row[]; items: Row[] }): DuplicatesOrg & { statements: string[] } {
  const statements: string[] = [];
  return {
    statements,
    query: async (soql) => {
      statements.push(soql);
      const match = /^SELECT (.+?) FROM (\w+) WHERE (.+?)(?: LIMIT (\d+))?$/.exec(soql);
      if (!match) throw new Error(`MALFORMED_QUERY: ${soql}`);
      const [, select, object, where, limit] = match;
      const fields = select.split(', ');
      for (const field of fields) {
        if (!COLUMNS[object]?.includes(field)) {
          throw new Error(`INVALID_FIELD: No such column '${field}' on entity '${object}'.`);
        }
      }
      const since = /CreatedDate >= (\S+)/.exec(where)?.[1];
      if (since !== undefined && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(since)) {
        throw new Error(`MALFORMED_QUERY: value of filter criterion is not valid: ${since}`);
      }
      const ids = /Id IN \(([^)]*)\)/
        .exec(where)?.[1]
        ?.split(', ')
        .map((id) => id.slice(1, -1));
      const rows = (object === 'DuplicateRecordSet' ? tables.sets : tables.items).filter(
        (row) =>
          (since === undefined || Date.parse(row.CreatedDate) >= Date.parse(since)) &&
          (ids === undefined || ids.includes(row.Id)),
      );
      const kept = limit === undefined ? rows : rows.slice(0, Number(limit));
      return {
        records: kept.map((row) =>
          Object.fromEntries(
            fields.map((f) => [f, (row as unknown as Record<string, unknown>)[f]]),
          ),
        ),
        done: true,
      };
    },
  };
}

const MASKED_1 = '003xx0000000001AAA';
const MASKED_2 = '003xx0000000002AAA';
const ALIKE = '003xx0000000009AAA';
const OTHER = '003xx0000000007AAA';
const RULES = [{ objectApiName: 'Contact', rules: ['Standard Contact Duplicate Rule'] }];
/** The org's clock just before the run's first write. */
const SINCE = '2026-11-04T12:31:20.500Z';

describe('duplicateRulesOn', () => {
  it('names the active duplicate rules of the objects the masking writes, and none of the others', () => {
    const automation: Pick<ForgeTargetAutomation, 'objects'> = {
      objects: [
        {
          objectApiName: 'Contact',
          flows: [],
          triggers: [],
          duplicateRules: [
            {
              name: 'Standard Contact Duplicate Rule',
              developerName: 'Standard_Rule_for_Contacts',
            },
          ],
        },
        {
          objectApiName: 'Lead',
          flows: [],
          triggers: [],
          duplicateRules: [{ name: 'Lead Block', developerName: 'Lead_Block' }],
        },
        { objectApiName: 'Account', flows: [], triggers: [], duplicateRules: [] },
      ],
    };
    expect(duplicateRulesOn(automation, ['contact', 'Account'])).toEqual(RULES);
    expect(duplicateRulesOn(undefined, ['Contact'])).toEqual([]);
  });
});

describe('readMaskingDuplicates', () => {
  it('counts the sets made during the run that hold a record it masked, with their items, and nothing from before or of other records', async () => {
    const org = orgOf({
      sets: [
        // Made by the rule a few seconds after the masking's write.
        { Id: '0GLxx0000000001AAA', CreatedDate: '2026-11-04T12:31:30.000Z' },
        // Held before the run; the masking added an item of its record to it.
        { Id: '0GLxx0000000002AAA', CreatedDate: '2026-10-01T08:00:00.000Z' },
        // Made during the run for records it never masked.
        { Id: '0GLxx0000000003AAA', CreatedDate: '2026-11-04T12:31:31.000Z' },
      ],
      items: [
        {
          Id: '0GMxx0000000001AAA',
          DuplicateRecordSetId: '0GLxx0000000001AAA',
          RecordId: MASKED_1,
          CreatedDate: '2026-11-04T12:31:30.000Z',
        },
        {
          Id: '0GMxx0000000002AAA',
          DuplicateRecordSetId: '0GLxx0000000001AAA',
          RecordId: MASKED_2,
          CreatedDate: '2026-11-04T12:31:30.000Z',
        },
        {
          Id: '0GMxx0000000003AAA',
          DuplicateRecordSetId: '0GLxx0000000002AAA',
          RecordId: MASKED_2.slice(0, 15),
          CreatedDate: '2026-11-04T12:31:30.000Z',
        },
        // The record it was matched with, in the same report.
        {
          Id: '0GMxx0000000004AAA',
          DuplicateRecordSetId: '0GLxx0000000002AAA',
          RecordId: ALIKE,
          CreatedDate: '2026-11-04T12:31:30.000Z',
        },
        {
          Id: '0GMxx0000000005AAA',
          DuplicateRecordSetId: '0GLxx0000000003AAA',
          RecordId: OTHER,
          CreatedDate: '2026-11-04T12:31:31.000Z',
        },
        // Written before the run.
        {
          Id: '0GMxx0000000006AAA',
          DuplicateRecordSetId: '0GLxx0000000002AAA',
          RecordId: MASKED_1,
          CreatedDate: '2026-10-01T08:00:00.000Z',
        },
      ],
    });

    const read = await readMaskingDuplicates(org, {
      rules: RULES,
      since: SINCE,
      masked: new Set([MASKED_1, MASKED_2]),
    });

    expect(read).toEqual({ rules: RULES, sets: 1, items: 4 });
    // From the second before the first write, as the org dates a record.
    expect(org.statements[0]).toContain('WHERE CreatedDate >= 2026-11-04T12:31:19Z');
  });

  it('says the counts are at least what it read when more items were made during the run than it reads', async () => {
    const items = Array.from({ length: DUPLICATE_ITEMS_READ + 1 }, (_, at) => ({
      Id: `0GMxx${String(at).padStart(10, '0')}AAA`,
      DuplicateRecordSetId: '0GLxx0000000001AAA',
      RecordId: MASKED_1,
      CreatedDate: '2026-11-04T12:31:30.000Z',
    }));
    const read = await readMaskingDuplicates(
      orgOf({
        sets: [{ Id: '0GLxx0000000001AAA', CreatedDate: '2026-11-04T12:31:30.000Z' }],
        items,
      }),
      { rules: RULES, since: SINCE, masked: new Set([MASKED_1]) },
    );
    expect(read).toEqual({ rules: RULES, sets: 1, items: DUPLICATE_ITEMS_READ, atLeast: true });
  });

  it('says what the org answered when it would not be read, and counts nothing', async () => {
    const read = await readMaskingDuplicates(
      {
        query: async () => {
          throw new Error("INVALID_TYPE: sObject type 'DuplicateRecordItem' is not supported.");
        },
      },
      { rules: RULES, since: SINCE, masked: new Set([MASKED_1]) },
    );
    expect(read).toEqual({
      rules: RULES,
      sets: 0,
      items: 0,
      unread: "INVALID_TYPE: sObject type 'DuplicateRecordItem' is not supported.",
    });
  });
});

describe('maskingDuplicatesSentence', () => {
  it('says what the rules wrote during the masking, and that it keeps it', () => {
    expect(maskingDuplicatesSentence({ rules: RULES, sets: 1, items: 2 }, 'TGT')).toBe(
      'The duplicate rules of TGT on Contact ("Standard Contact Duplicate Rule") wrote 1 ' +
        'duplicate record set(s) and 2 item(s) during the masking, for records it masked: kept, ' +
        'as they name records that stay.',
    );
    expect(
      maskingDuplicatesSentence({ rules: RULES, sets: 1, items: 2000, atLeast: true }, 'TGT'),
    ).toContain('wrote at least 1 duplicate record set(s) and at least 2000 item(s)');
  });

  it('says they wrote nothing, or that what they wrote could not be read, and nothing without a rule', () => {
    expect(maskingDuplicatesSentence({ rules: RULES, sets: 0, items: 0 }, 'TGT')).toBe(
      'The duplicate rules of TGT on Contact ("Standard Contact Duplicate Rule") wrote nothing ' +
        'for the records it masked.',
    );
    expect(
      maskingDuplicatesSentence(
        { rules: RULES, sets: 0, items: 0, unread: 'INSUFFICIENT_ACCESS' },
        'TGT',
      ),
    ).toBe(
      'What the duplicate rules of TGT on Contact ("Standard Contact Duplicate Rule") wrote ' +
        'during the masking could not be read (INSUFFICIENT_ACCESS): a duplicate record set ' +
        'they wrote stays.',
    );
    expect(maskingDuplicatesSentence(undefined, 'TGT')).toBe('');
    expect(maskingDuplicatesSentence({ rules: [], sets: 0, items: 0 }, 'TGT')).toBe('');
  });
});
