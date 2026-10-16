import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  BaseMessage,
  FrozenProjectConfig,
  FrozenSelectProgress,
  FrozenSelectionSummary,
} from '@sandforge/shared';
import { FrozenDatasetHandler } from './FrozenDatasetHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import { inboundRequest } from '../../test/mockFactories.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import { PIIDetector } from '../../core/precheck/PIIDetector.js';
import { countingConnection, largeOrg } from '../../test/largeOrg.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

/** The selection request, by its id. */
function selectMsg(id = 'select-1'): InboundRequest {
  return inboundRequest({
    id,
    type: 'frozen:select',
    timestamp: Date.now(),
    payload: { sourceOrgId: 'org-1' },
  } as BaseMessage);
}

/** Handler deps over a saved configuration. */
function depsWith(config: FrozenProjectConfig): HandlerDeps {
  let id = 0;
  const store = new Map<string, unknown>([['frozen:config', config]]);
  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
    stateSync: {} as HandlerDeps['stateSync'],
    orgManager: { getOrg: vi.fn() } as unknown as HandlerDeps['orgManager'],
    orgRegistry: {} as unknown as HandlerDeps['orgRegistry'],
    configStore: {
      get: vi.fn((key: string) => store.get(key)),
      set: vi.fn((key: string, value: unknown) => store.set(key, value)),
    } as unknown as HandlerDeps['configStore'],
    secretVault: {} as unknown as HandlerDeps['secretVault'],
    authProvider: {} as unknown as HandlerDeps['authProvider'],
    sfdxBridge: {} as unknown as HandlerDeps['sfdxBridge'],
    infraServices: { piiDetector: new PIIDetector() } as unknown as HandlerDeps['infraServices'],
    nextId: () => String(++id),
  };
}

/** Every message of a type the handler posted. */
function posted<T>(deps: HandlerDeps, type: string): T[] {
  const calls = (deps.broker.postToWebview as unknown as { mock: { calls: unknown[][] } }).mock
    .calls;
  return calls
    .map((call) => call[0] as { type: string; payload: T })
    .filter((message) => message.type === type)
    .map((message) => message.payload);
}

const sasDirs: string[] = [];

/** A selection of cases by origin over a large org: `values` origins, `candidates` each. */
function caseSelection(
  values: number,
  candidates: number,
  extra: Partial<FrozenProjectConfig> = {},
) {
  const sasDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandforge-frozen-select-'));
  sasDirs.push(sasDir);
  return {
    rootObject: 'Case',
    axes: [
      {
        name: 'origin',
        label: 'Origin',
        filterField: 'Origin',
        valuesSoql: `SELECT Origin axisValue FROM Case GROUP BY Origin LIMIT ${values}`,
      },
    ],
    edgeCases: [],
    budgetMaxRecords: 100_000,
    candidatesPerCombination: candidates,
    maxNodes: 30,
    sasDir,
    ...extra,
  } satisfies FrozenProjectConfig;
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of sasDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('a selection on an org shaped like a large one', () => {
  it('describes each object once for the whole selection, however many candidates it probes', async () => {
    // Every candidate's extraction described every object of the graph again:
    // half the calls of a selection were describes discovery had made.
    const { conn, calls } = countingConnection(largeOrg({ cases: 12 }));
    vi.mocked(getJsforceConnection).mockResolvedValue(conn as never);
    // No candidate holds the object expected: each of the twelve is probed.
    const deps = depsWith(caseSelection(4, 3, { expectedObjects: ['Obj999__c'] }));

    await new FrozenDatasetHandler(deps).handle(selectMsg());

    expect(posted(deps, 'frozen:select:error')).toEqual([]);
    expect(calls.describes.length).toBe(new Set(calls.describes).size);
    expect(calls.describes.length).toBeLessThanOrEqual(4 * 30);
  });

  it('spends a bounded number of calls on each candidate after the first', async () => {
    const run = async (candidates: number): Promise<{ total: number; objects: number }> => {
      const { conn, total } = countingConnection(largeOrg({ cases: 12 }));
      vi.mocked(getJsforceConnection).mockResolvedValue(conn as never);
      const deps = depsWith(caseSelection(1, candidates, { expectedObjects: ['Obj999__c'] }));
      await new FrozenDatasetHandler(deps).handle(selectMsg());
      const [selection] = posted<{ selection: FrozenSelectionSummary }>(
        deps,
        'frozen:select:response',
      );
      expect(selection.selection.uncovered).toHaveLength(1);
      return { total: total(), objects: selection.selection.graph?.objects ?? 0 };
    };

    const one = await run(1);
    const three = await run(3);

    // Each candidate more reads its own dossier: one statement per object of
    // the graph and a few for its parents — no describe, no count.
    const perCandidate = (three.total - one.total) / 2;
    expect(perCandidate).toBeGreaterThan(0);
    expect(perCandidate).toBeLessThanOrEqual(three.objects + 5);
  });

  it('says each step to the panel: the discovery, each combination and candidate, the measure', async () => {
    const { conn } = countingConnection(largeOrg({ cases: 12 }));
    vi.mocked(getJsforceConnection).mockResolvedValue(conn as never);
    const deps = depsWith(caseSelection(2, 1));

    await new FrozenDatasetHandler(deps).handle(selectMsg());

    const steps = posted<FrozenSelectProgress>(deps, 'frozen:select:progress');
    expect(steps[0]).toEqual({ phase: 'axis', axis: 'origin' });
    expect(steps).toContainEqual({
      phase: 'combination',
      combinationKey: 'origin=Phone',
      index: 1,
      of: 2,
    });
    expect(steps).toContainEqual({
      phase: 'candidate',
      combinationKey: 'origin=Web',
      candidate: 1,
      candidates: 1,
    });
    expect(steps.some((step) => step.phase === 'discovery' && (step.objects ?? 0) > 0)).toBe(true);
    expect(steps.at(-1)).toEqual({ phase: 'measure', roots: 2 });
  });

  /**
   * A selection of four origins whose probe of the second — Chat, Email,
   * Phone, Web, in order — never answers, started: resolves once it is
   * probing it.
   */
  async function stuckOnTheSecond(registry?: BackgroundOperationRegistry) {
    const { conn } = countingConnection(largeOrg({ cases: 12 }));
    const stuck = {
      ...conn,
      query: (soql: string) =>
        soql.includes("Origin = 'Email'") ? new Promise<never>(() => {}) : conn.query(soql),
    };
    vi.mocked(getJsforceConnection).mockResolvedValue(stuck as never);
    const deps = depsWith(caseSelection(4, 2));
    const handler = new FrozenDatasetHandler(deps);
    if (registry) handler.setRegistry(registry);
    const done = handler.handle(selectMsg('select-stuck'));
    await vi.waitFor(() =>
      expect(posted<FrozenSelectProgress>(deps, 'frozen:select:progress')).toContainEqual(
        expect.objectContaining({ phase: 'combination', combinationKey: 'origin=Email' }),
      ),
    );
    return { deps, done };
  }

  it('keeps what it decided when its time runs out, and says the combination it was probing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { deps, done } = await stuckOnTheSecond();

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await done;

    expect(posted(deps, 'frozen:select:error')).toEqual([]);
    const [{ selection }] = posted<{ selection: FrozenSelectionSummary }>(
      deps,
      'frozen:select:response',
    );
    expect(selection.combinations.map((c) => c.combinationKey)).toEqual(['origin=Chat']);
    expect(selection.stopped).toEqual({
      reason: 'timeout',
      during: 'combination',
      combinationKey: 'origin=Email',
      notProbed: ['origin=Phone', 'origin=Web'],
    });
    expect(selection.volumetry.summed).toBe(true);
    expect(selection.volumetry.total).toBeGreaterThan(0);
  });

  it('keeps what it decided when it is cancelled, and is listed as cancelled', async () => {
    const registry = new BackgroundOperationRegistry();
    const { deps, done } = await stuckOnTheSecond(registry);

    registry.abort('select-stuck');
    await done;

    const [{ selection }] = posted<{ selection: FrozenSelectionSummary }>(
      deps,
      'frozen:select:response',
    );
    expect(selection.combinations.map((c) => c.combinationKey)).toEqual(['origin=Chat']);
    expect(selection.stopped).toMatchObject({
      reason: 'cancelled',
      combinationKey: 'origin=Email',
    });
  });
});

describe('a dossier on an org shaped like a large one', () => {
  /** The records the selection measured for the one case it kept, per object. */
  async function measuredDossier(): Promise<Record<string, number>> {
    const org = largeOrg({
      customObjects: 8,
      cases: 4,
      fieldService: { assetsPerAccount: 2_000, territories: 3_000 },
    });
    const { conn } = countingConnection(org);
    vi.mocked(getJsforceConnection).mockResolvedValue(conn as never);
    const deps = depsWith(caseSelection(1, 1, { maxNodes: 50 }));

    await new FrozenDatasetHandler(deps).handle(selectMsg());

    expect(posted(deps, 'frozen:select:error')).toEqual([]);
    const [{ selection }] = posted<{ selection: FrozenSelectionSummary }>(
      deps,
      'frozen:select:response',
    );
    expect(selection.combinations).toHaveLength(1);
    return selection.volumetry.measured;
  }

  it('takes a case and what hangs under it, with the account it names and none of the account’s other children', async () => {
    // Run for real, the account a case named brought every policy, asset and
    // feed item of that account: thousands of records for one case.
    const measured = await measuredDossier();

    expect(measured).toMatchObject({ Case: 1, WorkOrder: 1, ServiceAppointment: 1, Account: 1 });
    expect(measured.Asset ?? 0).toBe(0);
  });

  it('takes the territory its appointment is booked in, and none of the tree it belongs to', async () => {
    // Here the territories share their operating hours with every account:
    // read as a parent in scope, a record they share brings the whole tree.
    // Run for real, three cases took 39 540 territories.
    const measured = await measuredDossier();

    expect(measured.ServiceTerritory).toBe(1);
    expect(measured.OperatingHours).toBe(1);
  });
});
