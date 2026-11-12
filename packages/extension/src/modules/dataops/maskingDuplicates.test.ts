import { describe, expect, it } from 'vitest';
import type { ForgeTargetAutomation } from '@sandforge/shared';

import {
  DUPLICATE_ITEMS_READ,
  duplicateRulesOn,
  maskingDuplicatesSentence,
  readMaskingDuplicates,
  watchDuplicates,
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

    // The items, then the one set they sit in.
    expect(read).toEqual({ rules: RULES, sets: 1, items: 4, requests: 2 });
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
    expect(read).toEqual({
      rules: RULES,
      sets: 1,
      items: DUPLICATE_ITEMS_READ,
      atLeast: true,
      requests: 2,
    });
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
      requests: 1,
    });
  });
});

describe('watchDuplicates', () => {
  /** A machine clock a test moves by hand, and the waits it was asked for. */
  function clock(start = 1_000_000) {
    const waits: number[] = [];
    const state = { at: start };
    return {
      waits,
      advance: (ms: number) => {
        state.at += ms;
      },
      now: () => state.at,
      sleep: async (ms: number) => {
        waits.push(ms);
        state.at += ms;
      },
    };
  }

  /** The org of {@link orgOf}, whose clock answers `serverTime`, counted. */
  function watchedOrg(
    tables: { sets: Row[]; items: Row[] },
    serverTime = '2026-11-04T12:31:25.000Z',
  ) {
    const org = orgOf(tables);
    const asked = { clock: 0 };
    return {
      ...org,
      asked,
      serverTime: async () => {
        asked.clock++;
        return serverTime;
      },
    };
  }

  it('asks the org nothing and waits for nothing when no record of an object a rule covers was saved', async () => {
    const org = watchedOrg({ sets: [], items: [] });
    const time = clock();
    const watch = watchDuplicates(org, RULES, { settleMs: 5_000, ...time });

    // Leads, which no rule covers, saved; contacts sent, and every one refused.
    watch.beforeWrite('Lead');
    watch.wrote('Lead', ['00Qxx0000000001AAA']);
    watch.beforeWrite('Contact');
    watch.wrote('Contact', []);

    expect(await watch.read()).toBeUndefined();
    expect(org.asked.clock).toBe(0);
    expect(org.statements).toEqual([]);
    expect(time.waits).toEqual([]);
  });

  it('waits from the last record a rule covers the org saved, not from the run’s last write', async () => {
    const org = watchedOrg({ sets: [], items: [] });
    const time = clock();
    const watch = watchDuplicates(org, RULES, { settleMs: 5_000, ...time });

    watch.beforeWrite('Contact');
    watch.wrote('contact', [MASKED_1]);
    // Two seconds of leads after it.
    time.advance(2_000);
    watch.beforeWrite('Lead');
    watch.wrote('Lead', ['00Qxx0000000001AAA']);

    const read = await watch.read();
    expect(time.waits).toEqual([3_000]);
    // The org's clock once, the items, and no set to read.
    expect(read).toEqual({ rules: RULES, sets: 0, items: 0, requests: 2, waitedMs: 3_000 });
    expect(org.asked.clock).toBe(1);
  });

  it('waits for nothing when the last covered record was saved longer ago than a report takes', async () => {
    const org = watchedOrg({ sets: [], items: [] });
    const time = clock();
    const watch = watchDuplicates(org, RULES, { settleMs: 5_000, ...time });

    watch.beforeWrite('Contact');
    watch.wrote('Contact', [MASKED_1]);
    time.advance(7_000);

    expect(await watch.read()).toMatchObject({ waitedMs: 0, requests: 2 });
    expect(time.waits).toEqual([]);
  });

  it('dates the clock back to when the saved write went out, and reads the records a call whose answer never came may have saved', async () => {
    const org = watchedOrg(
      {
        sets: [{ Id: '0GLxx0000000001AAA', CreatedDate: '2026-11-04T12:31:24.000Z' }],
        items: [
          {
            Id: '0GMxx0000000001AAA',
            DuplicateRecordSetId: '0GLxx0000000001AAA',
            RecordId: MASKED_2,
            CreatedDate: '2026-11-04T12:31:24.000Z',
          },
        ],
      },
      '2026-11-04T12:31:25.000Z',
    );
    const time = clock();
    const watch = watchDuplicates(org, RULES, { settleMs: 0, ...time });

    // The write went out, and its answer came four seconds later.
    watch.beforeWrite('Contact');
    time.advance(4_000);
    watch.wrote('Contact', [MASKED_2]);

    const read = await watch.read();
    expect(read).toMatchObject({ sets: 1, items: 1 });
    // 12:31:25 less the four seconds, less the second the org dates a record to.
    expect(org.statements[0]).toContain('WHERE CreatedDate >= 2026-11-04T12:31:20Z');
  });

  it('says it could not read what they wrote when the org would not give its clock', async () => {
    const org = {
      ...watchedOrg({ sets: [], items: [] }),
      serverTime: async (): Promise<string> => {
        throw new Error('INVALID_SESSION_ID: Session expired or invalid');
      },
    };
    const watch = watchDuplicates(org, RULES, { settleMs: 0, ...clock() });

    watch.beforeWrite('Contact');
    watch.wrote('Contact', [MASKED_1]);

    expect(await watch.read()).toEqual({
      rules: RULES,
      sets: 0,
      items: 0,
      unread: "the org's clock: INVALID_SESSION_ID: Session expired or invalid",
      requests: 1,
    });
    expect(org.statements).toEqual([]);
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

  it('names the restore and the erasure in place as what wrote the records, and says what the read cost', () => {
    expect(
      maskingDuplicatesSentence(
        { rules: RULES, sets: 1, items: 2, requests: 3, waitedMs: 4_600 },
        'TGT',
        'restore',
      ),
    ).toBe(
      'The duplicate rules of TGT on Contact ("Standard Contact Duplicate Rule") wrote 1 ' +
        'duplicate record set(s) and 2 item(s) during the restore, for records it put back: ' +
        'kept, as they name records that stay. Read in 3 request(s), after waiting 5 s.',
    );
    expect(
      maskingDuplicatesSentence(
        { rules: RULES, sets: 0, items: 0, requests: 2, waitedMs: 0 },
        'TGT',
        'erasure',
      ),
    ).toBe(
      'The duplicate rules of TGT on Contact ("Standard Contact Duplicate Rule") wrote nothing ' +
        'for the records it overwrote. Read in 2 request(s), without waiting.',
    );
  });
});
