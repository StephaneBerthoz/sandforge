/**
 * Property-based tests of the scenario compiler, over packs drawn at random
 * within the schema's bounds and over the seeds of the built-in packs. Each
 * property sets its own `numRuns`.
 */
import * as fc from 'fast-check';
import { describe, it, expect } from 'vitest';
import { BUILT_IN_SCENARIO_PACKS, scenarioPackSchema } from '@sandforge/shared';
import type {
  CompiledScenario,
  ScenarioCompileOptions,
  ScenarioPack,
  ScenarioTopic,
} from '@sandforge/shared';
import { seedTemplatePayloadSchema } from '../../../bridge/validatePayload';
import { SeedValidator } from '../SeedValidator';
import { reachNobody } from '../AIDataGenerator';
import { isReservedEmailDomain } from '../LocaleData';
import { compileScenario } from './compileScenario';

/** What a text may carry that reaches somebody, or nothing. */
const contactPointArb = fc.constantFrom(
  '',
  ' jane@gmail.com',
  ' +33 6 12 34 56 78',
  ' (415) 867-5309',
  ' 020 7946 0958',
  ' ops@corp-mail.io',
);

const wordArb = fc.stringMatching(/^[a-z]{2,7}$/);

/**
 * A sentence of words, now and then with an address or a number in it: at
 * most 67 characters, inside the shortest bound a text of the pack has.
 */
const proseArb = fc
  .tuple(fc.array(wordArb, { minLength: 1, maxLength: 6 }), contactPointArb)
  .map(([words, point]) => `${words.join(' ')}${point}`);

/** A text of a case or an utterance, with a placeholder now and then. */
const placedArb = fc
  .tuple(proseArb, fc.constantFrom('', ' {firstName}', ' {company}', ' {email}', ' {caseSubject}'))
  .map(([text, placeholder]) => `${text}${placeholder}`);

const keyArb = fc.stringMatching(/^[a-z][a-z0-9]{1,7}(?:-[a-z0-9]{1,6}){0,2}$/);

/** A topic named `key`, whose article states its facts. */
function topicArb(key: string): fc.Arbitrary<ScenarioTopic> {
  return fc.record({
    key: fc.constant(key),
    label: proseArb,
    article: fc
      .tuple(fc.array(wordArb, { minLength: 3, maxLength: 5 }), proseArb, proseArb)
      .map(([facts, summary, rest]) => ({
        title: `Article on ${key}`,
        summary,
        body: `${facts.map((fact) => `It is ${fact}.`).join(' ')}\n\n${rest}`,
        facts: facts.map((fact) => `It is ${fact}`),
      })),
    caseTemplates: fc.array(
      fc.record({
        subject: fc
          .tuple(proseArb, fc.constantFrom('', ' {company}'))
          .map(([text, placeholder]) => `${text}${placeholder}`),
        description: placedArb,
        priority: fc.constantFrom('High', 'Medium', 'Low'),
        origin: fc.constantFrom('Phone', 'Email', 'Web'),
        followUp: placedArb,
        resolution: fc.array(placedArb, { minLength: 1, maxLength: 4 }),
      }),
      { minLength: 1, maxLength: 4 },
    ),
    utterances: fc.array(fc.record({ text: placedArb, expectedOutcome: placedArb }), {
      minLength: 1,
      maxLength: 5,
    }),
  });
}

/** A pack within the schema's bounds, and the options a run compiles it with. */
const caseArb: fc.Arbitrary<{ pack: ScenarioPack; options: ScenarioCompileOptions }> = fc
  .uniqueArray(keyArb, { minLength: 3, maxLength: 6 })
  .chain((keys) =>
    fc.record({
      pack: fc.record({
        version: fc.constant(1 as const),
        id: keyArb,
        name: proseArb,
        language: fc.constantFrom('en_US', 'fr_FR', 'de', 'ja_JP', 'it_IT'),
        businessContext: proseArb,
        customers: fc.record({
          count: fc.integer({ min: keys.length, max: 12 }),
          industry: wordArb,
        }),
        topics: fc.tuple(...keys.map(topicArb)),
        decoy: fc.record({
          title: fc.constant('The decoy article'),
          summary: proseArb,
          body: proseArb,
          resembles: fc.constantFrom(...keys),
        }),
        outOfScope: fc.array(fc.record({ text: proseArb, expectedOutcome: proseArb }), {
          minLength: 2,
          maxLength: 5,
        }),
      }),
      options: fc.record(
        {
          seed: fc.integer({ min: 0, max: 2 ** 32 - 1 }),
          customers: fc.integer({ min: keys.length, max: 15 }),
          historyPerCustomer: fc.integer({ min: 0, max: 3 }),
        },
        { requiredKeys: [] },
      ),
    }),
  );

/** Every string a compiled scenario holds, rows and tests alike. */
function textsOf(compiled: CompiledScenario): string[] {
  const texts: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') texts.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(compiled);
  return texts;
}

/** Whether a text holds no address off a reserved domain and nothing a seed would rewrite. */
function reachesNobody(text: string): boolean {
  const domains = [...text.matchAll(/@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)].map((m) => m[1]);
  const unchanged = reachNobody({ text }, new Set(), () => 'rewritten').text === text;
  return unchanged && domains.every(isReservedEmailDomain);
}

const PARENT_OF: Record<string, string> = {
  Contact: 'Account',
  Case: 'Contact',
  CaseComment: 'Case',
};

describe('compileScenario — property-based', () => {
  it('draws only packs the schema takes', () => {
    fc.assert(
      fc.property(caseArb, ({ pack }) => {
        const parsed = scenarioPackSchema.safeParse(pack);
        expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
      }),
      { numRuns: 100 },
    );
  });

  it('compiles every pack into a template the schema and the run validator take', () => {
    const validator = new SeedValidator();
    fc.assert(
      fc.property(caseArb, ({ pack, options }) => {
        const { template } = compileScenario(pack, options);
        const parsed = seedTemplatePayloadSchema.safeParse(template);
        expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
        expect(validator.validate(template).errors).toEqual([]);
      }),
      { numRuns: 100 },
    );
  });

  it('places every child row under a row of its parent, each key once, as many records as rows', () => {
    fc.assert(
      fc.property(caseArb, ({ pack, options }) => {
        const { template } = compileScenario(pack, options);
        const keysOf = (name: string) =>
          new Set(
            (template.objects.find((o) => o.objectApiName === name)?.rows ?? []).map((r) => r.key),
          );
        for (const object of template.objects) {
          const rows = object.rows ?? [];
          expect(object.recordCount).toBe(rows.length);
          expect(keysOf(object.objectApiName).size).toBe(rows.length);
          const parent = PARENT_OF[object.objectApiName];
          const parentKeys = parent ? keysOf(parent) : new Set<string>();
          for (const row of rows) {
            if (parent) expect(parentKeys.has(String(row.parentKey))).toBe(true);
            else expect(row.parentKey).toBeUndefined();
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it('writes as many records as the pack and the options declare', () => {
    fc.assert(
      fc.property(caseArb, ({ pack, options }) => {
        const compiled = compileScenario(pack, options);
        const customers = options.customers ?? pack.customers.count;
        const history = options.historyPerCustomer ?? 2;
        const counts = Object.fromEntries(
          compiled.template.objects.map((o) => [o.objectApiName, o.recordCount]),
        );
        expect(counts.Account).toBe(customers);
        expect(counts.Contact).toBe(customers);
        expect(counts.Case).toBe(customers * (history + 1));
        expect(counts.Knowledge__kav).toBe(pack.topics.length + 1);
        expect(compiled.closedCaseArticles).toHaveLength(customers * history);
        const comments = compiled.template.objects.find((o) => o.objectApiName === 'CaseComment');
        const closedSteps = compiled.closedCaseArticles.length;
        expect(comments?.recordCount).toBeGreaterThanOrEqual(customers + closedSteps);
        expect(comments?.recordCount).toBeLessThanOrEqual(customers + 4 * closedSteps);
        expect(compiled.tests).toHaveLength(
          pack.topics.reduce((sum, t) => sum + t.utterances.length, 0) + pack.outOfScope.length,
        );
      }),
      { numRuns: 100 },
    );
  });

  it('reaches nobody: no value, no utterance, holds an address or a number someone has', () => {
    fc.assert(
      fc.property(caseArb, ({ pack, options }) => {
        for (const text of textsOf(compileScenario(pack, options))) {
          expect(reachesNobody(text)).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });

  it.each(BUILT_IN_SCENARIO_PACKS.map((pack) => [pack.id, pack] as const))(
    'reaches nobody from the built-in pack %s, whatever the seed',
    (_id, pack) => {
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 2 ** 32 - 1 }), (seed) => {
          for (const text of textsOf(compileScenario(pack, { seed }))) {
            expect(reachesNobody(text)).toBe(true);
          }
        }),
        { numRuns: 200 },
      );
    },
  );

  it('asks each test about a case written open, under the contact the test names', () => {
    fc.assert(
      fc.property(caseArb, ({ pack, options }) => {
        const compiled = compileScenario(pack, options);
        const rows = (name: string) =>
          new Map(
            (compiled.template.objects.find((o) => o.objectApiName === name)?.rows ?? []).map(
              (row) => [row.key, row],
            ),
          );
        const cases = rows('Case');
        const contacts = rows('Contact');
        const open = options.caseStatus?.open ?? 'New';
        for (const test of compiled.tests) {
          if (test.topicKey === null) {
            expect(test.openCase).toBeUndefined();
            continue;
          }
          const caseRow = cases.get(test.openCase!.caseKey);
          expect(caseRow?.values.Status).toBe(open);
          expect(caseRow?.values.Subject).toBe(test.openCase!.subject);
          expect(caseRow?.parentKey).toBe(test.openCase!.contactKey);
          expect(contacts.get(test.openCase!.contactKey)?.values.Email).toBe(
            test.openCase!.contactEmail,
          );
        }
      }),
      { numRuns: 100 },
    );
  });

  it('gives the same template, byte for byte, for the same pack and options', () => {
    fc.assert(
      fc.property(caseArb, ({ pack, options }) => {
        const once = JSON.stringify(compileScenario(pack, options));
        expect(JSON.stringify(compileScenario(structuredClone(pack), { ...options }))).toBe(once);
      }),
      { numRuns: 100 },
    );
  });

  it('keeps every key and link under another seed', () => {
    fc.assert(
      fc.property(caseArb, fc.integer({ min: 0, max: 2 ** 32 - 1 }), ({ pack, options }, seed) => {
        const shape = (compiled: CompiledScenario) =>
          compiled.template.objects.map((o) => (o.rows ?? []).map((r) => [r.key, r.parentKey]));
        expect(shape(compileScenario(pack, { ...options, seed }))).toEqual(
          shape(compileScenario(pack, options)),
        );
      }),
      { numRuns: 100 },
    );
  });
});
