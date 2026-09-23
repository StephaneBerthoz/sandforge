import { describe, it, expect } from 'vitest';
import type { DataLineageGraph } from '@sandforge/shared';

import { buildLineageGraph, LINEAGE_LIMIT, LineageStore } from './lineage.js';
import type { LineageInput } from './lineage.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';

function openStore(backend = new InMemoryConfigStoreBackend()): ConfigStore {
  const store = new ConfigStore(backend);
  store.initialize();
  return store;
}

const input = (over: Partial<LineageInput> = {}): LineageInput => ({
  operationId: 'op-1',
  module: 'sync',
  action: 'sync_execute',
  source: { origin: 'org', label: 'source-uat', orgId: '00D000000000002AAA' },
  target: { label: 'target-sandbox', orgId: '00D000000000001AAA' },
  objects: [
    { objectApiName: 'Account', records: 4 },
    { objectApiName: 'Contact', records: 9 },
  ],
  generatedAt: '2026-09-02T08:00:00.000Z',
  ...over,
});

const graph = (operationId: string): DataLineageGraph => {
  const built = buildLineageGraph(input({ operationId }));
  if (!built) throw new Error('fixture carried nothing');
  return built;
};

describe('buildLineageGraph', () => {
  it('draws the source, one node per object with its count, and the target', () => {
    const built = buildLineageGraph(input());

    expect(built?.nodes).toEqual([
      {
        id: 'source',
        type: 'source',
        label: 'source-uat',
        origin: 'org',
        orgId: '00D000000000002AAA',
      },
      {
        id: 'object:Account',
        type: 'object',
        label: 'Account',
        objectApiName: 'Account',
        recordCount: 4,
      },
      {
        id: 'object:Contact',
        type: 'object',
        label: 'Contact',
        objectApiName: 'Contact',
        recordCount: 9,
      },
      {
        id: 'target',
        type: 'destination',
        label: 'target-sandbox',
        orgId: '00D000000000001AAA',
        origin: 'org',
      },
    ]);
  });

  it('runs every object from the source to the target, counted on the way in', () => {
    const built = buildLineageGraph(input());

    expect(built?.edges).toEqual([
      { sourceId: 'source', targetId: 'object:Account' },
      { sourceId: 'object:Account', targetId: 'target', recordCount: 4 },
      { sourceId: 'source', targetId: 'object:Contact' },
      { sourceId: 'object:Contact', targetId: 'target', recordCount: 9 },
    ]);
  });

  it('leaves out an object the run carried nothing of', () => {
    const built = buildLineageGraph(
      input({
        objects: [
          { objectApiName: 'Account', records: 4 },
          { objectApiName: 'Case', records: 0 },
        ],
      }),
    );

    expect(built?.nodes.map((n) => n.label)).not.toContain('Case');
  });

  it('draws nothing for a run that carried nothing', () => {
    expect(buildLineageGraph(input({ objects: [{ objectApiName: 'Account', records: 0 }] }))).toBe(
      null,
    );
  });

  it('names the run it traces', () => {
    expect(buildLineageGraph(input())).toMatchObject({
      operationId: 'op-1',
      module: 'sync',
      action: 'sync_execute',
      generatedAt: '2026-09-02T08:00:00.000Z',
    });
  });
});

describe('LineageStore', () => {
  it('answers the latest graph when no run is named, and a named one when it is kept', () => {
    const store = new LineageStore(openStore());
    store.save(graph('op-1'));
    store.save(graph('op-2'));

    expect(store.get()?.operationId).toBe('op-2');
    expect(store.get('op-1')?.operationId).toBe('op-1');
    expect(store.get('op-unknown')).toBeNull();
  });

  it('answers nothing before any run was traced', () => {
    expect(new LineageStore(openStore()).get()).toBeNull();
    expect(new LineageStore(openStore()).runs()).toEqual([]);
  });

  it('keeps one graph per run, the last one saved for it', () => {
    const store = new LineageStore(openStore());
    store.save(graph('op-1'));
    store.save({ ...graph('op-1'), generatedAt: '2026-09-03T00:00:00.000Z' });

    expect(store.runs()).toHaveLength(1);
    expect(store.get('op-1')?.generatedAt).toBe('2026-09-03T00:00:00.000Z');
  });

  it('keeps the newest graphs past its bound', () => {
    const store = new LineageStore(openStore(), 2);
    for (const id of ['op-1', 'op-2', 'op-3']) store.save(graph(id));

    expect(store.runs().map((r) => r.operationId)).toEqual(['op-3', 'op-2']);
    expect(LINEAGE_LIMIT).toBe(100);
  });

  it('lists the runs it keeps, newest first, named by module, action and target', () => {
    const store = new LineageStore(openStore());
    store.save(graph('op-1'));

    expect(store.runs()).toEqual([
      {
        operationId: 'op-1',
        generatedAt: '2026-09-02T08:00:00.000Z',
        module: 'sync',
        action: 'sync_execute',
        targetLabel: 'target-sandbox',
      },
    ]);
  });

  it('survives a restart', () => {
    const backend = new InMemoryConfigStoreBackend();
    new LineageStore(openStore(backend)).save(graph('op-1'));

    expect(new LineageStore(openStore(backend)).get()?.operationId).toBe('op-1');
  });

  it('skips a stored value it cannot read', () => {
    const configStore = openStore();
    configStore.set('lineage:runs', [{ nodes: 'no' }, graph('op-1')], 'lineage');

    expect(new LineageStore(configStore).runs().map((r) => r.operationId)).toEqual(['op-1']);
  });
});
