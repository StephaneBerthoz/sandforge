import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import type { BaseMessage } from '@sandforge/shared';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
  connectionAnnouncing: vi.fn(),
}));

import {
  connectionAnnouncing,
  getJsforceConnection,
} from '../../core/connection/ConnectionHelper.js';
import { clearDescribeCache } from '../../core/connection/describeCache.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import {
  SubscriptionRefused,
  type CometdTransport,
} from '../../modules/realtime/cometdTransport.js';
import type { DescribedField, OrgReader } from '../../modules/realtime/RealtimeApplier.js';
import {
  SyncRunCreations,
  type SyncRunCreationsDeps,
} from '../../modules/sync/SyncRunCreations.js';
import { overwriteBackupIdOf } from '../../modules/sync/syncOverwrites.js';
import { createMockBroker, inboundRequest } from '../../test/mockFactories.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes';
import { liveOrgAccess, RealtimeHandler, type RealtimeOrgAccess } from './RealtimeHandler';

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const SOURCE_LEAD = fakeId('00Q', 1);
/** The lead the target holds under the key `K1`, and one it never held, created by an upsert. */
const TARGET_LEAD = fakeId('00Q', 2);
const MADE = fakeId('00Q', 3);

const STORAGE = path.join(path.sep, 'storage');

/** A disk in memory, as the runs' store writes it. */
function memoryRuns(): SyncRunCreations {
  const files = new Map<string, string>();
  const deps: SyncRunCreationsDeps = {
    storagePath: STORAGE,
    readFile: async (filePath) => {
      const text = files.get(filePath);
      if (text === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return text;
    },
    writeFile: async (filePath, content) => {
      files.set(filePath, content);
    },
    appendFile: async (filePath, content) => {
      files.set(filePath, (files.get(filePath) ?? '') + content);
    },
    rename: async (from, to) => {
      files.set(to, files.get(from) ?? '');
      files.delete(from);
    },
    mkdir: async () => undefined,
    rm: async (filePath) => {
      files.delete(filePath);
    },
    listFiles: async (dirPath) =>
      [...files]
        .filter(([filePath]) => path.dirname(filePath) === dirPath)
        .map(([filePath, text]) => ({ name: path.basename(filePath), size: text.length })),
  };
  return new SyncRunCreations(deps);
}

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
  { name: 'Ext__c', type: 'string', createable: true, updateable: true, externalId: true },
  { name: 'Title', type: 'string', createable: true, updateable: true },
  { name: 'LastModifiedDate', type: 'datetime', createable: false, updateable: false },
];

/** An org answering `SELECT … FROM Lead WHERE <field> IN (…)` from memory. */
function memoryReader(rows: Array<Record<string, unknown>>): OrgReader {
  return {
    async query(soql) {
      if (soql === 'SELECT PermissionsViewEncryptedData FROM UserPermissionAccess') {
        return [{ PermissionsViewEncryptedData: true }];
      }
      const match = /FROM Lead WHERE (\w+) IN \((.*)\)/.exec(soql);
      if (!match) throw new Error(`unexpected query: ${soql}`);
      const values = match[2].split(', ').map((v) => v.replace(/^'|'$/g, ''));
      return rows.filter((row) => values.includes(String(row[match[1]])));
    },
    async describe() {
      return { fields: LEAD_FIELDS };
    },
  };
}

/** A CometD connection on which the test sends. */
function fakeTransport() {
  const handlers = new Map<string, (message: unknown) => void>();
  let down: ((reason: string) => void) | undefined;
  const transport: CometdTransport = {
    subscribe: vi.fn(async (channel: string, _from: number, onMessage: (m: unknown) => void) => {
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

function leadChange(replayId: number, changeType: string, values: Record<string, unknown>) {
  return {
    event: { replayId },
    payload: {
      ChangeEventHeader: {
        entityName: 'Lead',
        changeType,
        recordIds: [SOURCE_LEAD],
        commitTimestamp: COMMIT,
        changedFields: Object.keys(values),
      },
      ...values,
    },
  };
}

/**
 * A handler whose sessions write through Sync's own writer, over a target
 * that takes every row: what reaches the target is what the jsforce calls
 * were given.
 */
function setup(options: { targetRows?: Array<Record<string, unknown>> } = {}) {
  const broker = createMockBroker();
  const configStore = memoryConfigStore();
  let n = 0;
  const deps = {
    log: vi.fn(),
    broker,
    configStore,
    orgManager: { getOrg: vi.fn(() => ({ orgType: 'Sandbox' })) },
    orgRegistry: {},
    nextId: () => `ext-${++n}`,
    infraServices: { productionGuard: new ProductionGuard() },
  } as unknown as HandlerDeps;
  const transport = fakeTransport();
  const source = memoryReader([{ Id: SOURCE_LEAD, Ext__c: 'K1' }]);
  const target = memoryReader(
    options.targetRows ?? [
      {
        Id: TARGET_LEAD,
        Ext__c: 'K1',
        Title: 'Old',
        LastModifiedDate: '2026-09-23T09:00:00.000+0000',
      },
    ],
  );
  const sent: string[] = [];
  const sobject = {
    upsert: vi.fn(async (rows: Array<Record<string, unknown>>) => {
      sent.push(`upsert ${rows.map((row) => String(row.Ext__c)).join(',')}`);
      return rows.map((row) =>
        row.Ext__c === 'K1'
          ? { id: TARGET_LEAD, success: true, created: false }
          : { id: MADE, success: true, created: true },
      );
    }),
    destroy: vi.fn(async (ids: string[]) => {
      sent.push(`delete ${ids.join(',')}`);
      return ids.map((id) => ({ id, success: true }));
    }),
  };
  vi.mocked(getJsforceConnection).mockResolvedValue({
    instanceUrl: 'https://target.example.invalid',
    describe: async () => ({
      name: 'Lead',
      createable: true,
      updateable: true,
      fields: LEAD_FIELDS,
    }),
  } as unknown as Awaited<ReturnType<typeof getJsforceConnection>>);
  vi.mocked(connectionAnnouncing).mockResolvedValue({
    sobject: () => sobject,
  } as unknown as Awaited<ReturnType<typeof connectionAnnouncing>>);
  const access: RealtimeOrgAccess = {
    openTransport: vi.fn(async () => transport.transport),
    reader: (orgId: string) => (orgId === 'org-source' ? source : target),
    // Sync's own writer, as the extension's sessions write.
    writer: liveOrgAccess(deps).writer,
    tooling: vi.fn(async () => []),
  };
  const handler = new RealtimeHandler(deps, access);
  const runs = memoryRuns();
  const backups: Array<{ objectApiName: string; records: unknown[] }> = [];
  handler.setRunCreations(runs);
  handler.setBackupRecordStore({
    begin: async () => undefined,
    append: async (_id, objectApiName, records) => {
      backups.push({ objectApiName, records: [...records] });
    },
  });
  const posted = (): Array<BaseMessage & { payload: Record<string, unknown> }> =>
    broker.postToWebview.mock.calls.map(
      ([message]) => message as BaseMessage & { payload: Record<string, unknown> },
    );
  const ofType = (type: string) => posted().filter((m) => m.type === type);
  return { handler, access, transport, runs, backups, sent, ofType, broker };
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
        applyDeletes: true,
      },
    ],
    conflictStrategy: 'source_wins',
    flushIntervalMs: 150,
    maxBatchSize: 100,
    ...overrides,
  });
}

describe('RealtimeHandler — a session keeps what it writes, for its removal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearDescribeCache();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps what a session writes over, with its values from before, and ends it once the session stops', async () => {
    const { handler, transport, runs, backups, sent, ofType } = setup();
    await handler.handle(start());
    const sessionId = String(ofType('realtime:started')[0].payload.sessionId);

    transport.send('/data/LeadChangeEvent', leadChange(7, 'UPDATE', { Title: 'Buyer' }));
    await vi.advanceTimersByTimeAsync(150);

    expect(sent).toEqual(['upsert K1']);
    // Written down as it went: a window closed now leaves it removable.
    expect(await runs.get(sessionId)).toMatchObject({
      runId: sessionId,
      realtime: true,
      overwritten: [
        { objectApiName: 'Lead', backup: overwriteBackupIdOf(sessionId), ids: [TARGET_LEAD] },
      ],
    });
    expect((await runs.get(sessionId))?.end).toBeUndefined();
    expect(backups).toEqual([
      { objectApiName: 'Lead', records: [{ Id: TARGET_LEAD, Title: 'Old' }] },
    ]);
    // Its removal waits while it writes.
    expect(handler.isRunning(sessionId)).toBe(true);

    await handler.handle(request('realtime:stop', { sessionId }));

    expect(handler.isRunning(sessionId)).toBe(false);
    expect((await runs.get(sessionId))?.end).toMatchObject({ status: 'success' });
  });

  it('keeps what a session creates', async () => {
    const { handler, transport, runs, sent, ofType } = setup({ targetRows: [] });
    await handler.handle(start());
    const sessionId = String(ofType('realtime:started')[0].payload.sessionId);

    // A lead the target does not hold, created by the upsert of its key.
    transport.send(
      '/data/LeadChangeEvent',
      leadChange(8, 'CREATE', { Ext__c: 'K2', Title: 'New' }),
    );
    await vi.advanceTimersByTimeAsync(150);
    await handler.handle(request('realtime:stop', { sessionId }));

    expect(sent).toEqual(['upsert K2']);
    expect(await runs.get(sessionId)).toMatchObject({
      created: [{ objectApiName: 'Lead', ids: [MADE] }],
      end: { status: 'success' },
    });
  });

  it('keeps the record a session deletes as the source deleted it, for its removal to bring back', async () => {
    const { handler, transport, runs, sent, ofType } = setup();
    await handler.handle(start());
    const sessionId = String(ofType('realtime:started')[0].payload.sessionId);

    transport.send('/data/LeadChangeEvent', leadChange(9, 'DELETE', {}));
    await vi.advanceTimersByTimeAsync(150);
    await handler.handle(request('realtime:stop', { sessionId }));

    expect(sent).toEqual([`delete ${TARGET_LEAD}`]);
    expect((await runs.get(sessionId))?.deleted).toEqual([
      { objectApiName: 'Lead', ids: [TARGET_LEAD] },
    ]);
  });

  it('says a session stopped from Live Operations was cancelled', async () => {
    const { handler, transport, runs, ofType } = setup();
    const { BackgroundOperationRegistry } =
      await import('../../core/engine/BackgroundOperationRegistry.js');
    const registry = new BackgroundOperationRegistry();
    handler.setRegistry(registry);
    await handler.handle(start());
    const sessionId = String(ofType('realtime:started')[0].payload.sessionId);
    transport.send('/data/LeadChangeEvent', leadChange(7, 'UPDATE', { Title: 'Buyer' }));
    await vi.advanceTimersByTimeAsync(150);

    registry.abort(sessionId);
    await vi.advanceTimersByTimeAsync(0);

    expect(ofType('realtime:stopped')[0].payload.reason).toBe('cancelled');
    expect((await runs.get(sessionId))?.end).toMatchObject({ status: 'success', cancelled: true });
    expect(handler.isRunning(sessionId)).toBe(false);
  });

  it('ends what a session wrote before the page hears it gave up reconnecting', async () => {
    const { handler, access, transport, runs, ofType, broker } = setup();
    await handler.handle(start());
    const sessionId = String(ofType('realtime:started')[0].payload.sessionId);
    transport.send('/data/LeadChangeEvent', leadChange(7, 'UPDATE', { Title: 'Buyer' }));
    await vi.advanceTimersByTimeAsync(150);
    vi.mocked(access.openTransport).mockRejectedValue(new Error('401::Authentication invalid'));
    // The tab lists the session for removal as it hears: by then it is no longer written.
    let writingWhenSaid: boolean | undefined;
    broker.postToWebview.mockImplementation((message: BaseMessage & { payload?: unknown }) => {
      const payload = message.payload as { status?: string } | undefined;
      if (message.type === 'realtime:status:response' && payload?.status === 'error') {
        writingWhenSaid = handler.isRunning(sessionId);
      }
    });

    transport.goDown('401::Authentication invalid');
    await vi.advanceTimersByTimeAsync(45_000);

    expect(writingWhenSaid).toBe(false);
    expect((await runs.get(sessionId))?.end).toMatchObject({ status: 'success' });
    // Stopped after, it writes no second end.
    await handler.handle(request('realtime:stop', { sessionId }));
    expect((await runs.list()).filter((run) => run.runId === sessionId)).toHaveLength(1);
  });

  it('ends what a session wrote as the extension deactivates', async () => {
    const { handler, transport, runs, ofType } = setup();
    await handler.handle(start());
    const sessionId = String(ofType('realtime:started')[0].payload.sessionId);
    transport.send('/data/LeadChangeEvent', leadChange(7, 'UPDATE', { Title: 'Buyer' }));
    await vi.advanceTimersByTimeAsync(150);

    await handler.dispose();

    expect((await runs.get(sessionId))?.end).toMatchObject({ status: 'success' });
  });

  it('keeps nothing of a session that only watches', async () => {
    const { handler, transport, runs, sent, ofType } = setup();
    await handler.handle(start({ apply: [] }));
    const sessionId = String(ofType('realtime:started')[0].payload.sessionId);
    transport.send('/data/LeadChangeEvent', leadChange(7, 'UPDATE', { Title: 'Buyer' }));
    await vi.advanceTimersByTimeAsync(150);

    expect(handler.isRunning(sessionId)).toBe(false);
    await handler.handle(request('realtime:stop', { sessionId }));
    expect(sent).toEqual([]);
    expect(await runs.list()).toEqual([]);
  });

  it('leaves nothing open for a session the source refused', async () => {
    const { handler, access, runs, ofType } = setup();
    const sessionId = '6f1c2a90-0000-4000-8000-000000000001';
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(sessionId);
    vi.mocked(access.openTransport).mockRejectedValue(new Error('INVALID_SESSION_ID'));

    await handler.handle(start());

    expect(ofType('realtime:started')[0].payload).toMatchObject({ success: false });
    expect(await runs.list()).toEqual([]);
    expect(handler.isRunning(sessionId)).toBe(false);
    vi.restoreAllMocks();
  });

  it('leaves nothing open for a session whose every object the source refused', async () => {
    const { handler, transport, runs, ofType } = setup();
    vi.mocked(transport.transport.subscribe).mockRejectedValue(
      new SubscriptionRefused('/data/LeadChangeEvent', '403::User not allowed to subscribe'),
    );

    await handler.handle(start());

    const [started] = ofType('realtime:started');
    expect(started.payload).toMatchObject({ success: false });
    expect(handler.isRunning(String(started.payload.sessionId))).toBe(false);
    expect(await runs.list()).toEqual([]);
  });
});
