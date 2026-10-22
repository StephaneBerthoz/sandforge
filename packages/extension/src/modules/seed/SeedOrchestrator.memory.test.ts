import * as v8 from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, it, expect, vi } from 'vitest';
import type { FieldRule, SeedTemplate } from '@sandforge/shared';
import { SeedOrchestrator } from './SeedOrchestrator';
import type { InsertFn, SeedOrchestratorDependencies } from './SeedOrchestrator';
import { FieldMapper } from './FieldMapper';
import type { FieldMapperDependencies } from './FieldMapper';
import { FakerFallback } from './FakerFallback';

/*
 * One object of three hundred thousand records, with the rules a large org's
 * contact gets by default, through a run that inserts them as they come:
 * what the run holds of them at any time is the slice it is writing and the
 * ids the org gave the slices before, never the object.
 */

const RECORDS = 300_000;
const MB = 1024 * 1024;
/**
 * The most the heap may grow, once collected, while the records go: a slice
 * of ten thousand records and what faker drew for it, and the ids kept —
 * some 40 MB measured. Generated whole, the records took some 215 MB before
 * the first insert.
 */
const MOST_HEAP_MB = 100;

/** The rules of a wide contact: names, addresses, numbers, picks and sequences. */
function contactRules(): FieldRule[] {
  const faker = (fieldApiName: string, fakerMethod: string): FieldRule => ({
    fieldApiName,
    ruleType: 'faker',
    config: { fakerMethod },
  });
  return [
    faker('FirstName', 'firstName'),
    faker('LastName', 'lastName'),
    faker('Email', 'email'),
    faker('Phone', 'phone'),
    faker('MobilePhone', 'phone'),
    faker('Title', 'jobTitle'),
    faker('MailingStreet', 'streetAddress'),
    faker('MailingCity', 'city'),
    faker('MailingPostalCode', 'zipCode'),
    faker('Description', 'sentence'),
    {
      fieldApiName: 'LeadSource',
      ruleType: 'picklist_random',
      config: { picklistValues: ['Web', 'Phone Inquiry', 'Partner Referral', 'Other'] },
    },
    { fieldApiName: 'Code__c', ruleType: 'sequence', config: { sequencePrefix: 'C-' } },
    { fieldApiName: 'Siret__c', ruleType: 'regex', config: { regexPattern: '##############' } },
    { fieldApiName: 'Score__c', ruleType: 'random', config: { minValue: 0, maxValue: 100 } },
  ];
}

/**
 * Run as the extension ships, never under Stryker, whose workers it names
 * (STRYKER_MUTATOR_WORKER): instrumented, the heap holds the counters too.
 */
const describeShipped =
  process.env['STRYKER_MUTATOR_WORKER'] === undefined ? describe : describe.skip;

describeShipped('a seed of one object of three hundred thousand records', () => {
  it('holds a slice of the records at a time, never the object, and writes every one', async () => {
    v8.setFlagsFromString('--expose-gc');
    const collect = runInNewContext('gc') as () => void;
    const heapNow = (): number => {
      collect();
      const { heapUsed, arrayBuffers } = process.memoryUsage();
      return heapUsed + arrayBuffers;
    };
    const flow = { written: 0, most: 0, inserts: 0 };
    // Not a mock, which would keep every slice it was given among its calls.
    const insert: InsertFn = async (_orgId, _objectApiName, rows) => {
      // Measured as the records reach the org: the most the run holds.
      flow.most = Math.max(flow.most, heapNow());
      flow.inserts++;
      const successIds = rows.map((_, i) => `003${String(flow.written + i).padStart(12, '0')}AAA`);
      flow.written += rows.length;
      return { successIds, errors: [] };
    };
    const deps: SeedOrchestratorDependencies = {
      validator: {
        validate: vi.fn().mockReturnValue({ valid: true, errors: [], warnings: [] }),
      } as unknown as SeedOrchestratorDependencies['validator'],
      planBuilder: { build: vi.fn() } as unknown as SeedOrchestratorDependencies['planBuilder'],
      fieldMapper: new FieldMapper({
        aiGenerator: { generate: vi.fn() } as unknown as FieldMapperDependencies['aiGenerator'],
        fakerFallback: new FakerFallback('fr_FR'),
      }),
      referenceLinker: {
        resolveInsertOrder: vi.fn((objects: SeedTemplate['objects']) => objects),
      } as unknown as SeedOrchestratorDependencies['referenceLinker'],
      insert,
      generateId: vi.fn().mockReturnValue('op-1'),
      now: vi.fn().mockReturnValue('2026-10-22T10:00:00Z'),
    };
    const template: SeedTemplate = {
      id: 'tpl',
      name: 'Volume',
      description: '',
      version: 1,
      strategy: 'faker',
      objects: [
        {
          objectApiName: 'Contact',
          recordCount: RECORDS,
          fieldRules: contactRules(),
          excludedFields: [],
          insertOrder: 0,
          batchSize: 200,
        },
      ],
      tags: [],
      createdAt: '2026-10-22T00:00:00Z',
      updatedAt: '2026-10-22T00:00:00Z',
    };
    const before = heapNow();

    const result = await new SeedOrchestrator(deps).execute(template, 'org');

    expect((flow.most - before) / MB).toBeLessThan(MOST_HEAP_MB);
    expect(flow.written).toBe(RECORDS);
    expect(result.objectResults[0]).toMatchObject({ recordsCreated: RECORDS, recordsFailed: 0 });
    expect(flow.inserts).toBe(RECORDS / 10_000);
  }, 300_000);
});
