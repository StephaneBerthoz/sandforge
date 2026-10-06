import { describe, expect, it } from 'vitest';
import type { ForgeConfig, ForgeGap, ForgeGraph } from '@sandforge/shared';
import { forgeGapId } from '@sandforge/shared';
import {
  allowedValues,
  choiceOf,
  decisionOf,
  decisionsAnsweringNoGap,
  gapsToShow,
  keptDecisions,
  objectsLeftOut,
  offeredDecisions,
  targetRecordTypes,
  undecidedBlockingGaps,
  withGapDecision,
  withoutGapDecision,
} from './forgeGapDecisions';

const CONFIG: ForgeConfig = {
  inputMode: 'record',
  recordId: '001000000000001AAA',
  depth: 'direct',
  sourceOrgId: 'org-source',
  targetOrgId: 'org-target',
  anonymizePII: false,
  skipEmpty: false,
  batchSize: 'auto',
};

/** A picklist value a record type of the target refuses, as a simulation finds it. */
const REFUSED: ForgeGap = {
  id: forgeGapId('picklist_value_refused', 'Case', 'Reason__c', 'Claim', 'Other'),
  kind: 'picklist_value_refused',
  severity: 'blocking',
  source: 'simulation',
  objectApiName: 'Case',
  field: 'Reason__c',
  recordType: 'Claim',
  value: 'Other',
  rows: 12,
  detail: { allowedValues: ['General', 'Billing'] },
  decisions: ['map_value', 'leave_empty', 'exclude_object', 'skip_rows', 'ignore'],
};

/** A field only the target requires. */
const REQUIRED: ForgeGap = {
  id: forgeGapId('required_field_missing', 'Account', 'Region__c'),
  kind: 'required_field_missing',
  severity: 'blocking',
  source: 'metadata',
  objectApiName: 'Account',
  field: 'Region__c',
  rows: 0,
  decisions: ['set_default', 'exclude_object'],
};

/** A text longer than the target's field. */
const TOO_LONG: ForgeGap = {
  id: forgeGapId('value_too_long', 'Contact', 'Description'),
  kind: 'value_too_long',
  severity: 'warning',
  source: 'simulation',
  objectApiName: 'Contact',
  field: 'Description',
  rows: 3,
  detail: { maxLength: 255 },
  decisions: ['truncate', 'leave_empty', 'ignore'],
};

/** A source record type the target holds no match for. */
const UNMAPPED: ForgeGap = {
  id: forgeGapId('record_type_unmapped', 'Case', undefined, undefined, 'Old_RT'),
  kind: 'record_type_unmapped',
  severity: 'blocking',
  source: 'simulation',
  objectApiName: 'Case',
  value: 'Old_RT',
  rows: 5,
  detail: { targetRecordTypes: ['Claim', 'Support'] },
  decisions: ['map_record_type', 'ignore'],
};

/** A validation rule, which names the field it shows its error on. */
const RULE: ForgeGap = {
  id: forgeGapId('validation_rule', 'Contact', 'Phone', undefined, 'Phone_Format'),
  kind: 'validation_rule',
  severity: 'warning',
  source: 'metadata',
  objectApiName: 'Contact',
  field: 'Phone',
  value: 'Phone_Format',
  rows: 0,
  decisions: ['leave_empty', 'ignore'],
};

describe('offeredDecisions', () => {
  it('offers what the config can hold, never skipping rows, which no field of it holds', () => {
    expect(offeredDecisions(REFUSED)).toEqual([
      'map_value',
      'leave_empty',
      'exclude_object',
      'ignore',
    ]);
  });

  it('reads the allowed values and record types under the names the simulation gives them', () => {
    // The simulation names them `allowed` and `mapTo`: under those names only,
    // the tab offered no value and no record type to map to.
    expect(offeredDecisions({ ...REFUSED, detail: { allowed: ['General', 'Claim'] } })).toContain(
      'map_value',
    );
    expect(allowedValues({ ...REFUSED, detail: { allowed: ['General'] } })).toEqual(['General']);
    expect(
      targetRecordTypes({
        ...REFUSED,
        kind: 'record_type_unmapped',
        detail: { mapTo: ['Claim', 'Service'] },
      }),
    ).toEqual(['Claim', 'Service']);
  });

  it('offers no mapping of a value the read gave no allowed value for', () => {
    expect(offeredDecisions({ ...REFUSED, detail: {} })).not.toContain('map_value');
  });
});

describe('each decision, written and taken back', () => {
  it('maps a refused value for the gap’s record type', () => {
    const config = withGapDecision(CONFIG, REFUSED, { kind: 'map_value', to: 'General' });

    expect(config.picklistValueMappings).toEqual([
      { object: 'Case', field: 'Reason__c', recordType: 'Claim', from: 'Other', to: 'General' },
    ]);
    expect(choiceOf(decisionOf(config, REFUSED)!)).toEqual({ kind: 'map_value', to: 'General' });
    expect(withoutGapDecision(config, REFUSED)).toEqual(CONFIG);
  });

  it('leaves a value empty with a mapping to nothing, and a whole field by excluding it', () => {
    const value = withGapDecision(CONFIG, REFUSED, { kind: 'leave_empty' });
    expect(value.picklistValueMappings?.[0].to).toBeNull();
    expect(value.fieldExclusions).toBeUndefined();

    const field = withGapDecision(CONFIG, RULE, { kind: 'leave_empty' });
    expect(field.fieldExclusions).toEqual({ Contact: ['Phone'] });
    expect(field.picklistValueMappings).toBeUndefined();
    expect(choiceOf(decisionOf(field, RULE)!)).toEqual({ kind: 'leave_empty' });
    expect(withoutGapDecision(field, RULE)).toEqual(CONFIG);
  });

  it('gives a required field a default value', () => {
    const config = withGapDecision(CONFIG, REQUIRED, { kind: 'set_default', value: 'EMEA' });

    expect(config.defaultValues).toEqual([
      { object: 'Account', field: 'Region__c', value: 'EMEA' },
    ]);
    expect(withoutGapDecision(config, REQUIRED)).toEqual(CONFIG);
  });

  it('cuts a text to the field', () => {
    const config = withGapDecision(CONFIG, TOO_LONG, { kind: 'truncate' });

    expect(config.truncateFields).toEqual([{ object: 'Contact', field: 'Description' }]);
    expect(withoutGapDecision(config, TOO_LONG)).toEqual(CONFIG);
  });

  it('maps a record type to a target one, or to the object’s default', () => {
    const mapped = withGapDecision(CONFIG, UNMAPPED, { kind: 'map_record_type', to: 'Claim' });
    expect(mapped.recordTypeMappings).toEqual([{ object: 'Case', from: 'Old_RT', to: 'Claim' }]);

    const byDefault = withGapDecision(mapped, UNMAPPED, { kind: 'map_record_type', to: null });
    expect(byDefault.recordTypeMappings).toEqual([{ object: 'Case', from: 'Old_RT', to: null }]);
    expect(withoutGapDecision(byDefault, UNMAPPED)).toEqual(CONFIG);
  });

  it('leaves the object out, and ignores a gap by its id', () => {
    const excluded = withGapDecision(CONFIG, REQUIRED, { kind: 'exclude_object' });
    expect(excluded.excludedObjects).toEqual(['Account']);
    expect(withoutGapDecision(excluded, REQUIRED)).toEqual(CONFIG);

    const ignored = withGapDecision(CONFIG, RULE, { kind: 'ignore' });
    expect(ignored.ignoredGaps).toEqual([RULE.id]);
    expect(withoutGapDecision(ignored, RULE)).toEqual(CONFIG);
  });

  it('replaces the decision that answered the gap rather than adding a second', () => {
    const first = withGapDecision(CONFIG, REFUSED, { kind: 'map_value', to: 'General' });
    const second = withGapDecision(first, REFUSED, { kind: 'leave_empty' });

    expect(second.picklistValueMappings).toEqual([
      { object: 'Case', field: 'Reason__c', recordType: 'Claim', from: 'Other', to: null },
    ]);
  });

  it('writes nothing a gap cannot carry', () => {
    expect(withGapDecision(CONFIG, REQUIRED, { kind: 'map_value', to: 'X' })).toBe(CONFIG);
    expect(withGapDecision(CONFIG, REQUIRED, { kind: 'map_record_type', to: 'X' })).toBe(CONFIG);
  });
});

describe('decisionOf', () => {
  it('reads a mapping for every record type as answering the gap of one of them', () => {
    const config: ForgeConfig = {
      ...CONFIG,
      picklistValueMappings: [{ object: 'Case', field: 'Reason__c', from: 'Other', to: 'General' }],
    };

    expect(choiceOf(decisionOf(config, REFUSED)!)).toEqual({ kind: 'map_value', to: 'General' });
  });

  it('does not read a default value as answering a gap that offers none', () => {
    const config: ForgeConfig = {
      ...CONFIG,
      defaultValues: [{ object: 'Contact', field: 'Phone', value: '0' }],
    };

    expect(decisionOf(config, RULE)).toBeNull();
  });
});

describe('the decisions that answer no gap', () => {
  it('lists those a template brought for gaps no read has found, apart from those answering one', () => {
    const config: ForgeConfig = withGapDecision(
      {
        ...CONFIG,
        truncateFields: [{ object: 'Lead', field: 'Description' }],
        ignoredGaps: ['validation_rule|Lead|||Lead_Rule'],
      },
      REFUSED,
      { kind: 'map_value', to: 'Billing' },
    );

    expect(keptDecisions(config)).toHaveLength(3);
    expect(decisionsAnsweringNoGap(config, [REFUSED])).toEqual([
      { kind: 'truncate', entry: { object: 'Lead', field: 'Description' } },
      { kind: 'ignored', gapId: 'validation_rule|Lead|||Lead_Rule' },
    ]);
  });
});

describe('the gaps shown and the badge', () => {
  const graph: ForgeGraph = {
    nodes: [
      { objectApiName: 'Case', included: true },
      { objectApiName: 'Account', included: false, leftOutByUser: true },
      { objectApiName: 'Contact', included: true },
    ].map((node) => ({
      recordCount: 1,
      fieldCount: 1,
      status: 'idle' as const,
      progress: 0,
      piiFields: [],
      anonymizeFields: [],
      level: 0,
      successCount: 0,
      failureCount: 0,
      errors: [],
      createableFieldCount: 1,
      estimatedSizeMB: 0,
      estimatedApiCalls: 0,
      batchStrategy: 'auto' as const,
      ...node,
    })),
    edges: [],
    totalRecords: 3,
    estimatedSizeMB: 0,
    estimatedDurationSeconds: 0,
  };

  it('hides the gaps of an object the run leaves out, by its box or by its config', () => {
    const gaps = { metadata: [REQUIRED, RULE], simulation: [REFUSED, UNMAPPED] };

    expect(gapsToShow(gaps, objectsLeftOut(CONFIG, graph)).map((g) => g.objectApiName)).toEqual([
      'Case',
      'Case',
      'Contact',
    ]);
    expect(
      gapsToShow(gaps, objectsLeftOut({ ...CONFIG, excludedObjects: ['Case'] }, graph)).map(
        (g) => g.id,
      ),
    ).toEqual([RULE.id]);
  });

  it('counts the blocking gaps of the objects written that no decision answers', () => {
    const gaps = { metadata: [REQUIRED], simulation: [REFUSED, UNMAPPED, TOO_LONG] };

    expect(undecidedBlockingGaps(gaps, CONFIG)).toBe(3);
    expect(undecidedBlockingGaps(gaps, CONFIG, graph)).toBe(2);
    const decided = withGapDecision(CONFIG, REFUSED, { kind: 'ignore' });
    expect(undecidedBlockingGaps(gaps, decided, graph)).toBe(1);
    expect(undecidedBlockingGaps(undefined, null)).toBe(0);
  });
});
