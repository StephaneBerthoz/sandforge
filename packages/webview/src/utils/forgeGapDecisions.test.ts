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
  it('offers what the config can hold, the holding back of the rows of a value included', () => {
    expect(offeredDecisions(REFUSED)).toEqual([
      'map_value',
      'leave_empty',
      'exclude_object',
      'skip_rows',
      'ignore',
    ]);
  });

  it('offers no holding back of rows on a gap about no value, whatever the read offers', () => {
    expect(offeredDecisions({ ...RULE, decisions: ['skip_rows', 'ignore'] })).toEqual(['ignore']);
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
    const config = withGapDecision(CONFIG, REFUSED, { kind: 'map_value', to: 'General' }, [
      REFUSED,
    ]);

    expect(config.picklistValueMappings).toEqual([
      { object: 'Case', field: 'Reason__c', recordType: 'Claim', from: 'Other', to: 'General' },
    ]);
    expect(choiceOf(decisionOf(config, REFUSED, [REFUSED])!)).toEqual({
      kind: 'map_value',
      to: 'General',
    });
    expect(withoutGapDecision(config, REFUSED, [REFUSED])).toEqual(CONFIG);
  });

  it('leaves a value empty with a mapping to nothing, and a whole field by excluding it', () => {
    const value = withGapDecision(CONFIG, REFUSED, { kind: 'leave_empty' }, [REFUSED]);
    expect(value.picklistValueMappings?.[0].to).toBeNull();
    expect(value.fieldExclusions).toBeUndefined();

    const field = withGapDecision(CONFIG, RULE, { kind: 'leave_empty' }, [RULE]);
    expect(field.fieldExclusions).toEqual({ Contact: ['Phone'] });
    expect(field.picklistValueMappings).toBeUndefined();
    expect(choiceOf(decisionOf(field, RULE, [RULE])!)).toEqual({ kind: 'leave_empty' });
    expect(withoutGapDecision(field, RULE, [RULE])).toEqual(CONFIG);
  });

  it('gives a required field a default value', () => {
    const config = withGapDecision(CONFIG, REQUIRED, { kind: 'set_default', value: 'EMEA' }, [
      REQUIRED,
    ]);

    expect(config.defaultValues).toEqual([
      { object: 'Account', field: 'Region__c', value: 'EMEA' },
    ]);
    expect(withoutGapDecision(config, REQUIRED, [REQUIRED])).toEqual(CONFIG);
  });

  it('cuts a text to the field', () => {
    const config = withGapDecision(CONFIG, TOO_LONG, { kind: 'truncate' }, [TOO_LONG]);

    expect(config.truncateFields).toEqual([{ object: 'Contact', field: 'Description' }]);
    expect(withoutGapDecision(config, TOO_LONG, [TOO_LONG])).toEqual(CONFIG);
  });

  it('maps a record type to a target one, or to the object’s default', () => {
    const mapped = withGapDecision(CONFIG, UNMAPPED, { kind: 'map_record_type', to: 'Claim' }, [
      UNMAPPED,
    ]);
    expect(mapped.recordTypeMappings).toEqual([{ object: 'Case', from: 'Old_RT', to: 'Claim' }]);

    const byDefault = withGapDecision(mapped, UNMAPPED, { kind: 'map_record_type', to: null }, [
      UNMAPPED,
    ]);
    expect(byDefault.recordTypeMappings).toEqual([{ object: 'Case', from: 'Old_RT', to: null }]);
    expect(withoutGapDecision(byDefault, UNMAPPED, [UNMAPPED])).toEqual(CONFIG);
  });

  it('leaves the object out, and ignores a gap by its id', () => {
    const excluded = withGapDecision(CONFIG, REQUIRED, { kind: 'exclude_object' }, [REQUIRED]);
    expect(excluded.excludedObjects).toEqual(['Account']);
    expect(withoutGapDecision(excluded, REQUIRED, [REQUIRED])).toEqual(CONFIG);

    const ignored = withGapDecision(CONFIG, RULE, { kind: 'ignore' }, [RULE]);
    expect(ignored.ignoredGaps).toEqual([RULE.id]);
    expect(withoutGapDecision(ignored, RULE, [RULE])).toEqual(CONFIG);

    // A template keeps the id a gap of a package's record type had before its
    // namespace: the gap reads answered, and Undo takes that entry out.
    const packaged = { ...RULE, id: 'record_type_unavailable|Case||ns__Support|' };
    const kept = { ...CONFIG, ignoredGaps: ['record_type_unavailable|Case||Support|'] };
    expect(decisionOf(kept, packaged, [packaged])).toEqual({
      kind: 'ignored',
      gapId: 'record_type_unavailable|Case||Support|',
    });
    expect(decisionsAnsweringNoGap(kept, [packaged])).toEqual([]);
  });

  it('reads a gap of a package’s record type as decided by what a template kept before its namespace, and Undo takes that out', () => {
    const packaged: ForgeGap = {
      ...REFUSED,
      id: forgeGapId('picklist_value_refused', 'Case', 'Status', 'ns__Support', 'Open'),
      field: 'Status',
      value: 'Open',
      recordType: 'ns__Support',
      decisions: ['map_value', 'leave_empty', 'skip_rows'],
    };
    const before = forgeGapId('picklist_value_refused', 'Case', 'Status', 'Support', 'Open');
    const skipped = { ...CONFIG, skippedRows: [{ object: 'Case', gapId: before }] };
    const mapped = {
      ...CONFIG,
      picklistValueMappings: [
        { object: 'Case', field: 'Status', recordType: 'Support', from: 'Open', to: 'New' },
      ],
    };

    expect(choiceOf(decisionOf(skipped, packaged, [packaged])!)).toEqual({ kind: 'skip_rows' });
    expect(withoutGapDecision(skipped, packaged, [packaged])).toEqual(CONFIG);
    expect(choiceOf(decisionOf(mapped, packaged, [packaged])!)).toEqual({
      kind: 'map_value',
      to: 'New',
    });
    expect(withoutGapDecision(mapped, packaged, [packaged])).toEqual(CONFIG);
  });

  describe('a target with the org’s own record type and a package’s of the same DeveloperName', () => {
    // Each closed to the user the run writes as: two blocking gaps in one read.
    const closed = (recordType: string): ForgeGap => ({
      id: forgeGapId('record_type_unavailable', 'Case', 'RecordTypeId', recordType),
      kind: 'record_type_unavailable',
      severity: 'blocking',
      source: 'simulation',
      objectApiName: 'Case',
      field: 'RecordTypeId',
      recordType,
      rows: 2,
      detail: { mapTo: ['General'] },
      decisions: ['map_record_type', 'exclude_object', 'ignore'],
    });
    const own = closed('Support');
    const packaged = closed('ns__Support');
    const read = [own, packaged];

    it('leaves the package’s gap undecided, counted and asked about, when only the org’s own was ignored', () => {
      const config = withGapDecision(CONFIG, own, { kind: 'ignore' }, read);

      expect(decisionOf(config, own, read)).toEqual({ kind: 'ignored', gapId: own.id });
      expect(decisionOf(config, packaged, read)).toBeNull();
      expect(undecidedBlockingGaps({ simulation: read }, config)).toBe(1);
    });

    it('keeps the org’s own decision when one is taken on the package’s gap, and takes back only the package’s', () => {
      const ownIgnored = withGapDecision(CONFIG, own, { kind: 'ignore' }, read);
      const both = withGapDecision(
        ownIgnored,
        packaged,
        { kind: 'map_record_type', to: 'General' },
        read,
      );

      expect(both.ignoredGaps).toEqual([own.id]);
      expect(both.recordTypeMappings).toEqual([
        { object: 'Case', from: 'ns__Support', to: 'General' },
      ]);
      expect(withoutGapDecision(both, packaged, read)).toEqual(ownIgnored);
      expect(undecidedBlockingGaps({ simulation: read }, both)).toBe(0);
    });

    it('reads a hold-back of the org’s own rows as answering not the package’s gap of the same value', () => {
      const value = (recordType: string): ForgeGap => ({
        ...REFUSED,
        id: forgeGapId('picklist_value_refused', 'Case', 'Status', recordType, 'Open'),
        field: 'Status',
        value: 'Open',
        recordType,
        decisions: ['map_value', 'leave_empty', 'skip_rows'],
      });
      const values = [value('Support'), value('ns__Support')];
      const config = withGapDecision(CONFIG, values[0]!, { kind: 'skip_rows' }, values);

      expect(choiceOf(decisionOf(config, values[0]!, values)!)).toEqual({ kind: 'skip_rows' });
      expect(decisionOf(config, values[1]!, values)).toBeNull();
    });

    it('reads a mapping of the org’s own value as answering not the package’s gap, and keeps it when the package’s is mapped', () => {
      // The run maps the org's own rows alone: the package's gap read
      // "written as New" and Execute no longer asked, and mapping it took the
      // org's own mapping away.
      const value = (recordType: string): ForgeGap => ({
        ...REFUSED,
        id: forgeGapId('picklist_value_refused', 'Case', 'Status', recordType, 'Open'),
        field: 'Status',
        value: 'Open',
        recordType,
        decisions: ['map_value', 'leave_empty', 'skip_rows'],
      });
      const [ownValue, packagedValue] = [value('Support'), value('ns__Support')];
      const values = [ownValue, packagedValue];
      const ownMapped = withGapDecision(CONFIG, ownValue, { kind: 'map_value', to: 'New' }, values);

      expect(choiceOf(decisionOf(ownMapped, ownValue, values)!)).toEqual({
        kind: 'map_value',
        to: 'New',
      });
      expect(decisionOf(ownMapped, packagedValue, values)).toBeNull();
      expect(undecidedBlockingGaps({ simulation: values }, ownMapped)).toBe(1);

      const both = withGapDecision(
        ownMapped,
        packagedValue,
        { kind: 'map_value', to: 'Closed' },
        values,
      );
      expect(both.picklistValueMappings).toEqual([
        { object: 'Case', field: 'Status', recordType: 'Support', from: 'Open', to: 'New' },
        { object: 'Case', field: 'Status', recordType: 'ns__Support', from: 'Open', to: 'Closed' },
      ]);
      expect(withoutGapDecision(both, packagedValue, values)).toEqual(ownMapped);
    });
  });

  it('reads an unmapped record type of a package as ignored by the id a template kept before its namespace', () => {
    const unmapped: ForgeGap = {
      id: forgeGapId('record_type_unmapped', 'Account', 'RecordTypeId', undefined, 'ns__Retail'),
      kind: 'record_type_unmapped',
      severity: 'blocking',
      source: 'simulation',
      objectApiName: 'Account',
      field: 'RecordTypeId',
      value: 'ns__Retail',
      rows: 1,
      detail: { mapTo: ['Other'] },
      decisions: ['map_record_type', 'exclude_object', 'ignore'],
    };
    const old = forgeGapId('record_type_unmapped', 'Account', 'RecordTypeId', undefined, 'Retail');
    const kept = { ...CONFIG, ignoredGaps: [old] };

    expect(decisionOf(kept, unmapped, [unmapped])).toEqual({ kind: 'ignored', gapId: old });
    expect(undecidedBlockingGaps({ simulation: [unmapped] }, kept)).toBe(0);
    expect(decisionsAnsweringNoGap(kept, [unmapped])).toEqual([]);
    expect(withoutGapDecision(kept, unmapped, [unmapped])).toEqual(CONFIG);
  });

  describe('a package’s gap whose record type’s name the org’s own carries too, with no gap of its own', () => {
    // The simulation says beside the package's gap which record types of
    // its org carry its DeveloperName too. Kept before namespaces under the
    // bare name, a decision is the org's own's, as the run applies it: the
    // package's gap read "left as it is", "held back" or "written as", and
    // Execute no longer asked, while its rows went as read and the target
    // refused them.
    const unmapped: ForgeGap = {
      id: forgeGapId('record_type_unmapped', 'Account', 'RecordTypeId', undefined, 'ns__Retail'),
      kind: 'record_type_unmapped',
      severity: 'blocking',
      source: 'simulation',
      objectApiName: 'Account',
      field: 'RecordTypeId',
      value: 'ns__Retail',
      rows: 1,
      detail: { mapTo: ['Retail', 'Other'], sameDeveloperName: ['Retail'] },
      decisions: ['map_record_type', 'exclude_object', 'ignore'],
    };
    const refused: ForgeGap = {
      ...REFUSED,
      id: forgeGapId('picklist_value_refused', 'Case', 'Status', 'ns__Support', 'Open'),
      field: 'Status',
      value: 'Open',
      recordType: 'ns__Support',
      detail: { allowedValues: ['New'], sameDeveloperName: ['Support'] },
      decisions: ['map_value', 'leave_empty', 'skip_rows'],
    };
    const ownOpen = forgeGapId('picklist_value_refused', 'Case', 'Status', 'Support', 'Open');

    it('asks again of an unmapped record type an ignore kept under the bare name', () => {
      const old = forgeGapId(
        'record_type_unmapped',
        'Account',
        'RecordTypeId',
        undefined,
        'Retail',
      );
      const kept = { ...CONFIG, ignoredGaps: [old] };

      expect(decisionOf(kept, unmapped, [unmapped])).toBeNull();
      expect(undecidedBlockingGaps({ simulation: [unmapped] }, kept)).toBe(1);
      expect(decisionsAnsweringNoGap(kept, [unmapped])).toEqual([{ kind: 'ignored', gapId: old }]);
    });

    it('asks again of a refused value a hold-back, a mapping or an ignore kept under the bare name', () => {
      const kept: ForgeConfig[] = [
        { ...CONFIG, skippedRows: [{ object: 'Case', gapId: ownOpen }] },
        {
          ...CONFIG,
          picklistValueMappings: [
            { object: 'Case', field: 'Status', recordType: 'Support', from: 'Open', to: 'New' },
          ],
        },
        { ...CONFIG, ignoredGaps: [ownOpen] },
      ];

      for (const config of kept) {
        expect(decisionOf(config, refused, [refused])).toBeNull();
        expect(undecidedBlockingGaps({ simulation: [refused] }, config)).toBe(1);
      }
    });

    it('reads a record type mapping kept under the bare name as the org’s own, as the run applies it', () => {
      // The run maps the source's own Retail by it, and the package's goes
      // unmapped: its gap stays to decide.
      const mapped = {
        ...CONFIG,
        recordTypeMappings: [{ object: 'Account', from: 'Retail', to: 'Other' }],
      };

      expect(decisionOf(mapped, unmapped, [unmapped])).toBeNull();
      expect(decisionsAnsweringNoGap(mapped, [unmapped])).toEqual([
        { kind: 'record_type', entry: { object: 'Account', from: 'Retail', to: 'Other' } },
      ]);
    });

    it('reads a decision taken on the package’s gap under its own name as answering it', () => {
      const config = withGapDecision(CONFIG, refused, { kind: 'skip_rows' }, [refused]);

      expect(config.skippedRows).toEqual([{ object: 'Case', gapId: refused.id }]);
      expect(choiceOf(decisionOf(config, refused, [refused])!)).toEqual({ kind: 'skip_rows' });
      expect(undecidedBlockingGaps({ simulation: [refused] }, config)).toBe(0);
    });
  });

  it('holds back the rows of a value by the gap’s id, and takes that back', () => {
    const config = withGapDecision(CONFIG, REFUSED, { kind: 'skip_rows' }, [REFUSED]);

    expect(config.skippedRows).toEqual([{ object: 'Case', gapId: REFUSED.id }]);
    expect(choiceOf(decisionOf(config, REFUSED, [REFUSED])!)).toEqual({ kind: 'skip_rows' });
    expect(keptDecisions(config)).toEqual([
      { kind: 'skipped_rows', entry: { object: 'Case', gapId: REFUSED.id } },
    ]);
    expect(withoutGapDecision(config, REFUSED, [REFUSED])).toEqual(CONFIG);
    // A gap about no value has no rows its value names.
    expect(withGapDecision(CONFIG, RULE, { kind: 'skip_rows' }, [RULE])).toBe(CONFIG);
  });

  it('replaces the decision that answered the gap rather than adding a second', () => {
    const first = withGapDecision(CONFIG, REFUSED, { kind: 'map_value', to: 'General' }, [REFUSED]);
    const second = withGapDecision(first, REFUSED, { kind: 'leave_empty' }, [REFUSED]);

    expect(second.picklistValueMappings).toEqual([
      { object: 'Case', field: 'Reason__c', recordType: 'Claim', from: 'Other', to: null },
    ]);
  });

  it('writes nothing a gap cannot carry', () => {
    expect(withGapDecision(CONFIG, REQUIRED, { kind: 'map_value', to: 'X' }, [REQUIRED])).toBe(
      CONFIG,
    );
    expect(
      withGapDecision(CONFIG, REQUIRED, { kind: 'map_record_type', to: 'X' }, [REQUIRED]),
    ).toBe(CONFIG);
  });
});

describe('decisionOf', () => {
  it('reads a mapping for every record type as answering the gap of one of them', () => {
    const config: ForgeConfig = {
      ...CONFIG,
      picklistValueMappings: [{ object: 'Case', field: 'Reason__c', from: 'Other', to: 'General' }],
    };

    expect(choiceOf(decisionOf(config, REFUSED, [REFUSED])!)).toEqual({
      kind: 'map_value',
      to: 'General',
    });
  });

  it('does not read a default value as answering a gap that offers none', () => {
    const config: ForgeConfig = {
      ...CONFIG,
      defaultValues: [{ object: 'Contact', field: 'Phone', value: '0' }],
    };

    expect(decisionOf(config, RULE, [RULE])).toBeNull();
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
      [REFUSED],
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
    const decided = withGapDecision(CONFIG, REFUSED, { kind: 'ignore' }, [REFUSED]);
    expect(undecidedBlockingGaps(gaps, decided, graph)).toBe(1);
    expect(undecidedBlockingGaps(undefined, null)).toBe(0);
  });
});
