import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { removeRunRecords, type RemovalOrg } from '../forge/ForgeRunRemoval';
import { previewSyncRun, removeSyncRun } from '../sync/SyncRunRemoval';
import type { SyncRunKept, SyncRunRemovalState } from '../sync/SyncRunCreations';
import { ARTICLE, ARTICLE_VERSION, MemoryKnowledgeOrg } from '../../test/memoryKnowledgeOrg';
import {
  OTHER_VERSIONS_KEPT,
  articleObjectOf,
  isArticleVersionObject,
  withArticleRemoval,
} from './articleRemoval';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const START = Date.parse('2026-10-28T10:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Move the clock on by `seconds`. */
function later(seconds: number): void {
  vi.setSystemTime(Date.now() + seconds * 1_000);
}

/** Publish a version as a seed does. */
async function publish(org: MemoryKnowledgeOrg, versionId: string): Promise<void> {
  await org.request({
    method: 'PATCH',
    url: `/knowledgeManagement/articleVersions/masterVersions/${versionId}`,
    body: JSON.stringify({ publishStatus: 'Online' }),
  });
}

/** A run that wrote `count` articles and published them, as kept once it ended. */
async function runOfArticles(
  org: MemoryKnowledgeOrg,
  count: number,
  options: { published?: boolean } = {},
): Promise<{ run: SyncRunKept; versions: string[] }> {
  const startedAt = new Date().toISOString();
  const answers = await org
    .sobject(ARTICLE_VERSION)
    .create(
      Array.from({ length: count }, (_, n) => ({ Title: `SF-T ${n}`, UrlName: `sf-t-${n}` })),
    );
  const versions = answers.map((answer) => (answer.success ? answer.id : ''));
  if (options.published !== false) for (const id of versions) await publish(org, id);
  const lastWrittenAt = new Date().toISOString();
  return {
    versions,
    run: {
      runId: 'run-1',
      configId: 'sandforge-seed',
      configName: 'sandforge-seed',
      sourceOrgId: 'tgt-org',
      targetOrgId: 'tgt-org',
      startedAt,
      lastWrittenAt,
      end: { at: lastWrittenAt, status: 'success' },
      created: [{ objectApiName: ARTICLE_VERSION, ids: versions }],
    },
  };
}

/** What the removals of a run did, kept in memory. */
function stateStore() {
  let state: SyncRunRemovalState = {};
  return {
    get state() {
      return state;
    },
    updateRemoval: vi.fn(
      async (_runId: string, change: (s: SyncRunRemovalState) => SyncRunRemovalState) => {
        state = change(state);
      },
    ),
  };
}

describe('the removal of a run that wrote Knowledge articles', () => {
  it('deletes each online article by its article, every version with it, without asking about records it says cannot be deleted', async () => {
    const org = new MemoryKnowledgeOrg();
    const { run, versions } = await runOfArticles(org, 3);
    const articles = org.all(ARTICLE).map((article) => article.Id);
    later(60);
    const onUndeletable = vi.fn(async () => true);

    const { result } = await removeSyncRun({
      run,
      org,
      includeChanged: false,
      store: stateStore(),
      onUndeletable,
    });

    expect(result.status).toBe('success');
    expect(result.objects).toEqual([
      expect.objectContaining({ objectApiName: ARTICLE_VERSION, planned: 3, deleted: 3 }),
    ]);
    expect(onUndeletable).not.toHaveBeenCalled();
    // The articles went, never a version on its own: the org refuses that.
    expect(org.deletes).toEqual([{ objectApiName: ARTICLE, ids: articles }]);
    expect(org.all(ARTICLE_VERSION)).toEqual([]);
    expect(org.inBin(ARTICLE).map((row) => row.Id)).toEqual(articles);
    expect(versions).toHaveLength(3);
  });

  it('previews the articles as records it deletes, never as ones the user may not delete', async () => {
    const org = new MemoryKnowledgeOrg();
    const { run } = await runOfArticles(org, 2);
    later(60);

    const { outcome, planned } = await previewSyncRun({ run, org, includeChanged: false });

    expect(planned).toBe(2);
    expect(outcome.undeletable).toBeUndefined();
    expect(outcome.preview?.objects).toEqual([
      expect.objectContaining({ objectApiName: ARTICLE_VERSION, planned: 2, toDelete: 2 }),
    ]);
    expect(org.deletes).toEqual([]);
  });

  it('deletes an article left a draft just the same', async () => {
    const org = new MemoryKnowledgeOrg();
    const { run } = await runOfArticles(org, 2, { published: false });

    const { result } = await removeSyncRun({
      run,
      org,
      includeChanged: false,
      store: stateStore(),
    });

    expect(result.status).toBe('success');
    expect(result.objects[0]).toMatchObject({ planned: 2, deleted: 2 });
    expect(org.all(ARTICLE)).toEqual([]);
  });

  it('never sets a version back to draft on its way out: that would make one the run never wrote', async () => {
    const org = new MemoryKnowledgeOrg();
    const { run } = await runOfArticles(org, 2);
    const publishedBefore = org.publications.length;

    await removeSyncRun({ run, org, includeChanged: false, store: stateStore() });

    expect(org.publications.slice(publishedBefore)).toEqual([]);
  });

  it('keeps an article someone began a draft of since, naming why, and takes it with the draft when the removal takes what changed', async () => {
    const org = new MemoryKnowledgeOrg();
    const { run, versions } = await runOfArticles(org, 2);
    later(60);
    const draft = org.editOnline(versions[1], { Title: 'SF-T 1, edited' });
    later(60);

    const kept = await removeSyncRun({ run, org, includeChanged: false, store: stateStore() });

    expect(kept.result.status).toBe('partial');
    expect(kept.result.objects[0]).toMatchObject({ deleted: 1, refused: 1 });
    expect(kept.result.objects[0].reasons).toContain(OTHER_VERSIONS_KEPT);
    expect(
      org
        .all(ARTICLE_VERSION)
        .map((row) => row.Id)
        .sort(),
    ).toEqual([versions[1], draft].sort());

    const taken = await removeSyncRun({
      run,
      org,
      includeChanged: true,
      store: stateStore(),
    });

    expect(taken.result.objects[0]).toMatchObject({ deleted: 1 });
    expect(org.all(ARTICLE_VERSION)).toEqual([]);
  });

  it('keeps an article whose version of the run another publication archived since: the newer one would go with it', async () => {
    const org = new MemoryKnowledgeOrg();
    const { run, versions } = await runOfArticles(org, 1);
    later(60);
    const draft = org.editOnline(versions[0], { Title: 'SF-T 0, second edition' });
    await publish(org, draft);
    later(60);

    const { result } = await removeSyncRun({ run, org, includeChanged: true, store: stateStore() });

    // Archived, the run's version is out of every read that does not ask for
    // it: the removal does not find it, and the article stays whole.
    expect(org.all(ARTICLE)).toHaveLength(1);
    expect(org.all(ARTICLE_VERSION).find((row) => row.Id === draft)).toMatchObject({
      PublishStatus: 'Online',
    });
    expect(result.objects[0]).toMatchObject({ deleted: 0 });
  });

  it("says the org's words when it refuses to delete an article, and counts its version refused", async () => {
    const org = new MemoryKnowledgeOrg();
    const { run } = await runOfArticles(org, 1);
    org.refuse.set(org.all(ARTICLE)[0].Id, 'the article is attached to an approval');

    const { result } = await removeSyncRun({
      run,
      org,
      includeChanged: false,
      store: stateStore(),
    });

    expect(result.objects[0]).toMatchObject({ deleted: 0, refused: 1 });
    expect(result.objects[0].reasons.join(' ')).toContain('the article is attached to an approval');
    expect(org.all(ARTICLE_VERSION)).toHaveLength(1);
  });

  it('counts a version gone with an article deleted since as already gone, no delete sent', async () => {
    const org = new MemoryKnowledgeOrg();
    const { run } = await runOfArticles(org, 2);
    const plan = [{ objectApiName: ARTICLE_VERSION, ids: run.created[0].ids }];
    // Read before the first write, as every removal reads its records; the
    // article went in between.
    const sent = vi.spyOn(org, 'destroy');
    org.beforeDelete = () => {
      if (org.all(ARTICLE).length === 2) org.trash(ARTICLE, org.all(ARTICLE)[0].Id);
    };

    const outcome = await removeRunRecords(org, plan, {
      includeChanged: false,
      runStartedAt: new Date(START - 1_000),
      runEndedAt: new Date(Date.now() + 1_000),
    });

    expect(outcome.objects[0]).toMatchObject({ deleted: 1, alreadyGone: 1, refused: 0 });
    expect(sent).toHaveBeenCalledTimes(1);
  });
});

describe('withArticleRemoval', () => {
  /** An org that records what reaches it. */
  function recordingOrg(describes: Record<string, unknown>): RemovalOrg & {
    bulk: Array<{ objectApiName: string; ids: readonly string[] }>;
  } {
    const bulk: Array<{ objectApiName: string; ids: readonly string[] }> = [];
    return {
      bulk,
      query: vi.fn(async () => ({ totalSize: 0, done: true, records: [] })),
      queryDeleted: vi.fn(async () => ({ records: [] })),
      destroy: vi.fn(async (_objectApiName: string, ids: string[]) =>
        ids.map((id) => ({ id, success: true, errors: [] })),
      ),
      update: vi.fn(async () => []),
      serverTime: vi.fn(async () => new Date().toISOString()),
      userId: vi.fn(async () => '005000000000001AAA'),
      describeGlobal: vi.fn(async () => ({ sobjects: [] })),
      describe: vi.fn(async (objectApiName: string) => {
        const described = describes[objectApiName];
        if (described instanceof Error) throw described;
        return described;
      }),
      bulkDestroy: vi.fn(async (objectApiName: string, ids: readonly string[]) => {
        bulk.push({ objectApiName, ids });
        return { kind: 'aborted' as const };
      }),
    };
  }

  it('describes a version object as deletable as its article is, and every other object as it is', async () => {
    const org = recordingOrg({
      Knowledge__kav: { name: 'Knowledge__kav', label: 'Knowledge', deletable: false, fields: [] },
      Knowledge__ka: { name: 'Knowledge__ka', label: 'Knowledge', deletable: true, fields: [] },
      Account: { name: 'Account', label: 'Account', deletable: false, fields: [] },
    });
    const session = withArticleRemoval(org, { includeChanged: false });

    expect(await session.describe('Knowledge__kav')).toMatchObject({ deletable: true });
    expect(await session.describe('Account')).toMatchObject({ deletable: false });
  });

  it('says nothing of deleting a version when its article cannot be described, for the deletes to answer', async () => {
    const org = recordingOrg({
      Knowledge__kav: { name: 'Knowledge__kav', label: 'Knowledge', deletable: false, fields: [] },
      Knowledge__ka: new Error('INVALID_TYPE: sObject type is not supported'),
    });

    const described = await withArticleRemoval(org, { includeChanged: false }).describe(
      'Knowledge__kav',
    );

    expect(described).not.toHaveProperty('deletable');
    expect(described).toMatchObject({ name: 'Knowledge__kav' });
  });

  it('never sends a version by a Bulk API job, which leaves it to REST, and every other object as asked', async () => {
    const org = recordingOrg({});
    const session = withArticleRemoval(org, { includeChanged: false });

    const versions = await session.bulkDestroy!('Knowledge__kav', ['ka0000000000001AAA']);
    await session.bulkDestroy!('Contact', ['003000000000001AAA']);

    expect(versions).toMatchObject({ kind: 'untouched' });
    expect(org.bulk).toEqual([{ objectApiName: 'Contact', ids: ['003000000000001AAA'] }]);
  });

  it('tells the version object of an article type and its article from any other object', () => {
    expect(isArticleVersionObject('Knowledge__kav')).toBe(true);
    expect(isArticleVersionObject('FAQ__kav')).toBe(true);
    expect(isArticleVersionObject('Knowledge__ka')).toBe(false);
    expect(isArticleVersionObject('Invoice__c')).toBe(false);
    expect(articleObjectOf('Knowledge__kav')).toBe('Knowledge__ka');
    expect(articleObjectOf('FAQ__kav')).toBe('FAQ__ka');
  });
});
