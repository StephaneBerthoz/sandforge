import { describe, it, expect, vi } from 'vitest';
import type { SeedTemplate } from '@sandforge/shared';
import { SeedOrchestrator } from './SeedOrchestrator';
import type { InsertFn, InsertedRow, SeedOrchestratorDependencies } from './SeedOrchestrator';
import { SeedValidator } from './SeedValidator';
import { DataPlanBuilder } from './DataPlanBuilder';
import { FieldMapper } from './FieldMapper';
import { FakerFallback } from './FakerFallback';
import { AIDataGenerator } from './AIDataGenerator';
import { ReferenceLinker } from './ReferenceLinker';
import { SeedGrappeAdapter } from './SeedGrappeAdapter';

/** The trap org's phone rule: a French number written +33 X XX XX XX XX, nothing else. */
const FRENCH_PHONE = /^\+33 [1-9]( [0-9]{2}){4}$/;

const PHONE_REFUSAL = {
  statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
  message: 'Phone must be written +33 X XX XX XX XX.',
  fields: ['Phone'],
};

/**
 * A target with a phone format rule on its contacts, as a client sandbox and
 * the trap org have: a contact whose phone is written any other way is
 * refused, the rule naming `Phone`. It answers per row, as the REST path does,
 * and keeps every row it was sent.
 */
function phoneRuleTarget(options: { rule?: RegExp; refuseOn?: string } = {}) {
  const sent: Array<{ objectApiName: string; records: Record<string, unknown>[] }> = [];
  let next = 0;
  const insert = vi.fn<InsertFn>(async (_orgId, objectApiName, records) => {
    sent.push({ objectApiName, records: records.map((r) => ({ ...r })) });
    const rows = records.map((record): InsertedRow => {
      const phone = record[options.refuseOn ?? 'Phone'];
      if (
        objectApiName === 'Contact' &&
        typeof phone === 'string' &&
        !(options.rule ?? FRENCH_PHONE).test(phone)
      ) {
        return {
          error: `${PHONE_REFUSAL.statusCode}: ${PHONE_REFUSAL.message}`,
          errorDetails: [{ ...PHONE_REFUSAL, fields: [options.refuseOn ?? 'Phone'] }],
        };
      }
      const prefix = objectApiName === 'Account' ? '001' : '003';
      return { id: `${prefix}${String(++next).padStart(15, '0')}` };
    });
    return {
      successIds: rows.flatMap((r) => (r.id ? [r.id] : [])),
      errors: rows.flatMap((r) => (r.id ? [] : [r.error ?? ''])),
      rows,
    };
  });
  return { insert, sent };
}

function seedDeps(insert: InsertFn): SeedOrchestratorDependencies {
  return {
    validator: new SeedValidator(),
    planBuilder: new DataPlanBuilder(),
    fieldMapper: new FieldMapper({
      aiGenerator: new AIDataGenerator(() => {
        throw new Error('no AI here');
      }),
      fakerFallback: new FakerFallback('en_US'),
    }),
    referenceLinker: new ReferenceLinker(),
    insert,
    generateId: () => 'op-1',
    now: () => '2026-10-17T00:00:00.000Z',
  };
}

/** `--object Contact:10`, as the command line builds it from a describe. */
function contacts(count: number, extra: SeedTemplate['objects'][number]['fieldRules'] = []) {
  return {
    objectApiName: 'Contact',
    recordCount: count,
    fieldRules: [
      { fieldApiName: 'LastName', ruleType: 'faker', config: { fakerMethod: 'lastName' } },
      { fieldApiName: 'Email', ruleType: 'faker', config: { fakerMethod: 'email' } },
      { fieldApiName: 'Phone', ruleType: 'faker', config: { fakerMethod: 'phone' } },
      ...extra,
    ],
    excludedFields: [],
    insertOrder: 0,
    batchSize: 200,
  } as SeedTemplate['objects'][number];
}

function template(objects: SeedTemplate['objects'], relations?: SeedTemplate['relations']) {
  return {
    id: 'tpl',
    name: 'refused fields',
    description: '',
    version: 1,
    strategy: 'faker',
    objects,
    ...(relations ? { relations } : {}),
    tags: [],
    createdAt: '2026-10-17T00:00:00.000Z',
    updatedAt: '2026-10-17T00:00:00.000Z',
  } as SeedTemplate;
}

describe('SeedOrchestrator — a target that refuses the phone it is given', () => {
  it('writes every contact again without its phone, and says so in the rule’s words', async () => {
    // Run into a client sandbox with a phone format rule, a seed of ten
    // contacts wrote none of them: the faker's numbers are fiction's.
    const target = phoneRuleTarget();
    const result = await new SeedOrchestrator(seedDeps(target.insert)).execute(
      template([contacts(10)]),
      'org',
    );

    const [contact] = result.objectResults;
    expect(contact.recordsCreated).toBe(10);
    expect(contact.recordsFailed).toBe(0);
    expect(contact.createdIds).toHaveLength(10);
    expect(result.status).toBe('success');
    expect(contact.errors).toEqual([
      '10 record(s) written again without the fields the target refused them on, 10 written ' +
        'without Phone: a validation rule of the target refused it, ' +
        'FIELD_CUSTOM_VALIDATION_EXCEPTION: Phone must be written +33 X XX XX XX XX.',
    ]);
    // Sent once with their phones, then again with every other field.
    expect(target.sent).toHaveLength(2);
    expect(
      target.sent[1].records.every((r) => !('Phone' in r) && typeof r.Email === 'string'),
    ).toBe(true);
  });

  it('sends nothing again when the target takes every phone', async () => {
    const target = phoneRuleTarget({ rule: /./ });
    const result = await new SeedOrchestrator(seedDeps(target.insert)).execute(
      template([contacts(4)]),
      'org',
    );

    expect(target.sent).toHaveLength(1);
    expect(result.objectResults[0].errors).toEqual([]);
  });

  it('never writes a contact again without the account its relation placed it under', async () => {
    // A rule of the target on the account a contact hangs from: written
    // without it, the contact would stand alone.
    const target = phoneRuleTarget({ refuseOn: 'AccountId', rule: /^$/ });
    const accounts = {
      objectApiName: 'Account',
      recordCount: 2,
      fieldRules: [{ fieldApiName: 'Name', ruleType: 'faker', config: { fakerMethod: 'company' } }],
      excludedFields: [],
      insertOrder: 0,
      batchSize: 200,
    } as SeedTemplate['objects'][number];
    const result = await new SeedOrchestrator(seedDeps(target.insert)).execute(
      template(
        [accounts, { ...contacts(2), insertOrder: 1 }],
        [
          {
            childObject: 'Contact',
            lookupField: 'AccountId',
            parentObject: 'Account',
            parents: { kind: 'generated' },
            distribution: { mode: 'perParent', count: 1 },
          },
        ],
      ),
      'org',
    );

    const contact = result.objectResults.find((o) => o.objectApiName === 'Contact');
    expect(contact?.recordsCreated).toBe(0);
    expect(contact?.recordsFailed).toBe(2);
    expect(target.sent.filter((s) => s.objectApiName === 'Contact')).toHaveLength(1);
  });

  it('never writes a contact again without the record type it was given', async () => {
    const target = phoneRuleTarget({ refuseOn: 'RecordTypeId', rule: /^$/ });
    const result = await new SeedOrchestrator(seedDeps(target.insert)).execute(
      template([
        contacts(2, [
          {
            fieldApiName: 'RecordTypeId',
            ruleType: 'static',
            config: { staticValue: '012000000000001AAA' },
          },
        ]),
      ]),
      'org',
    );

    expect(result.objectResults[0].recordsFailed).toBe(2);
    expect(target.sent).toHaveLength(1);
  });

  it('says it once per object on the partitioned path, counting every partition', async () => {
    const target = phoneRuleTarget();
    const deps: SeedOrchestratorDependencies = {
      ...seedDeps(target.insert),
      grappeAdapter: new SeedGrappeAdapter(() => 'gid', 4),
      grappeConfig: {
        enabled: true,
        autoActivateThreshold: 1,
        grappeSize: 4,
      } as SeedOrchestratorDependencies['grappeConfig'],
    };

    const result = await new SeedOrchestrator(deps).execute(template([contacts(10)]), 'org');

    const [contact] = result.objectResults;
    expect(contact.recordsCreated).toBe(10);
    expect(contact.errors).toHaveLength(1);
    expect(contact.errors[0]).toMatch(/^10 record\(s\) written again without the fields/);
  });
});
