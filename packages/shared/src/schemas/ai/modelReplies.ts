import * as z from 'zod';
import {
  SCENARIO_PACK_LIMITS,
  scenarioArticleSchema,
  scenarioPackSchema,
  scenarioTopicSchema,
} from '../scenario.schema.js';

/**
 * Shapes of the JSON the extension asks a model for, and the one way to read a
 * reply into them.
 *
 * A model reply is text. Asked for JSON, a model often wraps it in a markdown
 * fence or writes a sentence around it, and each reader used to parse it its
 * own way: the pipeline reader parsed the raw text, so a fenced draft read as
 * no JSON at all and came back with no step. The defaults these schemas fill
 * in are the ones the readers applied field by field.
 */

/**
 * The first fenced block of a reply, with or without a `json` tag. The
 * whitespace around the content is trimmed after the match, not inside it:
 * `\s*` on both sides of a lazy body backtracks polynomially, and a reply that
 * opened a fence and sent 5,000 spaces without closing it held the extension
 * host for 23 seconds.
 */
const FENCED_BLOCK = /```(?:json)?([\s\S]*?)```/;

/**
 * Parse a model reply as JSON and read it with `schema`.
 *
 * The JSON is the first fenced block when the reply has one, the whole trimmed
 * reply otherwise.
 *
 * @throws Error when the reply is not JSON, or its JSON does not fit `schema`.
 *   The message quotes neither the reply nor its values: a reply can repeat org
 *   data back.
 */
export function parseModelJson<S extends z.ZodTypeAny>(schema: S, reply: string): z.output<S> {
  const result = schema.safeParse(replyJson(reply));
  if (!result.success) {
    throw new Error('The AI reply is JSON, but not in the expected format.');
  }
  return result.data as z.output<S>;
}

/**
 * The JSON of a reply: its first fenced block when it has one, the whole
 * trimmed reply otherwise.
 *
 * @throws Error when it is not JSON.
 */
function replyJson(reply: string): unknown {
  const trimmed = reply.trim();
  const fenced = FENCED_BLOCK.exec(trimmed);
  const text = fenced ? fenced[1].trim() : trimmed;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('The AI reply is not valid JSON.');
  }
}

/** Most places a refused reply is said to break, so that a reply wrong everywhere is not a page of them. */
const MAX_ISSUES_SAID = 10;

/**
 * A reply that is JSON, refused for the fields that do not fit what was asked
 * for: each by its path in the reply (`topics[2].article.facts[1]`) and what
 * is wrong there.
 */
export class ModelReplyShapeError extends Error {
  constructor(readonly issues: string[]) {
    const said = issues.slice(0, MAX_ISSUES_SAID);
    const more = issues.length - said.length;
    super(
      `The AI reply is JSON, but not in the expected format: ${said.join('; ')}` +
        (more > 0 ? `; and ${more} more` : ''),
    );
    this.name = 'ModelReplyShapeError';
  }
}

/** A path into a reply, as a refusal names it: `topics[2].article.facts[1]`. */
function replyPath(path: ReadonlyArray<PropertyKey>): string {
  const where = path.reduce<string>(
    (at, step) => (typeof step === 'number' ? `${at}[${step}]` : `${at}.${String(step)}`),
    '',
  );
  return where.replace(/^\./, '') || '(the reply)';
}

/**
 * Parse a model reply as JSON and read it with `schema`, refusing it with
 * every field that does not fit.
 *
 * Where {@link parseModelJson} says only that a reply does not fit, this names
 * the fields: a scenario pack is long, bounded field by field, and a draft
 * the user is told was refused "in the wrong format" cannot be corrected or
 * asked again any better. The refusal quotes what the schema says of a field,
 * which can quote a text of the reply: it is for replies to prompts that carry
 * no record of the org, so that a reply has none to repeat.
 *
 * @throws Error when the reply is not JSON.
 * @throws ModelReplyShapeError when its JSON does not fit `schema`.
 */
export function parseModelReplyNamingFields<S extends z.ZodTypeAny>(
  schema: S,
  reply: string,
): z.output<S> {
  const result = schema.safeParse(replyJson(reply));
  if (!result.success) {
    throw new ModelReplyShapeError(
      result.error.issues.map((issue) => `${replyPath(issue.path)}: ${issue.message}`),
    );
  }
  return result.data as z.output<S>;
}

/** An array read item by item: the items that fit `item` are kept, the rest dropped. */
function keepFitting<T extends z.ZodTypeAny>(
  item: T,
): z.ZodPipe<z.ZodArray<z.ZodUnknown>, z.ZodTransform<Array<z.output<T>>, unknown[]>> {
  return z.array(z.unknown()).transform((items) =>
    items.flatMap((entry): Array<z.output<T>> => {
      const parsed = item.safeParse(entry);
      return parsed.success ? [parsed.data as z.output<T>] : [];
    }),
  );
}

/** A JSON object, and nothing else: not an array, not null. */
const JsonObjectSchema = z.record(z.string(), z.unknown());

/** One step of a pipeline draft. A step with no name or no type cannot be placed on the canvas. */
const PipelineDraftStepSchema = z.object({
  name: z.string(),
  type: z.string(),
  config: JsonObjectSchema.catch({}),
  description: z.string().catch(''),
});

/** A pipeline draft. Steps that do not fit are dropped; a draft left with none is the caller's to refuse. */
export const PipelineDraftReplySchema = z.object({
  name: z.string().optional().catch(undefined),
  description: z.string().optional().catch(undefined),
  steps: keepFitting(PipelineDraftStepSchema).catch([]),
  schedule: z.string().optional().catch(undefined),
  triggers: keepFitting(z.string()).optional().catch(undefined),
});

/** A natural-language-to-SOQL draft. */
export const NL2SOQLReplySchema = z.object({
  soql: z.string().catch(''),
  explanation: z.string().catch(''),
  confidence: z.number().catch(0),
  alternatives: keepFitting(z.string()).optional().catch(undefined),
});

/**
 * A custom Seed persona. Each data pattern stays unread here: whether Seed can
 * generate it depends on generator params the extension checks.
 */
export const PersonaReplySchema = z.object({
  name: z.string().catch('Custom Persona'),
  description: z.string().catch(''),
  industry: z.string().catch('General'),
  locale: z.string().catch('en-US'),
  dataPatterns: JsonObjectSchema.catch({}),
});

/** One way out of a failure: what to try, and how likely it is to be the cause. */
const ErrorSuggestionSchema = z.object({
  title: z.string().catch('Unknown'),
  description: z.string().catch(''),
  probability: z.number().catch(0.5),
  action: z.string().optional().catch(undefined),
});

/**
 * A model's reading of a Salesforce error. Every field carries the default the
 * resolver used to apply field by field, so a reply that names none of them
 * still produces a resolution the notification can show.
 */
export const ErrorResolutionReplySchema = z.object({
  explanation: z.string().catch('Unable to determine root cause.'),
  suggestions: keepFitting(ErrorSuggestionSchema).catch([]),
  autoFixable: z.boolean().catch(false),
  autoFixAction: z.string().optional().catch(undefined),
  confidence: z.number().catch(0.5),
  relatedDocs: keepFitting(z.string()).catch([]),
});

/**
 * Generated records. An array keeps its objects, a single object is one
 * record, and any other JSON value carries no record.
 */
export const DataRowsReplySchema = z.union([
  keepFitting(JsonObjectSchema),
  JsonObjectSchema.transform((row) => [row]),
  z.unknown().transform((): Array<Record<string, unknown>> => []),
]);

/**
 * Bounds of what a scenario pack is drafted from. The scenario text goes out
 * with each call of a draft, a plan and then one call a topic: nine calls for
 * a pack of eight topics.
 */
export const SCENARIO_DRAFT_LIMITS = {
  /** The scenario as the user writes it. */
  text: 8_000,
  /** A Case picklist holds up to 1,000 values; the prompt names its first ones. */
  picklistValues: 1_000,
  picklistValue: 255,
  /** The agent's topics, and the actions of one topic. */
  agentTopics: 100,
  agentActions: 100,
  agentName: 255,
  agentLabel: 255,
  agentDescription: 4_000,
} as const;

/** A topic as a plan names it: what customers say on it, before its article and cases are written. */
const plannedTopicSchema = scenarioTopicSchema.pick({ key: true, label: true, utterances: true });

/** The part of a plan or a draft {@link checkScenarioPlan} reads. */
interface ScenarioPlanKeys {
  customers: { count: number };
  topics: ReadonlyArray<{ key: string }>;
  decoy: { resembles: string };
}

/**
 * What a plan breaks between its parts, as a pack would: a topic named
 * twice, a decoy that resembles no topic of it, or fewer customers than
 * topics. The topics are written one call each from the plan, by key, so a
 * plan that breaks one of these is refused before any of them is asked for.
 * Two articles of one title can only be told once they are written, by the
 * pack's own schema.
 */
function checkScenarioPlan(
  plan: ScenarioPlanKeys,
  ctx: { addIssue(issue: { code: 'custom'; path: Array<string | number>; message: string }): void },
): void {
  const issue = (path: Array<string | number>, message: string): void =>
    ctx.addIssue({ code: 'custom', path, message });
  const keys = plan.topics.map((topic) => topic.key);
  for (const [index, key] of keys.entries()) {
    if (keys.indexOf(key) !== index) {
      issue(
        ['topics', index, 'key'],
        `The topic "${key}" is named twice: each topic is named once`,
      );
    }
  }
  if (!keys.includes(plan.decoy.resembles)) {
    issue(
      ['decoy', 'resembles'],
      `The decoy resembles the topic "${plan.decoy.resembles}", which the plan does not have: ` +
        `its topics are ${keys.map((key) => `"${key}"`).join(', ')}`,
    );
  }
  if (plan.customers.count < plan.topics.length) {
    issue(
      ['customers', 'count'],
      `${plan.customers.count} customer(s) for ${plan.topics.length} topics: ` +
        "each topic's utterances are said about a customer's open case on it, so a pack has a customer a topic",
    );
  }
}

const packShape = scenarioPackSchema.shape;

/**
 * The first reply of a draft: the pack without the articles and cases of its
 * topics — its context, its customers, each topic with what customers say on
 * it, the decoy article and what no topic covers.
 */
const ScenarioPlanReplySchema = z
  .strictObject({
    id: packShape.id,
    name: packShape.name,
    businessContext: packShape.businessContext,
    customers: packShape.customers,
    topics: z
      .array(plannedTopicSchema)
      .min(SCENARIO_PACK_LIMITS.topics.min)
      .max(SCENARIO_PACK_LIMITS.topics.max),
    decoy: packShape.decoy,
    outOfScope: packShape.outOfScope,
  })
  .superRefine(checkScenarioPlan);

/** The reply for one topic of a plan: the article that answers it and the cases customers open on it. */
const ScenarioTopicReplySchema = z.strictObject({
  article: scenarioArticleSchema,
  caseTemplates: scenarioTopicSchema.shape.caseTemplates,
});

/**
 * The replies a scenario pack is drafted from, each held to the bounds the
 * pack holds the same fields to (`scenario.schema.ts`): the plan, then one
 * reply a topic. A pack drafted whole would not fit in one reply.
 */
export const ScenarioPackReplySchema = {
  plan: ScenarioPlanReplySchema,
  topic: ScenarioTopicReplySchema,
} as const;

/** The plan of a scenario pack, as its first reply holds it. */
export type ScenarioPlanReply = z.output<typeof ScenarioPlanReplySchema>;

/** One topic written, as its reply holds it. */
export type ScenarioTopicReply = z.output<typeof ScenarioTopicReplySchema>;

/**
 * A topic of a draft: planned, and written once its reply came, with its
 * article and its cases. A topic with neither is one the draft stopped
 * before.
 */
const draftTopicSchema = plannedTopicSchema.extend({
  article: scenarioArticleSchema.optional(),
  caseTemplates: scenarioTopicSchema.shape.caseTemplates.optional(),
});

/**
 * A scenario pack being drafted: every topic of its plan, those written so
 * far with their article and cases. A draft stopped or failed part way is
 * kept in this shape, for the user to read and to go on with; until every
 * topic is written it is no pack, and the pack's schema refuses it — so
 * nothing is compiled, let alone written to an org, from a draft that stopped.
 */
export const ScenarioPackDraftSchema = z
  .strictObject({
    version: packShape.version,
    id: packShape.id,
    name: packShape.name,
    language: packShape.language,
    businessContext: packShape.businessContext,
    customers: packShape.customers,
    topics: z
      .array(draftTopicSchema)
      .min(SCENARIO_PACK_LIMITS.topics.min)
      .max(SCENARIO_PACK_LIMITS.topics.max),
    decoy: packShape.decoy,
    outOfScope: packShape.outOfScope,
  })
  .superRefine(checkScenarioPlan);

/** A scenario pack being drafted (see {@link ScenarioPackDraftSchema}). */
export type ScenarioPackDraft = z.output<typeof ScenarioPackDraftSchema>;
