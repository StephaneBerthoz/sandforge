import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import type { BaseMessage } from '@sandforge/shared';
import type { HandlerDeps } from './handlers/HandlerTypes.js';
import {
  validatePayload,
  orgIdSchema,
  sfApiNameSchema,
  whereClauseSchema,
  syncExecutePayloadSchema,
  seedExecutePayloadSchema,
  dataOpsBackupPayloadSchema,
  dataOpsRollbackPayloadSchema,
  dataOpsAnonymizePayloadSchema,
  monitorAbortJobPayloadSchema,
  compareExecutePayloadSchema,
} from './validatePayload.js';

type MockDeps = Pick<HandlerDeps, 'log' | 'broker' | 'nextId'>;

function createMockDeps(): MockDeps & { postToWebview: ReturnType<typeof vi.fn> } {
  const postToWebview = vi.fn();
  let id = 0;
  return {
    log: vi.fn(),
    broker: { postToWebview } as unknown as MockDeps['broker'],
    nextId: () => String(++id),
    postToWebview,
  };
}

function makeMsg(type: string, payload: unknown): BaseMessage {
  return { id: 'msg-1', type, timestamp: Date.now(), payload } as BaseMessage;
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
        operation: 'upsert',
        externalIdField: 'Ext_Id__c',
        batchSize: 200,
        where: "Name != null",
        fieldMappings: [],
        transformRules: [],
        excludedFields: [],
        addOnFields: [],
        insertOrder: 0,
      },
    ],
    conflictStrategy: 'source_wins',
    enableRollback: false,
    dryRun: false,
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
          { fieldApiName: 'FirstName', ruleType: 'faker', config: { fakerMethod: 'person.firstName' } },
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
    const msg: BaseMessage = { id: 'msg-1', type: 'x:y', timestamp: Date.now() };
    expect(validatePayload(schema, msg, 'x:error', deps)).toBeNull();
    expect(deps.postToWebview).toHaveBeenCalledTimes(1);
  });

  it('caps the error summary at 3 issues', () => {
    const schema = z.object({ a: z.string(), b: z.string(), c: z.string(), d: z.string() });
    validatePayload(schema, makeMsg('x:y', {}), 'x:error', deps);
    const errMsg = deps.postToWebview.mock.calls[0][0] as { payload: { message: string } };
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
    expect(whereClauseSchema.safeParse("Name != null AND CreatedDate > 2024-01-01").success).toBe(
      true,
    );
  });

  it('whereClauseSchema rejects subqueries and DML keywords', () => {
    expect(whereClauseSchema.safeParse('Id IN (SELECT AccountId FROM Contact)').success).toBe(false);
    expect(whereClauseSchema.safeParse("Name = 'x' DELETE").success).toBe(false);
    expect(whereClauseSchema.safeParse('update me').success).toBe(false);
  });
});

describe('syncExecutePayloadSchema', () => {
  it('accepts the exact payload shape the webview sends', () => {
    const result = syncExecutePayloadSchema.safeParse({ config: validSyncConfig() });
    expect(result.success).toBe(true);
  });

  it('preserves extra keys (id/createdAt) via passthrough', () => {
    const result = syncExecutePayloadSchema.parse({ config: validSyncConfig() });
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
    (config.objects as Array<Record<string, unknown>>)[0].where =
      'Id IN (SELECT Id FROM Contact)';
    expect(syncExecutePayloadSchema.safeParse({ config }).success).toBe(false);
  });

  it('rejects missing config', () => {
    expect(syncExecutePayloadSchema.safeParse({}).success).toBe(false);
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
});

describe('dataops payload schemas', () => {
  it('dataOpsBackupPayloadSchema accepts webview payload', () => {
    expect(
      dataOpsBackupPayloadSchema.safeParse({ orgId: 'org-1', objects: ['Account', 'Contact'] })
        .success,
    ).toBe(true);
  });

  it('dataOpsBackupPayloadSchema rejects empty objects and bad names', () => {
    expect(dataOpsBackupPayloadSchema.safeParse({ orgId: 'org-1', objects: [] }).success).toBe(
      false,
    );
    expect(
      dataOpsBackupPayloadSchema.safeParse({ orgId: 'org-1', objects: ['Account; DROP'] }).success,
    ).toBe(false);
  });

  it('dataOpsRollbackPayloadSchema requires orgId + operationId', () => {
    expect(
      dataOpsRollbackPayloadSchema.safeParse({ orgId: 'org-1', operationId: 'op-1' }).success,
    ).toBe(true);
    expect(dataOpsRollbackPayloadSchema.safeParse({ orgId: 'org-1' }).success).toBe(false);
  });

  it('dataOpsAnonymizePayloadSchema accepts optional objects', () => {
    expect(
      dataOpsAnonymizePayloadSchema.safeParse({ orgId: 'o', templateId: 'gdpr-basic' }).success,
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

describe('monitorAbortJobPayloadSchema', () => {
  it('accepts 18-char SF job ids', () => {
    expect(
      monitorAbortJobPayloadSchema.safeParse({ orgId: 'o', jobId: '707XXXXXXXXXXXXXXX' }).success,
    ).toBe(true);
  });

  it('rejects malformed job ids', () => {
    expect(monitorAbortJobPayloadSchema.safeParse({ orgId: 'o', jobId: 'not a job' }).success).toBe(
      false,
    );
    expect(monitorAbortJobPayloadSchema.safeParse({ orgId: 'o', jobId: '' }).success).toBe(false);
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
      compareExecutePayloadSchema.safeParse({ sourceOrgId: 'a', targetOrgId: 'b', types: [] })
        .success,
    ).toBe(false);
  });
});
