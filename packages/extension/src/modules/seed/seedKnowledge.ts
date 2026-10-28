/**
 * What a seed does with the Knowledge articles it wrote, once every object of
 * it is in the org: publishes each, then links each closed case to the article
 * that answers it — a scenario's history, which an agent reads to see how such
 * a case was resolved. And, before it is compiled, which field of the org an
 * article's body goes to.
 *
 * As a Developer Edition with Lightning Knowledge turned on answered (P1 to
 * P3, wave 44):
 *
 * - An article written through the API is a draft. It is published by
 *   `PATCH …/knowledgeManagement/articleVersions/masterVersions/<versionId>`
 *   with `{"publishStatus":"Online"}`, which answers no body and keeps the
 *   version's id. It is never set back to draft here: that archives the
 *   version the run wrote and makes a new draft under an id the run never
 *   wrote, which a removal of the run could not name.
 * - A case is linked with a `CaseArticle` naming the case and the article —
 *   `KnowledgeArticleId`, read back from the version, never the version's own
 *   id; the platform fills in the version. The link goes with its case,
 *   leaving nothing in the recycle bin of its own: the removal of the run's
 *   cases takes the links, and they are not kept as records of the run.
 * - A base turned on afresh has no long or rich text field: `Summary`, plain
 *   text of 1 000 characters, is where a body goes, in place of the summary,
 *   unless the admin added a field for it.
 *
 * Each publication and each call of links is one of the run's calls, kept
 * with it as a write to its records (`SeedRunRecorder.wroteAgain`): the run's
 * last write then comes after them, and its removal does not read a version
 * the publication dated, or a case and a version a link dated, as changed
 * since the run and keep it. An org without Knowledge has no article written
 * — the object is optional and skipped with its reason — and nothing here is
 * done, said with that reason.
 */

import * as z from 'zod';
import { recordWriteHeaders } from '@sandforge/shared';
import type {
  ScenarioCompileOptions,
  SeedKnowledgeOutcome,
  SeedKnowledgeStep,
} from '@sandforge/shared';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { assertSoqlIdentifier } from '../../core/common/soqlValidator.js';
import { idLists, RECORDS_PER_CALL } from '../dataops/RecordRemoval.js';
import type { SeedRowsWritten } from './SeedOrchestrator.js';
import type { SeedRunRecorder } from './SeedRunCreations.js';

/** The article version object of Lightning Knowledge, which a scenario writes. */
export const ARTICLE_VERSION_OBJECT = 'Knowledge__kav';

/** The link of a case to an article. */
const CASE_ARTICLE = 'CaseArticle';

/** The case a link is made from. */
const CASE = 'Case';

/** The field a base turned on afresh gives a body: plain text, 1 000 characters (P1). */
const SUMMARY = 'Summary';

/** The longest a plain text area holds: a field no longer is no field for a body. */
const TEXT_AREA_LENGTH = 255;

/** A record id, as one goes into an address: letters and digits, 15 or 18 of them. */
const RECORD_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

/** A field of the article version object a body can go to, as its describe gives it. */
export interface ArticleBodyField {
  name: string;
  /** The most characters it holds. */
  length: number;
  /** Rich text, long text, or the summary of a base with no other. */
  kind: 'richText' | 'longText' | 'summary';
}

/** One field of a describe, as far as the choice of a body field reads it. */
const describedFieldSchema = z
  .object({
    name: z.string(),
    type: z.string(),
    length: z.number().optional(),
    extraTypeInfo: z.string().nullish(),
    htmlFormatted: z.boolean().optional(),
    createable: z.boolean().optional(),
  })
  .loose();

const describedFieldsSchema = z.object({ fields: z.array(z.unknown()) }).loose();

/** How a field of the article holds a body, or undefined when it holds none. */
function kindOf(field: z.infer<typeof describedFieldSchema>): ArticleBodyField['kind'] | undefined {
  if (field.type !== 'textarea' || field.createable !== true) return undefined;
  if (field.name === SUMMARY) return 'summary';
  if (field.extraTypeInfo === 'richtextarea' || field.htmlFormatted === true) return 'richText';
  return (field.length ?? 0) > TEXT_AREA_LENGTH ? 'longText' : undefined;
}

/** How a kind of field ranks for a body: the first the best. */
const RANK: Readonly<Record<ArticleBodyField['kind'], number>> = {
  richText: 0,
  longText: 1,
  summary: 2,
};

/**
 * The fields of the article version object's describe a body can go to, the
 * best first: a rich text field the admin added, then a long text one, each
 * the longest first, then `Summary`, which a base turned on afresh gives
 * alone. More than one is the user's choice; none, when the describe cannot
 * be read, and the article is then written with its summary alone.
 */
export function articleBodyFields(describe: unknown): ArticleBodyField[] {
  const parsed = describedFieldsSchema.safeParse(describe);
  if (!parsed.success) return [];
  const fields: ArticleBodyField[] = [];
  for (const raw of parsed.data.fields) {
    const field = describedFieldSchema.safeParse(raw);
    if (!field.success) continue;
    const kind = kindOf(field.data);
    if (kind === undefined || typeof field.data.length !== 'number') continue;
    fields.push({ name: field.data.name, length: field.data.length, kind });
  }
  return fields.sort(
    (a, b) => RANK[a.kind] - RANK[b.kind] || b.length - a.length || a.name.localeCompare(b.name),
  );
}

/**
 * The options a scenario is compiled with for its bodies to go to `field`:
 * which field, how long, and whether it holds rich text.
 */
export function articleBodyOptions(
  field: ArticleBodyField,
): Pick<ScenarioCompileOptions, 'articleBodyField' | 'articleBodyLength' | 'articleBodyHtml'> {
  return {
    articleBodyField: field.name,
    articleBodyLength: field.length,
    ...(field.kind === 'richText' ? { articleBodyHtml: true } : {}),
  };
}

/** What a run does with its articles once written. */
export interface SeedKnowledgePlan {
  /** Publish each article the run wrote: online, its channels as the template closed them. */
  publish: boolean;
  /**
   * Each closed case to link, by the key of its row, to the article of its
   * topic, by the key of that row: `CompiledScenario.closedCaseArticles`.
   */
  links: ReadonlyArray<{ caseKey: string; articleKey: string }>;
}

/** The part of a connection the articles need: a read, a request, and a create. */
export interface KnowledgeOrg {
  query(soql: string): PromiseLike<{ records: unknown[] }>;
  /** A request of the REST API, its address under the API's version, as jsforce sends one. */
  request(request: {
    method: string;
    url: string;
    body?: string;
    headers?: Record<string, string>;
  }): Promise<unknown>;
  sobject(objectApiName: string): {
    create(
      records: Record<string, unknown>[],
      options: { headers: Record<string, string> },
    ): Promise<unknown>;
  };
}

/** What {@link seedKnowledge} works with. */
export interface SeedKnowledgeDeps {
  org: KnowledgeOrg;
  plan: SeedKnowledgePlan;
  /**
   * Where the run keeps what it writes: each call dated as one of its writes.
   * Without it, as for a run nothing keeps, the calls are made all the same.
   */
  journal?: Pick<SeedRunRecorder, 'wroteAgain'>;
  /** The run's cancel: looked at before each call, what is left unsent then named. */
  signal?: AbortSignal;
}

/** One row of a create's answer, as a REST collection gives it. */
const saveResultSchema = z
  .object({
    success: z.boolean(),
    errors: z
      .array(
        z.union([
          z
            .object({
              statusCode: z.string().optional(),
              message: z.string().optional(),
            })
            .loose(),
          z.string(),
        ]),
      )
      .optional(),
  })
  .loose();

/** The org's words for why it refused one record of a create: `CODE: message`. */
function refusalOf(raw: unknown): string {
  const row = saveResultSchema.safeParse(raw);
  const error = row.success ? row.data.errors?.[0] : undefined;
  if (error === undefined) return 'The org gave no reason.';
  if (typeof error === 'string') return error;
  return [error.statusCode, error.message].filter(Boolean).join(': ') || 'The org gave no reason.';
}

/** Whether one row of a create's answer says the record was created. */
function created(raw: unknown): boolean {
  const row = saveResultSchema.safeParse(raw);
  return row.success && row.data.success;
}

/** The key a record is known by: its id's first fifteen characters. */
function keyOf(id: string): string {
  return id.slice(0, 15);
}

/**
 * The step a seed takes once every object is written: publish the articles it
 * wrote, then link its closed cases to them — see the module's comment. Every
 * article and every link is answered, done or not, and why; nothing throws
 * for what the org refuses.
 */
export function seedKnowledge(
  deps: SeedKnowledgeDeps,
): (written: SeedRowsWritten) => Promise<SeedKnowledgeOutcome> {
  return async ({ ids, results }) => {
    const versions = ids.get(ARTICLE_VERSION_OBJECT) ?? new Map<string, string>();
    if (versions.size === 0) {
      const skipped = results.find((result) => result.objectApiName === ARTICLE_VERSION_OBJECT);
      return {
        skipped:
          skipped?.errors[0] ??
          `The run wrote no ${ARTICLE_VERSION_OBJECT} article, so none was published or linked.`,
      };
    }
    const outcome: SeedKnowledgeOutcome = {};
    if (deps.plan.publish) outcome.publish = await publish(deps, versions);
    if (deps.plan.links.length > 0) {
      outcome.links = await link(deps, versions, ids.get(CASE) ?? new Map<string, string>());
    }
    return outcome;
  };
}

/** Publish each version, in turn, each call kept with the run. */
async function publish(
  deps: SeedKnowledgeDeps,
  versions: ReadonlyMap<string, string>,
): Promise<SeedKnowledgeStep> {
  const step: SeedKnowledgeStep = { asked: versions.size, done: 0, notDone: [] };
  for (const [key, versionId] of versions) {
    if (deps.signal?.aborted) {
      step.notDone.push({
        key,
        reason: 'Left a draft: the run was stopped before it was published.',
      });
      continue;
    }
    if (!RECORD_ID.test(versionId)) {
      step.notDone.push({ key, reason: `Left a draft: ${versionId} is not a record id.` });
      continue;
    }
    try {
      await deps.org.request({
        method: 'PATCH',
        url: `/knowledgeManagement/articleVersions/masterVersions/${versionId}`,
        body: JSON.stringify({ publishStatus: 'Online' }),
        headers: { 'Content-Type': 'application/json' },
      });
      step.done++;
    } catch (err: unknown) {
      step.notDone.push({ key, reason: `Left a draft: ${extractErrorMessage(err)}` });
    } finally {
      // Kept whatever the org answered: a call that failed may have written.
      deps.journal?.wroteAgain(ARTICLE_VERSION_OBJECT, [versionId]);
    }
  }
  return step;
}

/** A link the run sends: the case's row and its id, the article's id and its version's. */
interface Link {
  caseKey: string;
  caseId: string;
  articleId: string;
  versionId: string;
}

/**
 * Link each closed case to its article, two hundred to a call, each call kept
 * with the run as a write to the cases and the versions it links.
 */
async function link(
  deps: SeedKnowledgeDeps,
  versions: ReadonlyMap<string, string>,
  cases: ReadonlyMap<string, string>,
): Promise<SeedKnowledgeStep> {
  const step: SeedKnowledgeStep = { asked: deps.plan.links.length, done: 0, notDone: [] };
  let articles: Map<string, string>;
  let unread: string | undefined;
  try {
    articles = await articlesOf(deps.org, [...versions.values()]);
  } catch (err: unknown) {
    articles = new Map();
    unread = extractErrorMessage(err);
  }
  const sendable: Link[] = [];
  const notLinked = (caseKey: string, why: string): void => {
    step.notDone.push({ key: caseKey, reason: `Not linked: ${why}.` });
  };
  for (const { caseKey, articleKey } of deps.plan.links) {
    const caseId = cases.get(caseKey);
    const versionId = versions.get(articleKey);
    if (caseId === undefined) {
      notLinked(caseKey, 'its case was not written');
      continue;
    }
    if (versionId === undefined) {
      notLinked(caseKey, `its article ${articleKey} was not written`);
      continue;
    }
    const articleId = articles.get(keyOf(versionId));
    if (articleId === undefined) {
      notLinked(
        caseKey,
        `the article of ${articleKey} could not be read back` +
          (unread ? ` (${unread})` : ': the org no longer holds its version'),
      );
      continue;
    }
    sendable.push({ caseKey, caseId, articleId, versionId });
  }
  for (let at = 0; at < sendable.length; at += RECORDS_PER_CALL) {
    const call = sendable.slice(at, at + RECORDS_PER_CALL);
    if (deps.signal?.aborted) {
      for (const { caseKey } of call) {
        step.notDone.push({
          key: caseKey,
          reason: 'Not linked: the run was stopped before it.',
        });
      }
      continue;
    }
    let answer: unknown;
    try {
      answer = await deps.org.sobject(CASE_ARTICLE).create(
        call.map(({ caseId, articleId }) => ({ CaseId: caseId, KnowledgeArticleId: articleId })),
        { headers: recordWriteHeaders() },
      );
    } catch (err: unknown) {
      const reason = `Not linked: ${extractErrorMessage(err)}`;
      for (const { caseKey } of call) step.notDone.push({ key: caseKey, reason });
      answer = [];
    } finally {
      // Kept whatever the org answered: a call that failed may have written.
      deps.journal?.wroteAgain(
        CASE,
        call.map(({ caseId }) => caseId),
      );
      deps.journal?.wroteAgain(ARTICLE_VERSION_OBJECT, [
        ...new Set(call.map(({ versionId }) => versionId)),
      ]);
    }
    const rows = Array.isArray(answer) ? answer : [answer];
    if (rows.length === 0) continue;
    call.forEach(({ caseKey }, place) => {
      if (created(rows[place])) step.done++;
      else step.notDone.push({ key: caseKey, reason: `Not linked: ${refusalOf(rows[place])}` });
    });
  }
  return step;
}

/**
 * The article of each version, by the version's key: what a link names. Read
 * by the versions' ids, which the run wrote and which publishing keeps.
 */
async function articlesOf(
  org: KnowledgeOrg,
  versionIds: readonly string[],
): Promise<Map<string, string>> {
  const object = assertSoqlIdentifier(ARTICLE_VERSION_OBJECT);
  const articles = new Map<string, string>();
  for (const list of idLists(versionIds)) {
    const answer = await org.query(
      `SELECT Id, KnowledgeArticleId FROM ${object} WHERE Id IN (${list})`,
    );
    for (const record of answer.records) {
      const row = record as { Id?: unknown; KnowledgeArticleId?: unknown } | null;
      if (typeof row?.Id === 'string' && typeof row.KnowledgeArticleId === 'string') {
        articles.set(keyOf(row.Id), row.KnowledgeArticleId);
      }
    }
  }
  return articles;
}
