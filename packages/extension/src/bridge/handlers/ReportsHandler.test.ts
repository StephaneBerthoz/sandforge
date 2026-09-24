import { describe, it, expect, vi } from 'vitest';
import type {
  BaseMessage,
  ForgeExecutionResult,
  SalesforceOrg,
  SyncHistoryEntry,
} from '@sandforge/shared';

import { ReportsHandler, summarise } from './ReportsHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import { inboundRequest } from '../../test/mockFactories.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { emptyCounts, recordWriteRun } from '../../modules/audit/auditTrail.js';
import type { WriteRun } from '../../modules/audit/auditTrail.js';

type Deps = Pick<HandlerDeps, 'nextId' | 'broker' | 'log' | 'configStore'>;

/** A store holding exactly what Forge and Sync write today. */
function makeDeps(store: Record<string, unknown>): {
  deps: Deps;
  posted: BaseMessage[];
} {
  const posted: BaseMessage[] = [];
  const deps = {
    nextId: () => 'resp-1',
    log: vi.fn(),
    broker: { postToWebview: (m: BaseMessage) => posted.push(m) },
    configStore: { get: (key: string) => store[key] },
  } as unknown as Deps;
  return { deps, posted };
}

const forgeRun = (over: Partial<ForgeExecutionResult> = {}): ForgeExecutionResult =>
  ({
    forgeId: 'f-1',
    status: 'success',
    duration: 4_000,
    timestamp: '2026-09-02T10:00:00.000Z',
    idRemapCount: 12,
    graph: { nodes: [{ recordCount: 30 }, { recordCount: 12 }] },
    ...over,
  }) as unknown as ForgeExecutionResult;

const syncRun = (over: Partial<SyncHistoryEntry> = {}): SyncHistoryEntry =>
  ({
    id: 's-1',
    configSnapshot: { name: 'Nightly refresh' },
    result: {
      status: 'completed',
      totalProcessed: 120,
      totalSuccess: 118,
      totalFailed: 2,
      duration: 9_000,
    },
    startTime: '2026-09-03T10:00:00.000Z',
    endTime: '2026-09-03T10:00:09.000Z',
    triggeredBy: 'manual',
    ...over,
  }) as unknown as SyncHistoryEntry;

const listMsg = (payload?: Record<string, unknown>): InboundRequest =>
  inboundRequest({
    id: 'req-1',
    type: 'reports:list',
    timestamp: 1,
    payload,
  } as BaseMessage);

describe('ReportsHandler', () => {
  it('builds reports from the history Forge and Sync already keep', async () => {
    // The module shipped with no producer and printed 0 / 0 / 0.0% / 0 — read
    // as a measurement rather than as an absent feature. The data was there
    // the whole time, under these two keys.
    const { deps, posted } = makeDeps({
      'forge:history': [forgeRun()],
      'sync:history:all': [syncRun()],
    });

    await new ReportsHandler(deps).handle(listMsg());

    const payload = (posted[0] as BaseMessage & { payload: { reports: unknown[] } }).payload;
    expect(posted[0].type).toBe('reports:list:response');
    expect(payload.reports).toHaveLength(2);
  });

  it('orders newest first, across both modules', async () => {
    const { deps, posted } = makeDeps({
      'forge:history': [forgeRun({ forgeId: 'old', timestamp: '2026-01-01T00:00:00.000Z' })],
      'sync:history:all': [syncRun({ id: 'new', endTime: '2026-09-09T00:00:00.000Z' })],
    });

    await new ReportsHandler(deps).handle(listMsg());

    const { reports } = (posted[0] as BaseMessage & { payload: { reports: { id: string }[] } })
      .payload;
    expect(reports.map((r) => r.id)).toEqual(['sync-new', 'forge-old']);
  });

  it('counts the records a Forge run read, not the rows discovery counted in the tables of its graph', () => {
    // The graph's counts are of whole tables: the clone of one account and
    // two of its contacts read 3 rows of the 42 its two tables held.
    const { deps } = makeDeps({
      'forge:history': [
        forgeRun({
          readByObject: [
            { objectApiName: 'Account', read: 1 },
            { objectApiName: 'Contact', read: 2 },
          ],
        }),
      ],
    });

    const [report] = new ReportsHandler(deps).build().reports;

    expect(report.metadata.recordCount).toBe(3);
    expect(report.summary).toContain('3 record(s) across 2 object(s)');
    expect(report.sections[0].content).toMatchObject({ records: 3 });
  });

  it('counts a Forge run recorded before it said what it read from its graph, as it did', () => {
    const { deps } = makeDeps({ 'forge:history': [forgeRun()] });

    const [report] = new ReportsHandler(deps).build().reports;

    expect(report.metadata.recordCount).toBe(42);
  });

  it('answers with an empty list — not an error — when nothing has run', async () => {
    // "No runs yet" is a measurement. It is only honest because the page now
    // has a producer: the same zeros used to mean "no feature".
    const { deps, posted } = makeDeps({});

    await new ReportsHandler(deps).handle(listMsg());

    const payload = (
      posted[0] as BaseMessage & {
        payload: { reports: unknown[]; summary: { totalOperations: number } };
      }
    ).payload;
    expect(payload.reports).toEqual([]);
    expect(payload.summary.totalOperations).toBe(0);
  });

  it('bounds the requested limit instead of trusting it', async () => {
    const { deps, posted } = makeDeps({
      'forge:history': Array.from({ length: 10 }, (_, i) =>
        forgeRun({
          forgeId: `f-${i}`,
          timestamp: `2026-09-0${(i % 9) + 1}T00:00:00.000Z`,
        }),
      ),
    });

    await new ReportsHandler(deps).handle(listMsg({ limit: 3 }));

    expect(
      (posted[0] as BaseMessage & { payload: { reports: unknown[] } }).payload.reports,
    ).toHaveLength(3);
  });

  it('ignores a limit that is not a usable number', async () => {
    const { deps, posted } = makeDeps({ 'forge:history': [forgeRun()] });

    await new ReportsHandler(deps).handle(listMsg({ limit: -4 }));

    expect(
      (posted[0] as BaseMessage & { payload: { reports: unknown[] } }).payload.reports,
    ).toHaveLength(1);
  });

  it('leaves messages it does not own alone', async () => {
    const { deps, posted } = makeDeps({});
    const handled = await new ReportsHandler(deps).handle(
      inboundRequest({
        id: 'x',
        type: 'org:list',
        timestamp: 1,
      } as BaseMessage),
    );

    expect(handled).toBe(false);
    expect(posted).toHaveLength(0);
  });
});

describe('ReportsHandler — audit trail and lineage', () => {
  const TARGET = '00D000000000001AAA';
  const SOURCE = '00D000000000002AAA';

  /** A real store, so what a write path records is what the handler reads. */
  function makeRecordingDeps(): { deps: Deps; posted: BaseMessage[]; store: ConfigStore } {
    const store = new ConfigStore(new InMemoryConfigStoreBackend());
    store.initialize();
    const posted: BaseMessage[] = [];
    const deps = {
      nextId: () => 'resp-1',
      log: vi.fn(),
      broker: { postToWebview: (m: BaseMessage) => posted.push(m) },
      configStore: store,
    } as unknown as Deps;
    return { deps, posted, store };
  }

  /** Record a run the way every write path does when it ends. */
  function recordRun(store: ConfigStore, over: Partial<WriteRun> = {}): void {
    recordWriteRun(
      {
        configStore: store,
        orgManager: {
          getOrg: (id: string) =>
            id === TARGET
              ? ({ id, alias: 'target-sandbox' } as unknown as SalesforceOrg)
              : undefined,
        },
        log: vi.fn(),
      },
      {
        action: 'sync_execute',
        module: 'sync',
        operationId: 'op-1',
        orgId: TARGET,
        outcome: 'success',
        objects: [{ ...emptyCounts('Account'), created: 2 }],
        source: { origin: 'org', orgId: SOURCE },
        ...over,
      },
    );
  }

  const request = (type: string, payload?: unknown): InboundRequest =>
    inboundRequest({
      id: 'req-2',
      type,
      timestamp: 1,
      ...(payload !== undefined ? { payload } : {}),
    } as BaseMessage);

  type AuditPayload = {
    entries: Array<{ operationId?: string; module: string }>;
    total: number;
    facets: { modules: string[] };
  };

  it('answers reports:audit with the recorded runs, newest first, correlated to the request', async () => {
    const { deps, posted, store } = makeRecordingDeps();
    recordRun(store, { operationId: 'first' });
    recordRun(store, { operationId: 'second' });

    await new ReportsHandler(deps).handle(request('reports:audit'));

    expect(posted[0].type).toBe('reports:audit:response');
    expect(posted[0].correlationId).toBe('req-2');
    const payload = (posted[0] as BaseMessage & { payload: AuditPayload }).payload;
    expect(payload.entries.map((e) => e.operationId)).toEqual(['second', 'first']);
    expect(payload.total).toBe(2);
  });

  it('filters the trail by module and pages it', async () => {
    const { deps, posted, store } = makeRecordingDeps();
    recordRun(store, { operationId: 's-1' });
    recordRun(store, { operationId: 'f-1', module: 'forge', action: 'forge_execute' });
    recordRun(store, { operationId: 's-2' });

    await new ReportsHandler(deps).handle(
      request('reports:audit', { module: 'sync', offset: 1, limit: 1 }),
    );

    const payload = (posted[0] as BaseMessage & { payload: AuditPayload }).payload;
    expect(payload.entries.map((e) => e.operationId)).toEqual(['s-1']);
    expect(payload.total).toBe(2);
    expect(payload.facets.modules).toEqual(['forge', 'sync']);
  });

  it('answers an install with nothing recorded with an empty trail, not an error', async () => {
    const { deps, posted } = makeRecordingDeps();

    await new ReportsHandler(deps).handle(request('reports:audit'));

    const payload = (posted[0] as BaseMessage & { payload: AuditPayload }).payload;
    expect(payload).toMatchObject({ entries: [], total: 0 });
  });

  it('refuses a malformed audit request on reports:error instead of reading it', async () => {
    const { deps, posted } = makeRecordingDeps();

    await new ReportsHandler(deps).handle(request('reports:audit', { limit: -1 }));

    expect(posted).toHaveLength(1);
    expect(posted[0].type).toBe('reports:error');
    expect((posted[0] as BaseMessage & { payload: { code: string } }).payload.code).toBe(
      'INVALID_PAYLOAD',
    );
  });

  it('answers reports:lineage with the latest run’s graph and the runs one is kept for', async () => {
    const { deps, posted, store } = makeRecordingDeps();
    recordRun(store, { operationId: 'first' });
    recordRun(store, { operationId: 'second' });

    await new ReportsHandler(deps).handle(request('reports:lineage'));

    expect(posted[0].type).toBe('reports:lineage:response');
    const payload = (
      posted[0] as BaseMessage & {
        payload: {
          lineage: { operationId: string; nodes: Array<{ label: string }> } | null;
          runs: Array<{ operationId: string }>;
        };
      }
    ).payload;
    expect(payload.lineage?.operationId).toBe('second');
    expect(payload.lineage?.nodes.map((n) => n.label)).toEqual([
      SOURCE,
      'Account',
      'target-sandbox',
    ]);
    expect(payload.runs.map((r) => r.operationId)).toEqual(['second', 'first']);
  });

  it('answers the lineage of the run asked for, and null for one it does not keep', async () => {
    const { deps, posted, store } = makeRecordingDeps();
    recordRun(store, { operationId: 'first' });
    recordRun(store, { operationId: 'second' });

    await new ReportsHandler(deps).handle(request('reports:lineage', { operationId: 'first' }));
    await new ReportsHandler(deps).handle(request('reports:lineage', { operationId: 'gone' }));

    const [asked, missing] = posted as Array<
      BaseMessage & { payload: { lineage: { operationId: string } | null } }
    >;
    expect(asked.payload.lineage?.operationId).toBe('first');
    expect(missing.payload.lineage).toBeNull();
  });
});

describe('summarise', () => {
  it('computes the KPI row from the reports it sits above', () => {
    // Not tracked separately: a total that can disagree with the list under it
    // is the failure this module is recovering from.
    const { deps } = makeDeps({
      'forge:history': [
        forgeRun({ forgeId: 'ok', status: 'success', duration: 1_000 }),
        forgeRun({ forgeId: 'bad', status: 'failure', duration: 3_000 }),
      ],
    });
    const { reports, summary } = new ReportsHandler(deps).build();

    expect(reports).toHaveLength(2);
    expect(summary).toEqual({
      totalOperations: 2,
      successRate: 50,
      avgDuration: 2_000,
      errorRate: 50,
    });
  });

  it('counts a partial run as a failure, because it is not a success', () => {
    const { deps } = makeDeps({
      'forge:history': [forgeRun({ status: 'partial', duration: 500 })],
    });
    expect(new ReportsHandler(deps).build().summary.errorRate).toBe(100);
  });

  it('gives zeros for an empty list rather than dividing by nothing', () => {
    expect(summarise([])).toEqual({
      totalOperations: 0,
      successRate: 0,
      avgDuration: 0,
      errorRate: 0,
    });
  });
});
