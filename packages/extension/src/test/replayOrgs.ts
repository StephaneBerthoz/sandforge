/**
 * The two ends of a replay of a checkpoint into another org, in miniature:
 * a checkpoint's folder made as a take leaves one — its snapshot compressed
 * and indexed, its `checkpoint.json`, its replay annex when it is of 1.81 or
 * later, its files' links — and the other org, read and written through the
 * access the Frozen loader reads a target with (`TargetOrgAccess`).
 *
 * The other org's describes copy, for the fields a test uses, what a scratch
 * org with person accounts and several currencies answered (`sf sobject
 * describe`, API 68.0): which fields an insert sets, which it requires and
 * which the org defaults, and what each lookup points at. An account's owner
 * is a user alone, a case's or a task's a user or a queue. It reads what an
 * org reads and refuses what an org refuses:
 *
 * - a describe of an object it does not have, `NOT_FOUND`;
 * - `IsPersonType` from an org without person accounts, `INVALID_FIELD`;
 * - `CurrencyType` from an org of one currency, `INVALID_TYPE`;
 * - an insert of an object it does not let anyone create, `INVALID_TYPE_FOR_OPERATION`;
 * - an owner it holds no user or queue of, and a lookup to a record it does
 *   not hold, `INVALID_CROSS_REFERENCE_KEY`;
 * - an owner it holds inactive, `INACTIVE_OWNER_OR_USER`;
 * - a record type it does not have for the object, or does not let the user
 *   create records of, `INVALID_CROSS_REFERENCE_KEY`;
 * - a currency it has not activated (the code the org answers is read at the
 *   replay's gate; `INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST` until then);
 * - a second row of a hierarchy setting for one owner, `DUPLICATE_VALUE`;
 * - a business account without its name, `REQUIRED_FIELD_MISSING`.
 *
 * Lives under `src/test/`: a helper, not a suite.
 */

import { createHash } from 'node:crypto';

import type {
  CheckpointCustomSettingKind,
  CheckpointOrg,
  CheckpointReplayAnnex,
  CheckpointStatus,
  OrgCheckpoint,
} from '@sandforge/shared';

import { to18 } from '../core/common/salesforceId.js';
import {
  filesDocumentsFileOf,
  filesLinksFileOf,
  type CheckpointFolder,
  type OrgCheckpointStore,
} from '../modules/checkpoint/OrgCheckpointStore.js';
import type { FileDocumentLine, FileLinkLine } from '../modules/checkpoint/checkpointFiles.js';
import { compressedSnapshotFiles } from '../modules/checkpoint/compressedSnapshotFiles.js';
import { writeReplayAnnex } from '../modules/checkpoint/replay/replayAnnex.js';
import { snapshotFileOf, writeSnapshotIndex } from '../modules/checkpoint/snapshotIndex.js';
import { nodeBackupFiles } from '../modules/dataops/BackupRecordStore.js';
import type {
  FrozenDmlWriter,
  TargetFieldDescribe,
  TargetObjectDescribe,
  TargetOrgAccess,
} from '../modules/frozendataset/loadTypes.js';
import type { OperationOutcome } from '../modules/sync/DataSync.js';
import { MEMORY_ORG_USER, orgError, type MemoryChild, type MemoryRow } from './memoryRemovalOrg.js';
import { MemoryRestoreOrg } from './memoryRestoreOrg.js';

/** The org a fabricated checkpoint is of, unless it names another. */
export const SOURCE_ORG_ID = '00D000000000011EAA';
/** The other org of a replay. */
export const TARGET_ORG_ID = '00D000000000022EAA';
/** When a fabricated checkpoint was taken. */
export const TAKEN_AT = '2026-11-10T09:14:00.000Z';
/** The fabricated checkpoint's id, unless it names another. */
export const CHECKPOINT_ID = 'ck-20261110-091400-a1b2';

/** An id of `prefix`, numbered, in its 18 characters. */
export const idOf = (prefix: string, n: number): string =>
  to18(`${prefix}${String(n).padStart(12, '0')}`);

/** The user who replays, in the other org. */
export const REPLAYING_USER = idOf('005', 990);

// ─── The checkpoint ──────────────────────────────────────────────────────────

/** An object of a fabricated checkpoint and its records, each with its `Id`. */
export interface FabricatedObject {
  objectApiName: string;
  rows: Array<Record<string, unknown> & { Id: string }>;
  customSetting?: CheckpointCustomSettingKind;
  /** The fields its snapshot holds: those of its rows unless given. */
  fields?: string[];
}

/** What a fabricated checkpoint holds and says. */
export interface CheckpointSpec {
  checkpointId?: string;
  name?: string;
  org?: Partial<CheckpointOrg>;
  status?: CheckpointStatus;
  objects: FabricatedObject[];
  /**
   * Its replay annex, as a take of 1.81 or later keeps it; none, as one
   * taken before keeps none.
   */
  annex?: Omit<CheckpointReplayAnnex, 'version' | 'organizationId' | 'unread'> &
    Partial<Pick<CheckpointReplayAnnex, 'unread'>>;
  files?: { links: FileLinkLine[]; documents: FileDocumentLine[] };
}

/** A fabricated checkpoint, and its folder. */
export interface Fabricated {
  checkpoint: OrgCheckpoint;
  folder: CheckpointFolder;
}

/** The stamps every row of a snapshot holds, dated before the take. */
function stamped(row: Record<string, unknown> & { Id: string }): Record<string, unknown> {
  const at = '2026-11-01T08:00:00.000Z';
  return {
    SystemModstamp: at,
    CreatedDate: at,
    CreatedById: MEMORY_ORG_USER,
    LastModifiedDate: at,
    LastModifiedById: MEMORY_ORG_USER,
    ...row,
  };
}

/**
 * Make, in `store`, the folder of a checkpoint holding `spec`'s records, as a
 * take leaves one: each object's values compressed and indexed, then
 * `checkpoint.json`, then the annex and the files' links when it holds them.
 */
export async function fabricateCheckpoint(
  store: OrgCheckpointStore,
  spec: CheckpointSpec,
): Promise<Fabricated> {
  // A key a test sets to undefined is one the checkpoint does not have, as a
  // take before 1.81 leaves `dataStorageMaxMB` out.
  const org = Object.fromEntries(
    Object.entries({
      organizationId: SOURCE_ORG_ID,
      alias: 'DEV1',
      username: 'ada@example.com.dev1',
      instanceUrl: 'https://example--dev1.sandbox.my.salesforce.com',
      isSandbox: true,
      organizationType: 'Enterprise Edition',
      tier: 'sandbox',
      dataStorageMaxMB: 200,
      ...spec.org,
    }).filter(([, value]) => value !== undefined),
  ) as unknown as CheckpointOrg;
  const checkpointId = spec.checkpointId ?? CHECKPOINT_ID;
  const snapshotId = `snapshot-${checkpointId}`;
  const folder = await store.create(org.organizationId, checkpointId);
  const files = compressedSnapshotFiles(nodeBackupFiles(folder.dir));
  await files.mkdir(`${folder.dir}/backups`);
  const objects: OrgCheckpoint['objects'] = [];
  for (const [readOrder, object] of spec.objects.entries()) {
    const rows = object.rows.map(stamped);
    await files.writeFile(
      snapshotFileOf(folder, snapshotId, object.objectApiName),
      rows.map((row) => `${JSON.stringify(row)}\n`).join(''),
    );
    await writeSnapshotIndex(folder, snapshotId, object.objectApiName);
    const fields = object.fields ?? [...new Set(rows.flatMap((row) => Object.keys(row)))].sort();
    objects.push({
      objectApiName: object.objectApiName,
      records: rows.length,
      inBin: 0,
      readOrder,
      readMode: object.objectApiName === 'Task' ? 'scanAllLive' : 'query',
      undeletable: true,
      cascadeParents: [],
      fingerprint: createHash('sha256').update(fields.join(',')).digest('hex'),
      fields,
      leftOutFields: [],
      ...(object.customSetting !== undefined ? { customSetting: object.customSetting } : {}),
    });
  }
  if (spec.files !== undefined) {
    await files.mkdir(folder.filesDir);
    await files.writeFile(
      filesLinksFileOf(folder),
      spec.files.links.map((line) => `${JSON.stringify(line)}\n`).join(''),
    );
    await files.writeFile(
      filesDocumentsFileOf(folder),
      spec.files.documents.map((line) => `${JSON.stringify(line)}\n`).join(''),
    );
  }
  const summary =
    spec.annex !== undefined
      ? await writeReplayAnnex(folder, {
          version: 1,
          organizationId: org.organizationId,
          unread: [],
          ...spec.annex,
        })
      : undefined;
  const checkpoint: OrgCheckpoint = {
    version: 1,
    checkpointId,
    name: spec.name ?? 'Before UAT',
    org,
    takenBy: { userId: MEMORY_ORG_USER, viewAllData: true, modifyAllData: true },
    readFrom: TAKEN_AT,
    takenAt: TAKEN_AT,
    scope: { mode: 'picked', leftOut: [] },
    objects,
    ignoredFields: [],
    snapshotId,
    movedWhileTaken: { changed: 0, deleted: 0, created: 0 },
    bytes: 0,
    expiresAt: null,
    status: spec.status ?? 'ready',
    takenOn: { host: 'test-host', pid: 1 },
    ...(spec.files !== undefined
      ? {
          files: {
            documents: spec.files.documents.length,
            links: spec.files.links.length,
            anchored: spec.files.documents.filter((doc) => doc.anchored).length,
          },
        }
      : {}),
    ...(summary !== undefined ? { replayAnnex: summary } : {}),
  };
  await store.write(checkpoint);
  return { checkpoint, folder };
}

// ─── The other org ───────────────────────────────────────────────────────────

/** A field of the other org's describe, with its length where it has one. */
export type ReplayField = TargetFieldDescribe & { length?: number };

/** A field anyone may set, which an insert may leave empty. */
function settable(name: string, type: string, extra: Partial<ReplayField> = {}): ReplayField {
  return { name, type, createable: true, nillable: true, defaultedOnCreate: false, ...extra };
}

/** A lookup anyone may set. */
function lookup(name: string, to: string[], extra: Partial<ReplayField> = {}): ReplayField {
  return settable(name, 'reference', { referenceTo: to, length: 18, ...extra });
}

/** A field the org sets itself, which no insert sets. */
function readOnly(name: string, type: string, extra: Partial<ReplayField> = {}): ReplayField {
  return { name, type, createable: false, nillable: true, defaultedOnCreate: true, ...extra };
}

/** An owner, which the org gives the user who writes when none is sent. */
const owner = (to: string[]): ReplayField =>
  lookup('OwnerId', to, { nillable: false, defaultedOnCreate: true });

/** An amount's currency, which the org gives its own when none is sent. */
const CURRENCY: ReplayField = settable('CurrencyIsoCode', 'picklist', {
  defaultedOnCreate: true,
  length: 3,
});

/** The record type, a lookup to `RecordType`. */
const RECORD_TYPE: ReplayField = lookup('RecordTypeId', ['RecordType']);

/** The id, which no insert sets. */
const ID: ReplayField = readOnly('Id', 'id', { nillable: false, length: 18 });

/**
 * The fields of the objects a test replays, as a scratch org with person
 * accounts and several currencies describes them: required where the org
 * requires them at insert, defaulted where it defaults them. Absent from an
 * org of one currency: `CurrencyIsoCode`; from one without person accounts:
 * the person fields and the flag.
 */
export function describedFields(options: {
  personAccounts: boolean;
  multiCurrency: boolean;
}): Record<string, ReplayField[]> {
  const currency = options.multiCurrency ? [CURRENCY] : [];
  const person = options.personAccounts
    ? [
        settable('LastName', 'string', { length: 80 }),
        settable('FirstName', 'string', { length: 40 }),
        settable('PersonEmail', 'email', { length: 80 }),
        settable('PersonMobilePhone', 'phone', { length: 40 }),
        readOnly('IsPersonAccount', 'boolean'),
        readOnly('PersonContactId', 'reference', { referenceTo: ['Contact'] }),
      ]
    : [];
  const personFlag = options.personAccounts ? [readOnly('IsPersonAccount', 'boolean')] : [];
  return {
    Account: [
      ID,
      settable('Name', 'string', { length: 255 }),
      settable('Phone', 'phone', { length: 40 }),
      settable('Industry', 'picklist', { length: 255 }),
      settable('Description', 'textarea', { length: 32000 }),
      owner(['User']),
      RECORD_TYPE,
      lookup('ParentId', ['Account']),
      lookup('SFX_Primary_Contact__c', ['Contact']),
      ...currency,
      ...person,
    ],
    Contact: [
      ID,
      settable('LastName', 'string', { nillable: false, length: 80 }),
      settable('FirstName', 'string', { length: 40 }),
      settable('Email', 'email', { length: 80 }),
      settable('Phone', 'phone', { length: 40 }),
      lookup('AccountId', ['Account']),
      lookup('ReportsToId', ['Contact']),
      owner(['User']),
      ...currency,
      ...personFlag,
    ],
    AccountContactRelation: [
      ID,
      lookup('AccountId', ['Account'], { nillable: false }),
      lookup('ContactId', ['Contact'], { nillable: false }),
      readOnly('IsDirect', 'boolean'),
      settable('Roles', 'multipicklist', { length: 4099 }),
    ],
    Opportunity: [
      ID,
      settable('Name', 'string', { nillable: false, length: 120 }),
      settable('StageName', 'picklist', { nillable: false, length: 255 }),
      settable('CloseDate', 'date', { nillable: false }),
      settable('Amount', 'currency'),
      settable('Description', 'textarea', { length: 32000 }),
      lookup('AccountId', ['Account']),
      lookup('Pricebook2Id', ['Pricebook2'], { defaultedOnCreate: true }),
      owner(['User']),
      RECORD_TYPE,
      ...currency,
    ],
    OpportunityLineItem: [
      ID,
      lookup('OpportunityId', ['Opportunity'], { nillable: false }),
      lookup('PricebookEntryId', ['PricebookEntry']),
      lookup('Product2Id', ['Product2']),
      settable('Quantity', 'double', { nillable: false }),
      settable('UnitPrice', 'currency', { defaultedOnCreate: true }),
      ...(options.multiCurrency ? [readOnly('CurrencyIsoCode', 'picklist', { length: 3 })] : []),
    ],
    Product2: [
      ID,
      settable('Name', 'string', { nillable: false, length: 255 }),
      settable('IsActive', 'boolean', { nillable: false, defaultedOnCreate: true }),
      ...currency,
    ],
    Pricebook2: [
      ID,
      settable('Name', 'string', { nillable: false, length: 255 }),
      settable('IsActive', 'boolean', { nillable: false, defaultedOnCreate: true }),
      readOnly('IsStandard', 'boolean'),
      ...currency,
    ],
    PricebookEntry: [
      ID,
      lookup('Pricebook2Id', ['Pricebook2'], { nillable: false }),
      lookup('Product2Id', ['Product2'], { nillable: false }),
      settable('UnitPrice', 'currency', { nillable: false }),
      settable('IsActive', 'boolean', { nillable: false, defaultedOnCreate: true }),
      ...currency,
    ],
    Case: [
      ID,
      settable('Subject', 'string', { length: 255 }),
      settable('SuppliedEmail', 'email', { length: 80 }),
      settable('Description', 'textarea', { length: 32000 }),
      lookup('AccountId', ['Account']),
      lookup('ContactId', ['Contact']),
      owner(['Group', 'User']),
      ...currency,
    ],
    Task: [
      ID,
      settable('Subject', 'combobox', { length: 255 }),
      settable('Description', 'textarea', { length: 32000 }),
      lookup('WhoId', ['Contact', 'Lead']),
      lookup('WhatId', ['Account', 'Case', 'Opportunity', 'Product2']),
      owner(['Group', 'User']),
      ...currency,
    ],
    ContentDocument: [ID, readOnly('Title', 'string', { length: 255 })],
    ContentDocumentLink: [
      ID,
      lookup('ContentDocumentId', ['ContentDocument'], { nillable: false }),
      lookup('LinkedEntityId', ['Account', 'Opportunity'], { nillable: false }),
      settable('ShareType', 'picklist', { nillable: false, length: 40 }),
      settable('Visibility', 'picklist', { defaultedOnCreate: true, length: 40 }),
    ],
  };
}

/** A custom setting's fields: its name, its owner, and a value. */
export function settingFields(kind: CheckpointCustomSettingKind): ReplayField[] {
  return [
    ID,
    settable('Name', 'string', { nillable: kind === 'hierarchy', length: 80 }),
    lookup('SetupOwnerId', ['Organization', 'Profile', 'User'], {
      nillable: false,
      defaultedOnCreate: true,
    }),
    settable('Value__c', 'string', { length: 255 }),
  ];
}

/** How the other org is set up. */
export interface ReplayTargetOptions {
  organizationId?: string;
  personAccounts?: boolean;
  /** Its active currencies; absent, an org of one currency. */
  currencies?: string[];
  /** Per object, its fields: {@link describedFields} unless given. */
  fields?: Record<string, ReplayField[]>;
  /** Objects it does not let anyone create records of. */
  notCreateable?: string[];
  /** Per object, the child relationships its describe lists, which a delete follows: none unless given. */
  children?: Record<string, MemoryChild[]>;
  /**
   * Whether it writes, as an org does, the direct relation of each contact
   * inserted with an account, in the same save: none unless told.
   */
  directRelations?: boolean;
}

/** A record type of the other org, as its describe gives it to the user who replays. */
export interface TargetRecordTypeSpec {
  id: string;
  sobjectType: string;
  developerName: string;
  namespacePrefix?: string;
  name?: string;
  isPersonType?: boolean;
  /** Whether the user who replays may create records of it: yes unless told. */
  available?: boolean;
  /** Whether the describe gives it as the user's default. */
  defaultRecordTypeMapping?: boolean;
}

/** See the module's comment. */
export class ReplayTargetOrg {
  readonly organizationId: string;
  /** The user the replay writes as: none of the checkpoint's org's, which another org never holds. */
  readonly runningUserId = REPLAYING_USER;
  /** The records, read and written. */
  readonly org: MemoryRestoreOrg;
  /** Every statement it was asked, in order. */
  readonly asked: string[] = [];
  /** Every describe it was asked, in order. */
  readonly described: string[] = [];
  private readonly fields: Record<string, ReplayField[]>;
  private readonly notCreateable: ReadonlySet<string>;
  /** Per object, what its describe says of deleting its records, where a test gives it. */
  private readonly deletable = new Map<string, boolean>();
  private readonly recordTypeInfos = new Map<string, TargetRecordTypeSpec[]>();
  readonly personAccounts: boolean;
  readonly currencies: readonly string[] | undefined;
  /** See {@link ReplayTargetOptions.directRelations}. */
  private readonly directRelations: boolean;
  /** Direct relations it wrote, to number their ids. */
  private relationsMade = 0;

  constructor(options: ReplayTargetOptions = {}) {
    this.org = new MemoryRestoreOrg(options.children ?? {});
    this.organizationId = options.organizationId ?? TARGET_ORG_ID;
    this.directRelations = options.directRelations ?? false;
    this.personAccounts = options.personAccounts ?? true;
    this.currencies = options.currencies;
    this.fields =
      options.fields ??
      describedFields({
        personAccounts: this.personAccounts,
        multiCurrency: this.currencies !== undefined,
      });
    this.notCreateable = new Set(['ContentDocument', ...(options.notCreateable ?? [])]);
    if (!this.personAccounts) this.org.missingFields.set('RecordType', new Set(['IsPersonType']));
    if (this.currencies === undefined) {
      this.org.refuseRead.set('CurrencyType', {
        errorCode: 'INVALID_TYPE',
        message: "sObject type 'CurrencyType' is not supported.",
      });
    } else {
      for (const [n, code] of ['USD', 'EUR', 'GBP', 'JPY'].entries()) {
        this.org.add('CurrencyType', {
          Id: idOf('01L', n + 1),
          IsoCode: code,
          IsActive: this.currencies.includes(code),
        });
      }
    }
    this.org.add('Organization', { Id: this.organizationId });
    this.addUser({ id: REPLAYING_USER, username: 'replayer@example.com.uat' });
    this.org.refuseCreate = (objectApiName, record) => this.refusal(objectApiName, record);
  }

  /**
   * Give the org a field list for an object it did not have: a custom
   * setting, a custom object, or one the platform writes, whose describe
   * then says whether its records may be deleted (a sweep looks only at
   * those it says may be).
   */
  withObject(
    objectApiName: string,
    fields: ReplayField[],
    describe: { deletable?: boolean } = {},
  ): this {
    this.fields[objectApiName] = fields;
    if (describe.deletable !== undefined) this.deletable.set(objectApiName, describe.deletable);
    return this;
  }

  /** A user of the org. */
  addUser(user: { id: string; username: string; isActive?: boolean; userType?: string }): this {
    this.org.add('User', {
      Id: user.id,
      Username: user.username,
      IsActive: user.isActive ?? true,
      UserType: user.userType ?? 'Standard',
    });
    return this;
  }

  /** A record type of the org, and how its describe gives it. */
  addRecordType(type: TargetRecordTypeSpec): this {
    this.org.add('RecordType', {
      Id: type.id,
      SobjectType: type.sobjectType,
      DeveloperName: type.developerName,
      NamespacePrefix: type.namespacePrefix ?? null,
      Name: type.name ?? type.developerName,
      IsActive: true,
      ...(this.personAccounts ? { IsPersonType: type.isPersonType ?? false } : {}),
    });
    this.recordTypeInfos.set(type.sobjectType, [
      ...(this.recordTypeInfos.get(type.sobjectType) ?? []),
      type,
    ]);
    return this;
  }

  /** A queue of the org, and the objects whose records it may own. */
  addQueue(id: string, developerName: string, objects: string[]): this {
    this.org.add('Group', {
      Id: id,
      DeveloperName: developerName,
      Name: developerName,
      Type: 'Queue',
    });
    for (const [n, sobjectType] of objects.entries()) {
      this.org.add('QueueSobject', {
        Id: `03g${id.slice(3, 14)}${n}AAA`,
        QueueId: id,
        SobjectType: sobjectType,
      });
    }
    return this;
  }

  /** A record the org holds already. */
  hold(objectApiName: string, row: MemoryRow): this {
    this.org.add(objectApiName, row);
    return this;
  }

  /** Its describe of an object, as the Frozen loader reads one. */
  describeOf(objectApiName: string): TargetObjectDescribe {
    const fields = this.fields[objectApiName];
    if (fields === undefined) {
      throw orgError(
        'NOT_FOUND',
        `The requested resource does not exist: sobjects/${objectApiName}`,
      );
    }
    const types = this.recordTypeInfos.get(objectApiName) ?? [];
    return {
      name: objectApiName,
      createable: !this.notCreateable.has(objectApiName),
      ...(this.deletable.has(objectApiName)
        ? { deletable: this.deletable.get(objectApiName) }
        : {}),
      fields: fields.map((field) => ({ ...field })),
      ...(types.length > 0
        ? {
            recordTypeInfos: types.map((type) => ({
              developerName: type.developerName,
              recordTypeId: type.id,
              available: type.available ?? true,
              name: type.name ?? type.developerName,
              active: true,
              master: false,
              defaultRecordTypeMapping: type.defaultRecordTypeMapping ?? false,
            })),
          }
        : {}),
    };
  }

  /** How the Frozen loader, and a replay, read the org. */
  access(): TargetOrgAccess {
    const all = async (soql: string): Promise<MemoryRow[]> => {
      this.asked.push(soql);
      let page = await this.org.query(soql);
      const rows = [...page.records];
      while (!page.done && page.nextRecordsUrl !== undefined) {
        page = await this.org.queryMore(page.nextRecordsUrl);
        rows.push(...page.records);
      }
      return rows;
    };
    return {
      query: (_orgId, soql) => all(soql),
      count: async (_orgId, soql) => {
        this.asked.push(soql);
        return (await this.org.query(soql)).totalSize;
      },
      describe: async (_orgId, objectApiName) => {
        this.described.push(objectApiName);
        return this.describeOf(objectApiName);
      },
      picklistValues: async () => [],
      userId: async () => this.runningUserId,
    };
  }

  /** How the Frozen loader writes to the org: one answer per record, as a REST collection. */
  writer(): FrozenDmlWriter {
    const outcomes = (answers: unknown): OperationOutcome[] =>
      (answers as Array<{ id?: string; success: boolean; errors: unknown[] }>).map((answer) => ({
        ...(answer.id !== undefined ? { id: answer.id } : {}),
        success: answer.success,
        errors: answer.errors.map((error) => {
          const told = error as { statusCode?: string; message?: string };
          return `${told.statusCode ?? 'UNKNOWN'}: ${told.message ?? ''}`;
        }),
      }));
    return {
      insert: async (_orgId, objectApiName, records, onAnswered) => {
        const answered = outcomes(await this.org.create(objectApiName, records));
        if (this.directRelations && objectApiName === 'Contact') {
          answered.forEach((outcome, index) => {
            const account = records[index]?.AccountId;
            if (!outcome.success || outcome.id === undefined || typeof account !== 'string') return;
            this.org.add('AccountContactRelation', {
              // Numbered apart from the checkpoint's own relations, which the
              // org holds under no such id.
              Id: idOf('07k', 900_000_000 + ++this.relationsMade),
              AccountId: account,
              ContactId: outcome.id,
              IsDirect: true,
              CreatedById: MEMORY_ORG_USER,
              LastModifiedById: MEMORY_ORG_USER,
            });
          });
        }
        onAnswered?.(0, answered);
        return answered;
      },
      update: async (_orgId, objectApiName, records) =>
        outcomes(await this.org.update(objectApiName, records)),
      delete: async (_orgId, objectApiName, ids) =>
        outcomes(await this.org.destroy(objectApiName, ids)),
    };
  }

  /** What the org refuses an insert for, as listed in the module's comment. */
  private refusal(
    objectApiName: string,
    record: Readonly<Record<string, unknown>>,
  ): { statusCode: string; message: string; fields?: string[] } | undefined {
    if (this.notCreateable.has(objectApiName) || this.fields[objectApiName] === undefined) {
      return {
        statusCode: 'INVALID_TYPE_FOR_OPERATION',
        message: `entity type cannot be inserted: ${objectApiName}`,
      };
    }
    const owner = record.OwnerId;
    if (typeof owner === 'string') {
      const user = this.org.all('User').find((row) => row.Id.slice(0, 15) === owner.slice(0, 15));
      const queue = this.org.all('Group').find((row) => row.Id.slice(0, 15) === owner.slice(0, 15));
      if (user === undefined && queue === undefined) {
        return {
          statusCode: 'INVALID_CROSS_REFERENCE_KEY',
          message: 'invalid cross reference id',
          fields: ['OwnerId'],
        };
      }
      if (user !== undefined && user.IsActive !== true) {
        return {
          statusCode: 'INACTIVE_OWNER_OR_USER',
          message: `operation performed with inactive user [${owner}] as owner of ${objectApiName}`,
        };
      }
    }
    const type = record.RecordTypeId;
    if (typeof type === 'string') {
      const given = (this.recordTypeInfos.get(objectApiName) ?? []).find(
        (each) => each.id.slice(0, 15) === type.slice(0, 15),
      );
      if (given === undefined || given.available === false) {
        return {
          statusCode: 'INVALID_CROSS_REFERENCE_KEY',
          message: `Record Type ID: this ID value isn't valid for the user: ${type}`,
          fields: ['RecordTypeId'],
        };
      }
    }
    const currency = record.CurrencyIsoCode;
    if (typeof currency === 'string' && !(this.currencies ?? []).includes(currency)) {
      return {
        statusCode: 'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST',
        message: `Currency ISO Code: invalid currency code: ${currency}`,
        fields: ['CurrencyIsoCode'],
      };
    }
    const setupOwner = record.SetupOwnerId;
    if (typeof setupOwner === 'string') {
      const taken = this.org
        .all(objectApiName)
        .find((row) => String(row.SetupOwnerId).slice(0, 15) === setupOwner.slice(0, 15));
      if (taken !== undefined) {
        return {
          statusCode: 'DUPLICATE_VALUE',
          message: `duplicate value found: SetupOwnerId duplicates value on record with id: ${taken.Id}`,
          fields: ['SetupOwnerId'],
        };
      }
    }
    if (objectApiName === 'Account' && record.LastName === undefined && record.Name === undefined) {
      return {
        statusCode: 'REQUIRED_FIELD_MISSING',
        message: 'Required fields are missing: [Name]',
        fields: ['Name'],
      };
    }
    for (const [field, value] of Object.entries(record)) {
      const described = this.fields[objectApiName]?.find((each) => each.name === field);
      if (described?.type !== 'reference' || field === 'OwnerId' || field === 'RecordTypeId')
        continue;
      if (typeof value !== 'string' || field === 'SetupOwnerId') continue;
      if (value.slice(0, 15) === this.organizationId.slice(0, 15)) continue;
      const held = (described.referenceTo ?? []).some((to) =>
        this.org.all(to).some((row) => row.Id.slice(0, 15) === value.slice(0, 15)),
      );
      if (!held) {
        return {
          statusCode: 'INVALID_CROSS_REFERENCE_KEY',
          message: 'invalid cross reference id',
          fields: [field],
        };
      }
    }
    return undefined;
  }
}
