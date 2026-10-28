/**
 * The memory org of the checkpoint's tests, holding files as a scratch org
 * held them in the probes of the files' lot (tour 0 of wave 44, `P-A1` to
 * `P-A9`): a file (`ContentDocument`) with its versions (`ContentVersion`),
 * its links to records (`ContentDocumentLink`), and the old model's
 * attachments as records like any other.
 *
 * What it does, as the probes saw it:
 *
 * - A file's versions go to the recycle bin with it and come back with it,
 *   under the same Ids, stamped as any cascade (P-A1). A version is never
 *   deleted on its own: `INSUFFICIENT_ACCESS_OR_READONLY` (P-A6).
 * - A link is live while its file and its record both are. Its file in the
 *   recycle bin, it reads `IsDeleted = true` through `queryAll`; its record
 *   in the bin, it reads nowhere, not even through `queryAll` by its file or
 *   by its record (P-A2). Either back, it is back under its Id once both are,
 *   in any order the two were deleted and brought back: no link is lost
 *   (P-A5).
 * - Deleting or bringing back a file stamps its links to that second (P-A1).
 *   Deleting or bringing back a record a file is linked to stamps the file's
 *   `SystemModstamp`, not its `LastModifiedDate`, and the link's on its way
 *   back (P-A2). Adding or removing a link stamps nothing of its file (P-A4).
 * - A link deleted on its own is gone: no read shows it (P-A3). Its undelete
 *   answers `Entity type is not undeletable`; one inserted again gets a new
 *   Id. The link of a file's owner is not deleted: `FIELD_INTEGRITY_EXCEPTION`.
 * - A link is read only by the file or the record it ties: any other read of
 *   them is refused, `MALFORMED_QUERY` (FA4), and so is a read by its file
 *   that filters on a column that is not an id, `IsDeleted` among them
 *   ({@link LINK_FILTER_REFUSAL}). A link has no `CreatedDate`, nor the other
 *   audit dates (`INVALID_FIELD`).
 * - Without Query All Files ({@link MemoryFileOrg.queryAllFiles}), the
 *   session's user sees a file another user owns only in a read that names
 *   it by its id, never in one that does not, even through `queryAll`, even
 *   linked to a record the user sees (P-A7).
 * - A new version becomes the file's latest, gives the file its title, and
 *   stamps the file and the version it replaces (P-A6).
 * - The org's file storage counts the live files alone: the recycle bin's
 *   take none, and an undelete counts a file again (P-A8).
 *
 * An attachment (`Attachment`) needs nothing of its own: a child of its
 * record whose delete takes it along, as the test that holds one says in its
 * relationships (P-A9).
 *
 * Lives under `src/test/`: a helper, not a suite.
 */

import {
  MEMORY_ORG_USER,
  orgError,
  orgStamp,
  type MemoryChild,
  type MemoryOrgOptions,
  type MemoryRow,
} from './memoryRemovalOrg.js';
import { MemoryRestoreOrg } from './memoryRestoreOrg.js';

/** The object of a file, of its versions and of its links, as the org names them. */
export const FILE_DOCUMENT = 'ContentDocument';
export const FILE_VERSION = 'ContentVersion';
export const FILE_LINK = 'ContentDocumentLink';

/** The first three characters of the ids of a file, a version and a link. */
const DOCUMENT_PREFIX = '069';
const VERSION_PREFIX = '068';
const LINK_PREFIX = '06A';

/** The first three characters of the ids of a user and of an account. */
const USER_PREFIX = '005';
const ACCOUNT_PREFIX = '001';

/** What the org answers a change of the sharing type of a link to an account (P-A3). */
export const SHARE_TYPE_REFUSAL = {
  statusCode: 'INSUFFICIENT_ACCESS_OR_READONLY',
  message:
    'The sharing type cannot be updated because updates are not currently supported for the ' +
    'linked Entity type.',
};

/** The columns a link has, as its describe lists them (P-A1): no audit date. */
const LINK_COLUMNS_MISSING: ReadonlySet<string> = new Set([
  'CreatedDate',
  'CreatedById',
  'LastModifiedDate',
  'LastModifiedById',
]);

/** How a link shares its file: viewer unless told, the owner's link inferred. */
export type MemoryShareType = 'V' | 'C' | 'I';

/** A link as the org holds it. */
export interface MemoryHeldLink {
  Id: string;
  ContentDocumentId: string;
  LinkedEntityId: string;
  ShareType: string;
  Visibility: string;
  SystemModstamp: string;
  /** The link of the file's owner, which the org never deletes. */
  owner: boolean;
}

/** A link of a file to add with it. */
export interface MemoryFileLink {
  /** The record, or the user, the file is linked to. */
  entityId: string;
  /** The link's Id: one is made unless given. */
  id?: string;
  shareType?: MemoryShareType;
  visibility?: string;
}

/** A file to put in the org. */
export interface MemoryFile {
  documentId: string;
  /** Its first version's Id: one is made unless given. */
  versionId?: string;
  title: string;
  /** Who owns it: the session's user unless given. */
  ownerId?: string;
  /** The bytes of its content. */
  size?: number;
  /** The records it is linked to beside its owner. */
  links?: readonly MemoryFileLink[];
  /** Its fields beside those, as a describe lists them. */
  fields?: Record<string, unknown>;
}

/** The key the org knows a record by: its id's first fifteen characters. */
function keyOf(id: string): string {
  return id.slice(0, 15);
}

/** Whether `soql` names records by their ids, as a read that sees another user's file must (P-A7). */
function namesIds(soql: string): boolean {
  return /\bId\s*(?:=\s*'|IN\s*\(\s*')/i.test(soql);
}

/** Whether a read of links names the files or the records they tie, as the org asks of each (FA4). */
function namesLinkEnds(soql: string): boolean {
  return /\b(?:ContentDocumentId|LinkedEntityId)\s*(?:=|IN\b)/i.test(soql);
}

/** The columns a link is read by that the org takes beside its file: its ids. */
const LINK_ID_COLUMNS: ReadonlySet<string> = new Set(['id', 'contentdocumentid', 'linkedentityid']);

/**
 * Whether a read of links by their file filters on a column that is not an
 * id, `IsDeleted` say, which the org refuses: see {@link LINK_FILTER_REFUSAL}.
 * What a semi-join filters is its own statement's.
 */
function filtersFileLinksBeyondIds(soql: string): boolean {
  const where = /\bWHERE\b([\s\S]*?)(?:\bORDER\s+BY\b|\bLIMIT\b|$)/i.exec(soql)?.[1] ?? '';
  const outer = where.replace(/\(\s*SELECT\b[^()]*\)/gi, '()').replace(/'[^']*'/g, "''");
  if (!/\bContentDocumentId\s*(?:=|IN\b)/i.test(outer)) return false;
  const filtered = [
    ...outer.matchAll(/\b(\w+)\s*(?:!=|<=|>=|=|<|>|\bNOT\s+IN\b|\bIN\b|\bLIKE\b)/gi),
  ];
  return filtered.some(([, column]) => !LINK_ID_COLUMNS.has(column.toLowerCase()));
}

/**
 * What the org answers a read of links by their file that filters on another
 * column than an id. Asked on a scratch org through `queryAll`:
 * `SELECT Id, ContentDocumentId FROM ContentDocumentLink WHERE
 * ContentDocumentId IN (…) AND IsDeleted = true` was refused in these words,
 * the same without the filter on `IsDeleted` answered, and a read by
 * `LinkedEntityId IN (…) AND IsDeleted = true` too.
 */
export const LINK_FILTER_REFUSAL = {
  errorCode: 'MALFORMED_QUERY',
  message:
    'Implementation restriction: filtering on non-id fields is only permitted when filtering by ' +
    'ContentDocumentLink.LinkedEntityId using the equals operator.',
};

/** See the module's comment. */
export class MemoryFileOrg extends MemoryRestoreOrg {
  /**
   * Whether the session's user has Query All Files: with it, a read sees
   * every file, whoever owns it. Without it, as on the probes' orgs (FA6).
   */
  queryAllFiles = false;
  /**
   * The org's answer to a read of links through a semi-join, when it refuses
   * one: a statement past what it reads in time, or one it will not take.
   */
  refuseSemiJoin?: { errorCode: string; message: string };
  /** The links of every file, by key, in the order they were made. */
  private readonly links = new Map<string, MemoryHeldLink>();
  private linked = 0;

  /**
   * @param children - Per object, the child relationships its describe lists:
   *   a file's versions are added to them, which go with their file.
   */
  constructor(
    children: Readonly<Record<string, readonly MemoryChild[]>> = {},
    options: MemoryOrgOptions = {},
  ) {
    super(
      {
        ...children,
        [FILE_DOCUMENT]: [
          ...(children[FILE_DOCUMENT] ?? []),
          { childSObject: FILE_VERSION, field: 'ContentDocumentId', cascadeDelete: true },
        ],
      },
      options,
    );
    this.missingFields.set(FILE_LINK, LINK_COLUMNS_MISSING);
  }

  /** An id of `prefix` no record of the org has yet. */
  private nextId(prefix: string): string {
    this.linked++;
    return `${prefix}MF${String(this.linked).padStart(10, '0')}AAA`;
  }

  /** Now, as the org dates a write: to the second. */
  private stampOfNow(): string {
    return orgStamp(this.now());
  }

  /**
   * Put a file in, as its first version makes it: the file, the version, the
   * link of its owner and those to the records it names, all dated now.
   */
  addFile(file: MemoryFile): void {
    const versionId = file.versionId ?? this.nextId(VERSION_PREFIX);
    const ownerId = file.ownerId ?? MEMORY_ORG_USER;
    this.add(FILE_DOCUMENT, {
      Id: file.documentId,
      Title: file.title,
      OwnerId: ownerId,
      LatestPublishedVersionId: versionId,
      ContentSize: file.size ?? 0,
      Description: null,
      SharingPrivacy: 'N',
      SharingOption: 'A',
      ...file.fields,
    });
    this.add(FILE_VERSION, {
      Id: versionId,
      ContentDocumentId: file.documentId,
      Title: file.title,
      IsLatest: true,
      VersionNumber: '1',
      ContentSize: file.size ?? 0,
    });
    this.hold(file.documentId, ownerId, { shareType: 'I' }, true);
    for (const link of file.links ?? []) this.hold(file.documentId, link.entityId, link, false);
  }

  private hold(
    documentId: string,
    entityId: string,
    link: Omit<MemoryFileLink, 'entityId'>,
    owner: boolean,
  ): string {
    const id = link.id ?? this.nextId(LINK_PREFIX);
    this.links.set(keyOf(id), {
      Id: id,
      ContentDocumentId: documentId,
      LinkedEntityId: entityId,
      ShareType: link.shareType ?? 'V',
      Visibility: link.visibility ?? 'AllUsers',
      SystemModstamp: this.stampOfNow(),
      owner,
    });
    return id;
  }

  /**
   * Link a file to a record, as a person does: under a new Id, its file not
   * stamped (P-A4).
   *
   * @returns The link's Id.
   */
  link(documentId: string, entityId: string, link: Omit<MemoryFileLink, 'entityId'> = {}): string {
    return this.hold(documentId, entityId, link, false);
  }

  /**
   * Remove a link, as a person does: gone, nowhere to read (P-A3), its file
   * not stamped (P-A4).
   *
   * @throws What the org answers for its owner's link, which it never removes.
   */
  unlink(linkId: string): void {
    const held = this.links.get(keyOf(linkId));
    if (held?.owner) throw orgError('FIELD_INTEGRITY_EXCEPTION', 'field integrity exception');
    this.links.delete(keyOf(linkId));
  }

  /**
   * Give a file a new version, as a person does (P-A6): the latest, whose
   * title the file takes, the file and the version before stamped.
   *
   * @returns The new version's Id.
   */
  newVersion(documentId: string, title: string, size?: number): string {
    const file = this.liveRow(FILE_DOCUMENT, documentId);
    if (!file) throw new Error(`The fake org holds no live file ${documentId}`);
    const versionId = this.nextId(VERSION_PREFIX);
    const before = this.all(FILE_VERSION).filter(
      (version) => version.ContentDocumentId === documentId,
    );
    for (const version of before) {
      version.IsLatest = false;
      this.restamp(version, MEMORY_ORG_USER);
    }
    this.add(FILE_VERSION, {
      Id: versionId,
      ContentDocumentId: documentId,
      Title: title,
      IsLatest: true,
      VersionNumber: String(before.length + 1),
      ContentSize: size ?? file.ContentSize,
    });
    Object.assign(file, {
      Title: title,
      LatestPublishedVersionId: versionId,
      ...(size !== undefined ? { ContentSize: size } : {}),
    });
    this.restamp(file, MEMORY_ORG_USER);
    return versionId;
  }

  /** Every link of the org, as it holds them, live or not: what a test reads the truth from. */
  heldLinks(): MemoryHeldLink[] {
    return [...this.links.values()].map((link) => ({ ...link }));
  }

  /** Bytes of file storage the org counts: its live files' (P-A8). */
  fileStorageBytes(): number {
    return this.all(FILE_DOCUMENT).reduce(
      (bytes, file) => bytes + Number(file.ContentSize ?? 0),
      0,
    );
  }

  /** A link as a read sees it, or none: see the module's comment. */
  private linkRow(link: MemoryHeldLink, scanAll: boolean): MemoryRow | undefined {
    if (this.namesBinned(link.LinkedEntityId)) return undefined;
    const fileLive = this.liveRow(FILE_DOCUMENT, link.ContentDocumentId) !== undefined;
    if (!fileLive && !(scanAll && this.namesBinned(link.ContentDocumentId))) return undefined;
    return {
      Id: link.Id,
      ContentDocumentId: link.ContentDocumentId,
      LinkedEntityId: link.LinkedEntityId,
      ShareType: link.ShareType,
      Visibility: link.Visibility,
      SystemModstamp: link.SystemModstamp,
      IsDeleted: !fileLive,
    };
  }

  protected override rowsFor(objectApiName: string, scanAll: boolean, soql: string): MemoryRow[] {
    if (objectApiName === FILE_LINK) {
      return [...this.links.values()]
        .map((link) => this.linkRow(link, scanAll))
        .filter((row): row is MemoryRow => row !== undefined);
    }
    const rows = super.rowsFor(objectApiName, scanAll, soql);
    if (objectApiName !== FILE_DOCUMENT || this.queryAllFiles || namesIds(soql)) return rows;
    return rows.filter((row) => row.OwnerId === MEMORY_ORG_USER);
  }

  protected override statementRefusal(objectApiName: string, soql: string): Error | undefined {
    if (objectApiName !== FILE_LINK) return undefined;
    if (!namesLinkEnds(soql)) {
      return orgError(
        'MALFORMED_QUERY',
        'Implementation restriction: ContentDocumentLink requires a filter by a single Id on ' +
          'ContentDocumentId or LinkedEntityId using the equals operator or multiple Id’s ' +
          'using the IN operator.',
      );
    }
    if (filtersFileLinksBeyondIds(soql)) {
      return orgError(LINK_FILTER_REFUSAL.errorCode, LINK_FILTER_REFUSAL.message);
    }
    const refusal = this.refuseSemiJoin;
    if (refusal && /\bIN\s*\(\s*SELECT\b/i.test(soql)) {
      return orgError(refusal.errorCode, refusal.message);
    }
    return undefined;
  }

  protected override removed(objectApiName: string, row: MemoryRow): void {
    const at = this.stampOfNow();
    const key = keyOf(row.Id);
    for (const link of this.links.values()) {
      if (objectApiName === FILE_DOCUMENT && keyOf(link.ContentDocumentId) === key) {
        link.SystemModstamp = at;
      } else if (keyOf(link.LinkedEntityId) === key) {
        const file = this.liveRow(FILE_DOCUMENT, link.ContentDocumentId);
        if (file) file.SystemModstamp = at;
      }
    }
  }

  protected override undeleted(objectApiName: string, row: MemoryRow): void {
    const at = this.stampOfNow();
    const key = keyOf(row.Id);
    for (const link of this.links.values()) {
      if (objectApiName === FILE_DOCUMENT && keyOf(link.ContentDocumentId) === key) {
        link.SystemModstamp = at;
      } else if (keyOf(link.LinkedEntityId) === key) {
        link.SystemModstamp = at;
        const file = this.liveRow(FILE_DOCUMENT, link.ContentDocumentId);
        if (file) file.SystemModstamp = at;
      }
    }
  }

  /** Whether a record of any object is live, or the id is a user's, which a link may name. */
  private linkable(id: string): boolean {
    if (id.startsWith(USER_PREFIX)) return true;
    return this.objectNames().some((name) => this.liveRow(name, id) !== undefined);
  }

  /**
   * Insert records, links among them: a link under a new Id, once its file
   * and its record are live, its file not stamped (P-A3, P-A4); one between a
   * file and a record a live link ties already is refused. The rest as the
   * restore org makes them, in one call.
   */
  override async create(
    objectApiName: string,
    records: Array<Record<string, unknown>>,
  ): Promise<unknown> {
    if (objectApiName !== FILE_LINK) return super.create(objectApiName, records);
    this.requests++;
    this.creates.push({ objectApiName, records: records.map((record) => ({ ...record })) });
    return records.map((record) => {
      const documentId = record.ContentDocumentId;
      const entityId = record.LinkedEntityId;
      if (
        typeof documentId !== 'string' ||
        typeof entityId !== 'string' ||
        this.liveRow(FILE_DOCUMENT, documentId) === undefined ||
        !this.linkable(entityId)
      ) {
        return {
          success: false,
          errors: [
            { statusCode: 'INVALID_CROSS_REFERENCE_KEY', message: 'invalid cross reference id' },
          ],
        };
      }
      const twin = [...this.links.values()].find(
        (link) =>
          keyOf(link.ContentDocumentId) === keyOf(documentId) &&
          keyOf(link.LinkedEntityId) === keyOf(entityId) &&
          this.linkRow(link, false) !== undefined,
      );
      if (twin) {
        return {
          success: false,
          errors: [
            {
              statusCode: 'DUPLICATE_VALUE',
              message:
                `Document with ID: ${documentId} is already linked with the entity with ID: ` +
                entityId,
            },
          ],
        };
      }
      const id = this.hold(
        documentId,
        entityId,
        {
          ...(typeof record.ShareType === 'string'
            ? { shareType: record.ShareType as MemoryShareType }
            : {}),
          ...(typeof record.Visibility === 'string' ? { visibility: record.Visibility } : {}),
        },
        false,
      );
      return { id, success: true, errors: [] };
    });
  }

  /**
   * Update records, links among them: a link's sharing set in place and the
   * link stamped, but the sharing type of a link to an account, which the org
   * refuses (P-A3). The rest as the restore org updates them, in one call.
   */
  override async update(
    objectApiName: string,
    records: Array<Record<string, unknown>>,
  ): Promise<unknown> {
    if (objectApiName !== FILE_LINK) return super.update(objectApiName, records);
    this.requests++;
    this.updates.push({ objectApiName, records: records.map((record) => ({ ...record })) });
    return records.map((record) => {
      const id = String(record.Id);
      const held = this.links.get(keyOf(id));
      if (held === undefined || this.linkRow(held, false) === undefined) {
        return {
          id,
          success: false,
          errors: [{ statusCode: 'ENTITY_IS_DELETED', message: 'entity is deleted' }],
        };
      }
      if (
        typeof record.ShareType === 'string' &&
        record.ShareType !== held.ShareType &&
        held.LinkedEntityId.startsWith(ACCOUNT_PREFIX)
      ) {
        return { id, success: false, errors: [SHARE_TYPE_REFUSAL] };
      }
      if (typeof record.ShareType === 'string') held.ShareType = record.ShareType;
      if (typeof record.Visibility === 'string') held.Visibility = record.Visibility;
      held.SystemModstamp = this.stampOfNow();
      return { id, success: true, errors: [] };
    });
  }

  /**
   * Delete records by id, links and versions among them: a link goes for
   * good, but its owner's, which the org refuses; a version is refused. The
   * rest as the base org deletes them, in one call.
   */
  override async destroy(objectApiName: string, ids: string[]): Promise<unknown> {
    const answers: unknown[] = [];
    const rest: Array<{ place: number; id: string }> = [];
    ids.forEach((id, place) => {
      if (id.startsWith(LINK_PREFIX)) {
        const held = this.links.get(keyOf(id));
        if (held === undefined || this.linkRow(held, false) === undefined) {
          answers[place] = {
            success: false,
            errors: [{ statusCode: 'ENTITY_IS_DELETED', message: 'entity is deleted' }],
          };
        } else if (held.owner) {
          answers[place] = {
            success: false,
            errors: [
              { statusCode: 'FIELD_INTEGRITY_EXCEPTION', message: 'field integrity exception' },
            ],
          };
        } else {
          this.links.delete(keyOf(id));
          answers[place] = { id, success: true, errors: [] };
        }
      } else if (id.startsWith(VERSION_PREFIX)) {
        answers[place] = {
          success: false,
          errors: [
            {
              statusCode: 'INSUFFICIENT_ACCESS_OR_READONLY',
              message: 'insufficient access rights on object id',
            },
          ],
        };
      } else {
        rest.push({ place, id });
      }
    });
    if (rest.length === 0) {
      this.requests++;
      this.deletes.push({ objectApiName, ids: [...ids] });
      return answers;
    }
    const others = (await super.destroy(
      objectApiName,
      rest.map(({ id }) => id),
    )) as unknown[];
    rest.forEach(({ place }, at) => {
      answers[place] = others[at];
    });
    return answers;
  }

  /**
   * Bring records back from the recycle bin, refusing a link and a version,
   * which the org brings back with their file only (P-A3, FA2).
   */
  override async undelete(ids: string[]): Promise<unknown> {
    const answers: unknown[] = [];
    const rest: Array<{ place: number; id: string }> = [];
    ids.forEach((id, place) => {
      if (id.startsWith(LINK_PREFIX) || id.startsWith(VERSION_PREFIX)) {
        answers[place] = {
          id,
          success: false,
          errors: [
            {
              statusCode: 'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY',
              message: 'Entity type is not undeletable',
            },
          ],
        };
      } else {
        rest.push({ place, id });
      }
    });
    if (rest.length === 0) {
      this.soapCalls++;
      return answers;
    }
    const others = (await super.undelete(rest.map(({ id }) => id))) as unknown[];
    rest.forEach(({ place }, at) => {
      answers[place] = others[at];
    });
    return answers;
  }
}

/** A file's id, the `n`th: `069…`. */
export function fileId(n: number): string {
  return `${DOCUMENT_PREFIX}${String(n).padStart(12, '0')}AAA`;
}
