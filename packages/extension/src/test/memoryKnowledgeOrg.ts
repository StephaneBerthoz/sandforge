/**
 * A target org in miniature with Lightning Knowledge turned on, as a
 * Developer Edition held it in the Knowledge probes of wave 44 (P1 to P3):
 * articles (`Knowledge__ka`), their versions (`Knowledge__kav`), and the links
 * of cases to articles (`CaseArticle`), beside the removal tests' records.
 *
 * What it does, as the probes saw it:
 *
 * - A version inserted is a draft of a new article: `PublishStatus` `Draft`,
 *   `VersionNumber` 0, `IsLatestVersion` true, its article made with it and
 *   named by `KnowledgeArticleId` (P2.1). `UrlName` is required and holds 255
 *   characters; `Language` takes the one language the base has, `en_US`, and
 *   is that one when none is sent (P1, P2.6).
 * - The body has nowhere to go but `Summary`, plain text of 1 000 characters:
 *   a base turned on afresh has no long or rich text field (P1). A test adds
 *   the field an admin would (`addBodyField`).
 * - A version is never deleted through the API, whatever its status:
 *   `INSUFFICIENT_ACCESS_OR_READONLY`, and its describe says `deletable:
 *   false` (P2.3, P2.5, P2.6). Its article deletes, online or not, and takes
 *   every version to the recycle bin under the article's id; no read shows a
 *   version again, not even through `queryAll` (P2.5, P3.4).
 * - `PATCH …/knowledgeManagement/articleVersions/masterVersions/<id>` with
 *   `{"publishStatus":"Online"}` publishes the version under the same id,
 *   `VersionNumber` 1, and answers no body (P2.2). With `Draft`, the online
 *   version is archived — `Archived`, `IsLatestVersion` false — and a new
 *   draft is made under a new id, `VersionNumber` 0, the answer naming it
 *   (P2.4).
 * - A read sees the latest versions alone; an archived one only on
 *   `IsLatestVersion = false`, which the org refuses without a filter on `Id`
 *   or `KnowledgeArticleId` (P2.4), and without one on
 *   `PublishStatus = 'Archived'` (G-F2).
 * - A `CaseArticle` is created with the article's id, never the version's;
 *   the platform fills the version it was linked at, and counts the link on
 *   the article and the version (P3.2). It goes with its case, `IsDeleted` in
 *   `queryAll` and no entry of its own in the recycle bin (P3.3). It keeps no
 *   `LastModifiedDate`.
 *
 * What the probes did not measure is a switch of {@link MemoryKnowledgeFacts},
 * set to the answer a removal has the most to fear from: whether publishing
 * or linking dates the version as modified.
 *
 * Lives under `src/test/`: a helper, not a suite.
 */

import { MEMORY_ORG_USER, MemoryRemovalOrg, orgError, orgStamp } from './memoryRemovalOrg.js';
import type {
  MemoryChild,
  MemoryOrgOptions,
  MemoryOrgRequest,
  MemoryRow,
} from './memoryRemovalOrg.js';

/** The objects of Lightning Knowledge, and the link of a case to an article. */
export const ARTICLE_VERSION = 'Knowledge__kav';
export const ARTICLE = 'Knowledge__ka';
export const CASE_ARTICLE = 'CaseArticle';

/** The first characters of the ids the org gives, per object. */
const PREFIX: Readonly<Record<string, string>> = {
  [ARTICLE_VERSION]: 'ka0',
  [ARTICLE]: 'kA0',
  [CASE_ARTICLE]: '0Cx',
  Account: '001',
  Contact: '003',
  Case: '500',
  CaseComment: '00a',
};

/** What the org answers a delete of a version (P2.3). */
export const VERSION_DELETE_REFUSAL = {
  statusCode: 'INSUFFICIENT_ACCESS_OR_READONLY',
  message: 'insufficient access rights on object id',
};

/** What the org answers a read of archived versions with no filter on an id (P2.4). */
export const LATEST_FILTER_REFUSAL = {
  errorCode: 'MALFORMED_QUERY',
  message:
    'Implementation restriction: When filtering by isLatestVersion=false, you must include a ' +
    'filter on Id or KnowledgeArticleId',
};

/** What the org answers a read of archived versions with no filter on their status (G-F2). */
export const ARCHIVED_FILTER_REFUSAL = {
  errorCode: 'MALFORMED_QUERY',
  message:
    "Implementation restriction: When filtering by isLatestVersion=false, you also filter by PublishStatus = 'archived'",
};

/** The fields of a version as a base turned on afresh describes them (P1). */
const VERSION_FIELDS: readonly Record<string, unknown>[] = [
  { name: 'Title', label: 'Title', type: 'string', length: 255, createable: true, custom: false },
  {
    name: 'UrlName',
    label: 'URL Name',
    type: 'string',
    length: 255,
    createable: true,
    custom: false,
  },
  {
    name: 'Summary',
    label: 'Summary',
    type: 'textarea',
    length: 1_000,
    extraTypeInfo: 'plaintextarea',
    createable: true,
    custom: false,
  },
  {
    name: 'Language',
    label: 'Language',
    type: 'picklist',
    length: 40,
    createable: true,
    custom: false,
  },
  ...['IsVisibleInPkb', 'IsVisibleInCsp', 'IsVisibleInPrm'].map((name) => ({
    name,
    label: name,
    type: 'boolean',
    createable: true,
    custom: false,
  })),
  {
    name: 'PublishStatus',
    label: 'Publication Status',
    type: 'picklist',
    length: 40,
    createable: false,
    custom: false,
  },
];

/** A body field an admin adds to the version, as its describe gives it. */
export interface MemoryBodyField {
  name: string;
  length: number;
  /** Rich text rather than long text. */
  rich?: boolean;
}

/**
 * What the probes did not measure, each set to the answer a removal has the
 * most to fear from — a version dated after the run's last write reads as
 * changed since it — and switchable to the other.
 */
export interface MemoryKnowledgeFacts {
  /** Publishing a version dates it modified, as the publishing user. */
  publishStamps: boolean;
  /** Linking a case to an article dates the version it counts the link on as modified. */
  linkStampsVersion: boolean;
}

/** The facts as {@link MemoryKnowledgeOrg} holds them unless told. */
export const MEMORY_KNOWLEDGE_FACTS: Readonly<MemoryKnowledgeFacts> = Object.freeze({
  publishStamps: true,
  linkStampsVersion: true,
});

/** How a Knowledge org is set up, beside a removal org's options. */
export interface MemoryKnowledgeOptions extends MemoryOrgOptions {
  /** Whether Knowledge is turned on: off, the org has none of its objects. True unless given. */
  knowledge?: boolean;
  /** The facts that differ from {@link MEMORY_KNOWLEDGE_FACTS}. */
  knowledgeFacts?: Partial<MemoryKnowledgeFacts>;
}

/** One record's answer to a create, as a REST collection gives it. */
type CreateAnswer =
  | { id: string; success: true; errors: [] }
  | { success: false; errors: Array<{ statusCode: string; message: string; fields: string[] }> };

/** The address of a version's publication, under the API's path. */
const MASTER_VERSION = /^\/knowledgeManagement\/articleVersions\/masterVersions\/(\w+)$/;

/** The key the org knows a record by: its id's first fifteen characters. */
function keyOf(id: string): string {
  return id.slice(0, 15);
}

/** A refusal of one record of a create. */
function refused(statusCode: string, message: string, fields: string[] = []): CreateAnswer {
  return { success: false, errors: [{ statusCode, message, fields }] };
}

/** See the module's comment. */
export class MemoryKnowledgeOrg extends MemoryRemovalOrg {
  /** The facts the probes did not measure: see {@link MemoryKnowledgeFacts}. */
  readonly knowledgeFacts: MemoryKnowledgeFacts;
  /** Whether Knowledge is turned on. */
  readonly knowledge: boolean;
  /** The languages of the Knowledge base: the default first (P1). */
  readonly languages: string[] = ['en_US'];
  /** Every publication asked, in order: the version, and the status it was asked for. */
  readonly publications: Array<{ versionId: string; status: string }> = [];
  /** Versions whose publication the org refuses, with its answer: a user without Publish Articles. */
  readonly refusePublication = new Map<string, { errorCode: string; message: string }>();
  /** Every version id the org made, live or gone: a delete of one is refused. */
  private readonly versionKeys = new Set<string>();
  private made = 0;
  private articleNumber = 1000;

  constructor(
    children: Readonly<Record<string, readonly MemoryChild[]>> = {},
    options: MemoryKnowledgeOptions = {},
  ) {
    const knowledge = options.knowledge !== false;
    super(
      knowledge
        ? {
            ...children,
            [ARTICLE]: [
              ...(children[ARTICLE] ?? []),
              { childSObject: ARTICLE_VERSION, field: 'KnowledgeArticleId', cascadeDelete: true },
            ],
            Case: [
              ...(children.Case ?? []),
              { childSObject: CASE_ARTICLE, field: 'CaseId', cascadeDelete: true },
            ],
          }
        : children,
      options,
    );
    this.knowledge = knowledge;
    this.knowledgeFacts = { ...MEMORY_KNOWLEDGE_FACTS, ...options.knowledgeFacts };
    if (knowledge) {
      this.undeletable.add(ARTICLE_VERSION);
      this.missingFields.set(CASE_ARTICLE, new Set(['LastModifiedDate', 'LastModifiedById']));
      this.changeSchema(ARTICLE_VERSION, [...VERSION_FIELDS]);
    }
  }

  /** Add the body field an admin would, as the version's describe then lists it. */
  addBodyField(field: MemoryBodyField): void {
    this.changeSchema(ARTICLE_VERSION, [
      ...VERSION_FIELDS,
      {
        name: field.name,
        label: field.name,
        type: 'textarea',
        length: field.length,
        extraTypeInfo: field.rich ? 'richtextarea' : 'plaintextarea',
        htmlFormatted: field.rich === true,
        createable: true,
        custom: true,
      },
    ]);
  }

  /** An id of `objectApiName` no record of the org has yet. */
  private nextId(objectApiName: string): string {
    this.made++;
    return `${PREFIX[objectApiName] ?? 'a0X'}MK${String(this.made).padStart(10, '0')}AAA`;
  }

  /** Now, as the org dates a write: to the second. */
  private stamp(): string {
    return orgStamp(this.now());
  }

  /** The versions of an article still in the org, latest or not. */
  versionsOf(articleId: string): MemoryRow[] {
    return this.all(ARTICLE_VERSION).filter(
      (version) => keyOf(String(version.KnowledgeArticleId)) === keyOf(articleId),
    );
  }

  async identity(): Promise<{ user_id: string }> {
    return { user_id: MEMORY_ORG_USER };
  }

  /** The REST API's create, as `conn.sobject(name).create(records, options)` sends it. */
  sobject(objectApiName: string): {
    create(records: Record<string, unknown>[], options?: unknown): Promise<CreateAnswer[]>;
  } {
    return {
      create: async (records) => {
        this.requests++;
        return records.map((record) => this.create(objectApiName, record));
      },
    };
  }

  /** Create one record as the org does: see the module's comment. */
  private create(objectApiName: string, record: Record<string, unknown>): CreateAnswer {
    const knowledgeObject = [ARTICLE_VERSION, ARTICLE, CASE_ARTICLE].includes(objectApiName);
    if (knowledgeObject && !this.knowledge) {
      return refused('NOT_FOUND', `sObject type '${objectApiName}' is not supported.`);
    }
    if (objectApiName === ARTICLE_VERSION) return this.createVersion(record);
    if (objectApiName === CASE_ARTICLE) return this.createLink(record);
    if (objectApiName === ARTICLE) {
      return refused('INVALID_TYPE', `entity type ${ARTICLE} does not support insert`);
    }
    const id = this.nextId(objectApiName);
    this.add(objectApiName, { ...record, Id: id, CreatedById: MEMORY_ORG_USER });
    return { id, success: true, errors: [] };
  }

  private createVersion(record: Record<string, unknown>): CreateAnswer {
    const urlName = record.UrlName;
    if (typeof urlName !== 'string' || urlName === '') {
      return refused('REQUIRED_FIELD_MISSING', 'Required fields are missing: [UrlName]', [
        'UrlName',
      ]);
    }
    if (urlName.length > 255) {
      return refused('STRING_TOO_LONG', 'URL Name: data value too large', ['UrlName']);
    }
    if (typeof record.Summary === 'string' && record.Summary.length > 1_000) {
      return refused('STRING_TOO_LONG', 'Summary: data value too large', ['Summary']);
    }
    const language = record.Language ?? this.languages[0];
    if (typeof language !== 'string' || !this.languages.includes(language)) {
      return refused(
        'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST',
        `Language: bad value for restricted picklist field: ${String(language)}`,
        ['Language'],
      );
    }
    const articleId = this.nextId(ARTICLE);
    this.add(ARTICLE, {
      Id: articleId,
      ArticleNumber: String(++this.articleNumber).padStart(9, '0'),
      FirstPublishedDate: null,
      LastPublishedDate: null,
      CaseAssociationCount: 0,
    });
    const id = this.nextId(ARTICLE_VERSION);
    this.versionKeys.add(keyOf(id));
    this.add(ARTICLE_VERSION, {
      ...record,
      Id: id,
      Language: language,
      KnowledgeArticleId: articleId,
      PublishStatus: 'Draft',
      VersionNumber: 0,
      IsLatestVersion: true,
      ArticleCaseAttachCount: 0,
      CreatedById: MEMORY_ORG_USER,
    });
    return { id, success: true, errors: [] };
  }

  private createLink(record: Record<string, unknown>): CreateAnswer {
    const caseId = record.CaseId;
    const articleId = record.KnowledgeArticleId;
    const missing = [
      ...(typeof caseId === 'string' ? [] : ['CaseId']),
      ...(typeof articleId === 'string' ? [] : ['KnowledgeArticleId']),
    ];
    if (missing.length > 0) {
      return refused(
        'REQUIRED_FIELD_MISSING',
        `Required fields are missing: [${missing.join(', ')}]`,
        missing,
      );
    }
    if (!this.liveRow('Case', String(caseId))) {
      return refused('ENTITY_IS_DELETED', 'entity is deleted', ['CaseId']);
    }
    const article = this.liveRow(ARTICLE, String(articleId));
    if (!article) {
      // A version's id where the article's goes: the probes linked by the
      // article alone, and this answer is the API's for an id of another object.
      return refused(
        'FIELD_INTEGRITY_EXCEPTION',
        'field integrity exception: unknown (Knowledge Article)',
        ['KnowledgeArticleId'],
      );
    }
    const versions = this.versionsOf(article.Id);
    const version =
      versions.find((row) => row.PublishStatus === 'Online') ??
      versions.find((row) => row.IsLatestVersion === true);
    if (!version) return refused('ENTITY_IS_DELETED', 'entity is deleted', ['KnowledgeArticleId']);
    const id = this.nextId(CASE_ARTICLE);
    const at = this.stamp();
    this.add(
      CASE_ARTICLE,
      {
        Id: id,
        CaseId: caseId,
        KnowledgeArticleId: article.Id,
        KnowledgeArticleVersionId: version.Id,
        ArticleVersionNumber: version.VersionNumber,
        ArticleLanguage: version.Language,
        IsSharedByEmail: false,
        CreatedById: MEMORY_ORG_USER,
        SystemModstamp: at,
      },
      at,
    );
    article.CaseAssociationCount = Number(article.CaseAssociationCount ?? 0) + 1;
    version.ArticleCaseAttachCount = Number(version.ArticleCaseAttachCount ?? 0) + 1;
    if (this.knowledgeFacts.linkStampsVersion) this.restamp(version, MEMORY_ORG_USER);
    return { id, success: true, errors: [] };
  }

  /**
   * A delete as a REST collection sends it, a version among the ids refused
   * as the org refuses it (P2.3), whatever its status, and every other id
   * deleted as the removal org deletes it.
   */
  override async destroy(objectApiName: string, ids: string[]): Promise<unknown> {
    const isVersion = ids.map((id) => this.versionKeys.has(keyOf(id)));
    if (!isVersion.some(Boolean)) return super.destroy(objectApiName, ids);
    const others = ids.filter((_, at) => !isVersion[at]);
    let answers: unknown[] = [];
    if (others.length > 0) answers = (await super.destroy(objectApiName, others)) as unknown[];
    else {
      this.requests++;
      this.beforeDelete?.();
      this.deletes.push({ objectApiName, ids: [...ids] });
    }
    let next = 0;
    return ids.map((id, at) =>
      isVersion[at] ? { id, success: false, errors: [VERSION_DELETE_REFUSAL] } : answers[next++],
    );
  }

  /** A request, a version's publication among them: see the module's comment. */
  override async request(request: MemoryOrgRequest): Promise<unknown> {
    const path = request.url.replace(/^\/services\/data\/v\d+\.\d+/, '');
    const publication = MASTER_VERSION.exec(path);
    if (!publication || request.method.toUpperCase() !== 'PATCH') return super.request(request);
    this.requests++;
    const body = (typeof request.body === 'string' ? JSON.parse(request.body) : request.body) as
      { publishStatus?: unknown } | undefined;
    const status = String(body?.publishStatus ?? '');
    this.publications.push({ versionId: publication[1], status });
    return this.publish(publication[1], status);
  }

  private publish(versionId: string, status: string): unknown {
    const version = this.liveRow(ARTICLE_VERSION, versionId);
    if (!this.knowledge || !version) {
      throw orgError('NOT_FOUND', 'The requested resource does not exist');
    }
    const refusal = this.refusePublication.get(versionId);
    if (refusal) throw orgError(refusal.errorCode, refusal.message);
    const article = this.liveRow(ARTICLE, String(version.KnowledgeArticleId));
    if (!article) throw orgError('NOT_FOUND', 'The requested resource does not exist');
    const versions = this.versionsOf(article.Id);
    if (status.toLowerCase() === 'online') {
      if (version.PublishStatus !== 'Draft') {
        throw orgError('INVALID_INPUT', 'Only a draft version can be published');
      }
      for (const other of versions) {
        if (other.Id !== version.Id && other.PublishStatus === 'Online') this.archiveVersion(other);
      }
      version.PublishStatus = 'Online';
      version.VersionNumber =
        Math.max(0, ...versions.map((row) => Number(row.VersionNumber ?? 0))) + 1;
      if (this.knowledgeFacts.publishStamps) this.restamp(version, MEMORY_ORG_USER);
      const at = this.stamp();
      article.FirstPublishedDate ??= at;
      article.LastPublishedDate = at;
      return undefined;
    }
    if (status.toLowerCase() === 'draft') {
      if (version.PublishStatus !== 'Online') {
        throw orgError('INVALID_INPUT', 'Only an online version can be set back to draft');
      }
      this.archiveVersion(version);
      const id = this.nextId(ARTICLE_VERSION);
      this.versionKeys.add(keyOf(id));
      const copied = { ...version };
      delete copied.ArchivedDate;
      this.add(ARTICLE_VERSION, {
        ...copied,
        Id: id,
        PublishStatus: 'Draft',
        VersionNumber: 0,
        IsLatestVersion: true,
        ArticleCaseAttachCount: 0,
        CreatedDate: this.stamp(),
        LastModifiedDate: this.stamp(),
        SystemModstamp: this.stamp(),
      });
      return {
        display:
          'The article is no longer published: its online version is archived, and a new draft ' +
          'version exists.',
        id,
        statusCode: 'SUCCESS',
        url: `/services/data/v${this.version}/knowledgeManagement/articleVersions/masterVersions/${id}`,
      };
    }
    throw orgError('INVALID_INPUT', `Not a publish status: ${status}`);
  }

  /** Archive a version, as a later publication or a return to draft does. */
  private archiveVersion(version: MemoryRow): void {
    version.PublishStatus = 'Archived';
    version.IsLatestVersion = false;
    version.ArchivedDate = this.stamp();
    this.restamp(version, MEMORY_ORG_USER);
  }

  /**
   * Begin a draft of an online article, as someone editing it in the org
   * does: a new version under a new id, the online one left as it is.
   *
   * @returns The draft's id.
   */
  editOnline(versionId: string, values: Record<string, unknown> = {}): string {
    const version = this.liveRow(ARTICLE_VERSION, versionId);
    if (!version || version.PublishStatus !== 'Online') {
      throw new Error(`The fake org holds no online version ${versionId}`);
    }
    const id = this.nextId(ARTICLE_VERSION);
    this.versionKeys.add(keyOf(id));
    this.add(ARTICLE_VERSION, {
      ...version,
      ...values,
      Id: id,
      PublishStatus: 'Draft',
      VersionNumber: 0,
      IsLatestVersion: true,
      ArticleCaseAttachCount: 0,
      CreatedDate: this.stamp(),
      LastModifiedDate: this.stamp(),
      SystemModstamp: this.stamp(),
    });
    return id;
  }

  protected override rowsFor(objectApiName: string, scanAll: boolean, soql: string): MemoryRow[] {
    if (objectApiName !== ARTICLE_VERSION) return super.rowsFor(objectApiName, scanAll, soql);
    // A version deleted with its article is read nowhere, not through
    // `queryAll` either (P2.5); an archived one only when asked for.
    const live = this.all(ARTICLE_VERSION);
    return /\bIsLatestVersion\s*=\s*false\b/i.test(soql)
      ? live
      : live.filter((row) => row.IsLatestVersion === true);
  }

  protected override statementRefusal(objectApiName: string, soql: string): Error | undefined {
    if (objectApiName !== ARTICLE_VERSION) return undefined;
    const archived = /\bIsLatestVersion\s*=\s*false\b/i.test(soql);
    if (archived && !/\b(?:Id|KnowledgeArticleId)\s*(?:=|IN\b)/i.test(soql)) {
      return orgError(LATEST_FILTER_REFUSAL.errorCode, LATEST_FILTER_REFUSAL.message);
    }
    if (archived && !/\bPublishStatus\s*=\s*'Archived'/i.test(soql)) {
      return orgError(ARCHIVED_FILTER_REFUSAL.errorCode, ARCHIVED_FILTER_REFUSAL.message);
    }
    return undefined;
  }
}
