import { describe, it, expect, expectTypeOf, vi, beforeEach } from 'vitest';
import * as z from 'zod';
import type {
  BaseMessage,
  CheckpointDeleteRequest,
  CheckpointExportRequest,
  CheckpointIgnoreFieldsRequest,
  CheckpointImportRequest,
  CheckpointKeepRequest,
  CheckpointListRequest,
  CheckpointPlanSelectionRequest,
  CheckpointPreviewRequest,
  CheckpointRenameRequest,
  CheckpointRewindRequest,
  CheckpointScopeRequest,
  CheckpointTakeRequest,
  CheckpointUndoRequest,
  PipelineRewindGrantRequest,
  PipelineRewindRevokeRequest,
  PipelineRewindStepsRequest,
} from '@sandforge/shared';
import { CSV_IMPORT_MAX_COLUMNS, CSV_IMPORT_MAX_ROWS } from '@sandforge/shared';
import type { HandlerDeps, InboundRequest } from './handlers/HandlerTypes.js';
import {
  validatePayload,
  orgIdSchema,
  sfApiNameSchema,
  whereClauseSchema,
  syncExecutePayloadSchema,
  seedExecutePayloadSchema,
  frozenConfigSavePayloadSchema,
  dataOpsBackupPayloadSchema,
  dataOpsRollbackPayloadSchema,
  dataOpsAnonymizePayloadSchema,
  anonymizationTemplateSavePayloadSchema,
  dataOpsQualityScanPayloadSchema,
  dataOpsSubjectSearchPayloadSchema,
  dataOpsSubjectErasePayloadSchema,
  dataOpsCleanupDeletePayloadSchema,
  monitorOpenApexJobsPayloadSchema,
  compareExecutePayloadSchema,
  pipelineApprovalPayloadSchema,
  pipelineRunPayloadSchema,
  savedPipelineSchema,
  seedCsvPayloadSchema,
  checkpointListPayloadSchema,
  checkpointScopePayloadSchema,
  checkpointTakePayloadSchema,
  checkpointPreviewPayloadSchema,
  checkpointRewindPayloadSchema,
  checkpointUndoPayloadSchema,
  checkpointDeletePayloadSchema,
  checkpointKeepPayloadSchema,
  checkpointRenamePayloadSchema,
  checkpointIgnoreFieldsPayloadSchema,
  checkpointPlanSelectionPayloadSchema,
  checkpointExportPayloadSchema,
  checkpointImportPayloadSchema,
  pipelineRewindStepsPayloadSchema,
  pipelineRewindGrantPayloadSchema,
  pipelineRewindRevokePayloadSchema,
} from './validatePayload.js';
import { inboundRequest } from '../test/mockFactories.js';

type MockDeps = Pick<HandlerDeps, 'log' | 'broker' | 'nextId'>;

function createMockDeps(): MockDeps & {
  postToWebview: ReturnType<typeof vi.fn>;
} {
  const postToWebview = vi.fn();
  let id = 0;
  return {
    log: vi.fn(),
    broker: { postToWebview } as unknown as MockDeps['broker'],
    nextId: () => String(++id),
    postToWebview,
  };
}

function makeMsg(type: string, payload: unknown): InboundRequest {
  return inboundRequest({
    id: 'msg-1',
    type,
    timestamp: Date.now(),
    payload,
  } as BaseMessage);
}

/** Minimal valid sync config as sent by the webview (org ids are SF 18-char ids). */
function validSyncConfig(): Record<string, unknown> {
  return {
    id: 'cfg-1',
    name: 'sync-from-ui',
    description: '',
    sourceOrgId: '00DXXXXXXXXXXXXXXX',
    targetOrgId: '00DYYYYYYYYYYYYYYY',
    direction: 'source_to_target',
    mode: 'full',
    objects: [
      {
        objectApiName: 'Account',
        operation: 'insert',
        externalIdField: 'Ext_Id__c',
        batchSize: 200,
        where: 'Name != null',
        fieldMappings: [],
        transformRules: [],
        excludedFields: [],
        addOnFields: [],
        insertOrder: 0,
      },
    ],
    conflictStrategy: 'source_wins',
    enableRollback: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/** Minimal valid seed template as sent by the webview. */
function validSeedTemplate(): Record<string, unknown> {
  return {
    id: 'tpl-1',
    name: 'seed-from-ui',
    description: '',
    version: 1,
    strategy: 'faker',
    objects: [
      {
        objectApiName: 'Contact',
        recordCount: 100,
        batchSize: 200,
        insertOrder: 0,
        excludedFields: [],
        fieldRules: [
          {
            fieldApiName: 'FirstName',
            ruleType: 'faker',
            config: { fakerMethod: 'person.firstName' },
          },
        ],
      },
    ],
    tags: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('validatePayload', () => {
  let deps: ReturnType<typeof createMockDeps>;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it('returns parsed data for a valid payload', () => {
    const schema = z.object({ orgId: orgIdSchema });
    const result = validatePayload(schema, makeMsg('x:y', { orgId: 'org-1' }), 'x:error', deps);
    expect(result).toEqual({ orgId: 'org-1' });
    expect(deps.postToWebview).not.toHaveBeenCalled();
  });

  it('returns null and posts INVALID_PAYLOAD error for an invalid payload', () => {
    const schema = z.object({ orgId: orgIdSchema });
    const result = validatePayload(schema, makeMsg('x:y', {}), 'x:error', deps);
    expect(result).toBeNull();
    expect(deps.postToWebview).toHaveBeenCalledTimes(1);
    const errMsg = deps.postToWebview.mock.calls[0][0] as {
      type: string;
      payload: { code: string; message: string };
    };
    expect(errMsg.type).toBe('x:error');
    expect(errMsg.payload.code).toBe('INVALID_PAYLOAD');
    expect(errMsg.payload.message).toContain('Invalid payload');
    expect(errMsg.payload.message).toContain('orgId');
  });

  it('returns null when payload is missing entirely', () => {
    const schema = z.object({ orgId: orgIdSchema });
    const msg: InboundRequest = inboundRequest({
      id: 'msg-1',
      type: 'x:y',
      timestamp: Date.now(),
    });
    expect(validatePayload(schema, msg, 'x:error', deps)).toBeNull();
    expect(deps.postToWebview).toHaveBeenCalledTimes(1);
  });

  it('caps the error summary at 3 issues', () => {
    const schema = z.object({
      a: z.string(),
      b: z.string(),
      c: z.string(),
      d: z.string(),
    });
    validatePayload(schema, makeMsg('x:y', {}), 'x:error', deps);
    const errMsg = deps.postToWebview.mock.calls[0][0] as {
      payload: { message: string };
    };
    expect(errMsg.payload.message.split(';').length).toBeLessThanOrEqual(3);
  });
});

describe('primitive schemas', () => {
  it('sfApiNameSchema accepts standard and custom API names', () => {
    expect(sfApiNameSchema.safeParse('Account').success).toBe(true);
    expect(sfApiNameSchema.safeParse('My_Object__c').success).toBe(true);
    expect(sfApiNameSchema.safeParse('Namespace__Obj__c').success).toBe(true);
  });

  it('sfApiNameSchema rejects injection-shaped names', () => {
    expect(sfApiNameSchema.safeParse('Account WHERE Id!=null').success).toBe(false);
    expect(sfApiNameSchema.safeParse("Account' OR '1'='1").success).toBe(false);
    expect(sfApiNameSchema.safeParse('1Object').success).toBe(false);
    expect(sfApiNameSchema.safeParse('').success).toBe(false);
  });

  it('whereClauseSchema accepts plain filters', () => {
    expect(whereClauseSchema.safeParse('Name != null AND CreatedDate > 2024-01-01').success).toBe(
      true,
    );
  });

  it('whereClauseSchema rejects subqueries and DML keywords', () => {
    expect(whereClauseSchema.safeParse('Id IN (SELECT AccountId FROM Contact)').success).toBe(
      false,
    );
    expect(whereClauseSchema.safeParse("Name = 'x' DELETE").success).toBe(false);
    expect(whereClauseSchema.safeParse('update me').success).toBe(false);
  });
});

describe('syncExecutePayloadSchema', () => {
  it('accepts the exact payload shape the webview sends', () => {
    const result = syncExecutePayloadSchema.safeParse({
      config: validSyncConfig(),
    });
    expect(result.success).toBe(true);
  });

  it('preserves extra keys (id/createdAt) via passthrough', () => {
    const result = syncExecutePayloadSchema.parse({
      config: validSyncConfig(),
    });
    expect((result.config as Record<string, unknown>).id).toBe('cfg-1');
  });

  it('rejects empty objects array', () => {
    const config = { ...validSyncConfig(), objects: [] };
    expect(syncExecutePayloadSchema.safeParse({ config }).success).toBe(false);
  });

  it('rejects non-SF object names (SOQL injection)', () => {
    const config = validSyncConfig();
    (config.objects as Array<Record<string, unknown>>)[0].objectApiName =
      'Account WHERE Id != null';
    expect(syncExecutePayloadSchema.safeParse({ config }).success).toBe(false);
  });

  it('rejects WHERE clauses with subqueries', () => {
    const config = validSyncConfig();
    (config.objects as Array<Record<string, unknown>>)[0].where = 'Id IN (SELECT Id FROM Contact)';
    expect(syncExecutePayloadSchema.safeParse({ config }).success).toBe(false);
  });

  it('rejects missing config', () => {
    expect(syncExecutePayloadSchema.safeParse({}).success).toBe(false);
  });
});

describe('frozenConfigSavePayloadSchema', () => {
  const withPlaceholderType = (recordTypeDeveloperName: string) => ({
    config: {
      rootObject: 'Case',
      axes: [],
      edgeCases: [],
      requiredLookupPlaceholders: {
        'Case.AccountId': { name: 'SF_PLACEHOLDER', recordTypeDeveloperName },
      },
    },
  });

  it('takes a placeholder’s record type by its namespaced name, a namespace and a DeveloperName long', () => {
    const longest = `${'n'.repeat(15)}__${'R'.repeat(80)}`;

    expect(frozenConfigSavePayloadSchema.safeParse(withPlaceholderType(longest)).success).toBe(
      true,
    );
    expect(
      frozenConfigSavePayloadSchema.safeParse(withPlaceholderType(`${longest}X`)).success,
    ).toBe(false);
  });
});

describe('seedExecutePayloadSchema', () => {
  it('accepts the exact payload shape the webview sends', () => {
    const result = seedExecutePayloadSchema.safeParse({
      orgId: '00DXXXXXXXXXXXXXXX',
      template: validSeedTemplate(),
    });
    expect(result.success).toBe(true);
  });

  it('accepts optional dryRun flag', () => {
    const result = seedExecutePayloadSchema.safeParse({
      orgId: 'org-1',
      template: validSeedTemplate(),
      dryRun: true,
    });
    expect(result.success).toBe(true);
  });

  it('rejects absurd record counts', () => {
    const template = validSeedTemplate();
    (template.objects as Array<Record<string, unknown>>)[0].recordCount = 50_000_000;
    expect(seedExecutePayloadSchema.safeParse({ orgId: 'o', template }).success).toBe(false);
  });

  it('rejects empty objects array', () => {
    const template = { ...validSeedTemplate(), objects: [] };
    expect(seedExecutePayloadSchema.safeParse({ orgId: 'o', template }).success).toBe(false);
  });

  it('strips the persona-side prompt key from a field rule, although objects pass extra keys through', () => {
    const template = validSeedTemplate();
    const object = (template.objects as Array<Record<string, unknown>>)[0];
    object.extraObjectKey = 'kept';
    object.fieldRules = [
      {
        fieldApiName: 'Description',
        ruleType: 'ai_generate',
        config: { prompt: 'persona wording', aiPrompt: 'a' },
      },
    ];

    const parsed = seedExecutePayloadSchema.parse({ orgId: 'o', template });

    expect(parsed.template.objects[0]).toHaveProperty('extraObjectKey', 'kept');
    expect(parsed.template.objects[0].fieldRules[0].config).toEqual({ aiPrompt: 'a' });
  });

  it('takes rows placed by key, and refuses one placed under a parent row no row is', () => {
    const keyedTemplate = (parentKey: string) => ({
      name: 'Keyed',
      strategy: 'template',
      objects: [
        {
          objectApiName: 'Account',
          recordCount: 1,
          fieldRules: [],
          excludedFields: [],
          insertOrder: 0,
          rows: [{ key: 'a1', values: { Name: 'Acme' } }],
        },
        {
          objectApiName: 'Contact',
          recordCount: 1,
          fieldRules: [],
          excludedFields: [],
          insertOrder: 1,
          rows: [{ key: 'c1', parentKey, values: { LastName: 'One' } }],
        },
      ],
      relations: [
        {
          childObject: 'Contact',
          lookupField: 'AccountId',
          parentObject: 'Account',
          parents: { kind: 'generated' },
          distribution: { mode: 'byKey' },
        },
      ],
    });

    const parsed = seedExecutePayloadSchema.parse({ orgId: 'o', template: keyedTemplate('a1') });
    expect(parsed.template.objects[1].rows).toEqual([
      { key: 'c1', parentKey: 'a1', values: { LastName: 'One' } },
    ]);
    const refused = seedExecutePayloadSchema.safeParse({
      orgId: 'o',
      template: keyedTemplate('a2'),
    });
    expect(refused.error?.issues.map((issue) => issue.message)).toEqual([
      'Contact row "c1" is placed under Account "a2", which no Account row is',
    ]);
  });
});

describe('dataops payload schemas', () => {
  it('dataOpsBackupPayloadSchema accepts webview payload', () => {
    expect(
      dataOpsBackupPayloadSchema.safeParse({
        orgId: 'org-1',
        objects: ['Account', 'Contact'],
      }).success,
    ).toBe(true);
  });

  it('dataOpsBackupPayloadSchema rejects empty objects and bad names', () => {
    expect(dataOpsBackupPayloadSchema.safeParse({ orgId: 'org-1', objects: [] }).success).toBe(
      false,
    );
    expect(
      dataOpsBackupPayloadSchema.safeParse({
        orgId: 'org-1',
        objects: ['Account; DROP'],
      }).success,
    ).toBe(false);
  });

  it('dataOpsRollbackPayloadSchema requires orgId + operationId', () => {
    expect(
      dataOpsRollbackPayloadSchema.safeParse({
        orgId: 'org-1',
        operationId: 'op-1',
      }).success,
    ).toBe(true);
    expect(dataOpsRollbackPayloadSchema.safeParse({ orgId: 'org-1' }).success).toBe(false);
  });

  it('dataOpsAnonymizePayloadSchema accepts optional objects', () => {
    expect(
      dataOpsAnonymizePayloadSchema.safeParse({
        orgId: 'o',
        templateId: 'gdpr-basic',
      }).success,
    ).toBe(true);
    expect(
      dataOpsAnonymizePayloadSchema.safeParse({
        orgId: 'o',
        templateId: 'gdpr-basic',
        objects: ['Contact'],
      }).success,
    ).toBe(true);
  });
});

describe('anonymizationTemplateSavePayloadSchema', () => {
  const save = (rule: Record<string, unknown>) =>
    anonymizationTemplateSavePayloadSchema.safeParse({
      name: 'Support desk',
      rules: [{ fieldPattern: 'Account.Website', ...rule }],
    });

  it('refuses a Constant rule with no value, which would write an empty one', () => {
    expect(save({ ruleType: 'constant' }).success).toBe(false);
    expect(save({ ruleType: 'constant', config: { constantValue: '' } }).success).toBe(false);
  });

  it('refuses a Truncate rule with no length, which would keep nothing', () => {
    expect(save({ ruleType: 'truncate' }).success).toBe(false);
    expect(save({ ruleType: 'truncate', config: { truncateKeep: 'first' } }).success).toBe(false);
    expect(save({ ruleType: 'truncate', config: { truncateLength: 0 } }).success).toBe(false);
  });

  it('takes a Constant with its value and a Truncate with its length, and keeps both', () => {
    const constant = save({
      ruleType: 'constant',
      config: { constantValue: 'https://example.com' },
    });
    expect(constant.success && constant.data.rules[0].config).toEqual({
      constantValue: 'https://example.com',
    });
    const truncate = save({
      ruleType: 'truncate',
      config: { truncateLength: 3, truncateKeep: 'first' },
    });
    expect(truncate.success && truncate.data.rules[0].config).toEqual({
      truncateLength: 3,
      truncateKeep: 'first',
    });
  });

  it('refuses a salt in a saved rule: the run that applies the template brings its own', () => {
    expect(save({ ruleType: 'hash', config: { hashSalt: 'written-down' } }).success).toBe(false);
  });
});

describe('dataOpsQualityScanPayloadSchema', () => {
  const scan = (overrides: Record<string, unknown>) =>
    dataOpsQualityScanPayloadSchema.safeParse({
      orgId: 'o',
      objects: [{ objectApiName: 'Contact', duplicateKey: 'Email' }, { objectApiName: 'Account' }],
      staleDays: 365,
      ...overrides,
    }).success;

  it('accepts objects with or without a duplicate key', () => {
    expect(scan({})).toBe(true);
  });

  it('refuses a duplicate key that is not an API name, since it lands in the query text', () => {
    expect(
      scan({ objects: [{ objectApiName: 'Contact', duplicateKey: 'Email) FROM User --' }] }),
    ).toBe(false);
  });

  it('refuses the same object twice in one scan', () => {
    expect(scan({ objects: [{ objectApiName: 'Account' }, { objectApiName: 'account' }] })).toBe(
      false,
    );
  });

  it('refuses more objects than one scan reads', () => {
    const objects = Array.from({ length: 11 }, (_, i) => ({ objectApiName: `Object${i}__c` }));
    expect(scan({ objects })).toBe(false);
  });

  it('refuses a staleness threshold that is not a whole number of days in range', () => {
    expect(scan({ staleDays: 0 })).toBe(false);
    expect(scan({ staleDays: 1.5 })).toBe(false);
    expect(scan({ staleDays: 3651 })).toBe(false);
    expect(scan({ staleDays: 3650 })).toBe(true);
  });
});

describe('dataOpsSubjectSearchPayloadSchema', () => {
  const search = (overrides: Record<string, unknown>) =>
    dataOpsSubjectSearchPayloadSchema.safeParse({ orgId: 'o', objects: ['Contact'], ...overrides })
      .success;

  it('takes an address, a name or a number, each on its own', () => {
    expect(search({ email: 'jane@example.com' })).toBe(true);
    expect(search({ name: 'Jane Doe' })).toBe(true);
    expect(search({ phone: '+33 1 23 45 67 89' })).toBe(true);
  });

  it('refuses a search with nothing to look for', () => {
    expect(search({})).toBe(false);
  });

  it('refuses what is not an address, a name or a number', () => {
    expect(search({ email: 'not an address' })).toBe(false);
    expect(search({ name: 'Jane\nDoe' })).toBe(false);
    expect(search({ phone: '12 34' })).toBe(false);
  });

  it('names a request only by the id the extension gave it', () => {
    expect(search({ email: 'jane@example.com', requestId: '../../log' })).toBe(false);
  });
});

describe('dataOpsSubjectErasePayloadSchema', () => {
  const erase = (overrides: Record<string, unknown>) =>
    dataOpsSubjectErasePayloadSchema.safeParse({
      orgId: 'o',
      requestId: '5b0a9b8c-0000-4000-8000-000000000000',
      mode: 'delete',
      records: [{ objectApiName: 'Contact', ids: ['003000000000001AAA'] }],
      dryRun: false,
      ...overrides,
    }).success;

  it('accepts records named by their Ids', () => {
    expect(erase({})).toBe(true);
  });

  it('refuses an Id that would change the query it lands in', () => {
    expect(erase({ records: [{ objectApiName: 'Contact', ids: ["003' OR Id != '"] }] })).toBe(
      false,
    );
  });

  it('refuses a way of erasing it does not know', () => {
    expect(erase({ mode: 'hardDelete' })).toBe(false);
  });
});

describe('dataOpsCleanupDeletePayloadSchema', () => {
  const remove = (recommendation: unknown) =>
    dataOpsCleanupDeletePayloadSchema.safeParse({
      orgId: 'o',
      objectApiName: 'Contact',
      recommendation,
      dryRun: true,
    }).success;

  it('accepts the three recommendations a scan makes', () => {
    expect(remove({ kind: 'stale', days: 365 })).toBe(true);
    expect(remove({ kind: 'orphans', fieldApiName: 'AccountId' })).toBe(true);
    expect(remove({ kind: 'duplicates', keyField: 'Email' })).toBe(true);
  });

  it('refuses a field that is not an API name, since it lands in the query text', () => {
    expect(remove({ kind: 'orphans', fieldApiName: 'AccountId = null OR Id' })).toBe(false);
  });

  it('refuses a recommendation no scan makes', () => {
    expect(remove({ kind: 'everything' })).toBe(false);
  });
});

describe('monitorOpenApexJobsPayloadSchema', () => {
  it('accepts an org id', () => {
    expect(monitorOpenApexJobsPayloadSchema.safeParse({ orgId: 'o' }).success).toBe(true);
  });

  it('refuses an address supplied by the page', () => {
    expect(
      monitorOpenApexJobsPayloadSchema.safeParse({ orgId: 'o', url: 'https://attacker.example' })
        .success,
    ).toBe(false);
    expect(monitorOpenApexJobsPayloadSchema.safeParse({ orgId: 'o', path: '/x' }).success).toBe(
      false,
    );
  });

  it('refuses a payload without an org id', () => {
    expect(monitorOpenApexJobsPayloadSchema.safeParse({}).success).toBe(false);
  });
});

describe('compareExecutePayloadSchema', () => {
  it('accepts webview payload', () => {
    expect(
      compareExecutePayloadSchema.safeParse({
        sourceOrgId: 'a',
        targetOrgId: 'b',
        types: ['CustomObject', 'ApexClass'],
      }).success,
    ).toBe(true);
  });

  it('rejects empty types array', () => {
    expect(
      compareExecutePayloadSchema.safeParse({
        sourceOrgId: 'a',
        targetOrgId: 'b',
        types: [],
      }).success,
    ).toBe(false);
  });
});

describe('the step types a stored pipeline reads with', () => {
  /** A saved pipeline holding one step of `type`. */
  function saved(type: string): Record<string, unknown> {
    return { id: 'pipe-1', name: 'Nightly', steps: [{ id: 's1', name: 'Step', type, config: {} }] };
  }

  it('reads a step of a type SandForge no longer has, for the run to refuse by name', () => {
    for (const type of ['script', 'loop', 'parallel']) {
      expect(savedPipelineSchema.safeParse(saved(type)).success).toBe(true);
    }
  });

  it('reads the types SandForge has, Approval and Sync among them', () => {
    for (const type of ['approval', 'sync', 'condition', 'backup']) {
      expect(pipelineRunPayloadSchema.safeParse({ pipeline: saved(type) }).success).toBe(true);
    }
  });

  it('reads a type this release does not have, for the run to refuse by name and History to record', () => {
    expect(savedPipelineSchema.safeParse(saved('dataops')).success).toBe(true);
    expect(pipelineRunPayloadSchema.safeParse({ pipeline: saved('dataops:backup') }).success).toBe(
      true,
    );
  });

  it('refuses a step with no type, an empty one, one that is no text, and one past any name', () => {
    expect(
      savedPipelineSchema.safeParse({ id: 'pipe-1', name: 'Nightly', steps: [{ config: {} }] })
        .success,
    ).toBe(false);
    expect(savedPipelineSchema.safeParse(saved(' ')).success).toBe(false);
    expect(savedPipelineSchema.safeParse(saved(7 as unknown as string)).success).toBe(false);
    expect(savedPipelineSchema.safeParse(saved('x'.repeat(81))).success).toBe(false);
  });
});

describe('pipelineApprovalPayloadSchema', () => {
  it('takes an approval or a rejection of a step of a run, and nothing else', () => {
    const answer = { operationId: 'op-1', stepId: 's1', decision: 'approved' };
    expect(pipelineApprovalPayloadSchema.safeParse(answer).success).toBe(true);
    expect(pipelineApprovalPayloadSchema.safeParse({ ...answer, decision: 'maybe' }).success).toBe(
      false,
    );
    expect(pipelineApprovalPayloadSchema.safeParse({ ...answer, stepId: '' }).success).toBe(false);
  });
});

describe('pipeline:rewind-* payloads', () => {
  const step = { pipelineId: 'pipeline-1', stepId: 'step-1' };

  it('validates each request as the shared contract declares its payload', () => {
    expectTypeOf<z.infer<typeof pipelineRewindStepsPayloadSchema>>().toEqualTypeOf<
      PipelineRewindStepsRequest['payload']
    >();
    expectTypeOf<z.infer<typeof pipelineRewindGrantPayloadSchema>>().toEqualTypeOf<
      PipelineRewindGrantRequest['payload']
    >();
    expectTypeOf<z.infer<typeof pipelineRewindRevokePayloadSchema>>().toEqualTypeOf<
      PipelineRewindRevokeRequest['payload']
    >();
  });

  it('reads the Rewind steps of a pipeline named by its saved id', () => {
    expect(pipelineRewindStepsPayloadSchema.safeParse({ pipelineId: 'pipeline-1' }).success).toBe(
      true,
    );
    // A pipeline not saved yet has an empty id: it has no Rewind step kept.
    expect(pipelineRewindStepsPayloadSchema.safeParse({ pipelineId: '' }).success).toBe(false);
    expect(pipelineRewindStepsPayloadSchema.safeParse(undefined).success).toBe(false);
  });

  it('keeps what was typed to confirm a step as it was typed, spaces and case', () => {
    const typed = ' Dev-SB ';
    expect(pipelineRewindGrantPayloadSchema.parse({ ...step, typed }).typed).toBe(typed);
  });

  it('refuses a confirmation with nothing typed, too much typed, or a step not saved', () => {
    for (const wrong of [
      { typed: '' },
      { typed: 'x'.repeat(256) },
      { typed: 42 },
      { pipelineId: '' },
      { stepId: '' },
    ]) {
      expect(
        pipelineRewindGrantPayloadSchema.safeParse({ ...step, typed: 'DEV-SB', ...wrong }).success,
      ).toBe(false);
    }
  });

  it('takes back the confirmation of a saved step, named by both its ids', () => {
    expect(pipelineRewindRevokePayloadSchema.safeParse(step).success).toBe(true);
    expect(pipelineRewindRevokePayloadSchema.safeParse({ pipelineId: 'pipeline-1' }).success).toBe(
      false,
    );
    expect(pipelineRewindRevokePayloadSchema.safeParse({ ...step, stepId: '' }).success).toBe(
      false,
    );
  });
});

describe('seedCsvPayloadSchema', () => {
  /** An import of `rows` rows over `columns` mapped columns. */
  const csvImport = (rows: number, columns: number): Record<string, unknown> => ({
    orgId: 'org-1',
    objectApiName: 'Account',
    records: Array.from({ length: rows }, () => ({ Name: 'Acme' })),
    columnMappings: Array.from({ length: columns }, (_, i) => ({
      csvHeader: `Column ${i}`,
      sfFieldApiName: `Field${i}__c`,
      sfFieldType: 'string',
      sfFieldLength: 80,
    })),
  });

  it('takes as many rows and mapped columns as the page lets through, and refuses one more of either', () => {
    // The page refuses a larger file as it reads it, by these same numbers:
    // the host refused it only once it had been mapped column by column.
    expect(seedCsvPayloadSchema.safeParse(csvImport(CSV_IMPORT_MAX_ROWS, 1)).success).toBe(true);
    expect(seedCsvPayloadSchema.safeParse(csvImport(CSV_IMPORT_MAX_ROWS + 1, 1)).success).toBe(
      false,
    );
    expect(seedCsvPayloadSchema.safeParse(csvImport(1, CSV_IMPORT_MAX_COLUMNS)).success).toBe(true);
    expect(seedCsvPayloadSchema.safeParse(csvImport(1, CSV_IMPORT_MAX_COLUMNS + 1)).success).toBe(
      false,
    );
  });
});

describe('checkpoint:* payloads', () => {
  const CHECKPOINT = 'ck-20261022-140512-a1b2';

  /** A take as the Take a checkpoint step sends it. */
  const take = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
    orgId: 'org-1',
    name: 'Before UAT',
    mode: 'everything',
    keepDays: 30,
    ...patch,
  });

  it('validates each request as the shared contract declares its payload', () => {
    expectTypeOf<z.infer<typeof checkpointListPayloadSchema>>().toEqualTypeOf<
      CheckpointListRequest['payload']
    >();
    expectTypeOf<z.infer<typeof checkpointScopePayloadSchema>>().toEqualTypeOf<
      CheckpointScopeRequest['payload']
    >();
    expectTypeOf<z.infer<typeof checkpointTakePayloadSchema>>().toEqualTypeOf<
      CheckpointTakeRequest['payload']
    >();
    expectTypeOf<z.infer<typeof checkpointPreviewPayloadSchema>>().toEqualTypeOf<
      CheckpointPreviewRequest['payload']
    >();
    expectTypeOf<z.infer<typeof checkpointRewindPayloadSchema>>().toEqualTypeOf<
      CheckpointRewindRequest['payload']
    >();
    expectTypeOf<z.infer<typeof checkpointUndoPayloadSchema>>().toEqualTypeOf<
      CheckpointUndoRequest['payload']
    >();
    expectTypeOf<z.infer<typeof checkpointDeletePayloadSchema>>().toEqualTypeOf<
      CheckpointDeleteRequest['payload']
    >();
    expectTypeOf<z.infer<typeof checkpointKeepPayloadSchema>>().toEqualTypeOf<
      CheckpointKeepRequest['payload']
    >();
    expectTypeOf<z.infer<typeof checkpointRenamePayloadSchema>>().toEqualTypeOf<
      CheckpointRenameRequest['payload']
    >();
    expectTypeOf<z.infer<typeof checkpointIgnoreFieldsPayloadSchema>>().toEqualTypeOf<
      CheckpointIgnoreFieldsRequest['payload']
    >();
    expectTypeOf<z.infer<typeof checkpointPlanSelectionPayloadSchema>>().toEqualTypeOf<
      CheckpointPlanSelectionRequest['payload']
    >();
    expectTypeOf<z.infer<typeof checkpointExportPayloadSchema>>().toEqualTypeOf<
      CheckpointExportRequest['payload']
    >();
    expectTypeOf<z.infer<typeof checkpointImportPayloadSchema>>().toEqualTypeOf<
      CheckpointImportRequest['payload']
    >();
  });

  it('limits a preview and a rewind to the objects named, by API name, each once, at least one', () => {
    const rewind = {
      checkpointId: CHECKPOINT,
      previewId: 'pv-20261022-141030-c3d4',
      acceptAutomation: false,
      acceptNoUndo: false,
      acceptRecreate: false,
      acceptOutside: false,
      acceptUnseen: false,
    };
    for (const objects of [undefined, ['Case'], ['Case', 'Contact']]) {
      expect(
        checkpointPreviewPayloadSchema.safeParse({ checkpointId: CHECKPOINT, objects }).success,
      ).toBe(true);
      expect(checkpointRewindPayloadSchema.safeParse({ ...rewind, objects }).success).toBe(true);
    }
    // Read so, the objects reach the handler: a rewind of one object is not
    // turned into a rewind of all of them by a schema that drops the field.
    expect(checkpointRewindPayloadSchema.parse({ ...rewind, objects: ['Case'] }).objects).toEqual([
      'Case',
    ]);
    for (const objects of [[], ['Case', 'Case'], ['Case WHERE Id != null'], 'Case']) {
      expect(
        checkpointPreviewPayloadSchema.safeParse({ checkpointId: CHECKPOINT, objects }).success,
      ).toBe(false);
      expect(checkpointRewindPayloadSchema.safeParse({ ...rewind, objects }).success).toBe(false);
    }
  });

  it('plans a selection from a preview named by its id, the objects picked and whether records outside may go', () => {
    const plan = {
      checkpointId: CHECKPOINT,
      previewId: 'pv-20261022-141030-c3d4',
      objects: ['Case'],
      acceptOutside: false,
    };
    expect(checkpointPlanSelectionPayloadSchema.safeParse(plan).success).toBe(true);
    for (const wrong of [
      { objects: undefined },
      { objects: [] },
      { objects: ['Case', 'Case'] },
      { acceptOutside: undefined },
      { acceptOutside: 'no' },
      { previewId: '../pv-20261022-141030-c3d4' },
      { previewId: CHECKPOINT },
    ]) {
      expect(checkpointPlanSelectionPayloadSchema.safeParse({ ...plan, ...wrong }).success).toBe(
        false,
      );
    }
  });

  it('exports a checkpoint named by its id alone', () => {
    expect(checkpointExportPayloadSchema.safeParse({ checkpointId: CHECKPOINT }).success).toBe(
      true,
    );
    expect(
      checkpointExportPayloadSchema.safeParse({ checkpointId: '../../ck-20261022-140512-a1b2' })
        .success,
    ).toBe(false);
    // A path the page would name is no field of the request, and is not kept.
    expect(
      checkpointExportPayloadSchema.parse({ checkpointId: CHECKPOINT, out: '/tmp/x.sfcheckpoint' }),
    ).toEqual({ checkpointId: CHECKPOINT });
  });

  it('imports the file a read answered by its token, for an org, with a key and a keeping time', () => {
    const asked = {
      token: 'imp-3f2a9c',
      orgId: 'org-1',
      key: 'ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23-4567-ABCD-EFGH-IJKL-MNOP-QRST',
      keepDays: 30,
    };
    expect(checkpointImportPayloadSchema.safeParse(asked).success).toBe(true);
    expect(checkpointImportPayloadSchema.safeParse({ ...asked, keepDays: 0 }).success).toBe(true);
    for (const wrong of [
      { token: '' },
      { orgId: '' },
      { key: '' },
      { key: 'x'.repeat(201) },
      { keepDays: -1 },
      { keepDays: 3651 },
      { keepDays: 1.5 },
    ]) {
      expect(checkpointImportPayloadSchema.safeParse({ ...asked, ...wrong }).success).toBe(false);
    }
    expect(
      checkpointImportPayloadSchema.parse({ ...asked, file: '/home/someone/x.sfcheckpoint' }),
    ).toEqual(asked);
  });

  it('lists the checkpoints of one org, or of every org when none is named', () => {
    expect(checkpointListPayloadSchema.safeParse(undefined).success).toBe(true);
    expect(checkpointListPayloadSchema.safeParse({}).success).toBe(true);
    expect(checkpointListPayloadSchema.safeParse({ orgId: 'org-1' }).success).toBe(true);
    expect(checkpointListPayloadSchema.safeParse({ orgId: '' }).success).toBe(false);
  });

  it('takes everything people work in without objects, and picked objects only with them', () => {
    expect(checkpointTakePayloadSchema.safeParse(take()).success).toBe(true);
    expect(
      checkpointTakePayloadSchema.safeParse(take({ mode: 'picked', objects: ['Account', 'Case'] }))
        .success,
    ).toBe(true);
    for (const scope of [
      { mode: 'picked' },
      { mode: 'picked', objects: [] },
      { mode: 'everything', objects: ['Account'] },
      { mode: 'all' },
    ]) {
      expect(checkpointTakePayloadSchema.safeParse(take(scope)).success).toBe(false);
    }
    expect(
      checkpointScopePayloadSchema.safeParse({ orgId: 'org-1', mode: 'picked', objects: ['Case'] })
        .success,
    ).toBe(true);
    expect(
      checkpointScopePayloadSchema.safeParse({
        orgId: 'org-1',
        mode: 'everything',
        objects: ['Case'],
      }).success,
    ).toBe(false);
  });

  it('refuses a picked object named twice, or not by its API name', () => {
    for (const objects of [['Account', 'Account'], ['Account WHERE Id != null']]) {
      expect(checkpointTakePayloadSchema.safeParse(take({ mode: 'picked', objects })).success).toBe(
        false,
      );
    }
  });

  it('takes custom settings named by their API names, or all of them, in either mode, and nothing else', () => {
    for (const customSettings of [
      ['App_Config__c'],
      ['acme__Switches__c', 'App_Config__c'],
      'all',
    ]) {
      expect(checkpointTakePayloadSchema.safeParse(take({ customSettings })).success).toBe(true);
      expect(
        checkpointScopePayloadSchema.safeParse({
          orgId: 'org-1',
          mode: 'picked',
          objects: ['Account'],
          customSettings,
        }).success,
      ).toBe(true);
    }
    for (const customSettings of [
      [],
      ['Account'],
      ['App_Config__c', 'app_config__c'],
      ['App_Config__c WHERE Id != null'],
      'everything',
      'All',
    ]) {
      expect(checkpointTakePayloadSchema.safeParse(take({ customSettings })).success).toBe(false);
    }
  });

  it('takes the objects to leave out and the limit of records the command line names, each checked', () => {
    const asked = { excluded: ['Case', 'Task'], maxTotal: 250_000 };
    expect(checkpointTakePayloadSchema.safeParse(take(asked)).success).toBe(true);
    expect(
      checkpointScopePayloadSchema.safeParse({ orgId: 'org-1', mode: 'everything', ...asked })
        .success,
    ).toBe(true);
    for (const wrong of [
      { excluded: [] },
      { excluded: ['Case', 'Case'] },
      { excluded: ['Case WHERE Id != null'] },
      { maxTotal: 0 },
      { maxTotal: 1.5 },
      { maxTotal: '500000' },
    ]) {
      expect(checkpointTakePayloadSchema.safeParse(take(wrong)).success).toBe(false);
      expect(
        checkpointScopePayloadSchema.safeParse({ orgId: 'org-1', mode: 'everything', ...wrong })
          .success,
      ).toBe(false);
    }
  });

  it('keeps a checkpoint for whole days, or until it is deleted with 0', () => {
    expect(checkpointTakePayloadSchema.safeParse(take({ keepDays: 0 })).success).toBe(true);
    for (const keepDays of [-1, 1.5, 3651, '30']) {
      expect(checkpointTakePayloadSchema.safeParse(take({ keepDays })).success).toBe(false);
    }
  });

  it('takes the fields not to compare named with their object, each once', () => {
    expect(
      checkpointTakePayloadSchema.safeParse(take({ ignoredFields: ['Case.Last_Touched__c'] }))
        .success,
    ).toBe(true);
    for (const ignoredFields of [['Last_Touched__c'], ['Case.A__c', 'Case.A__c']]) {
      expect(checkpointTakePayloadSchema.safeParse(take({ ignoredFields })).success).toBe(false);
    }
    expect(
      checkpointIgnoreFieldsPayloadSchema.safeParse({ checkpointId: CHECKPOINT, fields: [] })
        .success,
    ).toBe(true);
  });

  it('names a checkpoint with one line of text, kept without the spaces around it', () => {
    const named = checkpointTakePayloadSchema.safeParse(take({ name: '  Before demo ' }));
    expect(named.data?.name).toBe('Before demo');
    for (const name of ['', '  ', 'Before\nUAT']) {
      expect(checkpointTakePayloadSchema.safeParse(take({ name })).success).toBe(false);
      expect(
        checkpointRenamePayloadSchema.safeParse({ checkpointId: CHECKPOINT, name }).success,
      ).toBe(false);
    }
  });

  it('refuses a rewind that does not say whether it accepts each consequence', () => {
    const rewind = {
      checkpointId: CHECKPOINT,
      previewId: 'pv-20261022-141030-c3d4',
      acceptAutomation: false,
      acceptNoUndo: false,
      acceptRecreate: false,
      acceptOutside: false,
      acceptUnseen: false,
    };
    expect(checkpointRewindPayloadSchema.safeParse(rewind).success).toBe(true);
    for (const said of [
      'acceptAutomation',
      'acceptNoUndo',
      'acceptRecreate',
      'acceptOutside',
      'acceptUnseen',
    ]) {
      const unsaid: Record<string, unknown> = { ...rewind };
      delete unsaid[said];
      expect(checkpointRewindPayloadSchema.safeParse(unsaid).success).toBe(false);
      expect(checkpointRewindPayloadSchema.safeParse({ ...rewind, [said]: 'yes' }).success).toBe(
        false,
      );
    }
    expect(
      checkpointUndoPayloadSchema.safeParse({
        checkpointId: CHECKPOINT,
        rewindId: 'rw-20261022-141102-e5f6',
      }).success,
    ).toBe(false);
  });

  it('refuses ids that would name another folder than the one they stand for', () => {
    const traversal = '../../ck-20261022-140512-a1b2';
    expect(checkpointPreviewPayloadSchema.safeParse({ checkpointId: traversal }).success).toBe(
      false,
    );
    expect(
      checkpointKeepPayloadSchema.safeParse({ checkpointId: traversal, keep: true }).success,
    ).toBe(false);
    expect(
      checkpointRewindPayloadSchema.safeParse({
        checkpointId: CHECKPOINT,
        previewId: 'pv-20261022-141030-c3d4/../../x',
        acceptAutomation: true,
        acceptNoUndo: true,
        acceptRecreate: true,
        acceptOutside: true,
        acceptUnseen: true,
      }).success,
    ).toBe(false);
    expect(
      checkpointUndoPayloadSchema.safeParse({
        checkpointId: CHECKPOINT,
        // A preview's id where the rewind's is expected.
        rewindId: 'pv-20261022-141030-c3d4',
        acceptAutomation: true,
      }).success,
    ).toBe(false);
    expect(
      checkpointDeletePayloadSchema.safeParse({ checkpointIds: [CHECKPOINT, traversal] }).success,
    ).toBe(false);
  });

  it('deletes at least one checkpoint, each named once', () => {
    expect(checkpointDeletePayloadSchema.safeParse({ checkpointIds: [CHECKPOINT] }).success).toBe(
      true,
    );
    for (const checkpointIds of [[], [CHECKPOINT, CHECKPOINT]]) {
      expect(checkpointDeletePayloadSchema.safeParse({ checkpointIds }).success).toBe(false);
    }
  });

  it("answers a malformed checkpoint request with INVALID_PAYLOAD on the domain's error channel", () => {
    const deps = createMockDeps();
    const msg = makeMsg('checkpoint:take', take({ keepDays: -1 }));
    expect(validatePayload(checkpointTakePayloadSchema, msg, 'checkpoint:error', deps)).toBeNull();
    const posted = deps.postToWebview.mock.calls[0][0] as {
      type: string;
      correlationId?: string;
      payload: { code: string; message: string };
    };
    expect(posted.type).toBe('checkpoint:error');
    expect(posted.correlationId).toBe('msg-1');
    expect(posted.payload.code).toBe('INVALID_PAYLOAD');
    expect(posted.payload.message).toContain('keepDays');
  });
});
