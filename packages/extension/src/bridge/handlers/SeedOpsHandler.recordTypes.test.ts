/**
 * The record types a seed from the panel can give an object's records, read
 * with the object's describe, and the accounts a run writes as the kind their
 * record types give them — the rules `sandforge-seed --record-type` follows.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseMessage, SeedRecordTypeOption, SeedTemplate } from '@sandforge/shared';

import { SeedOpsHandler } from './SeedOpsHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { inboundRequest } from '../../test/mockFactories.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';

const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const PERSON_TYPE = fakeId('012', 1);
const BUSINESS_TYPE = fakeId('012', 2);

/** An org with person accounts: a person account record type and a business one on Account. */
function personAccountOrg() {
  const query = vi.fn(async (soql: string) =>
    soql.includes('IsPersonType = true')
      ? { records: [{ Id: PERSON_TYPE, DeveloperName: 'PersonAccount' }] }
      : { records: [] },
  );
  const describe = vi.fn(async () => ({
    label: 'Account',
    fields: [
      { name: 'Name', label: 'Account Name', type: 'string', nillable: false, createable: true },
      { name: 'LastName', label: 'Last Name', type: 'string', nillable: true, createable: true },
    ].map((f) => ({ ...f, defaultedOnCreate: false, length: 80 })),
    recordTypeInfos: [
      {
        recordTypeId: PERSON_TYPE,
        developerName: 'PersonAccount',
        name: 'Person Account',
        available: true,
        active: true,
        master: false,
        defaultRecordTypeMapping: false,
      },
      {
        recordTypeId: BUSINESS_TYPE,
        developerName: 'Customer',
        name: 'Customer',
        available: true,
        active: true,
        master: false,
        defaultRecordTypeMapping: true,
      },
    ],
  }));
  vi.mocked(getJsforceConnection).mockResolvedValue({ query, describe } as never);
}

/** Accounts seeded with a name and a last name, given these record types. */
function accountsTyped(recordTypeIds: string[]): SeedTemplate {
  return {
    id: 'tpl-ui',
    name: 'seed-from-ui',
    description: '',
    version: 1,
    strategy: 'faker',
    objects: [
      {
        objectApiName: 'Account',
        recordCount: 5,
        batchSize: 200,
        insertOrder: 0,
        excludedFields: [],
        fieldRules: [
          { fieldApiName: 'Name', ruleType: 'faker', config: { fakerMethod: 'company' } },
          { fieldApiName: 'LastName', ruleType: 'faker', config: { fakerMethod: 'lastName' } },
          recordTypeIds.length === 1
            ? {
                fieldApiName: 'RecordTypeId',
                fieldType: 'reference',
                ruleType: 'static',
                config: { staticValue: recordTypeIds[0] },
              }
            : {
                fieldApiName: 'RecordTypeId',
                fieldType: 'reference',
                ruleType: 'picklist_random',
                config: { picklistValues: recordTypeIds },
              },
        ],
      },
    ],
    tags: [],
    createdAt: '2026-10-18T00:00:00.000Z',
    updatedAt: '2026-10-18T00:00:00.000Z',
  };
}

describe('SeedOpsHandler — record types', () => {
  let deps: HandlerDeps;
  let handler: SeedOpsHandler;
  /** The template each run handed the orchestrator. */
  let executed: SeedTemplate[];

  const posted = (type: string) =>
    vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map(([m]) => m as BaseMessage & { payload: Record<string, unknown> })
      .filter((m) => m.type === type);

  beforeEach(() => {
    vi.clearAllMocks();
    executed = [];
    let n = 0;
    deps = {
      log: vi.fn(),
      broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
      stateSync: {} as HandlerDeps['stateSync'],
      orgManager: {
        getOrg: vi.fn(() => ({ orgType: 'Sandbox' })),
      } as unknown as HandlerDeps['orgManager'],
      orgRegistry: {} as HandlerDeps['orgRegistry'],
      configStore: {
        get: vi.fn(),
        set: vi.fn(),
        getKeysByPrefix: vi.fn(() => []),
      } as unknown as HandlerDeps['configStore'],
      secretVault: {} as HandlerDeps['secretVault'],
      authProvider: {} as HandlerDeps['authProvider'],
      sfdxBridge: {} as HandlerDeps['sfdxBridge'],
      infraServices: { productionGuard: new ProductionGuard() } as HandlerDeps['infraServices'],
      services: {
        isAIEnabled: () => false,
        getSandforgeSetting: vi.fn(() => 200),
        seedOrchestrator: vi.fn(() => ({
          execute: vi.fn(async (template: SeedTemplate) => {
            executed.push(template);
            return {
              templateId: template.id,
              operationId: 'op-typed',
              status: 'success',
              objectResults: [],
              totalRecordsCreated: 0,
              totalRecordsFailed: 0,
              duration: 1,
              timestamp: '2026-10-18T00:00:00.000Z',
            };
          }),
        })),
      } as unknown as HandlerDeps['services'],
      nextId: () => String(++n),
    };
    handler = new SeedOpsHandler(deps);
    personAccountOrg();
  });

  const execute = (template: SeedTemplate) =>
    handler.handle(
      inboundRequest({
        id: 'seed-typed',
        type: 'seed:execute',
        timestamp: Date.now(),
        payload: { orgId: 'org-1', template },
      }),
    );

  it('tells the wizard the record types it can give the accounts, the person account’s marked', async () => {
    await handler.handle(
      inboundRequest({
        id: 'req-rt',
        type: 'seed:describe-object',
        timestamp: Date.now(),
        payload: { orgId: 'org-1', objectApiName: 'Account' },
      }),
    );

    const [response] = posted('seed:describe-object:response');
    expect(response.payload.recordTypes as SeedRecordTypeOption[]).toEqual([
      expect.objectContaining({ developerName: 'PersonAccount', person: true, isDefault: false }),
      expect.objectContaining({ developerName: 'Customer', person: false, isDefault: true }),
    ]);
  });

  it('writes accounts given the person account type without Name, which the platform builds', async () => {
    await execute(accountsTyped([PERSON_TYPE]));

    await vi.waitFor(() => expect(executed).toHaveLength(1));
    expect(executed[0].objects[0].fieldRules.map((r) => r.fieldApiName)).toEqual([
      'LastName',
      'RecordTypeId',
    ]);
  });

  it('refuses a person type and a business type taking turns, before anything is written', async () => {
    await execute(accountsTyped([PERSON_TYPE, BUSINESS_TYPE]));

    expect(executed).toEqual([]);
    expect(posted('seed:error')).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          code: 'RECORD_TYPES_MIXED',
          message: expect.stringContaining('take different fields'),
        }),
      }),
    ]);
  });
});
