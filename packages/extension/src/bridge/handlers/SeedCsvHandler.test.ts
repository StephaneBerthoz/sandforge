import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BaseMessage } from '@sandforge/shared';
import { SeedCsvHandler } from './SeedCsvHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));
vi.mock('../../core/common/sforceLimitParser.js', () => ({
  checkApiLimits: vi.fn(),
}));

/**
 * The writer and the validator are constructed inside the handler, so they are
 * replaced at module level. `writer` doubles as the "did anything reach the
 * target org?" probe used by the production-guard cases.
 */
const writer = vi.hoisted(() => ({
  insert: vi.fn(),
  upsert: vi.fn(),
}));
const validator = vi.hoisted(() => ({ validate: vi.fn() }));

vi.mock('../../modules/sync/BulkDataWriter.js', () => ({
  BulkDataWriter: vi.fn().mockImplementation(() => writer),
}));
vi.mock('../../modules/seed/CsvValidator.js', () => ({
  CsvValidator: vi.fn().mockImplementation(() => validator),
}));

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { inboundRequest } from '../../test/mockFactories.js';

const mockGetConn = vi.mocked(getJsforceConnection);

/** Message envelope shaped like what MessageBroker hands a handler. */
function buildMsg(type: string, payload?: unknown): InboundRequest {
  return inboundRequest({
    id: `msg-${type}`,
    type,
    timestamp: Date.now(),
    payload,
  } as BaseMessage);
}

/** A valid `seed:csv:*` payload: one mapped column, one row. */
function csvPayload(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    orgId: 'tgt-org',
    objectApiName: 'Account',
    records: [{ name: 'Acme' }],
    columnMappings: [
      {
        csvHeader: 'name',
        sfFieldApiName: 'Name',
        sfFieldType: 'string',
        sfFieldLength: 255,
      },
    ],
    ...overrides,
  };
}

function createMockDeps(): HandlerDeps {
  let idCounter = 0;
  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
    stateSync: {} as HandlerDeps['stateSync'],
    orgManager: { getOrg: vi.fn() } as unknown as HandlerDeps['orgManager'],
    orgRegistry: {} as unknown as HandlerDeps['orgRegistry'],
    configStore: {
      get: vi.fn().mockReturnValue(undefined),
      set: vi.fn(),
    } as unknown as HandlerDeps['configStore'],
    secretVault: {} as unknown as HandlerDeps['secretVault'],
    authProvider: {} as unknown as HandlerDeps['authProvider'],
    sfdxBridge: {} as unknown as HandlerDeps['sfdxBridge'],
    nextId: () => String(++idCounter),
  };
}

/** All messages of one type posted to the webview, in emission order. */
function posted(deps: HandlerDeps, type: string): Array<BaseMessage & { payload: never }> {
  return vi
    .mocked(deps.broker.postToWebview)
    .mock.calls.map((call) => call[0] as BaseMessage & { payload: never })
    .filter((msg) => msg.type === type);
}

describe('SeedCsvHandler', () => {
  let deps: HandlerDeps;
  let handler: SeedCsvHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = createMockDeps();
    handler = new SeedCsvHandler(deps);

    mockGetConn.mockResolvedValue({
      describe: vi.fn().mockResolvedValue({ fields: [{ name: 'Name', type: 'string' }] }),
      limitInfo: undefined,
    } as unknown as Awaited<ReturnType<typeof getJsforceConnection>>);
    validator.validate.mockReturnValue({
      valid: true,
      errors: [],
      validRowCount: 1,
    });
    writer.insert.mockResolvedValue([{ id: '001TGT', success: true, errors: [] }]);
    writer.upsert.mockResolvedValue([{ id: '001TGT', success: true, errors: [] }]);
  });

  describe('routing', () => {
    it('ignores message types it does not own', async () => {
      expect(await handler.handle(buildMsg('seed:clone:execute'))).toBe(false);
      expect(deps.broker.postToWebview).not.toHaveBeenCalled();
    });
  });

  describe('seed:csv:validate', () => {
    it('validates the rows against the live describe and returns the verdict', async () => {
      await handler.handle(buildMsg('seed:csv:validate', csvPayload()));

      expect(validator.validate).toHaveBeenCalledWith(
        [{ name: 'Acme' }],
        expect.any(Array),
        [{ name: 'Name', type: 'string' }],
        undefined,
      );
      const responses = posted(deps, 'seed:csv:validate:response');
      expect(responses).toHaveLength(1);
      expect(responses[0].payload as unknown).toMatchObject({ valid: true });
    });

    it('reports describe failures on seed:csv:error', async () => {
      mockGetConn.mockRejectedValue(new Error('org unreachable'));

      await handler.handle(buildMsg('seed:csv:validate', csvPayload()));

      const errors = posted(deps, 'seed:csv:error');
      expect(errors).toHaveLength(1);
      expect((errors[0].payload as { message: string }).message).toContain('org unreachable');
    });
  });

  describe('seed:csv:execute', () => {
    it('coerces cell values and skips unmapped columns before writing', async () => {
      await handler.handle(
        buildMsg(
          'seed:csv:execute',
          csvPayload({
            records: [
              {
                name: 'Acme',
                active: 'true',
                employees: '42',
                note: 'null',
                skip: 'x',
              },
            ],
            columnMappings: [
              {
                csvHeader: 'name',
                sfFieldApiName: 'Name',
                sfFieldType: 'string',
                sfFieldLength: 255,
              },
              {
                csvHeader: 'active',
                sfFieldApiName: 'Active__c',
                sfFieldType: 'boolean',
                sfFieldLength: null,
              },
              {
                csvHeader: 'employees',
                sfFieldApiName: 'NumberOfEmployees',
                sfFieldType: 'int',
                sfFieldLength: null,
              },
              {
                csvHeader: 'note',
                sfFieldApiName: 'Description',
                sfFieldType: 'textarea',
                sfFieldLength: null,
              },
              // Empty target = column deliberately left unmapped in the wizard.
              {
                csvHeader: 'skip',
                sfFieldApiName: '',
                sfFieldType: '',
                sfFieldLength: null,
              },
            ],
          }),
        ),
      );

      expect(writer.insert).toHaveBeenCalledWith(
        'Account',
        [
          {
            Name: 'Acme',
            Active__c: true,
            NumberOfEmployees: 42,
            Description: null,
          },
        ],
        200,
      );
    });

    it('counts failures and caps the errors carried back to the webview', async () => {
      const outcomes = Array.from({ length: 150 }, () => ({
        success: false,
        errors: ['REQUIRED_FIELD_MISSING: Name'],
      }));
      writer.insert.mockResolvedValue(outcomes);

      await handler.handle(
        buildMsg(
          'seed:csv:execute',
          csvPayload({
            records: Array.from({ length: 150 }, () => ({ name: 'Acme' })),
          }),
        ),
      );

      const responses = posted(deps, 'seed:csv:execute:response');
      const payload = responses[0].payload as unknown as {
        insertedCount: number;
        failedCount: number;
        errors: string[];
      };
      expect(payload.insertedCount).toBe(0);
      expect(payload.failedCount).toBe(150);
      expect(payload.errors).toHaveLength(100);
    });

    it('upserts when the payload carries an external ID field', async () => {
      await handler.handle(
        buildMsg('seed:csv:execute', csvPayload({ externalIdField: 'External_Id__c' })),
      );

      expect(writer.upsert).toHaveBeenCalledWith(
        'Account',
        'External_Id__c',
        [{ Name: 'Acme' }],
        200,
      );
      expect(writer.insert).not.toHaveBeenCalled();
    });

    it('reports execute failures on operation:failed as retryable', async () => {
      writer.insert.mockRejectedValue(new Error('bulk write exploded'));

      await handler.handle(buildMsg('seed:csv:execute', csvPayload()));

      const failures = posted(deps, 'operation:failed');
      expect(failures).toHaveLength(1);
      expect(failures[0].payload as unknown).toMatchObject({
        error: 'bulk write exploded',
        retryable: true,
      });
    });
  });

  describe('production guard', () => {
    /** Wire a mock ProductionGuard into deps.infraServices and return its spies. */
    function wireGuard(behavior: {
      allowed: boolean;
      requiresConfirmation?: boolean;
      blockedReason?: string;
      confirmed?: boolean;
    }): {
      check: ReturnType<typeof vi.fn>;
      logOperation: ReturnType<typeof vi.fn>;
      confirmIfNeeded: ReturnType<typeof vi.fn>;
    } {
      const check = vi.fn().mockReturnValue({
        allowed: behavior.allowed,
        requiresConfirmation: behavior.requiresConfirmation ?? false,
        requiresApproval: false,
        blockedReason: behavior.blockedReason,
        warnings: [],
        impactSummary: 'INSERT 1 Account record(s) on production org tgt-org [module: seed]',
      });
      const logOperation = vi.fn();
      const confirmIfNeeded = vi.fn().mockResolvedValue(behavior.confirmed ?? true);
      deps.infraServices = {
        performanceTracker: { start: vi.fn(), complete: vi.fn() },
        productionGuard: { check, logOperation, confirmIfNeeded },
        offlineManager: undefined,
        piiDetector: undefined,
      } as unknown as NonNullable<HandlerDeps['infraServices']>;
      return { check, logOperation, confirmIfNeeded };
    }

    function mockTargetOrgType(orgType: string): void {
      vi.mocked(deps.orgManager.getOrg).mockReturnValue({
        orgType,
      } as unknown as ReturnType<HandlerDeps['orgManager']['getOrg']>);
    }

    it('resolves the guard tier from the target org and imports once confirmed', async () => {
      const guard = wireGuard({
        allowed: true,
        requiresConfirmation: true,
        confirmed: true,
      });
      mockTargetOrgType('Production');

      await handler.handle(buildMsg('seed:csv:execute', csvPayload()));

      expect(guard.check.mock.calls[0][0]).toMatchObject({
        orgId: 'tgt-org',
        orgTier: 'production',
        operation: 'insert',
        objectName: 'Account',
        recordCount: 1,
        module: 'seed',
      });
      expect(guard.logOperation).toHaveBeenCalledTimes(1);
      expect(writer.insert).toHaveBeenCalledTimes(1);
      expect(posted(deps, 'seed:csv:execute:response')).toHaveLength(1);
    });

    it('declares an external-ID import as an upsert to the guard', async () => {
      const guard = wireGuard({ allowed: true });
      mockTargetOrgType('Scratch');

      await handler.handle(
        buildMsg('seed:csv:execute', csvPayload({ externalIdField: 'External_Id__c' })),
      );

      expect(guard.check.mock.calls[0][0]).toMatchObject({
        orgTier: 'scratch',
        operation: 'upsert',
      });
    });

    it('blocks the import when the guard refuses — no write, retryable operation:failed', async () => {
      const guard = wireGuard({
        allowed: false,
        blockedReason: 'insert is not allowed on production org tgt-org',
      });
      mockTargetOrgType('Production');

      await handler.handle(buildMsg('seed:csv:execute', csvPayload()));

      expect(guard.logOperation).toHaveBeenCalledTimes(1);
      expect(guard.confirmIfNeeded).not.toHaveBeenCalled();
      expect(writer.insert).not.toHaveBeenCalled();
      expect(writer.upsert).not.toHaveBeenCalled();
      expect(posted(deps, 'seed:csv:execute:response')).toHaveLength(0);

      const failures = posted(deps, 'operation:failed');
      expect(failures).toHaveLength(1);
      expect(failures[0].payload as unknown).toEqual({
        operationId: 'msg-seed:csv:execute',
        error:
          'Operation blocked by Production Guard: insert is not allowed on production org tgt-org',
        retryable: true,
      });
    });

    it('falls back to the impact summary when the guard blocks without a reason', async () => {
      wireGuard({ allowed: false });
      mockTargetOrgType('Production');

      await handler.handle(buildMsg('seed:csv:execute', csvPayload()));

      const failures = posted(deps, 'operation:failed');
      expect((failures[0].payload as { error: string }).error).toBe(
        'Operation blocked by Production Guard: INSERT 1 Account record(s) on production org tgt-org [module: seed]',
      );
    });

    it('cancels the import when the user declines confirmation — no write, not retryable', async () => {
      const guard = wireGuard({
        allowed: true,
        requiresConfirmation: true,
        confirmed: false,
      });
      mockTargetOrgType('Production');

      await handler.handle(buildMsg('seed:csv:execute', csvPayload()));

      expect(guard.confirmIfNeeded).toHaveBeenCalledTimes(1);
      expect(writer.insert).not.toHaveBeenCalled();
      expect(writer.upsert).not.toHaveBeenCalled();
      expect(posted(deps, 'operation:started')).toHaveLength(0);
      expect(posted(deps, 'seed:csv:execute:response')).toHaveLength(0);

      const failures = posted(deps, 'operation:failed');
      expect(failures).toHaveLength(1);
      expect(failures[0].payload as unknown).toEqual({
        operationId: 'msg-seed:csv:execute',
        error: 'Operation cancelled by user (production confirmation declined).',
        retryable: false,
      });
    });
  });
});
