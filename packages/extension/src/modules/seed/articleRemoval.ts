/**
 * Taking back the Knowledge articles a run wrote: how a removal deletes the
 * records of an article version object (`Knowledge__kav`), which a seed's
 * scenario writes and a Forge clone may copy.
 *
 * Salesforce deletes no article version through the API. On a Developer
 * Edition with Lightning Knowledge turned on, `DELETE /sobjects/Knowledge__kav/<id>`
 * answered `INSUFFICIENT_ACCESS_OR_READONLY: insufficient access rights on
 * object id` for a draft as for an online version, the version's describe
 * says `deletable: false`, and the profile of the user had every Knowledge
 * permission (P2, wave 44). What deletes is the article, `Knowledge__ka`, by
 * the `KnowledgeArticleId` of its version: it takes every version with it to
 * the recycle bin, under the article's id, even while it is online, and the
 * versions are then read nowhere, not even through `queryAll` (P2, P3). A
 * removal went by the version, as for any record: its describe made it ask
 * the user about records it said could not be deleted, then leave them all.
 *
 * Never by setting a version back to draft first, as the design had it: that
 * archives the version the run wrote and makes a new draft, under an id the
 * run never wrote, which a removal would then leave in the org (P2).
 *
 * So a removal, for an article version object, reads whether the user may
 * delete its articles, deletes each version by deleting its article, and
 * never sends a version by a Bulk API job, which has no such way. Since the
 * article takes every version with it, an article holding a version the run
 * did not write — a draft someone began on it, or a version published since,
 * the run's then archived — is kept, unless the removal takes what changed
 * since the run too: that version would go with it.
 */

import { assertSoqlIdentifier } from '../../core/common/soqlValidator.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { idLists } from '../dataops/RecordRemoval.js';
import type { BulkDeleteAnswer, RemovalOrg } from '../forge/ForgeRunRemoval.js';

/** An article version object of Lightning Knowledge (`Knowledge__kav`), or of an article type. */
const ARTICLE_VERSION = /__kav$/i;

/** Whether the records of `objectApiName` are article versions, deleted through their articles. */
export function isArticleVersionObject(objectApiName: string): boolean {
  return ARTICLE_VERSION.test(objectApiName);
}

/** The article object of an article version object: `Knowledge__ka` for `Knowledge__kav`. */
export function articleObjectOf(versionObject: string): string {
  return versionObject.replace(/v$/i, '');
}

/** Why an article is kept for a version the run did not write, as its object's result says it. */
export const OTHER_VERSIONS_KEPT =
  'Kept: its article holds a version the run did not write — a draft begun on it, or a version ' +
  'published since — which deleting the article would take with it. A removal that takes what ' +
  'changed since the run takes it too.';

/** What a removal is told of a version no longer in the org: gone with its article. */
const VERSION_GONE = {
  statusCode: 'ENTITY_IS_DELETED',
  message: 'The version is no longer in the org: it went with its article.',
};

/** The filter that reads archived versions, which no other read shows: see {@link versionsOf}. */
const ARCHIVED = " AND IsLatestVersion = false AND PublishStatus = 'Archived'";

/** Why a version is never sent by a Bulk API job. */
const NOT_BY_JOB = 'An article version is deleted through its article, over REST.';

/** A record's answer the org did not give, as a delete over REST words a refusal. */
type WriteRow = { success: false; errors: Array<{ statusCode?: string; message: string }> };

/** What a version is answered when the org gave its article no answer. */
const NO_ANSWER: WriteRow = { success: false, errors: [{ message: 'The org gave no reason.' }] };

/** The key a record is known by: its id's first fifteen characters. */
function keyOf(id: string): string {
  return id.slice(0, 15);
}

/** How {@link withArticleRemoval} goes. */
export interface ArticleRemovalOptions {
  /**
   * Whether the removal takes what changed since the run too: an article
   * holding a version the run did not write is then deleted, that version
   * with it.
   */
  includeChanged: boolean;
}

/**
 * The org a removal works on, its article versions deleted through their
 * articles: see the module's comment. Every other object goes to `org` as
 * it came.
 */
export function withArticleRemoval(org: RemovalOrg, options: ArticleRemovalOptions): RemovalOrg {
  const bulkDestroy = org.bulkDestroy?.bind(org);
  return {
    query: (soql) => org.query(soql),
    queryDeleted: (soql) => org.queryDeleted(soql),
    update: (objectApiName, records) => org.update(objectApiName, records),
    serverTime: () => org.serverTime(),
    userId: () => org.userId(),
    describeGlobal: () => org.describeGlobal(),
    describe: (objectApiName) =>
      isArticleVersionObject(objectApiName)
        ? describedAsItsArticle(org, objectApiName)
        : org.describe(objectApiName),
    destroy: (objectApiName, ids) =>
      isArticleVersionObject(objectApiName)
        ? destroyThroughArticles(org, objectApiName, ids, options)
        : org.destroy(objectApiName, ids),
    ...(bulkDestroy
      ? {
          bulkDestroy: (
            objectApiName: string,
            ids: readonly string[],
            signal?: AbortSignal,
          ): Promise<BulkDeleteAnswer> =>
            isArticleVersionObject(objectApiName)
              ? Promise.resolve({ kind: 'untouched', reason: NOT_BY_JOB, requests: 0 })
              : bulkDestroy(objectApiName, ids, signal),
        }
      : {}),
  };
}

/**
 * The version object's describe, saying of its records whether the user may
 * delete their articles: what deleting one of them asks. A describe of the
 * article that cannot be read says nothing of it, and the deletes answer.
 */
async function describedAsItsArticle(org: RemovalOrg, versionObject: string): Promise<unknown> {
  const described = await org.describe(versionObject);
  if (typeof described !== 'object' || described === null) return described;
  let deletable: unknown;
  try {
    deletable = ((await org.describe(articleObjectOf(versionObject))) as { deletable?: unknown })
      ?.deletable;
  } catch {
    deletable = undefined;
  }
  const own: Record<string, unknown> = { ...(described as Record<string, unknown>) };
  delete own.deletable;
  return typeof deletable === 'boolean' ? { ...own, deletable } : own;
}

/**
 * Of an article version object, the versions `ids` names and the article of
 * each, then every version of those articles: the latest, and the archived
 * ones, which only a read on `IsLatestVersion = false` gives (P2: a read by
 * the article and `PublishStatus = 'Archived'` gave none). The org takes
 * that filter only with a filter on `Id` or `KnowledgeArticleId` (P2) and on
 * `PublishStatus = 'Archived'`: without the second, `MALFORMED_QUERY`, every
 * version of the removal refused before any article was deleted (G-F2).
 */
async function versionsOf(
  org: RemovalOrg,
  versionObject: string,
  ids: readonly string[],
): Promise<{ articleOf: Map<string, string>; versions: Map<string, Set<string>> }> {
  const object = assertSoqlIdentifier(versionObject);
  const articleOf = new Map<string, string>();
  const versions = new Map<string, Set<string>>();
  const keep = (records: readonly unknown[], named?: Map<string, string>): void => {
    for (const record of records) {
      const row = record as { Id?: unknown; KnowledgeArticleId?: unknown } | null;
      if (typeof row?.Id !== 'string' || typeof row.KnowledgeArticleId !== 'string') continue;
      named?.set(keyOf(row.Id), row.KnowledgeArticleId);
      const article = keyOf(row.KnowledgeArticleId);
      const held = versions.get(article) ?? new Set<string>();
      held.add(keyOf(row.Id));
      versions.set(article, held);
    }
  };
  // A version archived since the run is read by its id on `IsLatestVersion = false` alone.
  for (const latest of ['', ARCHIVED]) {
    for (const list of idLists(ids)) {
      const answer = await org.query(
        `SELECT Id, KnowledgeArticleId FROM ${object} WHERE Id IN (${list})${latest}`,
      );
      keep(answer.records, articleOf);
    }
  }
  const articles = [...new Set(articleOf.values())];
  for (const latest of ['', ARCHIVED]) {
    for (const list of idLists(articles)) {
      const answer = await org.query(
        `SELECT Id, KnowledgeArticleId FROM ${object} WHERE KnowledgeArticleId IN (${list})${latest}`,
      );
      keep(answer.records);
    }
  }
  return { articleOf, versions };
}

/**
 * Delete the versions `ids` names by deleting their articles, and answer each
 * version as a delete over REST answers a record: deleted with its article,
 * already gone, or refused — in the org's words, or kept for a version the
 * run did not write. A read that fails throws, and every version of the call
 * is refused with why, as a call the org refuses whole.
 */
async function destroyThroughArticles(
  org: RemovalOrg,
  versionObject: string,
  ids: readonly string[],
  options: ArticleRemovalOptions,
): Promise<unknown[]> {
  const { articleOf, versions } = await versionsOf(org, versionObject, ids);
  const sent = new Set(ids.map(keyOf));
  /** Whether the article holds a version none of `ids` names. */
  const holdsOthers = (article: string): boolean =>
    [...(versions.get(keyOf(article)) ?? [])].some((version) => !sent.has(version));
  const articles = [...new Set(articleOf.values())];
  const kept = new Set(
    options.includeChanged ? [] : articles.filter(holdsOthers).map((article) => keyOf(article)),
  );
  const toDelete = articles.filter((article) => !kept.has(keyOf(article)));
  /** The org's answer for each article deleted, by its key, as it gave it: the delete reads it. */
  const answerOf = new Map<string, unknown>();
  if (toDelete.length > 0) {
    let answer: unknown;
    try {
      answer = await org.destroy(articleObjectOf(versionObject), toDelete);
    } catch (err: unknown) {
      const message = extractErrorMessage(err);
      answer = toDelete.map((): WriteRow => ({ success: false, errors: [{ message }] }));
    }
    const rows = Array.isArray(answer) ? answer : [answer];
    toDelete.forEach((article, at) => answerOf.set(keyOf(article), rows[at]));
  }
  return ids.map((id): unknown => {
    const article = articleOf.get(keyOf(id));
    if (article === undefined) return { success: false, errors: [VERSION_GONE] };
    if (kept.has(keyOf(article))) {
      return { success: false, errors: [{ message: OTHER_VERSIONS_KEPT }] };
    }
    return answerOf.get(keyOf(article)) ?? NO_ANSWER;
  });
}
