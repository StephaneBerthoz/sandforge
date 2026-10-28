import { describe, it, expect } from 'vitest';
import {
  BROADBAND_SUPPORT_PACK,
  BUILT_IN_SCENARIO_PACKS,
  RETAIL_ORDERS_PACK,
  SAAS_SUPPORT_PACK,
} from '@sandforge/shared';
import type {
  CompiledScenario,
  ScenarioPack,
  SeedObjectConfig,
  SeedRow,
  SeedTemplate,
} from '@sandforge/shared';
import { seedTemplatePayloadSchema } from '../../../bridge/validatePayload';
import { SeedValidator } from '../SeedValidator';
import { seedStorageBytes } from '../seedStorage';
import { reachNobody } from '../AIDataGenerator';
import { isReservedEmailDomain, isReservedPhone } from '../LocaleData';
import { compileScenario, ScenarioCompileError } from './compileScenario';

/** The rows of one object of a compiled template. */
function rowsOf(template: SeedTemplate, objectApiName: string): SeedRow[] {
  const object = template.objects.find((o) => o.objectApiName === objectApiName);
  if (!object?.rows) throw new Error(`${objectApiName} has no rows`);
  return object.rows;
}

/** The object of a compiled template. */
function objectOf(template: SeedTemplate, objectApiName: string): SeedObjectConfig {
  const object = template.objects.find((o) => o.objectApiName === objectApiName);
  if (!object) throw new Error(`${objectApiName} is not written`);
  return object;
}

/** A row of an object, by its key. */
function rowAt(template: SeedTemplate, objectApiName: string, key: string): SeedRow {
  const row = rowsOf(template, objectApiName).find((r) => r.key === key);
  if (!row) throw new Error(`${objectApiName} has no row ${key}`);
  return row;
}

/** A copy of a pack, to change one part of. */
function copyOf(pack: ScenarioPack): ScenarioPack {
  return structuredClone(pack);
}

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

/** The parent object of each child object a scenario places by key. */
const PARENT_OF: Record<string, string> = {
  Contact: 'Account',
  Case: 'Contact',
  CaseComment: 'Case',
};

/** The lookup each child object is placed by. */
const LOOKUP_OF: Record<string, string> = {
  Contact: 'AccountId',
  Case: 'ContactId',
  CaseComment: 'ParentId',
};

describe('compileScenario', () => {
  describe.each(BUILT_IN_SCENARIO_PACKS.map((pack) => [pack.id, pack] as const))(
    'the built-in pack %s',
    (_id, pack) => {
      const compiled = compileScenario(pack);

      it('compiles into a template the seed:execute schema takes, its rows agreeing with its relations', () => {
        const parsed = seedTemplatePayloadSchema.safeParse(compiled.template);
        expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
      });

      it('compiles into a template the run validator takes without an error', () => {
        const result = new SeedValidator().validate(compiled.template);
        expect(result.errors).toEqual([]);
        expect(result.valid).toBe(true);
      });

      it('writes ten companies, their contacts, three cases each and their comments, and six articles', () => {
        const counts = Object.fromEntries(
          compiled.template.objects.map((o) => [o.objectApiName, o.recordCount]),
        );
        expect(counts).toEqual({
          Account: 10,
          Contact: 10,
          Case: 30,
          CaseComment: 50,
          Knowledge__kav: 6,
        });
        for (const object of compiled.template.objects) {
          expect(object.recordCount).toBe(object.rows?.length);
        }
      });

      it('takes about a quarter of a megabyte, well inside the 5 MB of a Developer Edition', () => {
        const bytes = seedStorageBytes(compiled.template, []);
        expect(bytes).toBe((100 * 2 + 6 * 4) * 1024);
        expect(bytes).toBeLessThan(1024 * 1024);
      });

      it('places every child row under a row of its parent, each key once per object', () => {
        for (const object of compiled.template.objects) {
          const keys = (object.rows ?? []).map((row) => row.key);
          expect(new Set(keys).size).toBe(keys.length);
          for (const key of keys) expect(key.length).toBeLessThanOrEqual(255);
          const parent = PARENT_OF[object.objectApiName];
          if (!parent) {
            expect((object.rows ?? []).every((row) => row.parentKey === undefined)).toBe(true);
            continue;
          }
          const parentKeys = new Set(rowsOf(compiled.template, parent).map((row) => row.key));
          for (const row of object.rows ?? []) expect(parentKeys).toContain(row.parentKey);
        }
        expect(compiled.template.relations).toEqual(
          Object.entries(PARENT_OF).map(([childObject, parentObject]) => ({
            childObject,
            lookupField: LOOKUP_OF[childObject],
            parentObject,
            parents: { kind: 'generated' },
            distribution: { mode: 'byKey' },
          })),
        );
      });

      it('gives each comment the text of its own case: a step of its resolution, or its follow-up while open', () => {
        for (const comment of rowsOf(compiled.template, 'CaseComment')) {
          const parent = rowAt(compiled.template, 'Case', String(comment.parentKey));
          const template = pack.topics
            .flatMap((topic) => topic.caseTemplates)
            .find((t) => fills(t.subject, String(parent.values.Subject)));
          expect(template).toBeDefined();
          const texts =
            parent.values.Status === 'Closed' ? template!.resolution : [template!.followUp];
          expect(texts.some((text) => fills(text, String(comment.values.CommentBody)))).toBe(true);
          expect(comment.values.IsPublished).toBe(false);
        }
      });

      it('links each closed case to the article of the topic its case was written from', () => {
        const closed = rowsOf(compiled.template, 'Case').filter(
          (row) => row.values.Status === 'Closed',
        );
        expect(compiled.closedCaseArticles.map((link) => link.caseKey)).toEqual(
          closed.map((row) => row.key),
        );
        for (const { caseKey, articleKey } of compiled.closedCaseArticles) {
          const subject = String(rowAt(compiled.template, 'Case', caseKey).values.Subject);
          const topic = pack.topics.find((t) =>
            t.caseTemplates.some((template) => fills(template.subject, subject)),
          );
          expect(rowAt(compiled.template, 'Knowledge__kav', articleKey).values.Title).toBe(
            topic?.article.title,
          );
        }
      });

      it("asks each test about the open case of a customer on the test's topic, naming that customer", () => {
        for (const test of compiled.tests.filter((t) => t.topicKey !== null)) {
          const open = test.openCase!;
          const caseRow = rowAt(compiled.template, 'Case', open.caseKey);
          expect(caseRow.values.Status).toBe('New');
          expect(caseRow.values.Subject).toBe(open.subject);
          expect(caseRow.parentKey).toBe(open.contactKey);
          expect(rowAt(compiled.template, 'Contact', open.contactKey).values.Email).toBe(
            open.contactEmail,
          );
          const topic = pack.topics.find((t) => t.key === test.topicKey)!;
          expect(topic.caseTemplates.some((t) => fills(t.subject, open.subject))).toBe(true);
          expect(test.article?.title).toBe(topic.article.title);
          expect(test.article?.facts).toEqual(topic.article.facts);
          expect(test.utterance).not.toMatch(/\{[A-Za-z]+\}/);
          expect(test.expectedOutcome).not.toMatch(/\{[A-Za-z]+\}/);
        }
      });

      it('names the address of the contact in each utterance that names one, and the subject of its case', () => {
        const named = pack.topics.flatMap((topic) =>
          topic.utterances.map((utterance, index) => ({
            key: `${pack.id}-test-${topic.key}-${index + 1}`,
            utterance,
          })),
        );
        for (const { key, utterance } of named) {
          const test = compiled.tests.find((t) => t.key === key)!;
          if (utterance.text.includes('{email}')) {
            expect(test.utterance).toContain(test.openCase!.contactEmail);
          }
          if (utterance.expectedOutcome.includes('{caseSubject}')) {
            expect(test.expectedOutcome).toContain(test.openCase!.subject);
          }
        }
        expect(named.some(({ utterance }) => utterance.text.includes('{email}'))).toBe(true);
      });

      it('compiles one test per utterance, the ones no topic covers last and about no case', () => {
        const onTopic = pack.topics.reduce((sum, topic) => sum + topic.utterances.length, 0);
        expect(compiled.tests).toHaveLength(onTopic + pack.outOfScope.length);
        const outOfScope = compiled.tests.slice(onTopic);
        expect(outOfScope.map((t) => t.utterance)).toEqual(pack.outOfScope.map((u) => u.text));
        for (const test of outOfScope) {
          expect(test.topicKey).toBeNull();
          expect(test.openCase).toBeUndefined();
          expect(test.article).toBeUndefined();
        }
        expect(new Set(compiled.tests.map((t) => t.key)).size).toBe(compiled.tests.length);
      });

      it('gives every address a reserved domain and every number one nobody holds', () => {
        for (const row of [
          ...rowsOf(compiled.template, 'Account'),
          ...rowsOf(compiled.template, 'Contact'),
        ]) {
          expect(isReservedPhone(String(row.values.Phone))).toBe(true);
        }
        for (const row of rowsOf(compiled.template, 'Contact')) {
          const domain = String(row.values.Email).split('@')[1];
          expect(isReservedEmailDomain(domain)).toBe(true);
        }
      });
    },
  );

  it('writes the articles as optional, in the language of the pack, with every channel closed', () => {
    const { template } = compileScenario(SAAS_SUPPORT_PACK);
    const articles = objectOf(template, 'Knowledge__kav');
    expect(articles.optional).toBe(true);
    expect(articles.rows?.map((row) => row.values.Title)).toEqual([
      ...SAAS_SUPPORT_PACK.topics.map((topic) => topic.article.title),
      SAAS_SUPPORT_PACK.decoy.title,
    ]);
    for (const row of articles.rows ?? []) {
      expect(row.values).toMatchObject({
        Language: 'en_US',
        IsVisibleInPkb: false,
        IsVisibleInCsp: false,
        IsVisibleInPrm: false,
      });
    }
    expect(
      ['Account', 'Contact', 'Case', 'CaseComment'].map((o) => objectOf(template, o).optional),
    ).toEqual([undefined, undefined, undefined, undefined]);
  });

  it('gives each article a URL name of its own, which the seed is part of', () => {
    const urlNames = (seed: number) =>
      rowsOf(compileScenario(RETAIL_ORDERS_PACK, { seed }).template, 'Knowledge__kav').map((row) =>
        String(row.values.UrlName),
      );
    const first = urlNames(1);
    expect(first).toEqual([
      'retail-orders-damaged-parcel-1',
      'retail-orders-refund-1',
      'retail-orders-late-delivery-1',
      'retail-orders-address-change-1',
      'retail-orders-warranty-1',
      'retail-orders-1-decoy',
    ]);
    for (const name of first) expect(name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(urlNames(2).filter((name) => first.includes(name))).toEqual([]);
  });

  it('writes the body to the field the run names, and none when it names none', () => {
    const body = (articleBodyField?: string) =>
      rowsOf(
        compileScenario(BROADBAND_SUPPORT_PACK, { articleBodyField }).template,
        'Knowledge__kav',
      )[0].values;
    expect(body('Body__c').Body__c).toBe(BROADBAND_SUPPORT_PACK.topics[0].article.body);
    expect(Object.keys(body())).not.toContain('Body__c');
    expect(body().Summary).toBe(BROADBAND_SUPPORT_PACK.topics[0].article.summary);
    const inSummary = String(body('Summary').Summary);
    expect(inSummary.length).toBeLessThanOrEqual(1_000);
    expect(BROADBAND_SUPPORT_PACK.topics[0].article.body.startsWith(inSummary)).toBe(true);
  });

  describe('the body, in the field the org has for it', () => {
    /** The Knowledge rows of a pack compiled with these options. */
    const articlesOf = (pack: ScenarioPack, options: Parameters<typeof compileScenario>[1]) =>
      rowsOf(compileScenario(pack, options).template, 'Knowledge__kav');
    /** Words that state none of a pack's facts, `length` characters of them. */
    const filler = (length: number): string =>
      'This paragraph tells the history of the service and states no rule. '
        .repeat(Math.ceil(length / 69))
        .slice(0, length)
        .trim();

    it('writes each built-in body whole to Summary, the one field a Knowledge base turned on afresh has', () => {
      for (const pack of BUILT_IN_SCENARIO_PACKS) {
        const rows = articlesOf(pack, { articleBodyField: 'Summary' });
        pack.topics.forEach((topic, index) => {
          expect(rows[index].values.Summary).toBe(topic.article.body);
        });
        expect(rows.at(-1)!.values.Summary).toBe(pack.decoy.body);
      }
    });

    it('writes, of a body longer than its field, the paragraphs that state its facts, every fact word for word', () => {
      const pack = copyOf(RETAIL_ORDERS_PACK);
      const article = pack.topics[0].article;
      // The rules after a long opening: cut at the field, the body would
      // keep the opening and lose them.
      article.body = `${filler(900)}\n\n${article.body}`;

      const summary = String(articlesOf(pack, { articleBodyField: 'Summary' })[0].values.Summary);

      expect(summary.length).toBeLessThanOrEqual(1_000);
      for (const fact of article.facts) {
        expect(summary.toLowerCase()).toContain(fact.toLowerCase());
      }
      expect(summary).not.toContain('history of the service');
      // Paragraphs of the body as it wrote them, in its order.
      expect(summary.split('\n\n')).toEqual(
        RETAIL_ORDERS_PACK.topics[0].article.body
          .split('\n\n')
          .filter((paragraph) =>
            article.facts.some((fact) => paragraph.toLowerCase().includes(fact.toLowerCase())),
          ),
      );
    });

    it('writes the facts alone when even the paragraphs stating them are longer than the field', () => {
      const pack = copyOf(RETAIL_ORDERS_PACK);
      const article = pack.topics[0].article;
      article.body = article.facts
        .map((fact) => `${filler(300)} ${fact}. ${filler(300)}`)
        .join('\n\n');

      const summary = articlesOf(pack, { articleBodyField: 'Summary' })[0].values.Summary;

      expect(summary).toBe(article.facts.join('\n\n'));
    });

    it("refuses a pack whose facts do not fit in the body's field, naming the first fact past it", () => {
      let error: unknown;
      try {
        compileScenario(RETAIL_ORDERS_PACK, { articleBodyField: 'Body__c', articleBodyLength: 80 });
      } catch (thrown) {
        error = thrown;
      }

      expect(error).toBeInstanceOf(ScenarioCompileError);
      const issues = (error as ScenarioCompileError).issues;
      // "within 7 days of delivery" (25) fits in 80; with the photos (+2+59) it does not.
      expect(issues[0]).toMatch(
        /^pack\.topics\[0\]\.article\.facts\[1\]: the fact "photos of the outer box, the packing and the damaged items" does not fit, with the facts before it, in the 80 characters of Body__c/,
      );
      expect(issues).toHaveLength(RETAIL_ORDERS_PACK.topics.length);
    });

    it('writes nothing cut to a field of no given length, the body as the pack wrote it', () => {
      const pack = copyOf(RETAIL_ORDERS_PACK);
      pack.topics[0].article.body = `${filler(5_000)}\n\n${pack.topics[0].article.body}`;

      const rows = articlesOf(pack, { articleBodyField: 'Body__c' });

      expect(rows[0].values.Body__c).toBe(pack.topics[0].article.body);
      expect(rows[0].values.Summary).toBe(pack.topics[0].article.summary);
    });

    it('writes a rich text field a paragraph each, its text escaped, within the length the field holds', () => {
      const pack = copyOf(RETAIL_ORDERS_PACK);
      const article = pack.topics[0].article;
      article.body = article.body.replace('the order page', 'the Orders & returns page');

      const body = String(
        articlesOf(pack, {
          articleBodyField: 'Answer__c',
          articleBodyHtml: true,
          articleBodyLength: 32_768,
        })[0].values.Answer__c,
      );

      expect(body.match(/<p>/g)).toHaveLength(article.body.split('\n\n').length);
      expect(body).toContain('the Orders &amp; returns page');
      expect(body.startsWith('<p>If a parcel arrives damaged')).toBe(true);
      expect(body.endsWith('</p>')).toBe(true);
    });

    it('writes the decoy its summary when its body is longer than the field, cut only past that', () => {
      const pack = copyOf(RETAIL_ORDERS_PACK);
      pack.decoy.summary = `${pack.decoy.summary} ${filler(170)}`;
      // The facts of every topic fit 260 characters; the decoy states none.
      const decoyIn = (articleBodyLength: number): string =>
        String(
          articlesOf(pack, { articleBodyField: 'Body__c', articleBodyLength }).at(-1)!.values
            .Body__c,
        );

      expect(decoyIn(300)).toBe(pack.decoy.summary);
      const cutShort = decoyIn(260);
      expect(cutShort.length).toBeLessThanOrEqual(260);
      expect(pack.decoy.summary.startsWith(cutShort)).toBe(true);
    });
  });

  it('writes the statuses of the org it is given, open and closed', () => {
    const { template } = compileScenario(RETAIL_ORDERS_PACK, {
      caseStatus: { open: 'Working', closed: 'Resolved' },
    });
    const statuses = rowsOf(template, 'Case').map((row) => row.values.Status);
    expect(statuses.filter((s) => s === 'Working')).toHaveLength(10);
    expect(statuses.filter((s) => s === 'Resolved')).toHaveLength(20);
    expect(new Set(statuses)).toEqual(new Set(['Working', 'Resolved']));
  });

  it('gives a customer the history asked for, its closed cases on topics other than its open one', () => {
    const { template, closedCaseArticles } = compileScenario(RETAIL_ORDERS_PACK, {
      historyPerCustomer: 0,
    });
    expect(objectOf(template, 'Case').recordCount).toBe(10);
    expect(objectOf(template, 'CaseComment').recordCount).toBe(10);
    expect(closedCaseArticles).toEqual([]);

    const withHistory = compileScenario(RETAIL_ORDERS_PACK, { historyPerCustomer: 2 });
    const cases = rowsOf(withHistory.template, 'Case');
    for (const contact of rowsOf(withHistory.template, 'Contact')) {
      const own = cases.filter((row) => row.parentKey === contact.key);
      expect(own.map((row) => row.key)).toEqual([
        `${contact.key}-h1`,
        `${contact.key}-h2`,
        `${contact.key}-open`,
      ]);
      const topicOf = (row: SeedRow) =>
        RETAIL_ORDERS_PACK.topics.findIndex((topic) =>
          topic.caseTemplates.some((t) => fills(t.subject, String(row.values.Subject))),
        );
      const open = topicOf(own[2]);
      expect([topicOf(own[0]), topicOf(own[1])]).not.toContain(open);
    }
  });

  it('keeps every parent object at two hundred rows at most, the most the REST path takes in one insert', () => {
    const { template } = compileScenario(SAAS_SUPPORT_PACK, {
      customers: 50,
      historyPerCustomer: 3,
    });
    expect(objectOf(template, 'Account').recordCount).toBe(50);
    expect(objectOf(template, 'Contact').recordCount).toBe(50);
    expect(objectOf(template, 'Case').recordCount).toBe(200);
    expect(seedTemplatePayloadSchema.safeParse(template).success).toBe(true);
  });

  describe('the seed', () => {
    it('gives the same template and tests, byte for byte, for the same pack and seed', () => {
      const once = JSON.stringify(compileScenario(RETAIL_ORDERS_PACK, { seed: 7 }));
      const again = JSON.stringify(compileScenario(copyOf(RETAIL_ORDERS_PACK), { seed: 7 }));
      expect(again).toBe(once);
    });

    it('changes the names under another seed, and neither the keys, the links nor the cases', () => {
      const one = compileScenario(RETAIL_ORDERS_PACK, { seed: 1 });
      const two = compileScenario(RETAIL_ORDERS_PACK, { seed: 2 });
      const shape = (compiled: CompiledScenario) =>
        compiled.template.objects.map((o) => ({
          object: o.objectApiName,
          rows: (o.rows ?? []).map((row) => [row.key, row.parentKey]),
        }));
      expect(shape(two)).toEqual(shape(one));
      const subjects = (compiled: CompiledScenario) =>
        rowsOf(compiled.template, 'Case').map((row) => row.values.Subject);
      expect(subjects(two)).toEqual(subjects(one));
      const names = (compiled: CompiledScenario) =>
        rowsOf(compiled.template, 'Account').map((row) => row.values.Name);
      expect(names(two)).not.toEqual(names(one));
      expect(new Set(names(one)).size).toBe(10);
    });

    it('is told by the result', () => {
      expect(compileScenario(RETAIL_ORDERS_PACK).seed).toBe(1);
      expect(compileScenario(RETAIL_ORDERS_PACK, { seed: 42 }).seed).toBe(42);
    });
  });

  describe('a pack whose texts hold contact points', () => {
    /** A retail pack whose texts give a real-looking address and number. */
    function packReachingSomebody(): ScenarioPack {
      const pack = copyOf(RETAIL_ORDERS_PACK);
      const topic = pack.topics[0];
      topic.caseTemplates[0].description =
        'Write to jane@gmail.com or call +33 6 12 34 56 78 about it, {firstName}.';
      topic.caseTemplates[0].resolution[0] = 'Called the customer back on (415) 867-5309.';
      topic.utterances[0].text =
        'My colleague jane@gmail.com, on +33 6 12 34 56 78, has the parcel.';
      topic.article.body += '\n\nQuestions go to returns@gmail.com.';
      return pack;
    }

    it('reaches nobody once compiled: no address off a reserved domain, no number someone holds', () => {
      const compiled = compileScenario(packReachingSomebody());
      const texts = textsOf(compiled);
      expect(texts.some((text) => text.includes('gmail.com'))).toBe(false);
      expect(texts.some((text) => text.includes('12 34 56 78'))).toBe(false);
      expect(texts.some((text) => text.includes('867-5309'))).toBe(false);
      for (const text of texts) {
        expect(reachNobody({ text }, new Set(), () => 'rewritten').text).toBe(text);
      }
      expect(texts.some((text) => text.includes('jane@gmail.example'))).toBe(true);
    });

    it('rewrites a number the same way in the case and in the test that quotes it', () => {
      const pack = copyOf(RETAIL_ORDERS_PACK);
      for (const template of pack.topics[0].caseTemplates) {
        template.subject = 'Parcel for the line +33 6 12 34 56 78 arrived damaged';
      }
      const compiled = compileScenario(pack);
      const test = compiled.tests.find((t) => t.topicKey === 'damaged-parcel')!;
      const subject = String(
        rowAt(compiled.template, 'Case', test.openCase!.caseKey).values.Subject,
      );
      expect(subject).not.toContain('12 34 56 78');
      expect(test.openCase!.subject).toBe(subject);
      expect(test.expectedOutcome).toContain(subject);
    });

    it('rewrites one number to one number, in the case a customer wrote and in what it says to the agent', () => {
      const pack = copyOf(RETAIL_ORDERS_PACK);
      const topic = pack.topics[0];
      for (const template of topic.caseTemplates) {
        template.description = 'Call me back on +33 6 12 34 56 78, {firstName}.';
      }
      topic.utterances[0].text = 'You can call me on +33 6 12 34 56 78 about my parcel.';
      const compiled = compileScenario(pack);
      const test = compiled.tests.find((t) => t.key === 'retail-orders-test-damaged-parcel-1')!;
      const description = String(
        rowAt(compiled.template, 'Case', test.openCase!.caseKey).values.Description,
      );
      const number = /on (\+[\d -]+\d)/.exec(description)?.[1];
      expect(number).toBeDefined();
      expect(number).not.toBe('+33 6 12 34 56 78');
      expect(test.utterance).toBe(`You can call me on ${number} about my parcel.`);
    });
  });

  describe('refusals', () => {
    it('refuses a pack whose decoy resembles a topic it does not have, naming the key', () => {
      const pack = copyOf(RETAIL_ORDERS_PACK);
      pack.decoy.resembles = 'gift-cards';
      expect(() => compileScenario(pack)).toThrow(ScenarioCompileError);
      expect(() => compileScenario(pack)).toThrow(/pack\.decoy\.resembles: .*"gift-cards"/);
    });

    it('refuses fewer customers than topics, from the pack or from the run', () => {
      const pack = copyOf(RETAIL_ORDERS_PACK);
      pack.customers.count = 4;
      expect(() => compileScenario(pack)).toThrow(/pack\.customers\.count: 4 customer\(s\) for 5/);
      expect(() => compileScenario(RETAIL_ORDERS_PACK, { customers: 3 })).toThrow(
        /options\.customers: 3 customer\(s\) for 5 topics/,
      );
    });

    it('refuses options out of bounds, each said where it is', () => {
      let error: unknown;
      try {
        compileScenario(RETAIL_ORDERS_PACK, {
          historyPerCustomer: 4,
          caseStatus: { open: 'Closed', closed: 'Closed' },
          articleBodyField: 'Body c',
        });
      } catch (thrown) {
        error = thrown;
      }
      expect(error).toBeInstanceOf(ScenarioCompileError);
      const issues = (error as ScenarioCompileError).issues;
      expect(issues.map((issue) => issue.split(':')[0])).toEqual([
        'options.historyPerCustomer',
        'options.caseStatus.closed',
        'options.articleBodyField',
      ]);
    });

    it('lets the seed:execute schema refuse a row placed under a parent row that does not exist, naming its key', () => {
      const { template } = compileScenario(RETAIL_ORDERS_PACK);
      const cases = objectOf(template, 'Case');
      cases.rows![4] = { ...cases.rows![4], parentKey: 'retail-orders-c99' };
      const parsed = seedTemplatePayloadSchema.safeParse(template);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues.map((issue) => issue.message)).toEqual([
        expect.stringContaining('"retail-orders-c99", which no Contact row is'),
      ]);
    });
  });
});

/**
 * Whether `written` is `text` with its placeholders filled: the text with
 * each placeholder read as any run of characters.
 */
function fills(text: string, written: string): boolean {
  const pattern = text
    .split(/\{[A-Za-z]+\}/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.+?');
  return new RegExp(`^${pattern}$`, 's').test(written);
}
