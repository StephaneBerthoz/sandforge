import {
  ModelReplyShapeError,
  SCENARIO_PACK_LIMITS,
  ScenarioPackReplySchema,
  parseModelReplyNamingFields,
  scenarioPackSchema,
  type ScenarioCasePicklists,
  type ScenarioDraftAgent,
  type ScenarioDraftFailedAt,
  type ScenarioPack,
  type ScenarioPackDraft,
  type ScenarioPlanReply,
  type ScenarioTopicReply,
} from '@sandforge/shared';
import { wrapAsUserData } from '../../adapters/ai/safety/index.js';
import {
  SCENARIO_PLAN_SYSTEM_PROMPT,
  SCENARIO_TOPIC_SYSTEM_PROMPT,
} from '../../adapters/ai/systemPrompts/index.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { phoneReplacement, reachNobody } from '../seed/AIDataGenerator.js';
import type { AIProvider, AIProviderOptions } from './types.js';

/**
 * What a scenario pack is drafted from, and all that is sent of it: the
 * scenario the user wrote, its email addresses and phone numbers rewritten to
 * reach nobody first; the language its texts are written in; the words the
 * target org's cases are written with; and, when an agent is chosen, what its
 * topics and their actions are called and what they say they do. No record
 * of the org is among them.
 */
export interface ScenarioDraftRequest {
  /** The scenario, in the user's words. */
  text: string;
  /** As Salesforce writes a language: `en_US`, `fr`. A draft gone on with keeps its own. */
  language: string;
  /** The active values of the target org's Case picklists. */
  casePicklists?: ScenarioCasePicklists;
  /**
   * The agent the tests are for. Only the names, labels and descriptions of
   * its topics and their actions are read, whatever else the caller hands
   * over with them: the agent catalog also carries ids and variables.
   */
  agent?: ScenarioDraftAgent;
  /** A draft that stopped or failed part way: its plan is kept, and only the topics it lacks are written. */
  from?: ScenarioPackDraft;
}

/**
 * How a draft ended. Complete, it is a pack the user reads and saves before
 * anything is written from it. Stopped or failed, `draft` is what was
 * written before, which is no pack: absent when the plan itself never came.
 */
export type ScenarioDraftOutcome =
  | { kind: 'complete'; sentText: string; pack: ScenarioPack }
  | { kind: 'stopped'; sentText: string; draft?: ScenarioPackDraft }
  | {
      kind: 'failed';
      sentText: string;
      /** In the provider's words — the budget, a refusal, a reply cut off — or naming the fields a reply broke. */
      error: string;
      failedAt: ScenarioDraftFailedAt;
      /** The fields a refused reply broke, each by its path. */
      issues?: string[];
      draft?: ScenarioPackDraft;
    };

/** The Case picklists a draft is told of, in the order the prompt names them. */
const CASE_PICKLISTS = ['Status', 'Origin', 'Priority', 'Type'] as const;

/**
 * Values of one picklist the prompt names. They are the words the cases are
 * written with, for the model to use rather than to list: an org can keep a
 * thousand `Type` values, and every call of a draft would carry them all.
 */
const PICKLIST_VALUES_SENT = 50;

/**
 * Characters of an agent's topic or action description the plan is told.
 * The plan only aligns the pack's topics with the agent's, and the catalog
 * of a large agent would otherwise outweigh the scenario itself.
 */
const AGENT_DESCRIPTION_SENT = 300;

/**
 * Drafts a scenario pack from a scenario the user wrote, in bounded calls:
 * one for the plan — the business, its customers, the topics with what
 * customers say on each, the decoy article and what no topic covers — then
 * one a topic for its article and cases. Each reply stays under the reply
 * limit every AI call has (8,192 tokens); a whole pack in one reply would be
 * cut off, and a reply cut off is refused.
 *
 * Every reply is read through the pack's own bounds, refused with the fields
 * it breaks, and has its email addresses and phone numbers made to reach
 * nobody. A failed call fails the draft with the provider's words, and
 * nothing stands in for what the model did not write: an invented article
 * would make a test of the agent pass or fail on text nobody wrote for it.
 *
 * The signal is the page's Stop: the call in flight is aborted, none is
 * started after it, and the topics written before stay in the draft.
 */
export class ScenarioDrafter {
  constructor(private readonly provider: AIProvider) {}

  /**
   * Draft a pack, or go on with one.
   *
   * @param request - What the pack is drafted from.
   * @param options - The signal that stops the draft.
   * @returns How the draft ended; it never throws for a call that failed.
   */
  async draft(
    request: ScenarioDraftRequest,
    options: AIProviderOptions = {},
  ): Promise<ScenarioDraftOutcome> {
    const { signal } = options;
    const mask = createMasker();
    const sentText = mask.text(request.text);
    // A draft handed back may hold texts the user typed into it since.
    let draft = request.from ? mask.deep(request.from) : undefined;
    const context = promptContext({ ...request, language: draft?.language ?? request.language });
    const ask = (prompt: string, system: string): Promise<string> =>
      this.provider(prompt, system, signal ? { signal } : {});
    const stopped = (): ScenarioDraftOutcome => ({
      kind: 'stopped',
      sentText,
      ...(draft ? { draft } : {}),
    });

    let at: ScenarioDraftFailedAt = { call: 'plan' };
    try {
      if (!draft) {
        if (signal?.aborted) return stopped();
        const reply = await ask(planPrompt(context, sentText), SCENARIO_PLAN_SYSTEM_PROMPT);
        // An answer that comes after the Stop is not applied.
        if (signal?.aborted) return stopped();
        const plan = mask.deep(parseModelReplyNamingFields(ScenarioPackReplySchema.plan, reply));
        draft = draftOf(plan, context.language);
      }
      for (const [index, topic] of draft.topics.entries()) {
        if (isWritten(topic)) continue;
        at = { call: 'topic', topicKey: topic.key };
        if (signal?.aborted) return stopped();
        const reply = await ask(
          topicPrompt(context, sentText, draft, index),
          SCENARIO_TOPIC_SYSTEM_PROMPT,
        );
        if (signal?.aborted) return stopped();
        const written = mask.deep(
          parseModelReplyNamingFields(ScenarioPackReplySchema.topic, reply),
        );
        draft = withTopicWritten(draft, index, written);
      }
    } catch (err: unknown) {
      if (signal?.aborted) return stopped();
      return {
        kind: 'failed',
        sentText,
        error: extractErrorMessage(err),
        failedAt: at,
        ...(err instanceof ModelReplyShapeError ? { issues: err.issues } : {}),
        ...(draft ? { draft } : {}),
      };
    }

    // Each reply fitted on its own; what only the whole pack can break — two
    // articles of one title, a text a rewritten address made too long — is
    // checked once every topic is written, by the schema a pack is compiled
    // with.
    const pack = scenarioPackSchema.safeParse(packOf(draft));
    if (!pack.success) {
      const issues = pack.error.issues.map((issue) => `${pathOf(issue.path)}: ${issue.message}`);
      return {
        kind: 'failed',
        sentText,
        error: `The drafted pack does not hold together: ${issues.join('; ')}`,
        failedAt: { call: 'pack' },
        issues,
        draft,
      };
    }
    return { kind: 'complete', sentText, pack: pack.data };
  }
}

/**
 * The scenario text as a draft sends it: every email address on a domain
 * that is not reserved moved to one that is, and every phone number nobody
 * could be reached on replaced by one nobody holds. What the page shows the
 * user before anything is sent, computed the way the draft computes it.
 */
export function maskScenarioText(text: string): string {
  return createMasker().text(text);
}

/** Rewrites the addresses and numbers of the texts of one draft, a number the same way each time. */
interface Masker {
  text(value: string): string;
  /** Every string of a value, keys left as they are. */
  deep<T>(value: T): T;
}

/** No field of a draft holds a phone number on its own: every text is read as free text. */
const NO_PHONE_FIELDS: ReadonlySet<string> = new Set();

function createMasker(): Masker {
  const replace = phoneReplacement();
  const replaced = new Map<string, string>();
  // The same number in the scenario, a fact and the body that states it is
  // rewritten the same way, so a fact is still the body's word for word.
  const replacement = (written: string): string => {
    const known = replaced.get(written);
    if (known !== undefined) return known;
    const fresh = replace(written);
    replaced.set(written, fresh);
    return fresh;
  };
  const text = (value: string): string => {
    const kept = reachNobody({ text: value }, NO_PHONE_FIELDS, replacement).text;
    return typeof kept === 'string' ? kept : value;
  };
  const deep = (value: unknown): unknown => {
    if (typeof value === 'string') return text(value);
    if (Array.isArray(value)) return value.map(deep);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, deep(v)]));
    }
    return value;
  };
  return { text, deep: <T>(value: T): T => deep(value) as T };
}

/** What every call of one draft is told besides its own task. */
interface PromptContext {
  language: string;
  /** The Case picklist values, as a block of data; absent when none was given. */
  picklists?: string;
  /** The agent's topics and actions, as a block of data; absent when no agent is chosen. */
  agent?: string;
}

function promptContext(request: ScenarioDraftRequest): PromptContext {
  const picklists: Record<string, string[]> = {};
  for (const field of CASE_PICKLISTS) {
    const values = request.casePicklists?.[field];
    if (values && values.length > 0) picklists[field] = values.slice(0, PICKLIST_VALUES_SENT);
  }
  // Read field by field: the catalog's objects carry ids, variables and flags
  // of their own, and none of them is sent.
  const agentTopics = request.agent?.topics.map((topic) => ({
    name: topic.name,
    ...labelled(topic),
    actions: topic.actions.map((action) => ({ name: action.name, ...labelled(action) })),
  }));
  return {
    language: request.language,
    ...(Object.keys(picklists).length > 0
      ? { picklists: wrapAsUserData('case-picklists', JSON.stringify(picklists)) }
      : {}),
    ...(agentTopics && agentTopics.length > 0
      ? { agent: wrapAsUserData('agent-topics', JSON.stringify(agentTopics)) }
      : {}),
  };
}

/** The label and the description of a topic or an action, as far as the prompt carries them. */
function labelled(of: { label?: string; description?: string }): {
  label?: string;
  description?: string;
} {
  return {
    ...(of.label ? { label: of.label } : {}),
    ...(of.description ? { description: of.description.slice(0, AGENT_DESCRIPTION_SENT) } : {}),
  };
}

/** The language the model writes in; the code is checked against Salesforce's shape before it gets here. */
function languageLine(language: string): string {
  return `Write every text in the language whose Salesforce code is ${language}.`;
}

/** The Case picklist values, when the org gave some. */
function picklistSection(context: PromptContext): string[] {
  return context.picklists
    ? [
        '',
        "The org's cases are written with these values, the active values of its Case picklists by field:",
        context.picklists,
      ]
    : [];
}

const L = SCENARIO_PACK_LIMITS;
const T = SCENARIO_PACK_LIMITS.text;

const PLACEHOLDERS_OF_A_CASE = '{firstName}, {lastName}, {company}, {email} and {caseSubject}';

const PLAN_SHAPE = `{
  "id": "lower-case-words",
  "name": "...",
  "businessContext": "...",
  "customers": { "count": 10, "industry": "..." },
  "topics": [
    {
      "key": "lower-case-words",
      "label": "...",
      "utterances": [{ "text": "...", "expectedOutcome": "..." }]
    }
  ],
  "decoy": { "title": "...", "summary": "...", "body": "...", "resembles": "<the key of one topic>" },
  "outOfScope": [{ "text": "...", "expectedOutcome": "..." }]
}`;

const PLAN_RULES = [
  `- "id" and each topic's "key": lower-case letters and digits in words joined by single hyphens, starting with a letter, ${L.maxKeyLength} characters at most.`,
  `- "name": at most ${T.name} characters. "businessContext": what the company does and who its customers are, in two or three sentences, at most ${T.businessContext} characters.`,
  `- "customers": "count" is 10 unless the scenario asks for another number, at least the number of topics and at most ${L.maxCustomers}; "industry" is the customers' industry as an Account Industry value of Salesforce (Retail, Telecommunications, Technology...), at most ${T.industry} characters.`,
  `- "topics": ${L.topics.min} to ${L.topics.max}, five unless the scenario calls for more or fewer: the subjects customers write to support about. "label": at most ${T.label} characters.`,
  `- "utterances": ${L.utterances.min} to ${L.utterances.max} a topic, two unless it needs more: what a customer whose case on the topic is still open says to the agent ("text"), and what the agent should do, in plain words ("expectedOutcome"), each at most ${T.utterance} characters. They may name the customer and the case with ${PLACEHOLDERS_OF_A_CASE}, filled in when the pack is seeded.`,
  `- "decoy": an article close to the topic it "resembles", by its key, that does not answer it, so that a test tells the right article from the nearest. "title" at most ${T.articleTitle} characters, "summary" at most ${T.articleSummary}, "body" plain-text paragraphs of 600 to 1,500 characters. No placeholder.`,
  `- "outOfScope": ${L.outOfScope.min} to ${L.outOfScope.max}, three unless more are useful: what a customer may say that no topic covers, and that the agent should decline ("expectedOutcome"), each at most ${T.utterance} characters. No placeholder.`,
  '- No word in braces but the placeholders named here, where they are allowed.',
];

/** The first call: the plan. */
function planPrompt(context: PromptContext, sentText: string): string {
  return [
    'Plan a scenario pack from the scenario below.',
    '',
    languageLine(context.language),
    '',
    'The scenario, as the user wrote it:',
    wrapAsUserData('scenario', sentText),
    ...picklistSection(context),
    ...(context.agent
      ? [
          '',
          'The agent the tests are for routes to these topics, each with the actions it can take. Plan topics a customer would bring to it:',
          context.agent,
        ]
      : []),
    '',
    'Answer with ONLY this JSON object:',
    PLAN_SHAPE,
    '',
    'Rules:',
    ...PLAN_RULES,
  ].join('\n');
}

const TOPIC_SHAPE = `{
  "article": { "title": "...", "summary": "...", "body": "...", "facts": ["..."] },
  "caseTemplates": [
    {
      "subject": "...",
      "description": "...",
      "priority": "Medium",
      "origin": "Email",
      "followUp": "...",
      "resolution": ["..."]
    }
  ]
}`;

const TOPIC_RULES = [
  `- "article": what the agent answers the topic from. "title" at most ${T.articleTitle} characters and none of the titles above; "summary" at most ${T.articleSummary}; "body" plain-text paragraphs of 1,200 to 3,000 characters, at most ${T.articleBody}: the policy or the procedure, with the figures, delays and conditions customers ask about. No placeholder in the article.`,
  `- "facts": ${L.facts.min} to ${L.facts.max}, each a sentence of the body copied word for word, at most ${T.fact} characters: what an answer drawn from the article has to say.`,
  `- "caseTemplates": ${L.caseTemplates.min} to ${L.caseTemplates.max}, two unless the topic needs more: cases customers open on the topic. "subject" at most ${T.caseSubject} characters, and may name {firstName}, {lastName}, {company} and {email}; "description" what the customer writes, under 600 characters; "priority" is High, Medium or Low; "origin" is Phone, Email or Web; "followUp" what the customer writes again while the case is open, under 300 characters; "resolution" ${L.resolutionSteps.min} to ${L.resolutionSteps.max} steps, each a comment of the agent who resolved the case, under 400 characters. "description", "followUp" and "resolution" may name ${PLACEHOLDERS_OF_A_CASE}.`,
  '- No word in braces but the placeholders named here, where they are allowed.',
];

/** A call after the plan: the article and the cases of the topic at `index`. */
function topicPrompt(
  context: PromptContext,
  sentText: string,
  draft: ScenarioPackDraft,
  index: number,
): string {
  const topic = draft.topics[index];
  const plan = {
    businessContext: draft.businessContext,
    customersIndustry: draft.customers.industry,
    topics: draft.topics.map(({ key, label }) => ({ key, label })),
  };
  const titles = [
    draft.decoy.title,
    ...draft.topics.flatMap((other) => (other.article ? [other.article.title] : [])),
  ];
  return [
    'Write one topic of the scenario pack planned below: the Knowledge article that answers it, and the cases customers open on it.',
    '',
    languageLine(context.language),
    '',
    'The scenario, as the user wrote it:',
    wrapAsUserData('scenario', sentText),
    '',
    'The plan:',
    wrapAsUserData('plan', JSON.stringify(plan)),
    '',
    'The topic to write, with what customers say on it:',
    wrapAsUserData(
      'topic',
      JSON.stringify({ key: topic.key, label: topic.label, utterances: topic.utterances }),
    ),
    '',
    "Titles the pack's other articles have, which this one does not take:",
    wrapAsUserData('article-titles', JSON.stringify(titles)),
    ...picklistSection(context),
    '',
    'Answer with ONLY this JSON object:',
    TOPIC_SHAPE,
    '',
    'Rules:',
    ...TOPIC_RULES,
  ].join('\n');
}

/** A plan, as the draft it starts. */
function draftOf(plan: ScenarioPlanReply, language: string): ScenarioPackDraft {
  return {
    version: 1,
    id: plan.id,
    name: plan.name,
    language,
    businessContext: plan.businessContext,
    customers: plan.customers,
    topics: plan.topics.map(({ key, label, utterances }) => ({ key, label, utterances })),
    decoy: plan.decoy,
    outOfScope: plan.outOfScope,
  };
}

/** Whether a topic of a draft has been written: its article and its cases. */
function isWritten(topic: ScenarioPackDraft['topics'][number]): boolean {
  return topic.article !== undefined && topic.caseTemplates !== undefined;
}

/** The draft with the topic at `index` written. */
function withTopicWritten(
  draft: ScenarioPackDraft,
  index: number,
  written: ScenarioTopicReply,
): ScenarioPackDraft {
  return {
    ...draft,
    topics: draft.topics.map((topic, at) =>
      at === index
        ? {
            key: topic.key,
            label: topic.label,
            article: written.article,
            caseTemplates: written.caseTemplates,
            utterances: topic.utterances,
          }
        : topic,
    ),
  };
}

/** A draft every topic of which is written, in the shape of a pack, for the pack's schema to read. */
function packOf(draft: ScenarioPackDraft): unknown {
  return {
    version: draft.version,
    id: draft.id,
    name: draft.name,
    language: draft.language,
    businessContext: draft.businessContext,
    customers: draft.customers,
    topics: draft.topics.map((topic) => ({
      key: topic.key,
      label: topic.label,
      article: topic.article,
      caseTemplates: topic.caseTemplates,
      utterances: topic.utterances,
    })),
    decoy: draft.decoy,
    outOfScope: draft.outOfScope,
  };
}

/** A path into the pack, as a refusal names it: `topics[2].article.title`. */
function pathOf(path: ReadonlyArray<PropertyKey>): string {
  const where = path.reduce<string>(
    (at, step) => (typeof step === 'number' ? `${at}[${step}]` : `${at}.${String(step)}`),
    '',
  );
  return where.replace(/^\./, '');
}
