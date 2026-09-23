import { describe, it, expect, vi, type Mock } from 'vitest';
import type { AuditLogEntry, SalesforceOrg } from '@sandforge/shared';

import { AUDIT_TRAIL_LIMIT, AuditTrailStore, emptyCounts, recordWriteRun } from './auditTrail.js';
import type { AuditDeps, WriteRun } from './auditTrail.js';
import { LineageStore } from './lineage.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';

const TARGET = '00D000000000001AAA';
const SOURCE = '00D000000000002AAA';

/** A ConfigStore over a backend the test keeps, to reopen it as a restart would. */
function openStore(backend = new InMemoryConfigStoreBackend()): ConfigStore {
  const store = new ConfigStore(backend);
  store.initialize();
  return store;
}

function makeDeps(configStore = openStore()): AuditDeps & { log: Mock<(msg: string) => void> } {
  const aliases: Record<string, string> = { [TARGET]: 'target-sandbox', [SOURCE]: 'source-uat' };
  return {
    configStore,
    orgManager: {
      getOrg: (id: string) =>
        aliases[id] ? ({ id, alias: aliases[id] } as unknown as SalesforceOrg) : undefined,
    },
    log: vi.fn(),
  };
}

const entry = (over: Partial<AuditLogEntry> = {}): AuditLogEntry => ({
  id: 'e-1',
  action: 'sync_execute',
  module: 'sync',
  orgId: TARGET,
  details: {},
  timestamp: '2026-09-01T10:00:00.000Z',
  ...over,
});

const run = (over: Partial<WriteRun> = {}): WriteRun => ({
  action: 'forge_execute',
  module: 'forge',
  operationId: 'op-1',
  orgId: TARGET,
  outcome: 'success',
  objects: [{ ...emptyCounts('Account'), created: 3, failed: 1 }],
  source: { origin: 'org', orgId: SOURCE },
  ...over,
});

describe('AuditTrailStore', () => {
  it('lists entries newest first', () => {
    const store = new AuditTrailStore(openStore());
    store.append(entry({ id: 'old' }));
    store.append(entry({ id: 'new' }));

    expect(store.list().entries.map((e) => e.id)).toEqual(['new', 'old']);
  });

  it('keeps the newest entries past its bound and drops the oldest', () => {
    const store = new AuditTrailStore(openStore(), 3);
    for (const id of ['1', '2', '3', '4', '5']) store.append(entry({ id }));

    const page = store.list();
    expect(page.entries.map((e) => e.id)).toEqual(['5', '4', '3']);
    expect(page.total).toBe(3);
  });

  it('is bounded at two thousand entries by default', () => {
    expect(AUDIT_TRAIL_LIMIT).toBe(2_000);
  });

  it('survives a restart: a store reopened over the same backend reads what was written', () => {
    // ConfigStore is globalState in the product; a new instance over the same
    // backend is what the next activation sees.
    const backend = new InMemoryConfigStoreBackend();
    new AuditTrailStore(openStore(backend)).append(entry({ id: 'kept' }));

    const reopened = new AuditTrailStore(openStore(backend));

    expect(reopened.list().entries.map((e) => e.id)).toEqual(['kept']);
  });

  it('filters by module and by org, and says how many match before paging', () => {
    const store = new AuditTrailStore(openStore());
    store.append(entry({ id: 'a', module: 'sync' }));
    store.append(entry({ id: 'b', module: 'forge' }));
    store.append(entry({ id: 'c', module: 'sync', orgId: SOURCE }));
    store.append(entry({ id: 'd', module: 'sync' }));

    const bySync = store.list({ module: 'sync' });
    expect(bySync.entries.map((e) => e.id)).toEqual(['d', 'c', 'a']);
    expect(bySync.total).toBe(3);

    const bySyncOnTarget = store.list({ module: 'sync', orgId: TARGET });
    expect(bySyncOnTarget.entries.map((e) => e.id)).toEqual(['d', 'a']);
  });

  it('pages through the matching entries', () => {
    const store = new AuditTrailStore(openStore());
    for (const id of ['1', '2', '3', '4', '5']) store.append(entry({ id }));

    const second = store.list({ offset: 2, limit: 2 });

    expect(second.entries.map((e) => e.id)).toEqual(['3', '2']);
    expect(second.total).toBe(5);
    expect(second.offset).toBe(2);
  });

  it('offers every module and org of the trail, whatever the filter, under the latest alias', () => {
    const store = new AuditTrailStore(openStore());
    store.append(entry({ id: 'a', module: 'sync', orgAlias: 'renamed-before' }));
    store.append(entry({ id: 'b', module: 'forge', orgId: SOURCE, orgAlias: 'source-uat' }));
    store.append(entry({ id: 'c', module: 'sync', orgAlias: 'target-sandbox' }));

    const { facets } = store.list({ module: 'forge' });

    expect(facets.modules).toEqual(['forge', 'sync']);
    expect(facets.orgs).toEqual([
      { orgId: TARGET, orgAlias: 'target-sandbox' },
      { orgId: SOURCE, orgAlias: 'source-uat' },
    ]);
  });

  it('skips a stored value it cannot read instead of handing it to the page', () => {
    const configStore = openStore();
    configStore.set('audit:trail', [{ nonsense: true }, entry({ id: 'fine' }), 'text'], 'audit');

    expect(new AuditTrailStore(configStore).list().entries.map((e) => e.id)).toEqual(['fine']);
  });
});

describe('recordWriteRun', () => {
  it('records one entry with the org, its alias, the source, the outcome and the counts', () => {
    const deps = makeDeps();

    recordWriteRun(deps, run({ guard: 'confirmed' }), new Date('2026-09-02T08:00:00.000Z'));

    const [recorded] = new AuditTrailStore(deps.configStore).list().entries;
    expect(recorded).toMatchObject({
      action: 'forge_execute',
      module: 'forge',
      orgId: TARGET,
      orgAlias: 'target-sandbox',
      sourceOrgId: SOURCE,
      sourceOrgAlias: 'source-uat',
      operationId: 'op-1',
      outcome: 'success',
      guard: 'confirmed',
      objects: [{ objectApiName: 'Account', created: 3, updated: 0, deleted: 0, failed: 1 }],
      timestamp: '2026-09-02T08:00:00.000Z',
    });
    expect(typeof recorded.id).toBe('string');
  });

  it('keeps the lineage of a run that carried records: source, one node per object, target', () => {
    const deps = makeDeps();

    recordWriteRun(deps, run());

    const lineage = new LineageStore(deps.configStore).get('op-1');
    expect(lineage?.nodes.map((n) => [n.type, n.label, n.recordCount])).toEqual([
      ['source', 'source-uat', undefined],
      ['object', 'Account', 3],
      ['destination', 'target-sandbox', undefined],
    ]);
  });

  it('counts the lineage from the run’s own id map when it hands one over', () => {
    const deps = makeDeps();

    recordWriteRun(deps, run({ carried: { Account: 5 } }));

    const lineage = new LineageStore(deps.configStore).get('op-1');
    expect(lineage?.nodes.find((n) => n.type === 'object')?.recordCount).toBe(5);
  });

  it('keeps no lineage for a run the guard stopped: nothing moved', () => {
    const deps = makeDeps();

    recordWriteRun(
      deps,
      run({ outcome: 'stopped', guard: 'refused', objects: [], source: undefined }),
    );

    expect(new AuditTrailStore(deps.configStore).list().entries[0]).toMatchObject({
      outcome: 'stopped',
      guard: 'refused',
      objects: [],
    });
    expect(new LineageStore(deps.configStore).get()).toBeNull();
  });

  describe('with sandforge.safety.auditLogging off', () => {
    /** Settings where the switch reads `value`. */
    const settings = (value: boolean): AuditDeps['services'] => ({
      getSandforgeSetting: <T>(key: string, fallback: T): T =>
        (key === 'safety.auditLogging' ? value : fallback) as T,
    });

    it('records a run without the decision the guard took about it', () => {
      const deps = { ...makeDeps(), services: settings(false) };

      recordWriteRun(deps, run({ guard: 'confirmed' }));

      const [recorded] = new AuditTrailStore(deps.configStore).list().entries;
      expect(recorded.outcome).toBe('success');
      expect(recorded).not.toHaveProperty('guard');
    });

    it('records nothing of a run the guard stopped: it was only a decision', () => {
      const deps = { ...makeDeps(), services: settings(false) };

      recordWriteRun(deps, run({ outcome: 'stopped', guard: 'refused', objects: [] }));

      expect(new AuditTrailStore(deps.configStore).list().total).toBe(0);
    });

    it('keeps both when the switch is on, as it is by default', () => {
      const deps = { ...makeDeps(), services: settings(true) };

      recordWriteRun(deps, run({ outcome: 'stopped', guard: 'refused', objects: [] }));

      expect(new AuditTrailStore(deps.configStore).list().entries[0].guard).toBe('refused');
    });
  });

  it('logs a store that cannot be written instead of failing the run it records', () => {
    const deps = makeDeps();
    deps.configStore = {
      get: () => undefined,
      set: () => {
        throw new Error('disk full');
      },
    };

    expect(() => recordWriteRun(deps, run())).not.toThrow();
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('disk full'));
  });
});
