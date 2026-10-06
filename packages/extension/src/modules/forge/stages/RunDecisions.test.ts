import { describe, it, expect } from 'vitest';
import type { RecordTypeAvailability } from '../../../core/metadata/recordTypeAvailability.js';
import { forgeGapId } from '@sandforge/shared';
import {
  DecisionTally,
  RunDecisions,
  recordTypeDecisionMappings,
  runDecisionsOf,
  withRecordTypeDecisions,
} from './RunDecisions.js';

const recordType = (recordTypeId: string, developerName: string): RecordTypeAvailability => ({
  recordTypeId,
  developerName,
  name: developerName,
  available: true,
  active: true,
  master: false,
  defaultRecordTypeMapping: false,
});

describe('RunDecisions.applyToRow', () => {
  it('maps a picklist value for every row when the mapping names no record type', () => {
    const decisions = new RunDecisions({
      picklistValueMappings: [{ object: 'Case', field: 'Origin', from: 'Fax', to: 'Phone' }],
    });
    const tally = new DecisionTally();
    const row: Record<string, unknown> = { Origin: 'Fax' };

    decisions.applyToRow('Case', row, 'Support', tally);

    expect(row).toEqual({ Origin: 'Phone' });
    expect(tally.list()).toEqual([
      {
        kind: 'map_value',
        objectApiName: 'Case',
        field: 'Origin',
        from: 'Fax',
        to: 'Phone',
        rows: 1,
      },
    ]);
  });

  it('maps a value only for the rows of the record type the mapping names', () => {
    const decisions = new RunDecisions({
      picklistValueMappings: [
        { object: 'Case', field: 'Origin', recordType: 'Support', from: 'Fax', to: 'Phone' },
      ],
    });
    const tally = new DecisionTally();
    const support: Record<string, unknown> = { Origin: 'Fax' };
    const other: Record<string, unknown> = { Origin: 'Fax' };
    const unknown: Record<string, unknown> = { Origin: 'Fax' };

    decisions.applyToRow('Case', support, 'Support', tally);
    decisions.applyToRow('Case', other, 'Billing', tally);
    decisions.applyToRow('Case', unknown, undefined, tally);

    expect([support, other, unknown]).toEqual([
      { Origin: 'Phone' },
      { Origin: 'Fax' },
      { Origin: 'Fax' },
    ]);
    expect(tally.list()[0]?.rows).toBe(1);
  });

  it('leaves the field out of a row whose value is mapped to nothing', () => {
    const decisions = new RunDecisions({
      picklistValueMappings: [{ object: 'Case', field: 'Origin', from: 'Fax', to: null }],
    });
    const tally = new DecisionTally();
    const row: Record<string, unknown> = { Origin: 'Fax', Subject: 'Hello' };

    decisions.applyToRow('Case', row, undefined, tally);

    expect(row).toEqual({ Subject: 'Hello' });
    expect(tally.list()).toEqual([
      { kind: 'leave_empty', objectApiName: 'Case', field: 'Origin', from: 'Fax', rows: 1 },
    ]);
  });

  it('maps one selection of a multi-select value, and keeps the others', () => {
    const decisions = new RunDecisions({
      picklistValueMappings: [
        { object: 'Account', field: 'Regions__c', from: 'North', to: 'Nord' },
        { object: 'Account', field: 'Regions__c', from: 'Gone', to: null },
      ],
    });
    const row: Record<string, unknown> = { Regions__c: 'North;Gone;South' };

    decisions.applyToRow('Account', row, undefined, new DecisionTally());

    expect(row).toEqual({ Regions__c: 'Nord;South' });
  });

  it('gives a default only to a field the row leaves empty, never over a value it holds', () => {
    const decisions = new RunDecisions({
      defaultValues: [{ object: 'Case', field: 'Region__c', value: 'North' }],
    });
    const tally = new DecisionTally();
    const empty: Record<string, unknown> = { Region__c: '' };
    const missing: Record<string, unknown> = {};
    const held: Record<string, unknown> = { Region__c: 'South' };

    for (const row of [empty, missing, held]) decisions.applyToRow('Case', row, undefined, tally);

    expect([empty, missing, held]).toEqual([
      { Region__c: 'North' },
      { Region__c: 'North' },
      { Region__c: 'South' },
    ]);
    expect(tally.list()).toEqual([
      { kind: 'set_default', objectApiName: 'Case', field: 'Region__c', to: 'North', rows: 2 },
    ]);
  });

  it('changes nothing of an object no decision names', () => {
    const decisions = new RunDecisions({
      defaultValues: [{ object: 'Case', field: 'Region__c', value: 'North' }],
    });
    const tally = new DecisionTally();
    const row: Record<string, unknown> = {};

    decisions.applyToRow('Contact', row, undefined, tally);

    expect(row).toEqual({});
    expect(tally.size).toBe(0);
  });
});

describe('RunDecisions.holdsBack', () => {
  const refused = (value: string, recordType?: string): string =>
    forgeGapId('picklist_value_refused', 'Case', 'Origin', recordType, value);
  const row =
    (values: Record<string, unknown>) =>
    (field: string): unknown =>
      values[field];

  it('holds back a row holding the value a skipped gap names, one selection among others included', () => {
    const decisions = new RunDecisions({
      skippedRows: [{ object: 'Case', gapId: refused('Fax') }],
    });
    const tally = new DecisionTally();

    expect(decisions.holdsBack('Case', row({ Origin: 'Fax' }), undefined, tally)).toBe(true);
    expect(decisions.holdsBack('Case', row({ Origin: 'Web;Fax' }), 'Support', tally)).toBe(true);
    expect(decisions.holdsBack('Case', row({ Origin: 'Faxed' }), undefined, tally)).toBe(false);
    expect(decisions.holdsBack('Case', row({}), undefined, tally)).toBe(false);
    expect(tally.list()).toEqual([
      { kind: 'skip_rows', objectApiName: 'Case', field: 'Origin', from: 'Fax', rows: 2 },
    ]);
  });

  it('holds back only the rows of the record type the gap names', () => {
    const decisions = new RunDecisions({
      skippedRows: [{ object: 'Case', gapId: refused('Fax', 'Support') }],
    });
    const tally = new DecisionTally();

    expect(decisions.holdsBack('Case', row({ Origin: 'Fax' }), 'Support', tally)).toBe(true);
    expect(decisions.holdsBack('Case', row({ Origin: 'Fax' }), 'Billing', tally)).toBe(false);
    expect(decisions.holdsBack('Case', row({ Origin: 'Fax' }), undefined, tally)).toBe(false);
  });

  it('holds back nothing for a gap of another object, or of a kind whose rows its value does not name', () => {
    const decisions = new RunDecisions({
      skippedRows: [
        { object: 'Lead', gapId: refused('Fax') },
        {
          object: 'Case',
          gapId: forgeGapId('dependent_value_invalid', 'Case', 'Origin', undefined, 'Fax'),
        },
        { object: 'Case', gapId: forgeGapId('validation_rule', 'Case', undefined, undefined, 'R') },
      ],
    });

    expect(decisions.skipsRowsOf('Case')).toBe(false);
    expect(decisions.skipsRowsOf('Lead')).toBe(false);
    expect(
      decisions.holdsBack('Case', row({ Origin: 'Fax' }), undefined, new DecisionTally()),
    ).toBe(false);
  });
});

describe('runDecisionsOf', () => {
  it('hands the executor the rows held back with the other decisions, and nothing when none is held', () => {
    const skippedRows = [{ object: 'Case', gapId: 'currency_inactive|Case|CurrencyIsoCode||USD' }];
    expect(runDecisionsOf({ skippedRows })).toEqual({ skippedRows });
    expect(runDecisionsOf({ skippedRows: [], ignoredGaps: [] })).toBeUndefined();
  });
});

describe('RunDecisions.truncate', () => {
  it('cuts a text the user chose to cut to the length its field holds in the target', () => {
    const decisions = new RunDecisions({ truncateFields: [{ object: 'Case', field: 'Subject' }] });
    const tally = new DecisionTally();
    const long: Record<string, unknown> = { Subject: 'abcdefgh', Description: 'abcdefgh' };
    const short: Record<string, unknown> = { Subject: 'abc' };
    const lengths = new Map([
      ['Subject', 5],
      ['Description', 5],
    ]);

    decisions.truncate('Case', long, lengths, tally);
    decisions.truncate('Case', short, lengths, tally);

    // Only the field chosen; the other stays for the target to refuse, and
    // the simulation to say.
    expect(long).toEqual({ Subject: 'abcde', Description: 'abcdefgh' });
    expect(short).toEqual({ Subject: 'abc' });
    expect(tally.list()).toEqual([
      { kind: 'truncate', objectApiName: 'Case', field: 'Subject', rows: 1 },
    ]);
  });

  it('cuts nothing when the target gives no length for the field', () => {
    const decisions = new RunDecisions({ truncateFields: [{ object: 'Case', field: 'Subject' }] });
    const row: Record<string, unknown> = { Subject: 'abcdefgh' };

    decisions.truncate('Case', row, new Map(), new DecisionTally());

    expect(row).toEqual({ Subject: 'abcdefgh' });
  });
});

describe('recordTypeDecisionMappings', () => {
  const types = [
    {
      objectApiName: 'Case',
      source: [
        recordType('012S00000000001AAA', 'Support'),
        recordType('012S00000000002AAA', 'Old'),
      ],
      target: [recordType('012T00000000001AAA', 'Service')],
    },
  ];

  it('turns a decision by names into ids, and keeps it by the source id', () => {
    const decided = recordTypeDecisionMappings(
      [{ object: 'Case', from: 'Support', to: 'Service' }],
      types,
    );

    expect(decided.mappings).toEqual([
      { sourceId: '012S00000000001AAA', targetId: '012T00000000001AAA', developerName: 'Service' },
    ]);
    expect(decided.bySource.get('012S00000000001AAA')).toEqual({
      object: 'Case',
      from: 'Support',
      to: 'Service',
    });
    expect(decided.unresolved).toEqual([]);
  });

  it('sends a source record type to the default without a mapping', () => {
    const decided = recordTypeDecisionMappings([{ object: 'Case', from: 'Old', to: null }], types);

    expect(decided.mappings).toEqual([]);
    expect(decided.bySource.get('012S00000000002AAA')?.to).toBeNull();
  });

  it('says why a decision naming a record type either org lacks is not applied', () => {
    const decided = recordTypeDecisionMappings(
      [
        { object: 'Case', from: 'Missing', to: 'Service' },
        { object: 'Case', from: 'Support', to: 'Missing' },
      ],
      types,
    );

    expect(decided.bySource.size).toBe(0);
    expect(decided.unresolved.map((u) => u.reason)).toEqual([
      'the source has no Case record type named Missing',
      'the target has no Case record type named Missing',
    ]);
  });
});

describe('withRecordTypeDecisions', () => {
  it('puts a decision over the mapping matched by name, and drops one sent to the default', () => {
    const base = [
      { sourceId: 'S1', targetId: 'T1', developerName: 'Support' },
      { sourceId: 'S2', targetId: 'T2', developerName: 'Old' },
      { sourceId: 'S3', targetId: 'T3', developerName: 'Kept' },
    ];
    const merged = withRecordTypeDecisions(base, {
      mappings: [{ sourceId: 'S1', targetId: 'T9', developerName: 'Service' }],
      bySource: new Map([
        ['S1', { object: 'Case', from: 'Support', to: 'Service' }],
        ['S2', { object: 'Case', from: 'Old', to: null }],
      ]),
      unresolved: [],
    });

    expect(merged).toEqual([
      { sourceId: 'S3', targetId: 'T3', developerName: 'Kept' },
      { sourceId: 'S1', targetId: 'T9', developerName: 'Service' },
    ]);
  });

  it('leaves the mapping as it was, unread included, when no decision resolved', () => {
    const empty = { mappings: [], bySource: new Map(), unresolved: [] };

    expect(withRecordTypeDecisions(undefined, empty)).toBeUndefined();
    expect(withRecordTypeDecisions([], empty)).toEqual([]);
  });
});
