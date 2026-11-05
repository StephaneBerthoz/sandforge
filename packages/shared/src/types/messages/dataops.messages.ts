import type { BaseMessage } from './base.messages.js';
import type {
  AnonymizationTemplateRuleConfig,
  BackupStatus,
  CleanupRecommendation,
  CleanupScanResult,
  DataQualityScanResult,
  DataQualityScanTarget,
  PiiInventoryResult,
  RemovalOutcome,
  RemovalPlanObject,
  SubjectEraseMode,
  SubjectIdentifiers,
  SubjectRequestLogEntry,
  SubjectSearchResult,
} from '../dataops.types.js';
import type {
  SavedTemplateMethod,
  SavedTemplateRuleConfig,
} from '../../constants/saved-anonymization-templates.js';
import type { GovernancePolicySummary } from '../governance.types.js';
import type { CheckpointEmails } from '../checkpoint.types.js';
import type { ForgeTargetAutomation, RunDeliverability } from '../forge.types.js';
import type { ForgeRemovalSteps } from '../../utils/forge-target-automation.js';
import type { MutedAutomation, MutePlan } from '../../utils/automation-mute.js';

/** Backup messages */
export interface BackupExecuteRequest extends BaseMessage {
  type: 'backup:execute';
  payload: { configId: string };
}

/** Request the persisted backup history for one org. */
export interface BackupListRequest extends BaseMessage {
  type: 'backup:list';
  payload: { orgId: string };
}

/**
 * The objects a backup taken before masking reads, in one org (validated by
 * dataOpsBackupObjectsPayloadSchema): those a masking run of the template
 * plans there, or of every template listed when none is named — Account among
 * them for a template that masks contacts, in an org with person accounts.
 * Read-only: at most a describe of Account.
 */
export interface BackupObjectsRequest extends BaseMessage {
  type: 'backup:objects';
  payload: { orgId: string; templateId?: string };
}

/** What `backup:objects` answers: the objects, in the order the templates' rules first name them. */
export interface BackupObjectsResponse extends BaseMessage {
  type: 'backup:objects:response';
  payload: { objects: string[] };
}

/**
 * Result of `backup:list`. The channel is `:result`, not `:response`, because
 * that is what the DataOps page has always listened on — the request side was
 * simply never declared, so the broker rejected it before any handler saw it
 * and the backup list was permanently empty.
 */
export interface BackupListResult extends BaseMessage {
  type: 'backup:list:result';
  payload: { backups: BackupSummary[] };
}

/**
 * Why a backup holds fewer rows of an object than the object had: `cap`, the
 * backup reached the cap of rows per object the user sets
 * (`sandforge.backup.maxRecordsPerObject`); `failure`, the read failed past
 * the rows it holds; `not_reached`, the backup failed before it read the
 * object at all, which it holds none of.
 */
export type BackupStopReason = 'cap' | 'failure' | 'not_reached';

/** One object of a backup, as the backup's metadata records it. */
export interface BackupObjectHeld {
  objectApiName: string;
  /** Rows the backup holds of it. */
  recordCount: number;
  /** Whether the object held more rows than the backup read, or the backup never read it. */
  truncated?: boolean;
  /**
   * Rows the object held when the backup read it, as the org counted them;
   * absent from backups taken before it was recorded.
   */
  orgCount?: number;
  /**
   * Why it holds fewer rows than the object: absent when it holds them all,
   * and from a backup taken before it was recorded, which stopped at the
   * tier's bound (2,000 rows on a sandbox, 500 on production).
   */
  stoppedAt?: BackupStopReason;
  /**
   * The classic encrypted fields of the object the user the backup read it as
   * reads masked, lacking View Encrypted Data: not kept, so a restore leaves
   * them as the org holds them. Kept, the mask was the value from before, and
   * a restore wrote it back over the real one. Absent when none.
   */
  notKept?: string[];
}

/** One entry of the backup history, as persisted by dataops:backup. */
export interface BackupSummary {
  operationId: string;
  orgId: string;
  timestamp: string;
  totalRecords: number;
  totalSize: number;
  /** `failed` for a backup whose read failed part-way: it keeps the rows read before. */
  status: BackupStatus;
  /** Each object read, with the rows taken, and why the read stopped short when it did. */
  objectResults: BackupObjectHeld[];
  /** Some object holds more rows than the backup read: a restore brings back only those it holds. */
  partial?: boolean;
  /**
   * Set on the backup a Sync run kept of the records it wrote over: their
   * values from before it, which removing that run gives back. Absent from a
   * DataOps backup.
   */
  origin?: 'sync';
}

/** Export one backup, records included, so it can leave the machine. */
export interface BackupExportRequest extends BaseMessage {
  type: 'backup:export';
  payload: { orgId: string; operationId: string };
}

/** One object of a backup export, and the records the file holds of it. */
export interface BackupExportObject {
  objectApiName: string;
  records: number;
}

/**
 * Result of `backup:export`: the host wrote the backup to a file the user
 * picked, and says where and how many records of each object it holds; or
 * the dialog was dismissed, and nothing was written. A failure goes out on
 * `dataops:error`.
 */
export interface BackupExportResult extends BaseMessage {
  type: 'backup:export:result';
  payload:
    | { operationId: string; status: 'saved'; path: string; objects: BackupExportObject[] }
    | { operationId: string; status: 'cancelled' };
}

/**
 * Delete backups of an org from this machine: those named, or every one of
 * the org's when none is. A backup holds the records' values in clear; nothing
 * else in the panel deletes one.
 */
export interface BackupDeleteRequest extends BaseMessage {
  type: 'backup:delete';
  payload: { orgId: string; operationIds?: string[] };
}

/**
 * Result of `backup:delete`: the backups deleted. A refusal — a backup or a
 * restore of the org is running — goes out on `dataops:error`, code
 * `BACKUP_BUSY`.
 */
export interface BackupDeleteResult extends BaseMessage {
  type: 'backup:delete:result';
  payload: { orgId: string; deleted: string[] };
}

/** Anonymization templates */
export interface AnonymizationTemplatesRequest extends BaseMessage {
  type: 'dataops:anonymization-templates';
}

/** One rule of a masking template as the host lists it: the `Object.Field` it masks, and how. */
export interface AnonymizationTemplateRule {
  fieldPattern: string;
  ruleType: string;
  description: string;
  /**
   * What the method needs that the template itself decides: a constant's
   * value, a truncation's length. Absent on a rule whose method needs nothing.
   */
  config?: AnonymizationTemplateRuleConfig;
}

/** A masking template as the host lists it: one that ships, or one the user saved. */
export interface ListedAnonymizationTemplate {
  id: string;
  name: string;
  description: string;
  complianceFramework: string;
  rules: readonly AnonymizationTemplateRule[];
  /** True for a template the user saved, which can be deleted; absent for one that ships. */
  saved?: boolean;
}

/** Response containing available anonymization templates with their rules */
export interface AnonymizationTemplatesResponse extends BaseMessage {
  type: 'dataops:anonymization-templates:response';
  payload: { templates: ListedAnonymizationTemplate[] };
}

/**
 * Save rules as a named template of the user's, kept in extension storage
 * (validated by anonymizationTemplateSavePayloadSchema).
 */
export interface AnonymizationTemplateSaveRequest extends BaseMessage {
  type: 'dataops:anonymization-template:save';
  payload: {
    name: string;
    /** Each rule's field and method, and the settings a Constant or a Truncate needs. */
    rules: Array<{
      fieldPattern: string;
      ruleType: SavedTemplateMethod;
      config?: SavedTemplateRuleConfig;
    }>;
  };
}

/** The template saved, as the host will list it. */
export interface AnonymizationTemplateSaveResponse extends BaseMessage {
  type: 'dataops:anonymization-template:save:response';
  payload: { template: ListedAnonymizationTemplate };
}

/** Delete a template the user saved; one that ships is refused. */
export interface AnonymizationTemplateDeleteRequest extends BaseMessage {
  type: 'dataops:anonymization-template:delete';
  payload: { templateId: string };
}

/** Whether the template was there to delete. */
export interface AnonymizationTemplateDeleteResponse extends BaseMessage {
  type: 'dataops:anonymization-template:delete:response';
  payload: { templateId: string; deleted: boolean };
}

/**
 * Before an Anonymize: how many rows of each object a template masks the org
 * holds, and how many of them its latest backup holds (validated by
 * dataOpsAnonymizeCoveragePayloadSchema). Read-only: a count per object.
 */
export interface DataOpsAnonymizeCoverageRequest extends BaseMessage {
  type: 'dataops:anonymize:coverage';
  payload: {
    orgId: string;
    templateId: string;
    /** The objects a run would be asked for ({@link DataOpsAnonymizeRequest}); absent, the template's. */
    objects?: string[];
    /** The filter a run would be given ({@link DataOpsAnonymizeRequest}): rows are counted under it. */
    where?: string;
  };
}

/** One object a template masks: its rows in the org, and those the latest backup holds. */
export interface AnonymizeCoverageObject {
  objectApiName: string;
  /** Rows the object holds in the org now; null when the org did not say. */
  count: number | null;
  /** Rows of it the latest backup holds: 0 when it holds none, or there is no backup. */
  backedUp: number;
  /** Whether the backup stopped at its cap of rows per object while the object held more. */
  truncated: boolean;
  /** Why the backup holds fewer rows than the object had, when it says: see {@link BackupObjectHeld}. */
  stoppedAt?: BackupStopReason;
}

/** What a restore of the latest backup can bring back of what a template masks. */
export interface DataOpsAnonymizeCoverageResponse extends BaseMessage {
  type: 'dataops:anonymize:coverage:response';
  payload: {
    templateId: string;
    /** The org's latest backup on this machine, when it has one. */
    backup?: { operationId: string; timestamp: string };
    objects: AnonymizeCoverageObject[];
    /**
     * The last run of this template on this org, when it stopped short and
     * can be resumed: its id, which a resume names as its `resumeFrom`, and
     * when it stopped.
     */
    checkpoint?: { id: string; savedAt: string };
  };
}

/**
 * Before an Anonymize: the first rows of each object a template masks, each
 * masked field as the org holds it and as Apply would write it (validated by
 * dataOpsAnonymizePreviewPayloadSchema). Read-only: nothing is written.
 */
export interface DataOpsAnonymizePreviewRequest extends BaseMessage {
  type: 'dataops:anonymize:preview';
  payload: {
    orgId: string;
    templateId: string;
    /** The objects a run would be asked for ({@link DataOpsAnonymizeRequest}); absent, the template's. */
    objects?: string[];
    /** The filter a run would be given ({@link DataOpsAnonymizeRequest}): the first rows under it. */
    where?: string;
  };
}

/** A masked field's value, as the org holds it or as Apply writes it. */
export type AnonymizePreviewValue = string | number | boolean | null;

/** One object of a preview: the fields its rules mask, and its first rows before and after. */
export interface AnonymizePreviewObject {
  objectApiName: string;
  /** The fields the template masks that the object has, as the org names them. */
  fields: string[];
  /**
   * Present when the object holds rows and its rules mask no field of it,
   * every one hidden or absent: Apply is refused for it, and masks nothing.
   */
  notCovered?: true;
  /**
   * Present when the object holds rows and the connected user may not edit
   * what Apply writes there: the fields it names, or the object itself when
   * `deniedFields` is empty. Apply is refused for it (`CRUD_FLS_DENIED`), and
   * masks nothing.
   */
  writeDenied?: { deniedFields: string[] };
  /**
   * How each of them is masked, by field: the template's method, or, on the
   * fields of a person account the template does not name, the method a
   * contact's rule or an erasure gives it.
   */
  methods?: Record<string, string>;
  /**
   * Its first rows in Id order — those a run masks first — each masked field
   * as it is and as Apply writes it. An empty field stays empty: Apply writes
   * nothing into it.
   */
  rows: Array<{
    id: string;
    before: Record<string, AnonymizePreviewValue>;
    after: Record<string, AnonymizePreviewValue>;
  }>;
  /** What the org said when it would not describe or read the object. */
  error?: string;
}

/** What a template would write over the first rows of each object it masks. */
export interface DataOpsAnonymizePreviewResponse extends BaseMessage {
  type: 'dataops:anonymize:preview:response';
  payload: {
    templateId: string;
    objects: AnonymizePreviewObject[];
    /**
     * The fields the template's rules name that their object's describe does
     * not list — the org has none, or field-level security hides them from
     * the connected user — on the objects that hold a row: Apply is refused
     * for them, as it is for an object marked `notCovered`, and masks nothing.
     */
    fieldsNotFound: Array<{ objectApiName: string; fieldApiName: string }>;
  };
}

/** PII detection pre-check */
export interface PIIScanRequest extends BaseMessage {
  type: 'precheck:pii-scan';
  payload: { orgId: string; objectNames: string[] };
}

/** Response from PII detection scan with detected fields per object */
export interface PIIScanResponse extends BaseMessage {
  type: 'precheck:pii-scan:response';
  payload: {
    success: boolean;
    results?: Array<{
      objectName: string;
      piiFields: Array<{ fieldName: string; piiType: string; confidence: number }>;
    }>;
    error?: string;
  };
}

// ─── DataOps operation messages ──────────────────────────────────────────────

/**
 * A DataOps act that writes records the org already holds, as the org's
 * automation is read for it: a masking updates them, a restore of a backup
 * brings back from the recycle bin what was deleted since and writes the
 * backup's values back, a cleanup deletes them. Each fires what the org runs
 * on that write, as a Forge run's inserts fire what it runs on insert.
 */
export type DataOpsAct = 'masking' | 'restore' | 'cleanup';

/**
 * What a DataOps write carries of the question put before it, as the panel
 * and the command line answer it: the automation that fires accepted
 * (`--accept-automation`, the panel's confirmation once it listed it), the
 * emails the org delivers accepted (`--accept-emails`, the panel's box), and
 * the mute asked for (`--mute-automation`, the panel's box). Absent, none of
 * them: a write that fires something, or whose emails the org delivers, is
 * refused before anything is written.
 */
export interface DataOpsWriteAccord {
  acceptAutomation?: boolean;
  acceptEmails?: boolean;
  muteAutomation?: boolean;
}

/**
 * Where a DataOps write was asked from: the DataOps page marks its masking,
 * restore and cleanup, and the read of what fires it lists before them
 * (`fromPage`, as a rewind's page marks its own). The command line sends the
 * same requests, and their refusals named its flags: told to add
 * `--mute-automation` and `--accept-emails`, the page had neither. Marked,
 * they name the page's confirmation and its boxes.
 */
export interface DataOpsAskedFrom {
  fromPage?: true;
}

/** The records of one object a DataOps act writes. */
export interface DataOpsAutomationObject {
  objectApiName: string;
  records: number;
}

/**
 * What the org runs as a DataOps act writes the records of these objects,
 * read before the act's question (validated by dataOpsAutomationPayloadSchema):
 * read only, its mute planned when asked, nothing assigned. The act reads it
 * again before its first write.
 */
export interface DataOpsAutomationRequest extends BaseMessage {
  type: 'dataops:automation';
  payload: {
    orgId: string;
    act: DataOpsAct;
    objects: DataOpsAutomationObject[];
    /** A subject erasure's, which writes as a masking or a cleanup and is named so. */
    erasure?: boolean;
  } & DataOpsWriteAccord &
    DataOpsAskedFrom;
}

/** Why a DataOps act would be refused before it writes, with its code. */
export interface DataOpsAutomationRefusal {
  code: string;
  message: string;
}

/**
 * What a DataOps act would run into: what fires as it writes, step by step,
 * the emails that sends against what the org has left today, whether the org
 * delivers them, what a mute asked for would assign, and why the act would
 * be refused as it was asked.
 */
export interface DataOpsAutomationAnswer {
  act: DataOpsAct;
  /** The objects it writes records of, those with none left out. */
  objects: DataOpsAutomationObject[];
  /** What each step of the act writes, as what fires is read on it. */
  steps: ForgeRemovalSteps;
  /** What the org runs on them; absent when it could not be read, and `automationUnread` says why. */
  automation?: ForgeTargetAutomation;
  automationUnread?: string;
  /** What the command line says of it, as a dry run prints it. */
  lines: string[];
  /** The emails the act makes the org send, per daily limit, against what it has left today. */
  emails: CheckpointEmails[];
  /** Why some emails were not counted: what sends them was not read. */
  emailsUncounted?: string;
  /** What may send, and whether the org delivers it; absent when nothing that still runs sends. */
  deliverability?: RunDeliverability;
  /** Whether the act needs its emails accepted: the org delivers them, or would not say. */
  emailsAsk: boolean;
  /** Why the act would be refused as asked, the first one stopping it; empty when it may go. */
  refusals: DataOpsAutomationRefusal[];
  /** Asked to mute: what a real act's mute would assign, silence and leave running. */
  mutedAutomation?: MutedAutomation;
  mutePlan?: MutePlan;
}

/** What `dataops:automation` answers. */
export interface DataOpsAutomationResponse extends BaseMessage {
  type: 'dataops:automation:response';
  payload: DataOpsAutomationAnswer;
}

/** Request to roll back a previous data operation (validated by dataOpsRollbackPayloadSchema). */
export interface DataOpsRollbackRequest extends BaseMessage {
  type: 'dataops:rollback';
  payload: {
    orgId: string;
    operationId: string;
    /**
     * Write every row of the backup back. Absent, a restore reads the org's
     * values first and writes only the rows where one differs.
     */
    rewriteAll?: boolean;
    /**
     * Of a Sync run's backup, restore the records changed or deleted since
     * the run too. Absent, they are left as they are, as removing the run in
     * Sync leaves them.
     */
    includeChanged?: boolean;
  } & DataOpsWriteAccord &
    DataOpsAskedFrom;
}

/** Request to anonymize data with a masking template (validated by dataOpsAnonymizePayloadSchema). */
export interface DataOpsAnonymizeRequest extends BaseMessage {
  type: 'dataops:anonymize';
  payload: {
    orgId: string;
    templateId: string;
    objects?: string[];
    /**
     * The checkpoint to resume from, as the coverage answer names it
     * ({@link DataOpsAnonymizeCoverageResponse}): the run masks only what that
     * run left. Absent, the run masks every row.
     */
    resumeFrom?: string;
    /**
     * A SOQL condition, without its `WHERE`, the rows of the one object in
     * `objects` are held to: the run counts, reads and masks those alone.
     * Absent, every row of each object.
     */
    where?: string;
    /**
     * Take a snapshot of the rows the run masks, their masked fields as they
     * are, once the guard let the run go and before its first write: a restore
     * of it puts their values back. The run writes nothing unless the snapshot
     * holds every row it counted. Not given with `resumeFrom`: the run resumed
     * already wrote over some of those rows.
     */
    snapshot?: boolean;
  } & DataOpsWriteAccord &
    DataOpsAskedFrom;
}

/** Response after a successful backup of the selected objects. */
export interface DataOpsBackupResponse extends BaseMessage {
  type: 'dataops:backup:response';
  payload: {
    operationId: string;
    status: string;
    objects: BackupObjectHeld[];
    totalRecords: number;
    /** Some object holds more rows than the backup read: see {@link BackupSummary.partial}. */
    partial?: boolean;
    timestamp: string;
  };
}

/** Response after a successful rollback of a previous data operation. */
export interface DataOpsRollbackResponse extends BaseMessage {
  type: 'dataops:rollback:response';
  payload: {
    operationId: string;
    status: string;
    message: string;
    totalRestored: number;
    /** Rows the org refused. */
    totalFailed?: number;
    /**
     * Rows the org already held with the backup's values, which the restore
     * read and did not write. Zero when it was asked to write every row back.
     */
    totalUnchanged?: number;
    /** The restore was asked to write every row back, without comparing. */
    rewriteAll?: boolean;
    /** Of a Sync run's backup, the restore was asked to include the records changed since the run. */
    includeChanged?: boolean;
    /** What the restore's mute assigned, kept quiet and left running, when it was asked to mute. */
    mutedAutomation?: MutedAutomation;
    /**
     * Of a Sync run's backup, the records changed or deleted since the run —
     * modified after its last write, or in the recycle bin — which the
     * restore left as they are, as removing the run in Sync does, per object.
     * `runNotKept` when the run is no longer kept on this machine: when it
     * last wrote is unknown, and every record read as changed since.
     * Absent when none was left.
     */
    keptChanged?: {
      total: number;
      objects: Array<{ objectApiName: string; count: number }>;
      runNotKept?: true;
    };
    /**
     * The backup held only part of some object — it stopped at the cap, its
     * read failed, or its file is no longer all there — and the restore left
     * the rest of that object as it is; `message` names each one.
     */
    partial?: boolean;
    /** A cancel stopped the restore between two batches: what it restored before is counted. */
    cancelled?: boolean;
  };
}

/**
 * What the duplicate rules of the org wrote while a masking ran, for the
 * records it masked: read once its last write was in, and kept. A masking
 * writes the same address over every record, and a rule that reports writes a
 * duplicate record set of the records alike.
 */
export interface MaskingDuplicatesWritten {
  /** The objects it masked whose duplicate rules are active, and the rules' names. */
  rules: Array<{ objectApiName: string; rules: string[] }>;
  /** Duplicate record sets created during the run that hold an item naming a record it masked. */
  sets: number;
  /** Items created during the run in such a set: the masked records', and those they match. */
  items: number;
  /** More items were created during the run than one read takes: the counts are at least these. */
  atLeast?: true;
  /** Why it could not be read; the counts are then 0. */
  unread?: string;
}

/**
 * Response when an anonymization run ends, whatever it masked; a run that
 * fails on an error ends on `dataops:error` instead, with the same counts.
 */
export interface DataOpsAnonymizeResponse extends BaseMessage {
  type: 'dataops:anonymize:response';
  payload: {
    templateId: string;
    status: string;
    recordsProcessed: number;
    /** Records the org refused to update: they still hold their original values. */
    recordsFailed: number;
    /**
     * Records still holding their original values: the ones the org refused,
     * and the ones a cancel or the API limit kept the run from reaching.
     */
    recordsNotMasked: number;
    /**
     * Per object, the records it held when the run counted them, those done
     * with (masked, or holding nothing to mask), those refused, and those still
     * holding their original values.
     */
    objects: Array<{
      objectApiName: string;
      total: number;
      processed: number;
      failed: number;
      notMasked: number;
    }>;
    message: string;
    /** Why the org refused them, per object. */
    errors: Array<{ objectApiName: string; message: string }>;
    /** Present when a cancel stopped the run before every record was masked. */
    cancelled?: true;
    /**
     * Present when the run stopped before every record was masked because the
     * org had used nearly all of its daily API requests.
     */
    stoppedAtApiLimit?: true;
    /**
     * The snapshot the run took before it wrote, when it was asked to: the
     * backup a restore names, and the rows it holds.
     */
    snapshot?: { operationId: string; totalRecords: number };
    /** What the run's mute assigned, kept quiet and left running, when it was asked to mute. */
    mutedAutomation?: MutedAutomation;
    /** What the duplicate rules wrote during it; absent when no object it masked has one. */
    duplicates?: MaskingDuplicatesWritten;
  };
}

/**
 * Measure the records of a few objects: fill counts, repeated values of a key,
 * records not modified for `staleDays` (validated by
 * dataOpsQualityScanPayloadSchema). Read-only: aggregate queries and describes.
 */
export interface DataOpsQualityScanRequest extends BaseMessage {
  type: 'dataops:quality-scan';
  payload: { orgId: string; objects: DataQualityScanTarget[]; staleDays: number };
}

/** Result of `dataops:quality-scan`; a scan that could not start fails on `dataops:error`. */
export interface DataOpsQualityScanResponse extends BaseMessage {
  type: 'dataops:quality-scan:response';
  payload: DataQualityScanResult;
}

/**
 * Which fields of a few objects hold personal data: the pre-flight PII
 * detector, confirmed on a bounded sample (validated by
 * dataOpsPiiInventoryPayloadSchema). Reads only.
 */
export interface DataOpsPiiInventoryRequest extends BaseMessage {
  type: 'dataops:pii-inventory';
  payload: { orgId: string; objects: string[] };
}

/** Result of `dataops:pii-inventory`: counts per field, never a value. */
export interface DataOpsPiiInventoryResponse extends BaseMessage {
  type: 'dataops:pii-inventory:response';
  payload: PiiInventoryResult;
}

/**
 * Find the records of a few objects that hold one person's address, name or
 * number (validated by dataOpsSubjectSearchPayloadSchema). Counted first, then
 * listed up to a bound. A search opens a request in the local log, or adds to
 * the one it names.
 */
export interface DataOpsSubjectSearchRequest extends BaseMessage {
  type: 'dataops:dsr:search';
  payload: SubjectIdentifiers & { orgId: string; objects: string[]; requestId?: string };
}

/** Result of `dataops:dsr:search`. */
export interface DataOpsSubjectSearchResponse extends BaseMessage {
  type: 'dataops:dsr:search:response';
  payload: SubjectSearchResult;
}

/**
 * Save every field of the records a request found to a JSON file the user
 * picks. The host reads, asks where, and writes: the records never cross the
 * bridge.
 */
export interface DataOpsSubjectExportRequest extends BaseMessage {
  type: 'dataops:dsr:export';
  payload: { orgId: string; requestId: string };
}

/** Result of `dataops:dsr:export`: how many records, and whether the file was written. */
export interface DataOpsSubjectExportResponse extends BaseMessage {
  type: 'dataops:dsr:export:response';
  payload: {
    requestId: string;
    records: number;
    saved:
      | { status: 'saved'; path: string }
      | { status: 'cancelled' }
      | { status: 'error'; message: string };
  };
}

/**
 * Erase records a request found: overwrite their personal data with the
 * DataOps anonymizer, or delete them — both through Production Guard, once
 * what the org runs as they are written was read and accepted, as for a
 * masking or a cleanup. A dry run answers what it would do and writes nothing.
 */
export interface DataOpsSubjectEraseRequest extends BaseMessage {
  type: 'dataops:dsr:erase';
  payload: {
    orgId: string;
    requestId: string;
    mode: SubjectEraseMode;
    /** The records to erase, each one the request found. */
    records: Array<{ objectApiName: string; ids: string[] }>;
    dryRun: boolean;
  } & DataOpsWriteAccord;
}

/** Result of `dataops:dsr:erase`: the plan of a dry run, or what the run did. */
export interface DataOpsSubjectEraseResponse extends BaseMessage {
  type: 'dataops:dsr:erase:response';
  payload: {
    requestId: string;
    mode: SubjectEraseMode;
    dryRun: boolean;
    plan: RemovalPlanObject[];
    /**
     * A dry run's: the records the erasure writes, per object, what the org
     * deletes along with them included — what its confirmation reads what
     * fires on, as the erasure reads it before its first write.
     */
    written?: DataOpsAutomationObject[];
    /** Absent on a dry run. */
    outcome?: RemovalOutcome;
    /** What the erasure's mute assigned, kept quiet and left running, when it was asked to mute. */
    mutedAutomation?: MutedAutomation;
  };
}

/** The local log of subject requests, newest first. */
export interface DataOpsSubjectLogRequest extends BaseMessage {
  type: 'dataops:dsr:log';
}

/** Result of `dataops:dsr:log`. */
export interface DataOpsSubjectLogResponse extends BaseMessage {
  type: 'dataops:dsr:log:response';
  payload: { entries: SubjectRequestLogEntry[] };
}

/**
 * Count, for a few objects, the records a cleanup would look at: not modified
 * for `staleDays`, orphans of a lookup the business relies on, repeated values
 * of a key. The quality scan's own request (validated by
 * dataOpsQualityScanPayloadSchema). Reads only.
 */
export interface DataOpsCleanupScanRequest extends BaseMessage {
  type: 'dataops:cleanup:scan';
  payload: { orgId: string; objects: DataQualityScanTarget[]; staleDays: number };
}

/** Result of `dataops:cleanup:scan`. */
export interface DataOpsCleanupScanResponse extends BaseMessage {
  type: 'dataops:cleanup:scan:response';
  payload: CleanupScanResult;
}

/** Save the records a recommendation names to a JSON file the user picks. */
export interface DataOpsCleanupExportRequest extends BaseMessage {
  type: 'dataops:cleanup:export';
  payload: { orgId: string; objectApiName: string; recommendation: CleanupRecommendation };
}

/** Result of `dataops:cleanup:export`. */
export interface DataOpsCleanupExportResponse extends BaseMessage {
  type: 'dataops:cleanup:export:response';
  payload: {
    objectApiName: string;
    records: number;
    /** More records are recommended than one export reads. */
    truncated: boolean;
    saved:
      | { status: 'saved'; path: string }
      | { status: 'cancelled' }
      | { status: 'error'; message: string };
  };
}

/**
 * Delete the records a recommendation names, through Production Guard. A dry
 * run answers how many it would delete and what the org would delete along
 * with them, and deletes nothing.
 */
export interface DataOpsCleanupDeleteRequest extends BaseMessage {
  type: 'dataops:cleanup:delete';
  payload: {
    orgId: string;
    objectApiName: string;
    recommendation: CleanupRecommendation;
    dryRun: boolean;
  } & DataOpsWriteAccord &
    DataOpsAskedFrom;
}

/** Result of `dataops:cleanup:delete`. */
export interface DataOpsCleanupDeleteResponse extends BaseMessage {
  type: 'dataops:cleanup:delete:response';
  payload: {
    objectApiName: string;
    dryRun: boolean;
    plan: RemovalPlanObject;
    /** More records are recommended than one delete reads. */
    truncated: boolean;
    /**
     * A dry run's: the records the delete takes, per object, what the org
     * deletes along with them included — what its confirmation reads what
     * fires on, as the delete reads it before its first write.
     */
    written?: DataOpsAutomationObject[];
    /** Absent on a dry run. */
    outcome?: RemovalOutcome;
    /** What the delete's mute assigned, kept quiet and left running, when it was asked to mute. */
    mutedAutomation?: MutedAutomation;
  };
}

/**
 * Error response for dataops backup/rollback/anonymize/quality-scan failures
 * (emitted via sendHandlerError). Dual-channel note: `operation:failed` carries the
 * lifecycle, `dataops:error` settles the in-flight webview mutation — the
 * webview surfaces the error from this channel only (see DataOpsHandler).
 */
export interface DataOpsErrorResponse extends BaseMessage {
  type: 'dataops:error';
  payload: {
    message: string;
    code: string;
    retryable: boolean;
    /** An erasure refused for several reasons: every one after the first, each under its code. */
    alsoRefused?: DataOpsAutomationRefusal[];
    /** A write that muted and stopped: what its mute assigned, kept quiet and took back. */
    mutedAutomation?: MutedAutomation;
  };
}

// ─── Governance messages ─────────────────────────────────────────────────────

/** Request to list all governance policies (summaries). */
export interface GovernancePoliciesListRequest extends BaseMessage {
  type: 'governance:policies:list';
}

/**
 * Result of `governance:policies:list`. The channel is `:result` (not
 * `:response`) — same convention as `monitor:alerts:result` — because both
 * the handler and the webview consumer were built on it.
 */
export interface GovernancePoliciesListResult extends BaseMessage {
  type: 'governance:policies:result';
  payload: { policies: GovernancePolicySummary[] };
}

/**
 * Request to save (create or update) a governance policy. The policy object is
 * validated server-side by `GovernancePolicySchema` (extension GovernanceEngine
 * module); no shared TS mirror of that schema exists yet.
 */
export interface GovernancePolicySaveRequest extends BaseMessage {
  type: 'governance:policy:save';
  payload: { policy: Record<string, unknown> };
}

/** Request to delete a governance policy by ID. */
export interface GovernancePolicyDeleteRequest extends BaseMessage {
  type: 'governance:policy:delete';
  payload: { policyId: string };
}

/** Request to evaluate a governance policy against live org limits. */
export interface GovernanceEvaluateRequest extends BaseMessage {
  type: 'governance:evaluate';
  payload: { policyId: string; orgId: string };
}

/** Request to list the default governance policy templates. */
export interface GovernanceTemplatesRequest extends BaseMessage {
  type: 'governance:templates';
}

/**
 * Response for `governance:policy:save`. Dual-use channel: the success path is
 * posted via buildResponse (`{ success: true }`); a policy that fails
 * GovernancePolicySchema validation is reported on the same channel via
 * sendHandlerError (`{ message, code, retryable }`).
 */
export interface GovernancePolicySaveResponse extends BaseMessage {
  type: 'governance:policy:save:response';
  payload: { success?: boolean; message?: string; code?: string; retryable?: boolean };
}

/** Response after deleting a governance policy. */
export interface GovernancePolicyDeleteResponse extends BaseMessage {
  type: 'governance:policy:delete:response';
  payload: { success: boolean };
}

/**
 * Response for `governance:evaluate`. Dual-use channel (same convention as
 * {@link GovernancePolicySaveResponse}). `result` is the extension-side
 * GovernanceEvaluationResult (no shared TS mirror yet).
 */
export interface GovernanceEvaluateResponse extends BaseMessage {
  type: 'governance:evaluate:response';
  payload: {
    success?: boolean;
    result?: Record<string, unknown>;
    message?: string;
    code?: string;
    retryable?: boolean;
  };
}

/** Response containing the default governance policy templates. */
export interface GovernanceTemplatesResponse extends BaseMessage {
  type: 'governance:templates:response';
  payload: { templates: Array<Record<string, unknown>> };
}

/** Error response for governance operations (emitted via sendHandlerError). */
export interface GovernanceErrorResponse extends BaseMessage {
  type: 'governance:error';
  payload: { message: string; code: string; retryable: boolean };
}
