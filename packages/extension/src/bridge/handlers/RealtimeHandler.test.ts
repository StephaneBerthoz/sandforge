import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BaseMessage, SyncConfig, SyncObjectConfig } from '@sandforge/shared';
import { RealtimeHandler, type RealtimeOrgAccess } from './RealtimeHandler';
import { AuditTrailStore } from '../../modules/audit/auditTrail';
import type { ConfigStore } from '../../core/storage/ConfigStore';
import type { HandlerDeps, InboundRequest } from './HandlerTypes';
import { createMockBroker, inboundRequest } from '../../test/mockFactories.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import {
  SubscriptionRefused,
  type CometdTransport,
} from '../../modules/realtime/cometdTransport.js';
import type { DescribedField, OrgReader } from '../../modules/realtime/RealtimeApplier.js';
import type { OperationOutcome } from '../../modules/sync/DataSync.js';

/** Config store held in memory, with the category reads SyncConfigStore makes. */
function memoryConfigStore() {
  const data = new Map<string, { value: string; category: string }>();
  return {
    get: <T>(key: string): T | undefined => {
      const entry = data.get(key);
      return entry ? (JSON.parse(entry.value) as T) : undefined;
    },
    set: <T>(key: string, value: T, category = 'general'): void => {
      data.set(key, { value: JSON.stringify(value), category });
    },
    delete: (key: string): boolean => data.delete(key),
    getByCategory: (category: string): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of data) {
        if (entry.category === category) out[key] = JSON.parse(entry.value);
      }
      return out;
    },
  };
}

const LEAD_FIELDS: DescribedField[] = [
  { name: 'Id', type: 'id', createable: false, updateable: false },
  { name: 'Ext__c', type: 'string', createable: true, updateable: true },
  { name: 'Title', type: 'string', createable: true, updateable: true },
  { name: 'LastModifiedDate', type: 'datetime', createable: false, updateable: false },
];

/** An org answering `SELECT … FROM Lead WHERE <field> IN (…)` from memory. */
function memoryReader(rows: Array<Record<string, unknown>>): OrgReader {
  return {
    async query(soql) {
      const match = /FROM Lead WHERE (\w+) IN \((.*)\)/.exec(soql);
      if (!match) throw new Error(`unexpected query: ${soql}`);
      const values = match[2].split(', ').map((v) => v.replace(/^'|'$/g, ''));
      return rows.filter((row) => values.includes(String(row[match[1]])));
    },
    async describe(objectApiName) {
      if (objectApiName !== 'Lead') throw new Error(`NOT_FOUND: ${objectApiName}`);
      return { fields: [...LEAD_FIELDS, { name: 'Ext__c', externalId: true } as DescribedField] };
    },
  };
}

/** A CometD connection whose channels the test decides, and on which it sends. */
function fakeTransport(refused: Record<string, string> = {}) {
  const handlers = new Map<string, (message: unknown) => void>();
  let down: ((reason: string) => void) | undefined;
  const transport: CometdTransport = {
    subscribe: vi.fn(async (channel: string, _from: number, onMessage: (m: unknown) => void) => {
      if (refused[channel]) throw new SubscriptionRefused(channel, refused[channel]);
      handlers.set(channel, onMessage);
    }),
    onDown: (listener) => {
      down = listener;
    },
    disconnect: vi.fn(),
  };
  return {
    transport,
    send: (channel: string, message: unknown) => handlers.get(channel)?.(message),
    goDown: (reason: string) => down?.(reason),
  };
}

const COMMIT = Date.parse('2026-09-23T10:00:00.000Z');

function leadUpdate(replayId: number, title: string) {
  return {
    event: { replayId },
    payload: {
      ChangeEventHeader: {
        entityName: 'Lead',
        changeType: 'UPDATE',
        recordIds: ['00QSOURCE0000001AA'],
        commitTimestamp: COMMIT,
        changedFields: ['Title'],
      },
      Title: title,
    },
  };
}

function setup(
  options: {
    refused?: Record<string, string>;
    targetRows?: Array<Record<string, unknown>>;
    orgType?: string;
    toolingRows?: Array<Record<string, unknown>>;
    /** Leave the Production Guard unwired, as a host that forgot it would. */
    noGuard?: boolean;
  } = {},
) {
  const broker = createMockBroker();
  const configStore = memoryConfigStore();
  let n = 0;
  const deps = {
    log: vi.fn(),
    broker,
    configStore,
    orgManager: { getOrg: vi.fn(() => ({ orgType: options.orgType ?? 'Sandbox' })) },
    nextId: () => `ext-${++n}`,
    infraServices: options.noGuard ? undefined : { productionGuard: new ProductionGuard() },
  } as unknown as HandlerDeps;
  const transport = fakeTransport(options.refused);
  const source = memoryReader([{ Id: '00QSOURCE0000001AA', Ext__c: 'K1' }]);
  const target = memoryReader(
    options.targetRows ?? [
      {
        Id: '00QTARGET0000001AA',
        Ext__c: 'K1',
        Title: 'Old',
        LastModifiedDate: '2026-09-23T09:00:00.000+0000',
      },
    ],
  );
  const writes: Array<{ config: SyncObjectConfig; records: Record<string, unknown>[] }> = [];
  const access: RealtimeOrgAccess = {
    openTransport: vi.fn(async () => transport.transport),
    reader: vi.fn((orgId: string) => (orgId === 'org-source' ? source : target)),
    writer: vi.fn(() => async (config: SyncObjectConfig, records: Record<string, unknown>[]) => {
      writes.push({ config, records });
      const outcomes: OperationOutcome[] = records.map(() => ({
        id: '00QTARGET0000001AA',
        success: true,
        errors: [],
      }));
      return { outcomes, notes: [] };
    }),
    tooling: vi.fn(async () => options.toolingRows ?? []),
  };
  const handler = new RealtimeHandler(deps, access);
  const posted = (): Array<BaseMessage & { payload: Record<string, unknown> }> =>
    broker.postToWebview.mock.calls.map(
      ([message]) => message as BaseMessage & { payload: Record<string, unknown> },
    );
  const ofType = (type: string) => posted().filter((m) => m.type === type);
  return { handler, access, transport, writes, configStore, ofType };
}

let requestCounter = 0;
function request(type: string, payload?: Record<string, unknown>): InboundRequest {
  return inboundRequest({
    id: `req-${++requestCounter}`,
    type,
    timestamp: Date.now(),
    payload,
  } as BaseMessage);
}

function start(overrides: Record<string, unknown> = {}): InboundRequest {
  return request('realtime:start', {
    sourceOrgId: 'org-source',
    targetOrgId: 'org-target',
    watchedObjects: ['Lead'],
    apply: [
      {
        objectApiName: 'Lead',
        match: { kind: 'externalId', field: 'Ext__c' },
        applyDeletes: false,
      },
    ],
    conflictStrategy: 'source_wins',
    flushIntervalMs: 150,
    maxBatchSize: 100,
    ...overrides,
  });
}

describe('RealtimeHandler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('claims the realtime channels and nothing else', async () => {
    const { handler } = setup();
    expect(await handler.handle(request('sync:execute'))).toBe(false);
    expect(await handler.handle(request('realtime:status'))).toBe(true);
  });

  it('lists the objects the source publishes, from its channel members', async () => {
    const { handler, access, ofType } = setup({
      toolingRows: [
        { EventChannel: 'ActivityEngagementVirtualChannel', SelectedEntity: 'LeadChangeEvent' },
        { EventChannel: 'ActivityEngagementVirtualChannel', SelectedEntity: 'TaskChangeEvent' },
      ],
    });
    const msg = request('realtime:objects', {
      sourceOrgId: 'org-source',
      targetOrgId: 'org-target',
    });

    await handler.handle(msg);

    expect(access.tooling).toHaveBeenCalledWith(
      'org-source',
      'SELECT EventChannel, SelectedEntity FROM PlatformEventChannelMember',
    );
    const [response] = ofType('realtime:objects:response');
    expect(response.correlationId).toBe(msg.id);
    expect(response.payload.objects).toEqual([
      {
        objectApiName: 'Lead',
        channel: 'ActivityEngagementVirtualChannel',
        inTarget: true,
        externalIdFields: ['Ext__c'],
        syncConfigs: [],
      },
      {
        objectApiName: 'Task',
        channel: 'ActivityEngagementVirtualChannel',
        inTarget: false,
        externalIdFields: [],
        syncConfigs: [],
      },
    ]);
  });

  it('answers with the org’s words when it will not say what publishes', async () => {
    const { handler, access, ofType } = setup();
    vi.mocked(access.tooling).mockRejectedValue(
      new Error("sObject type 'PlatformEventChannelMember' is not supported."),
    );
    const msg = request('realtime:objects', {
      sourceOrgId: 'org-source',
      targetOrgId: 'org-target',
    });

    await handler.handle(msg);

    const [error] = ofType('realtime:error');
    expect(error.correlationId).toBe(msg.id);
    expect(error.payload.message).toBe(
      "sObject type 'PlatformEventChannelMember' is not supported.",
    );
  });

  it('refuses a start that watches nothing, before reaching any org', async () => {
    const { handler, access, ofType } = setup();

    await handler.handle(start({ watchedObjects: [], apply: [] }));

    expect(ofType('realtime:error')[0].payload.code).toBe('INVALID_PAYLOAD');
    expect(access.openTransport).not.toHaveBeenCalled();
  });

  it('refuses to apply an object it does not watch', async () => {
    const { handler, ofType } = setup();

    await handler.handle(start({ watchedObjects: ['Task'] }));

    expect(ofType('realtime:error')[0].payload.message).toContain(
      'Every applied object must be watched',
    );
  });

  it('starts a session, and writes a change of the source to the target', async () => {
    const { handler, transport, writes, ofType } = setup({
      refused: {
        '/data/AccountChangeEvent':
          '403::User not allowed to subscribe CDC without required permissions',
      },
    });
    const msg = start({ watchedObjects: ['Lead', 'Account'] });

    await handler.handle(msg);

    const [started] = ofType('realtime:started');
    expect(started.correlationId).toBe(msg.id);
    expect(started.payload).toMatchObject({
      success: true,
      watchedObjects: ['Lead'],
      refused: [
        {
          objectApiName: 'Account',
          reason: '403::User not allowed to subscribe CDC without required permissions',
        },
      ],
      notes: [],
    });
    expect(typeof started.payload.sessionId).toBe('string');

    transport.send('/data/LeadChangeEvent', leadUpdate(7, 'Buyer'));
    await vi.advanceTimersByTimeAsync(150);

    expect(writes).toEqual([
      {
        config: expect.objectContaining({ operation: 'upsert', externalIdField: 'Ext__c' }),
        records: [{ Title: 'Buyer', Ext__c: 'K1' }],
      },
    ]);
    const [batch] = ofType('realtime:events-batch');
    expect(batch.correlationId).toBeUndefined();
    expect(batch.payload.events).toEqual([
      expect.objectContaining({
        replayId: 7,
        objectApiName: 'Lead',
        outcome: 'applied',
        applied: true,
      }),
    ]);

    await handler.handle(request('realtime:metrics'));
    expect(ofType('realtime:metrics:response')[0].payload.metrics).toMatchObject({
      eventsReceived: 1,
      eventsApplied: 1,
    });
  });

  it('says so when the source refuses every watched object', async () => {
    const { handler, ofType } = setup({ refused: { '/data/LeadChangeEvent': '403::refused' } });

    await handler.handle(start());

    expect(ofType('realtime:started')[0].payload).toMatchObject({
      success: false,
      watchedObjects: [],
      refused: [{ objectApiName: 'Lead', reason: '403::refused' }],
    });
  });

  it('runs one session at a time', async () => {
    const { handler, ofType } = setup();
    await handler.handle(start());

    await handler.handle(start());

    const second = ofType('realtime:started')[1];
    expect(second.payload.success).toBe(false);
    expect(String(second.payload.error)).toContain('already running');
  });

  it('writes nothing to a production org the guard will not let it write to', async () => {
    const { handler, access, ofType } = setup({ orgType: 'Production' });

    await handler.handle(
      start({ apply: [{ objectApiName: 'Lead', match: { kind: 'id' }, applyDeletes: true }] }),
    );

    expect(ofType('realtime:started')[0].payload.success).toBe(false);
    expect(access.openTransport).not.toHaveBeenCalled();
  });

  it('refuses a session that writes when no Production Guard is wired', async () => {
    const { handler, access, ofType, configStore } = setup({ noGuard: true });

    await handler.handle(start());

    const [started] = ofType('realtime:started');
    expect(started.payload.success).toBe(false);
    expect(String(started.payload.error)).toContain('Production Guard is not initialized');
    expect(access.openTransport).not.toHaveBeenCalled();
    // Recorded as the guard's own refusals are, with the code that says why.
    expect(new AuditTrailStore(configStore as unknown as ConfigStore).list().entries).toEqual([
      expect.objectContaining({
        action: 'realtime_sync',
        outcome: 'stopped',
        details: { code: 'NOT_INITIALIZED' },
      }),
    ]);
  });

  it('records in the audit trail a session the guard stopped, with its decision', async () => {
    const { handler, configStore } = setup({ orgType: 'Production' });

    await handler.handle(
      start({ apply: [{ objectApiName: 'Lead', match: { kind: 'id' }, applyDeletes: true }] }),
    );

    expect(new AuditTrailStore(configStore as unknown as ConfigStore).list().entries).toEqual([
      expect.objectContaining({
        action: 'realtime_sync',
        orgId: 'org-target',
        outcome: 'stopped',
        guard: 'refused',
      }),
    ]);
  });

  it('records a session that wrote once it stops, as one run of the trail', async () => {
    const { handler, transport, configStore, ofType } = setup();
    const msg = start();
    await handler.handle(msg);
    transport.send('/data/LeadChangeEvent', leadUpdate(7, 'Buyer'));
    await vi.advanceTimersByTimeAsync(150);
    const trail = () => new AuditTrailStore(configStore as unknown as ConfigStore).list().entries;
    // Nothing is recorded while the session runs.
    expect(trail()).toEqual([]);

    const sessionId = String(ofType('realtime:started')[0].payload.sessionId);
    await handler.handle(request('realtime:stop', { sessionId }));

    expect(trail()).toEqual([
      expect.objectContaining({
        action: 'realtime_sync',
        module: 'sync',
        operationId: msg.id,
        orgId: 'org-target',
        sourceOrgId: 'org-source',
        outcome: 'success',
        guard: 'allowed',
      }),
    ]);
  });

  it('refuses a start whose saved mapping is gone', async () => {
    const { handler, ofType } = setup();

    await handler.handle(
      start({
        apply: [
          {
            objectApiName: 'Lead',
            match: { kind: 'syncConfig', configId: 'gone' },
            applyDeletes: false,
          },
        ],
      }),
    );

    expect(String(ofType('realtime:started')[0].payload.error)).toContain('no longer exists');
  });

  it('writes through a saved configuration between the same orgs', async () => {
    const { handler, configStore, transport, writes } = setup();
    const config: SyncConfig = {
      id: 'cfg-1',
      name: 'Leads',
      description: '',
      sourceOrgId: 'org-source',
      targetOrgId: 'org-target',
      direction: 'source_to_target',
      mode: 'full',
      objects: [
        {
          objectApiName: 'Lead',
          operation: 'upsert',
          externalIdField: 'Ext__c',
          fieldMappings: [
            { sourceField: 'Ext__c', targetField: 'Ext__c', type: 'direct' },
            {
              sourceField: 'Title',
              targetField: 'Title',
              type: 'transform',
              transformRules: [{ type: 'uppercase', config: {} }],
            },
          ],
          transformRules: [],
          excludedFields: [],
          addOnFields: [],
          batchSize: 200,
          insertOrder: 1,
        },
      ],
      conflictStrategy: 'source_wins',
      enableRollback: false,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    };
    configStore.set('sync:config:cfg-1', config, 'syncConfigs');

    await handler.handle(
      start({
        apply: [
          {
            objectApiName: 'Lead',
            match: { kind: 'syncConfig', configId: 'cfg-1' },
            applyDeletes: false,
          },
        ],
      }),
    );
    transport.send('/data/LeadChangeEvent', leadUpdate(8, 'buyer'));
    await vi.advanceTimersByTimeAsync(150);

    expect(writes[0].records).toEqual([{ Title: 'BUYER', Ext__c: 'K1' }]);
  });

  it('holds a change that collides with a newer target edit, and applies the decision', async () => {
    const { handler, transport, writes, ofType } = setup({
      targetRows: [
        {
          Id: '00QTARGET0000001AA',
          Ext__c: 'K1',
          Title: 'Edited',
          LastModifiedDate: '2026-09-23T11:00:00.000+0000',
        },
      ],
    });
    await handler.handle(start({ conflictStrategy: 'manual' }));
    transport.send('/data/LeadChangeEvent', leadUpdate(9, 'Buyer'));
    await vi.advanceTimersByTimeAsync(150);

    expect(writes).toEqual([]);
    const [conflict] = ofType('realtime:conflict');
    expect(conflict.payload).toEqual({
      replayId: 9,
      objectApiName: 'Lead',
      recordIds: ['00QSOURCE0000001AA'],
      changeType: 'UPDATE',
      sourceValues: { Title: 'Buyer' },
      targetValues: { Title: 'Edited' },
      targetLastModified: '2026-09-23T11:00:00.000Z',
    });

    const decide = request('realtime:resolve-conflict', {
      conflictId: 'Lead:00QSOURCE0000001AA:9',
      resolution: 'manual',
      fieldResolutions: { Title: { value: 'Agreed', source: 'manual' } },
    });
    await handler.handle(decide);

    const [resolved] = ofType('realtime:conflict-resolved');
    expect(resolved.correlationId).toBe(decide.id);
    expect(resolved.payload).toMatchObject({
      conflictId: 'Lead:00QSOURCE0000001AA:9',
      success: true,
    });
    expect(writes[0].records).toEqual([{ Title: 'Agreed', Ext__c: 'K1' }]);
  });

  it('cannot decide a change once no session holds it', async () => {
    const { handler, ofType } = setup();

    await handler.handle(
      request('realtime:resolve-conflict', { conflictId: 'Lead:00Q:1', resolution: 'source_wins' }),
    );

    expect(ofType('realtime:conflict-resolved')[0].payload).toMatchObject({
      success: false,
      error: expect.stringContaining('No real-time session is running'),
    });
  });

  it('stops the session it is asked to, and keeps its figures', async () => {
    const { handler, transport, ofType } = setup();
    await handler.handle(start());
    const sessionId = String(ofType('realtime:started')[0].payload.sessionId);

    await handler.handle(request('realtime:stop', { sessionId }));

    expect(ofType('realtime:stopped')[0].payload).toEqual({
      sessionId,
      reason: 'stopped',
      success: true,
    });
    expect(transport.transport.disconnect).toHaveBeenCalled();
    await handler.handle(request('realtime:status'));
    expect(ofType('realtime:status:response')[0].payload).toEqual({
      status: 'disconnected',
      watchedObjects: [],
    });
    await handler.handle(request('realtime:metrics'));
    expect(ofType('realtime:metrics:response')[0].payload.metrics).toMatchObject({
      eventsReceived: 0,
    });
  });

  it('answers a stop naming another session with what does run', async () => {
    const { handler, ofType } = setup();
    await handler.handle(start());

    await handler.handle(request('realtime:stop', { sessionId: 'someone-else' }));

    expect(ofType('realtime:stopped')).toEqual([]);
    expect(ofType('realtime:status:response')[0].payload.status).toBe('syncing');
  });

  it('tells the page, uncorrelated, when the source closes the connection', async () => {
    const { handler, transport, ofType } = setup();
    await handler.handle(start());

    transport.goDown('401::Authentication invalid');
    await vi.advanceTimersByTimeAsync(0);

    const [pushed] = ofType('realtime:status:response');
    expect(pushed.correlationId).toBeUndefined();
    expect(pushed.payload).toMatchObject({ status: 'connecting' });
    await handler.dispose();
  });

  it('lists a running session with the background operations, and their cancel stops it', async () => {
    const { handler, transport, ofType } = setup();
    const registry = new BackgroundOperationRegistry();
    handler.setRegistry(registry);
    await handler.handle(start());
    const sessionId = String(ofType('realtime:started')[0].payload.sessionId);

    expect(registry.getActiveOperations().map((op) => op.operationId)).toEqual([sessionId]);

    registry.abort(sessionId);
    await vi.advanceTimersByTimeAsync(0);

    expect(transport.transport.disconnect).toHaveBeenCalled();
    const [stopped] = ofType('realtime:stopped');
    expect(stopped.correlationId).toBeUndefined();
    expect(stopped.payload).toEqual({ sessionId, reason: 'cancelled', success: true });
    await handler.handle(request('realtime:status'));
    expect(ofType('realtime:status:response')[0].payload.status).toBe('disconnected');
  });

  it('hands its writes no cancel: the batch a stopped session is writing is finished', async () => {
    // The writer stops a write between two batches on the cancel it is given,
    // and the session stores its resume point past the whole batch: handed
    // the session's cancel, a stop in the middle of a batch left changes that
    // were never written and would never be replayed.
    const { handler, access } = setup();

    await handler.handle(start());

    expect(access.writer).toHaveBeenCalledWith('org-target');
  });

  it('forgets where an org’s channels were read to', async () => {
    const { handler, configStore } = setup();
    configStore.set('realtime:replay:org-source', { '/data/LeadChangeEvent': 5 }, 'realtime');

    handler.forgetOrg('org-source');

    expect(configStore.get('realtime:replay:org-source')).toBeUndefined();
  });
});
