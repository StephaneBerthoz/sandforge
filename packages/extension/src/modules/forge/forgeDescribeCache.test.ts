import { describe, it, expect, vi } from 'vitest';
import type { ForgeConfig } from '@sandforge/shared';
import { forgeDescribeCache, FORGE_DESCRIBE_CACHE_ENTRIES } from './forgeDescribeCache.js';
import { GraphDiscoveryService, type ObjectDescribe } from './GraphDiscoveryService.js';
import { countingConnection, describeOf, fakeId, largeOrg } from '../../test/largeOrg.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** A describe of the fake org as discovery reads it. */
function asDiscoveryReads(raw: ReturnType<typeof describeOf>): ObjectDescribe {
  return {
    name: raw.name,
    fields: raw.fields.map((f) => ({
      name: f.name,
      type: f.type,
      referenceTo: f.referenceTo,
      relationshipName: f.relationshipName,
      isMasterDetail: false,
      nillable: f.nillable,
      createable: f.createable,
      updateable: f.updateable,
    })),
    childRelationships: raw.childRelationships.map((child) => ({
      childSObject: child.childSObject,
      field: child.field,
      relationshipName: child.relationshipName,
      isCascadeDelete: child.cascadeDelete,
    })),
  };
}

describe('the describes a Forge cycle shares', () => {
  it('describes each object once per org through discovery, Review and Execute on an org of six hundred objects', async () => {
    // The custom objects under a case hold no row of these cases: each is
    // examined, and takes no place under the cap, as a root's empty children
    // do in a real org.
    const org = largeOrg({ cases: 12, rowsPerCase: 0 });
    const { conn } = countingConnection(org);
    const cache = forgeDescribeCache<ObjectDescribe>();
    /** Describes asked of each org, by object. */
    const asked = new Map<string, number>();
    // As the composition's `describeOnce` reads them: from the cache, or
    // from the org once and kept.
    const describeOnce = async (orgId: string, objectApiName: string): Promise<ObjectDescribe> => {
      const key = `${orgId}::${objectApiName}`;
      const held = cache.get(key);
      if (held) return held;
      asked.set(key, (asked.get(key) ?? 0) + 1);
      const described = asDiscoveryReads(await conn.describe(objectApiName));
      cache.set(key, described);
      return described;
    };
    const discovery = new GraphDiscoveryService({
      describeObject: describeOnce,
      queryCount: async (_orgId, soql) => (await conn.query(soql)).totalSize,
      detectPII: () => [],
      describeGlobal: async () =>
        (await conn.describeGlobal()).sobjects.map((o) => ({
          name: o.name,
          keyPrefix: o.keyPrefix,
        })),
    });
    const config: ForgeConfig = {
      inputMode: 'record',
      recordId: fakeId(org, 'Case', 1),
      depth: 'full',
      sourceOrgId: 'src',
      targetOrgId: 'tgt',
      anonymizePII: false,
      skipEmpty: false,
      batchSize: 'auto',
    };

    const graph = await discovery.discover(config, { maxNodes: 50 });
    const examined = asked.size;
    // Review's metadata diff and gap reader, then the executor: the included
    // nodes of both orgs, the source's root and first wave first.
    const included = graph.nodes.filter((node) => node.included).map((n) => n.objectApiName);
    for (const object of included) await describeOnce('src', object);
    for (const object of included) await describeOnce('tgt', object);
    for (const object of included) await describeOnce('src', object);

    // Discovery examines up to four times its cap: more than the hundred
    // entries the cache held, which dropped the root first.
    expect(examined).toBeGreaterThan(100);
    expect(included.length).toBeGreaterThan(1);
    expect([...asked.values()].every((count) => count === 1)).toBe(true);
    expect(asked.size).toBe(examined + included.length);
    expect(asked.size).toBeLessThanOrEqual(FORGE_DESCRIBE_CACHE_ENTRIES);
  });
});
