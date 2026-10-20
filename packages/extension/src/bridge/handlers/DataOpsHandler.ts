import { randomBytes } from 'node:crypto';

import type {
  AnonymizationRuleConfig,
  AnonymizationTemplateRule,
  AnonymizeCoverageObject,
  AnonymizePreviewObject,
  AnonymizePreviewValue,
  AuditObjectCounts,
  AuditOutcome,
  BackupExportObject,
  BackupObjectHeld,
  BackupSummary,
  DataOpsAnonymizationRule,
  ListedAnonymizationTemplate,
} from '@sandforge/shared';
import { recordWriteHeaders, sanitizeSoqlObjectName, guardTierOf } from '@sandforge/shared';
import type {
  HandlerDeps,
  DomainHandler,
  InboundRequest,
  OperationFailureContext,
} from './HandlerTypes.js';
import {
  buildResponse,
  sendNotification,
  sendOperationStarted,
  sendOperationProgress,
  sendOperationCompleted,
  sendOperationFailed,
  sendHandlerError,
  PRODUCTION_GUARD_MISSING,
  GUARD_REFUSAL,
  guardBlockedError,
  guardRefusalCode,
} from './HandlerTypes.js';
import type { Connection, QueryOptions, QueryResult } from 'jsforce';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { assertSoqlWhere, sanitizeSoqlValue } from '../../core/common/soqlValidator.js';
import { ANONYMIZATION_TEMPLATES } from '../templates/anonymizationTemplates.js';
import { RUN_CANCELLED } from '../../modules/forge/forgeAudit.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { queryAll, queryAllBounded } from '../../core/common/soqlQueryHelper.js';
import type { BoundedRecords } from '../../core/common/soqlQueryHelper.js';
import { CrudFlsGuard } from '../../core/metadata/CrudFlsGuard.js';
import type { ObjectDescribe } from '../../core/metadata/describeTypes.js';
import { DmlOperationTracker } from '../../core/common/DmlOperationTracker.js';
import {
  validatePayload,
  dataOpsBackupPayloadSchema,
  dataOpsBackupListPayloadSchema,
  dataOpsBackupObjectsPayloadSchema,
  dataOpsBackupExportPayloadSchema,
  dataOpsRollbackPayloadSchema,
  dataOpsAnonymizePayloadSchema,
  dataOpsAnonymizeCoveragePayloadSchema,
  dataOpsAnonymizePreviewPayloadSchema,
  dataOpsQualityScanPayloadSchema,
  anonymizationTemplateSavePayloadSchema,
  anonymizationTemplateDeletePayloadSchema,
  piiScanPayloadSchema,
} from '../validatePayload.js';
import { checkApiLimits } from '../../core/common/sforceLimitParser.js';
import type { SforceLimitInfo } from '../../core/common/sforceLimitParser.js';
import { resolveOrgTier, getQueryLimits } from '../../core/common/queryLimits.js';
import type { BackupRecord, BackupRecordStore } from '../../modules/dataops/BackupRecordStore.js';
import type { AnonymizationEngine } from '../../modules/dataops/AnonymizationEngine.js';
import { scanDataQuality } from '../../modules/dataops/DataQualityScanner.js';
import { rowsToRestore } from '../../modules/dataops/restoreDiff.js';
import { AnonymizationTemplateStore } from '../../modules/dataops/AnonymizationTemplateStore.js';
import { StepCancelledError } from '../../modules/automation/StepExecutor.js';
import { isFilledValue } from '../../modules/dataops/personalDataFields.js';
import {
  PERSON_ACCOUNT_FLAG,
  personAccountMasking,
  personAccountRules,
  rulesOfRow,
  type MaskableField,
} from '../../modules/dataops/personAccountMasking.js';
import {
  ACCOUNT,
  accountKindOf,
  leftOutForAccountKind,
} from '../../core/common/platformRecords.js';
import { PIIDetector } from '../../core/precheck/PIIDetector.js';
import { consultProductionGuard } from '../../core/precheck/consultProductionGuard.js';
import type { SafetyTier } from '../../core/precheck/ProductionGuard.js';
import { emptyCounts, recordWriteRun } from '../../modules/audit/auditTrail.js';
import type { WriteRun } from '../../modules/audit/auditTrail.js';
import {
  MAX_CHECKPOINT_REFUSED,
  MaskingCheckpointStore,
  maskingFingerprint,
  refusedCount,
  sentValuesDigest,
} from '../../modules/dataops/MaskingCheckpointStore.js';
import type {
  MaskingCheckpoint,
  MaskingProgress,
  UnconfirmedRow,
} from '../../modules/dataops/MaskingCheckpointStore.js';
import { whatTheWriteLeft } from '../../core/common/thrownWrite.js';
import { SaveDialogAdapter } from '../../adapters/fs/SaveDialogAdapter.js';

/**
 * Convert a jsforce DescribeSObjectResult to the ObjectDescribe shape
 * expected by CrudFlsGuard.
 */
function describeToObjectDescribe(desc: Record<string, unknown>): ObjectDescribe {
  const fields = desc.fields as Array<Record<string, unknown>>;
  return {
    name: desc.name as string,
    label: desc.label as string,
    labelPlural: (desc.labelPlural as string) ?? '',
    keyPrefix: (desc.keyPrefix as string | null) ?? null,
    custom: (desc.custom as boolean) ?? false,
    createable: desc.createable as boolean,
    updateable: desc.updateable as boolean,
    deletable: desc.deletable as boolean,
    queryable: desc.queryable as boolean,
    fields: fields.map((f) => ({
      name: f.name as string,
      label: f.label as string,
      type: f.type as string,
      length: (f.length as number) ?? 0,
      nillable: (f.nillable as boolean) ?? false,
      createable: f.createable as boolean,
      updateable: f.updateable as boolean,
      externalId: (f.externalId as boolean) ?? false,
      referenceTo: (f.referenceTo as string[]) ?? [],
      relationshipName: (f.relationshipName as string | null) ?? null,
      picklistValues:
        (f.picklistValues as Array<{
          value: string;
          label: string;
          active: boolean;
          defaultValue: boolean;
        }>) ?? [],
      defaultValue: f.defaultValue ?? null,
      calculated: (f.calculated as boolean) ?? false,
      autoNumber: (f.autoNumber as boolean) ?? false,
      unique: (f.unique as boolean) ?? false,
      permissionable: (f.permissionable as boolean) ?? true,
    })),
    recordTypeInfos:
      (desc.recordTypeInfos as Array<{
        recordTypeId: string;
        name: string;
        developerName: string;
        active: boolean;
        defaultRecordTypeMapping: boolean;
      }>) ?? [],
    childRelationships:
      (desc.childRelationships as Array<{
        childSObject: string;
        field: string;
        relationshipName: string | null;
        cascadeDelete: boolean;
      }>) ?? [],
  };
}

/** Message types handled by DataOpsHandler. */
const DATAOPS_TYPES = new Set([
  'backup:execute',
  'backup:list',
  'backup:objects',
  'backup:export',
  'dataops:rollback',
  'dataops:anonymize',
  'dataops:anonymization-templates',
  'dataops:quality-scan',
  'dataops:anonymization-template:save',
  'dataops:anonymization-template:delete',
  'dataops:anonymize:coverage',
  'dataops:anonymize:preview',
  'precheck:pii-scan',
]);

/** How many rejected rows are echoed back: an org repeats a handful of reasons. */
const DML_ERROR_SAMPLE_LIMIT = 10;

/** A Salesforce org id, in its 15- or 18-character form. */
const ORG_ID_PATTERN = /^00D[0-9A-Za-z]{12}(?:[0-9A-Za-z]{3})?$/;

/**
 * Whether two org ids name the same org: their first 15 characters, case
 * included. `Organization.Id` answers with 18, and the last three only
 * encode the case of the first fifteen.
 */
function sameOrg(a: string, b: string): boolean {
  return a.slice(0, 15) === b.slice(0, 15);
}

/** The code of a restore refused because the org is no longer the one the backup was taken from. */
const ORG_REPLACED_SINCE_BACKUP = 'ORG_REPLACED_SINCE_BACKUP';

/** Why a snapshot a cancel stopped was not taken. */
const BACKUP_CANCELLED =
  'Backup was cancelled before it finished. Nothing was saved — run it again to take a complete snapshot.';

/**
 * What a snapshot throws where it stops at a cancel, told apart from the
 * errors it can fail on while one is pending.
 */
class BackupCancelledError extends Error {
  constructor() {
    super(BACKUP_CANCELLED);
    this.name = 'BackupCancelledError';
  }
}

/**
 * What a snapshot throws where it could not write a page to disk. The file
 * may hold part of that page, so nothing of the snapshot is kept: a restore
 * must not read it as what the org held.
 */
class BackupWriteError extends Error {
  constructor(cause: unknown) {
    super(`The backup could not be written to disk: ${extractErrorMessage(cause)}`);
    this.name = 'BackupWriteError';
  }
}

/** Rows of each object a backup reads when `sandforge.backup.maxRecordsPerObject` says nothing. */
const BACKUP_CAP_DEFAULT = 50_000;

/** The fewest rows of an object the setting may set a backup to read: what its manifest allows. */
const BACKUP_CAP_MIN = 100;

/** The most rows of an object the setting may set a backup to read: what its manifest allows. */
const BACKUP_CAP_MAX = 1_000_000;

/** Rows a restore reads of a backup, and upserts, at a time: the most one REST collection takes. */
const RESTORE_BATCH_SIZE = 200;

/**
 * How long the newest file of a backup with no metadata must have gone
 * unwritten before its files are removed (`BackupRecordStore.sweep`). A
 * backup under way in another window writes a page every few seconds, and
 * the metadata it saves when it ends reaches this window through the state
 * the windows share, after its files: a day leaves both far behind, and a
 * crashed backup's pages go the next day.
 */
const ORPHAN_BACKUP_AGE_MS = 24 * 60 * 60_000;

/** One object of a snapshot as it is read: the rows written so far, and why it stopped short. */
type BackupObjectRead = BackupObjectHeld & { truncated: boolean };

/**
 * Where a snapshot's records go, a page at a time, as the org answers them:
 * the backup files, or, in a host that gave the handler none, the config store.
 */
interface BackupWriter {
  /** Start an object: its file is there, empty, from now on. */
  begin(objectApiName: string): Promise<void>;
  /** Add a page of an object's records. */
  append(objectApiName: string, records: readonly BackupRecord[]): Promise<void>;
  /** Once the snapshot's metadata is written: keep what is still held only in memory. */
  keep(): void;
  /** Remove every object begun: the snapshot is not kept. */
  discard(): Promise<void>;
}

/**
 * The three words Seed, Sync and Clone already use for a write that did not
 * fully land. Reused here rather than invented: a restore or a masking run
 * that only partly succeeded is the same event those modules name `partial`.
 */
function dmlStatus(succeeded: number, failed: number): 'success' | 'partial' | 'failure' {
  if (failed === 0) return 'success';
  if (succeeded === 0) return 'failure';
  return 'partial';
}

/**
 * The tier Production Guard takes the org of a restore or a masking run for:
 * the tier of its type, but a Developer Edition org, which says `IsSandbox`
 * false and was registered as a production org by earlier builds, taken for
 * the development org it is — as every guard takes it (`guardTierOf`). Read
 * from its type alone, DataOps asked before every
 * write to such an org as before one to production, and a command line, with
 * nobody to ask, could tell it from production by nothing. An org whose
 * edition is not known stays production.
 */
function writeTier(
  org: { orgType?: string; metadata?: { edition?: unknown } } | undefined,
): SafetyTier {
  return guardTierOf(org);
}

/** Append a bounded sample of what the org said about a rejected row. */
function collectDmlError(
  sink: Array<{ objectApiName: string; message: string }>,
  objectApiName: string,
  errors: Array<{ message: string }> | undefined,
): void {
  if (sink.length >= DML_ERROR_SAMPLE_LIMIT) return;
  sink.push({ objectApiName, message: errors?.[0]?.message ?? 'Unknown DML error' });
}

/**
 * Objects a masking run addresses: the ones the request names, otherwise
 * the ones the template's rules address — and Account, in an org with person
 * accounts, when the template masks on a contact what a person account holds
 * as its own (`personAccountRules`). Planned from the rules alone, a run of
 * the CCPA template, whose rules name Contact and Lead, masked every contact
 * of such an org and left each person account's name, email, phone, address
 * and birthdate in clear. Empty for an unknown template — such a request
 * stops at the template lookup, before any write.
 *
 * @param personAccounts - Whether the org has person accounts
 *   (`orgHasPersonAccounts`); read only for a request that names no object.
 */
function plannedAnonymizeObjects(
  payload: { objects?: string[] },
  template: ListedAnonymizationTemplate | undefined,
  personAccounts = false,
): string[] {
  if (payload.objects) return payload.objects;
  if (!template) return [];
  const objects = template.rules
    .map((r) => r.fieldPattern.split('.')[0])
    .filter((v, i, a) => a.indexOf(v) === i);
  if (personAccounts && personRowsOnly(payload, template, ACCOUNT)) objects.push(ACCOUNT);
  return objects;
}

/** The filter that holds the rows of Account to its person accounts. */
const PERSON_ROWS = `${PERSON_ACCOUNT_FLAG} = true`;

/**
 * Whether a run masks an object's person accounts and nothing else: Account,
 * planned for them alone — the request names no object and the template no
 * rule of its own on Account, but derives rules for its person accounts. Its
 * business accounts hold none of what those rules mask, and are neither
 * counted, read, nor kept in the snapshot.
 */
function personRowsOnly(
  payload: { objects?: string[] },
  template: ListedAnonymizationTemplate,
  objectName: string,
): boolean {
  return (
    payload.objects === undefined &&
    objectName.toLowerCase() === ACCOUNT.toLowerCase() &&
    rulesOfObject(template, ACCOUNT).length === 0 &&
    personAccountRules(template.rules).length > 0
  );
}

/**
 * The rows of one object a masking run holds to: the request's filter, which
 * goes with one object alone; the person accounts, for Account planned for
 * them (`personRowsOnly`); every row otherwise.
 */
function whereOfObject(
  payload: { objects?: string[]; where?: string },
  template: ListedAnonymizationTemplate,
  objectName: string,
): string | undefined {
  if (personRowsOnly(payload, template, objectName)) return PERSON_ROWS;
  return filterOf(payload);
}

/**
 * Whether an org has person accounts: its Account has `IsPersonAccount`. A
 * describe the org refuses is taken for none, as before this was asked, and
 * logged.
 */
async function orgHasPersonAccounts(
  conn: { describe: (objectApiName: string) => Promise<{ fields: MaskableField[] }> },
  log: (line: string) => void,
): Promise<boolean> {
  try {
    return (await conn.describe(ACCOUNT)).fields.some((f) => f.name === PERSON_ACCOUNT_FLAG);
  } catch (err: unknown) {
    log(
      `[WARN] dataops: whether the org has person accounts was not read: ${extractErrorMessage(err)}`,
    );
    return false;
  }
}

/** The rules of a template a masking run applies to one object: those naming it, and a wildcard. */
function rulesOfObject(
  template: ListedAnonymizationTemplate,
  objectName: string,
): AnonymizationTemplateRule[] {
  return template.rules.filter(
    (r) => r.fieldPattern.startsWith(`${objectName}.`) || (r.fieldPattern as string) === '*',
  );
}

/**
 * The rules a template derives for the person accounts of one object: its
 * Contact rules on the fields of Account a person account holds them in
 * (`personAccountRules`); none for any other object. They mask only where the
 * org has person accounts, on those only.
 */
function personRulesOfObject(
  template: ListedAnonymizationTemplate,
  objectName: string,
): AnonymizationTemplateRule[] {
  return objectName.toLowerCase() === ACCOUNT.toLowerCase()
    ? personAccountRules(template.rules)
    : [];
}

/** Whether a template has anything to mask on an object: a rule of its own, or one for person accounts. */
function masksObject(template: ListedAnonymizationTemplate, objectName: string): boolean {
  return (
    rulesOfObject(template, objectName).length > 0 ||
    personRulesOfObject(template, objectName).length > 0
  );
}

/** A backup kept on this machine, as its metadata records it. */
interface KeptBackup {
  operationId: string;
  timestamp: string;
  /** Per object, the rows it holds, and whether, and why, it stopped with the object holding more. */
  objects: BackupObjectHeld[];
}

/** A backup's metadata, as `takeBackup` writes it into the config store, older ones included. */
interface BackupMeta {
  operationId?: string;
  orgId?: string;
  /** Absent from backups taken before it was recorded. */
  organizationId?: string;
  objects?: BackupObjectHeld[];
  /** True when any object stopped with the object holding more, or was never read. */
  partial?: boolean;
  /** `failed` when the read failed part-way and the backup keeps the rows read before; absent otherwise. */
  status?: 'failed';
  /** The cap of rows per object the backup read with; absent from backups taken before it. */
  cap?: number;
  timestamp?: string;
  totalRecords?: number;
}

/**
 * One object of a backup as its answer, its metadata and the listing all say
 * it: whether it holds fewer rows than the object had, always said — `false`
 * for an object read whole — and why, only when it does.
 *
 * Read with a tool that names every key it is asked for, the answer of a
 * backup of a large sandbox said `truncated: null` and `stoppedAt: null` for
 * an object read whole: the answer left `truncated` out where the metadata
 * said `false`, and a backup kept before the flag was recorded lists none.
 */
function heldOf(o: BackupObjectHeld): BackupObjectHeld & { truncated: boolean } {
  return {
    objectApiName: o.objectApiName,
    recordCount: o.recordCount,
    truncated: o.truncated === true,
    ...(o.orgCount !== undefined ? { orgCount: o.orgCount } : {}),
    ...(o.stoppedAt ? { stoppedAt: o.stoppedAt } : {}),
  };
}

/**
 * Per object, what a backup holds short of what the org held, as a restore's
 * result says it: `Contact 5000 of 12345 (stopped at the cap)`. Empty for a
 * backup that holds every row of every object.
 *
 * @param objects - The backup's objects, as its metadata records them.
 * @param read - Per object, the rows a restore read of it; fewer than the
 *   metadata records is said too, whatever the reason.
 */
function backupShortfall(
  objects: readonly BackupObjectHeld[],
  read?: ReadonlyMap<string, number>,
): string {
  return objects
    .flatMap((o) => {
      const rows = read?.get(o.objectApiName);
      if (rows !== undefined && rows < o.recordCount) {
        return [`${o.objectApiName} ${rows} of the ${o.recordCount} it listed (not found on disk)`];
      }
      if (!o.truncated) return [];
      if (o.stoppedAt === 'not_reached') {
        return [`${o.objectApiName} none (the backup stopped before it)`];
      }
      const held = o.orgCount !== undefined ? ` of ${o.orgCount}` : '';
      const why =
        o.stoppedAt === 'cap'
          ? ' (stopped at the cap)'
          : o.stoppedAt === 'failure'
            ? ' (the read failed)'
            : '';
      return [`${o.objectApiName} ${o.recordCount}${held}${why}`];
    })
    .join(', ');
}

/** Rows a masking run writes back per update call: the most one REST collection takes. */
const MASKING_BATCH_SIZE = 200;

/**
 * The share of the org's daily API requests past which a masking run makes no
 * further call: the line `checkApiLimits` logs as critical. A run writes back
 * every row of every object, two hundred a call, so an object of a few hundred
 * thousand rows takes thousands of calls. Left to run on, it would use the last
 * of the org's allowance, and every integration of the org would be refused
 * with it until the requests of the last 24 hours age out.
 */
const MASKING_API_STOP_PERCENT = 95;

/** A record id, as the last row of a page hands it on: 15 or 18 letters and digits. */
const RECORD_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

/** What a masking run did to one object, counted against the rows it held. */
interface MaskingTally {
  objectApiName: string;
  /** Rows the object held when the run counted them, before it wrote anything. */
  total: number;
  /** Rows written back masked. */
  masked: number;
  /** Rows read none of whose masked fields held anything: done, with nothing to write. */
  nothingToMask: number;
  /** Rows the org refused to update: they keep their original values. */
  refused: number;
  /**
   * Rows of the update the run ended on, whose answer never came back: the
   * org may hold them masked, or as they were.
   */
  unanswered: number;
  /** Whether the run read the object to its last row. */
  done: boolean;
}

/** One object of a masking run: its rules, its counts, and how far the run got through it. */
interface MaskingWork {
  objectName: string;
  /** The rows of the object the run holds to (`whereOfObject`); every row when absent. */
  where?: string;
  objectRules: AnonymizationTemplateRule[];
  /** The rules the template derives for the object's person accounts (`personRulesOfObject`). */
  personRules: AnonymizationTemplateRule[];
  tally: MaskingTally;
  /** What a checkpoint keeps of the object, should the run stop short. */
  progress: MaskingProgress;
}

/** The code of a resume refused because the checkpoint it names is not the one kept. */
const NOTHING_TO_RESUME = 'NOTHING_TO_RESUME';

/** The code of a request naming a template neither shipped nor saved. */
const TEMPLATE_NOT_FOUND = 'TEMPLATE_NOT_FOUND';

/**
 * A row of an update whose answer never came back, as a checkpoint keeps it:
 * its id, the fields the update sent and a digest of what it sent for them —
 * masked values, never the originals. Nothing for a row without a usable id.
 */
function unconfirmedRowOf(row: Readonly<Record<string, unknown>>): UnconfirmedRow[] {
  const id = row['Id'];
  if (typeof id !== 'string' || !RECORD_ID.test(id)) return [];
  const fields = Object.keys(row).filter((field) => field !== 'Id');
  return fields.length > 0 ? [{ id, fields, digest: sentValuesDigest(row, fields) }] : [];
}

/** The code a masking run is recorded with when the org would not count an object's rows. */
const COUNT_FAILED = 'COUNT_FAILED';

/**
 * The code a masking run is stopped with, before its first write, when the
 * snapshot it asked for was not taken, or holds only part of its rows.
 */
const SNAPSHOT_NOT_TAKEN = 'SNAPSHOT_NOT_TAKEN';

/** An API or system error code, as an org's error message starts with one. */
const LEADING_CODE = /^([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+):/;

/**
 * Why the org refused a call, as a code and never as its message: the
 * Salesforce code jsforce puts on `errorCode` (`INVALID_TYPE`,
 * `REQUEST_LIMIT_EXCEEDED`), the system's for a connection that broke
 * (`ECONNRESET`), or the code a message starts with. The audit trail keeps no
 * message: a Salesforce error can quote the value it refused.
 */
function orgReasonCode(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const { errorCode, code } = err as { errorCode?: unknown; code?: unknown };
    if (typeof errorCode === 'string' && errorCode !== '') return errorCode;
    if (typeof code === 'string' && code !== '') return code;
  }
  return LEADING_CODE.exec(extractErrorMessage(err))?.[1] ?? 'UNKNOWN';
}

/** Rows of each object a preview reads: the first ones a masking run masks. */
const PREVIEW_ROWS = 5;

/**
 * A value read from the org as a preview hands it to the page: text, a number
 * or a flag as it is, nothing as null, anything else — a compound address —
 * as its JSON.
 */
function previewValue(value: unknown): AnonymizePreviewValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return JSON.stringify(value);
}

/**
 * Rows of an object the run never reached, counted from the rows it held: none
 * once the run read the object to its end, whatever was deleted meanwhile.
 */
function notReached(tally: MaskingTally): number {
  if (tally.done) return 0;
  return Math.max(
    0,
    tally.total - tally.masked - tally.nothingToMask - tally.refused - tally.unanswered,
  );
}

/**
 * Rows of an object that may still hold their original values: refused,
 * never reached, or sent in a call whose answer never came back.
 */
function notMasked(tally: MaskingTally): number {
  return tally.refused + tally.unanswered + notReached(tally);
}

/** A masking run's counts over every object, as its result carries them. */
function maskingTotals(tallies: readonly MaskingTally[]): {
  recordsProcessed: number;
  recordsFailed: number;
  recordsNotMasked: number;
} {
  return tallies.reduce(
    (sum, t) => ({
      recordsProcessed: sum.recordsProcessed + t.masked + t.nothingToMask,
      recordsFailed: sum.recordsFailed + t.refused,
      recordsNotMasked: sum.recordsNotMasked + notMasked(t),
    }),
    { recordsProcessed: 0, recordsFailed: 0, recordsNotMasked: 0 },
  );
}

/**
 * What a masking run comes to: success only when every row it counted was
 * masked or held nothing to mask, failure when none was, partial otherwise. A
 * cancel that came before anything was written is still partial, as it always
 * was: the run was stopped, not refused.
 */
function maskingStatus(
  tallies: readonly MaskingTally[],
  cancelled: boolean,
): 'success' | 'partial' | 'failure' {
  const { recordsProcessed, recordsFailed, recordsNotMasked } = maskingTotals(tallies);
  if (recordsNotMasked === 0) return 'success';
  if (recordsProcessed > 0) return 'partial';
  return cancelled && recordsFailed === 0 ? 'partial' : 'failure';
}

/**
 * How the audit trail records a masking run: as it came to, unless the user
 * stopped it short of a row — cancelled once it masked a row or had one
 * refused, its counts saying which; stopped, under the code of a run
 * cancelled before it wrote, when it had done neither. A run the user stopped
 * was recorded as partial whether or not it had masked anything, as a run the
 * org refused part of is. One that stopped at the org's API limit keeps its
 * status: the limit stopped it, not the user.
 */
function maskingAuditOutcome(
  tallies: readonly MaskingTally[],
  status: 'success' | 'partial' | 'failure',
  cancelled: boolean,
): { outcome: AuditOutcome; code?: string } {
  if (!cancelled || status === 'success') return { outcome: status };
  const { recordsProcessed, recordsFailed } = maskingTotals(tallies);
  return recordsProcessed + recordsFailed > 0
    ? { outcome: 'cancelled' }
    : { outcome: 'stopped', code: RUN_CANCELLED };
}

/** Per object, the rows a run left holding their original values: `Contact 500, Lead 450`. */
function leftByObject(tallies: readonly MaskingTally[]): string {
  return tallies
    .filter((t) => notMasked(t) > 0)
    .map((t) => `${t.objectApiName} ${notMasked(t)}`)
    .join(', ');
}

/**
 * Per object, what the result of a masking run says: the rows counted, the
 * rows done with — masked, or holding nothing to mask — the rows the org
 * refused, and the rows still holding their original values.
 */
function maskingResultObjects(tallies: readonly MaskingTally[]): Array<{
  objectApiName: string;
  total: number;
  processed: number;
  failed: number;
  notMasked: number;
}> {
  return tallies.map((t) => ({
    objectApiName: t.objectApiName,
    total: t.total,
    processed: t.masked + t.nothingToMask,
    failed: t.refused,
    notMasked: notMasked(t),
  }));
}

/**
 * Per object, what the audit trail keeps of a masking run: the rows masked as
 * updated, the rows the org refused as failed, and the rows the run never
 * reached — a cancel, the API limit or the failure it ended on kept them from
 * the org — as not sent. An object with no row to mask is left out.
 */
function maskingAuditCounts(tallies: readonly MaskingTally[]): AuditObjectCounts[] {
  return tallies
    .filter((t) => t.total > 0 || t.masked + t.refused > 0)
    .map((t) => {
      const left = notReached(t);
      return {
        ...emptyCounts(t.objectApiName),
        updated: t.masked,
        // A call with no answer is counted failed, and apart: it may have
        // masked any of its rows.
        failed: t.refused + t.unanswered,
        ...(t.unanswered > 0 ? { mayHaveBeenWritten: t.unanswered } : {}),
        ...(left > 0 ? { notSent: left } : {}),
      };
    });
}

/**
 * One page of the rows a masking run reads: the first `pageSize` by Id after
 * `afterId`, or from the first.
 *
 * By Id rather than down one cursor followed with `queryMore`: each page is a
 * statement of its own, so no query locator stays open on the org while the
 * page before is masked and written back — an org keeps a few per user and
 * drops the oldest, and one left idle expires — and each page starts after the
 * last row of the one before, whatever was written in between.
 * `queryAllBounded`, which the backup reads with, reads the page whole,
 * following the batches the org splits a wide one into, and says when it came
 * back full: only then can more rows follow.
 *
 * @param afterId - The last row of the page before, as {@link pageEnd} checked
 *   it: letters and digits only, so it goes into the statement as it is.
 * @param where - The run's filter, as the payload schema let it through.
 */
async function maskingPage(
  conn: Connection,
  objectApiName: string,
  fields: string,
  pageSize: number,
  afterId: string | undefined,
  where?: string,
): Promise<BoundedRecords<Record<string, unknown>>> {
  return queryAllBounded<Record<string, unknown>>(
    conn,
    `SELECT ${fields} FROM ${objectApiName}${rowsOfTheRun(where, afterId)} ORDER BY Id LIMIT ${pageSize}`,
    pageSize,
  );
}

/**
 * The WHERE of a masking run's statements: its filter, and past the row it
 * reached. The filter goes in parentheses, so an `OR` in it does not reach
 * past the row the run reached; it is checked again here, as every builder of
 * a filter checks it, for one that leaves a parenthesis open or goes on past
 * the condition.
 *
 * @param where - The run's filter; absent or blank for every row.
 * @param afterId - The last row handled, letters and digits only.
 * @throws When the filter does more than filter.
 */
function rowsOfTheRun(where: string | undefined, afterId: string | undefined): string {
  const filter = where?.trim();
  const conditions = [
    ...(filter ? [`(${assertSoqlWhere(filter)})`] : []),
    ...(afterId === undefined ? [] : [`Id > '${afterId}'`]),
  ];
  return conditions.length === 0 ? '' : ` WHERE ${conditions.join(' AND ')}`;
}

/** A run's filter as it was given, or undefined for none: a blank one filters nothing. */
function filterOf(payload: { where?: string }): string | undefined {
  const where = payload.where?.trim();
  return where ? where : undefined;
}

/**
 * Where the next page of a masking run starts: after the last row of this one.
 *
 * @throws When that row carries no record id, or the one the page started
 *   after: the org did not move past it, and going on would write the same
 *   rows again and never reach the end.
 */
function pageEnd(
  records: ReadonlyArray<Record<string, unknown>>,
  afterId: string | undefined,
  objectApiName: string,
): string {
  const lastId = records[records.length - 1]?.Id;
  if (typeof lastId !== 'string' || !RECORD_ID.test(lastId) || lastId === afterId) {
    throw new Error(
      `The org answered a page of ${objectApiName} that does not end past the page before it: ` +
        'masking stopped there rather than write the same rows again.',
    );
  }
  return lastId;
}

/** A snapshot taken, as its metadata records it. */
export interface BackupTaken {
  operationId: string;
  /**
   * Each object read, with the rows taken, the rows the org held, and
   * whether, and why, the read stopped short.
   */
  objects: BackupObjectRead[];
  totalRecords: number;
  /** Whether any object stopped at the cap: the snapshot is only part of the org's data. */
  partial: boolean;
  timestamp: string;
}

/** A snapshot not taken: why, whether trying again may help, and what it was on. */
interface BackupNotTaken {
  error: unknown;
  retryable: boolean;
  context: OperationFailureContext;
  /** Whether a cancel stopped it, rather than a failure. */
  cancelled?: boolean;
}

/**
 * Domain handler for DataOps-related webview-to-extension messages.
 *
 * Manages backup, rollback, anonymization, anonymization templates,
 * data-quality scans and PII scanning operations.
 */
export class DataOpsHandler implements DomainHandler {
  /**
   * Set of orgId values currently involved in a rollback or backup operation.
   * Prevents concurrent operations from interleaving on the same org.
   */
  private readonly activeOrgOperations = new Set<string>();

  /** Tracks DML operations to prevent duplicate submissions. */
  private readonly dmlTracker = new DmlOperationTracker();

  /**
   * File-backed store for backup record payloads.
   *
   * Present once composition supplies a storage path. Absent in tests and in
   * any host without one, where the ConfigStore path below still works.
   */
  private backupRecords?: BackupRecordStore;

  /**
   * The snapshots this window is writing, whose files have no metadata until
   * they end: the sweep of files left without metadata never takes them.
   */
  private readonly backupsWriting = new Set<string>();

  /**
   * HMAC key the masking engine falls back to for rules that carry no salt,
   * and the salt every hash rule is given (see `ruleConfig`).
   *
   * Held here rather than left to the engine, which mints a random one per
   * instance: a fresh engine per request meant two masking runs of the same
   * template replaced the same record with two different people, so nothing
   * the user saw in one run told them anything about the next. This handler is
   * built once per activation and shared by every panel, so the key is one per
   * window, and staying out of storage keeps the permutation from being
   * replayable by anyone who reads the workspace.
   */
  private readonly maskingKey = randomBytes(32).toString('hex');

  /** Where an export of a backup is written: a file the user picks. */
  private readonly saveDialog: SaveDialogAdapter;

  /**
   * @param deps - Injected handler dependencies.
   * @param saveDialog - Injected for tests; defaults to the real VS Code dialog.
   */
  constructor(
    private readonly deps: HandlerDeps,
    saveDialog?: SaveDialogAdapter,
  ) {
    this.saveDialog = saveDialog ?? new SaveDialogAdapter();
  }

  /** The masking templates the user saved, kept in the config store. */
  private get savedTemplates(): AnonymizationTemplateStore {
    return new AnonymizationTemplateStore(this.deps.configStore);
  }

  /** A template that ships, or else one the user saved; undefined for an id neither holds. */
  private findTemplate(templateId: string): ListedAnonymizationTemplate | undefined {
    return (
      ANONYMIZATION_TEMPLATES.find((t) => t.id === templateId) ??
      this.savedTemplates.load(templateId)
    );
  }

  /**
   * What a template's rule hands the masking engine: the settings the
   * template gives it, and for a hash the window's key as its salt.
   *
   * Every rule used to go in with an empty configuration, so the CCPA and
   * HIPAA templates threw on their first email, which the engine will not hash
   * without a salt, and nothing was masked. No template carries a salt, and
   * none may: one written into a template is readable by everyone who has the
   * template. The window's key is the one the run's other keyed methods
   * already draw from, never written down, so an address gets the same digest
   * on every object of a run and on every run of the window, and another one
   * in the next window.
   */
  private ruleConfig(rule: AnonymizationTemplateRule): AnonymizationRuleConfig {
    const config: AnonymizationRuleConfig = { ...rule.config };
    if (rule.ruleType === 'hash') config.hashSalt = this.maskingKey;
    return config;
  }

  /**
   * The rules a masking run applies to one object of a template, as the
   * engine takes them: the field after the dot, the method, and the settings
   * `ruleConfig` gives it. A preview reads them from here too, so what it
   * shows is what the run writes.
   */
  private maskingRules(
    objectName: string,
    objectRules: readonly AnonymizationTemplateRule[],
  ): DataOpsAnonymizationRule[] {
    return objectRules.map((r) => ({
      objectApiName: objectName,
      fieldApiName: r.fieldPattern.includes('.') ? r.fieldPattern.split('.')[1] : r.fieldPattern,
      method: r.ruleType as
        | 'mask'
        | 'hash'
        | 'fake'
        | 'nullify'
        | 'shuffle'
        | 'truncate'
        | 'constant'
        | 'preserve_format',
      config: this.ruleConfig(r),
    }));
  }

  /**
   * Answer a request naming a template neither shipped nor saved, on the
   * error channel the page waits on. A masking run used to say so in a
   * notification alone, and the page's request waited out its hour.
   */
  private refuseUnknownTemplate(
    context:
      | 'dataops:anonymize'
      | 'dataops:anonymize:coverage'
      | 'dataops:anonymize:preview'
      | 'backup:objects',
    msg: InboundRequest,
    templateId: string,
  ): void {
    sendHandlerError(
      this.deps,
      context,
      'dataops:error',
      msg,
      new Error(`Template "${templateId}" not found.`),
      { code: TEMPLATE_NOT_FOUND },
    );
  }

  /**
   * Inject the file-backed record store so backups stop inflating globalState.
   * Called from composition, which owns the extension's storage path.
   */
  setBackupRecordStore(store: BackupRecordStore): void {
    this.backupRecords = store;
    // What a window that stopped in the middle of a backup left behind goes
    // when the next window starts.
    void this.sweepBackupFiles();
  }

  /**
   * Remove the files of backups whose metadata was never saved — a window
   * closed or crashed in the middle of one — once no window has written to
   * them for {@link ORPHAN_BACKUP_AGE_MS}. No listing shows them, no restore
   * reads them, and the retention, which goes by metadata, never removed them.
   *
   * Run when the store is given, as the extension starts, and after each
   * backup's retention. Housekeeping: a failure is logged, never reported.
   *
   * @param now - The time now, in milliseconds since the epoch.
   */
  async sweepBackupFiles(now: number = Date.now()): Promise<void> {
    const store = this.backupRecords;
    if (!store) return;
    try {
      const keep = new Set(this.backupsWriting);
      // Every backup a key names, its metadata or, for one kept in the config
      // store before the files, its records: `backup:<id>` or `backup:<id>:<object>`.
      for (const key of this.deps.configStore.getKeysByPrefix('backup:')) {
        keep.add(key.slice('backup:'.length).split(':')[0]);
      }
      const removed = await store.sweep(keep, ORPHAN_BACKUP_AGE_MS, now);
      if (removed.length > 0) {
        this.deps.log(
          `[INFO] Removed ${removed.length} backup file(s) whose backup never saved its metadata: ` +
            removed.join(', '),
        );
      }
    } catch (err: unknown) {
      this.deps.log(
        `[WARN] the files of backups that never saved their metadata were not removed: ` +
          extractErrorMessage(err),
      );
    }
  }

  /**
   * Handle an incoming bridge message.
   *
   * @param msg - The typed base message from the webview.
   * @returns `true` if the message was handled, `false` otherwise.
   */
  async handle(msg: InboundRequest): Promise<boolean> {
    if (!DATAOPS_TYPES.has(msg.type)) return false;

    switch (msg.type) {
      case 'backup:execute':
        await this.handleBackup(msg);
        return true;
      case 'backup:list':
        this.handleBackupList(msg);
        return true;
      case 'backup:objects':
        await this.handleBackupObjects(msg);
        return true;
      case 'backup:export':
        await this.handleBackupExport(msg);
        return true;
      case 'dataops:rollback':
        await this.handleRollback(msg);
        return true;
      case 'dataops:anonymize':
        await this.handleAnonymize(msg);
        return true;
      case 'dataops:anonymization-templates':
        this.handleAnonymizationTemplates(msg);
        return true;
      case 'dataops:quality-scan':
        await this.handleQualityScan(msg);
        return true;
      case 'dataops:anonymization-template:save':
        this.handleTemplateSave(msg);
        return true;
      case 'dataops:anonymization-template:delete':
        this.handleTemplateDelete(msg);
        return true;
      case 'dataops:anonymize:coverage':
        await this.handleAnonymizeCoverage(msg);
        return true;
      case 'dataops:anonymize:preview':
        await this.handleAnonymizePreview(msg);
        return true;
      case 'precheck:pii-scan':
        await this.handlePIIScan(msg);
        return true;
      default:
        return false;
    }
  }

  /**
   * Comma-separated list of every field of an object, ready to drop into a
   * SELECT clause.
   *
   * Salesforce caps `SELECT FIELDS(ALL)` at `LIMIT 200`, and these snapshots
   * asked for the org-tier limit (2000 on a sandbox): the org rejected the
   * query every single time, and the records only arrived because
   * `queryWithFieldsFallback` caught the rejection, described the object and
   * re-queried — three round trips per object to do the work of two. Resolving
   * the field list up front makes the query valid on the first attempt, with
   * no `LIMIT` at all: a snapshot now reads every page of the object, up to
   * its cap. It is the same list that fallback built, so the columns
   * collected do not change.
   *
   * @param conn - Connection used for the describe call.
   * @param objectApiName - Already-sanitized SObject API name.
   */
  private async selectAllFields(
    conn: { describe: (objectApiName: string) => Promise<{ fields: Array<{ name: string }> }> },
    objectApiName: string,
  ): Promise<string> {
    const desc = await conn.describe(objectApiName);
    return desc.fields.map((f) => f.name).join(', ');
  }

  /**
   * What a masking run reads of an object and masks in it: the rules whose
   * field the object has, under the name the describe gives it; the fields it
   * reads, the Id it writes each row back by and those; and the fields its
   * rules name that the object lacks.
   *
   * Every field used to be read, for the few the template names: a run now
   * reads every row, and the rest — long text, rich text, every column of every
   * page — would cross the wire for nothing. A field the object lacks is not
   * asked for, as reading every field never brought it, so its rule masks
   * nothing either way — and is named, which it was not: a run whose template
   * was written for another org's custom fields masked none of them and said
   * it had completed. A field is matched whatever its case, as Salesforce matches
   * it, and a rule written `Contact.email` masks the `Email` the rows carry.
   *
   * On the accounts of an org with person accounts, the person accounts' own
   * fields are masked too (`personAccountMasking`), and each row is read with
   * the flag that tells a person account's: the rules a row is masked by are
   * those its kind of account can hold (`rulesOf`). A rule derived for person
   * accounts whose field the org lacks is never said to be missing: the
   * template does not name it.
   *
   * @param conn - Connection used for the describe call.
   * @param objectApiName - Already-sanitized SObject API name.
   * @param rules - The template's rules for the object.
   * @param personRules - The rules the template derives for its person accounts.
   */
  private async maskedFields(
    conn: { describe: (objectApiName: string) => Promise<{ fields: MaskableField[] }> },
    objectApiName: string,
    rules: readonly DataOpsAnonymizationRule[],
    personRules: readonly DataOpsAnonymizationRule[] = [],
  ): Promise<{
    rules: DataOpsAnonymizationRule[];
    select: string;
    missing: string[];
    rulesOf: (row: Record<string, unknown>) => DataOpsAnonymizationRule[];
  }> {
    const fields = (await conn.describe(objectApiName)).fields;
    const described = new Map(fields.map((f) => [f.name.toLowerCase(), f.name]));
    const kept: DataOpsAnonymizationRule[] = [];
    const missing: string[] = [];
    for (const rule of rules) {
      const name = described.get(rule.fieldApiName.toLowerCase());
      if (name !== undefined) kept.push({ ...rule, fieldApiName: name });
      // A wildcard names no field: there is none to say is missing.
      else if (rule.fieldApiName !== '*' && !missing.includes(rule.fieldApiName)) {
        missing.push(rule.fieldApiName);
      }
    }
    const persons = personAccountMasking({
      objectApiName,
      fields,
      kept,
      derived: personRules,
      detector: this.deps.infraServices?.piiDetector ?? new PIIDetector(),
    });
    const all = persons ? [...kept, ...persons.rules] : kept;
    const masked = all
      .map((r) => r.fieldApiName)
      .filter((field, i, list) => field !== 'Id' && list.indexOf(field) === i);
    const flag = persons && masked.length > 0 && !masked.includes(PERSON_ACCOUNT_FLAG);
    return {
      rules: all,
      select: ['Id', ...masked, ...(flag ? [PERSON_ACCOUNT_FLAG] : [])].join(', '),
      missing,
      rulesOf: persons
        ? (row) => rulesOfRow(objectApiName, row, all, persons.personOnly)
        : () => all,
    };
  }

  /**
   * How many rows an object holds (`SELECT COUNT()`), which a masking run
   * counts before it writes anything: its progress counts against these, and
   * what a run that stops leaves is counted from them.
   *
   * @param afterId - Count only the rows past this one, in Id order: those a
   *   resume has left to read. Letters and digits only, as a checkpoint keeps it.
   * @param where - Count only the rows the run's filter holds it to.
   * @throws When the org answers the count with no number.
   */
  private async countRows(
    conn: Connection,
    objectApiName: string,
    afterId?: string,
    where?: string,
  ): Promise<number> {
    const answer = await conn.query(
      `SELECT COUNT() FROM ${objectApiName}${rowsOfTheRun(where, afterId)}`,
    );
    const total: unknown = answer.totalSize;
    if (typeof total !== 'number' || !Number.isInteger(total) || total < 0) {
      throw new Error(`The org did not say how many records ${objectApiName} holds.`);
    }
    return total;
  }

  /**
   * The id the org behind a connection answers with (`Organization.Id`), or
   * `undefined` when it does not say.
   *
   * A refreshed sandbox keeps its registered id and answers with a new one,
   * so this, not the registry, tells apart the org a backup was taken from
   * and the org a restore would write to. An org that cannot say is bound to
   * nothing, and no restore is held back on its account.
   */
  private async organizationIdOf(conn: Connection): Promise<string | undefined> {
    try {
      const records = await queryAll<{ Id?: unknown }>(conn, 'SELECT Id FROM Organization');
      const id = records[0]?.Id;
      return typeof id === 'string' && ORG_ID_PATTERN.test(id) ? id : undefined;
    } catch (err: unknown) {
      this.deps.log(
        `[WARN] dataops: the org did not say which org it is: ${extractErrorMessage(err)}`,
      );
      return undefined;
    }
  }

  private async handleBackup(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(dataOpsBackupPayloadSchema, msg, 'dataops:error', this.deps);
    if (!parsed) return;
    // Deterministic ID from the message ID — enables genuine duplicate detection
    // (a fresh UUID per call made `isDuplicate` dead code).
    const operationId = msg.id;
    const outcome = await this.takeBackup(operationId, parsed, msg.type);

    if ('error' in outcome) {
      // Dual channel, single display: `operation:failed` carries the lifecycle
      // (webview clears global loading + auto AI-resolver); `dataops:error` is
      // the `<domain>:error` channel useBridgeMutation listens on — it settles
      // the in-flight mutation with the real message. The webview surfaces the
      // error from dataops:error only, so the user sees it exactly once.
      sendHandlerError(this.deps, 'backup:execute', 'dataops:error', msg, outcome.error);
      this.endBackupNotTaken(operationId, outcome);
      return;
    }

    const response = buildResponse(this.deps, msg, 'dataops:backup:response', {
      operationId,
      status: 'completed',
      objects: outcome.objects.map(heldOf),
      totalRecords: outcome.totalRecords,
      ...(outcome.partial ? { partial: true } : {}),
      timestamp: outcome.timestamp,
    });
    this.deps.broker.postToWebview(response);
    this.deps.log(`[TX] ${response.type} id=${response.id}`);
  }

  /**
   * Take a snapshot for a pipeline's Backup step: the flow the Backup button
   * runs — the org's lock, the duplicate guard, the cap of rows per object,
   * the registry entry Live Operations can cancel, the retention — answered to
   * the step rather than to a page. Nothing is written to the org; the records
   * go to local storage, where the DataOps page lists them.
   *
   * @param request - The snapshot's id, the org, and the objects to read.
   * @param signal - Stops the snapshot between two pages or before it is
   *   saved, with nothing saved.
   * @returns What the snapshot holds.
   * @throws {StepCancelledError} When a cancel stopped the snapshot — Live
   *   Operations' on its own registry entry, or the run's — so the step is not
   *   tried again: a retry took a new snapshot of what the person had just
   *   stopped.
   * @throws With the reason, when no snapshot was taken for any other reason.
   */
  async backupForPipeline(
    request: { operationId: string; orgId: string; objects: string[] },
    signal?: AbortSignal,
  ): Promise<BackupTaken> {
    const outcome = await this.takeBackup(
      request.operationId,
      { orgId: request.orgId, objects: request.objects },
      'pipeline:execute',
      signal,
    );
    if ('error' in outcome) {
      const message = extractErrorMessage(outcome.error);
      this.endBackupNotTaken(request.operationId, outcome);
      if (outcome.cancelled) throw new StepCancelledError(message);
      throw outcome.error instanceof Error ? outcome.error : new Error(message);
    }
    return outcome;
  }

  /**
   * End the lifecycle of a snapshot that was not taken: as failed, or, when a
   * cancel stopped it, as a completion that says it was aborted — the way a
   * cancelled Forge discovery ends. A cancel used to post `operation:failed`:
   * the activity feed listed the snapshot the user had stopped as failed, and
   * the cancel was sent off to be explained like an org's error.
   *
   * @param operationId - The snapshot's id.
   * @param outcome - Why it was not taken.
   */
  private endBackupNotTaken(operationId: string, outcome: BackupNotTaken): void {
    if (outcome.cancelled) {
      sendOperationCompleted(this.deps, operationId, { aborted: true });
      return;
    }
    sendOperationFailed(
      this.deps,
      operationId,
      extractErrorMessage(outcome.error),
      outcome.retryable,
      { context: outcome.context },
    );
  }

  /**
   * The snapshot flow the Backup button and a pipeline's Backup step share. It
   * reports the lifecycle (`operation:started`, progress, `operation:completed`)
   * itself and leaves answering the request, or the step, to its caller, with
   * the failure when there is one.
   *
   * @param operationId - The snapshot's id: its storage key and its registry entry.
   * @param payload - The org and the objects to read; for the snapshot a
   *   masking run takes, the rows its filter holds it to and, per object, the
   *   fields it masks, which are all a restore of it writes back.
   * @param origin - The request that asked for it, for the fix suggestion.
   * @param signal - Stops the snapshot between two pages or before it is
   *   saved, as a cancel from Live Operations does.
   */
  private async takeBackup(
    operationId: string,
    payload: {
      orgId: string;
      objects: string[];
      /** Per object, the rows the snapshot keeps; every row of an object it names none for. */
      wheres?: ReadonlyMap<string, string>;
      fields?: ReadonlyMap<string, string>;
    },
    origin: string,
    signal?: AbortSignal,
  ): Promise<BackupTaken | BackupNotTaken> {
    // Names the object in progress as the loop below advances, so the fix
    // suggestion for a failure says which object it came from.
    const failure: OperationFailureContext = { module: 'dataops', operation: origin };

    const lockKey = `backup:${payload.orgId}`;
    if (this.activeOrgOperations.has(lockKey)) {
      const message = `A backup or rollback operation is already running for org ${payload.orgId}. Please wait for it to complete.`;
      this.deps.log(`[WARN] ${message}`);
      // This message is one SandForge writes itself, so it is never asked
      // about and the context is never read — it is passed here, and at the
      // guard and precondition refusals below, so every failure of the run
      // carries the same thing.
      return { error: new Error(message), retryable: false, context: failure };
    }
    this.activeOrgOperations.add(lockKey);

    /**
     * Settles the promise the registry watches, so it stops listing this run:
     * with the error the snapshot failed on, or with nothing when it finished.
     * Settled unconditionally, a snapshot that errored was announced completed.
     */
    let settleBackup: (error?: unknown) => void = () => {};
    /** What the snapshot failed on, read by `settleBackup` in `finally`. */
    let backupError: unknown;
    // Aborted by the registry (a cancel from Live Operations, the window
    // closing) and by the caller's signal (a pipeline run stopped).
    const stop = new AbortController();
    const onAbort = (): void => stop.abort();
    if (signal?.aborted) stop.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    /** The most rows of each object the snapshot reads. */
    const cap = this.backupCap();
    /** Where the pages go as the org answers them. */
    const writer = this.backupWriter(operationId);
    this.backupsWriting.add(operationId);
    /** The objects read to their end, or to the cap. */
    const taken: BackupObjectRead[] = [];
    /** The object under way, until it is read: a failure part-way says how far it got. */
    let reading: BackupObjectRead | undefined;
    /** The org's connection, once opened: a snapshot kept after a failure asks which org it is. */
    let connection: Connection | undefined;

    try {
      if (this.dmlTracker.isDuplicate(operationId)) {
        this.deps.log(`[WARN] Duplicate backup operation detected: ${operationId}`);
        return {
          error: new Error(`Duplicate operation: ${operationId}`),
          retryable: false,
          context: failure,
        };
      }
      this.dmlTracker.register(operationId, 'backup', 'insert', payload.objects.length);

      const conn = await getJsforceConnection(
        payload.orgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );
      connection = conn;

      // A page is as many rows as the org's tier reads at a time: 2,000 on a
      // sandbox, 500 on production. It used to be how many rows of each
      // object a backup read at all: one taken before an Anonymize of a larger
      // object brought that many back, and the rest stayed masked for good.
      const org = this.deps.orgManager.getOrg(payload.orgId);
      const orgTier = resolveOrgTier(org?.orgType === 'Sandbox' || org?.orgType === 'Scratch');
      const pageSize = getQueryLimits(orgTier).defaultQueryLimit;

      const description = `Backup ${payload.objects.length} object(s)`;
      sendOperationStarted(this.deps, operationId, 'dataops', description);

      // A snapshot reads one page after another, so the registry's abort —
      // the extension deactivating, the window closing, a cancel from Live
      // Operations, a pipeline run stopped — is honoured between two pages.
      // What the pages before wrote is then removed, so stopping leaves no
      // half-saved backup behind.
      this.deps.infraServices?.backgroundRegistry?.register(
        operationId,
        'dataops',
        description,
        new Promise<void>((resolve, reject) => {
          settleBackup = (error) => {
            if (error === undefined) resolve();
            else reject(error instanceof Error ? error : new Error(String(error)));
          };
        }),
        stop,
      );

      for (const objectApiName of payload.objects) {
        if (stop.signal.aborted) {
          throw new BackupCancelledError();
        }
        const safeObj = sanitizeSoqlObjectName(objectApiName);
        failure.objectName = safeObj;
        const read: BackupObjectRead = { objectApiName, recordCount: 0, truncated: false };
        reading = read;
        await this.readIntoBackup(
          conn,
          safeObj,
          read,
          writer,
          {
            pageSize,
            cap,
            select: payload.fields?.get(safeObj),
            where: payload.wheres?.get(safeObj),
          },
          stop.signal,
          () => {
            // Between two pages of a large object: how far into it the read is.
            const target = Math.max(1, Math.min(read.orgCount ?? cap, cap));
            sendOperationProgress(
              this.deps,
              operationId,
              Math.round(
                ((taken.length + read.recordCount / target) / payload.objects.length) * 100,
              ),
              taken.length,
              payload.objects.length,
              `Reading ${objectApiName} (${read.recordCount} of ${target} records)`,
            );
          },
        );
        reading = undefined;
        taken.push(read);

        // A snapshot that stopped at the cap is still a snapshot, and taking
        // it is still better than taking none — but it is not the thing the
        // user thinks they have. Said here, carried in the metadata below, and
        // read back by the listing and the coverage check, so it is still true
        // tomorrow.
        if (read.stoppedAt === 'cap') {
          this.deps.log(
            `[WARN] backup of ${safeObj} stopped at the cap of ${cap} record(s): the object holds ` +
              `${read.orgCount ?? 'more'}.`,
          );
        }

        sendOperationProgress(
          this.deps,
          operationId,
          Math.round((taken.length / payload.objects.length) * 100),
          taken.length,
          payload.objects.length,
          `Exported ${objectApiName} (${read.recordCount} records)`,
        );
      }

      // Which org the records were read from: a restore compares it with the
      // org it would write to, which a sandbox refresh replaces behind the
      // same registered id.
      const organizationId = await this.organizationIdOf(conn);

      // And once more before anything is saved. A cancel that came while the
      // last object was read was honoured by nothing: the snapshot of a single
      // object was saved and called taken, after Live Operations had said it
      // was stopped.
      if (stop.signal.aborted) {
        throw new BackupCancelledError();
      }

      const backupMeta = this.saveBackupMeta(
        { operationId, orgId: payload.orgId, organizationId, cap },
        taken,
        writer,
        false,
      );

      // `sandforge.backup.maxCount` retention: prune oldest backups for this
      // org. Housekeeping, and it runs after the snapshot is written — so a
      // failure in it must not be reported as a failed backup. Told the
      // snapshot failed, a user takes it again or, worse, carries on without
      // the one they already have; the records are on disk either way and the
      // listing finds them. Only the pruning is lost, and it retries on the
      // next backup of this org.
      this.pruneAfterBackup(payload.orgId);

      sendOperationCompleted(this.deps, operationId, {
        objects: taken.map((r) => ({
          objectApiName: r.objectApiName,
          recordCount: r.recordCount,
        })),
        totalRecords: backupMeta.totalRecords,
      });
      this.dmlTracker.markCompleted(operationId);

      return {
        operationId,
        objects: taken,
        totalRecords: backupMeta.totalRecords,
        partial: backupMeta.partial,
        timestamp: backupMeta.timestamp,
      };
    } catch (err: unknown) {
      this.dmlTracker.markFailed(operationId);
      // Only a stop at the cancel is one. Read off the signal, a query the org
      // refused while a cancel was pending made a cancelled snapshot: the
      // activity feed listed it cancelled, and a pipeline's Backup step ended
      // cancelled rather than failed, and was not tried again.
      const cancelled = err instanceof BackupCancelledError;
      // A read the org failed part-way keeps what it read, said to be partial;
      // a cancel, or a page the disk did not take whole, keeps nothing.
      const kept =
        cancelled || err instanceof BackupWriteError
          ? undefined
          : await this.keepFailedBackup(
              { operationId, orgId: payload.orgId, cap },
              connection,
              { taken, reading, planned: payload.objects },
              writer,
            );
      if (kept === undefined) {
        await writer.discard().catch((discardErr: unknown) => {
          this.deps.log(
            `[WARN] backup ${operationId}: what it wrote before it stopped was not removed: ` +
              extractErrorMessage(discardErr),
          );
        });
      }
      const reported =
        kept === undefined
          ? err
          : new Error(
              `${extractErrorMessage(err)} — the backup keeps the ${kept.totalRecords} record(s) ` +
                `read before it stopped, listed as partial: ${backupShortfall(kept.objects)}.`,
            );
      backupError = reported;
      // Stopped through the run's signal rather than from Live Operations, the
      // snapshot is still listed as running there, and the error it settles
      // with below would list it as failed.
      if (cancelled) this.deps.infraServices?.backgroundRegistry?.abort(operationId);
      return { error: reported, retryable: true, context: failure, cancelled };
    } finally {
      signal?.removeEventListener('abort', onAbort);
      settleBackup(backupError);
      this.activeOrgOperations.delete(lockKey);
      this.backupsWriting.delete(operationId);
    }
  }

  /**
   * The most rows of one object a backup reads: `sandforge.backup.maxRecordsPerObject`,
   * held within the bounds its manifest gives it, which the Settings editor
   * enforces and a hand-edited settings file does not.
   */
  private backupCap(): number {
    const asked: unknown = this.deps.services?.getSandforgeSetting?.(
      'backup.maxRecordsPerObject',
      BACKUP_CAP_DEFAULT,
    );
    if (typeof asked !== 'number' || !Number.isFinite(asked)) return BACKUP_CAP_DEFAULT;
    return Math.min(BACKUP_CAP_MAX, Math.max(BACKUP_CAP_MIN, Math.floor(asked)));
  }

  /**
   * Where a snapshot's records go as pages arrive: the backup files once
   * composition gave the handler their store; otherwise the config store, in
   * one entry per object written with the metadata, as before the files.
   *
   * @param operationId - The snapshot's id, its files' and entries' key.
   */
  private backupWriter(operationId: string): BackupWriter {
    const store = this.backupRecords;
    if (store) {
      const begun = new Set<string>();
      return {
        begin: async (objectApiName) => {
          begun.add(objectApiName);
          await store.begin(operationId, objectApiName).catch((err: unknown) => {
            throw new BackupWriteError(err);
          });
        },
        append: async (objectApiName, records) => {
          await store.append(operationId, objectApiName, records).catch((err: unknown) => {
            throw new BackupWriteError(err);
          });
        },
        keep: () => undefined,
        discard: async () => {
          for (const objectApiName of begun) await store.delete(operationId, objectApiName);
        },
      };
    }
    const held = new Map<string, BackupRecord[]>();
    return {
      begin: async (objectApiName) => {
        held.set(objectApiName, []);
      },
      append: async (objectApiName, records) => {
        held.get(objectApiName)?.push(...records);
      },
      keep: () => {
        for (const [objectApiName, records] of held) {
          this.deps.configStore.set(`backup:${operationId}:${objectApiName}`, records, 'backups');
        }
      },
      discard: async () => {
        held.clear();
      },
    };
  }

  /**
   * Read one object into a snapshot, page after page to its last row or to
   * the cap, each page written before the next is asked for: the snapshot
   * holds one page in memory, whatever the object's size.
   *
   * One statement, its pages followed by `nextRecordsUrl`, each as large as
   * the org's tier reads (`Sforce-Query-Options: batchSize`). Its first answer
   * says how many rows the object holds, which the snapshot records beside
   * the rows it read. Reaching the cap, it stops with the rows past it unread
   * and records why.
   *
   * @param read - The object as read so far, updated page by page, so that a
   *   read that fails part-way still says how many rows it wrote.
   * @param limits - The rows a page reads and the most the snapshot takes;
   *   and, for a masking run's snapshot, the fields read — every field
   *   otherwise — and the rows its filter holds it to.
   * @param onPage - Called between two pages, once more are to come.
   * @throws {BackupCancelledError} At a cancel, between two pages.
   */
  private async readIntoBackup(
    conn: Connection,
    safeObj: string,
    read: BackupObjectRead,
    writer: BackupWriter,
    limits: { pageSize: number; cap: number; select?: string; where?: string },
    stop: AbortSignal,
    onPage: () => void,
  ): Promise<void> {
    const options: QueryOptions = {
      headers: { 'Sforce-Query-Options': `batchSize=${limits.pageSize}` },
      maxFetch: 10_000,
      autoFetch: false,
      scanAll: false,
      responseTarget: 'QueryResult',
    };
    const select = limits.select ?? (await this.selectAllFields(conn, safeObj));
    let page: QueryResult<BackupRecord> = await conn.query<BackupRecord>(
      `SELECT ${select} FROM ${safeObj}${rowsOfTheRun(limits.where, undefined)}`,
      options,
    );
    checkApiLimits(conn.limitInfo, `dataops:backup query ${safeObj}`);
    if (typeof page.totalSize === 'number' && Number.isInteger(page.totalSize)) {
      read.orgCount = page.totalSize;
    }
    await writer.begin(read.objectApiName);
    for (;;) {
      const room = limits.cap - read.recordCount;
      const rows = page.records.length > room ? page.records.slice(0, room) : page.records;
      await writer.append(read.objectApiName, rows);
      read.recordCount += rows.length;
      const next = !page.done ? page.nextRecordsUrl : undefined;
      if (
        rows.length < page.records.length ||
        (next !== undefined && read.recordCount >= limits.cap)
      ) {
        read.truncated = true;
        read.stoppedAt = 'cap';
        return;
      }
      if (next === undefined) return;
      onPage();
      if (stop.aborted) throw new BackupCancelledError();
      page = await conn.queryMore<BackupRecord>(next, options);
      checkApiLimits(conn.limitInfo, `dataops:backup query ${safeObj}`);
    }
  }

  /**
   * Write a snapshot's metadata, the one entry the listing, the coverage
   * check and a restore read, then keep its records.
   *
   * @param failed - Whether the read failed part-way: the backup keeps the
   *   rows read before, and says so.
   * @returns The metadata written.
   */
  private saveBackupMeta(
    backup: { operationId: string; orgId: string; organizationId?: string; cap: number },
    objects: readonly BackupObjectRead[],
    writer: BackupWriter,
    failed: boolean,
  ): BackupMeta & { partial: boolean; timestamp: string; totalRecords: number } {
    const backupMeta = {
      operationId: backup.operationId,
      orgId: backup.orgId,
      ...(backup.organizationId !== undefined ? { organizationId: backup.organizationId } : {}),
      objects: objects.map(heldOf),
      // True when any object stopped short, or was never reached, so the
      // listing can say so without reading every object of every snapshot.
      partial: objects.some((r) => r.truncated),
      ...(failed ? { status: 'failed' as const } : {}),
      cap: backup.cap,
      timestamp: new Date().toISOString(),
      totalRecords: objects.reduce((sum, r) => sum + r.recordCount, 0),
    };
    this.deps.configStore.set(`backup:${backup.operationId}`, backupMeta, 'backups');
    // Record payloads go to a file, not globalState: VSCode re-serializes
    // that memento in full on every write, so megabytes of backup made every
    // unrelated setting save pay for them.
    writer.keep();
    return backupMeta;
  }

  /**
   * Keep a snapshot whose read the org failed part-way, as far as it got:
   * the objects read whole, the one it failed on with the rows it wrote, and
   * every object it was to read and never reached, with none — listed as
   * partial and failed, so that neither the listing nor a restore takes it
   * for the org's data. Nothing is kept when no row was written.
   *
   * A backup that failed between two objects was kept as failed and not
   * partial, and the objects after the failure were in no list: the Backup
   * and Restore tabs, and a restore's warning, named none of them.
   *
   * @param read - The objects read whole, the one being read when it failed,
   *   and every object the backup was to read, in its order.
   * @returns The metadata written, or undefined when nothing was kept.
   */
  private async keepFailedBackup(
    backup: { operationId: string; orgId: string; cap: number },
    conn: Connection | undefined,
    read: {
      taken: readonly BackupObjectRead[];
      reading: BackupObjectRead | undefined;
      planned: readonly string[];
    },
    writer: BackupWriter,
  ): Promise<(BackupMeta & { objects: BackupObjectRead[]; totalRecords: number }) | undefined> {
    const { taken, reading } = read;
    const reached = reading
      ? [...taken, { ...reading, truncated: true, stoppedAt: 'failure' as const }]
      : [...taken];
    const seen = new Set(reached.map((o) => o.objectApiName.toLowerCase()));
    const notReached = read.planned
      .filter((objectApiName) => !seen.has(objectApiName.toLowerCase()))
      .map((objectApiName): BackupObjectRead => ({
        objectApiName,
        recordCount: 0,
        truncated: true,
        stoppedAt: 'not_reached',
      }));
    const objects = [...reached, ...notReached];
    if (objects.every((o) => o.recordCount === 0)) return undefined;
    try {
      const organizationId = conn ? await this.organizationIdOf(conn) : undefined;
      const meta = this.saveBackupMeta({ ...backup, organizationId }, objects, writer, true);
      this.pruneAfterBackup(backup.orgId);
      return { ...meta, objects };
    } catch (err: unknown) {
      this.deps.log(
        `[WARN] backup ${backup.operationId}: the rows read before it failed were not kept: ` +
          extractErrorMessage(err),
      );
      // Its metadata may be written already: without its records, a listed
      // backup would restore nothing and say it had.
      try {
        this.deps.configStore.delete(`backup:${backup.operationId}`);
      } catch {
        // Not written, or the store refuses: either way nothing is listed.
      }
      return undefined;
    }
  }

  /** Prune the org's backups past the retention, logging rather than failing a backup kept. */
  private pruneAfterBackup(orgId: string): void {
    try {
      this.pruneBackups(orgId);
    } catch (pruneErr: unknown) {
      this.deps.log(
        `[WARN] backup retention failed after the snapshot was written: ${extractErrorMessage(pruneErr)}`,
      );
    }
    void this.sweepBackupFiles();
  }

  /**
   * Enforce the `sandforge.backup.maxCount` retention policy for an org:
   * oldest backups (by meta timestamp) beyond the cap are deleted, including
   * their per-object record payloads.
   */
  /**
   * Answer `backup:list` with the backups persisted for one org.
   *
   * The DataOps page has always listened on `backup:list:result`, but the
   * request type was declared in no Zod member, so the broker rejected the
   * message before any handler saw it: the list was permanently empty, the KPI
   * row read 0, Restore had nothing to select, and the query eventually timed
   * out into an error banner.
   *
   * Key partitioning mirrors pruneBackups: meta keys are `backup:<operationId>`,
   * record keys are `backup:<operationId>:<objectApiName>`.
   */
  private handleBackupList(msg: InboundRequest): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(dataOpsBackupListPayloadSchema, msg, 'dataops:error', this.deps);
    if (!parsed) return;

    const backups: BackupSummary[] = [];
    for (const key of this.deps.configStore.getKeysByPrefix('backup:')) {
      if (key.slice('backup:'.length).includes(':')) continue;
      const meta = this.deps.configStore.get<BackupMeta>(key);
      if (!meta || meta.orgId !== parsed.orgId) continue;
      backups.push({
        operationId: meta.operationId ?? key.slice('backup:'.length),
        orgId: meta.orgId,
        timestamp: meta.timestamp ?? '',
        totalRecords: meta.totalRecords ?? 0,
        // Byte size is not recorded at backup time; reporting 0 is honest,
        // where a computed guess would not be.
        totalSize: 0,
        // A meta record only exists once the backup has been written, so a
        // listed backup is a completed one — or one whose read failed
        // part-way, which keeps the rows read before and says it failed.
        status: meta.status === 'failed' ? 'failed' : 'completed',
        // Run for real, a backup of 1 220 contacts on a Developer Edition
        // read 500 and was listed as complete: the snapshot knew, the list
        // did not say.
        objectResults: (meta.objects ?? []).map(heldOf),
        ...(meta.partial ? { partial: true } : {}),
      });
    }
    // Newest first — the list is a history, and the most recent restore point
    // is the one a user reaches for.
    backups.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    const response = buildResponse(this.deps, msg, 'backup:list:result', { backups });
    this.deps.broker.postToWebview(response);
    this.deps.log(`[TX] ${response.type} id=${response.id} count=${backups.length}`);
  }

  /**
   * Write one backup, records included, to a file the user picks, so it can
   * leave the machine.
   *
   * Nothing here touches the org: it reads what the backup kept and writes
   * it out {@link RESTORE_BATCH_SIZE} records at a time, as a restore reads
   * it. The document used to be built whole and posted to the page in one
   * message, which saved it as one file: every record of every object, up to
   * the cap of a million rows per object, held at once on both sides of the
   * bridge. The page now hears where the file went and the records written
   * per object, or that the dialog was dismissed.
   *
   * The document is the one the page saved (`sandforgeBackupVersion` 1):
   * the backup's id, org, time and record count, then each object's records
   * as an array, one record to a line.
   */
  private async handleBackupExport(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(
      dataOpsBackupExportPayloadSchema,
      msg,
      'dataops:error',
      this.deps,
    );
    if (!parsed) return;

    const metaKey = `backup:${parsed.operationId}`;
    const meta = this.deps.configStore.get<{
      orgId?: string;
      timestamp?: string;
      totalRecords?: number;
      objects?: Array<{ objectApiName: string; recordCount: number }>;
    }>(metaKey);

    if (!meta || meta.orgId !== parsed.orgId) {
      sendHandlerError(
        this.deps,
        'backup:export',
        'dataops:error',
        msg,
        new Error(`Backup not found: ${parsed.operationId}`),
        { code: 'BACKUP_NOT_FOUND' },
      );
      return;
    }

    const saved = await this.saveDialog.saveStream(
      `sandforge-backup-${parsed.operationId}.json`,
      (append) => this.writeBackupDocument(parsed, meta, append),
      ['json'],
    );
    if (saved.status === 'error') {
      sendHandlerError(this.deps, 'backup:export', 'dataops:error', msg, new Error(saved.message));
      return;
    }

    const response = buildResponse(
      this.deps,
      msg,
      'backup:export:result',
      saved.status === 'saved'
        ? {
            operationId: parsed.operationId,
            status: 'saved' as const,
            path: saved.path,
            objects: saved.result,
          }
        : { operationId: parsed.operationId, status: 'cancelled' as const },
    );
    this.deps.broker.postToWebview(response);
    // Not the path: where a person keeps an export is theirs.
    this.deps.log(`[TX] ${response.type} id=${response.id} ${saved.status}`);
  }

  /**
   * Write a backup's export document through `append`, a batch of records
   * at a time: never more than one batch of the backup in memory.
   *
   * @param backup - The backup's id and the org it was taken from.
   * @param meta - The backup's metadata.
   * @returns Per object, the records written.
   */
  private async writeBackupDocument(
    backup: { operationId: string; orgId: string },
    meta: { timestamp?: string; totalRecords?: number; objects?: Array<{ objectApiName: string }> },
    append: (text: string) => Promise<void>,
  ): Promise<BackupExportObject[]> {
    const { operationId } = backup;
    const header: Array<[string, string | number]> = [
      ['sandforgeBackupVersion', 1],
      ['operationId', operationId],
      ['orgId', backup.orgId],
      ['timestamp', meta.timestamp ?? ''],
      ['totalRecords', meta.totalRecords ?? 0],
    ];
    const fields = header.map(([key, value]) => `  "${key}": ${JSON.stringify(value)},\n`);
    await append(`{\n${fields.join('')}  "objects": {`);
    const written: BackupExportObject[] = [];
    for (const { objectApiName } of meta.objects ?? []) {
      // One key per object, as the document built whole had it.
      if (written.some((w) => w.objectApiName === objectApiName)) continue;
      await append(`${written.length > 0 ? ',' : ''}\n    ${JSON.stringify(objectApiName)}: [`);
      let records = 0;
      for await (const batch of await this.backupBatches(operationId, objectApiName)) {
        if (batch.length === 0) continue;
        await append(
          batch
            .map((record, i) => `${records + i > 0 ? ',' : ''}\n      ${JSON.stringify(record)}`)
            .join(''),
        );
        records += batch.length;
      }
      await append(records > 0 ? '\n    ]' : ']');
      written.push({ objectApiName, records });
    }
    await append(`${written.length > 0 ? '\n  ' : ''}}\n}\n`);
    return written;
  }

  /**
   * One object's records of a backup, {@link RESTORE_BATCH_SIZE} at a time,
   * wherever the backup keeps them: its file — one record to a line, or one
   * array for a backup taken before — or the config store, for a backup taken
   * before the files. Each pass over the answer reads them from the first.
   */
  private async backupBatches(
    operationId: string,
    objectApiName: string,
  ): Promise<AsyncIterable<BackupRecord[]>> {
    const fromFile = await this.backupRecords?.batches(
      operationId,
      objectApiName,
      RESTORE_BATCH_SIZE,
    );
    if (fromFile) return fromFile;
    const stored: unknown = this.deps.configStore.get(`backup:${operationId}:${objectApiName}`);
    const held = Array.isArray(stored) ? (stored as BackupRecord[]) : [];
    return {
      async *[Symbol.asyncIterator]() {
        for (let i = 0; i < held.length; i += RESTORE_BATCH_SIZE) {
          yield held.slice(i, i + RESTORE_BATCH_SIZE);
        }
      },
    };
  }

  private pruneBackups(orgId: string): void {
    const maxCount = this.deps.services?.getSandforgeSetting?.('backup.maxCount', 10) ?? 10;
    const metas: Array<{ key: string; timestamp: string }> = [];
    for (const key of this.deps.configStore.getKeysByPrefix('backup:')) {
      // Meta keys are `backup:<operationId>`; record keys are
      // `backup:<operationId>:<objectApiName>` — skip the latter.
      const rest = key.slice('backup:'.length);
      if (rest.includes(':')) continue;
      const meta = this.deps.configStore.get<{ orgId?: string; timestamp?: string }>(key);
      if (meta?.orgId !== orgId) continue;
      metas.push({ key, timestamp: meta.timestamp ?? '' });
    }
    if (metas.length <= maxCount) return;
    metas.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    for (const { key } of metas.slice(0, metas.length - maxCount)) {
      const meta = this.deps.configStore.get<{
        objects?: Array<{ objectApiName: string }>;
      }>(key);
      for (const obj of meta?.objects ?? []) {
        this.deps.configStore.delete(`${key}:${obj.objectApiName}`);
        void this.backupRecords?.delete(key.slice('backup:'.length), obj.objectApiName);
      }
      this.deps.configStore.delete(key);
      this.deps.log(`[INFO] Pruned backup ${key} (retention: ${maxCount} per org)`);
    }
  }

  /**
   * Bring back, from the recycle bin, the records of a snapshot deleted since.
   *
   * A record no longer in the recycle bin cannot come back with its Id; the
   * upsert that follows reports it as refused, which is what it is. An object
   * whose rows cannot be read with the deleted ones, or a record the bin will
   * not give back, is likewise left to that upsert and its report.
   *
   * @param batches - The snapshot's records of the object, read a batch at a
   *   time: every one is brought back before the upsert writes any, so a row
   *   pointing at another of the same object finds it there.
   */
  private async undeleteFromRecycleBin(
    conn: Connection,
    objectApiName: string,
    batches: AsyncIterable<readonly BackupRecord[]>,
  ): Promise<{ undeleted: number }> {
    const deleted: string[] = [];
    for await (const batch of batches) {
      const ids = batch.map((r) => r.Id).filter((id): id is string => typeof id === 'string');
      if (ids.length === 0) continue;
      const inList = ids.map((id) => `'${sanitizeSoqlValue(id)}'`).join(', ');
      try {
        const result = await conn.query<{ Id: string }>(
          `SELECT Id FROM ${objectApiName} WHERE Id IN (${inList}) AND IsDeleted = true`,
          { scanAll: true },
        );
        deleted.push(...result.records.map((r) => r.Id));
      } catch (err: unknown) {
        this.deps.log(
          `[WARN] Rollback on ${objectApiName}: could not look for deleted records — ${extractErrorMessage(err)}`,
        );
        return { undeleted: 0 };
      }
    }
    let undeleted = 0;
    for (let i = 0; i < deleted.length; i += 200) {
      const results = await conn.soap.undelete(deleted.slice(i, i + 200));
      undeleted += results.filter((r) => r.success).length;
    }
    return { undeleted };
  }

  /**
   * Refuse a write whose Production Guard is not there, on both channels the
   * page listens on — the same as a declined confirmation, with the code the
   * frozen load refuses with — and record it in the audit trail, as the
   * guard's own refusals are.
   */
  private refuseWithoutGuard(
    context: 'dataops:rollback' | 'dataops:anonymize',
    msg: InboundRequest,
    operationId: string,
    failure: OperationFailureContext,
    run: WriteRun,
  ): void {
    recordWriteRun(this.deps, {
      ...run,
      outcome: 'stopped',
      source: undefined,
      code: PRODUCTION_GUARD_MISSING.code,
    });
    sendHandlerError(
      this.deps,
      context,
      'dataops:error',
      msg,
      new Error(PRODUCTION_GUARD_MISSING.message),
      { code: PRODUCTION_GUARD_MISSING.code },
    );
    sendOperationFailed(this.deps, operationId, PRODUCTION_GUARD_MISSING.message, false, {
      context: failure,
    });
  }

  private async handleRollback(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(dataOpsRollbackPayloadSchema, msg, 'dataops:error', this.deps);
    if (!parsed) return;
    const payload = parsed;
    // Deterministic ID from the message ID (see handleBackup).
    const rollbackOpId = msg.id;
    // Follows the object in progress (see handleBackup).
    const failure: OperationFailureContext = { module: 'dataops', operation: msg.type };

    const lockKey = `backup:${payload.orgId}`;
    if (this.activeOrgOperations.has(lockKey)) {
      const message = `A backup or rollback operation is already running for org ${payload.orgId}. Please wait for it to complete.`;
      this.deps.log(`[WARN] ${message}`);
      sendHandlerError(this.deps, 'dataops:rollback', 'dataops:error', msg, new Error(message));
      sendOperationFailed(this.deps, rollbackOpId, message, false, { context: failure });
      return;
    }
    this.activeOrgOperations.add(lockKey);

    /** The restore as the audit trail records it, once the backup is found. */
    let run: WriteRun | undefined;
    /** Per object, what the restore wrote so far. */
    const restored: AuditObjectCounts[] = [];
    /**
     * True from the moment the restore is announced until its end is recorded:
     * it stops at the first object it may not write, and must still be recorded.
     */
    let unrecorded = false;

    try {
      if (this.dmlTracker.isDuplicate(rollbackOpId)) {
        this.deps.log(`[WARN] Duplicate rollback operation detected: ${rollbackOpId}`);
        sendHandlerError(
          this.deps,
          'dataops:rollback',
          'dataops:error',
          msg,
          new Error(`Duplicate operation: ${rollbackOpId}`),
        );
        sendOperationFailed(
          this.deps,
          rollbackOpId,
          `Duplicate operation: ${rollbackOpId}`,
          false,
          { context: failure },
        );
        return;
      }
      this.dmlTracker.register(rollbackOpId, 'rollback', 'upsert', 0);

      const conn = await getJsforceConnection(
        payload.orgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );

      // Create CrudFlsGuard for permission checks before DML
      const crudFlsGuard = new CrudFlsGuard(async (objectApiName: string) => {
        const desc = await conn.describe(objectApiName);
        return describeToObjectDescribe(desc);
      });

      const backupKey = `backup:${payload.operationId}`;
      const backupMeta = this.deps.configStore.get<
        BackupMeta & { orgId: string; objects: BackupObjectHeld[]; totalRecords: number }
      >(backupKey);

      if (!backupMeta) {
        throw new Error(`No backup found for operation ${payload.operationId}. Cannot rollback.`);
      }

      // A backup belongs to the org it was taken from. Without this, the
      // records of org A could be poured into org B.
      if (backupMeta.orgId !== payload.orgId) {
        throw new Error(
          `Backup ${payload.operationId} was taken from org ${backupMeta.orgId} and cannot be ` +
            `restored into org ${payload.orgId}.`,
        );
      }

      run = {
        action: 'backup_restore',
        module: 'dataops',
        operationId: rollbackOpId,
        orgId: payload.orgId,
        outcome: 'failure',
        // Named by when it was taken: the backup's own id says nothing to a reader.
        source: {
          origin: 'backup',
          label: backupMeta.timestamp?.slice(0, 16).replace('T', ' ') ?? payload.operationId,
        },
      };

      // Rollback writes records over live data — the same Production Guard as
      // every other write path applies (see handleAnonymize), and no write
      // without it.
      const guard = this.deps.infraServices?.productionGuard;
      if (!guard) {
        this.refuseWithoutGuard('dataops:rollback', msg, rollbackOpId, failure, run);
        return;
      }
      const org = this.deps.orgManager.getOrg(payload.orgId);
      const guardRequest = {
        orgId: payload.orgId,
        // A Developer Edition org as the development org it is (see `writeTier`).
        orgTier: writeTier(org),
        operation: 'upsert' as const,
        objectName: backupMeta.objects.map((o) => o.objectApiName).join(', ') || 'RollbackData',
        recordCount: backupMeta.totalRecords ?? 0,
        module: 'dataops',
      };
      const { check, decision } = await consultProductionGuard(guard, guardRequest);
      run.guard = decision;
      if (decision === 'refused' || decision === 'declined') {
        recordWriteRun(this.deps, { ...run, outcome: 'stopped', source: undefined });
      }
      if (decision === 'refused') {
        throw guardBlockedError(check.blockedReason ?? check.impactSummary);
      }
      // `safety.requireProdConfirmation`: explicit user consent before
      // writing to a production org.
      if (decision === 'declined') {
        const message = 'Operation cancelled by user (production confirmation declined).';
        sendHandlerError(this.deps, 'dataops:rollback', 'dataops:error', msg, new Error(message), {
          code: GUARD_REFUSAL.declined,
        });
        sendOperationFailed(this.deps, rollbackOpId, message, false, { context: failure });
        return;
      }

      // A refresh replaces the org behind a registered sandbox and keeps its
      // id: the registry check above passes, and the records the backup saved
      // belong to the org the sandbox was. Restoring them does not put that
      // org back, so the user is told before anything is written.
      if (backupMeta.organizationId !== undefined) {
        const now = await this.organizationIdOf(conn);
        if (now !== undefined && !sameOrg(backupMeta.organizationId, now)) {
          const alias = org?.alias ?? payload.orgId;
          const ask = this.deps.infraServices?.confirmRestoreIntoReplacedOrg;
          const restoreAnyway = ask
            ? await ask({ alias, backedUpFrom: backupMeta.organizationId, now })
            : false;
          if (!restoreAnyway) {
            // Stopped before anything was written, and recorded as the
            // guard's refusals are: the trail said nothing of a restore the
            // check turned down.
            recordWriteRun(this.deps, {
              ...run,
              outcome: 'stopped',
              source: undefined,
              code: ORG_REPLACED_SINCE_BACKUP,
            });
            const message =
              `Restore not run: ${alias} answers as org ${now}, not as org ` +
              `${backupMeta.organizationId}, which backup ${payload.operationId} was taken from, ` +
              (ask
                ? 'and the restore into the org it is now was not confirmed.'
                : 'and nothing here can ask whether to restore into the org it is now.');
            sendHandlerError(
              this.deps,
              'dataops:rollback',
              'dataops:error',
              msg,
              new Error(message),
              {
                code: ORG_REPLACED_SINCE_BACKUP,
              },
            );
            sendOperationFailed(this.deps, rollbackOpId, message, false, { context: failure });
            return;
          }
        }
      }

      sendOperationStarted(
        this.deps,
        rollbackOpId,
        'dataops',
        `Rollback ${backupMeta.objects.length} object(s)`,
      );
      unrecorded = true;

      let totalRestored = 0;
      let totalFailed = 0;
      /** Rows the org already held as the backup does, which the restore did not write. */
      let totalUnchanged = 0;
      const restoreErrors: Array<{ objectApiName: string; message: string }> = [];
      /** Per object, the rows read of the backup: fewer than it lists are said. */
      const rowsRead = new Map<string, number>();
      for (let i = 0; i < backupMeta.objects.length; i++) {
        const obj = backupMeta.objects[i];
        const safeObj = sanitizeSoqlObjectName(obj.objectApiName);
        failure.objectName = safeObj;
        // A batch at a time, whichever form the backup was kept in: a backup
        // now holds up to the cap of rows per object, and the whole of one in
        // memory was what writing it a page at a time stopped doing.
        const batches = await this.backupBatches(payload.operationId, obj.objectApiName);
        let first: BackupRecord | undefined;
        for await (const batch of batches) {
          first = batch[0];
          if (first !== undefined) break;
        }

        if (first === undefined) {
          rowsRead.set(obj.objectApiName, 0);
          this.deps.log(`[WARN] No backup records for ${obj.objectApiName}, skipping.`);
          continue;
        }

        // Can this org upsert the object at all? That question is all-or-nothing
        // and still gates the restore.
        const crudCheck = await crudFlsGuard.checkCrudPermission(safeObj, 'upsert');
        if (!crudCheck.allowed) {
          this.deps.log(`[WARN] CRUD check failed for rollback on ${safeObj}: ${crudCheck.reason}`);
          sendHandlerError(
            this.deps,
            'dataops:rollback',
            'dataops:error',
            msg,
            new Error(crudCheck.reason),
          );
          sendOperationFailed(this.deps, rollbackOpId, crudCheck.reason, false, {
            context: failure,
          });
          return;
        }

        // Which of the backup's fields can actually be written? A backup is a
        // verbatim `SELECT FIELDS(ALL)` snapshot, so it always carries fields
        // nobody may write. Asking "may I write ALL of these?" made every
        // restore fail; the describe answers the field-by-field question.
        const payloadFields = Object.keys(first).filter((k) => k !== 'attributes');
        const { skipped, denied } = await crudFlsGuard.partitionWritableFields(
          safeObj,
          'upsert',
          payloadFields,
        );
        // A business field this org may not write is still a hard stop: dropping
        // it would restore the record with that column silently missing.
        if (denied.length > 0) {
          const reason = `FLS violation on '${safeObj}': fields [${denied.join(', ')}] are not updateable.`;
          this.deps.log(`[WARN] CRUD/FLS check failed for rollback on ${safeObj}: ${reason}`);
          sendHandlerError(this.deps, 'dataops:rollback', 'dataops:error', msg, new Error(reason));
          sendOperationFailed(this.deps, rollbackOpId, reason, false, { context: failure });
          return;
        }
        // `Id` is the upsert match key, not a field being written.
        const droppedFields = new Set(
          skipped.filter((f) => f.toLowerCase() !== 'id').map((f) => f.toLowerCase()),
        );
        if (droppedFields.size > 0) {
          // Reported, never silent: a partial restore the user is not told
          // about is a different lie from the one this replaces.
          this.deps.log(
            `[INFO] Rollback on ${safeObj}: ${droppedFields.size} non-writable field(s) ` +
              `excluded from the payload — ${[...droppedFields].sort().join(', ')}`,
          );
        }

        // A record deleted since the snapshot sits in the recycle bin, and an
        // upsert on its Id is refused: "entity is deleted". Run for real, a
        // restore reported 204 restored and 1 rejected — the one record the
        // user had lost. It is brought back first, with its Id and whatever
        // pointed at it, and the upsert below then writes its fields.
        const brought = await this.undeleteFromRecycleBin(conn, safeObj, batches);
        if (brought.undeleted > 0) {
          this.deps.log(
            `[INFO] Rollback on ${safeObj}: ${brought.undeleted} record(s) brought back from the recycle bin`,
          );
        }

        type JsforceResult = { success: boolean; id?: string; errors?: Array<{ message: string }> };
        failure.batchSize = RESTORE_BATCH_SIZE;
        let successCount = 0;
        let failureCount = 0;
        let unchangedCount = 0;
        let read = 0;
        for await (const batch of batches) {
          read += batch.length;
          const cleaned = batch.map((r) => {
            // An account goes back without what its kind cannot hold, told
            // by the flag it was kept with: a business account's empty first
            // and last names, sent back, refuse it whole — "bad field names on
            // insert/update call: FirstName" — and so does a person
            // account's name, the platform's to compute.
            const kind = safeObj === ACCOUNT ? accountKindOf(r, false) : undefined;
            const copy: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(r)) {
              if (key === 'attributes') continue;
              // `Id` is the upsert match key — kept; everything the describe
              // says this org cannot write is dropped.
              if (droppedFields.has(key.toLowerCase())) continue;
              if (kind !== undefined && leftOutForAccountKind(ACCOUNT, key, kind)) continue;
              copy[key] = value;
            }
            return copy;
          });
          // Only the rows the org no longer holds as the backup does, unless
          // the restore was asked to write every row back.
          let toWrite = cleaned;
          if (payload.rewriteAll !== true) {
            const diff = await rowsToRestore(
              {
                query: async (soql) => {
                  const answer = await conn.query<Record<string, unknown>>(soql);
                  return { totalSize: answer.totalSize, records: answer.records };
                },
              },
              safeObj,
              cleaned,
            );
            if (diff.unread !== undefined) {
              this.deps.log(
                `[WARN] Rollback on ${safeObj}: the org's values could not be read, so ` +
                  `${cleaned.length} row(s) are written back without comparing — ${diff.unread}`,
              );
            }
            toWrite = diff.write;
            unchangedCount += diff.unchanged;
          }
          if (toWrite.length === 0) continue;
          const results = (await conn
            .sobject(safeObj)
            .upsert(toWrite as Array<Record<string, unknown> & { Id: string }>, 'Id', {
              headers: recordWriteHeaders(),
            })) as unknown as JsforceResult[];
          const arr = Array.isArray(results) ? results : [results];
          // Only the successes used to be counted, so a row the org refused
          // (validation rule, required field, trigger) vanished between the
          // upsert and the report. `errors` was declared above and read by
          // no one.
          for (const r of arr) {
            if (r.success) {
              successCount++;
              continue;
            }
            failureCount++;
            collectDmlError(restoreErrors, safeObj, r.errors);
          }
        }
        checkApiLimits(conn.limitInfo, `dataops:rollback upsert ${safeObj}`);
        rowsRead.set(obj.objectApiName, read);
        totalRestored += successCount;
        totalFailed += failureCount;
        totalUnchanged += unchangedCount;
        // An upsert on the record's own Id writes over a record that exists —
        // or was just brought back from the recycle bin — so it updates.
        // A row the org already held as the backup does was not written.
        restored.push({ ...emptyCounts(safeObj), updated: successCount, failed: failureCount });

        sendOperationProgress(
          this.deps,
          rollbackOpId,
          Math.round(((i + 1) / backupMeta.objects.length) * 100),
          i + 1,
          backupMeta.objects.length,
          `Restored ${safeObj} (${successCount}/${read}` +
            `${unchangedCount > 0 ? `, ${unchangedCount} unchanged` : ''})`,
        );
      }

      const status = dmlStatus(totalRestored, totalFailed);
      if (run) {
        unrecorded = false;
        recordWriteRun(this.deps, { ...run, outcome: status, objects: restored });
      }
      sendOperationCompleted(this.deps, rollbackOpId, {
        status,
        totalRestored,
        totalFailed,
        totalUnchanged,
      });
      this.dmlTracker.markCompleted(rollbackOpId);

      // A backup that holds only part of an object — stopped at the cap, a
      // read that failed part-way, a file no longer all there — restores
      // only that part, and the rest of the object stays as it is now: a
      // restore after a masking run leaves those rows masked. Said with the
      // result, as a restore of the whole would not need saying.
      const shortfall = backupShortfall(backupMeta.objects, rowsRead);
      const ranMessage =
        (totalFailed === 0
          ? `Rollback completed: ${totalRestored} records restored`
          : `Rollback ${status}: ${totalRestored} restored, ${totalFailed} rejected by the org`) +
        (totalUnchanged > 0
          ? `; ${totalUnchanged} already held the backup's values and were not written`
          : '');
      const message =
        shortfall === ''
          ? ranMessage
          : `${ranMessage}. The backup held only part of the org's records, and the rest were ` +
            `left as they are: ${shortfall}.`;
      const response = buildResponse(this.deps, msg, 'dataops:rollback:response', {
        operationId: payload.operationId,
        status,
        message,
        totalRestored,
        totalFailed,
        totalUnchanged,
        ...(payload.rewriteAll === true ? { rewriteAll: true } : {}),
        errors: restoreErrors,
        ...(shortfall !== '' ? { partial: true } : {}),
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id} status=${status}`);
      // The DataOps page reads only the error and notification channels: a
      // `partial` left in the response alone is as invisible as the count that
      // was dropped.
      if (totalFailed > 0 || shortfall !== '') {
        sendNotification(
          this.deps,
          status === 'failure' ? 'error' : 'warning',
          'Restore',
          `${message}${restoreErrors[0] ? ` — e.g. ${restoreErrors[0].message}` : ''}`,
        );
      }
    } catch (err: unknown) {
      this.dmlTracker.markFailed(rollbackOpId);
      // Dual channel, single display (see handleBackup).
      sendHandlerError(this.deps, 'dataops:rollback', 'dataops:error', msg, err, {
        code: guardRefusalCode(err),
      });
      sendOperationFailed(this.deps, rollbackOpId, extractErrorMessage(err), true, {
        context: failure,
      });
    } finally {
      this.activeOrgOperations.delete(lockKey);
      // A restore that stopped at an object it may not write, or threw, after
      // it started: recorded as failed, with the objects it had restored.
      if (unrecorded && run) {
        recordWriteRun(this.deps, { ...run, outcome: 'failure', objects: restored });
      }
    }
  }

  /**
   * Take the snapshot a masking run asked for, once the guard let it go and
   * before its first write: the rows it counted, held to its filter, each
   * with the fields its rules mask as they are now. A restore of it writes
   * those fields back, by Id, and nothing else of the record.
   *
   * Taken by the flow the Backup button runs — the org's lock, the cap of
   * rows per object, the registry entry a cancel stops — so it is listed,
   * kept and restored like any backup. The run then writes nothing unless the
   * snapshot holds every row it would mask: a snapshot that stopped at the
   * cap, with the rows past it masked all the same, would put back part of
   * the object and leave the rest masked for good.
   *
   * @param work - The run's objects, counted: one with no row is not read.
   * @returns The snapshot, or none when there was no row to keep; or why the
   *   run must not write, and whether trying again may help.
   */
  private async snapshotBeforeMasking(
    conn: Connection,
    operationId: string,
    orgId: string,
    work: readonly MaskingWork[],
    options: { origin: string; stop: AbortSignal },
  ): Promise<
    | { taken?: { operationId: string; totalRecords: number } }
    | { refused: string; retryable: boolean }
  > {
    const fields = new Map<string, string>();
    /** The rows of each object the run holds to, which are all the snapshot keeps of it. */
    const wheres = new Map<string, string>();
    try {
      for (const w of work) {
        if (w.tally.total === 0) continue;
        if (w.where !== undefined) wheres.set(w.tally.objectApiName, w.where);
        const { select } = await this.maskedFields(
          conn,
          w.tally.objectApiName,
          this.maskingRules(w.objectName, w.objectRules),
          this.maskingRules(w.objectName, w.personRules),
        );
        // An object none of whose masked fields it has is written nothing.
        if (select !== 'Id') fields.set(w.tally.objectApiName, select);
      }
    } catch (err: unknown) {
      return {
        refused: `No snapshot was taken, so nothing was masked: ${extractErrorMessage(err)}`,
        retryable: true,
      };
    }
    if (fields.size === 0) return {};
    const snapshotId = `${operationId}-snapshot`;
    const outcome = await this.takeBackup(
      snapshotId,
      {
        orgId,
        objects: [...fields.keys()],
        ...(wheres.size > 0 ? { wheres } : {}),
        fields,
      },
      options.origin,
      options.stop,
    );
    if ('error' in outcome) {
      this.endBackupNotTaken(snapshotId, outcome);
      return {
        refused: `No snapshot was taken, so nothing was masked: ${extractErrorMessage(outcome.error)}`,
        retryable: outcome.retryable && outcome.cancelled !== true,
      };
    }
    if (outcome.partial) {
      return {
        refused:
          `Snapshot ${snapshotId} holds only part of the records the run would mask, so nothing ` +
          `was masked: a restore could not put back the rest (${backupShortfall(outcome.objects)}). ` +
          'Raise sandforge.backup.maxRecordsPerObject, or narrow the run.',
        retryable: false,
      };
    }
    return { taken: { operationId: snapshotId, totalRecords: outcome.totalRecords } };
  }

  private async handleAnonymize(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(dataOpsAnonymizePayloadSchema, msg, 'dataops:error', this.deps);
    if (!parsed) return;
    const payload = parsed;
    const operationId = crypto.randomUUID();
    // Follows the object in progress (see handleBackup).
    const failure: OperationFailureContext = { module: 'dataops', operation: msg.type };

    // A template the user saved is applied the way one that ships is.
    const template = this.findTemplate(payload.templateId);
    /** The objects the run addresses: Account joins them once the org says it has person accounts. */
    let plannedObjects = plannedAnonymizeObjects(payload, template);

    /** The masking run as the audit trail records it: read from the org, written back to it. */
    const run: WriteRun = {
      action: 'anonymize_execute',
      module: 'dataops',
      operationId,
      orgId: payload.orgId,
      outcome: 'failure',
      source: { origin: 'org', orgId: payload.orgId },
    };
    /** Per object, the rows it held and what the run did with them so far. */
    const tallies: MaskingTally[] = [];
    /** Per object, its rules, its counts, and how far the run got through it. */
    const work: MaskingWork[] = [];
    /** The filter the run holds the rows of its one object to, if it was given one. */
    const where = filterOf(payload);
    /** What a checkpoint of this run is good for: its rules, its objects and its filter. */
    let fingerprint = template ? maskingFingerprint(template.rules, plannedObjects, where) : '';
    /**
     * Whether every object the run addresses has been counted and the guard
     * let it go ahead: until then, how many rows a run that stops leaves is
     * not said.
     */
    let counted = false;
    /**
     * True from the moment the run is announced until its end is recorded: it
     * stops at the first object it may not write, and must still be recorded.
     */
    let unrecorded = false;
    /**
     * Whether the run was announced: from then on, where it got is kept, or
     * forgotten, when it ends — however it ends.
     */
    let begun = false;
    /** Whether the end of the run already kept or forgot where it got. */
    let checkpointSettled = false;
    /** The engine the run masks with, once made: what it drew is kept for a resume. */
    let drawing: AnonymizationEngine | undefined;
    /**
     * The snapshot taken before the first write, when the request asked for
     * one: every answer of the run names it, a failure's too, since that is
     * when a restore is wanted.
     */
    let snapshot: { operationId: string; totalRecords: number } | undefined;
    /**
     * Aborted by the registry: a cancel of the run, the window closing. A run
     * was never registered, so nothing could stop it, and it masked every
     * batch of every object to its end.
     */
    const stop = new AbortController();
    /** Settles the promise the registry watches, so it stops listing the run. */
    let settleRun: (error?: unknown) => void = () => {};
    /** What the run failed on, read by `settleRun` in `finally`. */
    let runError: unknown;

    /**
     * End the run on what it failed on, on both channels the page listens on.
     * Once every object was counted, both say what the run masked before it
     * stopped and, per object, how many rows still hold their original values:
     * a run that failed half-way through used to say only what the org said,
     * and nothing told the user half the org was still unmasked.
     */
    const failRun = (err: unknown, retryable: boolean): void => {
      runError = err;
      const reason = extractErrorMessage(err);
      const totals = maskingTotals(tallies);
      const left = counted && totals.recordsNotMasked > 0;
      const extraPayload = {
        ...(counted ? { ...totals, objects: maskingResultObjects(tallies) } : {}),
        ...(snapshot ? { snapshot } : {}),
      };
      sendHandlerError(
        this.deps,
        'dataops:anonymize',
        'dataops:error',
        msg,
        left
          ? new Error(
              `${reason} — ${totals.recordsProcessed} masked before it stopped; ` +
                `${totals.recordsNotMasked} still hold their original values ` +
                `(${leftByObject(tallies)}).`,
            )
          : err,
        { code: guardRefusalCode(err), extraPayload },
      );
      sendOperationFailed(this.deps, operationId, reason, retryable, {
        context: failure,
        extraPayload,
      });
    };

    /**
     * Keep where the run got when it left rows holding their original values,
     * so that Resume masks only those; forget it once nothing is left. A run
     * masks every row it reads, and a second run over rows the first one
     * masked masks them again: an address it hashed is still an address, and
     * is hashed once more, so the same address no longer gives the same
     * pseudonym on Contact and on Lead.
     *
     * Kept outside the org: losing it costs a resume, never the run's result,
     * so a store that cannot keep it is logged and the run ends as it did.
     *
     * @returns Whether a run of this template on this org can now be resumed.
     */
    const settleCheckpoint = (): boolean => {
      checkpointSettled = true;
      const checkpoints = new MaskingCheckpointStore(this.deps.configStore);
      const { recordsNotMasked } = maskingTotals(tallies);
      // A call whose answer never came may have changed the org as well.
      const handled = tallies.reduce(
        (sum, t) => sum + t.masked + t.nothingToMask + t.refused + t.unanswered,
        0,
      );
      try {
        if (recordsNotMasked === 0) {
          checkpoints.clear(payload.orgId, payload.templateId);
          return false;
        }
        // A run that handled no row changed nothing in the org: where the run
        // before it stopped is still where the org stands.
        if (handled === 0) {
          return checkpoints.load(payload.orgId, payload.templateId, fingerprint) !== undefined;
        }
        const objects = work.map((w) => w.progress);
        if (refusedCount(objects) > MAX_CHECKPOINT_REFUSED) {
          this.deps.log(
            `[WARN] dataops:anonymize ${operationId}: the org refused ${refusedCount(objects)} ` +
              `record(s), more than a resume retries (${MAX_CHECKPOINT_REFUSED}): only a full run masks them.`,
          );
          checkpoints.clear(payload.orgId, payload.templateId);
          return false;
        }
        checkpoints.save({
          id: operationId,
          orgId: payload.orgId,
          templateId: payload.templateId,
          fingerprint,
          savedAt: new Date().toISOString(),
          objects,
          // The names the run made up, counted: a resume gives none of them
          // again. A resume of a run that kept none adds its own to nothing.
          ...(drawing ? { namesGiven: drawing.namesGiven() } : {}),
        });
        return true;
      } catch (err: unknown) {
        this.deps.log(
          `[WARN] dataops:anonymize ${operationId}: where the run stopped was not kept: ` +
            extractErrorMessage(err),
        );
        return false;
      }
    };

    try {
      const guard = this.deps.infraServices?.productionGuard;
      if (!guard) {
        this.refuseWithoutGuard('dataops:anonymize', msg, operationId, failure, run);
        return;
      }
      // Before anything is counted: an unknown template has nothing to count.
      if (!template) {
        this.refuseUnknownTemplate('dataops:anonymize', msg, payload.templateId);
        return;
      }

      /**
       * The objects the run addresses with Account planned for its person
       * accounts, and what a checkpoint of that run is good for: which of the
       * two plans holds is the org's to say, asked once it is reached.
       */
      const withPersons = personRowsOnly(payload, template, ACCOUNT)
        ? plannedAnonymizeObjects(payload, template, true)
        : undefined;
      const fingerprints = withPersons
        ? [fingerprint, maskingFingerprint(template.rules, withPersons, where)]
        : [fingerprint];
      const refuseResume = (): void =>
        sendHandlerError(
          this.deps,
          'dataops:anonymize',
          'dataops:error',
          msg,
          new Error(
            'There is nothing to resume: the run has finished since, another run of this ' +
              'template has stopped since, or its rules have changed. Apply masks every record ' +
              'of its objects.',
          ),
          { code: NOTHING_TO_RESUME },
        );

      /** Where the run this one resumes stopped; a run asked for whole starts from nothing. */
      let resumed: MaskingCheckpoint | undefined;
      if (payload.resumeFrom !== undefined) {
        const checkpoints = new MaskingCheckpointStore(this.deps.configStore);
        resumed = fingerprints
          .map((kept) => checkpoints.load(payload.orgId, payload.templateId, kept))
          .find((checkpoint) => checkpoint?.id === payload.resumeFrom);
        // Another run since, a run that finished, or rules edited since: what
        // the page offered to resume is not where the org stands, and a run
        // from the first row would mask again what was masked.
        if (!resumed) {
          refuseResume();
          return;
        }
      }

      const conn = await getJsforceConnection(
        payload.orgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );
      if (withPersons && (await orgHasPersonAccounts(conn, this.deps.log))) {
        plannedObjects = withPersons;
        fingerprint = fingerprints[1];
      }
      // The run resumed planned other objects than the org now gives: its
      // person accounts came or went since.
      if (resumed && resumed.fingerprint !== fingerprint) {
        refuseResume();
        return;
      }

      /** The org's API usage, once it passed the line past which the run makes no call. */
      let apiLimit: SforceLimitInfo | undefined;
      /** Log the org's API usage after a call, and keep it once it passes that line. */
      const noteApiUsage = (context: string): void => {
        const usage = checkApiLimits(conn.limitInfo, context);
        if (usage && usage.usagePercent >= MASKING_API_STOP_PERCENT) apiLimit ??= usage;
      };
      /** Where the org's API usage stood when the run stopped on it, if it did. */
      const usageAtStop = (): SforceLimitInfo | undefined => apiLimit;

      // Every object is counted before the guard is asked and before anything
      // is written. The guard was asked first, with no count: a production
      // confirmation said 'UPDATE an unknown number of records', and the
      // warning past 50 000 rows never fired on a sandbox, whose tier only
      // warns. The progress counts rows against these totals, and a run that
      // stops says from them how many rows of each object it left. A resume
      // counts what the run it resumes left: the rows past where it stopped,
      // and the ones the org refused.
      for (const objectName of plannedObjects) {
        const objectRules = rulesOfObject(template, objectName);
        const personRules = personRulesOfObject(template, objectName);
        if (objectRules.length === 0 && personRules.length === 0) continue;
        const safeObj = sanitizeSoqlObjectName(objectName);
        const objectWhere = whereOfObject(payload, template, objectName);
        failure.objectName = safeObj;
        const from = resumed?.objects.find((o) => o.objectApiName === safeObj);
        const progress: MaskingProgress = {
          objectApiName: safeObj,
          done: from?.done ?? false,
          ...(from?.afterId !== undefined ? { afterId: from.afterId } : {}),
          refused: [...(from?.refused ?? [])],
          ...(from?.unconfirmed?.length ? { unconfirmed: [...from.unconfirmed] } : {}),
        };
        let toRead = 0;
        if (!progress.done) {
          try {
            toRead = await this.countRows(conn, safeObj, progress.afterId, objectWhere);
          } catch (err: unknown) {
            // Before the guard is asked and before anything is written: the
            // run ends here, and is recorded as a failure with the object and
            // the org's reason, as a run a check of its own stops is. Once
            // the counts came before the guard, such a run left no entry.
            recordWriteRun(this.deps, {
              ...run,
              outcome: 'failure',
              source: undefined,
              objects: [emptyCounts(safeObj)],
              code: COUNT_FAILED,
              details: { reason: orgReasonCode(err) },
            });
            throw err;
          }
          noteApiUsage(`dataops:anonymize count ${safeObj}`);
          if (toRead === 0) progress.done = true;
        }
        const total = toRead + progress.refused.length + (progress.unconfirmed?.length ?? 0);
        const tally: MaskingTally = {
          objectApiName: safeObj,
          total,
          masked: 0,
          nothingToMask: 0,
          refused: 0,
          unanswered: 0,
          done: total === 0,
        };
        tallies.push(tally);
        work.push({
          objectName,
          ...(objectWhere !== undefined ? { where: objectWhere } : {}),
          objectRules,
          personRules,
          tally,
          progress,
        });
      }
      const grandTotal = tallies.reduce((sum, t) => sum + t.total, 0);

      const org = this.deps.orgManager.getOrg(payload.orgId);
      const guardRequest = {
        orgId: payload.orgId,
        // A Developer Edition org as the development org it is (see `writeTier`).
        orgTier: writeTier(org),
        operation: 'update' as const,
        // The objects the run addresses, so a production confirmation
        // names them instead of an opaque 'AnonymizeData'.
        objectName: plannedObjects.join(', ') || 'AnonymizeData',
        // The rows counted above: every one of them is written over. A run
        // the guard stops has made these counts, and no write.
        recordCount: grandTotal,
        module: 'dataops',
      };
      const { check, decision } = await consultProductionGuard(guard, guardRequest);
      run.guard = decision;
      if (decision === 'refused' || decision === 'declined') {
        recordWriteRun(this.deps, { ...run, outcome: 'stopped', source: undefined });
      }
      if (decision === 'refused') {
        throw guardBlockedError(check.blockedReason ?? check.impactSummary);
      }
      // `safety.requireProdConfirmation`: explicit user consent before
      // writing to a production org.
      if (decision === 'declined') {
        const message = 'Operation cancelled by user (production confirmation declined).';
        sendHandlerError(this.deps, 'dataops:anonymize', 'dataops:error', msg, new Error(message), {
          code: GUARD_REFUSAL.declined,
        });
        sendOperationFailed(this.deps, operationId, message, false, { context: failure });
        return;
      }
      // A tier that asks nothing still says what it saw: a run past 50 000
      // rows on a sandbox.
      for (const warning of check.warnings) {
        this.deps.log(`[WARN] dataops:anonymize ${operationId}: ${warning}`);
      }
      counted = true;

      // The org's tier sets how many rows a page reads: 2,000 on a sandbox, 500
      // on production. It used to be how many rows of each object a run read at
      // all: the rows past it were never masked, the progress counted only what
      // was read, and the run said it had succeeded.
      const anonOrgTier = resolveOrgTier(org?.orgType === 'Sandbox' || org?.orgType === 'Scratch');
      const pageSize = getQueryLimits(anonOrgTier).defaultQueryLimit;

      // Create CrudFlsGuard for permission checks before DML
      const crudFlsGuard = new CrudFlsGuard(async (objectApiName: string) => {
        const desc = await conn.describe(objectApiName);
        return describeToObjectDescribe(desc);
      });

      // A snapshot of what the run is about to write over, when asked: after
      // the guard, which may stop the run, and before the first write.
      if (payload.snapshot === true) {
        const kept = await this.snapshotBeforeMasking(conn, operationId, payload.orgId, work, {
          origin: msg.type,
          stop: stop.signal,
        });
        if ('refused' in kept) {
          recordWriteRun(this.deps, {
            ...run,
            outcome: 'stopped',
            source: undefined,
            code: SNAPSHOT_NOT_TAKEN,
          });
          sendHandlerError(
            this.deps,
            'dataops:anonymize',
            'dataops:error',
            msg,
            new Error(kept.refused),
            { code: SNAPSHOT_NOT_TAKEN },
          );
          sendOperationFailed(this.deps, operationId, kept.refused, kept.retryable, {
            context: failure,
          });
          return;
        }
        snapshot = kept.taken;
      }

      const description = `Anonymizing with ${template.name}`;
      sendOperationStarted(this.deps, operationId, 'dataops', description);
      unrecorded = true;
      begun = true;
      this.deps.infraServices?.backgroundRegistry?.register(
        operationId,
        'dataops',
        description,
        new Promise<void>((resolve, reject) => {
          settleRun = (error) => {
            if (error === undefined) resolve();
            else reject(error instanceof Error ? error : new Error(String(error)));
          };
        }),
        stop,
      );

      const { AnonymizationEngine } = await import('../../modules/dataops/AnonymizationEngine.js');
      // The window's key, not a fresh random one: see `maskingKey`.
      const engine = new AnonymizationEngine(undefined, this.maskingKey);
      drawing = engine;
      // A resume carries on from the names the run it resumes made up: one
      // starting with none given handed out again, to the rows it masked, the
      // names and the addresses that run had written on others.
      if (
        resumed &&
        !(resumed.namesGiven !== undefined && engine.continueFrom(resumed.namesGiven))
      ) {
        this.deps.log(
          `[INFO] dataops:anonymize ${operationId}: the run it resumes kept no record of the ` +
            'names it made up, so this one may give again a name or an address that run gave.',
        );
      }

      const maskErrors: Array<{ objectApiName: string; message: string }> = [];
      /** The fields the template's rules name that their object does not have. */
      const fieldsNotFound: Array<{ objectApiName: string; fieldApiName: string }> = [];
      /** Whether a cancel stopped the run before every record it was for was masked. */
      let cancelled = false;

      /** Rows of one object the run is done with: masked, refused, or holding nothing to mask. */
      const doneWith = (t: MaskingTally): number => t.masked + t.nothingToMask + t.refused;
      /** Progress over the rows of every object, counted against what the counts said. */
      const reportProgress = (objectName: string, tally: MaskingTally): void => {
        const handled = tallies.reduce((sum, t) => sum + doneWith(t), 0);
        // A row created while the run goes can be read past the count.
        const total = Math.max(grandTotal, handled);
        sendOperationProgress(
          this.deps,
          operationId,
          Math.round((handled / total) * 100),
          handled,
          total,
          `Anonymized ${objectName} (${doneWith(tally)}/${Math.max(tally.total, doneWith(tally))})`,
        );
      };

      for (const {
        objectName,
        where: objectWhere,
        objectRules,
        personRules,
        tally,
        progress,
      } of work) {
        if (tally.total === 0) continue;
        if (stop.signal.aborted) {
          cancelled = true;
          break;
        }
        if (usageAtStop()) break;
        const safeObj = tally.objectApiName;
        failure.objectName = safeObj;

        // Verify CRUD/FLS permissions before update: a field of a person
        // account the org lacks is not asked about, as any field it lacks.
        const updateFieldNames = [...objectRules, ...personRules]
          .map((r) =>
            r.fieldPattern.includes('.') ? r.fieldPattern.split('.')[1] : r.fieldPattern,
          )
          .filter((f) => f !== '*');
        const flsCheck = await crudFlsGuard.checkCrudAndFls(safeObj, 'update', updateFieldNames);
        if (!flsCheck.allowed) {
          this.deps.log(
            `[WARN] CRUD/FLS check failed for anonymize on ${safeObj}: ${flsCheck.reason}`,
          );
          failRun(new Error(flsCheck.reason), false);
          return;
        }

        const templateRules = this.maskingRules(objectName, objectRules);
        const {
          select: fields,
          missing,
          rulesOf,
        } = await this.maskedFields(
          conn,
          safeObj,
          templateRules,
          this.maskingRules(objectName, personRules),
        );
        if (missing.length > 0) {
          fieldsNotFound.push(
            ...missing.map((fieldApiName) => ({ objectApiName: safeObj, fieldApiName })),
          );
          this.deps.log(
            `[WARN] dataops:anonymize ${operationId}: ${safeObj} has no field ` +
              `${missing.join(', ')} — the template's rule masks nothing there.`,
          );
        }
        failure.batchSize = MASKING_BATCH_SIZE;

        /**
         * Mask rows read from the object and write them back, two hundred an
         * update, handing each batch the org answered to `onAnswered` with the
         * ids it refused, and the batch whose answer never came back to
         * `onUnanswered`, with what it sent, before the error goes on. A
         * cancel, or the org's API usage passing the line, is honoured before
         * each batch.
         *
         * @returns Whether it stopped before every batch was written.
         */
        const writeBack = async (
          records: Array<Record<string, unknown>>,
          onAnswered: (batch: ReadonlyArray<Record<string, unknown>>, refused: string[]) => void,
          onUnanswered: (
            batch: ReadonlyArray<Record<string, unknown>>,
            sent: UnconfirmedRow[],
          ) => void,
        ): Promise<boolean> => {
          // Each row by the rules its kind of account can hold: see `maskedFields`.
          const rulesOfEach = records.map(rulesOf);
          const anonymized = records.map(
            (record, index) => engine.anonymize([record], rulesOfEach[index])[0],
          );

          // Only the Id and the template's fields that held something go back.
          // Each record used to go back with every field it was read with — its
          // audit dates, its compound name and address and every flag the org
          // keeps — and Salesforce refuses a record carrying any of those,
          // whole — Sync and Autopilot saw it refuse every record of a run over
          // the same fields — so no record could be masked. An empty field
          // holds nobody's data, and a value made up for it — a fake street,
          // the digest of nothing, which an Email field refuses along with the
          // rest of the record — is data the record never had.
          const payloads: Array<Record<string, unknown>> = [];
          records.forEach((original, index) => {
            const update: Record<string, unknown> = { Id: original.Id };
            for (const rule of rulesOfEach[index]) {
              if (isFilledValue(original[rule.fieldApiName])) {
                update[rule.fieldApiName] = anonymized[index][rule.fieldApiName];
              }
            }
            // A record none of whose masked fields held anything is done, as
            // an erasure counts one; the audit trail keeps to what was written.
            if (Object.keys(update).length > 1) payloads.push(update);
            else tally.nothingToMask++;
          });

          type JsforceResult = {
            success: boolean;
            id?: string;
            errors?: Array<{ message: string }>;
          };
          for (let bi = 0; bi < payloads.length; bi += MASKING_BATCH_SIZE) {
            // A cancel stops the run before each batch, with what the batches
            // before it masked counted. The first batch included, as in the
            // writer Sync writes through: the run looks at the cancel once the
            // page is read, and nothing between that and the first batch waits
            // today, but a cancel that came between them would still send two
            // hundred records.
            if (stop.signal.aborted) {
              cancelled = true;
              return true;
            }
            if (usageAtStop()) return true;
            const batch = payloads.slice(bi, bi + MASKING_BATCH_SIZE);
            // The waiver the restore's upsert sends: a duplicate rule can block
            // an edit as it blocks a create, and a masked record that the rule
            // refuses keeps its real values.
            let updateResults: JsforceResult[];
            try {
              updateResults = (await conn
                .sobject(objectName)
                .update(batch as Array<Record<string, unknown> & { Id: string }>, {
                  headers: recordWriteHeaders(),
                })) as unknown as JsforceResult[];
            } catch (err: unknown) {
              // The request went out and no answer came: the org may have
              // masked any row of it, each committed on its own, and a resume
              // that sent them again would mask those a second time, another
              // way. What was sent is kept, as a digest, for the resume to
              // read back first. A call the org never had, or refused whole,
              // wrote nothing, and is sent again as it was.
              if (whatTheWriteLeft(err) === 'may-have-written') {
                tally.unanswered += batch.length;
                onUnanswered(batch, batch.flatMap(unconfirmedRowOf));
              }
              throw err;
            }
            noteApiUsage(`dataops:anonymize update ${safeObj}`);
            // Same dropped count as the restore: a record the org refuses keeps
            // its real PII, and reporting only the successes hid exactly that.
            const refusedIds: string[] = [];
            const answers = Array.isArray(updateResults) ? updateResults : [updateResults];
            answers.forEach((r, i) => {
              if (r.success) {
                tally.masked++;
                return;
              }
              tally.refused++;
              const id = batch[i]?.Id;
              if (typeof id === 'string' && RECORD_ID.test(id)) refusedIds.push(id);
              collectDmlError(maskErrors, safeObj, r.errors);
            });
            onAnswered(batch, refusedIds);
            reportProgress(objectName, tally);
          }
          // Rows that held nothing to mask are done with all the same.
          if (payloads.length === 0) reportProgress(objectName, tally);
          return false;
        };

        // A resume first reads back, by Id, the rows of the update whose
        // answer never came: those that hold what it sent were masked, and
        // are done with; the others hold their original values, and are
        // tried again with the rows the org refused. Sent again unread, a
        // row the update did mask was masked a second time, another way.
        const unconfirmed = progress.unconfirmed ?? [];
        for (let i = 0; i < unconfirmed.length; i += MASKING_BATCH_SIZE) {
          if (stop.signal.aborted) {
            cancelled = true;
            break;
          }
          if (usageAtStop()) break;
          const part = unconfirmed.slice(i, i + MASKING_BATCH_SIZE);
          const ids = part.map((row) => `'${row.id}'`).join(', ');
          const rows = await queryAll<Record<string, unknown>>(
            conn,
            `SELECT ${fields} FROM ${safeObj} WHERE Id IN (${ids})`,
          );
          noteApiUsage(`dataops:anonymize query ${safeObj}`);
          const read = new Map(rows.map((row) => [String(row.Id), row]));
          const original: string[] = [];
          for (const sent of part) {
            const row = read.get(sent.id);
            // A row deleted since holds nothing left to mask.
            if (row === undefined) tally.total -= 1;
            else if (sentValuesDigest(row, sent.fields) === sent.digest) tally.nothingToMask++;
            else original.push(sent.id);
          }
          const checked = new Set(part.map((row) => row.id));
          const left = (progress.unconfirmed ?? []).filter((row) => !checked.has(row.id));
          if (left.length > 0) progress.unconfirmed = left;
          else delete progress.unconfirmed;
          progress.refused.push(...original);
        }
        if (cancelled || usageAtStop()) break;

        // A resume then tries again, by Id, the rows the org refused last
        // time: they hold their original values, and lie behind where the run
        // it resumes stopped, so reading on from there never reaches them.
        const retry = [...progress.refused];
        for (let i = 0; i < retry.length; i += MASKING_BATCH_SIZE) {
          if (stop.signal.aborted) {
            cancelled = true;
            break;
          }
          if (usageAtStop()) break;
          const ids = retry.slice(i, i + MASKING_BATCH_SIZE);
          const rows = await queryAll<Record<string, unknown>>(
            conn,
            `SELECT ${fields} FROM ${safeObj} WHERE Id IN (${ids.map((id) => `'${id}'`).join(', ')})`,
          );
          noteApiUsage(`dataops:anonymize query ${safeObj}`);
          // A row deleted since holds nothing left to mask.
          tally.total -= ids.length - rows.length;
          const refusedAgain: string[] = [];
          const stopped = await writeBack(
            rows,
            (_batch, refused) => refusedAgain.push(...refused),
            (_batch, sent) => {
              // No longer known to hold their original values: read back first.
              const unsure = new Set(sent.map((row) => row.id));
              progress.refused = progress.refused.filter((id) => !unsure.has(id));
              progress.unconfirmed = [...(progress.unconfirmed ?? []), ...sent];
            },
          );
          if (stopped) break;
          const tried = new Set(ids);
          progress.refused = [...progress.refused.filter((id) => !tried.has(id)), ...refusedAgain];
        }
        if (cancelled || usageAtStop()) break;
        if (progress.done) {
          tally.done = true;
          continue;
        }

        // Page after page to the object's last row, each written back before
        // the next is read, so the run holds one page whatever the object's
        // size. A cancel, or the org's API usage passing the line, is honoured
        // before the next page, and before each batch of this one. A resume
        // reads on from the last row the run it resumes handled.
        let afterId: string | undefined = progress.afterId;
        for (;;) {
          if (stop.signal.aborted) {
            cancelled = true;
            break;
          }
          if (usageAtStop()) break;
          const page = await maskingPage(conn, safeObj, fields, pageSize, afterId, objectWhere);
          noteApiUsage(`dataops:anonymize query ${safeObj}`);
          if (page.records.length === 0) {
            tally.done = true;
            progress.done = true;
            break;
          }
          // Where the next page starts, taken before this one is written: a
          // page that does not end past the one before it is not written twice.
          const nextAfterId = page.truncated ? pageEnd(page.records, afterId, safeObj) : undefined;

          // Reading a page takes a while: a cancel that came meanwhile is
          // honoured before any of it is written.
          if (stop.signal.aborted) {
            cancelled = true;
            break;
          }

          // Every row of the page up to the last of a batch the org answered
          // is done with: a run that stops between two batches resumes after it.
          // A batch whose answer never came is gone past as well: a resume
          // reads its rows back by Id rather than send them again.
          const passBatch = (batch: ReadonlyArray<Record<string, unknown>>): void => {
            const lastId = batch[batch.length - 1]?.Id;
            if (typeof lastId === 'string' && RECORD_ID.test(lastId)) progress.afterId = lastId;
          };
          const stopped = await writeBack(
            page.records,
            (batch, refused) => {
              progress.refused.push(...refused);
              passBatch(batch);
            },
            (batch, sent) => {
              progress.unconfirmed = [...(progress.unconfirmed ?? []), ...sent];
              passBatch(batch);
            },
          );
          if (stopped) break;
          // A page that came back short was the last one.
          if (nextAfterId === undefined) {
            tally.done = true;
            progress.done = true;
            break;
          }
          afterId = nextAfterId;
          progress.afterId = nextAfterId;
        }
        if (cancelled || usageAtStop()) break;
      }

      const limitHit = usageAtStop();
      const status = maskingStatus(tallies, cancelled);
      const { recordsProcessed, recordsFailed, recordsNotMasked } = maskingTotals(tallies);
      const left = leftByObject(tallies);
      unrecorded = false;
      recordWriteRun(this.deps, {
        ...run,
        ...maskingAuditOutcome(tallies, status, cancelled),
        objects: maskingAuditCounts(tallies),
      });
      const resumable = settleCheckpoint();
      if (recordsNotMasked > 0) {
        const why = cancelled
          ? 'cancelled'
          : limitHit
            ? `stopped at ${limitHit.usagePercent}% of the org's API requests`
            : 'refused by the org';
        this.deps.log(
          `[WARN] dataops:anonymize ${operationId} ${why}: ${recordsNotMasked} record(s) ` +
            `not masked — ${left}`,
        );
      }
      if (cancelled) {
        // Ended the way a cancelled Sync or Seed ends: aborted in the registry
        // — already, when the cancel came through it — and posted as a
        // completion that says so, with what it masked before it stopped.
        this.deps.infraServices?.backgroundRegistry?.abort(operationId);
        sendOperationCompleted(this.deps, operationId, {
          aborted: true,
          totalProcessed: recordsProcessed,
          totalFailed: recordsFailed,
          totalNotMasked: recordsNotMasked,
        });
      } else {
        sendOperationCompleted(this.deps, operationId, {
          status,
          totalProcessed: recordsProcessed,
          totalFailed: recordsFailed,
          totalNotMasked: recordsNotMasked,
        });
      }

      const stillHeld = `${recordsNotMasked} still hold their original values (${left})`;
      const ranMessage = cancelled
        ? `Anonymization cancelled: ${recordsProcessed} masked before the cancel — ${stillHeld}.`
        : limitHit
          ? `Anonymization stopped at ${limitHit.usagePercent}% of the org's daily API requests ` +
            `(${limitHit.apiUsage} of ${limitHit.apiLimit}): ${recordsProcessed} masked — ` +
            `${stillHeld}. ${resumable ? 'Resume it' : 'Run it again'} once the org has ` +
            'requests to spare.'
          : recordsFailed === 0
            ? `Anonymization completed: ${recordsProcessed} records processed.`
            : `Anonymization ${status}: ${recordsProcessed} masked, ${recordsFailed} rejected by the org` +
              ' — those records still hold their original values.';
      // Said once the run left something a resume can mask, and not for a run
      // that left nothing.
      const resumeHint =
        resumable && recordsNotMasked > 0 ? ' Resume masks only what this run left.' : '';
      const message =
        (fieldsNotFound.length > 0
          ? `${ranMessage} Masked nothing in ${fieldsNotFound
              .map((f) => `${f.objectApiName}.${f.fieldApiName}`)
              .join(', ')}: the org has no such field.`
          : ranMessage) + resumeHint;
      const response = buildResponse(this.deps, msg, 'dataops:anonymize:response', {
        templateId: payload.templateId,
        status,
        recordsProcessed,
        recordsFailed,
        recordsNotMasked,
        objects: maskingResultObjects(tallies),
        message,
        errors: maskErrors,
        fieldsNotFound,
        ...(cancelled ? { cancelled: true } : {}),
        ...(limitHit ? { stoppedAtApiLimit: true } : {}),
        ...(snapshot ? { snapshot } : {}),
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id} status=${status}`);
      // The page shows a run's end through this notification and nothing
      // else: a run that left records unmasked, for whatever reason, says so,
      // as does one whose template named a field the org does not have.
      if (recordsNotMasked > 0 || fieldsNotFound.length > 0) {
        sendNotification(
          this.deps,
          status === 'failure' ? 'error' : 'warning',
          'Anonymize',
          `${message}${maskErrors[0] ? ` — e.g. ${maskErrors[0].message}` : ''}`,
        );
      }
    } catch (err: unknown) {
      // An error the org answered while a cancel was pending is still the
      // run's failure: only the loop, stopping at the cancel, says a run was
      // cancelled. Dual channel, single display (see handleBackup).
      failRun(err, true);
    } finally {
      // A run that stopped at an object it may not write, or threw, after it
      // started: recorded with what it masked — partial once it wrote a row,
      // failed otherwise — and, per object, the rows it never reached.
      if (unrecorded) {
        const wrote = tallies.some((t) => t.masked > 0);
        recordWriteRun(this.deps, {
          ...run,
          outcome: wrote ? 'partial' : 'failure',
          objects: counted ? maskingAuditCounts(tallies) : [],
        });
      }
      // And where it got is kept for a resume, as for a run that ended on its own.
      if (begun && !checkpointSettled) settleCheckpoint();
      settleRun(runError);
    }
  }

  private handleAnonymizationTemplates(msg: InboundRequest): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const templates = this.listedTemplates();
    const response = buildResponse(this.deps, msg, 'dataops:anonymization-templates:response', {
      templates,
    });
    this.deps.broker.postToWebview(response);
    this.deps.log(`[TX] dataops:anonymization-templates:response`);
  }

  /** Every template the page lists: those that ship, then those the user saved. */
  private listedTemplates(): ListedAnonymizationTemplate[] {
    return [...ANONYMIZATION_TEMPLATES, ...this.savedTemplates.list()];
  }

  /**
   * Answer `backup:objects`: the objects the Backup tab reads before an
   * Anonymize — those a masking run of the template picked plans in the org,
   * or of every template listed when none is picked, in the order their rules
   * first name them (`plannedAnonymizeObjects`). The tab read the objects the
   * rules name, so a template masking contacts in an org with person accounts
   * took no backup of the accounts the run masks too, which the run's own
   * snapshot holds. Whether the org has person accounts is asked once, and
   * only for a template that needs it. Read-only.
   */
  private async handleBackupObjects(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(
      dataOpsBackupObjectsPayloadSchema,
      msg,
      'dataops:error',
      this.deps,
    );
    if (!parsed) return;
    const picked =
      parsed.templateId !== undefined ? this.findTemplate(parsed.templateId) : undefined;
    if (parsed.templateId !== undefined && !picked) {
      this.refuseUnknownTemplate('backup:objects', msg, parsed.templateId);
      return;
    }
    try {
      let persons: Promise<boolean> | undefined;
      const personAccounts = (): Promise<boolean> =>
        (persons ??= getJsforceConnection(
          parsed.orgId,
          this.deps.orgRegistry,
          this.deps.orgManager,
        ).then((conn) => orgHasPersonAccounts(conn, this.deps.log)));
      const objects: string[] = [];
      for (const template of picked ? [picked] : this.listedTemplates()) {
        const withPersons = personRowsOnly({}, template, ACCOUNT) && (await personAccounts());
        for (const name of plannedAnonymizeObjects({}, template, withPersons)) {
          // A wildcard rule names no object a backup can read.
          if (name !== '' && name !== '*' && !objects.includes(name)) objects.push(name);
        }
      }
      const response = buildResponse(this.deps, msg, 'backup:objects:response', { objects });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id} objects=${objects.length}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'backup:objects', 'dataops:error', msg, err);
    }
  }

  /**
   * The objects a coverage or a preview reads for a request, as the run it
   * stands for plans them (`plannedAnonymizeObjects`): Account among them in
   * an org with person accounts, which is asked only when it decides.
   */
  private async plannedObjectsIn(
    conn: { describe: (objectApiName: string) => Promise<{ fields: MaskableField[] }> },
    payload: { objects?: string[] },
    template: ListedAnonymizationTemplate,
  ): Promise<string[]> {
    const persons =
      personRowsOnly(payload, template, ACCOUNT) &&
      (await orgHasPersonAccounts(conn, this.deps.log));
    return plannedAnonymizeObjects(payload, template, persons);
  }

  /**
   * Answer `dataops:anonymize:coverage`: before an Anonymize, how many rows of
   * each object the template masks the org holds, and how many of them its
   * latest backup holds — what a restore can bring back once the run has
   * masked them all.
   *
   * A backup reads each object up to a cap of rows the user sets
   * (`sandforge.backup.maxRecordsPerObject`), and a masking run masks every
   * row: a backup taken just before an Anonymize of an object larger than the
   * cap brings back that many rows and leaves the rest masked, and nothing
   * said so. Each object says whether its backup stopped at the cap, or on a
   * read that failed. Read-only: one count per object, and the backups kept
   * on this machine. An object the org will not count is listed with no count
   * rather than failing the answer.
   *
   * Asked with the objects and the filter a run would be given, it counts
   * what that run would mask, and finds the checkpoint that run would resume:
   * an object the template has no rule for is not listed, as the run masks
   * nothing there.
   */
  private async handleAnonymizeCoverage(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(
      dataOpsAnonymizeCoveragePayloadSchema,
      msg,
      'dataops:error',
      this.deps,
    );
    if (!parsed) return;
    const template = this.findTemplate(parsed.templateId);
    if (!template) {
      this.refuseUnknownTemplate('dataops:anonymize:coverage', msg, parsed.templateId);
      return;
    }
    try {
      const backup = this.latestBackup(parsed.orgId);
      const conn = await getJsforceConnection(
        parsed.orgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );
      const objects: AnonymizeCoverageObject[] = [];
      const planned = await this.plannedObjectsIn(conn, parsed, template);
      for (const objectName of planned) {
        if (!masksObject(template, objectName)) continue;
        const objectApiName = sanitizeSoqlObjectName(objectName);
        let count: number | null = null;
        try {
          count = await this.countRows(
            conn,
            objectApiName,
            undefined,
            whereOfObject(parsed, template, objectName),
          );
        } catch (err: unknown) {
          this.deps.log(
            `[WARN] dataops:anonymize:coverage: ${objectApiName} not counted: ${extractErrorMessage(err)}`,
          );
        }
        const held = backup?.objects.find(
          (o) => o.objectApiName.toLowerCase() === objectApiName.toLowerCase(),
        );
        objects.push({
          objectApiName,
          count,
          backedUp: held?.recordCount ?? 0,
          truncated: held?.truncated === true,
          ...(held?.stoppedAt ? { stoppedAt: held.stoppedAt } : {}),
        });
      }
      // The last run of this template on this org, when it stopped short and
      // its rules are still the template's: the page offers to resume it.
      const checkpoint = new MaskingCheckpointStore(this.deps.configStore).load(
        parsed.orgId,
        parsed.templateId,
        maskingFingerprint(template.rules, planned, filterOf(parsed)),
      );
      const response = buildResponse(this.deps, msg, 'dataops:anonymize:coverage:response', {
        templateId: parsed.templateId,
        ...(backup
          ? { backup: { operationId: backup.operationId, timestamp: backup.timestamp } }
          : {}),
        objects,
        ...(checkpoint ? { checkpoint: { id: checkpoint.id, savedAt: checkpoint.savedAt } } : {}),
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id} objects=${objects.length}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'dataops:anonymize:coverage', 'dataops:error', msg, err);
    }
  }

  /**
   * Answer `dataops:anonymize:preview`: before an Anonymize, the first rows of
   * each object the template masks, each masked field as the org holds it
   * and as Apply would write it.
   *
   * Read-only: a describe and one page of {@link PREVIEW_ROWS} rows per object,
   * the page a run reads first, and no update — so neither the guard nor the
   * org lock stands in its way. The panel offered a Preview that ran the
   * irreversible mutation itself, and then none: Apply masked every row of
   * the org with nothing shown before.
   *
   * The rows are masked as a run of this window masks them: the same rules,
   * settings and key, one engine across the objects in the run's order. A
   * digest, a mask, a constant or a truncation is what Apply writes. A made-up
   * name is too on the first object; on the next ones Apply may draw another
   * for a record whose name an earlier record of the run already took, which
   * only a run through every record before it can tell. An object the org will
   * not describe or read is listed with what it said rather than failing the
   * answer. Asked with the objects and the filter a run would be given, it
   * shows the first rows that run would mask.
   */
  private async handleAnonymizePreview(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(
      dataOpsAnonymizePreviewPayloadSchema,
      msg,
      'dataops:error',
      this.deps,
    );
    if (!parsed) return;
    const template = this.findTemplate(parsed.templateId);
    if (!template) {
      this.refuseUnknownTemplate('dataops:anonymize:preview', msg, parsed.templateId);
      return;
    }
    try {
      const conn = await getJsforceConnection(
        parsed.orgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );
      const { AnonymizationEngine } = await import('../../modules/dataops/AnonymizationEngine.js');
      // The window's key, as Apply's engine is given: see `maskingKey`.
      const engine = new AnonymizationEngine(undefined, this.maskingKey);
      const objects: AnonymizePreviewObject[] = [];
      const fieldsNotFound: Array<{ objectApiName: string; fieldApiName: string }> = [];
      for (const objectName of await this.plannedObjectsIn(conn, parsed, template)) {
        if (!masksObject(template, objectName)) continue;
        const objectApiName = sanitizeSoqlObjectName(objectName);
        try {
          const { rules, select, missing, rulesOf } = await this.maskedFields(
            conn,
            objectApiName,
            this.maskingRules(objectName, rulesOfObject(template, objectName)),
            this.maskingRules(objectName, personRulesOfObject(template, objectName)),
          );
          fieldsNotFound.push(...missing.map((fieldApiName) => ({ objectApiName, fieldApiName })));
          const page = await maskingPage(
            conn,
            objectApiName,
            select,
            PREVIEW_ROWS,
            undefined,
            whereOfObject(parsed, template, objectName),
          );
          checkApiLimits(conn.limitInfo, `dataops:anonymize:preview ${objectApiName}`);
          // Each row by the rules its kind of account can hold, as Apply masks it.
          const rulesOfEach = page.records.map(rulesOf);
          const masked = page.records.map(
            (record, index) => engine.anonymize([record], rulesOfEach[index])[0],
          );
          const fields = rules
            .map((r) => r.fieldApiName)
            .filter((field, i, all) => field !== 'Id' && all.indexOf(field) === i);
          objects.push({
            objectApiName,
            fields,
            methods: Object.fromEntries(rules.map((r) => [r.fieldApiName, r.method])),
            rows: page.records.slice(0, PREVIEW_ROWS).map((original, index) => {
              const before: Record<string, AnonymizePreviewValue> = {};
              const after: Record<string, AnonymizePreviewValue> = {};
              const applied = new Set(rulesOfEach[index].map((rule) => rule.fieldApiName));
              for (const field of fields) {
                before[field] = previewValue(original[field]);
                // An empty field is left as it is: Apply writes nothing into it,
                // nor into a field the row's kind of account cannot hold.
                after[field] =
                  isFilledValue(original[field]) && applied.has(field)
                    ? previewValue(masked[index][field])
                    : before[field];
              }
              return { id: String(original.Id ?? ''), before, after };
            }),
          });
        } catch (err: unknown) {
          const reason = extractErrorMessage(err);
          this.deps.log(`[WARN] dataops:anonymize:preview: ${objectApiName} not read: ${reason}`);
          objects.push({ objectApiName, fields: [], rows: [], error: reason });
        }
      }
      const response = buildResponse(this.deps, msg, 'dataops:anonymize:preview:response', {
        templateId: parsed.templateId,
        objects,
        fieldsNotFound,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id} objects=${objects.length}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'dataops:anonymize:preview', 'dataops:error', msg, err);
    }
  }

  /**
   * The newest backup kept for an org, as its metadata records it, or
   * undefined when none is. Keys as `pruneBackups` reads them.
   */
  private latestBackup(orgId: string): KeptBackup | undefined {
    let latest: KeptBackup | undefined;
    for (const key of this.deps.configStore.getKeysByPrefix('backup:')) {
      const operationId = key.slice('backup:'.length);
      if (operationId.includes(':')) continue;
      const meta = this.deps.configStore.get<{
        orgId?: string;
        timestamp?: string;
        objects?: KeptBackup['objects'];
      }>(key);
      if (meta?.orgId !== orgId) continue;
      const timestamp = meta.timestamp ?? '';
      if (latest && latest.timestamp.localeCompare(timestamp) >= 0) continue;
      latest = { operationId, timestamp, objects: meta.objects ?? [] };
    }
    return latest;
  }

  /**
   * Answer `dataops:quality-scan`: fill counts, repeated values and stale
   * records for the objects the page picked, each a count the org made.
   *
   * Read-only by construction — describes and aggregate queries, nothing else
   * — so it takes no org lock and passes no Production Guard: there is no
   * write for either to hold back. An object the org will not describe or
   * count comes back failed inside the result; only a scan that cannot start
   * at all, such as an org with no session, answers on `dataops:error`.
   */
  private async handleQualityScan(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(
      dataOpsQualityScanPayloadSchema,
      msg,
      'dataops:error',
      this.deps,
    );
    if (!parsed) return;
    try {
      const conn = await getJsforceConnection(
        parsed.orgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );
      const result = await scanDataQuality(
        {
          describe: (objectApiName) => conn.describe(objectApiName),
          query: async (soql) => {
            const answer = await conn.query<Record<string, unknown>>(soql);
            checkApiLimits(conn.limitInfo, 'dataops:quality-scan');
            return { totalSize: answer.totalSize, records: answer.records };
          },
        },
        parsed,
      );
      const response = buildResponse(this.deps, msg, 'dataops:quality-scan:response', {
        ...result,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id} objects=${result.objects.length}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'dataops:quality-scan', 'dataops:error', msg, err);
    }
  }

  /**
   * Save the rules the page sends as a template of the user's.
   *
   * The library used to be the four templates that ship: nothing could be
   * added to it, and the Create Template button said so. A name any template
   * already goes by is refused, since the picker lists templates by name.
   */
  private handleTemplateSave(msg: InboundRequest): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(
      anonymizationTemplateSavePayloadSchema,
      msg,
      'dataops:error',
      this.deps,
    );
    if (!parsed) return;
    try {
      const name = parsed.name.trim();
      const taken = [...ANONYMIZATION_TEMPLATES, ...this.savedTemplates.list()].some(
        (t) => t.name.trim().toLowerCase() === name.toLowerCase(),
      );
      if (taken) {
        sendHandlerError(
          this.deps,
          'dataops:anonymization-template:save',
          'dataops:error',
          msg,
          new Error(`A template named "${name}" already exists. Pick another name.`),
          { code: 'DUPLICATE_NAME' },
        );
        return;
      }
      const template = {
        id: `tpl-saved-${crypto.randomUUID()}`,
        name,
        description: '',
        complianceFramework: 'custom' as const,
        rules: parsed.rules.map((rule) => ({ ...rule, description: '' })),
        saved: true as const,
        createdAt: new Date().toISOString(),
      };
      this.savedTemplates.save(template);
      const response = buildResponse(
        this.deps,
        msg,
        'dataops:anonymization-template:save:response',
        { template },
      );
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'dataops:anonymization-template:save', 'dataops:error', msg, err);
    }
  }

  /** Delete a template the user saved. One that ships is code, and is refused. */
  private handleTemplateDelete(msg: InboundRequest): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(
      anonymizationTemplateDeletePayloadSchema,
      msg,
      'dataops:error',
      this.deps,
    );
    if (!parsed) return;
    const { templateId } = parsed;
    if (ANONYMIZATION_TEMPLATES.some((t) => t.id === templateId)) {
      sendHandlerError(
        this.deps,
        'dataops:anonymization-template:delete',
        'dataops:error',
        msg,
        new Error(`Template "${templateId}" ships with SandForge and cannot be deleted.`),
        { code: 'BUILT_IN' },
      );
      return;
    }
    try {
      const deleted = this.savedTemplates.delete(templateId);
      const response = buildResponse(
        this.deps,
        msg,
        'dataops:anonymization-template:delete:response',
        { templateId, deleted },
      );
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(
        this.deps,
        'dataops:anonymization-template:delete',
        'dataops:error',
        msg,
        err,
      );
    }
  }

  private async handlePIIScan(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(piiScanPayloadSchema, msg, 'dataops:error', this.deps);
    if (!parsed) return;
    const { orgId, objectNames } = parsed;
    try {
      if (!this.deps.infraServices?.piiDetector) {
        throw new Error('PII Detector not available.');
      }
      const conn = await getJsforceConnection(orgId, this.deps.orgRegistry, this.deps.orgManager);
      const results = await Promise.all(
        objectNames.map(async (objectName: string) => {
          const safeObj = sanitizeSoqlObjectName(objectName);
          const desc = await conn.describe(safeObj);
          checkApiLimits(conn.limitInfo, `precheck:pii-scan describe ${safeObj}`);
          const fields = (
            desc.fields as Array<{ name: string; label: string; type: string; length?: number }>
          ).map((f: { name: string; label: string; type: string; length?: number }) => ({
            apiName: f.name,
            label: f.label,
            type: f.type,
            length: f.length,
          }));
          const piiResult = this.deps.infraServices!.piiDetector.detectPII(objectName, fields);
          return {
            objectName,
            piiFields: piiResult.piiFields.map(
              (f: { fieldApiName: string; classification: string; confidence: number }) => ({
                fieldName: f.fieldApiName,
                piiType: f.classification,
                confidence: f.confidence,
              }),
            ),
          };
        }),
      );
      const response = buildResponse(this.deps, msg, 'precheck:pii-scan:response', {
        success: true,
        results,
      });
      this.deps.broker.postToWebview(response);
    } catch (err: unknown) {
      this.deps.log(`[ERR] precheck:pii-scan: ${extractErrorMessage(err)}`);
      const errResp = buildResponse(this.deps, msg, 'precheck:pii-scan:response', {
        success: false,
        error: extractErrorMessage(err),
      });
      this.deps.broker.postToWebview(errResp);
    }
  }
}
