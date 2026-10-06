import { describe, it, expect, vi } from 'vitest';
import type { ForgeGraph, ForgeGraphNode } from '@sandforge/shared';
import { ForgeExecutor } from './ForgeExecutor.js';
import type {
  FieldInfo,
  ForgeExecutorDeps,
  ForgeProgressEvent,
  InsertResult,
} from './ForgeExecutor.js';
import { toSaveOutcome } from '../../core/common/existingRecordMatch.js';
import type { ForgeBatchStrategy, ResolvedBatchStrategy } from './ForgeBatchStrategy.js';
import { forgeRunResult } from './runResult.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const RULE = 'Enter the phone in international format';
const REASON = `FIELD_CUSTOM_VALIDATION_EXCEPTION: ${RULE}`;

function node(objectApiName: string, level: number): ForgeGraphNode {
  return {
    objectApiName,
    recordCount: 1,
    fieldCount: 3,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 0,
    estimatedSizeMB: 0,
    estimatedApiCalls: 0,
    batchStrategy: 'auto',
  };
}

const GRAPH: ForgeGraph = {
  nodes: [node('Contact', 0), node('Case', 1)],
  edges: [
    { sourceObject: 'Contact', targetObject: 'Case', relationshipName: 'Cases', type: 'lookup' },
  ],
  totalRecords: 2,
  estimatedSizeMB: 0,
  estimatedDurationSeconds: 0,
};

const FIELDS: Record<string, FieldInfo[]> = {
  Contact: [
    { name: 'Id', queryable: true, createable: false, isReference: false },
    { name: 'LastName', queryable: true, createable: true, isReference: false },
    { name: 'Phone', queryable: true, createable: true, isReference: false, type: 'phone' },
  ],
  Case: [
    { name: 'Id', queryable: true, createable: false, isReference: false },
    { name: 'Subject', queryable: true, createable: true, isReference: false },
    {
      name: 'ContactId',
      queryable: true,
      createable: true,
      isReference: true,
      referenceTo: ['Contact'],
      nillable: true,
    },
  ],
};

/** The rule's refusal of the phone, as the writers read it from the platform. */
const refusedOnThePhone = (): InsertResult =>
  toSaveOutcome(
    {
      success: false,
      errors: [
        { statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: RULE, fields: ['Phone'] },
      ],
    },
    'Contact',
  );

/**
 * Deps reading one contact and its case, counting one request per call, and
 * answering each insert of the contact with `contactAnswers`, in turn.
 */
function deps(contactAnswers: InsertResult[][]): ForgeExecutorDeps & {
  inserts: Array<[string, Record<string, unknown>[]]>;
} {
  let sent = 0;
  const inserts: Array<[string, Record<string, unknown>[]]> = [];
  const answers = [...contactAnswers];
  return {
    inserts,
    requestsSent: () => sent,
    describeFields: async (_org, objectName) => {
      sent++;
      return FIELDS[objectName] ?? [];
    },
    queryRecords: async (org, soql) => {
      sent++;
      if (org !== 'src') return [];
      if (soql.includes('FROM Contact')) {
        return [{ Id: '003OLD1', LastName: 'Doe', Phone: '555-0100' }];
      }
      if (soql.includes('FROM Case')) {
        return [{ Id: '500OLD1', Subject: 'Help', ContactId: '003OLD1' }];
      }
      return [];
    },
    insertRecords: async (_org, objectName, records) => {
      sent++;
      inserts.push([objectName, records.map((r) => ({ ...r }))]);
      if (objectName === 'Contact') return answers.shift() ?? [];
      return records.map((_, i) => ({ id: `500NEW${i + 1}`, success: true, errors: [] }));
    },
  };
}

/*
 * A contact a validation rule of the target refused on its phone, and the case
 * hanging from it. Run for real, the contact was refused, and what hung from it
 * failed or was skipped for want of it.
 */
describe('ForgeExecutor — a row a validation rule refused on a field it named', () => {
  it('writes the contact again without its phone, and the case under it finds it', async () => {
    const d = deps([[refusedOnThePhone()], [{ id: '003NEW1', success: true, errors: [] }]]);
    const events: ForgeProgressEvent[] = [];

    const summary = await new ForgeExecutor(d).execute(GRAPH, 'src', 'tgt', (e) => events.push(e));

    expect(d.inserts).toEqual([
      ['Contact', [{ LastName: 'Doe', Phone: '555-0100' }]],
      ['Contact', [{ LastName: 'Doe' }]],
      ['Case', [{ Subject: 'Help', ContactId: '003NEW1' }]],
    ]);
    expect(summary).toMatchObject({ successCount: 2, failedCount: 0, errors: [] });
    expect(summary.remapTable).toEqual({ '003OLD1': '003NEW1', '500OLD1': '500NEW1' });
    expect(summary.writtenWithoutFields).toEqual([
      {
        objectApiName: 'Contact',
        rows: 1,
        fields: [{ field: 'Phone', refusedBy: 'validation-rule', reason: REASON, rows: 1 }],
      },
    ]);
    // The object's line says which field the row went without, and why.
    expect(events.find((e) => e.objectName === 'Contact' && e.status === 'done')?.message).toBe(
      `Completed Contact: 1 succeeded, 0 failed, 1 written without Phone: ` +
        `a validation rule of the target refused it, ${REASON}`,
    );
    // The call that wrote it again is one of the run's calls.
    expect(summary.apiCalls).toBe(d.requestsSent?.());
    expect(d.inserts).toHaveLength(3);
  });

  it('keeps the field left out in the result the run is recorded under', async () => {
    const d = deps([[refusedOnThePhone()], [{ id: '003NEW1', success: true, errors: [] }]]);

    const summary = await new ForgeExecutor(d).execute(GRAPH, 'src', 'tgt', () => undefined);
    const result = forgeRunResult(summary, GRAPH, { startedAt: Date.now(), status: 'success' });

    expect(result.writtenWithoutFields).toEqual(summary.writtenWithoutFields);
  });

  it('fails the contact refused again with the second refusal, the case going in without it', async () => {
    const refusedAgain = toSaveOutcome(
      {
        success: false,
        errors: [
          {
            statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
            message: 'Give a phone or an email',
            fields: [],
          },
        ],
      },
      'Contact',
    );
    const d = deps([[refusedOnThePhone()], [refusedAgain]]);

    const summary = await new ForgeExecutor(d).execute(GRAPH, 'src', 'tgt', () => undefined);

    expect(summary.remapTable['003OLD1']).toBeUndefined();
    expect(summary.writtenWithoutFields).toBeUndefined();
    expect(summary.errors.find((e) => e.objectApiName === 'Contact')).toMatchObject({
      stage: 'insert',
      failedCount: 1,
      attemptedCount: 1,
      samples: [
        {
          recordSummary: 'LastName=Doe Phone=555-0100',
          messages: [
            'FIELD_CUSTOM_VALIDATION_EXCEPTION: Give a phone or an email',
            `Sent again without Phone after the first refusal: ${REASON} [Phone]`,
            'A validation rule of the target, or a trigger with its code, refused the row without ' +
              'naming a field: there was none to send it again without.',
          ],
        },
      ],
    });
    // Two calls for the contact, never a third; the case's lookup at it left empty.
    expect(d.inserts).toEqual([
      ['Contact', [{ LastName: 'Doe', Phone: '555-0100' }]],
      ['Contact', [{ LastName: 'Doe' }]],
      ['Case', [{ Subject: 'Help' }]],
    ]);
  });

  it('says the field left out on the line of an object that mostly failed', async () => {
    const d = deps([
      [
        refusedOnThePhone(),
        {
          id: '',
          success: false,
          errors: ['INVALID_CROSS_REFERENCE_KEY: invalid cross reference id'],
        },
        {
          id: '',
          success: false,
          errors: ['INVALID_CROSS_REFERENCE_KEY: invalid cross reference id'],
        },
      ],
      [{ id: '003NEW1', success: true, errors: [] }],
    ]);
    const contacts = [1, 2, 3].map((i) => ({
      Id: `003OLD${i}`,
      LastName: `L${i}`,
      Phone: '555-0100',
    }));
    const reading: ForgeExecutorDeps = {
      ...d,
      queryRecords: async (org, soql, onTruncated) =>
        org === 'src' && soql.includes('FROM Contact')
          ? contacts.map((c) => ({ ...c }))
          : d.queryRecords(org, soql, onTruncated),
    };
    const events: ForgeProgressEvent[] = [];

    await new ForgeExecutor(reading).execute(GRAPH, 'src', 'tgt', (e) => events.push(e));

    expect(events.find((e) => e.objectName === 'Contact' && e.status === 'error')?.message).toBe(
      `2/3 Contact records failed (>50%), 1 written without Phone: a validation rule of the ` +
        `target refused it, ${REASON} — objects that cannot be written without it will be skipped`,
    );
  });

  it('says the field left out on the line of an object a cancel stopped, and counts the row it kept from its second call', async () => {
    const oneByOne: ForgeBatchStrategy = {
      resolve: (): ResolvedBatchStrategy => ({ api: 'rest', batchSize: 1, batchCount: 2 }),
    };
    const d = deps([
      [refusedOnThePhone()],
      [refusedOnThePhone()],
      [{ id: '003NEW1', success: true, errors: [] }],
    ]);
    const contacts = [1, 2].map((i) => ({
      Id: `003OLD${i}`,
      LastName: `L${i}`,
      Phone: '555-0100',
    }));
    const events: ForgeProgressEvent[] = [];
    let contactCalls = 0;
    const executor: ForgeExecutor = new ForgeExecutor({
      ...d,
      batchStrategy: oneByOne,
      queryRecords: async (org, soql, onTruncated) =>
        org === 'src' && soql.includes('FROM Contact')
          ? contacts.map((c) => ({ ...c }))
          : d.queryRecords(org, soql, onTruncated),
      insertRecords: async (org, objectName, records) => {
        const answer = await d.insertRecords(org, objectName, records);
        // The cancel comes once the first row went in again, before the second.
        if (objectName === 'Contact' && ++contactCalls === 3) executor.abort();
        return answer;
      },
    });

    const stopped = await executor
      .execute(GRAPH, 'src', 'tgt', (e) => events.push(e))
      .catch((err: unknown) => err);

    expect(stopped).toBeInstanceOf(Error);
    expect(events.find((e) => e.objectName === 'Contact' && e.status === 'stopped')?.message).toBe(
      `Stopped Contact: 1 succeeded, 1 failed, 0 not sent, 1 written without Phone: ` +
        `a validation rule of the target refused it, ${REASON}`,
    );
  });

  it('leaves a contact the rule refused without naming a field failed, sent once', async () => {
    const unnamed = toSaveOutcome(
      {
        success: false,
        errors: [{ statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: RULE, fields: [] }],
      },
      'Contact',
    );
    const d = deps([[unnamed]]);
    const events: ForgeProgressEvent[] = [];

    const summary = await new ForgeExecutor(d).execute(GRAPH, 'src', 'tgt', (e) => events.push(e));

    expect(d.inserts.map(([objectName]) => objectName)).toEqual(['Contact', 'Case']);
    expect(summary.remapTable['003OLD1']).toBeUndefined();
    expect(summary.writtenWithoutFields).toBeUndefined();
    expect(events.some((e) => e.message.includes('written without'))).toBe(false);
  });
});

/*
 * Rows of a custom object whose record type in the target was never given
 * values of a restricted picklist: it takes none of them, while the UI API
 * answers the field's every value for it, so the check before the write lets
 * "Yes" through. Run for real between two orgs, the target refused every row
 * of the object so, and what hung from them failed with them.
 */
describe('ForgeExecutor — a row a restricted picklist refused for its value', () => {
  /** The record type of the rows in the source, and the one the mapping gives them in the target. */
  const SOURCE_TYPE = '012SR0000000001AAA';
  const TARGET_TYPE = '012TG0000000001AAA';
  const BAD_YES = 'bad value for restricted picklist field: Yes';
  const PICKLIST_REASON = `INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: ${BAD_YES}`;

  const VISIT_GRAPH: ForgeGraph = {
    nodes: [node('Visit__c', 0)],
    edges: [],
    totalRecords: 2,
    estimatedSizeMB: 0,
    estimatedDurationSeconds: 0,
  };

  const VISIT_FIELDS: FieldInfo[] = [
    { name: 'Id', queryable: true, createable: false, isReference: false },
    { name: 'Name', queryable: true, createable: true, isReference: false },
    {
      name: 'RecordTypeId',
      queryable: true,
      createable: true,
      isReference: true,
      referenceTo: ['RecordType'],
    },
    {
      name: 'Rating__c',
      queryable: true,
      createable: true,
      isReference: false,
      type: 'picklist',
      restrictedPicklist: true,
      picklistValues: ['Yes', 'No'],
    },
  ];

  /** One row to a call: what the first call learns reaches the second. */
  const oneByOne: ForgeBatchStrategy = {
    resolve: (): ResolvedBatchStrategy => ({ api: 'rest', batchSize: 1, batchCount: 2 }),
  };

  /** Deps reading two rows, the UI API answering both values, the target refusing "Yes". */
  function visitDeps(): ForgeExecutorDeps & {
    inserts: Record<string, unknown>[][];
    uiApiReads: Array<[string, string, string]>;
  } {
    const inserts: Record<string, unknown>[][] = [];
    const uiApiReads: Array<[string, string, string]> = [];
    let next = 0;
    return {
      inserts,
      uiApiReads,
      batchStrategy: oneByOne,
      describeFields: async () => VISIT_FIELDS,
      queryRecords: async (org, soql) =>
        org === 'src' && soql.includes('FROM Visit__c')
          ? [1, 2].map((i) => ({
              Id: `a01OLD${i}`,
              Name: `V${i}`,
              RecordTypeId: SOURCE_TYPE,
              Rating__c: 'Yes',
            }))
          : [],
      recordTypePicklists: async (org, object, recordTypeId) => {
        uiApiReads.push([org, object, recordTypeId]);
        return new Map([['Rating__c', { values: ['Yes', 'No'], defaultValue: null }]]);
      },
      insertRecords: async (_org, _object, records) => {
        inserts.push(records.map((r) => ({ ...r })));
        return records.map((r) =>
          r['Rating__c'] === 'Yes'
            ? toSaveOutcome(
                {
                  success: false,
                  errors: [
                    {
                      statusCode: 'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST',
                      message: BAD_YES,
                      fields: ['Rating__c'],
                    },
                  ],
                },
                'Visit__c',
              )
            : { id: `a01NEW${++next}`, success: true, errors: [] },
        );
      },
    };
  }

  it('writes the rows without the field, the second without it from its first call, and says what refused it', async () => {
    const d = visitDeps();
    const events: ForgeProgressEvent[] = [];

    const summary = await new ForgeExecutor(d).execute(
      VISIT_GRAPH,
      'src',
      'tgt',
      (e) => events.push(e),
      {
        recordTypeMappings: [
          { sourceId: SOURCE_TYPE, targetId: TARGET_TYPE, developerName: 'Visit' },
        ],
      },
    );

    // The check read the record type's values, and kept "Yes" by them.
    expect(d.uiApiReads).toEqual([['tgt', 'Visit__c', TARGET_TYPE]]);
    expect(summary.picklistValuesChanged).toBeUndefined();
    expect(d.inserts).toEqual([
      [{ Name: 'V1', RecordTypeId: TARGET_TYPE, Rating__c: 'Yes' }],
      [{ Name: 'V2', RecordTypeId: TARGET_TYPE }],
      [{ Name: 'V1', RecordTypeId: TARGET_TYPE }],
    ]);
    expect(summary).toMatchObject({ successCount: 2, failedCount: 0, errors: [] });
    expect(summary.writtenWithoutFields).toEqual([
      {
        objectApiName: 'Visit__c',
        rows: 2,
        fields: [
          {
            field: 'Rating__c',
            refusedBy: 'restricted-picklist',
            reason: PICKLIST_REASON,
            rows: 2,
          },
        ],
      },
    ]);
    expect(events.find((e) => e.objectName === 'Visit__c' && e.status === 'done')?.message).toBe(
      'Completed Visit__c: 2 succeeded, 0 failed, 2 written without Rating__c: a restricted ' +
        `picklist of the target refused its value, ${PICKLIST_REASON}`,
    );
  });
});
