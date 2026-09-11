import { describe, it, expect, vi } from 'vitest';
import type { BaseMessage, ForgeExecutionResult, SyncHistoryEntry } from '@sandforge/shared';

import { ReportsHandler, summarise } from './ReportsHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import { inboundRequest } from '../../test/mockFactories.js';

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
