import { describe, it, expect } from 'vitest';
import type { ScenarioPack } from '../types/scenario.types.js';
import { BUILT_IN_SCENARIO_PACKS, RETAIL_ORDERS_PACK } from '../constants/scenario-packs.js';
import {
  SCENARIO_COMPILE_DEFAULTS,
  SCENARIO_PACK_LIMITS,
  scenarioCompileOptionsSchema,
  scenarioPackSchema,
  scenarioPlaceholdersIn,
} from './scenario.schema.js';

/** A copy of the retail pack, to change one part of. */
function retail(): ScenarioPack {
  return structuredClone(RETAIL_ORDERS_PACK);
}

/** What the schema says of a pack: each issue as `path: message`. */
function issuesOf(pack: unknown): string[] {
  const parsed = scenarioPackSchema.safeParse(pack);
  return parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}

describe('scenarioPackSchema', () => {
  it.each(BUILT_IN_SCENARIO_PACKS.map((pack) => [pack.id, pack] as const))(
    'takes the built-in pack %s',
    (_id, pack) => {
      expect(issuesOf(pack)).toEqual([]);
    },
  );

  it('refuses a topic without an article', () => {
    const pack = retail() as unknown as { topics: Array<Record<string, unknown>> };
    delete pack.topics[1].article;
    expect(issuesOf(pack)).toEqual([expect.stringMatching(/^topics\.1\.article: /)]);
  });

  it('refuses an article body of 8,001 characters, and takes one of 8,000', () => {
    const pack = retail();
    const article = pack.topics[0].article;
    article.body = `${article.facts.join('. ')}. `.padEnd(8_000, 'x');
    expect(issuesOf(pack)).toEqual([]);
    article.body += 'x';
    expect(article.body).toHaveLength(8_001);
    expect(issuesOf(pack)).toEqual([expect.stringMatching(/^topics\.0\.article\.body: Too big/)]);
  });

  it('refuses a topic named twice, naming it', () => {
    const pack = retail();
    pack.topics[3].key = pack.topics[1].key;
    expect(issuesOf(pack)).toEqual([
      'topics.3.key: The topic "refund" is named twice: each topic is named once',
    ]);
  });

  it('refuses a decoy that resembles a topic the pack does not have, naming the key', () => {
    const pack = retail();
    pack.decoy.resembles = 'gift-cards';
    expect(issuesOf(pack)).toEqual([
      'decoy.resembles: The decoy resembles the topic "gift-cards", which the pack does not have: ' +
        'its topics are "damaged-parcel", "refund", "late-delivery", "address-change", "warranty"',
    ]);
  });

  it("refuses a fact the article's body does not state, naming it", () => {
    const pack = retail();
    pack.topics[2].article.facts[1] = 'Parcels are insured up to any amount';
    expect(issuesOf(pack)).toEqual([
      'topics.2.article.facts.1: The fact "Parcels are insured up to any amount" is not stated by ' +
        "the article's body word for word: an agent answering from the article can only cite what " +
        'its body says',
    ]);
  });

  it('reads a fact in the body whatever its case and its line breaks', () => {
    const pack = retail();
    pack.topics[0].article.facts[0] = 'WITHIN 7\n days   of delivery';
    expect(issuesOf(pack)).toEqual([]);
  });

  it('refuses two articles of one title, the decoy among them', () => {
    const pack = retail();
    pack.decoy.title = pack.topics[1].article.title.toUpperCase();
    expect(issuesOf(pack)).toEqual([
      `decoy.title: "${pack.decoy.title}" is the title of the article of "refund" too: each ` +
        'article has a title of its own',
    ]);
  });

  it('refuses fewer customers than topics', () => {
    const pack = retail();
    pack.customers.count = 4;
    expect(issuesOf(pack)).toEqual([
      "customers.count: 4 customer(s) for 5 topics: each topic's utterances are said about a " +
        "customer's open case on it, so a pack has a customer a topic",
    ]);
  });

  it('refuses a misspelt key rather than leave what it holds unread', () => {
    const pack = retail() as unknown as { topics: Array<{ article: Record<string, unknown> }> };
    pack.topics[0].article.fact = ['within 7 days of delivery'];
    expect(issuesOf(pack)).toEqual([expect.stringMatching(/^topics\.0\.article: .*"fact"/)]);
  });

  it('refuses a key that an article URL name cannot hold', () => {
    for (const key of ['Refund', 'refund--late', '-refund', 'refund-', '9refund', 'r']) {
      const pack = retail();
      pack.topics[1].key = key;
      if (pack.decoy.resembles === 'refund') pack.decoy.resembles = key;
      expect(issuesOf(pack).some((issue) => issue.startsWith('topics.1.key: '))).toBe(true);
    }
  });

  it('refuses a pack with too few topics or too few out-of-scope utterances', () => {
    const pack = retail();
    pack.topics = pack.topics.slice(0, 2);
    pack.decoy.resembles = pack.topics[0].key;
    pack.customers.count = 10;
    pack.outOfScope = pack.outOfScope.slice(0, 1);
    expect(issuesOf(pack)).toEqual([
      expect.stringMatching(/^topics: Too small/),
      expect.stringMatching(/^outOfScope: Too small/),
    ]);
  });

  describe('placeholders', () => {
    it('refuses a placeholder misspelt in an utterance, naming it and the ones there are', () => {
      const pack = retail();
      pack.topics[0].utterances[0].text = 'Hi, my email is {mail}.';
      expect(issuesOf(pack)).toEqual([
        'topics.0.utterances.0.text: {mail} is not a placeholder of this text, which can name ' +
          '{firstName}, {lastName}, {company}, {email}, {caseSubject}',
      ]);
    });

    it("refuses the case's subject in its own subject", () => {
      const pack = retail();
      pack.topics[0].caseTemplates[0].subject = 'Again: {caseSubject}';
      expect(issuesOf(pack)).toEqual([
        'topics.0.caseTemplates.0.subject: {caseSubject} is not a placeholder of this text, which ' +
          'can name {firstName}, {lastName}, {company}, {email}',
      ]);
    });

    it('refuses a placeholder where none is filled, and takes any other word in braces there', () => {
      const pack = retail();
      pack.topics[0].article.body += '\n\nWrite to {email}.';
      pack.outOfScope[0].text = 'I am {firstName}, recommend me a restaurant.';
      expect(issuesOf(pack)).toEqual([
        'topics.0.article.body: {email} is not filled in this text, and would be written as it stands',
        'outOfScope.0.text: {firstName} is not filled in this text, and would be written as it stands',
      ]);
      const literal = retail();
      literal.topics[0].article.body += '\n\nThe path is /v2/projects/{projectId}.';
      expect(issuesOf(literal)).toEqual([]);
    });

    it('lists the placeholders a text names, each once, in order', () => {
      expect(scenarioPlaceholdersIn('{email} then {company}, {email} and { spaced } {9}')).toEqual([
        'email',
        'company',
      ]);
    });
  });

  it('refuses a blank text', () => {
    const pack = retail();
    pack.topics[4].label = '   ';
    expect(issuesOf(pack)).toEqual([expect.stringMatching(/^topics\.4\.label: .*blank/)]);
  });

  it('refuses a language Salesforce does not write that way', () => {
    const pack = retail();
    pack.language = 'en-US';
    expect(issuesOf(pack)).toEqual([expect.stringMatching(/^language: /)]);
  });
});

describe('scenarioCompileOptionsSchema', () => {
  it('takes no option at all, and the defaults are options it takes', () => {
    expect(scenarioCompileOptionsSchema.safeParse({}).success).toBe(true);
    expect(scenarioCompileOptionsSchema.safeParse(SCENARIO_COMPILE_DEFAULTS).success).toBe(true);
  });

  it('refuses each option out of bounds, each where it is', () => {
    const parsed = scenarioCompileOptionsSchema.safeParse({
      seed: -1,
      customers: SCENARIO_PACK_LIMITS.maxCustomers + 1,
      historyPerCustomer: SCENARIO_PACK_LIMITS.maxHistoryPerCustomer + 1,
      caseStatus: { open: 'Closed', closed: 'Closed' },
      articleBodyField: 'Body c',
      seeds: 3,
    });
    expect(parsed.error?.issues.map((i) => i.path.join('.')).sort()).toEqual([
      '',
      'articleBodyField',
      'caseStatus.closed',
      'customers',
      'historyPerCustomer',
      'seed',
    ]);
  });

  it('refuses to send the body to a field the article is already written with, and takes Summary', () => {
    for (const field of ['Title', 'UrlName', 'Language', 'IsVisibleInPkb']) {
      const parsed = scenarioCompileOptionsSchema.safeParse({ articleBodyField: field });
      expect(parsed.error?.issues.map((i) => i.message)).toEqual([
        'The article is written with this field already: its body goes to a field of its own, ' +
          'or to Summary',
      ]);
    }
    for (const field of ['Summary', 'Body__c', 'Answer__c']) {
      expect(scenarioCompileOptionsSchema.safeParse({ articleBodyField: field }).success).toBe(
        true,
      );
    }
  });

  it('takes the length of a field the org can have for the body, and no other', () => {
    for (const articleBodyLength of [1_000, 32_768, 131_072]) {
      expect(scenarioCompileOptionsSchema.safeParse({ articleBodyLength }).success).toBe(true);
    }
    for (const articleBodyLength of [0, 131_073, 999.5]) {
      expect(scenarioCompileOptionsSchema.safeParse({ articleBodyLength }).success).toBe(false);
    }
    expect(scenarioCompileOptionsSchema.safeParse({ articleBodyHtml: 'yes' }).success).toBe(false);
  });

  it('takes every seed of 32 bits', () => {
    expect(scenarioCompileOptionsSchema.safeParse({ seed: 2 ** 32 - 1 }).success).toBe(true);
    expect(scenarioCompileOptionsSchema.safeParse({ seed: 2 ** 32 }).success).toBe(false);
    expect(scenarioCompileOptionsSchema.safeParse({ seed: 1.5 }).success).toBe(false);
  });
});
