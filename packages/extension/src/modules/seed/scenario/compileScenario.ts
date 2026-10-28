/**
 * A scenario pack compiled into the seed template that writes it.
 *
 * Every record is a row of its own, with a key, and every child row names the
 * row of its parent by that key: a contact under its company, a case under
 * its contact, a comment under its case. A seed places each child under the
 * record its parent row became, and writes none under a parent the org
 * refused — placed by rank, the cases of a refused contact went to the next
 * one, and the tests then asked one customer about another's case.
 *
 * Compiling is pure: no clock, no random draw but the seed's, no org. The
 * same pack and the same choices give the same template, byte for byte, so a
 * test that failed is run again on the data it failed on.
 */

import {
  SCENARIO_COMPILE_DEFAULTS,
  scenarioCompileOptionsSchema,
  scenarioPackSchema,
  statesScenarioFact,
} from '@sandforge/shared';
import type {
  CompiledScenario,
  ScenarioCaseTemplate,
  ScenarioCompileOptions,
  ScenarioPack,
  ScenarioPlaceholder,
  ScenarioTestCase,
  SeedObjectConfig,
  SeedRelation,
  SeedRow,
  SeedTemplate,
} from '@sandforge/shared';
import { phoneReplacement, reachNobody } from '../AIDataGenerator';
import { LOCALE_DATA, reservedPhone, type SupportedLocale } from '../LocaleData';
import { companiesOf, FIRST_NAMES, LAST_NAMES } from '../localeNames';

/** Why a pack, or the choices it is compiled with, cannot be compiled: each issue where it is. */
export class ScenarioCompileError extends Error {
  constructor(readonly issues: string[]) {
    super(`The scenario cannot be compiled: ${issues.join('; ')}`);
    this.name = 'ScenarioCompileError';
  }
}

/**
 * The template's dates. A compiled template is the pack's, not a moment's:
 * a date of the clock would make two compilations of one pack differ.
 */
const COMPILED_AT = '2026-10-28T00:00:00.000Z';

/**
 * The lengths of the standard fields a scenario writes. A text is cut here,
 * where a test that cites it is compiled from the same cut text: cut by the
 * org on the way in, a subject would no longer be the one its test names.
 */
const FIELD_LENGTH = {
  subject: 255,
  description: 32_000,
  commentBody: 4_000,
  articleTitle: 255,
  articleSummary: 1_000,
} as const;

/** The phone fields of the rows, whose whole value is a number. */
const PHONE_FIELDS: ReadonlySet<string> = new Set(['Phone']);

/** One of the companies that write to the pack's company, and the person who writes. */
interface Customer {
  key: string;
  company: string;
  firstName: string;
  lastName: string;
  email: string;
}

/** The open case of a customer, as it was compiled. */
interface OpenCase {
  key: string;
  subject: string;
  topicIndex: number;
  customer: Customer;
}

/**
 * The pack compiled into rows and tests. A pack or a choice out of bounds is
 * refused with every issue where it is, before anything is compiled.
 *
 * @throws {ScenarioCompileError} When the pack or the options are not valid.
 */
export function compileScenario(
  pack: ScenarioPack,
  options: ScenarioCompileOptions = {},
): CompiledScenario {
  const parsedPack = scenarioPackSchema.safeParse(pack);
  const parsedOptions = scenarioCompileOptionsSchema.safeParse(options);
  if (!parsedPack.success || !parsedOptions.success) {
    throw new ScenarioCompileError([
      ...(parsedPack.error?.issues.map((i) => said(['pack', ...i.path], i)) ?? []),
      ...(parsedOptions.error?.issues.map((i) => said(['options', ...i.path], i)) ?? []),
    ]);
  }
  const customerCount = options.customers ?? pack.customers.count;
  if (customerCount < pack.topics.length) {
    throw new ScenarioCompileError([
      `options.customers: ${customerCount} customer(s) for ${pack.topics.length} topics: each ` +
        "topic's utterances are said about a customer's open case on it",
    ]);
  }

  const seed = options.seed ?? SCENARIO_COMPILE_DEFAULTS.seed;
  const history = options.historyPerCustomer ?? SCENARIO_COMPILE_DEFAULTS.historyPerCustomer;
  const status = options.caseStatus ?? SCENARIO_COMPILE_DEFAULTS.caseStatus;
  const locale = localeOf(pack.language);
  const finish = textFinisher();
  const id = pack.id;
  const topics = pack.topics;

  const customers = drawCustomers(id, customerCount, locale, seed);
  const accounts: SeedRow[] = customers.map((customer, index) => ({
    key: customer.key,
    values: finish.row({
      Name: customer.company,
      Industry: pack.customers.industry,
      Type: 'Customer - Direct',
      Phone: reservedPhone(locale, 2 * index),
      Website: `https://www.${domainOf(customer.company)}`,
    }),
  }));
  const contacts: SeedRow[] = customers.map((customer, index) => ({
    key: customer.key,
    parentKey: customer.key,
    values: finish.row({
      FirstName: customer.firstName,
      LastName: customer.lastName,
      Email: customer.email,
      Phone: reservedPhone(locale, 2 * index + 1),
    }),
  }));

  // Each case of a topic takes the topic's next case template, in turn, so
  // that the cases of one topic do not all read the same.
  const usedTemplates = topics.map(() => 0);
  const cases: SeedRow[] = [];
  const comments: SeedRow[] = [];
  const openCases: OpenCase[] = [];
  const closedCaseArticles: CompiledScenario['closedCaseArticles'] = [];
  const articleKey = (topicIndex: number): string => `${id}-article-${topics[topicIndex].key}`;

  for (const [index, customer] of customers.entries()) {
    // A customer's history is on the topics after the one its open case is
    // on, as far as the topics go: an agent asked about the open case finds
    // that one, not a resolved case of the same customer on the same subject.
    const caseTopics = [
      ...Array.from({ length: history }, (_, h) => ({
        topicIndex: (index + 1 + h) % topics.length,
        key: `${customer.key}-h${h + 1}`,
        open: false,
      })),
      { topicIndex: index % topics.length, key: `${customer.key}-open`, open: true },
    ];
    for (const { topicIndex, key, open } of caseTopics) {
      const templates = topics[topicIndex].caseTemplates;
      const template = templates[usedTemplates[topicIndex]++ % templates.length];
      const subject = finish.text(fill(template.subject, customer), FIELD_LENGTH.subject);
      const filled = { ...customer, caseSubject: subject };
      cases.push({
        key,
        parentKey: customer.key,
        values: finish.row({
          Subject: subject,
          Description: finish.text(fill(template.description, filled), FIELD_LENGTH.description),
          Status: open ? status.open : status.closed,
          Priority: template.priority,
          Origin: template.origin,
        }),
      });
      comments.push(...caseComments(key, template, open, filled, finish));
      if (open) openCases.push({ key, subject, topicIndex, customer });
      else closedCaseArticles.push({ caseKey: key, articleKey: articleKey(topicIndex) });
    }
  }

  const field = bodyFieldOf(options);
  const unfit: string[] = [];
  const topicBodies = topics.map((topic, topicIndex) => {
    if (!field) return undefined;
    const facts = topic.article.facts.map((fact) => finish.text(fact));
    const fitted = bodyFor(finish.text(topic.article.body), facts, field);
    if (typeof fitted === 'string') return fitted;
    unfit.push(
      `pack.topics[${topicIndex}].article.facts[${fitted.unfit}]: the fact ` +
        `"${topic.article.facts[fitted.unfit]}" does not fit, with the facts before it, in the ` +
        `${field.max} characters of ${field.name}, the field the article's body goes to in ` +
        'this org: shorten the facts, or give Knowledge a longer field for the body',
    );
    return undefined;
  });
  if (unfit.length > 0) throw new ScenarioCompileError(unfit);
  const articles: SeedRow[] = [
    ...topics.map((topic, topicIndex) => ({
      key: articleKey(topicIndex),
      values: articleValues(
        topic.article,
        `${id}-${topic.key}-${seed}`,
        pack,
        finish,
        field && { name: field.name, text: topicBodies[topicIndex] ?? '' },
      ),
    })),
    {
      // The seed comes before the word: a topic's URL name ends with the
      // seed, so no topic key can make one equal to the decoy's.
      key: `${id}-decoy-article`,
      values: articleValues(
        pack.decoy,
        `${id}-${seed}-decoy`,
        pack,
        finish,
        field && {
          name: field.name,
          text: decoyBodyFor(finish.text(pack.decoy.body), finish.text(pack.decoy.summary), field),
        },
      ),
    },
  ];

  const template: SeedTemplate = {
    id: `scenario-${id}`,
    name: finish.text(pack.name),
    description: finish.text(pack.businessContext),
    version: 1,
    strategy: 'template',
    objects: [
      rowsOf('Account', 0, accounts),
      rowsOf('Contact', 1, contacts),
      rowsOf('Case', 2, cases),
      rowsOf('CaseComment', 3, comments),
      // An org without Knowledge has no articles to write: the run skips
      // them, saying why, and stays a success on the rest.
      { ...rowsOf('Knowledge__kav', 4, articles), optional: true },
    ],
    relations: [
      byKey('Contact', 'AccountId', 'Account'),
      // The case's account is its contact's: the platform files a case under
      // the account of its contact when the case names none.
      byKey('Case', 'ContactId', 'Contact'),
      byKey('CaseComment', 'ParentId', 'Case'),
    ],
    tags: ['scenario', id],
    createdAt: COMPILED_AT,
    updatedAt: COMPILED_AT,
  };

  return {
    packId: id,
    seed,
    template,
    tests: testCases(pack, openCases, articleKey, articles, finish),
    closedCaseArticles,
  };
}

/** An issue of a schema, said with where it is. */
function said(path: ReadonlyArray<PropertyKey>, issue: { message: string }): string {
  const where = path.reduce<string>(
    (at, step) => (typeof step === 'number' ? `${at}[${step}]` : `${at}.${String(step)}`),
    '',
  );
  return `${where.replace(/^\./, '')}: ${issue.message}`;
}

/**
 * What every text of the compiled scenario goes through: an email address or
 * a phone number made to reach nobody, as every seed's values are — a pack a
 * model drafted holds them as much as any answer — and a text cut to its
 * field. A number rewritten is rewritten the same way wherever it is, so a
 * subject quoted by a test still reads as the case's.
 */
function textFinisher(): {
  text(value: string, max?: number): string;
  row(values: SeedRow['values']): SeedRow['values'];
} {
  const replace = phoneReplacement();
  const replaced = new Map<string, string>();
  const replacement = (written: string): string => {
    const known = replaced.get(written);
    if (known !== undefined) return known;
    const fresh = replace(written);
    replaced.set(written, fresh);
    return fresh;
  };
  const safe = (values: Record<string, unknown>, phones: ReadonlySet<string>) =>
    reachNobody(values, phones, replacement);
  return {
    text(value, max) {
      const kept = safe({ text: value }, new Set()).text;
      return cut(typeof kept === 'string' ? kept : value, max);
    },
    row(values) {
      return safe(values, PHONE_FIELDS) as SeedRow['values'];
    },
  };
}

/**
 * A text cut to `max` characters, at the last word boundary within it when
 * there is one, as a seed cuts a value to its field.
 */
function cut(text: string, max: number | undefined): string {
  if (max === undefined || text.length <= max) return text;
  const head = text.slice(0, max);
  if (/\s/.test(text.charAt(max))) return head.trimEnd();
  const boundary = head.search(/\s\S*$/);
  return boundary > 0 ? head.slice(0, boundary).trimEnd() : head;
}

/** A pack's text with its placeholders filled; one with nothing to fill it stays as written. */
function fill(text: string, values: Partial<Record<ScenarioPlaceholder, string>>): string {
  return text.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (written, name: string) => {
    const value = (values as Record<string, string | undefined>)[name];
    return value ?? written;
  });
}

/** The comments of a case: its resolution, a step a comment, or the customer's follow-up while it is open. */
function caseComments(
  caseKey: string,
  template: ScenarioCaseTemplate,
  open: boolean,
  filled: Partial<Record<ScenarioPlaceholder, string>>,
  finish: ReturnType<typeof textFinisher>,
): SeedRow[] {
  const texts = open ? [template.followUp] : template.resolution;
  return texts.map((text, step) => ({
    key: `${caseKey}-${step + 1}`,
    parentKey: caseKey,
    values: {
      CommentBody: finish.text(fill(text, filled), FIELD_LENGTH.commentBody),
      // Internal: a published comment shows to the customer in a portal.
      IsPublished: false,
    },
  }));
}

/**
 * An article's fields. Its channels are closed, so that an article published
 * later shows to the org's own Knowledge readers and to nobody outside. Its
 * body goes to the field the run names, the org's own — `Summary` in place of
 * the summary on a Knowledge base that has no other; without one, the summary
 * is all it says.
 */
function articleValues(
  article: { title: string; summary: string },
  urlName: string,
  pack: ScenarioPack,
  finish: ReturnType<typeof textFinisher>,
  body: { name: string; text: string } | undefined,
): SeedRow['values'] {
  const values: SeedRow['values'] = {
    Title: finish.text(article.title, FIELD_LENGTH.articleTitle),
    UrlName: urlName,
    Summary: finish.text(article.summary, FIELD_LENGTH.articleSummary),
    Language: pack.language,
    IsVisibleInPkb: false,
    IsVisibleInCsp: false,
    IsVisibleInPrm: false,
  };
  if (body) values[body.name] = body.text;
  return values;
}

/** The field an article's body goes to, as the run names it. */
interface BodyField {
  name: string;
  /** The most characters it holds; absent, no bound. */
  max?: number;
  /** Whether it holds rich text, a paragraph a `<p>`. */
  html: boolean;
}

/** The body's field the options name, with how long it is; none when they name none. */
function bodyFieldOf(options: ScenarioCompileOptions): BodyField | undefined {
  const name = options.articleBodyField;
  if (name === undefined) return undefined;
  const max =
    options.articleBodyLength ?? (name === 'Summary' ? FIELD_LENGTH.articleSummary : undefined);
  return { name, ...(max !== undefined ? { max } : {}), html: options.articleBodyHtml === true };
}

/** A text's paragraphs, as its blank lines part them. */
function paragraphsOf(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

/** Paragraphs as the field holds them: apart by a blank line, or each a rich text paragraph. */
function rendered(paragraphs: readonly string[], field: BodyField): string {
  if (!field.html) return paragraphs.join('\n\n');
  return paragraphs.map((paragraph) => `<p>${escapedHtml(paragraph)}</p>`).join('');
}

/** A text as rich text shows it as written. */
function escapedHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Whether a text fits its field. */
function fits(text: string, field: BodyField): boolean {
  return field.max === undefined || text.length <= field.max;
}

/**
 * An article's body as its field holds it: whole when it fits; else the
 * paragraphs of it that state a fact, in its order; else its facts alone, a
 * paragraph each. Every fact stays in it word for word: cut at the field's
 * length, a body of a thousand characters in `Summary` lost the facts its end
 * stated, and an agent asked for one of them had no article that said it.
 *
 * @returns The text, or the place of the first fact that does not fit with
 *   the facts before it, when even the facts alone are longer than the field.
 */
function bodyFor(
  body: string,
  facts: readonly string[],
  field: BodyField,
): string | { unfit: number } {
  const paragraphs = paragraphsOf(body);
  const whole = field.html ? rendered(paragraphs, field) : body;
  if (fits(whole, field)) return whole;
  const stating = paragraphs.filter((paragraph) =>
    facts.some((fact) => statesScenarioFact(paragraph, fact)),
  );
  const statesAll = facts.every((fact) => statesScenarioFact(stating.join('\n\n'), fact));
  if (statesAll && fits(rendered(stating, field), field)) return rendered(stating, field);
  if (fits(rendered(facts, field), field)) return rendered(facts, field);
  const unfit = facts.findIndex((_, at) => !fits(rendered(facts.slice(0, at + 1), field), field));
  return { unfit: Math.max(0, unfit) };
}

/**
 * The decoy's body as its field holds it: whole when it fits, else its
 * summary, cut to the field when even that is longer. It states no fact: a
 * test passes by the agent not citing it.
 */
function decoyBodyFor(body: string, summary: string, field: BodyField): string {
  const whole = field.html ? rendered(paragraphsOf(body), field) : body;
  if (fits(whole, field)) return whole;
  const short = field.html ? rendered(paragraphsOf(summary), field) : summary;
  if (fits(short, field)) return short;
  const room = (field.max ?? summary.length) - (field.html ? '<p></p>'.length : 0);
  return field.html ? `<p>${cut(escapedHtml(summary), room)}</p>` : cut(summary, room);
}

/** An object written from its rows: as many records as rows, no rule. */
function rowsOf(objectApiName: string, insertOrder: number, rows: SeedRow[]): SeedObjectConfig {
  return {
    objectApiName,
    recordCount: rows.length,
    fieldRules: [],
    excludedFields: [],
    insertOrder,
    batchSize: 200,
    rows,
  };
}

/** A lookup filled from the rows this run writes for its parent, each child under the row it names. */
function byKey(childObject: string, lookupField: string, parentObject: string): SeedRelation {
  return {
    childObject,
    lookupField,
    parentObject,
    parents: { kind: 'generated' },
    distribution: { mode: 'byKey' },
  };
}

/**
 * The tests: each utterance of a topic said by a customer whose open case is
 * on it, in turn, its placeholders filled with that customer and that case;
 * then the utterances no topic covers, said about no case.
 */
function testCases(
  pack: ScenarioPack,
  openCases: readonly OpenCase[],
  articleKey: (topicIndex: number) => string,
  articles: readonly SeedRow[],
  finish: ReturnType<typeof textFinisher>,
): ScenarioTestCase[] {
  const onTopic = pack.topics.flatMap((topic, topicIndex) => {
    const saidBy = openCases.filter((open) => open.topicIndex === topicIndex);
    const article = articles[topicIndex].values;
    return topic.utterances.map((utterance, index): ScenarioTestCase => {
      const open = saidBy[index % saidBy.length];
      const customer = open.customer;
      const filled = { ...customer, caseSubject: open.subject };
      return {
        key: `${pack.id}-test-${topic.key}-${index + 1}`,
        topicKey: topic.key,
        utterance: finish.text(fill(utterance.text, filled)),
        expectedOutcome: finish.text(fill(utterance.expectedOutcome, filled)),
        article: {
          key: articleKey(topicIndex),
          title: String(article.Title),
          facts: topic.article.facts.map((fact) => finish.text(fact)),
        },
        openCase: {
          caseKey: open.key,
          contactKey: customer.key,
          subject: open.subject,
          contactEmail: customer.email,
        },
      };
    });
  });
  const outOfScope = pack.outOfScope.map((utterance, index): ScenarioTestCase => ({
    key: `${pack.id}-out-${index + 1}`,
    topicKey: null,
    utterance: finish.text(utterance.text),
    expectedOutcome: finish.text(utterance.expectedOutcome),
  }));
  return [...onTopic, ...outOfScope];
}

/** The locale whose names and numbers a pack's customers get: its language's, or English. */
function localeOf(language: string): SupportedLocale {
  const locales = Object.keys(LOCALE_DATA) as SupportedLocale[];
  return (
    locales.find((locale) => locale === language) ??
    locales.find((locale) => locale.split('_')[0] === language.split('_')[0]) ??
    'en_US'
  );
}

/**
 * The customers, drawn from the seed: as many companies of the locale, each
 * once, and a person at each. The keys are the customers' places, which no
 * seed changes; the names are the seed's.
 */
function drawCustomers(
  packId: string,
  count: number,
  locale: SupportedLocale,
  seed: number,
): Customer[] {
  const random = seededRandom(seed);
  const companies = [...companiesOf(locale)];
  // The first `count` places of a shuffle: each company at most once.
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(random() * (companies.length - i));
    [companies[i], companies[j]] = [companies[j], companies[i]];
  }
  const firstNames = FIRST_NAMES[locale];
  const lastNames = LAST_NAMES[locale];
  return Array.from({ length: count }, (_, index) => {
    const company = companies[index];
    const firstName = firstNames[Math.floor(random() * firstNames.length)];
    const lastName = lastNames[Math.floor(random() * lastNames.length)];
    const local = [firstName, lastName].map(asciiWord).filter(Boolean).join('.');
    return {
      key: `${packId}-c${String(index + 1).padStart(2, '0')}`,
      company,
      firstName,
      lastName,
      email: `${local || `contact${index + 1}`}@${domainOf(company)}`,
    };
  });
}

/** A word in lower-case ASCII letters and digits, its accents dropped. */
function asciiWord(word: string): string {
  return word
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * The company's domain, under the top-level domain reserved for examples:
 * mail to it reaches nobody, and the name still reads as the company's.
 */
function domainOf(company: string): string {
  const name = company
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${name || 'company'}.example`;
}

/**
 * A random draw the seed fixes (mulberry32): the same seed gives the same
 * draws, on any machine, which `Math.random` does not.
 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
