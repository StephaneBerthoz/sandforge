/**
 * A transform rule that names no field, at every start of a Sync run the
 * bridge serves: the page's run and simulation, a saved configuration's run
 * (Run now, Migration's Open in Sync, both `sync:execute`), a history rerun,
 * a schedule's run and a pipeline's Sync step. Each is refused before any org
 * is reached and before Production Guard is asked, with the rule and its
 * object named and the code the page words, and nothing is written.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BaseMessage, SyncConfig, TransformRule } from '@sandforge/shared';
import { SyncOpsHandler } from './SyncOpsHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { inboundRequest } from '../../test/mockFactories.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));
vi.mock('../../modules/sync/SyncOrchestrator.js', () => ({
  SyncOrchestrator: vi.fn().mockImplementation(function () {
    return { execute: vi.fn(), simulate: vi.fn() };
  }),
}));

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';

const mockGetConn = vi.mocked(getJsforceConnection);

/** The configuration the page sends, its Account carrying the rules given. */
function configWith(transformRules: TransformRule[]): Record<string, unknown> {
  return {
    id: 'cfg-1',
    name: 'Accounts',
    description: 'test',
    sourceOrgId: 'src-org',
    targetOrgId: 'tgt-org',
    direction: 'source_to_target',
    mode: 'full',
    objects: [
      {
        objectApiName: 'Account',
        operation: 'insert',
        externalIdField: '',
        batchSize: 200,
        fieldMappings: [],
        transformRules,
        excludedFields: [],
        addOnFields: [],
        insertOrder: 0,
      },
    ],
    conflictStrategy: 'source_wins',
    enableRollback: false,
    createdAt: '2026-10-31T00:00:00Z',
    updatedAt: '2026-10-31T00:00:00Z',
  };
}

/** A rule saved before rules named a field. */
const FIELDLESS: TransformRule[] = [{ type: 'uppercase', config: {} }];

const WORDS =
  'The rule Uppercase on Account names no field: open the configuration and pick its field. ' +
  'Without one it would change every field of every record, record types and lookups among them.';

describe('SyncOpsHandler — a transform rule that names no field', () => {
  let deps: HandlerDeps;
  let handler: SyncOpsHandler;
  let guardCheck: ReturnType<typeof vi.spyOn>;
  let stored: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetConn.mockRejectedValue(new Error('connection failed'));
    const guard = new ProductionGuard();
    guardCheck = vi.spyOn(guard, 'check');
    stored = vi.fn();
    let id = 0;
    deps = {
      log: vi.fn(),
      broker: { postToWebview: vi.fn() },
      configStore: { set: stored, get: vi.fn(), getKeysByPrefix: vi.fn(() => []) },
      orgManager: { getOrg: vi.fn() },
      infraServices: { productionGuard: guard },
      nextId: () => String(++id),
    } as unknown as HandlerDeps;
    handler = new SyncOpsHandler(deps);
  });

  /** Every message the handler posted to the page. */
  function posted(): Array<BaseMessage & { payload: Record<string, unknown> }> {
    return vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map((call) => call[0] as BaseMessage & { payload: Record<string, unknown> });
  }

  /** Neither org reached, the guard not asked, nothing started. */
  function nothingStarted(): void {
    expect(mockGetConn).not.toHaveBeenCalled();
    expect(guardCheck).not.toHaveBeenCalled();
    expect(posted().filter((m) => m.type === 'operation:started')).toEqual([]);
  }

  it.each([
    ['sync:execute', 'Nothing was read or written.'],
    ['sync:simulate', 'Nothing was read.'],
  ])(
    'refuses %s before it reads anything, naming the rule and its object',
    async (type, undone) => {
      await handler.handle(
        inboundRequest({
          id: 'req-1',
          type,
          timestamp: Date.now(),
          payload: { config: configWith(FIELDLESS) },
        }),
      );

      const errors = posted().filter((m) => m.type === 'sync:error');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        correlationId: 'req-1',
        payload: {
          code: 'TRANSFORM_RULE_NO_FIELD',
          message: `${WORDS} ${undone}`,
          rules: [{ objectApiName: 'Account', type: 'uppercase' }],
        },
      });
      nothingStarted();
    },
  );

  it('saves no configuration a run of which would be refused', async () => {
    await handler.handle(
      inboundRequest({
        id: 'req-save',
        type: 'sync:config:save',
        timestamp: Date.now(),
        payload: { config: configWith(FIELDLESS) },
      }),
    );

    expect(posted()).toEqual([
      expect.objectContaining({
        type: 'sync:error',
        payload: expect.objectContaining({
          code: 'TRANSFORM_RULE_NO_FIELD',
          message: `${WORDS} Nothing was saved.`,
        }),
      }),
    ]);
    expect(stored).not.toHaveBeenCalled();
  });

  it('refuses a rerun of a history entry before it reads anything', async () => {
    await handler.rerunFromSnapshot(
      inboundRequest({ id: 'req-rerun', type: 'sync:history:rerun', timestamp: Date.now() }),
      configWith(FIELDLESS),
    );

    expect(posted().filter((m) => m.type === 'sync:history:error')).toEqual([
      expect.objectContaining({
        correlationId: 'req-rerun',
        payload: expect.objectContaining({ code: 'TRANSFORM_RULE_NO_FIELD' }),
      }),
    ]);
    nothingStarted();
  });

  it.each(['schedule', 'pipeline'] as const)(
    'refuses a run of a %s before Production Guard is asked, with the code',
    async (origin) => {
      await expect(
        handler.executeScheduled(configWith(FIELDLESS) as unknown as SyncConfig, origin),
      ).rejects.toMatchObject({
        message: `${WORDS} Nothing was read or written.`,
        code: 'TRANSFORM_RULE_NO_FIELD',
      });
      nothingStarted();
    },
  );

  it('names every rule without a field, of every object, once', async () => {
    const config = configWith([...FIELDLESS, ...FIELDLESS, { type: 'trim', config: {} }]);
    const objects = config.objects as Array<Record<string, unknown>>;
    objects.push({
      ...objects[0],
      objectApiName: 'Contact',
      insertOrder: 1,
      transformRules: [{ type: 'prefix', field: 'LastName', config: { prefix: 'X-' } }],
    });

    await handler.handle(
      inboundRequest({
        id: 'req-2',
        type: 'sync:execute',
        timestamp: Date.now(),
        payload: { config },
      }),
    );

    expect(posted().find((m) => m.type === 'sync:error')?.payload).toMatchObject({
      rules: [
        { objectApiName: 'Account', type: 'uppercase' },
        { objectApiName: 'Account', type: 'trim' },
      ],
      message: expect.stringMatching(
        /^The rules Uppercase on Account and Trim on Account name no field: open the configuration and pick their fields\./,
      ),
    });
  });

  it('starts a run whose every rule names its field', async () => {
    // The control: the same run, its rule on Name, goes on to Production
    // Guard and to the orgs (here unreachable).
    await handler.handle(
      inboundRequest({
        id: 'req-3',
        type: 'sync:execute',
        timestamp: Date.now(),
        payload: { config: configWith([{ type: 'uppercase', field: 'Name', config: {} }]) },
      }),
    );
    await vi.waitFor(() => expect(mockGetConn).toHaveBeenCalled());

    expect(guardCheck).toHaveBeenCalled();
    expect(posted().some((m) => m.payload.code === 'TRANSFORM_RULE_NO_FIELD')).toBe(false);
  });
});
