import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ARTICLE,
  ARTICLE_VERSION,
  CASE_ARTICLE,
  ARCHIVED_FILTER_REFUSAL,
  LATEST_FILTER_REFUSAL,
  MemoryKnowledgeOrg,
  VERSION_DELETE_REFUSAL,
} from './memoryKnowledgeOrg.js';
import { orgStamp, type MemoryRow } from './memoryRemovalOrg.js';

/*
 * The memory org's Knowledge against what the probes of wave 44 saw a
 * Developer Edition do (P1 to P3): each test one probe's answer.
 */

const START = Date.parse('2026-10-28T09:50:00.000Z');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Move the clock on by `seconds`. */
function later(seconds: number): string {
  vi.setSystemTime(Date.now() + seconds * 1_000);
  return orgStamp(Date.now());
}

/** Insert one article version, as a seed's insert sends it. */
async function inserted(
  org: MemoryKnowledgeOrg,
  values: Record<string, unknown> = { Title: 'SF-T', UrlName: 'sf-t' },
): Promise<string> {
  const [answer] = await org.sobject(ARTICLE_VERSION).create([values]);
  if (!answer.success) throw new Error(JSON.stringify(answer.errors));
  return answer.id;
}

/** A version read by its id, archived ones included. */
async function versionRow(org: MemoryKnowledgeOrg, id: string): Promise<MemoryRow | undefined> {
  const columns = 'Id, KnowledgeArticleId, PublishStatus, VersionNumber, IsLatestVersion';
  const latest = await org.query(`SELECT ${columns} FROM ${ARTICLE_VERSION} WHERE Id = '${id}'`);
  const archived = await org.query(
    `SELECT ${columns} FROM ${ARTICLE_VERSION} WHERE Id = '${id}' AND IsLatestVersion = false AND PublishStatus = 'Archived'`,
  );
  return latest.records[0] ?? archived.records[0];
}

/** Publish a version, as SandForge does. */
function publication(org: MemoryKnowledgeOrg, id: string, publishStatus: string) {
  return org.request({
    method: 'PATCH',
    url: `/services/data/v66.0/knowledgeManagement/articleVersions/masterVersions/${id}`,
    body: JSON.stringify({ publishStatus }),
  });
}

describe('MemoryKnowledgeOrg', () => {
  it('writes a version as the draft of a new article, version 0, in the one language of the base when none is sent (P2.1, P2.6)', async () => {
    const org = new MemoryKnowledgeOrg();

    const id = await inserted(org);

    const row = await versionRow(org, id);
    expect(row).toMatchObject({ PublishStatus: 'Draft', VersionNumber: 0, IsLatestVersion: true });
    expect(org.all(ARTICLE).map((article) => article.Id)).toEqual([row!.KnowledgeArticleId]);
    expect(org.all(ARTICLE_VERSION)[0].Language).toBe('en_US');
  });

  it('refuses a version without a URL name, and one in a language the base does not have (P1)', async () => {
    const org = new MemoryKnowledgeOrg();

    const [noUrl, otherLanguage] = await org
      .sobject(ARTICLE_VERSION)
      .create([{ Title: 'SF-T' }, { Title: 'SF-T', UrlName: 'sf-t', Language: 'fr' }]);

    expect(noUrl).toMatchObject({ success: false, errors: [{ fields: ['UrlName'] }] });
    expect(otherLanguage).toMatchObject({
      success: false,
      errors: [{ statusCode: 'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST' }],
    });
    expect(org.all(ARTICLE)).toEqual([]);
  });

  it('describes Summary, plain text of 1 000 characters, as the only field a body can go to, and the version as not deletable (P1)', async () => {
    const org = new MemoryKnowledgeOrg();

    const described = (await org.describe(ARTICLE_VERSION)) as {
      deletable?: boolean;
      fields: Array<{ name: string; type: string; length?: number }>;
    };

    expect(described.deletable).toBe(false);
    expect(described.fields.filter((field) => field.type === 'textarea')).toEqual([
      expect.objectContaining({ name: 'Summary', length: 1_000, extraTypeInfo: 'plaintextarea' }),
    ]);
  });

  it('publishes a version under the same id, version 1, answering no body (P2.2)', async () => {
    const org = new MemoryKnowledgeOrg();
    const id = await inserted(org);

    const answer = await publication(org, id, 'Online');

    expect(answer).toBeUndefined();
    expect(await versionRow(org, id)).toMatchObject({
      Id: id,
      PublishStatus: 'Online',
      VersionNumber: 1,
    });
    expect(org.all(ARTICLE)[0].FirstPublishedDate).not.toBeNull();
  });

  it('archives the online version set back to draft and makes a new draft under a new id, which a read without IsLatestVersion = false no longer shows (P2.4)', async () => {
    const org = new MemoryKnowledgeOrg();
    const id = await inserted(org);
    await publication(org, id, 'Online');

    const answer = (await publication(org, id, 'Draft')) as { id: string; statusCode: string };

    expect(answer.statusCode).toBe('SUCCESS');
    expect(answer.id).not.toBe(id);
    expect(await versionRow(org, id)).toMatchObject({
      PublishStatus: 'Archived',
      IsLatestVersion: false,
    });
    expect(await versionRow(org, answer.id)).toMatchObject({
      PublishStatus: 'Draft',
      VersionNumber: 0,
      IsLatestVersion: true,
    });
    const article = org.all(ARTICLE)[0].Id;
    const archived = await org.query(
      `SELECT Id FROM ${ARTICLE_VERSION} WHERE KnowledgeArticleId = '${article}' AND PublishStatus = 'Archived'`,
    );
    expect(archived.records).toEqual([]);
  });

  it('refuses a read of archived versions with no filter on Id or KnowledgeArticleId (P2.4)', async () => {
    const org = new MemoryKnowledgeOrg();
    await inserted(org);

    await expect(
      org.query(`SELECT Id FROM ${ARTICLE_VERSION} WHERE IsLatestVersion = false`),
    ).rejects.toMatchObject({ errorCode: LATEST_FILTER_REFUSAL.errorCode });
  });

  it("refuses a read of archived versions by their id with no filter on PublishStatus = 'Archived' (G-F2)", async () => {
    const org = new MemoryKnowledgeOrg();
    const id = await inserted(org);
    await publication(org, id, 'Online');
    await publication(org, id, 'Draft');

    await expect(
      org.query(`SELECT Id FROM ${ARTICLE_VERSION} WHERE Id = '${id}' AND IsLatestVersion = false`),
    ).rejects.toMatchObject({ errorCode: ARCHIVED_FILTER_REFUSAL.errorCode });
    const read = await org.query(
      `SELECT Id FROM ${ARTICLE_VERSION} WHERE Id = '${id}' AND IsLatestVersion = false AND PublishStatus = 'Archived'`,
    );
    expect(read.records.map((row) => row.Id)).toEqual([id]);
  });

  it('refuses the delete of a version, a draft or an online one, and deletes nothing (P2.3, P2.5)', async () => {
    const org = new MemoryKnowledgeOrg();
    const draft = await inserted(org);
    const online = await inserted(org, { Title: 'SF-T2', UrlName: 'sf-t2' });
    await publication(org, online, 'Online');

    const answers = await org.destroy(ARTICLE_VERSION, [draft, online]);

    expect(answers).toEqual([
      { id: draft, success: false, errors: [VERSION_DELETE_REFUSAL] },
      { id: online, success: false, errors: [VERSION_DELETE_REFUSAL] },
    ]);
    expect(org.all(ARTICLE_VERSION)).toHaveLength(2);
  });

  it('deletes an online article, every version of it to the recycle bin under its id, no version read again even through queryAll (P2.5, P3.4)', async () => {
    const org = new MemoryKnowledgeOrg();
    const id = await inserted(org);
    await publication(org, id, 'Online');
    const draft = ((await publication(org, id, 'Draft')) as { id: string }).id;
    const article = org.all(ARTICLE)[0].Id;

    const [answer] = (await org.destroy(ARTICLE, [article])) as Array<{ success: boolean }>;

    expect(answer.success).toBe(true);
    for (const version of [id, draft]) {
      const read = await org.queryAll(
        `SELECT Id FROM ${ARTICLE_VERSION} WHERE Id = '${version}' AND IsLatestVersion = false AND PublishStatus = 'Archived'`,
      );
      expect(read.records).toEqual([]);
      expect(
        (await org.queryAll(`SELECT Id FROM ${ARTICLE_VERSION} WHERE Id = '${version}'`)).records,
      ).toEqual([]);
    }
    expect(org.inBin(ARTICLE).map((row) => row.Id)).toEqual([article]);
  });

  it('links a case by the article, filling in the version and counting the link, and refuses a version id where the article goes (P3.2)', async () => {
    const org = new MemoryKnowledgeOrg();
    const id = await inserted(org);
    await publication(org, id, 'Online');
    const article = org.all(ARTICLE)[0];
    const [kase] = await org.sobject('Case').create([{ Subject: 'SF-T' }]);
    if (!kase.success) throw new Error('no case');

    const [byArticle, byVersion] = await org.sobject(CASE_ARTICLE).create([
      { CaseId: kase.id, KnowledgeArticleId: article.Id },
      { CaseId: kase.id, KnowledgeArticleId: id },
    ]);

    expect(byArticle.success).toBe(true);
    expect(byVersion).toMatchObject({
      success: false,
      errors: [{ fields: ['KnowledgeArticleId'] }],
    });
    expect(org.all(CASE_ARTICLE)).toEqual([
      expect.objectContaining({ KnowledgeArticleVersionId: id, ArticleVersionNumber: 1 }),
    ]);
    expect(article.CaseAssociationCount).toBe(1);
    expect(org.all(ARTICLE_VERSION)[0].ArticleCaseAttachCount).toBe(1);
  });

  it('takes a link with its case, IsDeleted through queryAll and no entry of its own (P3.3)', async () => {
    const org = new MemoryKnowledgeOrg();
    const id = await inserted(org);
    await publication(org, id, 'Online');
    const [kase] = await org.sobject('Case').create([{ Subject: 'SF-T' }]);
    if (!kase.success) throw new Error('no case');
    const [link] = await org
      .sobject(CASE_ARTICLE)
      .create([{ CaseId: kase.id, KnowledgeArticleId: org.all(ARTICLE)[0].Id }]);
    if (!link.success) throw new Error('no link');

    await org.destroy('Case', [kase.id]);

    expect(org.all(CASE_ARTICLE)).toEqual([]);
    const read = await org.queryAll(
      `SELECT Id, IsDeleted FROM ${CASE_ARTICLE} WHERE Id = '${link.id}'`,
    );
    expect(read.records).toEqual([{ Id: link.id, IsDeleted: true }]);
  });

  it('reads a link by its system stamp alone: it keeps no LastModifiedDate', async () => {
    const org = new MemoryKnowledgeOrg();

    await expect(
      org.query(
        `SELECT Id, LastModifiedDate FROM ${CASE_ARTICLE} WHERE CaseId = '500000000000001AAA'`,
      ),
    ).rejects.toMatchObject({ errorCode: 'INVALID_FIELD' });
  });

  it('dates a version modified by its publication and by a link to it unless told otherwise, what the probes did not measure', async () => {
    for (const stamps of [true, false]) {
      vi.setSystemTime(START);
      const org = new MemoryKnowledgeOrg(
        {},
        { knowledgeFacts: { publishStamps: stamps, linkStampsVersion: stamps } },
      );
      const id = await inserted(org);
      const written = orgStamp(Date.now());

      const publishedAt = later(30);
      await publication(org, id, 'Online');
      const afterPublication = org.all(ARTICLE_VERSION)[0].LastModifiedDate;
      const [kase] = await org.sobject('Case').create([{ Subject: 'SF-T' }]);
      if (!kase.success) throw new Error('no case');
      const linkedAt = later(30);
      await org
        .sobject(CASE_ARTICLE)
        .create([{ CaseId: kase.id, KnowledgeArticleId: org.all(ARTICLE)[0].Id }]);

      expect(afterPublication).toBe(stamps ? publishedAt : written);
      expect(org.all(ARTICLE_VERSION)[0].LastModifiedDate).toBe(stamps ? linkedAt : written);
    }
  });

  it('has none of the objects of Knowledge when it is off', async () => {
    const org = new MemoryKnowledgeOrg({}, { knowledge: false });

    const [answer] = await org.sobject(ARTICLE_VERSION).create([{ UrlName: 'sf-t' }]);
    const listed = (await org.describeGlobal()) as { sobjects: Array<{ name: string }> };

    expect(answer).toMatchObject({ success: false, errors: [{ statusCode: 'NOT_FOUND' }] });
    expect(listed.sobjects.map((object) => object.name)).not.toContain(ARTICLE_VERSION);
  });
});
