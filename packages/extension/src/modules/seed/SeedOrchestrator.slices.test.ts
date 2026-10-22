import { describe, it, expect, vi } from 'vitest';
import type { SeedTemplate } from '@sandforge/shared';
import {
  SEED_SLICE_RECORDS,
  SEED_SLICE_VALUES,
  SeedOrchestrator,
  seedSliceOf,
} from './SeedOrchestrator';
import type { InsertFn, SeedOrchestratorDependencies } from './SeedOrchestrator';
import { SeedGrappeAdapter } from './SeedGrappeAdapter';
import { FieldMapper } from './FieldMapper';
import type { FieldMapperDependencies } from './FieldMapper';
import { FakerFallback } from './FakerFallback';

/*
 * A seed generates an object a slice at a time, each slice only once the one
 * before has been written: every record of an object used to be generated
 * before its first insert, and a seed of a few hundred thousand records of a
 * wide object ran the extension host out of memory under the million the
 * host takes.
 */

/** An id of `prefix`, the `n`-th. */
const idOf = (prefix: string, n: number): string => `${prefix}${String(n).padStart(15, '0')}`;

/** The deps of a run whose inserts are kept, with a real field mapper. */
function depsKeepingInserts(signal?: AbortSignal) {
  const inserted: Array<{ objectApiName: string; rows: Array<Record<string, unknown>> }> = [];
  const counters = new Map<string, number>();
  const insert = vi.fn<InsertFn>(async (_orgId, objectApiName, rows) => {
    inserted.push({ objectApiName, rows });
    const prefix = objectApiName === 'Account' ? '001' : '003';
    const at = counters.get(objectApiName) ?? 0;
    counters.set(objectApiName, at + rows.length);
    return { successIds: rows.map((_, i) => idOf(prefix, at + i)), errors: [] };
  });
  const fieldMapper = new FieldMapper({
    aiGenerator: { generate: vi.fn() } as unknown as FieldMapperDependencies['aiGenerator'],
    fakerFallback: new FakerFallback(),
  });
  const deps: SeedOrchestratorDependencies = {
    validator: {
      validate: vi.fn().mockReturnValue({ valid: true, errors: [], warnings: [] }),
    } as unknown as SeedOrchestratorDependencies['validator'],
    planBuilder: { build: vi.fn() } as unknown as SeedOrchestratorDependencies['planBuilder'],
    fieldMapper,
    referenceLinker: {
      resolveInsertOrder: vi.fn((objects: SeedTemplate['objects']) => objects),
    } as unknown as SeedOrchestratorDependencies['referenceLinker'],
    insert,
    generateId: vi.fn().mockReturnValue('op-1'),
    now: vi.fn().mockReturnValue('2026-10-22T10:00:00Z'),
    ...(signal ? { signal } : {}),
  };
  return { deps, inserted, insert, fieldMapper };
}

/** A template of `contacts` contacts numbered by a sequence, under `accounts` accounts each given 1 000. */
function template(contacts: number, accounts = 0): SeedTemplate {
  return {
    id: 'tpl',
    name: 'Volume',
    description: '',
    version: 1,
    strategy: 'faker',
    objects: [
      ...(accounts > 0
        ? [
            {
              objectApiName: 'Account',
              recordCount: accounts,
              fieldRules: [
                { fieldApiName: 'Name', ruleType: 'static' as const, config: { staticValue: 'A' } },
              ],
              excludedFields: [],
              insertOrder: 0,
              batchSize: 200,
            },
          ]
        : []),
      {
        objectApiName: 'Contact',
        recordCount: contacts,
        fieldRules: [
          {
            fieldApiName: 'LastName',
            ruleType: 'sequence',
            config: { sequencePrefix: 'C-', sequenceStart: 1 },
          },
          { fieldApiName: 'Code__c', ruleType: 'regex', config: { regexPattern: 'K######' } },
        ],
        excludedFields: [],
        insertOrder: 1,
        batchSize: 200,
      },
    ],
    ...(accounts > 0
      ? {
          relations: [
            {
              childObject: 'Contact',
              lookupField: 'AccountId',
              parentObject: 'Account',
              parents: { kind: 'generated' as const },
              distribution: { mode: 'perParent' as const, count: 1_000 },
            },
          ],
        }
      : {}),
    tags: [],
    createdAt: '2026-10-22T00:00:00Z',
    updatedAt: '2026-10-22T00:00:00Z',
  };
}

describe('a seed of an object larger than one slice', () => {
  it('generates and inserts it ten thousand records at a time, each slice going on from the one before', async () => {
    const { deps, inserted } = depsKeepingInserts();
    const mapFields = vi.spyOn(deps.fieldMapper, 'mapFields');

    const result = await new SeedOrchestrator(deps).execute(template(25_000), 'org');

    expect(SEED_SLICE_RECORDS).toBe(10_000);
    expect(inserted.map((call) => call.rows.length)).toEqual([10_000, 10_000, 5_000]);
    expect(mapFields.mock.calls.map((call) => [call[0].recordCount, call[3]])).toEqual([
      [10_000, 0],
      [10_000, 10_000],
      [5_000, 20_000],
    ]);
    // The sequence goes on from the slice before, as one generation of all
    // of them numbered them.
    expect(inserted[1]?.rows[0]?.LastName).toBe('C-10001');
    expect(inserted[2]?.rows[4_999]?.LastName).toBe('C-25000');
    expect(result.status).toBe('success');
    expect(result.objectResults[0]).toMatchObject({
      objectApiName: 'Contact',
      recordsCreated: 25_000,
      recordsFailed: 0,
    });
    expect(result.objectResults[0]?.createdIds).toHaveLength(25_000);
  });

  it('gives each slice of a relation the parents placed after the slice before', async () => {
    const { deps, inserted } = depsKeepingInserts();

    await new SeedOrchestrator(deps).execute(template(25_000, 25), 'org');

    const contacts = inserted.filter((call) => call.objectApiName === 'Contact');
    expect(contacts.map((call) => call.rows.length)).toEqual([10_000, 10_000, 5_000]);
    // A thousand children a parent: the second slice starts at the eleventh.
    expect(contacts[1]?.rows[0]?.AccountId).toBe(idOf('001', 10));
    expect(contacts[2]?.rows[4_999]?.AccountId).toBe(idOf('001', 24));
  });

  it('keeps what the slices before a cancel wrote, and says the run was cancelled', async () => {
    const stop = new AbortController();
    const { deps, inserted, insert } = depsKeepingInserts(stop.signal);
    const write = insert.getMockImplementation();
    insert.mockImplementation(async (...args) => {
      const answer = await write?.(...args);
      stop.abort();
      return answer ?? { successIds: [], errors: [] };
    });

    const result = await new SeedOrchestrator(deps).execute(template(25_000), 'org');

    expect(inserted).toHaveLength(1);
    expect(result.cancelled).toBe(true);
    expect(result.status).toBe('partial');
    expect(result.objectResults[0]).toMatchObject({ recordsCreated: 10_000 });
  });

  it('generates a wide object in fewer records at a time, never fewer than a call takes', () => {
    const rules = (count: number) => ({
      fieldRules: Array.from({ length: count }, (_, i) => ({
        fieldApiName: `F${i}__c`,
        ruleType: 'static' as const,
        config: { staticValue: 'x' },
      })),
    });

    expect(seedSliceOf(rules(14))).toBe(SEED_SLICE_RECORDS);
    expect(seedSliceOf(rules(400))).toBe(SEED_SLICE_VALUES / 400);
    expect(seedSliceOf(rules(10_000))).toBe(200);
  });

  it('slices an object of four hundred rules by the values it holds', async () => {
    const { deps, inserted } = depsKeepingInserts();
    const wide = template(3_000);
    const contact = wide.objects[0];
    if (!contact) throw new Error('no contact');
    contact.fieldRules = [
      ...contact.fieldRules,
      ...Array.from({ length: 398 }, (_, i) => ({
        fieldApiName: `Attribute_${i}__c`,
        ruleType: 'static' as const,
        config: { staticValue: 'x' },
      })),
    ];

    await new SeedOrchestrator(deps).execute(wide, 'org');

    expect(inserted.map((call) => call.rows.length)).toEqual([1_250, 1_250, 500]);
  });

  it('generates each partition of a partitioned run just before it is inserted', async () => {
    const { deps, inserted } = depsKeepingInserts();
    const partitioned: SeedOrchestratorDependencies = {
      ...deps,
      grappeAdapter: new SeedGrappeAdapter(() => 'gid', 2_000),
      grappeConfig: {
        enabled: true,
        autoActivateThreshold: 1,
        grappeSize: 2_000,
      } as SeedOrchestratorDependencies['grappeConfig'],
    };
    const order: string[] = [];
    const mapFields = deps.fieldMapper.mapFields.bind(deps.fieldMapper);
    vi.spyOn(deps.fieldMapper, 'mapFields').mockImplementation(async (...args) => {
      order.push(`generate ${args[3] ?? 0}`);
      return mapFields(...args);
    });
    const insert = partitioned.insert;
    partitioned.insert = async (...args) => {
      order.push(`insert ${args[2].length}`);
      return insert(...args);
    };

    const result = await new SeedOrchestrator(partitioned).execute(template(5_000), 'org');

    expect(order).toEqual([
      'generate 0',
      'insert 2000',
      'generate 2000',
      'insert 2000',
      'generate 4000',
      'insert 1000',
    ]);
    expect(inserted[2]?.rows[999]?.LastName).toBe('C-5000');
    expect(result.objectResults[0]).toMatchObject({ recordsCreated: 5_000 });
  });
});
