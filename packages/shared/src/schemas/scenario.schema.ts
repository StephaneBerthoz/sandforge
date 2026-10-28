import * as z from 'zod';

/**
 * Zod schemas of a scenario pack (`ScenarioPack`, version 1) and of the
 * choices a run compiles one with.
 *
 * A pack is kept in the workspace as a file, edited by hand or drafted by a
 * model, and every record a scenario writes is compiled from it. So every
 * object of it is strict — a misspelt `facts` would be a list the file seems
 * to hold and the compiler never reads — and every text is bounded by the
 * field it ends up in, so that what a test cites is what was written, not a
 * text the org cut short.
 */

/**
 * What a pack's texts can name, filled with the customer's own and the
 * subject of the case when they are compiled: a test that names the address
 * of the contact it is about can be checked against the record it names.
 */
export const SCENARIO_PLACEHOLDERS = [
  'firstName',
  'lastName',
  'company',
  'email',
  'caseSubject',
] as const;

/** A placeholder of {@link SCENARIO_PLACEHOLDERS}, written `{firstName}` in a text. */
export type ScenarioPlaceholder = (typeof SCENARIO_PLACEHOLDERS)[number];

/** What names the customer: what a case's subject can hold, which no case subject can name. */
const CUSTOMER_PLACEHOLDERS: readonly ScenarioPlaceholder[] = [
  'firstName',
  'lastName',
  'company',
  'email',
];

/**
 * Bounds of a pack. A text is bounded by the field it is written to, less
 * the room its placeholders take once filled: a case's subject goes to a
 * field of 255 characters, and a company's name can be forty.
 */
export const SCENARIO_PACK_LIMITS = {
  /** Longest key of a pack or a topic, which every row key and article URL name starts with. */
  maxKeyLength: 40,
  topics: { min: 3, max: 8 },
  caseTemplates: { min: 1, max: 4 },
  utterances: { min: 1, max: 5 },
  outOfScope: { min: 2, max: 5 },
  facts: { min: 3, max: 5 },
  resolutionSteps: { min: 1, max: 4 },
  /**
   * Most customers a pack or a run asks for. With the most history, that is
   * two hundred cases: an insert past two hundred records goes as a Bulk API
   * job, whose answer may not say which row became which record, and the
   * comments of a case are placed under it by that answer.
   */
  maxCustomers: 50,
  /** Most closed cases a customer has beside its open one. */
  maxHistoryPerCustomer: 3,
  text: {
    name: 80,
    label: 80,
    industry: 40,
    businessContext: 1_000,
    /** `Knowledge__kav.Title`. */
    articleTitle: 255,
    /** `Knowledge__kav.Summary`. */
    articleSummary: 1_000,
    articleBody: 8_000,
    fact: 300,
    caseSubject: 200,
    caseDescription: 4_000,
    /** A `CaseComment.CommentBody` holds 4,000 characters, a filled placeholder included. */
    comment: 2_000,
    utterance: 1_000,
  },
} as const;

/**
 * The choices a run makes when it does not make its own: a seed of its own,
 * two closed cases a customer, and the statuses a new org's cases have.
 */
export const SCENARIO_COMPILE_DEFAULTS = {
  seed: 1,
  historyPerCustomer: 2,
  caseStatus: { open: 'New', closed: 'Closed' },
} as const;

/** A placeholder as a text writes one: a word in braces. */
const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

/** The placeholders a text names, each once, in the order it names them. */
export function scenarioPlaceholdersIn(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((match) => match[1]))];
}

/** Whether a name is one of {@link SCENARIO_PLACEHOLDERS}. */
function isScenarioPlaceholder(name: string): name is ScenarioPlaceholder {
  return (SCENARIO_PLACEHOLDERS as readonly string[]).includes(name);
}

/**
 * A text of the pack: not blank, at most `max` characters, and naming only
 * the placeholders it is filled with. Where none is filled, a placeholder's
 * name would be written as it stands, and is refused; any other word in
 * braces there is text, an API path's `{projectId}` among them. Where some
 * are, a word in braces that is not one of them is a placeholder misspelt.
 */
function scenarioText(max: number, placeholders: readonly ScenarioPlaceholder[] = []) {
  return z
    .string()
    .max(max)
    .regex(/\S/, 'A text of the pack says something: it is empty or blank')
    .superRefine((text, ctx) => {
      for (const name of scenarioPlaceholdersIn(text)) {
        if ((placeholders as readonly string[]).includes(name)) continue;
        if (placeholders.length === 0) {
          if (!isScenarioPlaceholder(name)) continue;
          ctx.addIssue({
            code: 'custom',
            message: `{${name}} is not filled in this text, and would be written as it stands`,
          });
        } else {
          ctx.addIssue({
            code: 'custom',
            message:
              `{${name}} is not a placeholder of this text, which can name ` +
              placeholders.map((p) => `{${p}}`).join(', '),
          });
        }
      }
    });
}

/**
 * What names a pack or a topic: lower-case words joined by single hyphens,
 * starting with a letter. It goes into the article URL names, which take
 * letters, digits and hyphens.
 */
export const scenarioKeySchema = z
  .string()
  .min(2)
  .max(SCENARIO_PACK_LIMITS.maxKeyLength)
  .regex(
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,
    'A key is lower-case letters and digits in words joined by single hyphens, starting with a letter',
  );

/** A text as a fact is compared with a body: its words, in lower case. */
function wordsOf(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

const { text: TEXT } = SCENARIO_PACK_LIMITS;

/** A Knowledge article of a topic, and the facts its body states. */
export const scenarioArticleSchema = z
  .strictObject({
    title: scenarioText(TEXT.articleTitle),
    summary: scenarioText(TEXT.articleSummary),
    body: scenarioText(TEXT.articleBody),
    facts: z
      .array(scenarioText(TEXT.fact))
      .min(SCENARIO_PACK_LIMITS.facts.min)
      .max(SCENARIO_PACK_LIMITS.facts.max),
  })
  .superRefine((article, ctx) => {
    const body = wordsOf(article.body);
    for (const [index, fact] of article.facts.entries()) {
      if (body.includes(wordsOf(fact))) continue;
      ctx.addIssue({
        code: 'custom',
        path: ['facts', index],
        message:
          `The fact "${fact}" is not stated by the article's body word for word: ` +
          'an agent answering from the article can only cite what its body says',
      });
    }
  });

/** The article close to a topic that does not answer it. */
export const scenarioDecoyArticleSchema = z.strictObject({
  title: scenarioText(TEXT.articleTitle),
  summary: scenarioText(TEXT.articleSummary),
  body: scenarioText(TEXT.articleBody),
  resembles: scenarioKeySchema,
});

/** A case customers open on a topic. */
export const scenarioCaseTemplateSchema = z.strictObject({
  subject: scenarioText(TEXT.caseSubject, CUSTOMER_PLACEHOLDERS),
  description: scenarioText(TEXT.caseDescription, SCENARIO_PLACEHOLDERS),
  priority: z.enum(['High', 'Medium', 'Low']),
  origin: z.enum(['Phone', 'Email', 'Web']),
  followUp: scenarioText(TEXT.comment, SCENARIO_PLACEHOLDERS),
  resolution: z
    .array(scenarioText(TEXT.comment, SCENARIO_PLACEHOLDERS))
    .min(SCENARIO_PACK_LIMITS.resolutionSteps.min)
    .max(SCENARIO_PACK_LIMITS.resolutionSteps.max),
});

/** What a customer says on a topic, about the open case it is said about. */
export const scenarioUtteranceSchema = z.strictObject({
  text: scenarioText(TEXT.utterance, SCENARIO_PLACEHOLDERS),
  expectedOutcome: scenarioText(TEXT.utterance, SCENARIO_PLACEHOLDERS),
});

/** What a customer says that no topic covers: said about no case, it names nobody. */
export const scenarioOutOfScopeUtteranceSchema = z.strictObject({
  text: scenarioText(TEXT.utterance),
  expectedOutcome: scenarioText(TEXT.utterance),
});

/** A subject customers write about. */
export const scenarioTopicSchema = z.strictObject({
  key: scenarioKeySchema,
  label: scenarioText(TEXT.label),
  article: scenarioArticleSchema,
  caseTemplates: z
    .array(scenarioCaseTemplateSchema)
    .min(SCENARIO_PACK_LIMITS.caseTemplates.min)
    .max(SCENARIO_PACK_LIMITS.caseTemplates.max),
  utterances: z
    .array(scenarioUtteranceSchema)
    .min(SCENARIO_PACK_LIMITS.utterances.min)
    .max(SCENARIO_PACK_LIMITS.utterances.max),
});

/** The companies of a pack. */
export const scenarioCustomersSchema = z.strictObject({
  count: z.number().int().min(1).max(SCENARIO_PACK_LIMITS.maxCustomers),
  industry: scenarioText(TEXT.industry),
});

/** The part of a pack {@link checkScenarioPack} reads. */
interface ScenarioPackKeys {
  customers: { count: number };
  topics: ReadonlyArray<{ key: string; article: { title: string } }>;
  decoy: { title: string; resembles: string };
}

/**
 * What a pack's parts break between them: a topic named twice, a decoy that
 * resembles a topic the pack does not have, two articles of one title — the
 * agent's answer is told apart by the title it cites — or fewer customers
 * than topics, which would leave a topic with no open case to test it on.
 */
export function checkScenarioPack(
  pack: ScenarioPackKeys,
  ctx: { addIssue(issue: { code: 'custom'; path: Array<string | number>; message: string }): void },
): void {
  const issue = (path: Array<string | number>, message: string): void =>
    ctx.addIssue({ code: 'custom', path, message });
  const keys = pack.topics.map((topic) => topic.key);
  for (const [index, key] of keys.entries()) {
    if (keys.indexOf(key) !== index) {
      issue(
        ['topics', index, 'key'],
        `The topic "${key}" is named twice: each topic is named once`,
      );
    }
  }
  if (!keys.includes(pack.decoy.resembles)) {
    issue(
      ['decoy', 'resembles'],
      `The decoy resembles the topic "${pack.decoy.resembles}", which the pack does not have: ` +
        `its topics are ${keys.map((key) => `"${key}"`).join(', ')}`,
    );
  }
  const titles = new Map<string, string>();
  const titled = [
    ...pack.topics.map((topic, index) => ({
      title: topic.article.title,
      path: ['topics', index, 'article', 'title'],
      of: `the article of "${topic.key}"`,
    })),
    { title: pack.decoy.title, path: ['decoy', 'title'], of: 'the decoy' },
  ];
  for (const { title, path, of } of titled) {
    const first = titles.get(wordsOf(title));
    if (first !== undefined) {
      issue(path, `"${title}" is the title of ${first} too: each article has a title of its own`);
    } else {
      titles.set(wordsOf(title), of);
    }
  }
  if (pack.customers.count < pack.topics.length) {
    issue(
      ['customers', 'count'],
      `${pack.customers.count} customer(s) for ${pack.topics.length} topics: each topic's ` +
        "utterances are said about a customer's open case on it, so a pack has a customer a topic",
    );
  }
}

/** A scenario pack, version 1. */
export const scenarioPackSchema = z
  .strictObject({
    version: z.literal(1),
    id: scenarioKeySchema,
    name: scenarioText(TEXT.name),
    language: z
      .string()
      .regex(/^[a-z]{2}(?:_[A-Z]{2})?$/, 'A language as Salesforce writes one: en_US, fr, pt_BR'),
    businessContext: scenarioText(TEXT.businessContext),
    customers: scenarioCustomersSchema,
    topics: z
      .array(scenarioTopicSchema)
      .min(SCENARIO_PACK_LIMITS.topics.min)
      .max(SCENARIO_PACK_LIMITS.topics.max),
    decoy: scenarioDecoyArticleSchema,
    outOfScope: z
      .array(scenarioOutOfScopeUtteranceSchema)
      .min(SCENARIO_PACK_LIMITS.outOfScope.min)
      .max(SCENARIO_PACK_LIMITS.outOfScope.max),
  })
  .superRefine(checkScenarioPack);

/** A field of the org, by its API name. */
const fieldApiNameSchema = z
  .string()
  .max(80)
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'A field API name: letters, digits and underscores');

/**
 * The fields an article is compiled with, besides its summary: a body sent
 * to one of them would take the place of its title, its URL name or the
 * channels it is closed to.
 */
const ARTICLE_FIELDS_WRITTEN: readonly string[] = [
  'Title',
  'UrlName',
  'Language',
  'IsVisibleInPkb',
  'IsVisibleInCsp',
  'IsVisibleInPrm',
];

/** A `Case.Status` value of the org. */
const caseStatusValueSchema = z.string().min(1).max(255);

/** How a run compiles a pack (`ScenarioCompileOptions`). */
export const scenarioCompileOptionsSchema = z.strictObject({
  seed: z
    .number()
    .int()
    .min(0)
    .max(2 ** 32 - 1)
    .optional(),
  customers: z.number().int().min(1).max(SCENARIO_PACK_LIMITS.maxCustomers).optional(),
  historyPerCustomer: z
    .number()
    .int()
    .min(0)
    .max(SCENARIO_PACK_LIMITS.maxHistoryPerCustomer)
    .optional(),
  caseStatus: z
    .strictObject({ open: caseStatusValueSchema, closed: caseStatusValueSchema })
    .refine((status) => status.open !== status.closed, {
      message: 'An open case and a closed one are written with two statuses',
      path: ['closed'],
    })
    .optional(),
  articleBodyField: fieldApiNameSchema
    .refine((field) => !ARTICLE_FIELDS_WRITTEN.includes(field), {
      message:
        'The article is written with this field already: its body goes to a field of its own, ' +
        'or to Summary',
    })
    .optional(),
});
