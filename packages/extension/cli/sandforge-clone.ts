#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * sandforge-clone — headless clone CLI, of one record or of whole tables.
 *
 * Wraps the production discovery + scoped-execute pipeline so devs can
 * run a Forge from the terminal without opening VSCode. The script
 * delegates org auth to the `sf` CLI (`sf org display`) and reuses the
 * exact same orchestrator/executor as the wizard.
 *
 * `--object` (with `--where`) clones whole tables instead of a record, as the
 * panel runs a query: the executor is handed what the panel's orchestrator
 * hands it for the same config (`forgeExecuteOptions`), and reads and writes
 * each table a page at a time, its journal on disk.
 *
 * A run printed with `--json` and saved to a file can be taken back: `--remove`
 * deletes from the target the records that run created, with the removal the
 * wizard runs from Recent runs.
 *
 * Runs from a checkout of the repository, at its root, after `pnpm install`
 * and `pnpm build:shared`.
 *
 * Usage:
 *   pnpm exec tsx packages/extension/cli/sandforge-clone.ts \
 *     --record <recordId> --source <alias> --target <alias>
 *     [--depth direct|full|custom] [--custom-depth <n>]
 *     [--max <n>] [--anonymize] [--dry-run]
 *   pnpm exec tsx packages/extension/cli/sandforge-clone.ts \
 *     --object Account --where "<condition>" --object Contact --where "<condition>" \
 *     --source <alias> --target <alias> [--dry-run] [--resume <journal>]
 *   pnpm exec tsx packages/extension/cli/sandforge-clone.ts \
 *     --remove <summary.json> --target <alias> [--include-changed] [--accept-automation]
 *       [--leave-undeletable] [--json]
 *       [--preview] [--sweep | --sweep-list] [--sweep-late] [--sweep-untied] [--audit <file>]
 *   pnpm exec tsx packages/extension/cli/sandforge-clone.ts \
 *     --verify <summary.json> --target <alias> [--source <alias>] [--json] [--audit <file>]
 *
 * Example:
 *   pnpm exec tsx packages/extension/cli/sandforge-clone.ts \
 *     --record 500XX00000000001AAA \
 *     --source SOURCE-UAT --target TARGET-DEV \
 *     --depth custom --custom-depth 5 --max 50 --dry-run
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join as joinPath, resolve as resolvePath, sep } from 'node:path';
import type { Connection, DescribeSObjectResult } from 'jsforce';
import { z } from 'zod';
import { countRequests, loadOrg, makeConn, type SfOrg } from './sfSession.js';
import {
  envWords,
  ownOptionWords,
  relayTakes,
  relayedBy,
  relayedByAnEnvironment,
} from './relayWords.js';
import {
  idsOf,
  laterPartsOf,
  machineSpanOf,
  mergedPreviewObjects,
  mergedUndoObjects,
  runPartsOf,
  spansOf,
  stillLeft,
  type RunPart,
} from './cloneRunParts.js';
import { fileConfigStore } from './fileConfigStore.js';
import { refuseUnreadArguments, type CommandFlags } from './commandLine.js';
import { elapsedSince } from './elapsedSince.js';
import { runExitCode } from './exitCodes.js';
import { onStopSignal, stopExitCode, type StopSignal } from './stopSignals.js';

import type {
  EmailSender,
  ForgeAdminChangeGroup,
  ForgeAutomationWrite,
  ForgeConfig,
  ForgeConfigInput,
  ForgeContactPointKind,
  ForgeContactPointsReport,
  ForgeDecisionApplied,
  ForgeFieldRefusal,
  ForgeFilesReport,
  ForgeGap,
  ForgeGraph,
  ForgePlan,
  ForgeRemovalFilesLeft,
  ForgeRemovalLeftCount,
  ForgeRemovalSpan,
  ForgeRunObjectRecords,
  ForgeSweepClasses,
  ForgeSweepLeftClass,
  ForgeSweepListing,
  ForgeSweepMark,
  ForgeSweepResult,
  ForgeTargetAutomation,
  ForgeTemplateInput,
  ForgeUndoObjectResult,
  ForgeUndoStatus,
  RecordTypeGiven,
  WithoutRecordTypeWhy,
} from '@sandforge/shared';
import {
  BYTES_PER_MB,
  FORGE_MAX_RECORDS_PER_OBJECT_BOUND,
  FORGE_READ_CEILING_PER_OBJECT,
  adminChangesOf,
  emailsPerInsertOf,
  forgeGapParts,
  FILE_COPY_CEILING_MB,
  FILE_COPY_DEFAULT_MAX_MB,
  fileCopyRefusal,
  forgeConfigSchema,
  forgeConfigSchemaStrict,
  forgeRemovalPlanLeft,
  forgeRunCreatedRecords,
  forgeRunLinkedKept,
  forgeTemplateSchema,
  removalBypassesOf,
  sweepTakenObjects,
  forgeWriteHeaders,
  formatFileSize,
  isDeveloperEdition,
  leftOutAsEmptyTable,
  mergeGaps,
  removalRisksOf,
} from '@sandforge/shared';
import {
  DEFAULT_MAX_NODES,
  GraphDiscoveryService,
  holdsAPlace,
} from '../src/modules/forge/GraphDiscoveryService.js';
import type {
  GraphDiscoveryDeps,
  ObjectDescribe,
} from '../src/modules/forge/GraphDiscoveryService.js';
import { ForgePlanGenerator } from '../src/modules/forge/ForgePlanGenerator.js';
import { forgeExecuteOptions } from '../src/modules/forge/ForgeOrchestrator.js';
import { ForgeAbortedError, ForgeExecutor } from '../src/modules/forge/ForgeExecutor.js';
import { ForgeStops } from '../src/modules/forge/ForgeStops.js';
import { cursorPages, queryAllPages } from '../src/modules/forge/queryAllPages.js';
import { controllersOf, fieldBoundsOf } from '../src/modules/forge/describeBounds.js';
import { withObjectsLeftOut } from '../src/modules/forge/stages/ScopeResolver.js';
import {
  runAnonymization,
  type ForgeAnonymizationMethods,
  type PIIFieldInfo,
} from '../src/modules/forge/ForgeAnonymizer.js';
import {
  runDecisionsOf,
  whySkippedRowsIgnored,
  type ForgeRunDecisions,
} from '../src/modules/forge/stages/RunDecisions.js';
import type {
  ExecuteOptions,
  ExecutionSummary,
  ForgeExecutorDeps,
  ForgeProgressEvent,
  ForgeWriteBoundary,
  ForgeWriteGateAnswer,
  FieldInfo,
  TargetObjectInfo,
} from '../src/modules/forge/ForgeExecutor.js';
import {
  RecordTypeMapper,
  namespaceMismatchWarning,
  namespaceMismatches,
} from '../src/modules/sync/RecordTypeMapper.js';
import type { RecordTypeInfo, RecordTypeMapping } from '../src/modules/sync/RecordTypeMapper.js';
import {
  PIIDetector,
  contactPointOf,
  personalFieldsByApiName,
} from '../src/core/precheck/PIIDetector.js';
import {
  formatSaveError,
  saveErrorDetail,
  toSaveOutcomes,
} from '../src/core/common/existingRecordMatch.js';
import { parseRecordTypeInfos } from '../src/core/metadata/recordTypeAvailability.js';
import { readRecordTypePicklists } from '../src/core/metadata/recordTypePicklists.js';
import { describePicklistChange } from '../src/modules/forge/stages/RecordTypePicklists.js';
import { describeCurrencyReplaced } from '../src/core/common/recordCurrencies.js';
import { CallSizes, RUN_SPLIT_CALLS, SplitAllowance } from '../src/core/common/governorLimit.js';
import { ForgeFilesRefusedError } from '../src/modules/forge/stages/FileCopier.js';
import {
  insertFile,
  readFileBody,
  remainingFileStorageMB,
} from '../src/modules/forge/fileTransfer.js';
import {
  objectsRemovedOf,
  removalOrg,
  NOTHING_REMOVED,
  removeRunRecords,
  setBackToDraftOf,
  type RemovalPreviewObject,
  type RunPartAlongside,
  type RunRemovalOptions,
  type RunRemovalOutcome,
  type UndeletableObject,
} from '../src/modules/forge/ForgeRunRemoval.js';
import {
  removalAuditObjects,
  removalAuditOutcome,
  removalStatus,
  removalStatusWithSweep,
} from '../src/modules/forge/removalOutcome.js';
import {
  SWEEP_LEAD_MS,
  SWEEP_LOOK_BOUND,
  SWEEP_TRAIL_MS,
  listSweep,
  sweepAuditDetails,
  sweepAuditObjects,
  sweepAutomationOf,
  sweepCountsOf,
  sweepMarkOf,
  sweepParts,
  type SweepInput,
  type SweepOptions,
  type SweepOrg,
  type SweepParts,
  type SweepTies,
} from '../src/modules/forge/ForgeRunSweep.js';
import { MADE_KEPT_PER_OBJECT, madeKept } from '../src/modules/forge/sweepTies.js';
import {
  compositeConnectionOf,
  compositeReader,
} from '../src/modules/checkpoint/compositeQueries.js';
import { nodeSyncRunCreations, type SyncRunKept } from '../src/modules/sync/SyncRunCreations.js';
import { SEED_RUNS_DIR } from '../src/modules/seed/SeedRunCreations.js';
import { ABORTED_BEFORE_START, recordWriteRun } from '../src/modules/audit/auditTrail.js';
import type { AuditDeps, WriteRun } from '../src/modules/audit/auditTrail.js';
import {
  RUN_CANCELLED,
  auditTalliesOf,
  cancelledRunOutcome,
  contactPointsAudit,
  forgeAuditObjects,
  forgeCarried,
} from '../src/modules/forge/forgeAudit.js';
import { ForgeRunAudit } from '../src/modules/forge/forgeRunAudit.js';
import { finishedRunStatus, type ForgeRunStatus } from '../src/modules/forge/runResult.js';
import {
  TargetAutomationReader,
  answerOf,
  automationLines,
  toolingAnswersOf,
  toolingCompositeBody,
  toolingRetrievesOver,
  type QueryAnswer,
} from '../src/modules/forge/TargetAutomationReader.js';
import {
  TargetGapReader,
  gapFieldOf,
  gapLines,
  gapsWithAnswers,
  toolingQueriesOver,
  type GapDecisions,
} from '../src/modules/forge/TargetGapReader.js';
import {
  DEFAULT_MAX_TOTAL,
  ForgeRunGateError,
  type ForgeRunGateErrorCode,
  automationRefusal,
  deliverabilityPartOf,
  EMAILS_NOT_ACCEPTED,
  bypassesToAssign,
  countedEmailChecksOf,
  emailCheckLines,
  emailRefusal,
  emailsUncountedOf,
  insertsOf,
  objectsUpdatedAfterInsert,
  removalAutomationLines,
  removalAutomationRefusal,
  runBypassesOf,
  readDataStorage,
  readEmailLimits,
  removalRiskLines,
  sendersOfNothingWritten,
  sendersOfNothingWrittenLine,
  storageCheckOf,
  storageRefusal,
  writePlanLines,
  writePlanOf,
  forgeWriteBudgetOf,
  readApiBudget,
  takeCheckpointFirst,
  apiBudgetRefusal,
  API_BUDGET_EXCEEDED,
  CHECKPOINT_REFUSED,
  type ApiBudget,
  type ApiBudgetCheck,
  type DataStorage,
  type WritePlan,
} from '../src/modules/forge/ForgeRunGate.js';
import { writtenWithWords } from '../src/core/common/platformRecords.js';
import { isNeverCopied } from '../src/modules/forge/excludedObjects.js';
import {
  noUserCreates,
  readCreateFacts,
  whyNotCreatableOver,
  type CreateFactsDeps,
  type NotCreatableBy,
} from '../src/modules/forge/targetCreators.js';
import { beforeRunFailedWords } from '../src/modules/checkpoint/beforeRunCheckpoint.js';
import {
  CHECKPOINT_FIRST_FLAGS,
  checkpointEstimateLines,
  checkpointFirstArgs,
  checkpointFirstHelp,
  checkpointOrgOf,
  checkpointRefusedWords,
  checkpointSettledLines,
  checkpointStopWords,
  checkpointTakenLines,
  commandCheckpoints,
  type CommandCheckpointAsk,
  type CommandCheckpoints,
} from './beforeRunCheckpoint.js';
import {
  dryRunMuteOf,
  isMuteRefusedError,
  muteForRun,
  muteLines,
  muteOrgOf,
  planMute,
  type HeldMute,
  type RunMute,
} from '../src/modules/forge/AutomationMuteLease.js';
import { partialSummaryOf } from '../src/modules/forge/interruptedRun.js';
import {
  ForgeRunJournal,
  SUMMARY_IDS_BOUND,
  nodeRunJournal,
} from '../src/modules/forge/ForgeRunJournal.js';
import type { ForgeRunPartEnd } from '../src/modules/forge/ForgeRunJournal.js';
import type { ForgeRunStore } from '../src/modules/forge/ForgeRunStore.js';
import {
  inFlightLines,
  inFlightTargetOf,
  uncertainRows,
  type InFlightReconciliation,
} from '../src/modules/forge/ForgeInFlight.js';
import { forgeRunFingerprint, sameRunSetup } from '../src/modules/forge/runFingerprint.js';
import { extractErrorMessage } from '../src/core/common/extractErrorMessage.js';
import type { ForgeRehearsal } from '@sandforge/shared';
import {
  auditMutedOf,
  gapLiftedBy,
  stillRunningOf,
  type MutedAutomation,
  type MutedAutomationAlsoLifted,
} from '@sandforge/shared';
import {
  NO_APEX_IN_PRODUCTION,
  readEmailDeliverability,
  runEmailsOf,
} from '../src/modules/forge/targetDeliverability.js';
import type {
  RunCheckpointEstimate,
  RunCheckpointInfo,
  RunCheckpointRequest,
  RunCheckpointTaken,
} from '@sandforge/shared';
import {
  OTHER_ORG,
  refusalOfSummary,
  refusedLine,
  refusedRemovalSummary,
  refusedSummary,
  refusedSummaryWords,
  wouldBeRefusedJson,
  wouldBeRefusedLine,
  type RunRefusal,
} from './runRefused.js';
import { UNDELETABLE_NOT_LEFT, undeletableAnswer } from './undeletableAnswer.js';
import { rehearsalExecutorDeps } from '../src/modules/forge/rehearsal/RehearsalWriter.js';
import { targetRecordTypesOf } from '../src/modules/forge/rehearsal/ForgeRehearser.js';
import { validationRulesOf } from '../src/modules/forge/rehearsal/rehearsalGaps.js';
import {
  RehearsalNotRolledBackError,
  rehearse,
  type RehearsalPlan,
} from '../src/modules/forge/rehearsal/rehearse.js';
import type { ForgeRunVerification } from '@sandforge/shared';
import {
  RunVerifier,
  verificationTotals,
  verifiedOrg,
  writtenWithoutByObject,
  type SourceOrg,
} from '../src/modules/forge/RunVerifier.js';
import { holdOutputWhole } from './wholeOutput.js';

export interface CliArgs {
  /** The record a clone of one record starts from; undefined for a clone of whole tables. */
  record: string | undefined;
  /**
   * The tables a clone of whole tables reads (`--object`, each with its
   * `--where`), the first the one discovery starts from; undefined for a
   * clone of one record.
   */
  tables: TableArg[] | undefined;
  source: string;
  target: string;
  depth: 'direct' | 'full' | 'custom';
  customDepth: number;
  /** Discovery node cap; undefined leaves the service default in place. */
  maxNodes: number | undefined;
  maxRecordsPerObject: number | undefined;
  anonymize: boolean;
  /**
   * Write email addresses and phone numbers as the source holds them
   * (`--keep-contact-points`). Off, every row has them neutralized first.
   */
  keepContactPoints: boolean;
  dryRun: boolean;
  /** Print the objects discovery reached and stop, without reading a row. */
  listObjects: boolean;
  /** Enable upsert path on objects with externalId fields (skips DUPLICATE_VALUE on re-runs). */
  upsert: boolean;
  /** Single-hop orphan parent expansion when a required FK is out-of-graph. */
  expandOrphans: boolean;
  /** Let the target's assignment rules apply to the records the run writes (`Sforce-Auto-Assign: TRUE`). */
  applyAssignmentRules: boolean;
  /** Skip the pre-execute target preflight (counts existing rows on target). */
  skipPreflight: boolean;
  /** Emit JSON summary on stdout (machine-readable for CI integration). */
  json: boolean;
  /** Exit 3, not 0, when the run was partial (`--fail-on-partial`), as Sync and Seed do. */
  failOnPartial: boolean;
  /**
   * Where the run writes its summary as it goes (`--summary`): after each
   * object, then whole once it ends, or once Ctrl-C stopped it. undefined =
   * no file.
   */
  summary: string | undefined;
  /** Per-object field exclusions: { Account: ['Description', 'NumberOfEmployees'] }. */
  fieldExclusions: Record<string, string[]>;
  /** Objects the clone leaves out, whether discovery reaches them or the run would add them. */
  excludedObjects: string[];
  /** Source User Id → target User Id remap for OwnerId. */
  ownerMappings: Record<string, string>;
  /** Per-object SOQL WHERE filter: { Case: "Status = 'Open' AND CreatedDate > LAST_N_DAYS:30" }. */
  objectSoqlFilters: Record<string, string>;
  /** Per-object source→target field rename: { Account: { 'Region__c': 'Region__pc' } }. */
  fieldMappings: Record<string, Record<string, string>>;
  /** Output path for the remap-table CSV (sourceId,targetId). undefined = no export. */
  remapCsv: string | undefined;
  /**
   * Copy the files attached to the cloned records (`--files`): the largest
   * file copied, and whether the files were accepted as they are
   * (`--files-as-is`). undefined = no file is read.
   */
  files: { maxFileSizeMB: number; acceptedAsIs: boolean } | undefined;
  /**
   * Write although the target runs automation as the clone inserts its
   * records, or could not say what it runs (`--accept-automation`).
   */
  acceptAutomation: boolean;
  /**
   * Write although the target delivers every email what still runs sends, or
   * would not say whether it does (`--accept-emails`). `--accept-automation`
   * never stands for it: it is the flag a CI script passes on every run.
   */
  acceptEmails: boolean;
  /**
   * Mute the target's automation for the run through its own bypass
   * (`--mute-automation`): the permission sets holding it assigned to the
   * user the run writes as for the run alone, taken back as it ends.
   */
  muteAutomation: boolean;
  /**
   * Take a checkpoint of what the run writes before its first write
   * (`--checkpoint-first`): the days it is kept and the objects left out of
   * it. undefined = none.
   */
  checkpointFirst?: RunCheckpointRequest;
  /** The most records a run may write in all; past it, nothing is written (`--max-total`). */
  maxTotal: number;
  /**
   * The most rows of one object a read takes; past it, the object is said
   * truncated (`--max-records-per-object`).
   */
  readCeiling: number;
  /**
   * Rows a page of a read holds (`SANDFORGE_FORGE_PAGE_SIZE`): a diagnostic,
   * which reads every statement through the org's cursor in pages of it.
   */
  pageSize?: number;
  /**
   * Rehearse the clone instead of writing it (`--rehearse`): a sample of its
   * rows created in the target in calls each rolled back whole, for the
   * platform's verdict on every one. Nothing stays in the target.
   */
  rehearse: boolean;
  /**
   * The decisions taken in Review's Gaps row, from `--config` or `--template`:
   * picklist values mapped, defaults, cuts, record types mapped, rows held
   * back, gaps ignored. undefined = none.
   */
  decisions: ForgeRunDecisions | undefined;
  /** The method of each personal-data category, from `--template`; none given takes the defaults. */
  anonymizationRules: ForgeAnonymizationMethods;
  /** The personal fields `--template` anonymizes on each object; undefined = discovery's choice. */
  anonymizeFields: Array<{ objectApiName: string; fieldNames: string[] }> | undefined;
  /** The file the run's choices were read from, as its output names it. */
  choicesFrom: { flag: ChoicesFlag; path: string } | undefined;
  /**
   * The file the run's entry in the audit trail goes to (`--audit`), the
   * store the panel keeps its trail in; undefined = no entry.
   */
  audit: string | undefined;
  /**
   * The run to take up where it stopped (`--resume`): its journal's file, or
   * its run id in the journal directory. undefined = a run of its own.
   */
  resume: string | undefined;
  /**
   * With `--resume`, write the rows of the calls the run had under way when
   * it stopped that the target may already hold (`--write-uncertain`): each
   * may then be there twice. Without it, such a resume is refused.
   */
  writeUncertain: boolean;
}

/** The flags that read a run's choices from a file. */
type ChoicesFlag = '--config' | '--template';

const HELP = `sandforge-clone — Forge a clone of one record, or of whole tables, from a source org
to a target sandbox, or remove what a run of it created.

Usage:
  pnpm exec tsx packages/extension/cli/sandforge-clone.ts \\
    --record <id> --source <alias> --target <alias> [options]
  pnpm exec tsx packages/extension/cli/sandforge-clone.ts \\
    --object <ApiName> [--where <condition>] [--object <ApiName> [--where <condition>]]... \\
    --source <alias> --target <alias> [options]
  pnpm exec tsx packages/extension/cli/sandforge-clone.ts \\
    --remove <summary.json> --target <alias> [--include-changed] [--accept-automation]
      [--mute-automation] [--leave-undeletable] [--json]
      [--preview] [--sweep | --sweep-list] [--sweep-late] [--sweep-untied] [--audit <file>]
  pnpm exec tsx packages/extension/cli/sandforge-clone.ts \\
    --verify <summary.json> --target <alias> [--source <alias>] [--json] [--audit <file>]

  Run from the repository root of a checkout, after pnpm install and
  pnpm build:shared.

  The target must be a sandbox or a Developer Edition org (a Trailhead
  playground is one). Its Organization record says which, and any other
  org, an org whose edition it does not say included, is refused as a
  production org before anything is written or deleted. --dry-run and
  --list-objects only read, and run against any org.

  Before it reads a row, the clone says what the target runs on the objects
  it writes: its active record-triggered flows, Apex triggers, Process
  Builder processes and workflow rules, per object and write, with what of
  them sends messages (SENDS MESSAGES) or runs after commit; its assignment
  and duplicate rules; and what keeps a flow from starting for the user the
  run writes as, and whether that user holds it (with --json, under
  targetAutomation). When any of them fires as the clone inserts its
  records, or as it updates those it writes a second time — a lookup
  filled in once its record exists, an order or a contract given back its
  status — or the target would not say what it runs, nothing is written
  unless --accept-automation is given. A bypass the user does not hold is
  given with the permission set of the target that holds it, which
  --mute-automation assigns for the run alone, under a lease.

  It then says what the target holds against the rows, read from its
  metadata: its active validation rules and what keeps them quiet, its
  active duplicate rules and whether each blocks an insert or lets it
  through, the fields only the target requires that the clone does not
  write, the lookup filters of the lookups it writes, and the daily API
  requests the target has left against those the run takes (with --json,
  under targetGaps). A gap a decision of --config or --template answers —
  a default given to a field only the target requires — is said answered
  by it, as Review shows it decided, and no longer BLOCKING (answeredBy,
  with --json). None of it stops the clone. With --dry-run --json,
  adminChanges lists, for whoever administers the target, the changes to its
  metadata that would let the rows go in as they are — a picklist value to
  add to a record type, a field to lengthen, a rule to turn off — grouped by
  object and record type, each with its step in Setup; the clone makes none.

  Once every row is read and before the first is written, the clone counts
  the records it is about to write, per object, and the data storage they
  take by the sizes Salesforce documents, and the daily API requests they
  take, with those of a checkpoint taken first and of the record types read
  back after. It writes nothing past --max-total, nor more than the target's
  data storage or its daily API requests have left. It says the emails the
  target's flows send as the records go in, against the daily limits it has
  left — a Developer Edition's email alerts counted against its single emails
  too — and writes nothing past them: a record whose flow fails in the save
  is refused there, and the org's own emails stop for the day. What sends
  and could not be read — a flow's definition refused or past the read's
  bound, a flow a package installed, which the org lets no one read — is
  said not counted (with --dry-run --json, under writePlan.emailsUncounted),
  and refuses nothing: --accept-automation already covers it.

Required:
  --record <id>          Source record ID (any object type — prefix detected automatically);
                         may come from --template instead; --object (below)
                         clones whole tables instead
  --source <alias>       sf CLI alias of the source org
  --target <alias>       sf CLI alias of the target sandbox

Clone whole tables, in place of --record:
  --object <ApiName>     a table to clone; repeat for more. The first is where
                         discovery starts, and each other must be in its graph
                         (--depth, --max-nodes): a parent one of them points at,
                         or a child that hangs from one. Every other object
                         discovery reaches is left out.
  --where <condition>    the rows of the --object before it: a SOQL condition,
                         written without WHERE         (default: every row)
                         The run is the panel's run of a query: each table read
                         with the org's cursor in the order of its ids and
                         written a page at a time, so the run holds a page of
                         rows whatever a table holds, and keeps what it wrote in
                         its journal as it goes; --resume reads each table after
                         the last row the run wrote. Parents go before the tables
                         that point at them, their lookups given the records the
                         run created. With --upsert, every page of a table goes
                         by one external id, the first whose value each row
                         the run reads of it holds and no two share. A run that
                         copies files (--files) reads each table whole. Not
                         with --record, --expand-orphans or --rehearse. With
                         --template, the template's choices go with the
                         tables, its record or query aside.

Options:
  --depth <mode>         direct | full | custom    (default: custom)
  --custom-depth <n>     traversal depth when --depth is custom (default: 5)
  --max <n>              max records cloned per object          (default: unlimited)
  --list-objects         print the objects discovery reached, then stop
                         Answers "why was my object not cloned?" — an object
                         absent from this list was never in the graph. With
                         --json, stdout carries them as JSON: each object's
                         record count, depth and whether it is included, and
                         whether the graph was truncated.
  --max-nodes <n>        objects discovery may reach            (default: 50)
                         Raise it when the summary says TRUNCATED and an
                         object you expected is missing, e.g. the lines of an
                         Opportunity's quotes. The prices, products, price
                         books and selling models the lines use come whatever
                         the cap, as do the items of an activated order and
                         the schedules of an opportunity's products. Each
                         parent a record reached cannot be written without
                         takes the cap one object further, up to twice it.
                         An empty table takes no place under it, and nothing
                         is reached through it; discovery reads four times
                         the cap in objects at most.
  --anonymize            anonymize PII fields                   (default: off)
  --keep-contact-points  write emails and phone numbers as read (default: off)
                         Off, every record is written with its email addresses
                         under .invalid and its phone numbers in a fictional
                         range, anonymized or not, so what the target's flows
                         and email alerts send to them reaches no one. On,
                         they may reach the real people the records name.
  --dry-run              skip writes, surface scoped queries    (default: off)
                         It reads the automation and counts the records as a
                         real run does, and says what would stop that run,
                         each under the code that run is refused with: a real
                         run would be refused (CODE): ... With --json, under
                         wouldBeRefused, and the codes under wouldBeRefusedCodes.
  --rehearse             have the target judge the rows, keep none (default: off)
                         Reads and prepares every row as a real run would,
                         then creates a sample of them in the target — every
                         row up to 200, one per object, record type and set of
                         fields given a value past it, with the records they
                         name — in composite calls that each fail on purpose,
                         so that every write is rolled back. Prints each
                         refusal (status code, field, rows) and what could not
                         be judged (with --json, under rehearsal). The target's
                         automation runs inside each call: emails, @future and
                         Queueable jobs, platform events published after
                         commit and the asynchronous paths of Flows never
                         leave it; platform events published immediately and
                         callouts do. Refused against a production org, and,
                         like a real run, without --accept-automation when the
                         target runs automation on insert. Not with --dry-run,
                         --upsert, --files, --remap-csv or --list-objects.
  --accept-automation    write although the target runs flows or Apex
                         triggers as the clone inserts, or as it updates the
                         records it inserted, or could not say what it runs
                                                                (default: off)
  --accept-emails        write although the target delivers every email of
                         what still runs as the clone writes, or would not say
                         whether it does; --accept-automation never stands for
                         it. Asked only when what still runs sends one: flows,
                         processes and workflow rules with an email action,
                         those whose definition was not read, and the
                         assignment rules --apply-assignment-rules applies,
                         whatever --mute-automation leaves. Whether the org
                         delivers them is read with one line of anonymous Apex
                         that sends nothing,
                         Messaging.reserveSingleEmailCapacity(1), as the user
                         the run writes as, never in a production org; on
                         System email only or No access, none of them goes
                         out, the org still counts them against its daily
                         limits, and nothing is asked. What an Apex trigger
                         sends is read nowhere                  (default: off)
  --mute-automation      mute the target's automation for the run through its
                         own bypass: assign the user the run writes as, for the
                         run alone, the permission sets holding the custom
                         permissions its flows, processes and workflow rules
                         test to stay quiet, and take them back as it ends.
                         What no bypass keeps quiet (an Apex trigger, a managed
                         package's flow) still runs, and still needs
                         --accept-automation. Refused on a production org and
                         for a user who cannot assign permission sets, exit 1;
                         a dry run says what would be muted and assigns nothing
                                                                (default: off)
${checkpointFirstHelp({ run: 'the run', simulation: '--dry-run' })}
  --max-total <n>        most records the run may write in all  (default: 10000)
                         Counted once every row is read: past it, nothing is
                         written. --max caps each object, this the whole run.
  --max-records-per-object <n>
                         most records one read of an object takes
                                                                (default: 50000)
                         An object with more is read to it and said
                         TRUNCATED. A clone of a record holds what it reads,
                         so a higher number takes more memory; 1000000 at most.
  --upsert               use external Id upsert when available  (default: insert)
                         Skips DUPLICATE_VALUE on re-runs of the same source records.
  --expand-orphans       single-hop expand orphan parent FKs    (default: off)
                         Clones missing parents (out-of-graph) so child FKs resolve.
  --apply-assignment-rules
                         apply the target's assignment rules    (default: off)
                         Off, every write says Sforce-Auto-Assign: FALSE and
                         keeps the owner the run sets. On, the target's active
                         assignment rules may give the Cases, Leads and
                         Accounts the run writes another owner, and mail them.
  --skip-preflight       skip pre-execute target row count      (default: off)
                         The preflight queries each object on target so the user
                         can see existing volume before pressing through.
  --json                 emit JSON summary on stdout (CI mode)  (default: off)
                         stdout then carries the JSON alone, and every other
                         line goes to stderr. Saved to a file, the summary is
                         what --remove takes the run back from. With
                         --list-objects, the JSON is the objects of the graph.
                         A run refused before its first write prints
                         "refused": {"code", "message"} instead, the code its
                         line names: refused (MAX_TOTAL_EXCEEDED): ..., each
                         other reason under "alsoRefused", on a line of its own.
                         How a run ended is under result.status: success,
                         partial or failure, as its status: line says it.
  --fail-on-partial      exit 3, not 0, when the run wrote some records and
                         the target refused others        (default: off)
  --summary <file>       write the summary to <file> as the run goes
                         The JSON --json prints, written after each object
                         with what the run has created so far ("running":
                         true), then whole once it ends. Ctrl-C stops the run
                         between two calls to the org and writes what it had
                         created by then ("interrupted": true), as --json then
                         prints it: --remove takes the run back from either.
                         A file already there is not overwritten. Not with
                         --list-objects or --rehearse.
  --resume <journal|id>  take up where it stopped a run that did not end — a
                         Ctrl-C, a failure, a process killed — from its journal:
                         its file, or its run id in the journal directory. Each
                         record that run wrote is linked to and never written
                         again, the lookups and statuses it still owed are
                         given, and the rest is written. The same record, orgs,
                         depth, choices and flags as the run it takes up, or it
                         is refused; a run that ended is refused too. Every run
                         that writes keeps its journal there (see
                         SANDFORGE_JOURNAL_DIR), and says where as it starts.
                         The calls the run had under way when it stopped are
                         looked for in the target first: a row found there is
                         kept as written by the run, never sent again; one the
                         target may hold already stops the resume before it
                         writes (see --write-uncertain).
                         Not with --dry-run, --rehearse or --list-objects.
  --write-uncertain      with --resume: write all the same the rows of a call
                         under way when the run stopped that the target may
                         already hold, records the resume cannot tell from
                         them being there — each may then be there twice.
  --exclude <obj.field>  skip a field on an object during clone (repeatable)
                         e.g. --exclude Account.Description --exclude Account.NumberOfEmployees
  --exclude-object <obj> leave an object out of the clone (repeatable)
                         e.g. --exclude-object PricebookEntry
                         Out whether discovery reaches it or the run would
                         add it past the cap. What it costs is said, not
                         written: the records that cannot be written without
                         one of its records, and the orders left drafts.
  --owner-map <src=tgt>  remap OwnerId from source User Id to target User Id (repeatable)
                         e.g. --owner-map 005AB...=005XY...
                         Useful when source records were authored by users
                         that don't exist on the target sandbox (ex-employees).
  --filter <obj=where>   per-object SOQL WHERE filter (repeatable)
                         e.g. --filter "Case=Status = 'Open' AND CreatedDate > LAST_N_DAYS:30"
                         Lets BAs narrow a clone to a subset without changing
                         graph topology. Filter is appended via AND (...) to
                         the scope-derived clause. Max 512 chars per filter,
                         max 50 filters total.
  --map <obj.src=tgt>    per-object source→target field rename (repeatable)
                         e.g. --map Account.Region__c=Region__pc
                         Handles schema drift between source and target
                         (managed-package re-key, namespace change). The
                         source field is dropped and the value written to
                         the target field name on insert.
  --config <file.json>   the run's choices from a JSON file: the decisions
                         taken in Review's Gaps row (picklistValueMappings,
                         recordTypeMappings, defaultValues, truncateFields,
                         skippedRows, ignoredGaps), the fields and objects
                         left out (fieldExclusions, excludedObjects), the
                         filters (objectSoqlFilters) and the mappings
                         (ownerMappings, fieldMappings), as a Forge config
                         names them. Checked as the panel checks a run's
                         config; any other key is refused. The flags above
                         win over the file: their exclusions are added, their
                         filters and mappings replace the file's for the same
                         object, user or field.
  --template <file.json> a template the Template tab exported: its decisions,
                         exclusions, filters and mappings, as --config takes
                         them, and its depth, caps, anonymization, contact
                         points and orphan parents, each unless its flag is
                         given. Its record is cloned when --record is not
                         given; a template of a query needs --record, or
                         --object. Not with --config.
  --remap-csv <file>     write the source→target ID remap table to a CSV
                         file (header: sourceId,targetId). BA reconciliation:
                         "where did source X go on the target sandbox?"
  --files                copy the files of the cloned records   (default: off)
                         Salesforce Files (the latest version of each) and
                         attachments, after the records they hang on. The
                         total is checked against the target's file storage
                         before anything is written: past it, refused
                         (FILE_STORAGE_EXCEEDED), as when that storage could
                         not be read (FILE_STORAGE_UNREAD) or the files not
                         all looked up (FILES_UNREAD).
  --max-file-size <MB>   largest file --files copies, 1 to 35   (default: 10)
                         A larger file is left out and listed, never cut.
  --files-as-is          accept that files are copied as they are: their
                         content cannot be anonymized. Required with --files
                         when --anonymize is on.
  --audit <file>         record the run in an audit trail kept in <file>
                         The entry the panel keeps in Reports -> Audit trail:
                         per object the records created, updated and lost,
                         the orgs, the outcome, the user as a hash of the
                         username, and, for a run refused before it wrote,
                         the code of what refused it. Counts only, never a
                         value of a record. Each run adds its entry to the
                         file; a dry run, --list-objects and --rehearse write
                         nothing, and add none.
  -h, --help             show this help and exit

Remove what a run created:
  --remove <file>        the summary a run printed with --json, saved to a file,
                         or the journal of a run: every part of it, the run it
                         took up and each time it was taken up
                         Deletes from --target the records that run created,
                         as the wizard removes a run from Recent runs: children
                         first, never a record the target already held, and a
                         record kept while records that stay depend on it. The
                         target must be the org the run wrote to. A dry run's
                         summary is refused: it created nothing.
                         What a removal wrote to the records it left is kept
                         beside the summary, clone-summary.removals.json for
                         clone-summary.json, and the next --remove of that
                         summary reads it: what a removal wrote is no change
                         since the run. Keep that file with the summary.
                         A summary of a run past 50 000 records keeps their ids
                         in its journal, which the removal reads them from.
                         Of a run stopped and taken up with --resume, one
                         summary per part, it is kept beside the journal too:
                         the removal of any part, or of the journal, reads what
                         the others wrote, and once a part's own records are
                         gone, takes what an earlier removal of another part
                         left. What the run wrote to a record of another part
                         is no change since the run. The journal's removal
                         takes the parts the last first, each read against
                         its own span: what someone changed, or made, between
                         two parts stays.
  --include-changed      remove also the records changed since the run, and
                         what was added to them since           (default: kept)
  --accept-automation    delete although the target runs flows, Apex triggers,
                         processes or workflow rules as the records go, those
                         --sweep deletes included — before or after a delete,
                         or as an activated order is set back to Draft for
                         its delete — or could not say what it runs
                                                                (default: off)
  --mute-automation      mute the target's automation for the removal through
                         its own bypass, as for a run: the permission sets
                         holding the bypasses of what fires as the records go,
                         those --sweep deletes included, assigned to the user
                         it deletes as, for the removal alone, and taken back
                         as it ends; what no bypass keeps quiet still needs
                         --accept-automation                    (default: off)
  --leave-undeletable    remove the rest when the user the removal runs as
                         may not delete the records of some objects of the
                         run, leaving those with what they hang from; without
                         it the removal stops before its first delete and
                         names them                             (default: off)
  --preview              say what the removal would do, and do nothing: per
                         object the records it would delete, those gone
                         already, those changed since the run and who changed
                         them, those it could not see, and what a removal run
                         now would be refused for, each under the code it is
                         refused with: a removal would be refused (CODE): ...,
                         with --json the codes under "refusalCodes", in the
                         order of "refusals". It reads the records, as
                         the removal reads them before its first delete, and
                         writes nothing: not to the org, not beside the
                         summary. With --sweep, it lists what the sweep would
                         take, and reads what fires on it with the run's own.
                         Not with --sweep-list or --audit.
                         A removal takes no --dry-run: one that did not read
                         it would delete for real.
  --sweep                before the run's records go, delete too what the
                         target's automation made for the run, that the run's
                         id map does not hold: what the run's user created
                         under the run's records, what they point at, or what
                         hangs from those, three links at most, at most a
                         minute after the record it is tied to — in the
                         objects the run wrote and their children, tasks,
                         events, feed, email messages, notes, case comments,
                         and the objects the target's flows create. What a
                         record of the run points at by a lookup the org
                         refuses the delete for (an asset its case names)
                         goes once that record is gone. Listed and kept: what
                         is tied to the run but came later, up to 15 minutes,
                         or as the org's Automated Process user; and what the
                         run's user created in the run's window, a second
                         before its first write to a minute after its last,
                         tied to nothing of it.
                         What anyone changed more than 2 s after the run's
                         last write, and after its own creation, stays — the
                         run's user and its automation too — unless
                         --include-changed, and the sweep then ends partial,
                         exit 3; a change made before the run's last write
                         reads as unchanged. Runs alone when an earlier
                         --remove took every record of the run
                                                                (default: off)
  --sweep-late           with --sweep, take too what it lists as made late;
                         with --sweep-list, say what it would take
  --sweep-untied         with --sweep, take too what it lists as tied to
                         nothing of the run; with --sweep-list, say what it
                         would take; refused when another run of this
                         machine wrote to the target in the run's window, or
                         when that user created records there on objects
                         neither the run nor the automation reaches (hand
                         work, likely)
  --sweep-list           list what --sweep would delete, per object with a few
                         names and how many it ties to the run, and delete
                         nothing, the run's records included; exit 3, as a
                         refused --sweep, when it says the sweep is refused
                         What a sweep leaves, and why: what another user
                         created, a colleague's or an integration's; what is
                         tied to nothing, unless --sweep-untied; what came
                         more than 15 minutes after its record, or after the
                         removal began, which cannot be told from work done
                         by hand; what anyone changed after the run's last
                         write, the run's own user included, unless
                         --include-changed; what the
                         automation changed or deleted rather than created,
                         which a checkpoint taken before the run takes back;
                         what left the org (emails, outbound messages); more
                         than 10 000 records of one object; and what the
                         panel, another machine or a CI wrote meanwhile, which
                         a sweep does not see
  --json                 print what became of the records as JSON on stdout,
                         every other line on stderr; refused before its first
                         delete, "refused": {"code", "message"}, the code its
                         line names: refused (CODE): ... — a production org
                         (PRODUCTION_TARGET), what fires as it deletes
                         (AUTOMATION_NOT_ACCEPTED), its mute (MUTE_PRODUCTION,
                         MUTE_NO_RIGHT, MUTE_FAILED), objects its user may not
                         delete (UNDELETABLE_NOT_LEFT), an org that is not the
                         one the run wrote to (OTHER_ORG, its --preview too)
  --audit <file>         record the removal, and the sweep, in the audit trail
                         kept in <file>

Verify what a run created:
  --verify <file>        the summary a run printed with --json, saved to a file,
                         or the journal of a run, every part of it
                         Reads back from --target every record the run created,
                         after a pause and again until two readings agree (three
                         at most, two seconds apart): those there, those in the
                         recycle bin, those neither, out of the user's sight;
                         checks on twenty records of each object that the
                         lookups the run set point at the ids their parents got,
                         reading the source records in --source; and lists the
                         records changed since the run, which --remove keeps
                         unless --include-changed. Only reads, from either org.
                         Exits 0 when VERIFIED, 3 when PARTIAL (a record not
                         there, a lookup that does not hold, or a part that could
                         not be checked) and 4 when UNSTABLE (no two readings
                         agreed: something still writes to the records).
  --source <alias>       the org the run read from      (default: the summary's)
                         A lookup the clone left out with --exclude reads as
                         one left empty.
  --json                 print the verification as JSON on stdout, every other
                         line on stderr; refused for an org that is not the
                         one the run wrote to, exit 1, "refused": {"code",
                         "message"}, the code its line names: refused
                         (OTHER_ORG): ...
  --audit <file>         record the verification in the audit trail kept in
                         <file>

Environment:
  SANDFORGE_FORGE_PAGE_SIZE=<n>
                         a diagnostic: read every statement through the org's
                         cursor and hand it on in pages of <n> rows, as a run of
                         whole tables reads, to see a clone's paged read against
                         a real org. Not a setting: an org answers in pages of
                         200 to 2000 rows, and a page of <n> is cut from them.
  SANDFORGE_JOURNAL_DIR=<dir>
                         where every run that writes keeps its journal, in
                         <dir>/forge-runs/        (default: ~/.sandforge)
                         What the run wrote, read and still owes, line by line
                         as it goes, ids only: what --resume takes a run up
                         from, and what --remove takes it back from however it
                         ended.

Exit codes:
  0  the clone ran, a run the target refused some records of too unless
     --fail-on-partial; the rehearsal ran, whatever it found refused; the removal
     took every record it set out to take; the preview said what a removal
     would do, refusals included
  1  the clone or the removal could not run; the clone produced only failures,
     or its files were refused; the target is a production org; the target
     runs automation on insert or on the updates the clone makes after its
     inserts, or the removal's deletes fire automation, and
     --accept-automation was not given; the target delivers the emails of
     what still runs, or would not say whether it does, and --accept-emails
     was not given (EMAILS_NOT_ACCEPTED); the checkpoint asked first was
     refused or could not be taken (CHECKPOINT_REFUSED); the run would write
     more than --max-total records, more than the target's data storage
     has left or more emails than it has left today, or would take more API
     requests than it has left today (nothing is written or deleted then)
  2  a bad command line, or a summary --remove cannot take a run back from, or
     a file beside it that is not what a removal kept there
  3  the run was partial and --fail-on-partial was given; the removal left
     records of the run in the org: kept, or refused, or found neither in the
     org nor in its recycle bin, as the user it ran as sees them; or the sweep
     was refused, or did not take all it was asked to (a --sweep-untied
     refused included)
  130  Ctrl-C stopped the clone: the summary says what it created by then
  143  a SIGTERM stopped it — a CI job cancelled or timed out —, 129 a SIGHUP:
       as Ctrl-C does, the summary and the journal say what it created
`;

/** A 15- or 18-character Salesforce ID. */
const SF_ID_RE = /^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$/;

/** An SObject or field API name — the pattern the ForgeConfig schema enforces. */
const API_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;

/**
 * The daily API requests the run takes of the target, against what it has
 * left, as a sync says them: a clone's and an Autopilot run's, every part
 * together. Exported so it can be tested.
 */
export function apiRequestsLine(api: ApiBudgetCheck, target: string): string {
  if (api.verdict === 'unread') {
    return `  API requests: about ${api.estimate}; what ${target} has left today could not be read (${api.unread})`;
  }
  return (
    `  API requests: about ${api.estimate}, of the ${api.remaining} ${target} has left ` +
    `of its ${api.max} a day` +
    (api.verdict === 'exceeds'
      ? ': more than it has left'
      : api.verdict === 'near'
        ? ': it would leave less than a tenth of them'
        : '')
  );
}

/** What refused a field rows were written again without, as the summary says it. */
const REFUSED_IT: Readonly<Record<ForgeFieldRefusal, string>> = {
  'validation-rule': 'a validation rule refused it',
  'restricted-picklist': 'a restricted picklist refused its value',
  'lookup-filter': 'a lookup filter refused the record it names',
  'inactive-owner': 'the target holds the owner it names inactive',
};

/** The flag each ForgeConfig field is read from, to name it in an error. */
const FLAG_OF_FIELD: Readonly<Record<string, string>> = {
  inputMode: '--record',
  recordId: '--record',
  depth: '--depth',
  customDepth: '--custom-depth',
  maxRecordsPerObject: '--max',
  sourceOrgId: '--source',
  targetOrgId: '--target',
  fieldExclusions: '--exclude',
  ownerMappings: '--owner-map',
  objectSoqlFilters: '--filter',
  fieldMappings: '--map',
  soqlQuery: '--object',
};

/** The keys of a Forge config `--config` takes: what decides, leaves out, filters and maps. */
const CONFIG_FILE_KEYS = [
  'fieldExclusions',
  'excludedObjects',
  'ownerMappings',
  'objectSoqlFilters',
  'fieldMappings',
  'picklistValueMappings',
  'recordTypeMappings',
  'defaultValues',
  'truncateFields',
  'skippedRows',
  'ignoredGaps',
] as const;

/**
 * What `--config` reads: those keys of a Forge config, checked as the schema
 * checks them, and nothing else. A key it does not take is refused rather
 * than dropped: a depth or a cap written there and ignored would read, in the
 * file, as one the run used.
 */
const configFileSchema = z.strictObject(
  forgeConfigSchema.pick(
    Object.fromEntries(CONFIG_FILE_KEYS.map((key) => [key, true])) as {
      [K in (typeof CONFIG_FILE_KEYS)[number]]: true;
    },
  ).shape,
);

/**
 * The object a query reads from: the name after its FROM, its subqueries set
 * aside. Exported so it can be tested.
 */
export function queryRootOf(soql: string): string | undefined {
  let flat = soql;
  for (let before = ''; before !== flat;) {
    before = flat;
    flat = flat.replace(/\([^()]*\)/g, ' ');
  }
  return /\bFROM\s+([A-Za-z][A-Za-z0-9_]*)/i.exec(flat)?.[1];
}

/** A table a clone of whole tables reads: its object, and the condition its rows are read under. */
export interface TableArg {
  objectApiName: string;
  /** The SOQL condition given with `--where`, written without WHERE; every row when absent. */
  where?: string;
}

/**
 * The tables `--object` names, each with the `--where` that follows it, in
 * the order given; undefined when none is named. Exits 2 on a name that is
 * not an API name, an object named twice, and a `--where` with no object
 * before it, a second one for the same object, or no condition.
 */
function tableArgs(args: readonly string[]): TableArg[] | undefined {
  const tables: TableArg[] = [];
  function refuse(line: string): never {
    process.stderr.write(`${line}\n`);
    process.exit(2);
  }
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag !== '--object' && flag !== '--where') continue;
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) {
      refuse(
        flag === '--object'
          ? '--object takes the API name of a table to clone.'
          : '--where takes a SOQL condition, written without WHERE.',
      );
    }
    i++;
    if (flag === '--object') {
      if (!API_NAME_RE.test(value)) {
        refuse(`Invalid --object value "${value}" (must match SObject API name pattern)`);
      }
      if (tables.some((table) => table.objectApiName === value)) {
        refuse(`--object ${value} is named twice.`);
      }
      tables.push({ objectApiName: value });
      continue;
    }
    const last = tables.at(-1);
    if (!last) refuse('--where filters the --object before it: name the table first.');
    else if (last.where !== undefined) {
      refuse(`--object ${last.objectApiName} is given two --where: join them with AND.`);
    } else if (value.trim() === '') {
      refuse(`--where for ${last.objectApiName} is empty.`);
    } else last.where = value.trim();
  }
  return tables.length > 0 ? tables : undefined;
}

/**
 * The query a clone of whole tables is discovered from, as the panel's query
 * mode sends one: the first table, under its condition. Exported so it can be
 * tested.
 */
export function tablesQueryOf(tables: readonly TableArg[]): string {
  const [root] = tables;
  return `SELECT Id FROM ${root.objectApiName}${root.where ? ` WHERE ${root.where}` : ''}`;
}

/**
 * The objects of the graph a clone of whole tables leaves out: every one
 * discovery reached that the command line does not name. Read whole, a table
 * nobody named would go to the target with every row it holds — the parents
 * the named tables point at are named with them, and written first.
 * Exported so it can be tested.
 */
export function tablesLeftOut(
  graph: Pick<ForgeGraph, 'nodes'>,
  tables: readonly TableArg[],
): string[] {
  const named = new Set(tables.map((table) => table.objectApiName));
  return graph.nodes.map((node) => node.objectApiName).filter((name) => !named.has(name));
}

/**
 * The tables the command line names that discovery did not reach from the
 * first: none of their rows could be read. Exported so it can be tested.
 */
export function tablesNotReached(
  graph: Pick<ForgeGraph, 'nodes'>,
  tables: readonly TableArg[],
): string[] {
  const reached = new Set(graph.nodes.map((node) => node.objectApiName));
  return tables.map((table) => table.objectApiName).filter((name) => !reached.has(name));
}

/**
 * The Forge config of a clone of whole tables, as the panel's query mode
 * sends one: its query, each table's condition as that object's filter, and
 * every choice of the command line in the fields the panel's run reads them
 * from. The objects discovery reached and the command line does not name are
 * left out. Exported so it can be tested.
 */
export function tablesRunConfig(args: CliArgs, graph: Pick<ForgeGraph, 'nodes'>): ForgeConfig {
  const tables = args.tables ?? [];
  const excludedObjects = [...new Set([...args.excludedObjects, ...tablesLeftOut(graph, tables)])];
  return {
    inputMode: 'soql',
    soqlQuery: tablesQueryOf(tables),
    depth: args.depth,
    ...(args.depth === 'custom' ? { customDepth: args.customDepth } : {}),
    sourceOrgId: args.source,
    targetOrgId: args.target,
    anonymizePII: args.anonymize,
    skipEmpty: true,
    batchSize: 'auto',
    ...(args.maxRecordsPerObject !== undefined
      ? { maxRecordsPerObject: args.maxRecordsPerObject }
      : {}),
    ...(Object.keys(args.fieldExclusions).length > 0
      ? { fieldExclusions: args.fieldExclusions }
      : {}),
    ...(excludedObjects.length > 0 ? { excludedObjects } : {}),
    ...(Object.keys(args.ownerMappings).length > 0 ? { ownerMappings: args.ownerMappings } : {}),
    ...(Object.keys(args.objectSoqlFilters).length > 0
      ? { objectSoqlFilters: args.objectSoqlFilters }
      : {}),
    ...(Object.keys(args.fieldMappings).length > 0 ? { fieldMappings: args.fieldMappings } : {}),
    ...(args.keepContactPoints ? { keepContactPoints: true } : {}),
    ...(args.applyAssignmentRules ? { applyAssignmentRules: true } : {}),
    ...(args.dryRun ? { dryRun: true } : {}),
    ...args.decisions,
  };
}

/**
 * What the executor is asked to do by a clone of whole tables: what the
 * panel's orchestrator asks of it for the same config (`forgeExecuteOptions`),
 * read page by page to the ceiling of each object — the diagnostic's pages
 * when it is set — and upserted by external id under `--upsert`, which the
 * panel never does. The journal and the gate are added as for a clone of one
 * record (`withTheJournal`, `beforeWrite`). Exported so it can be tested.
 */
export function tablesExecuteOptions(
  args: CliArgs,
  config: ForgeConfig,
  graph: ForgeGraph,
  recordTypeMappings: RecordTypeMapping[],
  personalFieldsOf: (fields: PIIFieldInfo[]) => string[],
): ExecuteOptions {
  const options =
    forgeExecuteOptions(
      graph,
      config,
      {
        recordTypeMappings,
        anonymizationRules: args.anonymizationRules,
        ...(args.files ? { files: args.files } : {}),
        stream: {
          ceiling: args.readCeiling,
          ...(args.pageSize !== undefined ? { pageSize: args.pageSize } : {}),
        },
      },
      personalFieldsOf,
    ) ?? {};
  return args.upsert ? { ...options, upsertMode: 'auto' } : options;
}

/**
 * The input of a run, as a Forge config holds it: the record a clone of one
 * record starts from, or the query a clone of whole tables is discovered
 * from. Exported so it can be tested.
 */
export function cloneInputOf(
  args: Pick<CliArgs, 'record' | 'tables'>,
): Pick<ForgeConfig, 'inputMode' | 'recordId' | 'soqlQuery'> {
  return args.tables
    ? { inputMode: 'soql', soqlQuery: tablesQueryOf(args.tables) }
    : { inputMode: 'record', recordId: args.record };
}

/** The run's first line names what it clones: its record, or each table under its condition. */
export function cloneInputLine(args: Pick<CliArgs, 'record' | 'tables'>): string {
  if (!args.tables) return `record=${args.record ?? ''}`;
  return `tables=${args.tables
    .map((table) => (table.where ? `${table.objectApiName} (${table.where})` : table.objectApiName))
    .join(', ')}`;
}

/** The most objects a run's line names by name: a clone of the whole org copies hundreds. */
const SUBJECT_OBJECTS_NAMED = 12;

/**
 * What a run's lines and summary call what it cloned: its record, or the
 * tables it read — the first of them by name, and how many more, past
 * {@link SUBJECT_OBJECTS_NAMED}.
 */
export function cloneSubjectOf(run: {
  record?: string;
  objects?: ReadonlyArray<{ objectApiName: string }>;
}): string {
  if (run.record) return run.record;
  const objects = (run.objects ?? []).map((object) => object.objectApiName);
  if (objects.length === 0) return 'the run';
  if (objects.length <= SUBJECT_OBJECTS_NAMED) return objects.join(', ');
  const more = objects.length - SUBJECT_OBJECTS_NAMED;
  return `${objects.slice(0, SUBJECT_OBJECTS_NAMED).join(', ')} and ${more} more object${more === 1 ? '' : 's'}`;
}

/** The largest file read as a run's choices: a template with every decision a graph holds stays well under it. */
const CHOICES_FILE_MAX_BYTES = 1_000_000;

/** What a choices file holds, read and checked. */
export type ChoicesFile =
  | { kind: 'config'; config: Pick<ForgeConfigInput, (typeof CONFIG_FILE_KEYS)[number]> }
  | { kind: 'template'; template: ForgeTemplateInput };

/**
 * Read a run's choices from `text`, the content of the file `flag` names:
 * a config subset for `--config`, a template the Template tab exported for
 * `--template`. Returns the reasons the file is refused, one per line, when
 * it is. Exported so it can be tested.
 */
export function readChoicesFile(
  flag: ChoicesFlag,
  text: string,
): { file: ChoicesFile } | { refusal: string[] } {
  if (text.length > CHOICES_FILE_MAX_BYTES) {
    return { refusal: [`${flag}: the file is larger than ${CHOICES_FILE_MAX_BYTES} bytes`] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return { refusal: [`${flag}: the file is not JSON`] };
  }
  const issues = (error: z.ZodError): string[] =>
    error.issues.map((issue) => {
      const at = issue.path.map(String).join('.');
      return `${flag}${at ? ` (${at})` : ''}: ${issue.message}`;
    });
  if (flag === '--template') {
    const checked = forgeTemplateSchema.safeParse(parsed);
    return checked.success
      ? { file: { kind: 'template', template: checked.data } }
      : { refusal: issues(checked.error) };
  }
  const checked = configFileSchema.safeParse(parsed);
  if (checked.success) return { file: { kind: 'config', config: checked.data } };
  return {
    refusal: [
      ...issues(checked.error),
      `${flag} takes ${CONFIG_FILE_KEYS.join(', ')}; the other choices have flags of their own.`,
    ],
  };
}

/**
 * What the line of a clone reads; a removal's and a verification's read their
 * own (`REMOVE_FLAGS`, `VERIFY_FLAGS`).
 */
const CLONE_FLAGS: CommandFlags = {
  switches: [
    '--list-objects',
    '--anonymize',
    '--keep-contact-points',
    '--dry-run',
    '--rehearse',
    '--accept-automation',
    '--accept-emails',
    '--mute-automation',
    '--upsert',
    '--expand-orphans',
    '--apply-assignment-rules',
    '--skip-preflight',
    '--json',
    '--fail-on-partial',
    '--write-uncertain',
    '--files',
    '--files-as-is',
    ...CHECKPOINT_FIRST_FLAGS.switches,
    // A removal's, refused with its own words below.
    '--include-changed',
  ],
  values: [
    '--record',
    '--source',
    '--target',
    '--object',
    '--where',
    '--depth',
    '--custom-depth',
    '--max',
    '--max-nodes',
    '--max-total',
    '--max-records-per-object',
    '--summary',
    '--resume',
    '--exclude',
    '--exclude-object',
    '--owner-map',
    '--filter',
    '--map',
    '--config',
    '--template',
    '--remap-csv',
    '--max-file-size',
    '--audit',
    ...CHECKPOINT_FIRST_FLAGS.values,
  ],
};

/**
 * Exit on the depth ALL: a clone of the whole org is a depth of the run's
 * schema, which would refuse it only for going with a record or tables. It is
 * not offered on the command line at all, which is what the refusal says.
 */
function refuseWholeOrgDepth(): never {
  process.stderr.write(
    '--depth all clones the whole org and is only offered in the Forge panel for now.\n',
  );
  process.exit(2);
}

/** The command line read and checked; exits on `--help` or a bad flag. Exported so it can be tested. */
export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliArgs {
  const args = argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  // `--dry-run=true`, the way a pipeline writes `--dry-run=$DRY_RUN`, or a
  // misspelt `--dryrun`, was dropped without a word, and the clone wrote.
  refuseUnreadArguments(args, CLONE_FLAGS);
  const get = (flag: string, fallback?: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
  };
  const has = (flag: string): boolean => args.includes(flag);

  // The choices a file brings, read before anything else is checked: a
  // template may name the record to clone.
  if (has('--config') && has('--template')) {
    process.stderr.write('--config and --template: give one of them.\n');
    process.exit(2);
  }
  const choicesFlag: ChoicesFlag | undefined = has('--template')
    ? '--template'
    : has('--config')
      ? '--config'
      : undefined;
  const choicesPath = choicesFlag ? get(choicesFlag) : undefined;
  let choices: ChoicesFile | undefined;
  if (choicesFlag) {
    if (!choicesPath || choicesPath.startsWith('--')) {
      process.stderr.write(`${choicesFlag} takes the path of a JSON file.\n`);
      process.exit(2);
    }
    let text: string;
    try {
      text = readFileSync(choicesPath, 'utf8');
    } catch (err: unknown) {
      process.stderr.write(
        `${choicesFlag}: cannot read ${choicesPath}: ${extractErrorMessage(err)}\n`,
      );
      process.exit(2);
    }
    const read = readChoicesFile(choicesFlag, text);
    if ('refusal' in read) {
      for (const line of read.refusal) process.stderr.write(`${line}\n`);
      process.exit(2);
    }
    choices = read.file;
  }
  const template = choices?.kind === 'template' ? choices.template : undefined;
  // A template saved from a clone of the whole org in the Forge panel: what
  // it clones is the whole org, which the command does not offer — not a
  // record, a query or tables whose choices it could take.
  if (template?.config.inputMode === 'org' || template?.config.depth === 'all') {
    process.stderr.write(
      '--template: the template clones the whole org (the depth ALL), which is only offered ' +
        'in the Forge panel for now.\n',
    );
    process.exit(2);
  }
  // The flag, told before what else the line lacks: `--depth all` names no
  // record, as a clone of the whole org takes none, and was answered that a
  // required flag was missing rather than why the depth is refused.
  if (get('--depth') === 'all') refuseWholeOrgDepth();
  /** What the file decides, leaves out, filters and maps: the template's config, or the config. */
  const fileChoices: Partial<ForgeConfigInput> =
    choices?.kind === 'template' ? { ...choices.template.config } : (choices?.config ?? {});
  // A template of a query holds the query's WHERE clause as its root's filter:
  // the command clones a record, and held to that clause, the record's own
  // object could read nothing. The panel leaves it to the query too.
  const queryRoot =
    template?.config.soqlQuery !== undefined ? queryRootOf(template.config.soqlQuery) : undefined;
  if (queryRoot !== undefined && fileChoices.objectSoqlFilters?.[queryRoot] !== undefined) {
    const filters = { ...fileChoices.objectSoqlFilters };
    delete filters[queryRoot];
    fileChoices.objectSoqlFilters = filters;
  }

  // Whole tables instead of a record: the objects named, each through its
  // filter, read and written as the panel runs a query.
  const tables = tableArgs(args);
  if (tables) {
    const refused = ['--record', '--expand-orphans', '--rehearse'].filter((flag) => has(flag));
    if (refused.length > 0) {
      process.stderr.write(
        `--object clones whole tables, as the panel runs a query: it does not go with ` +
          `${refused.join(', ')}, which ${refused.length === 1 ? 'goes' : 'go'} with a clone ` +
          'of one record (--record).\n',
      );
      process.exit(2);
    }
    // A template's choices go with the tables, its record or query aside: the
    // tables are the line's. Its orphan parents are refused as the flag is.
    if (template?.config.expandOrphanParents === true) {
      process.stderr.write(
        '--template: the template brings orphan parents (expandOrphanParents), which go with ' +
          'a clone of one record (--record), not with --object.\n',
      );
      process.exit(2);
    }
  }
  const templateRecord =
    template?.config.inputMode === 'record' ? template.config.recordId : undefined;
  if (template && !tables && !has('--record') && !templateRecord) {
    process.stderr.write(
      `--template: the template clones from a ${template.config.inputMode === 'record' ? 'record it does not name' : 'query'}, ` +
        'and the command clones from a record: give --record.\n',
    );
    process.exit(2);
  }
  const record = tables ? undefined : (get('--record') ?? templateRecord);
  const source = get('--source');
  const target = get('--target');
  if ((!record && !tables) || !source || !target) {
    process.stderr.write('Missing required flag. Run with --help for usage.\n');
    process.exit(2);
  }
  // The flag says what a removal takes; on a clone it would do nothing, and is
  // refused rather than ignored.
  if (has('--include-changed')) {
    process.stderr.write('--include-changed goes with --remove.\n');
    process.exit(2);
  }
  // A rehearsal creates rows and keeps none: a dry run writes none to judge,
  // an upsert writes over records a rehearsal cannot judge, and there is no
  // file copied nor id kept to export.
  const withRehearse = ['--dry-run', '--upsert', '--files', '--remap-csv', '--list-objects'].filter(
    (flag) => has(flag),
  );
  if (has('--rehearse') && withRehearse.length > 0) {
    process.stderr.write(`--rehearse does not go with ${withRehearse.join(', ')}.\n`);
    process.exit(2);
  }
  const summary = summaryArg(args);
  // A checkpoint of what the run writes, taken before its first write: of a
  // run that writes, and keeps, what it writes.
  const checkpointFirst = checkpointFirstArgs(args, [
    {
      flag: '--rehearse',
      why: 'a rehearsal keeps nothing it creates in the target, and there is nothing to take back.',
    },
    { flag: '--list-objects', why: 'it lists the objects of the graph, and writes nothing.' },
    {
      flag: '--resume',
      why:
        'a run taken up is the run its first part began, and a checkpoint taken now would hold ' +
        'what that part wrote: rewind to the one it took, if it took one.',
    },
  ]);

  // A template's depth and caps, each unless its flag is given.
  const depthRaw = get('--depth') ?? template?.config.depth ?? 'custom';
  const customDepthRaw =
    get('--custom-depth') ??
    (template?.config.customDepth !== undefined ? String(template.config.customDepth) : '5');
  const maxRaw =
    get('--max') ??
    (template?.config.maxRecordsPerObject !== undefined
      ? String(template.config.maxRecordsPerObject)
      : undefined);
  const maxNodesRaw =
    get('--max-nodes') ??
    (template?.config.maxNodes !== undefined ? String(template.config.maxNodes) : undefined);
  const maxTotalRaw = get('--max-total');
  const readCeilingRaw = get('--max-records-per-object');
  // Repeatable flags: scan all positions for matches.
  const collectRepeated = (flag: string): string[] => {
    const out: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === flag && i + 1 < args.length) out.push(args[i + 1]);
    }
    return out;
  };
  // The file's exclusions, filters and mappings first; the flags' are added
  // to them, or put in place of theirs for the same object, user or field.
  const fieldExclusions: Record<string, string[]> = Object.fromEntries(
    Object.entries(fileChoices.fieldExclusions ?? {}).map(([obj, fields]) => [obj, [...fields]]),
  );
  for (const raw of collectRepeated('--exclude')) {
    const dotIdx = raw.indexOf('.');
    if (dotIdx <= 0 || dotIdx === raw.length - 1) {
      process.stderr.write(`Invalid --exclude value "${raw}" (expected Object.field)\n`);
      process.exit(2);
    }
    const obj = raw.slice(0, dotIdx);
    const field = raw.slice(dotIdx + 1);
    if (!API_NAME_RE.test(obj) || !API_NAME_RE.test(field)) {
      process.stderr.write(
        `Invalid --exclude name in "${raw}" (must match SObject API name pattern)\n`,
      );
      process.exit(2);
    }
    const fields = (fieldExclusions[obj] ??= []);
    if (!fields.includes(field)) fields.push(field);
  }
  const excludedObjects: string[] = [...(fileChoices.excludedObjects ?? [])];
  for (const obj of collectRepeated('--exclude-object')) {
    if (!API_NAME_RE.test(obj)) {
      process.stderr.write(
        `Invalid --exclude-object value "${obj}" (must match SObject API name pattern)\n`,
      );
      process.exit(2);
    }
    if (!excludedObjects.includes(obj)) excludedObjects.push(obj);
  }
  const ownerMappings: Record<string, string> = { ...fileChoices.ownerMappings };
  for (const raw of collectRepeated('--owner-map')) {
    const eqIdx = raw.indexOf('=');
    if (eqIdx <= 0 || eqIdx === raw.length - 1) {
      process.stderr.write(`Invalid --owner-map value "${raw}" (expected sourceId=targetId)\n`);
      process.exit(2);
    }
    const src = raw.slice(0, eqIdx);
    const tgt = raw.slice(eqIdx + 1);
    if (!SF_ID_RE.test(src) || !SF_ID_RE.test(tgt)) {
      process.stderr.write(
        `Invalid --owner-map IDs in "${raw}" (must be 15 or 18 char Salesforce IDs)\n`,
      );
      process.exit(2);
    }
    ownerMappings[src] = tgt;
  }
  const objectSoqlFilters: Record<string, string> = { ...fileChoices.objectSoqlFilters };
  for (const raw of collectRepeated('--filter')) {
    const eqIdx = raw.indexOf('=');
    if (eqIdx <= 0 || eqIdx === raw.length - 1) {
      process.stderr.write(`Invalid --filter value "${raw}" (expected Object=where-clause)\n`);
      process.exit(2);
    }
    const obj = raw.slice(0, eqIdx);
    const where = raw.slice(eqIdx + 1);
    if (where.length > 512) {
      process.stderr.write(`--filter where-clause for "${obj}" exceeds 512 chars\n`);
      process.exit(2);
    }
    if (/--|\/\*|\*\/|;\s*$/.test(where)) {
      process.stderr.write(
        `--filter where-clause for "${obj}" contains forbidden tokens (--, /*, */, trailing ;)\n`,
      );
      process.exit(2);
    }
    objectSoqlFilters[obj] = where;
  }
  // The condition given with an --object is that table's filter, over the
  // file's; given with --filter too, the run could not say which one it read.
  const filtered = new Set(
    collectRepeated('--filter').map((raw) => raw.slice(0, raw.indexOf('='))),
  );
  for (const table of tables ?? []) {
    if (table.where === undefined) continue;
    if (filtered.has(table.objectApiName)) {
      process.stderr.write(
        `--where and --filter both filter ${table.objectApiName}: give one of them.\n`,
      );
      process.exit(2);
    }
    if (table.where.length > 512) {
      process.stderr.write(`--where for "${table.objectApiName}" exceeds 512 chars\n`);
      process.exit(2);
    }
    if (/--|\/\*|\*\/|;\s*$/.test(table.where)) {
      process.stderr.write(
        `--where for "${table.objectApiName}" contains forbidden tokens (--, /*, */, trailing ;)\n`,
      );
      process.exit(2);
    }
    objectSoqlFilters[table.objectApiName] = table.where;
  }
  const fieldMappings: Record<string, Record<string, string>> = Object.fromEntries(
    Object.entries(fileChoices.fieldMappings ?? {}).map(([obj, renames]) => [obj, { ...renames }]),
  );
  for (const raw of collectRepeated('--map')) {
    const dotIdx = raw.indexOf('.');
    const eqIdx = raw.indexOf('=');
    if (dotIdx <= 0 || eqIdx <= dotIdx + 1 || eqIdx === raw.length - 1) {
      process.stderr.write(
        `Invalid --map value "${raw}" (expected Object.sourceField=targetField)\n`,
      );
      process.exit(2);
    }
    const obj = raw.slice(0, dotIdx);
    const src = raw.slice(dotIdx + 1, eqIdx);
    const tgt = raw.slice(eqIdx + 1);
    if (!API_NAME_RE.test(src) || !API_NAME_RE.test(tgt)) {
      process.stderr.write(
        `Invalid --map field name in "${raw}" (must match SObject API name pattern)\n`,
      );
      process.exit(2);
    }
    (fieldMappings[obj] ??= {})[src] = tgt;
  }
  const customDepth = customDepthRaw ? Number(customDepthRaw) : 5;
  const maxRecordsPerObject = maxRaw ? Number(maxRaw) : undefined;
  // Discovery stops at fifty objects by default, which a CRM graph exceeds
  // long before it has reached everything the clone could hold: an
  // Opportunity's fifty-odd children fill it before its quotes' lines are
  // reached. The catalog the lines price from comes whatever the cap.
  const maxNodes = maxNodesRaw ? Number(maxNodesRaw) : undefined;
  if (maxNodes !== undefined && (!Number.isInteger(maxNodes) || maxNodes < 1)) {
    process.stderr.write('--max-nodes takes a whole number of objects, 1 or more.\n');
    process.exit(2);
  }
  // A run of one record whose scope widened wrote 34 216 records into a
  // sandbox where its dry run had said 37: no run writes past this many.
  const maxTotal = maxTotalRaw === undefined ? DEFAULT_MAX_TOTAL : Number(maxTotalRaw);
  if (!Number.isInteger(maxTotal) || maxTotal < 1) {
    process.stderr.write('--max-total takes a whole number of records, 1 or more.\n');
    process.exit(2);
  }
  const readCeiling =
    readCeilingRaw === undefined ? FORGE_READ_CEILING_PER_OBJECT : Number(readCeilingRaw);
  if (
    !Number.isInteger(readCeiling) ||
    readCeiling < 1 ||
    readCeiling > FORGE_MAX_RECORDS_PER_OBJECT_BOUND
  ) {
    process.stderr.write(
      `--max-records-per-object takes a whole number of records, 1 to ` +
        `${FORGE_MAX_RECORDS_PER_OBJECT_BOUND}.\n`,
    );
    process.exit(2);
  }
  const pageSizeRaw = env['SANDFORGE_FORGE_PAGE_SIZE'];
  const pageSize =
    pageSizeRaw === undefined || pageSizeRaw === '' ? undefined : Number(pageSizeRaw);
  if (pageSize !== undefined && (!Number.isInteger(pageSize) || pageSize < 1)) {
    process.stderr.write('SANDFORGE_FORGE_PAGE_SIZE takes a whole number of rows, 1 or more.\n');
    process.exit(2);
  }
  // A template that anonymizes or keeps contact points does so unless told
  // otherwise; there is no flag to turn either off, so the flag adds to it.
  const anonymize = has('--anonymize') || template?.config.anonymizePII === true;
  const keepContactPoints =
    has('--keep-contact-points') || template?.config.keepContactPoints === true;
  const files = fileCopyArgs(args, anonymize);
  const decisions = runDecisionsOf(fileChoices);

  // The schema the wizard's ForgeConfig goes through, run on the same fields.
  // Without it `--depth deep` was cast into the union, and a malformed record
  // ID or object name was only refused after both orgs had been authenticated.
  const checked = forgeConfigSchemaStrict.safeParse({
    ...(tables
      ? { inputMode: 'soql', soqlQuery: tablesQueryOf(tables) }
      : { inputMode: 'record', recordId: record }),
    depth: depthRaw,
    customDepth: depthRaw === 'custom' ? customDepth : undefined,
    sourceOrgId: source,
    targetOrgId: target,
    anonymizePII: anonymize,
    keepContactPoints,
    skipEmpty: true,
    batchSize: 'auto',
    maxRecordsPerObject,
    fieldExclusions,
    excludedObjects,
    ownerMappings,
    objectSoqlFilters,
    fieldMappings,
    ...decisions,
  });
  if (!checked.success) {
    for (const issue of checked.error.issues) {
      const [field, ...rest] = issue.path.map(String);
      const flag =
        FLAG_OF_FIELD[field ?? ''] ??
        (choicesFlag && field ? `${choicesFlag} ${field}` : (field ?? 'arguments'));
      const at = rest.length > 0 ? ` (${rest.join('.')})` : '';
      process.stderr.write(`Invalid ${flag}${at}: ${issue.message}\n`);
    }
    process.exit(2);
  }
  // Refused above, the flag and the template both: what remains is a walk
  // from the root. The schema's `'all'` is told in words all the same, should
  // the checks above ever move behind it.
  const { depth } = checked.data;
  if (depth === 'all') refuseWholeOrgDepth();

  return {
    record,
    tables,
    source,
    target,
    depth,
    customDepth,
    maxNodes,
    maxRecordsPerObject,
    anonymize,
    keepContactPoints: checked.data.keepContactPoints === true,
    dryRun: has('--dry-run'),
    listObjects: has('--list-objects'),
    upsert: has('--upsert'),
    expandOrphans: has('--expand-orphans') || template?.config.expandOrphanParents === true,
    applyAssignmentRules:
      has('--apply-assignment-rules') || template?.config.applyAssignmentRules === true,
    skipPreflight: has('--skip-preflight'),
    json: has('--json'),
    failOnPartial: has('--fail-on-partial'),
    summary,
    fieldExclusions,
    excludedObjects,
    ownerMappings,
    objectSoqlFilters,
    fieldMappings,
    remapCsv: remapCsvArg(args),
    files,
    acceptAutomation: has('--accept-automation'),
    acceptEmails: has('--accept-emails'),
    muteAutomation: has('--mute-automation'),
    ...(checkpointFirst !== undefined ? { checkpointFirst } : {}),
    maxTotal,
    readCeiling,
    ...(pageSize !== undefined ? { pageSize } : {}),
    rehearse: has('--rehearse'),
    decisions,
    anonymizationRules: { ...template?.anonymization?.rules },
    anonymizeFields: template?.anonymization?.fields,
    choicesFrom: choicesFlag && choicesPath ? { flag: choicesFlag, path: choicesPath } : undefined,
    audit: auditArg(args),
    resume: resumeArg(args),
    writeUncertain: writeUncertainArg(args),
  };
}

/** Whether `--write-uncertain` was given; exits 2 on one given without `--resume`. */
function writeUncertainArg(args: readonly string[]): boolean {
  if (!args.includes('--write-uncertain')) return false;
  if (!args.includes('--resume')) {
    process.stderr.write(
      '--write-uncertain goes with --resume: it writes the rows of a call under way when the ' +
        'run stopped that the target may already hold.\n',
    );
    process.exit(2);
  }
  return true;
}

/**
 * Why a resume stops before it writes, when the target may already hold rows
 * of a call the run had under way: how many, of which objects, and the two
 * ways on. Exported so it can be tested.
 */
export function uncertainRefusal(reconciled: InFlightReconciliation, target: string): string {
  const rows = uncertainRows(reconciled);
  const objects = reconciled.uncertain
    .map(({ objectApiName, rows: count }) => `${count} ${objectApiName}`)
    .join(', ');
  return (
    `${rows} row(s) may already be in ${target} (${objects}): the insert call that sent them was ` +
    `under way when the run stopped, its answer never kept, and ${target} holds records the ` +
    'resume cannot tell from them, or could not be read. Nothing was written. Look at the ' +
    `records of those objects the run's user created in ${target} as the run stopped; run the ` +
    'same --resume with --write-uncertain to write those rows all the same (one already there ' +
    'is then there twice), or --remove the run.'
  );
}

/**
 * What `--resume` names, read and checked; exits 2 on a flag given nothing,
 * and with a flag of a run that writes nothing to take up.
 */
function resumeArg(args: readonly string[]): string | undefined {
  const at = args.indexOf('--resume');
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (value === undefined || value.startsWith('--')) {
    process.stderr.write('--resume takes the journal of the run to take up, or its run id.\n');
    process.exit(2);
  }
  const without = ['--dry-run', '--rehearse', '--list-objects'].filter((flag) =>
    args.includes(flag),
  );
  if (without.length > 0) {
    process.stderr.write(
      `--resume takes a run up and writes: it does not go with ${without.join(', ')}.\n`,
    );
    process.exit(2);
  }
  return value;
}

/**
 * Where the command keeps the journals of the runs that write:
 * `SANDFORGE_JOURNAL_DIR`, or `.sandforge` in the home directory. Exported so
 * it can be tested.
 */
export function journalDirOf(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env['SANDFORGE_JOURNAL_DIR'];
  return dir !== undefined && dir.trim() !== ''
    ? resolvePath(dir)
    : joinPath(homedir(), '.sandforge');
}

/**
 * The journal file `--resume` names: the file it gives, or the journal of the
 * run id it gives. Exported so it can be tested.
 */
export function resumedJournalPath(value: string, journals: ForgeRunJournal): string {
  return value.endsWith('.ndjson') || /[\\/]/.test(value)
    ? resolvePath(value)
    : journals.pathOf(value);
}

/**
 * What a run of the command is fingerprinted by (`forgeRunFingerprint`): the
 * orgs, the record, and every flag and choice that changes what it reads,
 * decides or writes — not the diagnostic's pages, which change none of it.
 * Exported so it can be tested.
 */
export function cliRunSetup(args: CliArgs, targetOrgId: string): Record<string, unknown> {
  return {
    source: args.source,
    targetOrgId: targetOrgId.slice(0, 15),
    record: args.record,
    // Only a clone of whole tables names them: a clone of one record keeps
    // the fingerprint its journals were begun with.
    ...(args.tables ? { tables: args.tables } : {}),
    depth: args.depth,
    customDepth: args.depth === 'custom' ? args.customDepth : null,
    maxNodes: args.maxNodes ?? null,
    maxRecordsPerObject: args.maxRecordsPerObject ?? null,
    anonymize: args.anonymize,
    keepContactPoints: args.keepContactPoints,
    upsert: args.upsert,
    expandOrphans: args.expandOrphans,
    applyAssignmentRules: args.applyAssignmentRules,
    fieldExclusions: args.fieldExclusions,
    excludedObjects: args.excludedObjects,
    ownerMappings: args.ownerMappings,
    objectSoqlFilters: args.objectSoqlFilters,
    fieldMappings: args.fieldMappings,
    decisions: args.decisions ?? null,
    anonymizationRules: args.anonymizationRules,
    anonymizeFields: args.anonymizeFields ?? null,
    files: args.files ?? null,
    readCeiling: args.readCeiling,
  };
}

/**
 * Why the run the journal at `journalPath` keeps cannot be taken up by this
 * one, or nothing when it can: no journal there, one that does not say how
 * its run was set up, a run that ended, another target, another setup.
 * Exported so it can be tested.
 */
export async function resumeRefusal(
  journals: ForgeRunJournal,
  journalPath: string,
  run: { target: string; targetOrgId: string; graph: ForgeGraph; setup: unknown },
): Promise<{ code: string; message: string } | undefined> {
  const head = await journals.headAt(journalPath);
  if (!head) {
    return {
      code: 'RESUME_UNAVAILABLE',
      message: `--resume ${journalPath}: there is no journal of a run there.`,
    };
  }
  if (!head.resume) {
    return {
      code: 'RESUME_UNAVAILABLE',
      message: `--resume ${journalPath}: the journal does not say how its run was set up, and the run cannot be taken up.`,
    };
  }
  const end = await journals.lastEndAt(journalPath);
  if (end?.status === 'success') {
    return {
      code: 'RESUME_UNAVAILABLE',
      message: `--resume ${journalPath}: the run ended, and there is nothing of it to take up.`,
    };
  }
  if (head.targetOrgId.slice(0, 15) !== run.targetOrgId.slice(0, 15)) {
    return {
      code: 'RESUME_TARGET_CHANGED',
      message:
        `${run.target} is not the org the run to take up wrote to (${head.targetOrgId}): it is ` +
        'taken up there only. Nothing was written.',
    };
  }
  if (!sameRunSetup(head.resume.fingerprint, run.graph, run.setup)) {
    return {
      code: 'RESUME_CHANGED',
      message:
        'The clone is set up otherwise than the run to take up: give the same record or ' +
        'tables, orgs, depth, choices and flags it ran with. Nothing was written.',
    };
  }
  return undefined;
}

/**
 * Where `--audit` keeps the audit trail, read and checked; exits 2 on a flag
 * given no file, and on a file there that is not a store the command can add
 * to — refused before any org is contacted, where it would otherwise lose the
 * run's entry once the run had written.
 */
function auditArg(args: readonly string[]): string | undefined {
  const at = args.indexOf('--audit');
  if (at < 0) return undefined;
  const path = args[at + 1];
  if (path === undefined || path.startsWith('--')) {
    process.stderr.write('--audit takes the file the audit trail is kept in.\n');
    process.exit(2);
  }
  try {
    fileConfigStore(path);
  } catch (err: unknown) {
    process.stderr.write(
      `--audit ${path} is not an audit trail the command can add to (${extractErrorMessage(err)}): ` +
        'give another file, or move it.\n',
    );
    process.exit(2);
  }
  return path;
}

/** An org an entry of `--audit` names: the alias it was reached by, and the user the command ran as. */
export type AuditedOrg = { alias: string; username: string };

/**
 * What `--audit` records with: the panel's own store, kept in the file, and
 * the orgs the command reached by their own ids, the way the Frozen command
 * registers them. Exported so it can be tested.
 */
export function auditDepsOf(path: string, orgs: ReadonlyMap<string, AuditedOrg>): AuditDeps {
  return {
    configStore: fileConfigStore(path),
    orgManager: { getOrg: (id) => orgs.get(id) },
    log: (message) => process.stderr.write(`${message}\n`),
  };
}

/**
 * Add one run's entry to the audit trail `--audit` keeps, as the panel adds
 * its own (`recordWriteRun`); nothing without the flag. A file that can no
 * longer be written is said, and the run's own outcome stands.
 */
function recordCliRun(
  path: string | undefined,
  orgs: ReadonlyMap<string, AuditedOrg>,
  run: WriteRun,
): void {
  if (!path) return;
  try {
    recordWriteRun(auditDepsOf(path, orgs), run);
  } catch (err: unknown) {
    process.stderr.write(
      `The run's entry could not be added to the audit trail in ${path} (${extractErrorMessage(err)}).\n`,
    );
  }
}

/**
 * Where `--summary` writes the run's summary, read and checked; exits 2 on a
 * flag given no file, one that goes with a run that creates nothing to take
 * back, and a file already there: it may be the summary of an earlier run,
 * the only way --remove takes that one back.
 */
function summaryArg(args: readonly string[]): string | undefined {
  const at = args.indexOf('--summary');
  if (at < 0) return undefined;
  const path = args[at + 1];
  if (path === undefined || path.startsWith('--')) {
    process.stderr.write('--summary takes the file to write the summary to.\n');
    process.exit(2);
  }
  const without = ['--list-objects', '--rehearse'].filter((flag) => args.includes(flag));
  if (without.length > 0) {
    process.stderr.write(`--summary does not go with ${without.join(', ')}.\n`);
    process.exit(2);
  }
  if (existsSync(path)) {
    process.stderr.write(
      `--summary ${path} exists, and is not overwritten: it may be the summary of an earlier ` +
        'run, which --remove takes that run back from. Give another file, or move it.\n',
    );
    process.exit(2);
  }
  return path;
}

/**
 * Where `--remap-csv` writes the table of the ids the run gave, read and
 * checked; exits 2 on a flag given no file, a file outside the working
 * directory or without the `.csv` extension, and one already there. Checked
 * once every record was written, the three refused the run after it had
 * written, and its summary was never printed. The containment and the
 * extension keep a misuse from clobbering a file that matters (an
 * authorized_keys, a profile script, a scheduled task's XML).
 *
 * @returns The file, resolved against the working directory.
 */
function remapCsvArg(args: readonly string[]): string | undefined {
  const at = args.indexOf('--remap-csv');
  if (at < 0) return undefined;
  const given = args[at + 1];
  if (given === undefined || given.startsWith('--')) {
    process.stderr.write('--remap-csv takes the .csv file to write the id table to.\n');
    process.exit(2);
  }
  const resolved = resolvePath(process.cwd(), given);
  const cwdResolved = resolvePath(process.cwd());
  const inside = resolved === cwdResolved || resolved.startsWith(cwdResolved + sep);
  if (!inside) {
    process.stderr.write(
      `--remap-csv must stay inside cwd: "${given}" resolves outside ${cwdResolved}\n`,
    );
    process.exit(2);
  }
  if (!resolved.toLowerCase().endsWith('.csv')) {
    process.stderr.write(`--remap-csv must use a .csv extension: "${given}"\n`);
    process.exit(2);
  }
  if (existsSync(resolved)) {
    process.stderr.write(
      `--remap-csv refuses to overwrite existing file: "${resolved}". Give another file, or ` +
        'move it.\n',
    );
    process.exit(2);
  }
  return resolved;
}

/**
 * The file flags read and checked; exits 2 on a combination that cannot run.
 *
 * `--anonymize` covers the records and never the files, whose content cannot
 * be anonymized: with it, `--files` copies nothing unless `--files-as-is`
 * says the files may go as they are. The other two flags only mean something
 * with `--files`, and are refused without it rather than ignored.
 */
function fileCopyArgs(args: readonly string[], anonymize: boolean): CliArgs['files'] {
  const wanted = args.includes('--files');
  const acceptedAsIs = args.includes('--files-as-is');
  const sizeAt = args.indexOf('--max-file-size');
  const sizeRaw = sizeAt >= 0 ? args[sizeAt + 1] : undefined;
  if (!wanted) {
    if (acceptedAsIs || sizeAt >= 0) {
      process.stderr.write('--files-as-is and --max-file-size go with --files.\n');
      process.exit(2);
    }
    return undefined;
  }
  const maxFileSizeMB = sizeAt >= 0 ? Number(sizeRaw) : FILE_COPY_DEFAULT_MAX_MB;
  if (
    !Number.isInteger(maxFileSizeMB) ||
    maxFileSizeMB < 1 ||
    maxFileSizeMB > FILE_COPY_CEILING_MB
  ) {
    process.stderr.write(
      `--max-file-size takes a whole number of MB from 1 to ${FILE_COPY_CEILING_MB}, ` +
        'the most one call to Salesforce carries.\n',
    );
    process.exit(2);
  }
  const refusal = fileCopyRefusal(anonymize, acceptedAsIs);
  if (refusal) {
    process.stderr.write(
      '--anonymize anonymizes the records, and the content of a file cannot be anonymized: ' +
        'add --files-as-is to accept that files are copied as they are, or leave out --files.\n',
    );
    process.exit(2);
  }
  return { maxFileSizeMB, acceptedAsIs };
}

/** Shape a raw describe for the discovery service; exported so the field reading can be tested. */
export function adaptDescribe(raw: DescribeSObjectResult): ObjectDescribe {
  return {
    name: raw.name,
    fields: raw.fields.map((f) => ({
      name: f.name,
      type: String(f.type),
      referenceTo: (f.referenceTo ?? []).filter((r): r is string => typeof r === 'string'),
      relationshipName: f.relationshipName ?? null,
      // Reads cascadeDelete as the extension's own describe adapter does. The
      // flag is not decoration: discovery keeps a master-detail edge over a
      // lookup for the same object pair, and the plan breaks a cycle by
      // nulling a lookup only when the cycle has one.
      isMasterDetail: f.cascadeDelete === true,
      // Not decoration either: discovery admits a parent behind a lookup the
      // platform refuses to leave null even when the node cap is spent.
      // Dropped here, that rule could never fire for a CLI run.
      nillable: f.nillable !== false,
      // Nor these: a lookup neither an insert nor an update can set — a
      // person account's contact — orders nothing, and the clone's write
      // order would wait on it again.
      createable: f.createable !== false,
      updateable: f.updateable !== false,
    })),
    childRelationships: raw.childRelationships.map((c) => ({
      childSObject: c.childSObject,
      field: c.field,
      relationshipName: c.relationshipName ?? '',
      isCascadeDelete: Boolean(c.cascadeDelete),
    })),
  };
}

/**
 * Match the active record types of both orgs; exported so the match can be
 * tested.
 *
 * @param warn - Told each source record type left unmatched because the
 *   target holds its DeveloperName under another namespace only.
 */
export async function loadRecordTypes(
  sourceConn: Connection,
  targetConn: Connection,
  warn?: (line: string) => void,
): Promise<RecordTypeMapping[]> {
  // SobjectType is read so the match stays within one object: Account and
  // Opportunity can each have a "Business" record type. NamespacePrefix so
  // that a package's record type matches the same package's only: one can
  // carry the DeveloperName of the org's own.
  const soql =
    'SELECT Id, Name, DeveloperName, NamespacePrefix, SobjectType FROM RecordType WHERE IsActive = true';
  type RecordTypeRow = {
    Id: string;
    Name: string;
    DeveloperName: string;
    NamespacePrefix?: string | null;
    SobjectType: string;
  };
  // Every page, as the extension reads them: a query answers with 2 000
  // records at most and a cursor to the rest, and a record type past the
  // first page went unmatched. Each page is a request of the connection,
  // which the run's calls count.
  const readAll = async (conn: Connection): Promise<RecordTypeRow[]> =>
    (
      await queryAllPages<RecordTypeRow>(
        {
          query: async (q) => conn.query<RecordTypeRow>(q),
          queryMore: async (url) => conn.queryMore<RecordTypeRow>(url),
        },
        soql,
      )
    ).records;
  const [s, tgt] = await Promise.all([readAll(sourceConn), readAll(targetConn)]);
  const toInfo = (r: RecordTypeRow): RecordTypeInfo => ({
    id: r.Id,
    name: r.Name,
    developerName: r.DeveloperName,
    namespacePrefix: r.NamespacePrefix ? r.NamespacePrefix : null,
    sobjectType: r.SobjectType,
  });
  const [sourceTypes, targetTypes] = [s.map(toInfo), tgt.map(toInfo)];
  for (const mismatch of namespaceMismatches(sourceTypes, targetTypes)) {
    warn?.(namespaceMismatchWarning(mismatch));
  }
  return new RecordTypeMapper().buildMapping(sourceTypes, targetTypes);
}

/**
 * The describe of an object in an org, asked of the org once a run: discovery,
 * the run's catalog step and each object's read and write all answer from one
 * request for the same object, as the extension's describe cache has them do.
 * Asked afresh each time, a dry run of an opportunity at the default cap sent
 * 223 describes, 85 of them for an object the org had already described — the
 * catalog step describes every object of the graph once more before the first
 * row is read. A describe under way is shared; one that failed is asked
 * again. Exported so it can be tested.
 */
export function describeOnce(
  describe: (orgId: string, objectName: string) => Promise<DescribeSObjectResult>,
): (orgId: string, objectName: string) => Promise<DescribeSObjectResult> {
  const described = new Map<string, Promise<DescribeSObjectResult>>();
  return (orgId, objectName) => {
    const key = `${orgId}::${objectName}`;
    const known = described.get(key);
    if (known) return known;
    const asked = describe(orgId, objectName);
    described.set(key, asked);
    // Not kept when it fails: the next step that needs the object asks again.
    asked.catch(() => {
      if (described.get(key) === asked) described.delete(key);
    });
    return asked;
  };
}

/**
 * The key prefix and record types of an object, read from the describe the
 * connection already holds — `describe$` answers from jsforce's cache, which
 * the field describe of the same object filled — or, `fresh`, asked of the
 * org again: what a permission set the mute's lease assigned opened is in a
 * describe read after it. Exported so it can be tested.
 */
export async function describeObjectInfo(
  conn: Connection,
  objectName: string,
  fresh = false,
): Promise<TargetObjectInfo> {
  const meta = fresh ? await conn.sobject(objectName).describe() : await conn.describe$(objectName);
  return {
    keyPrefix: meta.keyPrefix ?? null,
    recordTypes: parseRecordTypeInfos(meta.recordTypeInfos),
  };
}

/**
 * Whether a run failed outright: records failed, the read of an object did, or
 * an object was skipped whole, and none was created, updated or linked, nor —
 * for a dry run — would have been inserted. A failed read counts no record —
 * the clone never learned how many of its rows it held — so a run whose every
 * read failed has none failed. A run that linked what it could not create, or
 * wrote over what its external ids matched, has done part of its job; so has
 * one whose second pass left lookups empty. Read from the status the run's
 * audit entry records, so the exit code and the history say the same thing.
 * Exported so it can be tested.
 */
export function failedOutright(summary: ExecutionSummary): boolean {
  return finishedRunStatus(summary) === 'failure';
}

/** Why records went without a record type, as a line says it of them. */
const WITHOUT_RECORD_TYPE: Readonly<Record<WithoutRecordTypeWhy, string>> = {
  masterInSource: 'on Master in the source',
  notRead: 'whose record type the run does not write',
  decidedDefault: 'sent to the default by your decision',
  dropped: 'whose record type the target lacks or keeps from the user',
};

/** A record type as a line names it: its API name, and its label when that says something else. */
function recordTypeNamed({
  developerName,
  label,
}: {
  developerName: string;
  label: string;
}): string {
  return label !== '' && label !== developerName ? `${developerName} (${label})` : developerName;
}

/**
 * What the line of an object says the target gives its records created
 * without a record type, as its describe tells it: the type, and why the
 * platform gives it that one.
 */
function predictedWords(entry: RecordTypeGiven, verb: string): string {
  const { predicted } = entry;
  if (!predicted) {
    return `${verb} on Master, which the target gives a record sent without one for the user the run writes as`;
  }
  const named = recordTypeNamed(predicted);
  return predicted.basis === 'userDefault'
    ? `${verb} as ${named}, the default record type of the user the run writes as`
    : `${verb} as ${named}, the only other ${entry.objectApiName} record type open to the ` +
        'user the run writes as, whose describe names Master the default';
}

/**
 * What an object's line says of what its records were read back holding,
 * against what the describe said: one type, the one said, in a few words;
 * another, or several, each with its count, and the target's automation
 * named as what set them.
 */
function readBackWords(
  entry: RecordTypeGiven,
  readBack: NonNullable<RecordTypeGiven['readBack']>,
): string {
  const on = readBack.read < entry.rows ? `${readBack.read} of ${entry.rows}` : `${readBack.read}`;
  const said = entry.predicted?.developerName ?? 'Master';
  const [only, ...others] = readBack.types;
  if (only && others.length === 0 && only.developerName === said) {
    return `went in as ${recordTypeNamed(only)}, read back on ${on}`;
  }
  if (!only) return `none of them found as they were read back (asked of ${on})`;
  const held = readBack.types.map((type) => `${type.rows} ${recordTypeNamed(type)}`).join(', ');
  return (
    `read back on ${on}: ${held}; the describe said ${said}: an automation of the target sets ` +
    'the record type'
  );
}

/**
 * What a run says of the records it created without a record type into a
 * target whose object has one besides Master, one line an object: how many,
 * why each went without one, and the type the target gives them — of a dry
 * run, what the describe of the user the run writes as says; of a real run,
 * what the first of them were read back holding, the describe's word said
 * beside it only where the target holds another. Exported so it can be
 * tested.
 */
export function recordTypeGivenLines(
  entries: readonly RecordTypeGiven[],
  dryRun: boolean,
): string[] {
  if (entries.length === 0) return [];
  const lines = [
    `record types the target ${dryRun ? 'would give' : 'gave'} the records created without one ` +
      `(${entries.length} object(s)):`,
  ];
  for (const entry of entries) {
    const whys = (Object.keys(WITHOUT_RECORD_TYPE) as WithoutRecordTypeWhy[]).filter(
      (why) => (entry.why[why] ?? 0) > 0,
    );
    const why =
      whys.length === 1
        ? ` ${WITHOUT_RECORD_TYPE[whys[0]!]}`
        : whys.length > 1
          ? ` (${whys.map((w) => `${entry.why[w]} ${WITHOUT_RECORD_TYPE[w]}`).join(', ')})`
          : '';
    const { readBack } = entry;
    const outcome = dryRun
      ? predictedWords(entry, 'would go in')
      : !readBack
        ? predictedWords(entry, 'went in, its describe says,')
        : readBack.unread !== undefined
          ? `${predictedWords(entry, 'went in, its describe says,')}; the record types they ` +
            `hold could not be read back: ${readBack.unread}`
          : readBackWords(entry, readBack);
    lines.push(`  ${entry.objectApiName}  ${entry.rows} record(s)${why}: ${outcome}`);
  }
  return lines;
}

/**
 * What `--files` did, or — on a dry run — would do: per object the files and
 * their size, the links to the other cloned records, every file left out
 * with why, and on a dry run a lookup of the files that failed. Exported so
 * it can be tested.
 */
export function fileLines(files: ForgeFilesReport, dryRun: boolean): string[] {
  const cap = formatFileSize(files.maxFileBytes);
  const lines = [`files (up to ${cap} each):`];
  // A lookup that failed hides an unknown number of files: what the others
  // found is not all there is, and none found is not none to copy.
  if (files.lookupFailure) {
    lines.push(`  ${files.lookupFailure}`, '  A real run stops here, before writing anything.');
  }
  for (const entry of files.objects) {
    const size = formatFileSize(entry.plannedBytes);
    lines.push(
      dryRun
        ? `  ${entry.objectApiName}  ${entry.planned} would be copied (${size}, dry run, nothing written)`
        : `  ${entry.objectApiName}  ${entry.copied} of ${entry.planned} copied (${size})` +
            (entry.failed > 0 ? `, ${entry.failed} failed` : ''),
    );
  }
  if (files.objects.length === 0 && !files.lookupFailure) lines.push('  none to copy');
  if (dryRun && files.wouldCopy && files.wouldCopy.length > 0) {
    lines.push(`  would copy (${files.wouldCopy.length}):`);
    for (const file of files.wouldCopy) {
      lines.push(`    ${file.objectApiName}  ${file.name}  ${formatFileSize(file.bytes)}`);
    }
  }
  if (files.links > 0) lines.push(`  links to other cloned records: ${files.links}`);
  if (files.remainingStorageBytes !== undefined) {
    lines.push(`  target file storage left: ${formatFileSize(files.remainingStorageBytes)}`);
  }
  if (files.leftOut.length > 0) {
    lines.push(`  left out (${files.leftOut.length}):`);
    for (const file of files.leftOut) {
      const why =
        file.reason === 'too-large'
          ? `larger than ${cap}`
          : file.reason === 'external'
            ? 'kept outside Salesforce'
            : 'its records were not created by this run';
      lines.push(`    ${file.objectApiName}  ${file.name}  ${formatFileSize(file.bytes)} — ${why}`);
    }
  }
  return lines;
}

/**
 * The objects a read was cut at the read ceiling (`--max-records-per-object`)
 * with rows left in the source, and the ceiling, as `cappedObjects` names the
 * objects a read stopped at `--max`; undefined when no read was cut.
 */
function truncatedObjectsOf(
  summary: Pick<ExecutionSummary, 'truncatedObjects'>,
  readCeiling: number | undefined,
): { perObject?: number; objects: string[] } | undefined {
  const objects = summary.truncatedObjects ?? [];
  if (objects.length === 0) return undefined;
  return {
    ...(readCeiling !== undefined ? { perObject: readCeiling } : {}),
    objects: [...objects],
  };
}

/**
 * The line of the records a run linked to rather than created: those the
 * target held before the run, and apart from them those the platform wrote
 * itself with a record the run created, in the words each object's line uses.
 * All said "already in the target", the owner's member and split of the run's
 * opportunity read as records the target held before the run.
 */
function linkedLine(
  summary: Pick<ExecutionSummary, 'linkedCount' | 'writtenByThePlatform'>,
): string {
  const byWords = new Map<string, number>();
  for (const { objectApiName, rows } of summary.writtenByThePlatform ?? []) {
    const words = writtenWithWords(objectApiName);
    byWords.set(words, (byWords.get(words) ?? 0) + rows);
  }
  const byThePlatform = [...byWords.values()].reduce((sum, rows) => sum + rows, 0);
  if (byThePlatform === 0) {
    return `linked:  ${summary.linkedCount} (already in the target, not created)`;
  }
  const held = summary.linkedCount - byThePlatform;
  const parts = [
    ...(held > 0 ? [`${held} already in the target, not created`] : []),
    ...[...byWords].map(([words, rows]) => `${rows} written by the platform with ${words}`),
  ];
  return `linked:  ${summary.linkedCount} (${parts.join('; ')})`;
}

/**
 * The text summary of a run. Records the target already held are named apart
 * from the created and the failed ones: linked is neither, and a duplicate
 * nobody could identify is a failure whose children lost their lookup.
 * Exported so it can be tested.
 *
 * @param dryRun - Whether the run wrote nothing, for the files it would copy.
 * @param readCeiling - The most rows one read of an object took
 *   (`--max-records-per-object`), for the objects a read was cut at.
 * @param muteAssigns - Whether a real run's mute would assign permission
 *   sets, which may open record types a dry run's describe does not show.
 */
export function summaryLines(
  summary: ExecutionSummary,
  dryRun = false,
  readCeiling?: number,
  muteAssigns = false,
): string[] {
  const lines = [
    `success: ${summary.successCount}`,
    // A dry run creates nothing: what it would have inserted, under its own name.
    ...(summary.wouldInsertCount > 0
      ? [`would be inserted: ${summary.wouldInsertCount} (dry run, nothing written)`]
      : []),
    // Only an `--upsert` run updates: a row matched by its external id is a
    // record the target held, written over and not created.
    ...(summary.updatedCount > 0
      ? [`updated: ${summary.updatedCount} (matched by their external id, not created)`]
      : []),
    linkedLine(summary),
    // A read that failed is the object's failure, counted in no record: the
    // clone never learned how many of its rows it held.
    `failed:  ${summary.failedCount}` +
      (summary.failedReads.length > 0 ? ` (read failed: ${summary.failedReads.join(', ')})` : ''),
    `skipped: ${summary.skippedCount}`,
    `remaps:  ${summary.remapCount}`,
    // Counted as the run sent them; discovery's describes and counts before
    // it are not among them.
    ...(summary.apiCalls !== undefined
      ? [`calls:   ${summary.apiCalls} (requests the run sent to both orgs)`]
      : []),
  ];
  if (summary.existingRecords.length > 0) {
    lines.push('', `already in the target (${summary.existingRecords.length} object(s)):`);
    for (const e of summary.existingRecords) {
      const parts = [`${e.linked} linked`];
      if (e.unidentified > 0) {
        parts.push(`${e.unidentified} not identified — their children lost the link`);
      }
      lines.push(`  ${e.objectApiName}  ${parts.join(', ')}`);
    }
  }
  // A read that stopped at --max with rows left in the source: the results
  // panel says so, and the command printed nothing.
  if (summary.cappedObjects) {
    const { perObject, objects } = summary.cappedObjects;
    lines.push(
      '',
      // An environment caps it with its template's setting, not a flag.
      `stopped at ${perObject} records per object (${envWords('--max', 'maxRecordsPerObject')}), ` +
        `the source holding more, which were not cloned (${objects.length} object(s)):`,
      ...objects.map((objectApiName) => `  ${objectApiName}`),
    );
  }
  // A read cut at --max-records-per-object, the source holding more: the
  // help said such an object was said TRUNCATED, and the summary named
  // none of them, so a clone cut short read as whole.
  const truncated = truncatedObjectsOf(summary, readCeiling);
  if (truncated) {
    const ceiling = truncated.perObject !== undefined ? `${truncated.perObject} ` : '';
    // An environment's file has nothing that raises it: the flag is not named.
    const raisedBy = relayedByAnEnvironment() ? '' : ' (--max-records-per-object)';
    lines.push(
      '',
      `TRUNCATED at ${ceiling}records per object${raisedBy}, ` +
        `the source holding more, which were not cloned (${truncated.objects.length} object(s)):`,
      ...truncated.objects.map((objectApiName) => `  ${objectApiName}`),
    );
  }
  if (summary.files) lines.push('', ...fileLines(summary.files, dryRun));
  // Read, such a field gives its file's address, never the file: the clone
  // leaves it empty rather than write that address where the content goes.
  const leftOut = summary.fileContentFieldsLeftOut ?? [];
  if (leftOut.length > 0) {
    lines.push('', `left empty, as they hold a file's content (${leftOut.length} object(s)):`);
    for (const { objectApiName, fields } of leftOut) {
      lines.push(`  ${objectApiName}  ${fields.join(', ')}`);
    }
  }
  // Read masked by a user without View Encrypted Data, an encrypted field
  // gives its mask: the clone leaves it out rather than write the mask.
  const masked = summary.encryptedFieldsLeftOut ?? [];
  if (masked.length > 0) {
    lines.push(
      '',
      'left out, encrypted and read masked: the user the source is read as lacks View ' +
        `Encrypted Data, and the masks are not copied (${masked.length} object(s)):`,
    );
    for (const { objectApiName, fields } of masked) {
      lines.push(`  ${objectApiName}  ${fields.join(', ')}`);
    }
  }
  // A picklist value the target would refuse — for the field, or for the
  // record type the row goes in with — is replaced or left out rather than
  // sent to cost the row, and said, per object and field, with why.
  const picklists = summary.picklistValuesChanged ?? [];
  if (picklists.length > 0) {
    const objects = new Set(picklists.map((change) => change.objectApiName)).size;
    lines.push('', `picklist values not written as read (${objects} object(s)):`);
    for (const change of picklists) {
      lines.push(`  ${change.objectApiName}  ${describePicklistChange(change)}`);
    }
  }
  // A row in a currency the target does not hold active goes in another, its
  // amounts converted into it: said per object, with the currencies.
  const currencies = summary.currenciesReplaced ?? [];
  if (currencies.length > 0) {
    const objects = new Set(currencies.map((entry) => entry.objectApiName)).size;
    lines.push('', `written in another currency (${objects} object(s)):`);
    for (const entry of currencies) {
      lines.push(`  ${entry.objectApiName}  ${describeCurrencyReplaced(entry)}`);
    }
  }
  // A record on Master in the source goes without a record type, and the
  // target gives it the one it gives the user the run writes as: not always
  // the default its describe names. Said per object, with what was read back.
  const recordTypes = recordTypeGivenLines(summary.recordTypesGiven ?? [], dryRun);
  if (recordTypes.length > 0) {
    lines.push('', ...recordTypes);
    // A dry run assigns nothing, and what it says is what the user has now.
    if (dryRun && muteAssigns) {
      lines.push(
        '  the permission sets a real run assigns to mute the automation may open other record ' +
          'types to the user it writes as: it reads them again once assigned, and its summary ' +
          'says what the target gave',
      );
    }
  }
  // Refused by a validation rule on the fields it named, by a restricted
  // picklist on their value, or by the lookup filter of a lookup the target
  // lets be empty, and written again without them: in the target, each short
  // of a value the source held. Each field says which refused it; one
  // recorded before a picklist's refusal was written again is a rule's.
  const withoutFields = summary.writtenWithoutFields ?? [];
  if (withoutFields.length > 0) {
    lines.push(
      '',
      `written again without a field the target refused (${withoutFields.length} object(s)):`,
    );
    for (const { objectApiName, fields } of withoutFields) {
      for (const { field, refusedBy = 'validation-rule', reason, rows } of fields) {
        lines.push(
          `  ${objectApiName}.${field}  ${rows} record(s) — ${REFUSED_IT[refusedBy]} — ${reason}`,
        );
      }
    }
  }
  if (summary.contactPoints) lines.push('', ...contactPointLines(summary.contactPoints, dryRun));
  // A call whose answer never came back may have written its rows: the target
  // may hold them, and nothing the run knows reaches them.
  const mayHaveBeenWritten = summary.mayHaveBeenWritten ?? [];
  if (mayHaveBeenWritten.length > 0) {
    lines.push(
      '',
      'may be in the target, under ids the run never learned ' +
        `(${envWords('--remove', 'destroy')} cannot reach them):`,
    );
    for (const { objectApiName, sourceIds } of mayHaveBeenWritten) {
      lines.push(`  ${objectApiName}  ${sourceIds.length} record(s)`);
    }
  }
  if (summary.decisionsApplied && summary.decisionsApplied.length > 0) {
    lines.push('', ...decisionLines(summary.decisionsApplied));
  }
  if (summary.gaps) lines.push('', ...simulationGapLines(summary.gaps));
  if (summary.errors.length > 0) {
    lines.push('', `errors (${summary.errors.length} object(s)):`);
    for (const e of summary.errors) {
      lines.push(`  [${e.stage}] ${e.objectApiName}  ${e.failedCount}/${e.attemptedCount}`);
      // Every sample the run kept, as the results panel shows them: grouped
      // by reason, a product clone's held-back products came in three groups,
      // and the command printed two.
      for (const s of e.samples) {
        lines.push(`    ${s.recordSummary}`);
        for (const m of s.messages) lines.push(`      └ ${m}`);
      }
    }
  }
  return lines;
}

/** What a gap's detail says on its line: a length, digits, the value written instead, where to map. */
function gapDetail(gap: ForgeGap): string {
  const detail = gap.detail ?? {};
  const parts: string[] = [];
  if (typeof detail['longest'] === 'number' && typeof detail['length'] === 'number') {
    parts.push(`longest ${detail['longest']} of ${detail['length']} characters`);
  }
  if (typeof detail['precision'] === 'number') {
    parts.push(`precision ${detail['precision']}, scale ${String(detail['scale'] ?? 0)}`);
  }
  if (typeof detail['replacement'] === 'string')
    parts.push(`written as "${detail['replacement']}"`);
  const converted = detail['amountsConverted'];
  if (Array.isArray(converted) && converted.length > 0) {
    parts.push(`amounts converted into it: ${converted.join(', ')}`);
  }
  if (detail['amountsAsRead'] === true)
    parts.push('amounts written as read, no rate converts them');
  if (typeof detail['colliding'] === 'number') {
    parts.push(`${detail['colliding']} value(s) already in the target`);
  }
  if (detail['linkedToTheRecordItNames'] === true) {
    parts.push('a real run links each row to the record the target holds');
  }
  const mapTo = detail['mapTo'];
  if (Array.isArray(mapTo) && mapTo.length > 0) parts.push(`may map to ${mapTo.join(', ')}`);
  if (detail['ignored'] === true) parts.push('ignored');
  return parts.length > 0 ? ` (${parts.join('; ')})` : '';
}

/**
 * What a dry run found the target would refuse or change, row by row, one
 * line a gap: its severity, the object and field, what it is about, and the
 * rows it touches. Exported so it can be tested.
 */
export function simulationGapLines(gaps: readonly ForgeGap[]): string[] {
  if (gaps.length === 0) {
    return ['gaps: none found (dry run: nothing the target would refuse or change)'];
  }
  return [
    `gaps the target holds against the rows (${gaps.length}, dry run):`,
    ...gaps.map((gap) => {
      const where = gap.field ? `${gap.objectApiName}.${gap.field}` : gap.objectApiName;
      const value = gap.value !== undefined ? ` "${gap.value}"` : '';
      const recordType = gap.recordType !== undefined ? ` (record type ${gap.recordType})` : '';
      return (
        `  [${gap.severity}] ${where}  ${gap.kind}${value}${recordType}: ` +
        `${gap.rows} record(s)${gapDetail(gap)}`
      );
    }),
  ];
}

/**
 * The run's choices, when a file brought them (`--config`, `--template`), said
 * before discovery: what it leaves out, filters and maps, the flags' included,
 * and each decision it holds, one line each — those the run then applies are
 * counted in its summary, with the rows each changed. Nothing without a file.
 * Exported so it can be tested.
 */
export function choicesLines(
  args: Pick<
    CliArgs,
    | 'choicesFrom'
    | 'decisions'
    | 'fieldExclusions'
    | 'excludedObjects'
    | 'objectSoqlFilters'
    | 'ownerMappings'
    | 'fieldMappings'
  >,
): string[] {
  if (!args.choicesFrom) return [];
  // Relayed by an environment, the file is one it wrote from a resource of
  // its own file, gone once the plan ends, and no flag goes over it: a plan
  // said "choices from --template /tmp/sandforge-env-plan-…/<name>.json".
  const lines = [
    relayedByAnEnvironment()
      ? 'choices from the resource in the file:'
      : `choices from ${args.choicesFrom.flag} ${args.choicesFrom.path}, the flags over it:`,
  ];
  const fields = Object.entries(args.fieldExclusions).flatMap(([object, names]) =>
    names.map((name) => `${object}.${name}`),
  );
  if (fields.length > 0) lines.push(`  fields left out: ${fields.join(', ')}`);
  if (args.excludedObjects.length > 0) {
    lines.push(`  objects left out: ${args.excludedObjects.join(', ')}`);
  }
  for (const [object, where] of Object.entries(args.objectSoqlFilters)) {
    lines.push(`  filter ${object}: ${where}`);
  }
  const owners = Object.keys(args.ownerMappings).length;
  if (owners > 0) lines.push(`  owners mapped: ${owners}`);
  for (const [object, renames] of Object.entries(args.fieldMappings)) {
    for (const [from, to] of Object.entries(renames)) {
      lines.push(`  renamed: ${object}.${from} → ${to}`);
    }
  }
  const decided = args.decisions;
  const scope = (recordType: string | undefined): string =>
    recordType !== undefined ? ` (record type ${recordType})` : '';
  const decisions = [
    ...(decided?.picklistValueMappings ?? []).map(
      (m) =>
        `  ${m.object}.${m.field}  ${m.to === null ? 'leave_empty' : 'map_value'} "${m.from}"` +
        `${m.to !== null ? ` → "${m.to}"` : ''}${scope(m.recordType)}`,
    ),
    ...(decided?.recordTypeMappings ?? []).map(
      (m) =>
        `  ${m.object}  map_record_type "${m.from}" → ${m.to === null ? 'the default' : `"${m.to}"`}`,
    ),
    ...(decided?.defaultValues ?? []).map(
      (d) => `  ${d.object}.${d.field}  set_default "${String(d.value)}"`,
    ),
    ...(decided?.truncateFields ?? []).map((f) => `  ${f.object}.${f.field}  truncate`),
    ...(decided?.skippedRows ?? []).map((entry) => {
      const gap = forgeGapParts(entry.gapId);
      // One the run holds back nothing for is said so, with why: listed as
      // the others are, it was applied to nothing, and nothing said it.
      const why = whySkippedRowsIgnored(entry);
      return (
        `  ${entry.object}.${gap?.field ?? '?'}  skip_rows "${gap?.value ?? ''}"${scope(gap?.recordType)}` +
        (why !== undefined ? `: ignored, ${why}` : '')
      );
    }),
    ...(decided?.ignoredGaps ?? []).map((gapId) => `  ignore ${gapId}`),
  ];
  if (decisions.length > 0) lines.push(`  decisions (${decisions.length}):`, ...decisions);
  return lines;
}

/** The user's decisions the run applied, one line each with the rows it changed. Exported so it can be tested. */
export function decisionLines(applied: readonly ForgeDecisionApplied[]): string[] {
  return [
    `decisions applied (${applied.length}):`,
    ...applied.map((decision) => {
      const where = decision.field
        ? `${decision.objectApiName}.${decision.field}`
        : decision.objectApiName;
      const from = decision.from !== undefined ? ` "${decision.from}"` : '';
      const to = decision.to !== undefined ? ` → "${decision.to}"` : '';
      const scope =
        decision.recordType !== undefined ? ` (record type ${decision.recordType})` : '';
      return `  ${where}  ${decision.kind}${from}${to}${scope}: ${decision.rows} record(s)`;
    }),
  ];
}

/**
 * What became of the email addresses and phone numbers of the records: how
 * many values of which fields were neutralized — on a dry run, would be — or
 * that they went as read under `--keep-contact-points`. Exported so it can be
 * tested.
 */
export function contactPointLines(report: ForgeContactPointsReport, dryRun: boolean): string[] {
  if (!report.neutralized) {
    return [
      `contact points: written as read (${envWords('--keep-contact-points', 'keepContactPoints')}): ` +
        "the target's flows and email alerts may reach the people the records name",
    ];
  }
  const done = dryRun ? 'would be neutralized (dry run, nothing written)' : 'neutralized';
  return [
    `contact points: ${report.values} value(s) in ${report.fields.length} field(s) ${done} — ` +
      'emails under .invalid, phone numbers in a fictional range',
    ...report.fields.map(
      ({ objectApiName, field, values }) => `  ${objectApiName}.${field}  ${values}`,
    ),
    ...(report.numbersExhausted
      ? [
          `  ${report.numbersExhausted} phone number(s) left out, their field empty: the ` +
            '10 000 fictional numbers were all given to other numbers of the run',
        ]
      : []),
  ];
}

/** An external id `--upsert` may match the target's records by, written neutralized. */
export interface NeutralizedUpsertKey {
  objectApiName: string;
  field: string;
  kind: ForgeContactPointKind;
}

/**
 * The external ids `--upsert` may match the target's records by that hold an
 * email address or a phone number, which the run writes neutralized unless
 * `--keep-contact-points`: of each object the run writes, the createable
 * external ids the source describes, the fields the writer picks its key
 * among. Exported so it can be tested.
 *
 * @param objects - Per object, its fields as the source describes them.
 */
export function neutralizedUpsertKeys(
  objects: ReadonlyArray<{
    objectApiName: string;
    fields: ReadonlyArray<{
      name: string;
      type: string;
      externalId?: boolean;
      createable?: boolean;
    }>;
  }>,
): NeutralizedUpsertKey[] {
  return objects.flatMap(({ objectApiName, fields }) =>
    fields.flatMap((field) => {
      if (field.externalId !== true || field.createable === false) return [];
      const kind = contactPointOf(field.name, String(field.type).toLowerCase());
      return kind ? [{ objectApiName, field: field.name, kind }] : [];
    }),
  );
}

/**
 * What a run that upserts by a neutralized contact point is told before it
 * writes: the key it writes is not the address the target's own copy holds,
 * so that copy is not matched, and the run creates a record beside it. A copy
 * an earlier neutralized run wrote is matched: the key is written the same
 * from one run to the next. Exported so it can be tested.
 */
export function upsertKeyLines(keys: readonly NeutralizedUpsertKey[], target: string): string[] {
  if (keys.length === 0) return [];
  return [
    `upsert keys: --upsert matches the records of ${target} by these external ids, which the run ` +
      'writes neutralized (emails under .invalid, phone numbers in a fictional range): a record ' +
      `of ${target} holding the real address or number is not matched, and the run creates ` +
      'another beside it; one an earlier run wrote neutralized is. --keep-contact-points matches ' +
      'the real ones',
    ...keys.map(({ objectApiName, field, kind }) => `  ${objectApiName}.${field} (${kind})`),
  ];
}

/**
 * Of a dry run, the changes to the target's metadata that would let the rows
 * go in as they are, for whoever administers the target (`adminChangesOf`),
 * from what its metadata says and what the simulation found row by row,
 * grouped by object and record type, each with its step in Setup: shown,
 * never made. Nothing on a run that writes, nor when no change would cure a
 * gap. Exported so it can be tested.
 *
 * @param lifted - What the run's mute lifts beside what it silences
 *   (`MutePlan.alsoLifts`): a validation rule it lifts refuses no row, and is
 *   no change to ask for. Its gap line said the mute lifts it, and the list
 *   still asked the admin to turn it off, as Review's did.
 */
export function dryRunAdminChanges(
  dryRun: boolean,
  targetGaps: { gaps: readonly ForgeGap[] },
  simulated: readonly ForgeGap[] | undefined,
  lifted?: readonly MutedAutomationAlsoLifted[],
): { adminChanges?: ForgeAdminChangeGroup[] } {
  if (!dryRun) return {};
  const groups = adminChangesOf(
    mergeGaps(targetGaps.gaps, simulated ?? []).filter((gap) => !gapLiftedBy(gap, lifted)),
  );
  return groups.length > 0 ? { adminChanges: groups } : {};
}

/**
 * The `result` of the `--json` summary, a stable schema for CI.
 *
 * `remapTable` maps every source id the run gave a counterpart in the target.
 * `existingSourceIds` names the entries the target already held and
 * `updatedSourceIds` the ones `--upsert` wrote over, so the table's other
 * entries are exactly the records the run created. Exported so it can be
 * tested.
 *
 * @param readCeiling - The most rows one read of an object took
 *   (`--max-records-per-object`), for `truncatedObjects`.
 */
export function jsonResult(summary: ExecutionSummary, readCeiling?: number) {
  const truncated = truncatedObjectsOf(summary, readCeiling);
  return {
    successCount: summary.successCount,
    // Written over by `--upsert`: the target held them before the run.
    updatedCount: summary.updatedCount,
    // Neither created nor failed: the target already held these records —
    // it named them, or they were matched by name — or the platform wrote
    // them itself with a record the run created, and their children link to
    // them.
    linkedCount: summary.linkedCount,
    // Of them, per object, those the platform wrote with a record the run
    // created: in the target no more than that record was before the run.
    ...(summary.writtenByThePlatform ? { writtenByThePlatform: summary.writtenByThePlatform } : {}),
    // What a dry run would have inserted: it writes nothing.
    wouldInsertCount: summary.wouldInsertCount,
    failedCount: summary.failedCount,
    skippedCount: summary.skippedCount,
    remapCount: summary.remapCount,
    existingRecords: summary.existingRecords,
    errors: summary.errors.map((e) => ({
      objectApiName: e.objectApiName,
      stage: e.stage,
      failedCount: e.failedCount,
      attemptedCount: e.attemptedCount,
      samples: e.samples,
      // What tells the rows of a report apart, as the audit trail tells them:
      // reference data unmatched by name, counted neither written nor failed,
      // and an object skipped whole, whose count may be none for want of a
      // read. Left out, a CI job read either as the rows the run held back.
      ...(e.referenceData === true ? { referenceData: true } : {}),
      ...(e.skipped === true ? { skipped: true } : {}),
    })),
    // remapTable only included in JSON output for CI consumers; the
    // text output stays terse (use --remap-csv for the file dump).
    remapTable: summary.remapTable,
    existingSourceIds: summary.existingSourceIds,
    updatedSourceIds: summary.updatedSourceIds,
    // What removing the run's records takes, as the wizard's removal reads it
    // from the run's history: per object, in the order the run wrote them,
    // the source ids of the records it created; of the records it linked,
    // those the platform wrote with one it created, which go with that one;
    // and the target's dates of the run's writes, which tell a later change.
    // The remap table alone cannot say what the run created: it maps the
    // standard price book and the reference data matched by name too.
    createdByObject: summary.createdByObject,
    ...(summary.withTheirRecordSourceIds
      ? { withTheirRecordSourceIds: summary.withTheirRecordSourceIds }
      : {}),
    ...(summary.writtenBetween ? { writtenBetween: summary.writtenBetween } : {}),
    // Per object, the rows the run read to clone: the size of the clone,
    // where discovery counted each whole table.
    readByObject: summary.readByObject,
    // The objects whose read failed: a failure of the run each, though none
    // counts in failedCount, as the clone never learned how many rows it held.
    failedReads: summary.failedReads,
    // The cap of --max and the objects whose read stopped at it with rows
    // left in the source; only when a read did.
    ...(summary.cappedObjects ? { cappedObjects: summary.cappedObjects } : {}),
    // The ceiling of --max-records-per-object and the objects whose read was
    // cut at it with rows left in the source; only when a read was.
    ...(truncated ? { truncatedObjects: truncated } : {}),
    // Only with --files: what became of the files. The ones copied are in
    // remapTable too, under their document or attachment id.
    ...(summary.files ? { files: summary.files } : {}),
    // Per object, the fields left empty because they hold a file's content;
    // only when there were any.
    ...(summary.fileContentFieldsLeftOut
      ? { fileContentFieldsLeftOut: summary.fileContentFieldsLeftOut }
      : {}),
    // Per object, the encrypted fields left out, read masked; only when there
    // were any.
    ...(summary.encryptedFieldsLeftOut
      ? { encryptedFieldsLeftOut: summary.encryptedFieldsLeftOut }
      : {}),
    // Per object and field, the picklist values replaced or left out, with
    // why; only when there were any.
    ...(summary.picklistValuesChanged
      ? { picklistValuesChanged: summary.picklistValuesChanged }
      : {}),
    // Per object, the rows written in another currency than they were read
    // in, and their amounts converted or not; only when there were any.
    ...(summary.currenciesReplaced ? { currenciesReplaced: summary.currenciesReplaced } : {}),
    // Per object, the records created without a record type, why, the type
    // the target's describe says it gives them, and, of a real run, what the
    // first of them were read back holding; only when there were any.
    ...(summary.recordTypesGiven ? { recordTypesGiven: summary.recordTypesGiven } : {}),
    // Per object, the rows written again without the fields a validation rule
    // or a restricted picklist refused, each field with what refused it
    // (`refusedBy`) and the refusal; only when there were any.
    ...(summary.writtenWithoutFields ? { writtenWithoutFields: summary.writtenWithoutFields } : {}),
    // Per object and field, the records whose lookup a lookup filter refused
    // and the run left empty: --verify tells them from a lookup that broke.
    ...(summary.lookupsLeftEmptyByFilter
      ? { lookupsLeftEmptyByFilter: summary.lookupsLeftEmptyByFilter }
      : {}),
    // Whether the email addresses and phone numbers were neutralized, and how
    // many values of which fields — on a dry run, would have been.
    ...(summary.contactPoints ? { contactPoints: summary.contactPoints } : {}),
    // The requests the run sent to both orgs, discovery's before it aside.
    ...(summary.apiCalls !== undefined ? { apiCalls: summary.apiCalls } : {}),
    // On a dry run, what the target would refuse or change, row by row: never
    // a record's data, a picklist value or a currency code at most.
    ...(summary.gaps ? { gaps: summary.gaps } : {}),
    ...(summary.decisionsApplied ? { decisionsApplied: summary.decisionsApplied } : {}),
    // Per object, the rows of a call whose answer never came back: they may be
    // in the target under ids the run never learned, and --remove cannot
    // reach them.
    ...(summary.mayHaveBeenWritten ? { mayHaveBeenWritten: summary.mayHaveBeenWritten } : {}),
    // Past the bound, the ids are in the run's journal, which the document
    // names: --remove and --verify read them from there.
    ...(summary.remapInJournal ? { remapInJournal: true as const } : {}),
  };
}

/**
 * The line an object's end of run prints, or nothing for a step on the way.
 * The executor says what each object came to — `--dry-run`'s "would be
 * inserted" counts among them, as its reads bring them and as its simulated
 * write ends the object — and the run passed it a callback that
 * dropped every word. A skipped object is printed too, with the reason the
 * executor gives: with the objects written and failed alone, a clone that
 * left objects out named none of them. So is an object a cancel stopped while
 * it was written, whose line says what it wrote and what it never sent.
 * So is what the scan of an object added to the run as it read it — the
 * standard price book entries the custom prices depend on, the prices of a
 * currency the target lacks replaced — which the panel shows as the object's
 * status and the command line printed nowhere: a clone carried records nobody
 * had asked for, unsaid. The scan's opening, at 0, is not: the object's own
 * line follows. Exported so it can be tested.
 */
export function objectOutcomeLine(event: ForgeProgressEvent): string | undefined {
  // What a dry run's read brings is a step the simulated write ends: printed
  // as it was before the write was simulated, the line the read says it on.
  if (event.status === 'running' && event.message.startsWith('[dry-run] ')) {
    return `  ${event.message}`;
  }
  if (event.status === 'scanning') {
    return event.progress > 0 && event.message ? `  ${event.message}` : undefined;
  }
  if (
    event.status !== 'done' &&
    event.status !== 'error' &&
    event.status !== 'skipped' &&
    event.status !== 'stopped'
  ) {
    return undefined;
  }
  return event.message ? `  ${event.message}` : undefined;
}

/**
 * What prints each object's end of run: {@link objectOutcomeLine}, with the
 * objects discovery left out for an empty table said in one line — how many —
 * where the first of them comes. They are most of a graph: a clone of one
 * opportunity between two sandboxes skipped 350 objects, 315 of them for an
 * empty table, one line each, and the 35 skipped for a reason worth reading
 * were lost among them. The other skipped objects keep their line, and one
 * empty table alone keeps its name. Exported so it can be tested.
 *
 * @param graph - The graph the run executes, which says why a node is left out.
 */
export function objectOutcomePrinter(
  graph: ForgeGraph,
): (event: ForgeProgressEvent) => string | undefined {
  // The empty tables only: a node left out because its describe or its count
  // failed keeps its own line, which says the error.
  const emptyTables = new Set(
    graph.nodes.filter(leftOutAsEmptyTable).map((node) => node.objectApiName),
  );
  let folded = false;
  return (event) => {
    if (event.status === 'skipped' && emptyTables.size > 1 && emptyTables.has(event.objectName)) {
      if (folded) return undefined;
      folded = true;
      // Relayed by a command that lists no objects, the flag is not named.
      const names = relayTakes('--list-objects') ? '; --list-objects names them' : '';
      return `  Skipped ${emptyTables.size} objects (excluded: empty tables${names})`;
    }
    return objectOutcomeLine(event);
  };
}

/**
 * The line that says how far discovery reached: the objects it described —
 * those the run reads and those it leaves out, empty tables among them —
 * against its cap, the lookups it met and how many of them join two of those
 * objects, and the plan's waves and cycles.
 *
 * The objects can outnumber the cap: each parent a record reached cannot be
 * written without raises it by one, to twice the cap. Printed as "100 nodes"
 * from a run at the default cap of fifty, the count read as the cap not
 * holding, and most of the 4 530 edges beside it were lookups at objects
 * discovery never reached. Exported so it can be tested.
 *
 * @param maxNodes - The cap discovery was given.
 */
export function graphLine(
  graph: ForgeGraph,
  plan: Pick<ForgePlan, 'waves' | 'cycleResolutions'>,
  maxNodes: number,
): string {
  const objects = new Set(graph.nodes.map((n) => n.objectApiName));
  const included = graph.nodes.filter((n) => n.included).length;
  const between = graph.edges.filter(
    (e) => objects.has(e.sourceObject) && objects.has(e.targetObject),
  ).length;
  // An empty table takes no place under the cap: the objects can outnumber
  // it without its being raised.
  const empty = graph.nodes.length - graph.nodes.filter(holdsAPlace).length;
  const emptyNote = empty > 0 ? ` (${empty} empty, taking no place under it)` : '';
  const raised =
    graph.nodes.length - empty > maxNodes
      ? ' (raised for the parents their records cannot be written without)'
      : '';
  // Said, the objects add up: 78 objects, 69 empty and 6 included left three
  // unaccounted for, the tables the source would not count.
  const { notCounted } = graphCounts(graph);
  const notCountedNote = notCounted > 0 ? `, ${notCounted} not counted` : '';
  return (
    `graph: ${graph.nodes.length} objects at a cap of ${maxNodes}${emptyNote}${raised}, ` +
    `${included} included${notCountedNote}; ` +
    `${graph.edges.length} lookups, ${between} between these objects; ` +
    `${plan.waves.length} waves, ${plan.cycleResolutions.length} cycles` +
    (graph.truncated ? ' (TRUNCATED)' : '')
  );
}

/**
 * The objects of a graph, each counted once: those the run reads, the empty
 * tables discovery left out (`leftOutAsEmptyTable`), those whose describe or
 * count failed, and those left out by name. They add up to the graph's
 * objects. Exported so it can be tested.
 *
 * Whether a table is empty is the source's, read whole as discovery counts
 * it, and changes with the source: a dry run counted 68 empty tables and 7
 * included, and the real runs after it 69 and 6 — another check had put three
 * opportunities in the source, none under the record cloned, and taken them
 * out again in between. The record cloned reached the same 39 rows each time.
 * Said with the graph, a dry run and a real run of the same clone can be
 * told apart from a source that changed under them.
 */
export function graphCounts(graph: Pick<ForgeGraph, 'nodes'>): {
  included: number;
  emptyTables: number;
  notCounted: number;
  leftOut: number;
} {
  let included = 0;
  let emptyTables = 0;
  let notCounted = 0;
  let leftOut = 0;
  for (const node of graph.nodes) {
    if (node.included) included++;
    else if (leftOutAsEmptyTable(node)) emptyTables++;
    else if (node.status === 'error' || node.errors.length > 0) notCounted++;
    else leftOut++;
  }
  return { included, emptyTables, notCounted, leftOut };
}

/**
 * The `graph` of the `--json` summary, and of `--list-objects --json`, the
 * same on a dry run and a real one: the objects discovery described — how
 * many it reads, how many it left out for an empty table or a count that
 * failed, and how many were left out by name — the lookups it met, the plan's
 * waves and cycles, and whether discovery stopped at its cap before it had
 * walked everything.
 */
function graphJson(graph: ForgeGraph, plan: Pick<ForgePlan, 'waves' | 'cycleResolutions'>) {
  return {
    nodes: graph.nodes.length,
    ...graphCounts(graph),
    edges: graph.edges.length,
    waves: plan.waves.length,
    cycles: plan.cycleResolutions.length,
    truncated: graph.truncated ?? false,
  };
}

/** One object of the graph as `--list-objects` names it. */
export interface ListedObject {
  objectApiName: string;
  /** The rows discovery counted in the whole table. */
  recordCount: number;
  /** How many relationships away from the record to clone discovery reached it. */
  depth: number;
  /** Whether the clone reads it: an empty table, or one `--exclude-object` names, is left out. */
  included: boolean;
}

/**
 * The objects of the graph, by name, as `--list-objects` prints them — in
 * lines, or in JSON with `--json`. Exported so it can be tested.
 */
export function listedObjects(graph: ForgeGraph): ListedObject[] {
  return [...graph.nodes]
    .sort((a, b) => a.objectApiName.localeCompare(b.objectApiName))
    .map((node) => ({
      objectApiName: node.objectApiName,
      recordCount: node.recordCount,
      depth: node.level,
      included: node.included,
    }));
}

/**
 * What the executor is asked to do, from the command line and the graph
 * discovery built. Exported so it can be tested.
 *
 * @param personalFieldsOf - The personal fields of an object, as discovery
 *   names them: what `--anonymize` covers on an orphan parent from outside
 *   the graph.
 */
export function executeOptions(
  args: CliArgs,
  graph: ForgeGraph,
  recordTypeMappings: RecordTypeMapping[],
  personalFieldsOf?: (fields: PIIFieldInfo[]) => string[],
): ExecuteOptions {
  return {
    rootRecordId: args.record,
    rootObjectApiName: graph.nodes[0]?.objectApiName ?? '',
    dryRun: args.dryRun,
    recordTypeMappings,
    maxRecordsPerObject: args.maxRecordsPerObject,
    // Force 'nullify' for cross-org CLI clones. The default
    // ('keep' for non-scoped) preserves source IDs which would be
    // invalid on the target unless source and target share state, which
    // is never the case for a real cross-org clone via this CLI.
    referenceFallback: 'nullify',
    upsertMode: args.upsert ? 'auto' : undefined,
    expandOrphanParents: args.expandOrphans,
    fieldExclusions:
      Object.keys(args.fieldExclusions).length > 0 ? args.fieldExclusions : undefined,
    // By name, to the run: an object discovery never reached is one the run
    // can add past the cap, and has no node to leave out.
    excludedObjects: args.excludedObjects.length > 0 ? args.excludedObjects : undefined,
    ownerMappings: Object.keys(args.ownerMappings).length > 0 ? args.ownerMappings : undefined,
    objectSoqlFilters:
      Object.keys(args.objectSoqlFilters).length > 0 ? args.objectSoqlFilters : undefined,
    fieldMappings: Object.keys(args.fieldMappings).length > 0 ? args.fieldMappings : undefined,
    // `--anonymize` had discovery select each object's PII fields, and every
    // record was then written as the source held it. The selected fields go,
    // each with its category's default method.
    anonymization: runAnonymization(
      args.anonymize,
      graph,
      args.anonymizationRules,
      personalFieldsOf,
    ),
    // Off, every email address and phone number the run writes is neutralized.
    keepContactPoints: args.keepContactPoints,
    // From --config or --template: applied to the rows, in a dry run too.
    decisions: args.decisions,
    files: args.files
      ? {
          maxFileBytes: args.files.maxFileSizeMB * BYTES_PER_MB,
          acceptedAsIs: args.files.acceptedAsIs,
        }
      : undefined,
    // The most rows of one object a read takes, and the diagnostic's pages.
    stream: {
      ceiling: args.readCeiling,
      ...(args.pageSize !== undefined ? { pageSize: args.pageSize } : {}),
    },
  };
}

/**
 * The options of a run that keeps its journal: what it wrote, read and owes
 * goes there as it goes, and past the bound the summary keeps the ids there.
 * Unchanged without one. Exported so it can be tested.
 */
export function withTheJournal(
  options: ExecuteOptions,
  store: ForgeRunStore | undefined,
): ExecuteOptions {
  if (!store) return options;
  return { ...options, stream: { ...options.stream, store, summaryBound: SUMMARY_IDS_BOUND } };
}

/**
 * The graph with the personal fields a template anonymizes on each object it
 * names, among those discovery found personal there: never a field the
 * source does not show as one. An object the template does not name keeps
 * discovery's choice. Exported so it can be tested.
 */
export function withTemplateFields(
  graph: ForgeGraph,
  fields: CliArgs['anonymizeFields'],
): ForgeGraph {
  if (!fields) return graph;
  const chosen = new Map(fields.map((entry) => [entry.objectApiName, entry.fieldNames]));
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const names = chosen.get(node.objectApiName);
      if (!names) return node;
      const personal = new Set(node.piiFields);
      return { ...node, anonymizeFields: names.filter((name) => personal.has(name)) };
    }),
  };
}

/**
 * What reads the target's automation through its connection, as Review reads
 * it in the extension: the flows over the regular API, the triggers and the
 * start conditions over the Tooling API. Exported so it can be tested.
 */
export function targetAutomationReader(conn: Connection): TargetAutomationReader {
  return new TargetAutomationReader({
    query: async (_orgId, soql) =>
      answerOf(
        {
          query: async (q) => conn.query<Record<string, unknown>>(q),
          queryMore: async (url) => conn.queryMore<Record<string, unknown>>(url),
        },
        soql,
      ),
    toolingQuery: async (_orgId, soql) =>
      answerOf(
        {
          query: async (q) => conn.tooling.query<Record<string, unknown>>(q),
          queryMore: async (url) => conn.tooling.queryMore<Record<string, unknown>>(url),
        },
        soql,
      ),
    // The start conditions and definitions, many a request, as the panel reads them.
    toolingQueries: async (_orgId, soqls) =>
      toolingAnswersOf(
        await conn.request({
          method: 'POST',
          url: '/tooling/composite',
          body: JSON.stringify(toolingCompositeBody(`/services/data/v${conn.version}`, soqls)),
          headers: { 'Content-Type': 'application/json' },
        }),
        soqls.length,
      ),
    // The flow versions and rules themselves, retrieved many more a request.
    toolingRetrieves: (_orgId, reads) => toolingRetrievesOver(conn)(reads),
  });
}

/**
 * What reads the target's gaps through the two connections, as Review reads
 * them in the extension: the rules over both APIs, the fields from the
 * describes the run keeps, the budget from `/limits`, the duplicate rules'
 * actions from the Metadata API. Exported so it can be tested.
 *
 * @param describe - The command's describes, which the run shares.
 * @param described - The describes already sent, by `<org>::<object>`: one
 *   asked again costs the read nothing.
 */
export function targetGapReader(
  conns: ReadonlyMap<string, Connection>,
  describe: (orgId: string, objectName: string) => Promise<DescribeSObjectResult>,
  described: ReadonlySet<string>,
): TargetGapReader {
  const conn = (orgId: string): Connection => {
    const c = conns.get(orgId);
    if (!c) throw new Error(`No connection for ${orgId}`);
    return c;
  };
  return new TargetGapReader({
    query: async (orgId, soql) =>
      answerOf(
        {
          query: async (q) => conn(orgId).query<Record<string, unknown>>(q),
          queryMore: async (url) => conn(orgId).queryMore<Record<string, unknown>>(url),
        },
        soql,
      ),
    toolingQuery: async (orgId, soql) =>
      answerOf(
        {
          query: async (q) => conn(orgId).tooling.query<Record<string, unknown>>(q),
          queryMore: async (url) => conn(orgId).tooling.queryMore<Record<string, unknown>>(url),
        },
        soql,
      ),
    describeFields: async (orgId, objectName) => {
      const sent = !described.has(`${orgId}::${objectName}`);
      const meta = await describe(orgId, objectName);
      return { sent, createable: meta.createable !== false, fields: meta.fields.map(gapFieldOf) };
    },
    readDuplicateRules: async (orgId, fullNames) => {
      const answer: unknown = await conn(orgId).metadata.read('DuplicateRule', fullNames);
      return Array.isArray(answer) ? answer : [answer];
    },
    readLimits: async (orgId) => conn(orgId).request({ method: 'GET', url: '/limits' }),
    // The validation rules' formulas, retrieved 25 a request, by query five
    // a request where the org will not retrieve, as the panel reads them.
    toolingQueries: async (orgId, soqls) => toolingQueriesOver(conn(orgId))(soqls),
    toolingRetrieves: (orgId, reads) => toolingRetrievesOver(conn(orgId))(reads),
  });
}

/** An org as the command types it before it writes to it or deletes from it. */
export interface TypedOrg {
  /** The org's own id, `Organization.Id`. */
  id: string;
  /** Whether the org says it is a sandbox. */
  sandbox: boolean;
  /**
   * The edition an org that is not a sandbox says it is,
   * `Organization.OrganizationType`; absent when it said none.
   */
  edition?: string;
}

/**
 * The org a connection reaches, typed from its `Organization` record as the
 * panel types an org it connects (`OrgHandler`) and the Frozen command types
 * its own: never from the alias or the instance URL, as a sandbox's My Domain
 * says "sandbox" only until someone renames it. An answer that does not say
 * `IsSandbox: true` is a production org's, as an org of unknown type is to
 * Production Guard. Exported so it can be tested.
 */
export async function typeOrg(conn: Connection): Promise<TypedOrg> {
  const answer = await conn.query<{ Id?: string; IsSandbox?: boolean }>(
    'SELECT Id, IsSandbox FROM Organization LIMIT 1',
  );
  const row = answer.records[0];
  if (typeof row?.Id !== 'string') {
    throw new Error('The org gave no Organization record: whether it is a sandbox cannot be told.');
  }
  if (row.IsSandbox === true) return { id: row.Id, sandbox: true };
  // A Developer Edition org says IsSandbox false and holds nobody's business:
  // its edition tells it from a production org. Asked of an org that is not a
  // sandbox alone; an answer that does not say leaves it a production org.
  try {
    const typed = await conn.query<{ OrganizationType?: string }>(
      'SELECT OrganizationType FROM Organization LIMIT 1',
    );
    const edition = typed.records[0]?.OrganizationType;
    return typeof edition === 'string' && edition !== ''
      ? { id: row.Id, sandbox: false, edition }
      : { id: row.Id, sandbox: false };
  } catch {
    return { id: row.Id, sandbox: false };
  }
}

/**
 * Why the command will not write to an org, or delete from it: the org is not
 * a sandbox. Nothing when it is one.
 *
 * The help always called the target a sandbox, and nothing checked it: a
 * clone, or a removal, went to whatever org the alias named. Production Guard
 * refuses a delete on a production org and asks before any write there; the
 * command has no one to ask, and the Frozen command refuses such an org for
 * both, its load at its entry guards and its removal at Production Guard. So
 * this one refuses it too — but a Developer Edition org, which says IsSandbox
 * false: refused, it left those who try SandForge with a Trailhead playground
 * and no sandbox nowhere to clone into, as the panel does not, and the Frozen
 * command no longer does either. Exported so it can be tested.
 *
 * @param action - What was about to happen: a clone writes, a removal deletes.
 */
export function productionRefusal(
  alias: string,
  org: TypedOrg,
  action: 'clone' | 'remove',
): string | undefined {
  if (org.sandbox || isDeveloperEdition(org.edition)) return undefined;
  const what =
    action === 'clone'
      ? 'sandforge-clone writes to sandboxes and Developer Edition orgs only. Nothing was written; --dry-run, which only reads, runs against it.'
      : 'sandforge-clone removes records from sandboxes and Developer Edition orgs only. Nothing was deleted.';
  const said = org.edition
    ? `IsSandbox false, edition ${org.edition}`
    : 'IsSandbox false, and no edition';
  return `${alias} is a production org (its Organization record says ${said}): ${what}`;
}

/** Why a row got no verdict, as a rehearsal's lines say it. */
const NOT_JUDGED_WORDS: Readonly<Record<ForgeRehearsal['notJudgedWhy'][number]['reason'], string>> =
  {
    parent_refused: 'a record it names was refused',
    beyond_a_call: 'the records it needs are more, or deeper, than one call holds',
    call_budget: 'the calls ran out before its turn',
  };

/**
 * What a rehearsal says before its first call: the records it creates, of
 * those the run would, the updates it makes of them, and the calls it costs.
 * Exported so it can be tested.
 */
export function rehearsalPlanLines(plan: RehearsalPlan, target: string): string[] {
  const updates = plan.updates.reduce((sum, object) => sum + object.updates, 0);
  return [
    `rehearsal: ${plan.sampled} of the ${plan.rows} record(s) the run would create, created in ` +
      `${target} and rolled back with each call`,
    ...(updates > 0
      ? [
          `  and ${updates} update(s) the run makes after its inserts, each in the call that ` +
            `creates its record: ${plan.updates.map((o) => `${o.objectApiName} ${o.updates}`).join(', ')}`,
        ]
      : []),
    `  ${plan.calls} composite call(s), ${plan.maxCalls} at most if a call stops at a refused record`,
    ...plan.objects.map(({ objectApiName, rows }) => `  ${objectApiName.padEnd(40)} ${rows}`),
  ];
}

/**
 * The verdicts of a rehearsal: what was judged, what passed, each refusal with
 * its status code, field and rows — an update's apart — and what could not be
 * judged. Exported so it can be tested.
 */
export function rehearsalLines(
  rehearsal: ForgeRehearsal,
  target: string,
  options: { lifted?: readonly MutedAutomationAlsoLifted[] } = {},
): string[] {
  const updates =
    rehearsal.updatesJudged > 0
      ? `; ${rehearsal.updatesJudged} update(s) judged, ${rehearsal.updatesPassed} would save, ` +
        `${rehearsal.updatesJudged - rehearsal.updatesPassed} refused`
      : '';
  // A row the target refused for a record it holds is linked by the run, as
  // its writer links it: neither saved nor refused.
  const linked = rehearsal.linked ?? 0;
  const linkedWords = linked > 0 ? `${linked} linked to a record the target holds, ` : '';
  const lines = [
    `rehearsed in ${target}: ${rehearsal.judged} judged, ${rehearsal.passed} would save, ` +
      `${linkedWords}${rehearsal.judged - rehearsal.passed - linked} refused, ` +
      `${rehearsal.notJudged} not judged${updates} ` +
      `(${rehearsal.calls} call(s), every write rolled back)`,
  ];
  for (const gap of rehearsal.gaps) {
    const code = typeof gap.detail?.statusCode === 'string' ? gap.detail.statusCode : gap.value;
    const field = gap.field ? `.${gap.field}` : '';
    const value = gap.kind === 'picklist_value_refused' && gap.value ? ` "${gap.value}"` : '';
    const recordType = gap.recordType ? ` (record type ${gap.recordType})` : '';
    const runRows = gap.detail?.rowsOfTheRun;
    const standsFor =
      typeof runRows === 'number' && runRows > gap.rows ? `, ${runRows} in the run` : '';
    if (gap.kind === 'rehearsal_update_refusal') {
      lines.push(
        `  refused on update  ${gap.objectApiName}${field}: ${code}, ${gap.rows} update(s)${standsFor} ` +
          '(the record goes in without what the update gives it)',
      );
      continue;
    }
    // A rule the run's mute lifts refused a row the run writes whole: a
    // rehearsal takes no mute. Said as the row going again without its
    // field, the line told of a loss the run under the mute never has.
    const lifted = gapLiftedBy(gap, options.lifted);
    if (lifted) {
      lines.push(
        `  refused  ${gap.objectApiName}${field}: ${code}, ${gap.rows} row(s)${standsFor}, ` +
          `validation rule "${String(gap.detail?.rule)}": the mute lifts it (${lifted.permission}, ` +
          `in ${lifted.permissionSet}), which the rehearsal ran without; a real run under it ` +
          'writes the row whole',
      );
      continue;
    }
    lines.push(
      `  ${gap.severity === 'blocking' ? 'REFUSED' : 'refused'}  ${gap.objectApiName}${field}${value}${recordType}: ` +
        `${code}, ${gap.rows} row(s)${standsFor}` +
        (gap.detail?.writtenWithoutTheField === true
          ? ' (a real run writes it again without the field)'
          : '') +
        (gap.detail?.linkedToTheRecordItNames === true
          ? ' (a real run links it to the record the target holds)'
          : ''),
    );
  }
  for (const { objectApiName, rows, reason } of rehearsal.notJudgedWhy) {
    lines.push(`  not judged  ${objectApiName}: ${rows} row(s), ${NOT_JUDGED_WORDS[reason]}`);
  }
  if (rehearsal.updatesNotRehearsed > 0) {
    lines.push(
      `  not rehearsed: ${rehearsal.updatesNotRehearsed} of the ${rehearsal.updates} update(s) ` +
        'the run makes after its inserts',
    );
  }
  return lines;
}

/**
 * The rehearsal as `--rehearse --json` gives it: each refusal by a validation
 * rule the run's mute lifts says so, as its line says it (`rehearsalLines`):
 * the bypass that lifts it under `detail.liftedByPermission`, and the set the
 * mute assigns that grants it under `detail.liftedByPermissionSet`. The JSON
 * named the rule and not that the mute lifts it: read alone, the refusal was
 * of a row the run under the mute writes whole.
 */
function rehearsalJson(
  rehearsal: ForgeRehearsal,
  lifted: readonly MutedAutomationAlsoLifted[] | undefined,
): ForgeRehearsal {
  return {
    ...rehearsal,
    gaps: rehearsal.gaps.map((gap) => {
      const by = gapLiftedBy(gap, lifted);
      return by
        ? {
            ...gap,
            detail: {
              ...gap.detail,
              liftedByPermission: by.permission,
              liftedByPermissionSet: by.permissionSet,
            },
          }
        : gap;
    }),
  };
}

/** What `--remove` was given. */
export interface RemoveArgs {
  /** The summary a run printed with `--json`, saved to a file. */
  summaryPath: string;
  /** sf CLI alias of the org the run wrote to. */
  target: string;
  /** Remove also the records changed since the run, and what was added to them since. */
  includeChanged: boolean;
  /** Print the outcome as JSON on stdout, and every other line on stderr. */
  json: boolean;
  /** Delete although the target runs automation as the records go, or could not say what it runs. */
  acceptAutomation: boolean;
  /** Mute the target's automation for the removal, through its own bypass (`--mute-automation`). */
  muteAutomation: boolean;
  /**
   * Remove the rest when the user may not delete the records of some objects
   * of the run, leaving those; without it the removal stops before its first
   * delete and names them.
   */
  leaveUndeletable: boolean;
  /** Before the run's records go, sweep what the target's automation created during the run. */
  sweep: boolean;
  /** List what a sweep would delete, and delete nothing. */
  sweepList: boolean;
  /** With the sweep, take too what it lists as made late (`--sweep-late`). Absent unless given. */
  sweepLate?: true;
  /**
   * With the sweep, take too what it lists as tied to nothing of the run
   * (`--sweep-untied`), unless that is refused. Absent unless given.
   */
  sweepUntied?: true;
  /** The file the removal's entry in the audit trail goes to; undefined = no entry. */
  audit: string | undefined;
  /** Say what the removal would do, and do nothing. Absent unless given. */
  preview?: true;
}

/** The flags a removal reads. */
const REMOVE_FLAGS: ReadonlySet<string> = new Set([
  '--remove',
  '--target',
  '--preview',
  '--include-changed',
  '--json',
  '--accept-automation',
  '--leave-undeletable',
  '--sweep',
  '--sweep-list',
  // Named here, not through SWEEP_CLASS_FLAGS, which is set further down.
  '--sweep-late',
  '--sweep-untied',
  '--audit',
  '--mute-automation',
]);

/** The flags of a removal that take a value. */
const REMOVE_VALUE_FLAGS: ReadonlySet<string> = new Set(['--remove', '--target', '--audit']);

/**
 * The command line of a removal read and checked; exits on `--help` or a bad
 * flag. A flag of the clone is refused rather than ignored: `--dry-run` read
 * as a preview would delete for real. Exported so it can be tested.
 */
export function parseRemoveArgs(argv: string[]): RemoveArgs {
  const args = argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    const value = i >= 0 ? args[i + 1] : undefined;
    return value !== undefined && !value.startsWith('--') ? value : undefined;
  };
  const has = (flag: string): boolean => args.includes(flag);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (REMOVE_VALUE_FLAGS.has(arg)) {
      // Its value, unless the flag was given none and the next is a flag.
      if (args[i + 1] !== undefined && !args[i + 1].startsWith('--')) i++;
      continue;
    }
    if (arg === '--dry-run') {
      // A removal that ignored it would delete for real: the word for a
      // removal that writes nothing is --preview.
      process.stderr.write(
        '--remove does not take --dry-run: a removal that did not read it would delete for ' +
          'real. --preview says what the removal would do, and writes nothing. Run with --help ' +
          'for usage.\n',
      );
      process.exit(2);
    }
    if (!REMOVE_FLAGS.has(arg)) {
      process.stderr.write(
        `--remove takes --target, --preview, --include-changed, --accept-automation, --mute-automation, --leave-undeletable, --sweep, --sweep-late, --sweep-untied, --sweep-list, --json and --audit, not "${arg}". ` +
          'Run with --help for usage.\n',
      );
      process.exit(2);
    }
  }
  const summaryPath = get('--remove');
  const target = get('--target');
  if (!summaryPath || !target) {
    process.stderr.write(
      '--remove takes the file a run printed its --json summary to, and --target the org ' +
        'the run wrote to. Run with --help for usage.\n',
    );
    process.exit(2);
  }
  if (has('--sweep') && has('--sweep-list')) {
    process.stderr.write(
      '--sweep deletes and --sweep-list only lists: give one of them. Run with --help for usage.\n',
    );
    process.exit(2);
  }
  // A preview writes nothing, so it has nothing to record; with --sweep, it
  // reads what the sweep would take, as the removal reads it before asking.
  const withPreview = [
    '--sweep-list',
    ...(has('--sweep') ? [] : SWEEP_CLASS_FLAGS),
    '--audit',
  ].filter((flag) => has(flag));
  if (has('--preview') && withPreview.length > 0) {
    process.stderr.write(
      `--preview writes nothing: give it without ${withPreview.join(', ')}. Run with --help for usage.\n`,
    );
    process.exit(2);
  }
  const classes = sweepClassArgsOf(args);
  if ('refusal' in classes) {
    process.stderr.write(`${classes.refusal} Run with --help for usage.\n`);
    process.exit(2);
  }
  return {
    summaryPath,
    target,
    includeChanged: has('--include-changed'),
    json: has('--json'),
    acceptAutomation: has('--accept-automation'),
    muteAutomation: has('--mute-automation'),
    leaveUndeletable: has('--leave-undeletable'),
    sweep: has('--sweep'),
    sweepList: has('--sweep-list'),
    ...classes,
    audit: auditArg(args),
    ...(has('--preview') ? { preview: true as const } : {}),
  };
}

/** A Salesforce id, as every id of a summary is. */
const summaryIdSchema = z.string().regex(SF_ID_RE, 'not a Salesforce id');

/** A date as the command writes one, `toISOString()`. */
const summaryDateSchema = z.iso.datetime();

/** An automation a run's mute named, as its summary keeps it: words only, said back. */
const mutedEntrySchema = z.object({
  objectApiName: z.string().regex(API_NAME_RE, 'not an API name'),
  kind: z.enum(['flow', 'trigger', 'process', 'workflowRule']),
  name: z.string().max(255),
});

/**
 * What a run's mute kept quiet and what still ran, as its summary keeps it
 * (`MutedAutomation`): a sweep says it with what it found, since what still
 * ran may have made it. The rest of the mute is not read. Exported for the
 * removals of Sync and Seed, whose summaries keep it in their result.
 */
export const runMuteSchema = z.object({
  silenced: z.array(mutedEntrySchema.extend({ permission: z.string().max(255) })),
  stillRan: z.array(
    mutedEntrySchema.extend({
      why: z.enum(['noBypass', 'managedPackage', 'notRead', 'noPermissionSet']),
    }),
  ),
});

/**
 * The first of `values` that is a Salesforce id: the user a run wrote as,
 * wherever its summary or its file keeps it. It goes into a sweep's queries:
 * anything else is left out, and the removal reads the user from the run's
 * records. Exported so it can be tested.
 */
export function runUserIdOf(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && SF_ID_RE.test(value)) return value;
  }
  return undefined;
}

/**
 * What a removal reads of a `--json` summary. The file is external input,
 * anyone may have edited it, and its ids end up in the removal's queries and
 * deletes: each is checked for an id, and each object for an API name, before
 * any org is contacted.
 */
const runSummarySchema = z.object({
  tool: z.literal('sandforge-clone'),
  version: z.literal(1),
  source: z.string(),
  target: z.string().min(1),
  targetOrgId: summaryIdSchema.optional(),
  // The record a clone of one record started from, or the tables a clone of
  // whole tables read: what its lines call the run.
  record: z.string().optional(),
  objects: z
    .array(
      z.object({
        objectApiName: z.string().regex(API_NAME_RE, 'not an API name'),
        where: z.string().max(512).optional(),
      }),
    )
    // As many as a graph holds nodes: a clone of the whole org the panel
    // ran, read back from its journal, names every object it copied.
    .max(2_000)
    .optional(),
  dryRun: z.literal(false),
  // Below none in a summary a clone wrote across a clock the machine set
  // back (`elapsedSince`): read as a run that took none, never refused.
  elapsedMs: z.number().transform((ms) => Math.max(0, ms)),
  finishedAt: summaryDateSchema.optional(),
  // The journal of the run, and which part of it this summary is of: where a
  // summary past the bound keeps the ids.
  journal: z.string().min(1).max(4096).optional(),
  part: z.number().int().nonnegative().optional(),
  result: z.object({
    remapInJournal: z.literal(true).optional(),
    remapTable: z.record(summaryIdSchema, summaryIdSchema),
    existingSourceIds: z.array(summaryIdSchema),
    updatedSourceIds: z.array(summaryIdSchema),
    createdByObject: z.array(
      z.object({
        objectApiName: z.string().regex(API_NAME_RE, 'not an API name'),
        sourceIds: z.array(summaryIdSchema),
      }),
    ),
    withTheirRecordSourceIds: z.array(summaryIdSchema).optional(),
    writtenBetween: z.object({ first: summaryDateSchema, last: summaryDateSchema }).optional(),
    mayHaveBeenWritten: z
      .array(
        z.object({
          objectApiName: z.string().regex(API_NAME_RE, 'not an API name'),
          sourceIds: z.array(summaryIdSchema),
        }),
      )
      .optional(),
    // The user the run wrote as: what the target's automation made for it
    // was created as that user. Absent from a run that did not keep it, whose
    // removal reads it from the run's own records.
    runUserId: summaryIdSchema.optional(),
  }),
  // What the run's mute kept quiet, and what still ran: the sweep says it
  // with what it found, as what still ran may have made it.
  mutedAutomation: runMuteSchema
    .optional()
    // A mute that does not read is left unsaid; the run's records still go.
    .catch(undefined),
});

/** A summary a removal can take its run back from. */
export type RunSummary = z.infer<typeof runSummarySchema>;

/**
 * The summary `--remove` and `--verify` take a run back from, read from the
 * file they are given: a summary as `parseRunSummary` reads it, its ids read
 * from the part of the journal it names whenever that journal is there; or
 * the journal of a run itself, every part of it, as one run. Exported so it
 * can be tested.
 *
 * The journal is written call by call, and the summary of a run of whole
 * tables object by object: killed part way, one said 60 records written
 * while its journal held 5 400, and a removal from the summary would have
 * left 5 340 behind. Read from the journal, the summary's ids are what the
 * run wrote, and what a reconciliation found since of the calls it had under
 * way; the summary's own stand when the journal is gone.
 *
 * @param target - The org the command was told to reach: what a journal,
 *   which names its org by id, is reached by.
 */
export async function runSummaryOfFile(
  filePath: string,
  text: string,
  target: string,
  journals: ForgeRunJournal = nodeRunJournal(journalDirOf()),
): Promise<{ summary: RunSummary } | { refusal: string }> {
  const newline = text.indexOf('\n');
  const first = newline >= 0 ? text.slice(0, newline) : text;
  if (/^\{"run":/.test(first)) return runSummaryOfJournal(filePath, target, journals);
  const read = parseRunSummary(text);
  if ('refusal' in read) return read;
  const { journal, part } = read.summary;
  const kept =
    journal !== undefined && part !== undefined ? await journals.readAt(journal, part) : undefined;
  if (!kept) {
    if (!read.summary.result.remapInJournal) return read;
    if (journal === undefined || part === undefined) {
      return { refusal: 'keeps the ids of its records in a journal it does not name.' };
    }
    return { refusal: `keeps the ids of its records in ${journal}, which cannot be read.` };
  }
  return {
    summary: {
      ...read.summary,
      result: {
        ...read.summary.result,
        remapTable: kept.remap.table,
        existingSourceIds: kept.remap.linked,
        updatedSourceIds: [],
        createdByObject: kept.remap.createdByObject,
      },
    },
  };
}

/** The summary of every part of the run the journal at `filePath` keeps: see `runSummaryOfFile`. */
async function runSummaryOfJournal(
  filePath: string,
  target: string,
  journals: ForgeRunJournal,
): Promise<{ summary: RunSummary } | { refusal: string }> {
  const read = await journals.readAt(filePath, 'all');
  if (!read) return { refusal: 'is not the journal of a run.' };
  const end = await journals.lastEndAt(filePath);
  // A run a killed process left has no end: its journal's last write is when it stopped.
  const recordedAt = end?.at ?? statSync(filePath).mtime.toISOString();
  const elapsed = Date.parse(recordedAt) - Date.parse(read.startedAt);
  const startedWith = read.resume?.startedWith;
  const record = read.resume?.recordId ?? startedWith?.config.recordId;
  // A clone of whole tables names the tables its graph took, each under its
  // filter; so does any run that started from no record — a clone of the
  // whole org the panel ran, its objects — rather than calling it a record
  // of none.
  const objects =
    !record && startedWith && startedWith.config.inputMode !== 'record'
      ? startedWith.graph.nodes
          .filter((node) => node.included)
          .map(({ objectApiName }) => {
            const where = startedWith.config.objectSoqlFilters?.[objectApiName];
            return where !== undefined ? { objectApiName, where } : { objectApiName };
          })
      : undefined;
  const parsed = runSummarySchema.safeParse({
    tool: 'sandforge-clone',
    version: 1,
    source: read.resume?.sourceOrgId ?? '',
    target,
    targetOrgId: read.targetOrgId,
    record: record ?? (objects ? undefined : ''),
    ...(objects ? { objects } : {}),
    dryRun: false,
    elapsedMs: Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0,
    finishedAt: recordedAt,
    journal: filePath,
    result: {
      remapTable: read.remap.table,
      existingSourceIds: read.remap.linked,
      updatedSourceIds: [],
      createdByObject: read.remap.createdByObject,
    },
  });
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.map(String).join('.') || 'the journal'}: ${issue.message}`);
    return {
      refusal: `is a journal the command cannot take a run back from: ${issues.join('; ')}.`,
    };
  }
  return { summary: parsed.data };
}

/**
 * The summary a `--json` run printed, read for a removal, or why it cannot be
 * one, said after the file's name: not JSON, not this command's, a dry run's,
 * which wrote nothing to take back, one printed before the summary said which
 * records the run created, or one whose ids or names are not what they should
 * be. Exported so it can be tested.
 */
export function parseRunSummary(text: string): { summary: RunSummary } | { refusal: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err: unknown) {
    return { refusal: `is not JSON (${err instanceof Error ? err.message : String(err)}).` };
  }
  const header = z.object({ tool: z.literal('sandforge-clone'), dryRun: z.boolean() });
  const run = header.safeParse(raw);
  if (!run.success) return { refusal: 'is not a summary sandforge-clone printed with --json.' };
  if (run.data.dryRun) {
    return {
      refusal:
        'is the summary of a dry run, which wrote nothing to the target: there is nothing of it to remove.',
    };
  }
  const refused = refusalOfSummary(raw, 'sandforge-clone');
  if (refused) return { refusal: refusedSummaryWords(refused) };
  const recorded = z.object({ result: z.object({ createdByObject: z.array(z.unknown()) }) });
  if (!recorded.safeParse(raw).success) {
    return {
      refusal:
        'does not say which records the run created (createdByObject): it was printed before ' +
        'the summary said so, and the records the run created cannot be told from those the ' +
        'target already held. sandforge-cleanup remains for such a run.',
    };
  }
  const parsed = runSummarySchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.map(String).join('.') || 'the summary'}: ${issue.message}`);
    return { refusal: `is not a summary a removal can read: ${issues.join('; ')}.` };
  }
  return { summary: parsed.data };
}

/**
 * What removing a run's records takes from its target, read from its summary
 * as the wizard reads a run's history entry (`forgeRunCreatedRecords`): per
 * object, the records the run created, children before their parents, the
 * last written first. A record the target held before the run — linked to,
 * matched by name, or written over by `--upsert` — is never the run's to
 * remove, whichever row maps to it. Exported so it can be tested.
 */
export function removalPlan(summary: RunSummary): ForgeRunObjectRecords[] {
  const { result } = summary;
  return forgeRunCreatedRecords({
    idRemapTable: result.remapTable,
    idRemapExisting: [...result.existingSourceIds, ...result.updatedSourceIds],
    idRemapCreated: result.createdByObject,
  });
}

/**
 * What a removal is about to take, said before it deletes anything: the run
 * and the org, the records per object, and what stays — the records the target
 * already held, and, without `--include-changed`, those changed since the run.
 * Exported so it can be tested.
 */
export function removalPlanLines(
  summary: RunSummary,
  plan: readonly ForgeRunObjectRecords[],
  args: Pick<RemoveArgs, 'target' | 'includeChanged'>,
): string[] {
  const planned = plan.reduce((sum, object) => sum + object.ids.length, 0);
  const ended = summary.result.writtenBetween?.last ?? summary.finishedAt;
  // Left where they are: the records the run linked to, but for those the
  // platform wrote with a record it created, which go with that one, and the
  // records --upsert wrote over.
  const stay =
    forgeRunLinkedKept({
      idRemapExisting: summary.result.existingSourceIds,
      idRemapWithTheirRecord: summary.result.withTheirRecordSourceIds,
    }).length + summary.result.updatedSourceIds.length;
  return [
    `the clone of ${cloneSubjectOf(summary)} wrote to ${args.target}${ended ? ` until ${ended}` : ''}; ` +
      `a removal deletes the ${planned} record(s) it created, children first:`,
    ...plan.map((object) => `  ${object.objectApiName}: ${object.ids.length}`),
    ...quoteCopiesLines(plan),
    `${stay} record(s) the target already held, which the run linked to or wrote over, stay`,
    args.includeChanged
      ? 'records changed since the run go too, and what was added to them since'
      : 'records changed since the run stay, as do those records added since depend on ' +
        `(${ownOptionWords('--include-changed', 'removal')} takes them)`,
  ];
}

/**
 * What a removal of one part of a run cut and taken up takes after its own
 * records, said with its plan: what an earlier removal of another part left,
 * per part and object. Nothing when there is none. Exported so it can be
 * tested.
 */
export function partsLeftLines(
  left: ReadonlyArray<{ part: Pick<RunPart, 'part'>; plan: readonly ForgeRunObjectRecords[] }>,
): string[] {
  return left.flatMap(({ part, plan }) => [
    `then the ${idsOf(plan).length} record(s) of the run's part ${part.part} (its summary's ` +
      '"part") an earlier --remove of that part left, once these are gone:',
    ...plan.map((object) => `  ${object.objectApiName}: ${object.ids.length}`),
  ]);
}

/**
 * What a plan says, before anything is read, of the lines the platform copies
 * when a run creates a quote and lines under it, or under its opportunity:
 * set as the quote its opportunity syncs, the quote gets a copy of each line
 * item the run inserts, which the run's id map does not hold. The removal
 * reads them as it begins and takes them with the run's own lines, counted
 * apart (`platformCopiesWords`); `--preview` counts them. Nothing for a plan
 * without a quote and its lines. Exported so it can be tested.
 */
export function quoteCopiesLines(plan: readonly ForgeRunObjectRecords[]): string[] {
  const objects = new Set(plan.filter((o) => o.ids.length > 0).map((o) => o.objectApiName));
  const lines = objects.has('QuoteLineItem') || objects.has('OpportunityLineItem');
  if (!objects.has('Quote') || !lines) return [];
  return [
    '  and the lines the platform copied between a quote the run synced and its opportunity, ' +
      'read as the removal begins and counted apart (--preview counts them)',
  ];
}

/**
 * Of an object's records, those the platform copied as the run wrote — the
 * lines of a quote the run synced with its opportunity, which the id map does
 * not hold —, said beside its counts: a plan of 2 quote lines once ended in
 * 4 deleted of 4, and nothing said where the other 2 came from. Empty when
 * there were none. Exported so it can be tested.
 */
export function platformCopiesWords(object: { planned: number; platformCopies?: number }): string {
  const copies = object.platformCopies ?? 0;
  if (copies <= 0) return '';
  return (
    ` (${object.planned - copies} the run wrote, and ${copies} the platform copied between the ` +
    'quote the run synced and its opportunity)'
  );
}

/**
 * What a removal took along that was not the run's, said under its object's
 * counts: the records added or changed since that the org deleted with the
 * ones the removal deleted, as a removal including changes asks. Taken unsaid,
 * a contact made by hand under an account of a Frozen load went with the
 * account, and the removal said "Contact: 4 deleted of 4", the load's four.
 * Empty when it took none. Exported so it can be tested.
 *
 * @param of - What the removal takes back, as the command calls it.
 */
export function tookAlongLines(
  object: Pick<ForgeUndoObjectResult, 'tookAlong'>,
  of: 'run' | 'load' = 'run',
): string[] {
  const taken = object.tookAlong;
  if (!taken || taken.count <= 0) return [];
  return [
    `      took along ${taken.count} record(s) that were not the ${of}'s, added or changed ` +
      `since it: ${taken.objects.join(', ')}`,
  ];
}

/** What became of one object's records in a removal: the counts that are not zero. */
function removalCounts(object: ForgeUndoObjectResult): string {
  return [
    object.deleted > 0 ? `${object.deleted} deleted` : '',
    object.alreadyGone > 0 ? `${object.alreadyGone} already gone` : '',
    (object.notVisible ?? 0) > 0
      ? `${object.notVisible} not visible to this user (neither found nor in the recycle bin)`
      : '',
    object.keptChanged > 0 ? `${object.keptChanged} kept, changed since the run` : '',
    object.keptDependents > 0
      ? `${object.keptDependents} kept for records that stay` +
        (object.heldBy.length > 0 ? ` (${object.heldBy.join(', ')})` : '')
      : '',
    object.refused > 0 ? `${object.refused} refused` : '',
    (object.notReached ?? 0) > 0 ? `${object.notReached} not reached` : '',
  ]
    .filter(Boolean)
    .join(', ');
}

/**
 * The files attached to an object's records the removal deleted, which stay in
 * the org: the run did not create them, and the removal leaves them there.
 */
function filesLeftLine(files: ForgeRemovalFilesLeft): string {
  const more = files.count > files.names.length ? ', …' : '';
  return (
    `${files.count} file(s) attached to them stay in the org, as the run did not create them: ` +
    `${files.names.join(', ')}${more}`
  );
}

/**
 * What a removal did, as the Frozen command says it: how it ended, then per
 * object what became of its records — deleted, already gone, kept as changed
 * since the run, kept for the records that stay and which, refused — with the
 * org's words and the files left in the org, and the objects that go with
 * their parent unchecked. Exported so it can be tested.
 */
export function removalLines(
  status: ForgeUndoStatus,
  objects: readonly ForgeUndoObjectResult[],
  mayHaveBeenWritten = 0,
): string[] {
  const unchecked = [...new Set(objects.flatMap((o) => o.unchecked))];
  return [
    `removal: ${status.toUpperCase()}`,
    ...objects.flatMap((o) => [
      `  ${o.objectApiName}: ${removalCounts(o) || 'nothing'} of ${o.planned}${platformCopiesWords(o)}`,
      ...tookAlongLines(o),
      ...o.reasons.map((reason) => `      ${reason}`),
      ...(o.filesLeft && o.filesLeft.count > 0 ? [`      ${filesLeftLine(o.filesLeft)}`] : []),
    ]),
    ...(unchecked.length > 0
      ? [`not checked, deleted with their parent: ${unchecked.join(', ')}`]
      : []),
    // Records a call of the run may have written before its answer was lost:
    // no id of theirs is known, and nothing here reaches them.
    ...(mayHaveBeenWritten > 0
      ? [
          `not reachable: ${mayHaveBeenWritten} record(s) a call of the run may have written ` +
            'before its answer was lost may be in the org, under ids the run never learned',
        ]
      : []),
  ];
}

/** What a sweep could not tell of the target's automation, said in a line or two. */
function sweepGapLines(listing: Pick<ForgeSweepListing, 'automationGaps'>): string[] {
  const gaps = listing.automationGaps;
  if (!gaps) return [];
  return [
    ...(gaps.error
      ? [
          `  the target's automation could not all be read (${gaps.error}): what it creates may be missed`,
        ]
      : []),
    ...(gaps.flowsNotRead > 0
      ? [
          `  ${gaps.flowsNotRead} flow(s) on the run's objects not read: what they create is not looked at`,
        ]
      : []),
    ...(gaps.triggers > 0
      ? [
          `  ${gaps.triggers} Apex trigger(s) on the run's objects: what they create no metadata says`,
        ]
      : []),
  ];
}

/** What a sweep could not look at, and the hand work that refuses it. */
function sweepNoteLines(listing: Pick<ForgeSweepListing, 'unread' | 'handWork'>): string[] {
  return [
    ...listing.unread.map((unread) => `  not looked at: ${unread.objectApiName}: ${unread.reason}`),
    ...listing.handWork.map(
      (count) =>
        `  created by the run's user in the window, where neither the run nor its automation writes: ` +
        `${count.objectApiName}: ${count.count} (left)`,
    ),
  ];
}

/** Objects named in one line at most; the rest are counted. */
const OBJECTS_NAMED = 10;

/**
 * Why a run is refused past `--max-total`, and what narrows it: the options of
 * this script's line. Relayed by a command that takes none of them — the MCP
 * server's `clone_record`, an environment's apply, which gives each clone its
 * dry run's count — they are this script's own: told "raise --max-total", an
 * agent had no parameter to raise it with. Relayed by an environment, which
 * sets the ceiling itself, it is said as the environment holds it: the
 * resource's `maxTotal` for a dry run, the count its plan gave for a run,
 * past which a source that grew since is refused. Told "raise its
 * --max-total", the reader of an apply had nothing to raise. Exported so it
 * can be tested.
 *
 * @param dryRun - Whether the run is a dry run, which an environment holds to its file's ceiling.
 */
export function maxTotalRefusal(rows: number, max: number, dryRun = false): string {
  if (relayTakes('--max-total')) {
    return (
      `The run would write ${rows} records, more than --max-total ${max}: narrow the clone ` +
      '(--max, --exclude-object, --filter), or raise --max-total.'
    );
  }
  if (relayedBy()?.startsWith('sandforge-env') === true) {
    return dryRun
      ? `The run would write ${rows} records, more than the ${max} the resource's maxTotal ` +
          'holds it to: narrow the resource in the file, or raise its maxTotal.'
      : `The run would write ${rows} records, more than the ${max} its plan counted: the ` +
          'source holds more records than when it was planned. Plan again.';
  }
  return (
    `The run would write ${rows} records, more than the ${max} ` +
    `${ownOptionWords('--max-total')} holds it to: narrow the clone with this script's own ` +
    '--max, --exclude-object or --filter, or raise its --max-total.'
  );
}

/**
 * An option of a sweep, as a line names it to whoever reads it: the option
 * itself on this script's own output, or relayed by a command that takes it
 * (`sandforge-env destroy`, its `--sweep`); relayed by a command whose line
 * does not take it (an apply of `sandforge-env`, the MCP server's
 * `run_remove`), this script's own removal given it. Exported so it can be
 * tested.
 */
export function sweepOptionWords(option: string): string {
  if (relayTakes(option)) return option;
  const sweep = option === '--sweep-list' || option === '--sweep' ? '' : '--sweep ';
  return `this script's own removal with ${sweep}${option}`;
}

/**
 * What takes what a sweep kept, as a line says it: the option, or, relayed
 * by `sandforge-env`, which keeps what came late and what is tied to nothing,
 * that it keeps them and what takes them.
 */
function takenByWords(option: string): string {
  const by = relayedBy();
  return by === undefined
    ? `${option} takes them`
    : `${by} keeps them; ${sweepOptionWords(option)} takes them`;
}

/** `names`, the first {@link OBJECTS_NAMED} of them, and how many more. */
function someOf(names: readonly string[]): string {
  const more = names.length - OBJECTS_NAMED;
  return `${names.slice(0, OBJECTS_NAMED).join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
}

/** Records per object, as a line says them: `Task: 2, Asset: 1`. */
function countsOfObjects(counts: readonly ForgeRemovalLeftCount[]): string {
  return counts.map((count) => `${count.objectApiName}: ${count.count}`).join(', ');
}

/**
 * What of one object's records falls in each class of a sweep, in words.
 * What changed since the run is said changed since the run: "by someone
 * else" was said of a task the run's own user had changed.
 */
function classWords(classes: ForgeSweepClasses, take: SweepClassArgs): string {
  const changed = classes.changed ?? 0;
  return [
    classes.made > 0
      ? `${classes.made} made for the run` +
        ((classes.sameSave ?? 0) > 0 ? ` (${classes.sameSave} in the same save)` : '')
      : '',
    classes.madeOver > 0 ? `${classes.madeOver} under records the run wrote over` : '',
    classes.late > 0 ? `${classes.late} late` : '',
    classes.untied > 0 ? `${classes.untied} tied to nothing of the run` : '',
    changed > 0
      ? `${changed} of them changed since the run${take.includeChanged === true ? '' : ', kept'}`
      : '',
  ]
    .filter(Boolean)
    .join(', ');
}

/** The classes of a sweep, as `ForgeSweepClasses` counts them. */
type SweepClassName = keyof NonNullable<ForgeSweepClasses['changedIn']>;

/**
 * Of one object's records in `name`, those a sweep that takes the class
 * deletes: all but what changed since the run, unless it includes what
 * changed, which it keeps.
 */
function goingIn(classes: ForgeSweepClasses, name: SweepClassName, take: SweepClassArgs): number {
  return classes[name] - (take.includeChanged === true ? 0 : (classes.changedIn?.[name] ?? 0));
}

/**
 * What a sweep takes of what it found, as it is asked: what is made for the
 * run, what came late with `--sweep-late`, what is tied to nothing with
 * `--sweep-untied` unless that is refused; of each, what changed since the
 * run only with `--include-changed`. A reload's list said "would delete 31"
 * of 31 tasks, and the reload kept the one changed since.
 */
function takenOf(listing: ForgeSweepListing, take: SweepClassArgs): number {
  const untiedTaken = take.sweepUntied === true && listing.untied?.refusal === undefined;
  return listing.found.reduce((sum, object) => {
    const classes = object.classes;
    // An object past the bound has no class, and none of its records goes.
    if (!classes) return sum;
    return (
      sum +
      goingIn(classes, 'made', take) +
      goingIn(classes, 'madeOver', take) +
      (take.sweepLate === true ? goingIn(classes, 'late', take) : 0) +
      (untiedTaken ? goingIn(classes, 'untied', take) : 0)
    );
  }, 0);
}

/**
 * Per object, what a class a list read before a sweep is asked to take would
 * delete: what changed since the run in it stays, unless it is included.
 */
function goingOfClass(
  listing: ForgeSweepListing,
  name: 'late' | 'untied',
  counts: readonly ForgeRemovalLeftCount[],
  take: SweepClassArgs,
): ForgeRemovalLeftCount[] {
  return counts.flatMap((count) => {
    const classes = listing.found.find(
      (object) => object.objectApiName === count.objectApiName,
    )?.classes;
    const going = classes ? Math.min(count.count, goingIn(classes, name, take)) : count.count;
    return going > 0 ? [{ objectApiName: count.objectApiName, count: going }] : [];
  });
}

/**
 * What a sweep lists and keeps, said with what it takes: what came late, what
 * is tied to nothing — and why taking it is refused, when it is —, the objects
 * past the most it looks at, what the run's mute kept quiet and what still ran,
 * and, to whoever reads the list before a sweep, what it cannot tell from the
 * automation's (`handWorkTakenLines`). A list read before a sweep asked to
 * take what came late or is tied to nothing (`--sweep-list --sweep-late`)
 * says what each would take.
 *
 * @param before - Whether the list is read before a sweep, not as one begins.
 */
function sweepClassLines(
  listing: ForgeSweepListing,
  take: SweepClassArgs,
  before: boolean,
): string[] {
  const lines: string[] = [];
  const late = listing.late ?? [];
  if (late.length > 0 && take.sweepLate !== true) {
    lines.push(
      `kept, made late — tied to the run but created more than a minute after the record it ` +
        `hangs from, or by the org's Automated Process user: ${countsOfObjects(late)} ` +
        `(${takenByWords('--sweep-late')})`,
    );
  } else if (before && take.sweepLate === true) {
    const going = goingOfClass(listing, 'late', late, take);
    lines.push(
      `with --sweep-late, it would delete too what was made late: ` +
        (going.length > 0 ? countsOfObjects(going) : late.length > 0 ? 'none' : 'none found'),
    );
  }
  const untied = listing.untied;
  if (untied && untied.objects.length > 0) {
    if (untied.refusal !== undefined) {
      lines.push(
        `kept, tied to nothing of the run: ${countsOfObjects(untied.objects)} — ` +
          `--sweep-untied is refused: ${untied.refusal}`,
      );
    } else if (take.sweepUntied !== true) {
      lines.push(
        `kept, created as the run's user in its window but tied to nothing of it: ` +
          `${countsOfObjects(untied.objects)} (${takenByWords('--sweep-untied')})`,
      );
    } else if (before) {
      const going = goingOfClass(listing, 'untied', untied.objects, take);
      lines.push(
        `with --sweep-untied, it would delete too what is tied to nothing of the run: ` +
          (going.length > 0 ? countsOfObjects(going) : 'none'),
      );
    }
  } else if (before && take.sweepUntied === true) {
    lines.push(
      untied?.refusal !== undefined
        ? `with --sweep-untied, it would delete nothing tied to nothing of the run: ` +
            `--sweep-untied is refused: ${untied.refusal}`
        : 'with --sweep-untied, it would delete too what is tied to nothing of the run: none found',
    );
  }
  if (listing.notLooked && listing.notLooked.length > 0) {
    lines.push(
      `not looked at, past the ${SWEEP_LOOK_BOUND} objects a sweep counts: ` +
        someOf(listing.notLooked),
    );
  }
  if (listing.muted) {
    const { silenced, stillRan } = listing.muted;
    lines.push(
      `the run's mute kept ${silenced.length} automation(s) quiet; ` +
        (stillRan.length > 0
          ? `what still ran may have made what is listed: ${someOf(
              stillRan.map((entry) => `${entry.name} (${entry.objectApiName})`),
            )}`
          : 'nothing of what the run fired still ran'),
    );
  }
  if (before) lines.push(...handWorkTakenLines(listing, take));
  return lines;
}

/**
 * What a sweep cannot tell from the automation's among what it would take,
 * said to whoever reads its list before it: a record made by hand as the
 * run's user where the automation makes them — under the run's records within
 * a minute of them, within a quarter of an hour with `--sweep-late`, anywhere
 * in the window with `--sweep-untied` — and one changed by hand before the
 * run's last write, which reads as unchanged. Run for real on the trap org, a
 * reload's list with --sweep-untied said none of it, and counted among what
 * it deletes a task the load's user had edited. Nothing when it takes none of
 * those classes.
 */
function handWorkTakenLines(listing: ForgeSweepListing, take: SweepClassArgs): string[] {
  // An object past the most a sweep counts is not swept: the page says
  // nothing of it either.
  const holds = (name: 'made' | 'madeOver' | 'late' | 'untied'): boolean =>
    listing.found.some((object) => !object.overBound && (object.classes?.[name] ?? 0) > 0);
  const made = holds('made') || holds('madeOver');
  const where = [
    made ? MADE_WHERE : '',
    // Said alone, what came late names the records it is made under.
    take.sweepLate === true && holds('late')
      ? `under ${made ? 'them' : "the run's records"} within a quarter of an hour with --sweep-late`
      : '',
    take.sweepUntied === true && listing.untied?.refusal === undefined && holds('untied')
      ? "anywhere in the run's window with --sweep-untied"
      : '',
  ].filter(Boolean);
  if (where.length === 0) return [];
  return [
    `${handWorkWords(`${where.join(', or ')}${where.length > 1 ? ',' : ''}`)}: check the ` +
      'names before a --sweep',
  ];
}

/** Where a sweep takes what the target's automation made for the run, asked nothing more. */
const MADE_WHERE = "under the run's records within a minute of them";

/**
 * What a sweep cannot tell from the automation's work among what it takes,
 * in words: said by the list read before a sweep (`handWorkTakenLines`), and
 * by a removal whose advice is a sweep (`automationHeldLines`).
 *
 * @param where - Where the sweep takes what it takes: {@link MADE_WHERE}, and
 *   what more it is asked to take.
 */
function handWorkWords(where: string): string {
  return (
    `a record made by hand as the run's user ${where} reads as the automation's, and one ` +
    "changed by hand before the run's last write as unchanged"
  );
}

/**
 * What a sweep would delete, said before anything is: the window and the
 * objects looked at, per object the records found with a few of their names
 * — names, never ids — and how many fall in each class; what it lists and
 * keeps, and why; what could not be looked at, and why the
 * sweep would be refused. Exported so it can be tested.
 *
 * @param take - What the removal asks the sweep to take beside what is made
 *   for the run (`--sweep-late`, `--sweep-untied`), said as the sweep begins;
 *   absent, the list is read before one.
 * @param before - Whether the list is read before a sweep: by default, when
 *   nothing is asked of it. A `--sweep-list` asked what came late or is tied
 *   to nothing is read before one, and counts and names what each would take.
 */
export function sweepListingLines(
  listing: ForgeSweepListing,
  target: string,
  take?: SweepClassArgs,
  before = take === undefined,
): string[] {
  const found = takenOf(listing, take ?? {});
  // The counts under it are of what it found: 4 tasks listed under "it would
  // delete 2 record(s)" read as 4 going, when 2 were late and stayed.
  const all = listing.found.reduce((sum, object) => sum + object.count, 0);
  const atLeast = listing.found.some((object) => object.overBound) ? ' or more' : '';
  return [
    listing.window
      ? `a sweep looks in ${target} for what the run's user created from ${listing.window.from} ` +
        `to ${listing.window.to} that the run's id map does not hold, in: ${someOf(listing.looked)}`
      : `a sweep of ${target} cannot tell the window the run wrote in`,
    ...(listing.found.length > 0
      ? [
          `it found ${all}${atLeast} record(s) and would delete ` +
            (found > 0 ? `${found} of them, children first` : 'none of them') +
            '; per object, all it found:',
          ...listing.found.map(
            (object) =>
              `  ${object.objectApiName}: ${object.count}` +
              (object.overBound ? ' or more (over the bound: none would be deleted)' : '') +
              (object.classes ? ` — ${classWords(object.classes, take ?? {})}` : '') +
              (object.names.length > 0
                ? ` (${object.names.join(', ')}${object.count > object.names.length ? ', …' : ''})`
                : ''),
          ),
        ]
      : listing.window
        ? ['it finds nothing to delete']
        : []),
    ...sweepClassLines(listing, take ?? {}, before),
    ...sweepGapLines(listing),
    ...sweepNoteLines(listing),
    ...(listing.refusal ? [`sweep refused: ${listing.refusal}`] : []),
  ];
}

/**
 * The listing of a sweep whose command said nothing of it yet: one that takes
 * nothing asks nothing (`SweepOptions.approve`), and a `--sweep` that kept all
 * it found, late or tied to nothing, did not say so. Undefined once it was
 * said, for a sweep stopped before it read, and for one refused, whose result
 * says why. Exported so it can be tested.
 *
 * @param said - What the sweep's question said, when it asked one.
 */
export function sweepUnsaid(
  parts: Pick<SweepParts, 'listing'> | undefined,
  said: ForgeSweepListing | undefined,
): ForgeSweepListing | undefined {
  const listing = parts?.listing;
  return said === undefined && listing?.refusal === undefined ? listing : undefined;
}

/**
 * Why a removal that kept records of the run for records hanging from them
 * kept them, when those records are likely the target's automation's —
 * created under the run's records during the run, as its user, and changed
 * since by no one else (`ForgeUndoObjectResult.heldByAutomation`) —, and
 * what takes them. Its one advice was `--include-changed`, which takes a
 * colleague's work too. Nothing when no record was so kept. Exported so it
 * can be tested.
 *
 * A removal whose run the target can no longer date — its summary built from
 * its journal, whose records that dated it this removal deleted, or one that
 * never said when it wrote — offers no sweep: a sweep of it is refused, for
 * want of the window to look in. Live, the removal of a run's journal said
 * "--sweep takes them first" of a contact role made by hand between its two
 * parts, and `--sweep-list` of the same journal was refused.
 *
 * What holds them is said as the org dated it: a record created after the
 * last write of the run, or of its part that wrote them, is the automation
 * run late or a person working as the run's user, never "during the run". A
 * sweep it offers is said with what that sweep takes that may not be the
 * run's, in the words of the list read before one (`handWorkWords`): live, a
 * cut part's removal offered `--sweep` for a contact role made by hand five
 * seconds after the part, which that sweep would have deleted. The records
 * of another part of the run, which an earlier removal of that part left and
 * this one took up (`part`), are its sweep's to take, never this summary's:
 * live, the resume's removal said "--sweep takes them first" of the cut
 * part's records, and its own sweep, looking in the resume's window, found
 * nothing.
 *
 * @param asked - Whether the removal had a sweep: what it left of them, it
 *   left for a reason its listing says; whether a sweep could not tell the
 *   window the run wrote in now (`windowUntold`); whether the run was cut and
 *   taken up (`inParts`); and, for the records of another part than the
 *   summary's, that part (`part`).
 */
export function automationHeldLines(
  objects: ReadonlyArray<
    Pick<
      ForgeUndoObjectResult,
      'heldByAutomation' | 'heldByAutomationAfterRun' | 'automationHolders'
    >
  >,
  asked: { sweep?: boolean; windowUntold?: boolean; inParts?: boolean; part?: number },
): string[] {
  const held = objects.reduce((sum, object) => sum + (object.heldByAutomation ?? 0), 0);
  if (held === 0) return [];
  const after = Math.min(
    held,
    objects.reduce((sum, object) => sum + (object.heldByAutomationAfterRun ?? 0), 0),
  );
  const holders = [...new Set(objects.flatMap((object) => object.automationHolders ?? []))];
  const named = holders.length > 0 ? ` (${someOf(holders)})` : '';
  const by = `likely by the target's automation${named}`;
  const byHand =
    'delete them by hand, then remove the run again; ' +
    `${ownOptionWords('--preview', 'removal')} says what of it their delete leaves changed ` +
    `since, which ${ownOptionWords('--include-changed', 'removal')} takes`;
  if (asked.part === undefined && asked.sweep !== true && asked.windowUntold === true) {
    return [
      `${held} record(s) of the run kept for records created under them as its user, within a ` +
        `minute of them, ${by}: a sweep cannot take them, as it cannot tell the window the run ` +
        `wrote in now — ${byHand}`,
    ];
  }
  const end =
    asked.part !== undefined
      ? "that part's last write"
      : asked.inParts === true
        ? "the last write of the run's part that wrote them"
        : "the run's last write";
  const when =
    after === 0
      ? 'during the run, as its user'
      : after === held
        ? `as its user after ${end}, within a minute of them`
        : `as its user during the run or, under ${after} of them, after ${end}, within a ` +
          'minute of them';
  const whose =
    asked.part === undefined
      ? 'of the run'
      : `of the run's part ${asked.part} (its summary's "part")`;
  const what =
    `${held} record(s) ${whose} kept for records created under them ${when}, ` +
    (after === 0 ? by : `by the target's automation or by hand${named}`);
  const handWork = handWorkWords(MADE_WHERE);
  if (asked.part !== undefined) {
    const ofPart = (option: string): string =>
      `${relayedBy() === undefined ? '--remove' : "this script's own removal"} of part ` +
      `${asked.part}'s summary with ${option}`;
    return [
      `${what}: ` +
        (asked.sweep === true
          ? "this removal's sweep looked in its own part's window alone, and did not see them; "
          : "a sweep of this summary looks in its own part's window alone, and leaves them; ") +
        `${ofPart('--sweep')} takes them first (${ofPart('--sweep-list')} shows them; ` +
        `${handWork}: check the names before it), or ${byHand}`,
    ];
  }
  return [
    asked.sweep === true
      ? `${what}: the sweep left them — ${sweepOptionWords('--sweep-list')} says why; ` +
        `${sweepOptionWords('--sweep-late')} takes those it lists as late, ` +
        `${ownOptionWords('--include-changed', 'removal')} those changed after the run's last write`
      : `${what}: ${sweepOptionWords('--sweep')} takes them first ` +
        `(${sweepOptionWords('--sweep-list')} shows them); ${handWork}: check the names before ` +
        (relayTakes('--sweep') ? 'a --sweep' : sweepOptionWords('--sweep')),
  ];
}

/** What a sweep's result calls each class of what it left. */
const SWEEP_LEFT_WORDS: Readonly<Record<ForgeSweepLeftClass['class'], string>> = {
  late: 'made late',
  untied: 'tied to nothing of the run',
};

/**
 * What a sweep found and left, by class, with the option that takes each or
 * why that option takes nothing: its status stays what it did to what it was
 * asked to take, and a `success` with five tasks left said so only in the line
 * before the first delete.
 */
function sweepLeftLines(left: readonly ForgeSweepLeftClass[]): string[] {
  return left.map(({ class: kept, objects, option, refusal }) => {
    const what = `  left, ${SWEEP_LEFT_WORDS[kept]}: ${countsOfObjects(objects)}`;
    return refusal !== undefined
      ? `${what} — ${option} is refused: ${refusal}`
      : `${what} (${takenByWords(option)})`;
  });
}

/**
 * What a sweep did: how it ended, per object what became of the records it
 * found — deleted, already gone, kept as changed since the run, refused with
 * the org's words — what it found and left, by class, what it could not look
 * at, and why it was refused when it was. Exported so it can be tested.
 */
export function sweepLines(result: ForgeSweepResult): string[] {
  return [
    `sweep: ${result.status.toUpperCase()}`,
    ...result.objects.flatMap((object) => {
      const after = object.afterRemoval ?? 0;
      const counts = [
        object.deleted > 0
          ? `${object.deleted} deleted` +
            (after > 0
              ? ` (${after} once the records of the run that point at them were gone)`
              : '')
          : '',
        object.alreadyGone > 0 ? `${object.alreadyGone} already gone` : '',
        object.keptChanged > 0 ? `${object.keptChanged} kept, changed since the run` : '',
        object.refused > 0 ? `${object.refused} refused` : '',
      ]
        .filter(Boolean)
        .join(', ');
      return [
        `  ${object.objectApiName}: ${counts || 'nothing'} of ${object.found}`,
        ...object.reasons.map((reason) => `      ${reason}`),
      ];
    }),
    ...sweepLeftLines(result.left ?? []),
    // Kept, then read back gone once the run's records were: never left.
    ...(result.goneAlong ?? []).map(
      ({ class: kept, objects }) =>
        `  ${SWEEP_LEFT_WORDS[kept]}, no longer in the org once the records of the run were ` +
        `gone: ${countsOfObjects(objects)}`,
    ),
    ...sweepGapLines(result),
    ...sweepNoteLines(result),
    ...(result.refusal ? [`  ${result.refusal}`] : []),
  ];
}

/**
 * Of a run cut and taken up, the records its journal names of the parts other
 * than the summary's, by target id: what each created, and what each linked
 * to. A sweep of one part's summary leaves them, as the run's own: the
 * removal of each part takes its records. Live, a resume that wrote 51 s
 * after the cut part's opportunity had its lines, quote and prices listed by
 * the cut part's --sweep-list as made for the run, to delete, and listed as
 * made late, which --sweep-late takes, when it wrote later; that part's
 * removal said they went with the resume's. Empty for a run of one part and
 * for the journal itself. Exported so it can be tested.
 */
export function otherPartIdsOf(run: Pick<RunInParts, 'parts' | 'part'> | undefined): string[] {
  return partsBeside(run).flatMap((other) => [...idsOf(other.created), ...other.linked]);
}

/** Of a run cut and taken up, its parts other than the summary's; none for the journal itself. */
function partsBeside(run: Pick<RunInParts, 'parts' | 'part'> | undefined): RunPart[] {
  const part = run?.part;
  return part === undefined ? [] : (run?.parts ?? []).filter((other) => other.part !== part);
}

/**
 * What a sweep of one part's summary says it leaves of the run's other parts
 * (`otherPartIdsOf`): each part with records left — with what the sweep found
 * pointing at them (`ForgeSweepListing.otherParts`) — and what takes them:
 * the removal of that part's summary, or of this one once its own are gone,
 * for a part an earlier removal was asked for and left (`partsLeft`).
 * Exported so it can be tested.
 */
export function otherPartsSweepLines(
  run: Pick<RunInParts, 'parts' | 'part' | 'earlier'> | undefined,
  listing?: Pick<ForgeSweepListing, 'otherParts'>,
): string[] {
  const asked = new Set(run?.earlier?.partsRemoved ?? []);
  return partsBeside(run).flatMap((other) => {
    const hanging = (listing?.otherParts ?? [])
      .filter(({ part }) => part === other.part)
      .flatMap(({ objects }) => objects)
      .reduce((sum, object) => sum + object.count, 0);
    const left = idsOf(stillLeft(other.created, run?.earlier?.removalLeft)).length + hanging;
    if (left === 0) return [];
    return [
      `a sweep of this summary leaves the ${left} record(s) of the run's part ${other.part} ` +
        `(its summary's "part"), the run's own, never the target's automation's: ` +
        (asked.has(other.part)
          ? 'an earlier --remove of that part left them, which the removal of this summary ' +
            'takes up once its own records are gone'
          : "--remove of that part's summary takes them"),
    ];
  });
}

/**
 * What a sweep of a summary's run is told of it: when the target dated its
 * writes, what it created, every record its id map holds — written, linked
 * to, matched or written over — the user it kept it wrote as, and what the
 * target's automation creates as the run's objects are written, read now;
 * and what ties a record to the run (`SweepTies`), so that the sweep takes
 * only what is tied to it. Of a run cut and taken up (`ofTheRun`), its id map
 * is every part's (`otherPartIdsOf`), and what points at a record another
 * part created is that part's (`SweepInput.otherParts`). Exported so it can
 * be tested.
 */
export async function cliSweepInput(
  conn: Connection,
  target: string,
  summary: RunSummary,
  created: readonly ForgeRunObjectRecords[],
  ties: SweepTies,
  {
    signal,
    ofTheRun,
  }: { signal?: AbortSignal; ofTheRun?: Pick<RunInParts, 'parts' | 'part'> } = {},
): Promise<SweepInput> {
  let automation: ForgeTargetAutomation | { error: string };
  try {
    automation = await targetAutomationReader(conn).read(
      target,
      created.map((object) => object.objectApiName),
    );
  } catch (err: unknown) {
    automation = { error: extractErrorMessage(err) };
  }
  const runUserId = summary.result.runUserId;
  const otherParts = partsBeside(ofTheRun).map(({ part, created: theirs }) => ({
    part,
    created: theirs,
  }));
  return {
    writtenBetween: summary.result.writtenBetween,
    created,
    remap: new Set(
      [...Object.values(summary.result.remapTable), ...otherPartIdsOf(ofTheRun)].map((id) =>
        id.slice(0, 15),
      ),
    ),
    ...(otherParts.length > 0 ? { otherParts } : {}),
    automation: sweepAutomationOf(automation),
    ...(runUserId ? { runUserId } : {}),
    ties,
    ...(signal ? { signal } : {}),
  };
}

// ─── What a removal's sweep is told of the run, and what it says ─────────────

/** The flags that have a sweep take more of what it lists, each only beside `--sweep`. */
export const SWEEP_CLASS_FLAGS: readonly string[] = ['--sweep-late', '--sweep-untied'];

/** What a removal's command line asks its sweep to take beside what is tied to the run. */
export interface SweepClassArgs {
  /** Take too what the sweep lists as made late (`--sweep-late`). */
  sweepLate?: true;
  /** Take too what it lists as tied to nothing of the run (`--sweep-untied`), unless that is refused. */
  sweepUntied?: true;
  /**
   * Take too, of what it takes, what changed since the run
   * (`--include-changed`): kept otherwise, and counted so by its list.
   */
  includeChanged?: boolean;
}

/**
 * `--sweep-late` and `--sweep-untied` as a removal's command line gives
 * them, or why they cannot be read: each takes more of what the sweep lists,
 * and a removal without `--sweep` takes none of it. Read without it, a CI
 * line that meant to take what came late would have taken nothing, and said
 * so nowhere. Beside `--sweep-list`, the list says what each would take: it
 * refused them, and could not show what a `--sweep --sweep-untied` would
 * delete. Exported so it can be tested.
 */
export function sweepClassArgsOf(args: readonly string[]): SweepClassArgs | { refusal: string } {
  const given = SWEEP_CLASS_FLAGS.filter((flag) => args.includes(flag));
  if (given.length > 0 && !args.includes('--sweep') && !args.includes('--sweep-list')) {
    return {
      refusal:
        `${given.join(' and ')} ${given.length === 1 ? 'takes' : 'take'} more of what --sweep ` +
        `lists: give ${given.length === 1 ? 'it' : 'them'} with --sweep, or with --sweep-list ` +
        `to see what ${given.length === 1 ? 'it' : 'they'} would take.`,
    };
  }
  return {
    ...(args.includes('--sweep-late') ? { sweepLate: true as const } : {}),
    ...(args.includes('--sweep-untied') ? { sweepUntied: true as const } : {}),
  };
}

/** What a sweep is asked to take beside what is tied to the run, as `SweepOptions` takes it. */
export function sweepClassOptions(
  args: SweepClassArgs,
): Pick<SweepOptions, 'sweepLate' | 'sweepUntied'> {
  return {
    ...(args.sweepLate ? { sweepLate: true } : {}),
    ...(args.sweepUntied ? { sweepUntied: true } : {}),
  };
}

/**
 * A sweep in parts as the removal is handed it (`RunRemovalOptions`): its
 * first part made once the removal has read the run's records, before its
 * first delete, handed the removal's allowance of smaller calls when the
 * removal has one to share; what it takes, which holds none of the run's
 * records back; its last part once they are deleted. Nothing without a
 * sweep. Exported so it can be tested.
 */
export function sweepPartsOptions(parts: SweepParts | undefined): Pick<
  RunRemovalOptions,
  'automationMade' | 'afterRemoval'
> & {
  sweep?: (allowance?: SplitAllowance) => Promise<boolean>;
} {
  if (!parts) return {};
  return {
    // The removal's smaller calls, which the sweep spends with it; a removal
    // that hands none (Sync's, Seed's) leaves the sweep its own.
    sweep: (allowance) => parts.first(allowance),
    automationMade: parts.automationMade,
    afterRemoval: () => parts.afterRemoval(),
  };
}

/**
 * The org a removal's sweep works on: the removal's, its counts sent five to
 * a composite (`sweepCountsOf`), which costs the org one request of its day
 * as one query does. Sent one by one, the counts of a sweep that looks at the
 * children of an account, some 165 objects on a scratch org, would take a
 * request each. Exported so it can be tested.
 */
export function sweepOrgOf(conn: Connection, context: string, signal?: AbortSignal): SweepOrg {
  const org = removalOrg(conn, context);
  // Built over the removal's org rather than copied from it, so that an org
  // whose methods live on its prototype keeps them.
  const counted = Object.create(org) as SweepOrg;
  counted.counts = sweepCountsOf(compositeReader(compositeConnectionOf(conn), signal));
  return counted;
}

/** A span on this machine's clock, in epoch milliseconds. */
export interface MachineSpan {
  from: number;
  to: number;
}

/** The run a removal takes back, as the other runs of this machine are told from it. */
export interface OwnRun {
  /** Its journal, for a clone. */
  journal?: string;
  /** Its run id, for a Sync or a Seed run. */
  runId?: string;
  /** The records it created: a run that created one of them is the same run. */
  ids: readonly string[];
  /**
   * Of a clone cut and taken up, its parts other than the one removed, each
   * with what it created and when it wrote, on this machine's clock: the
   * run's own, its id map holds them, but what is tied to nothing of the part
   * removed may be theirs, as the panel reads the run's other entries.
   */
  otherParts?: ReadonlyArray<{ ids: readonly string[]; from: number; to: number }>;
}

/** What {@link otherRunsOf} looks for. */
export interface OtherRunsInput {
  /** The org the run wrote to, by its Organization Id. */
  organizationId: string;
  /** Its alias, for a Sync or a Seed run file that names its org by it alone. */
  alias?: string;
  /**
   * When the run wrote, on this machine's clock; undefined when it cannot be
   * told, and every run of the org is then taken for one of its window.
   */
  span: MachineSpan | undefined;
  own: OwnRun;
  /** The folder the runs are kept in (`SANDFORGE_JOURNAL_DIR`): {@link journalDirOf} unless told. */
  journalDir?: string;
}

/**
 * When a Sync or a Seed run wrote, on this machine's clock, as its file keeps
 * it: its first write — its start, for a file written before it kept that —
 * to its end, or its last write for a run that never ended. Undefined when
 * the file says neither end. Exported so it can be tested.
 */
export function syncRunSpanOf(
  run: Pick<SyncRunKept, 'startedAt' | 'firstWrittenAt' | 'lastWriteAt' | 'lastWrittenAt' | 'end'>,
): MachineSpan | undefined {
  const from = Date.parse(run.firstWrittenAt ?? run.startedAt);
  const to = Date.parse(run.end?.at ?? run.lastWriteAt ?? run.lastWrittenAt ?? '');
  return Number.isFinite(from) && Number.isFinite(to)
    ? { from, to: Math.max(from, to) }
    : undefined;
}

/** Whether two org ids name the same org, an 18-character id and its first 15 alike. */
function sameOrgId(a: string | undefined, b: string): boolean {
  return a !== undefined && a.length >= 15 && a.slice(0, 15) === b.slice(0, 15);
}

/**
 * The records of the runs of this machine's command lines that wrote to the
 * same org within the run's window, each run's ids together
 * (`SweepTies.otherRuns`): the clones whose journals are kept in the journal
 * folder, the Sync and Seed runs whose files are. A sweep never takes them,
 * and while there is one, it takes nothing tied to nothing of the run, whose
 * it is cannot be told: on an org every session writes to as one user, two
 * runs a minute apart, or the resources of one environment applied back to
 * back, swept each other's records. The panel's runs, kept in the editor's
 * storage, and the runs of another machine or of a CI are not seen. Each run
 * is told by the span this machine's clock gave it, widened as the sweep's
 * window is (`SWEEP_LEAD_MS` before, `SWEEP_TRAIL_MS` after). A file that does
 * not read is passed over. Exported so it can be tested.
 */
export async function otherRunsOf(input: OtherRunsInput): Promise<Array<{ ids: string[] }>> {
  const dir = input.journalDir ?? journalDirOf();
  const ownKeys = new Set(input.own.ids.map((id) => id.slice(0, 15)));
  const inWindow = (from: number, to: number): boolean =>
    !input.span ||
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    (from <= input.span.to + SWEEP_TRAIL_MS && to >= input.span.from - SWEEP_LEAD_MS);
  const others: Array<{ ids: string[] }> = [];
  const add = (ids: readonly string[]): void => {
    if (ids.length === 0 || ids.some((id) => ownKeys.has(id.slice(0, 15)))) return;
    others.push({ ids: [...ids] });
  };

  // The clones, each by its journal.
  const forgeRuns = joinPath(dir, 'forge-runs');
  let names: string[] = [];
  try {
    names = readdirSync(forgeRuns).filter((name) => name.endsWith('.ndjson'));
  } catch {
    // No clone kept a journal here.
  }
  const journals = nodeRunJournal(dir);
  for (const name of names) {
    const path = joinPath(forgeRuns, name);
    if (input.own.journal !== undefined && resolvePath(input.own.journal) === resolvePath(path)) {
      continue;
    }
    try {
      const head = await journals.headAt(path);
      if (!head || !sameOrgId(head.targetOrgId, input.organizationId)) continue;
      const end = await journals.lastEndAt(path);
      const to = Date.parse(end?.at ?? '') || statSync(path).mtimeMs;
      if (!inWindow(Date.parse(head.startedAt), to)) continue;
      const read = await journals.readAt(path, 'all');
      add(read?.created.flatMap((object) => object.ids) ?? []);
    } catch {
      // A journal that does not read is passed over, as the removal's own reads it.
    }
  }

  // The run's other parts, each as a run of its own: see `OwnRun.otherParts`.
  for (const part of input.own.otherParts ?? []) {
    if (inWindow(part.from, part.to)) add(part.ids);
  }

  // The Sync and Seed runs, each by its file.
  for (const runs of [nodeSyncRunCreations(dir), nodeSyncRunCreations(dir, SEED_RUNS_DIR)]) {
    let listed: SyncRunKept[] = [];
    try {
      listed = await runs.list();
    } catch {
      continue;
    }
    for (const run of listed) {
      if (input.own.runId !== undefined && run.runId === input.own.runId) continue;
      const toTheOrg =
        sameOrgId(run.targetOrganizationId, input.organizationId) ||
        (run.targetOrganizationId === undefined &&
          (sameOrgId(run.targetOrgId, input.organizationId) ||
            (input.alias !== undefined && run.targetOrgId === input.alias)));
      if (!toTheOrg) continue;
      const from = Date.parse(run.firstWrittenAt ?? run.startedAt);
      // A run with no end stopped as it wrote, at its last write, or is
      // writing still: up to now.
      const to = run.end
        ? Date.parse(run.end.at)
        : Date.parse(run.lastWriteAt ?? run.lastWrittenAt ?? '') || Date.now();
      if (!inWindow(from, to)) continue;
      // What it wrote over counts: a run that only updated wrote in the
      // window as much as one that created.
      add([...run.created, ...(run.overwritten ?? [])].flatMap((object) => object.ids));
    }
  }
  return others;
}

/**
 * What tells a sweep the records tied to the run from the rest, beside the
 * records it created (`SweepTies`): the other runs of this machine in its
 * window, what its mute kept quiet and what still ran, when its first
 * removal began, and what an earlier sweep found made for it, and made late.
 * Exported so it can be tested.
 *
 * @param removalSpans - When the earlier removals of the run that wrote ran:
 *   the first one's start ends what can be the run's.
 * @param made - The ids an earlier sweep of the run found made for it, as
 *   its removals keep them.
 * @param late - The ids an earlier sweep found made late for it and left.
 */
export function commandSweepTies(input: {
  otherRuns: ReadonlyArray<{ readonly ids: readonly string[] }>;
  muted?: Pick<MutedAutomation, 'silenced' | 'stillRan'>;
  removalSpans?: readonly ForgeRemovalSpan[];
  made?: readonly string[];
  late?: readonly string[];
}): SweepTies {
  const began = input.removalSpans
    ?.map((span) => span.first)
    .filter((first) => Number.isFinite(Date.parse(first)))
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  return {
    otherRuns: input.otherRuns,
    ...(input.muted
      ? { muted: { silenced: input.muted.silenced, stillRan: input.muted.stillRan } }
      : {}),
    ...(began !== undefined ? { removalBegan: began } : {}),
    ...(input.made && input.made.length > 0 ? { madeEarlier: input.made } : {}),
    ...(input.late && input.late.length > 0 ? { lateEarlier: input.late } : {}),
  };
}

/**
 * What tells the records tied to a summary's run from the rest of what its
 * user created in its window (`commandSweepTies`): the other runs of this
 * machine that wrote to the org meanwhile, its mute, its earlier removals,
 * and what their sweeps found made for it, and made late. Read for a sweep,
 * its listing, and a preview asked with one.
 */
async function summarySweepTies(
  organizationId: string,
  target: string,
  summary: RunSummary,
  created: readonly ForgeRunObjectRecords[],
  earlier: EarlierRemovals | undefined,
  ofTheRun: Pick<RunInParts, 'parts' | 'part'> | undefined,
): Promise<SweepTies> {
  const finished = Date.parse(summary.finishedAt ?? '');
  const otherParts = partsBeside(ofTheRun).map((other) => ({
    ids: idsOf(other.created),
    from: Date.parse(other.startedAt ?? ''),
    to: Date.parse(other.endedAt ?? ''),
  }));
  return commandSweepTies({
    otherRuns: await otherRunsOf({
      organizationId,
      alias: target,
      span: Number.isFinite(finished)
        ? { from: finished - summary.elapsedMs, to: finished }
        : undefined,
      own: {
        ...(summary.journal !== undefined ? { journal: summary.journal } : {}),
        ids: created.flatMap((object) => object.ids),
        ...(otherParts.length > 0 ? { otherParts } : {}),
      },
    }),
    ...(summary.mutedAutomation ? { muted: summary.mutedAutomation } : {}),
    ...(earlier ? { removalSpans: earlier.removalSpans } : {}),
    ...(earlier?.made ? { made: earlier.made } : {}),
    ...(earlier?.late ? { late: earlier.late } : {}),
  });
}

/** The exit code of a removal that left records of the run in the org. */
const RECORDS_LEFT_EXIT = 3;

/**
 * Where a removal keeps what it left on the run's records, beside the summary
 * it took the run back from — `clone-summary.removals.json` for
 * `clone-summary.json` — and never the summary itself. Exported so it can be
 * tested.
 */
export function removalsPath(summaryPath: string): string {
  return /\.json$/i.test(summaryPath)
    ? summaryPath.replace(/\.json$/i, '.removals.json')
    : `${summaryPath}.removals.json`;
}

/**
 * The run a removals file is of, by the records it created: no two runs
 * create the same record, so the same records are the same run, however its
 * summary was saved or laid out since. Exported so it can be tested.
 */
export function runKey(plan: readonly ForgeRunObjectRecords[]): string {
  const keys = plan.flatMap((object) => object.ids.map((id) => id.slice(0, 15))).sort();
  return createHash('sha256').update(keys.join(',')).digest('hex');
}

/**
 * A date as the org writes one and a removal reads it back: a record's
 * `LastModifiedDate` comes as `2026-10-01T10:00:05.000+0000`, an offset
 * `z.iso.datetime()` refuses.
 */
const orgDateSchema = z
  .string()
  .refine(
    (value) =>
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})$/.test(value) &&
      Number.isFinite(Date.parse(value)),
    'not a date',
  );

/**
 * What a removal keeps beside the summary for the next one: what the
 * removals of the run left on records they did not delete, by record id, and
 * when each that wrote to the org ran and as which user — what the wizard
 * keeps in a run's history entry (`removalStamps`, `removalSpans`) — and the
 * run's records they have not taken (`removalLeft`). External input as the
 * summary is: every id is checked for an id, every date for a date. A file
 * written before removals kept `removalLeft` reads all the same: the next
 * removal sets out to take every record the run created.
 */
const runRemovalsSchema = z.object({
  tool: z.literal('sandforge-clone'),
  version: z.literal(1),
  /** The run's {@link runKey}. */
  run: z.string(),
  removalStamps: z.record(summaryIdSchema, orgDateSchema),
  removalSpans: z.array(
    z.object({ first: orgDateSchema, last: orgDateSchema, userId: summaryIdSchema }),
  ),
  removalLeft: z.array(summaryIdSchema).optional(),
  /** What the sweeps run with its removals took (`ForgeSweepMark`). */
  sweep: z
    .object({
      sweptAt: summaryDateSchema,
      deleted: z.number().int().nonnegative(),
      keptChanged: z.number().int().nonnegative(),
      refused: z.number().int().nonnegative(),
    })
    .optional(),
  /**
   * What the sweeps of the run found made for it, by id (`SweepParts.made`):
   * the next sweep takes them as made still, though the record of the run
   * they were tied to is gone and the lookup that told it with it.
   */
  made: z
    .array(summaryIdSchema)
    .max(MADE_KEPT_PER_OBJECT * 100)
    .optional(),
  /**
   * What the sweeps of the run found made late for it, by id
   * (`SweepParts.late`): late still for the next sweep, which takes them with
   * `--sweep-late`. Left by a sweep that did not take them, their tie went
   * with the run's record, and the next sweep found them in no class.
   */
  late: z
    .array(summaryIdSchema)
    .max(MADE_KEPT_PER_OBJECT * 100)
    .optional(),
  /**
   * Of a run cut and taken up, kept beside its journal: the parts a removal
   * was asked for, by their place in the journal — the journal's own removal
   * asks for every one. What such a removal left, the removal of another
   * part takes once that part's own records are gone.
   */
  partsRemoved: z.array(z.number().int().nonnegative()).max(10_000).optional(),
});

/** What a removal keeps beside the summary for the next one. */
export type RunRemovals = z.infer<typeof runRemovalsSchema>;

/** What earlier removals of a run left on its records, for the next removal to be told. */
export type EarlierRemovals = Pick<
  RunRemovals,
  'removalStamps' | 'removalSpans' | 'removalLeft' | 'sweep' | 'made' | 'late' | 'partsRemoved'
>;

/**
 * What the removals file beside a summary says of the earlier removals of
 * its run: nothing when there is no file; nothing either from the file of
 * another run, as when another run's summary was saved under the same name
 * since, which the next removal replaces; or why it cannot be read, said after
 * the file's name — a file there that the command did not write, which it
 * will not overwrite, or one whose ids or dates are not what they should be.
 * Exported so it can be tested.
 *
 * @param text - The file's content; undefined when there is none.
 * @param run - The {@link runKey} of the summary's run.
 */
export function readEarlierRemovals(
  text: string | undefined,
  run: string,
): { earlier?: EarlierRemovals; otherRun?: true } | { refusal: string } {
  if (text === undefined) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // Not JSON: not a file the command wrote, which the header below refuses.
  }
  const header = z.object({ tool: z.literal('sandforge-clone'), run: z.string() }).safeParse(raw);
  if (!header.success) {
    return {
      refusal:
        'is not the record of removals sandforge-clone keeps there, and is not overwritten: ' +
        'move it, as the removal keeps there what it leaves on the records of the run.',
    };
  }
  if (header.data.run !== run) return { otherRun: true };
  const parsed = runRemovalsSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.map(String).join('.') || 'the file'}: ${issue.message}`);
    return { refusal: `is not a record of removals a removal can read: ${issues.join('; ')}.` };
  }
  const { removalStamps, removalSpans, removalLeft, sweep, made, late, partsRemoved } = parsed.data;
  return {
    earlier: {
      removalStamps,
      removalSpans,
      ...(removalLeft ? { removalLeft } : {}),
      ...(sweep ? { sweep } : {}),
      ...(made ? { made } : {}),
      ...(late ? { late } : {}),
      ...(partsRemoved ? { partsRemoved } : {}),
    },
  };
}

/**
 * What the removals file holds once a removal has run: what the earlier
 * removals of the run left, with what this one left over it for a record both
 * stamped, when this one ran, and the records of the run still to take — those
 * it set out to take less those it deleted or found gone — as the wizard adds
 * a removal's to the run's history entry. Nothing when this removal stamped
 * nothing, took nothing and did not say when it ran: it has nothing to add.
 * Exported so it can be tested.
 *
 * A second removal of a summary once set out to take every record the run
 * created again: a record the first deleted from an object that skips the
 * recycle bin was found neither in the org nor in the bin, and counted as not
 * visible to the user, and the removal exited 3 for records already gone.
 *
 * @param plan - What this removal set out to take.
 * @param sweep - What the sweeps of the run took, this one's included, when one ran.
 * @param made - What this removal's sweep found made for the run, by id: kept
 *   with what earlier sweeps found ({@link madeKept}).
 * @param late - What it found made late for the run, kept the same way.
 * @param sweptGone - What it said gone (`SweepParts.gone`): kept no more.
 */
export function removalsAfter(
  run: string,
  earlier: EarlierRemovals | undefined,
  outcome: Pick<RunRemovalOutcome, 'stamps' | 'span'> & { gone?: readonly string[] },
  plan: readonly ForgeRunObjectRecords[] = [],
  sweep?: ForgeSweepMark,
  made: Iterable<string> = [],
  late: Iterable<string> = [],
  sweptGone: Iterable<string> = [],
): RunRemovals | undefined {
  const gone = new Set(outcome.gone ?? []);
  const said = [...sweptGone];
  const kept = madeKept(earlier?.made, made, said);
  const keptLate = madeKept(earlier?.late, late, said);
  const findsChanged =
    kept.join() !== (earlier?.made ?? []).join() ||
    keptLate.join() !== (earlier?.late ?? []).join();
  if (
    Object.keys(outcome.stamps).length === 0 &&
    !outcome.span &&
    gone.size === 0 &&
    !sweep &&
    !findsChanged
  ) {
    return undefined;
  }
  const swept = sweep ?? earlier?.sweep;
  const left =
    gone.size > 0
      ? plan.flatMap(({ ids }) => ids.filter((id) => !gone.has(id)))
      : earlier?.removalLeft;
  return {
    tool: 'sandforge-clone',
    version: 1,
    run,
    removalStamps: { ...earlier?.removalStamps, ...outcome.stamps },
    removalSpans: [...(earlier?.removalSpans ?? []), ...(outcome.span ? [outcome.span] : [])],
    ...(left ? { removalLeft: left } : {}),
    ...(swept ? { sweep: swept } : {}),
    ...(kept.length > 0 ? { made: kept } : {}),
    ...(keptLate.length > 0 ? { late: keptLate } : {}),
    ...(earlier?.partsRemoved ? { partsRemoved: earlier.partsRemoved } : {}),
  };
}

/** A run cut and taken up, as a removal of one of its summaries, or of its journal, reads it. */
export interface RunInParts {
  /** Its parts, as its journal says them. */
  parts: RunPart[];
  /** The part the summary is of; undefined for the journal itself, every part. */
  part?: number;
  /** What the removals of the run keep beside its journal, read by each. */
  file: string;
  /** The {@link runKey} of every record the run created, its parts together. */
  key: string;
  /** Those records, per object. */
  created: ForgeRunObjectRecords[];
  /** What that file says the removals of the run left. */
  earlier?: EarlierRemovals;
}

/**
 * The run a summary is one part of, when the run was cut and taken up and
 * its journal is there: its parts, and what its removals keep beside its
 * journal — the file the journal's own removal keeps, which a removal of any
 * of its summaries reads and adds to as well. Undefined for a run of one
 * part, or whose journal is gone; why that file cannot be read, said after
 * its name, refuses the removal as its own file does. Exported so it can be
 * tested.
 */
export async function runInPartsOf(
  summary: Pick<RunSummary, 'journal' | 'part'>,
  journals: ForgeRunJournal = nodeRunJournal(journalDirOf()),
): Promise<RunInParts | { refusal: string } | undefined> {
  const journal = summary.journal;
  if (journal === undefined || !existsSync(journal)) return undefined;
  const parts = await runPartsOf(journal, journals);
  const whole = parts.length > 1 ? await journals.readAt(journal, 'all') : undefined;
  if (!whole) return undefined;
  const file = removalsPath(journal);
  let text: string | undefined;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
      return {
        refusal: `${file} cannot be read: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  const key = runKey(whole.created);
  const read = readEarlierRemovals(text, key);
  if ('refusal' in read) return { refusal: `${file} ${read.refusal}` };
  return {
    parts,
    ...(summary.part !== undefined ? { part: summary.part } : {}),
    file,
    key,
    created: whole.created,
    ...(read.earlier ? { earlier: read.earlier } : {}),
  };
}

/**
 * Of a run cut and taken up, the parts other than the summary's that an
 * earlier removal was asked for and left records of, each with those
 * records: held, most often, by the records of the summary's own part, which
 * the removal of that part takes first. Exported so it can be tested.
 */
export function partsLeft(
  run: Pick<RunInParts, 'parts' | 'part' | 'earlier'>,
): Array<{ part: RunPart; plan: ForgeRunObjectRecords[] }> {
  const asked = new Set(run.earlier?.partsRemoved ?? []);
  return run.parts.flatMap((part) => {
    if (part.part === run.part || !asked.has(part.part)) return [];
    const plan = stillLeft(part.created, run.earlier?.removalLeft);
    return plan.length > 0 ? [{ part, plan }] : [];
  });
}

/**
 * Of the journal of a run cut and taken up, removed whole, `plan` as the
 * removal takes it: the records of the run's last part first, then those of
 * each part before it, the latest first — a part's records hang from those
 * of the parts before it — each part read against its own span, with what
 * the parts after it wrote, as the removals of its summaries read it. Read
 * over the run's whole window, the gap between its parts included, a contact
 * a colleague changed between the parts was taken for the run's own write
 * and went, and so did a contact role someone made then. A part with no
 * record left in `plan` is passed over. Undefined for a run of one part.
 * Exported so it can be tested.
 */
export function journalPartsOf(
  run: Pick<RunInParts, 'parts'>,
  plan: readonly ForgeRunObjectRecords[],
): Array<{ part: RunPart; plan: ForgeRunObjectRecords[] }> | undefined {
  if (run.parts.length < 2) return undefined;
  return [...run.parts]
    .sort((a, b) => b.part - a.part)
    .flatMap((part) => {
      const ofPart = stillLeft(plan, idsOf(part.created));
      return ofPart.length > 0 ? [{ part, plan: ofPart }] : [];
    });
}

/**
 * Of a run cut and taken up, the parts other than the summary's that no
 * removal was asked for yet and whose records are of objects among those
 * holding what this removal kept for records that stay, each with those
 * objects: the records of the same run, most often — the resume's quote and
 * lines under the opportunity the cut part wrote —, which the removal of that
 * part takes first, then what this one left. Live, removing the cut part
 * first kept seven records for the resume's, and said only that
 * `--include-changed` took them. Empty when nothing was so kept.
 */
function heldByOtherParts(
  run: Pick<RunInParts, 'parts' | 'part' | 'earlier'>,
  objects: ReadonlyArray<Pick<ForgeUndoObjectResult, 'keptDependents' | 'heldBy'>>,
): Array<{ part: number; objects: string[] }> {
  const holders = [...new Set(objects.flatMap((o) => (o.keptDependents > 0 ? o.heldBy : [])))];
  const asked = new Set(run.earlier?.partsRemoved ?? []);
  return run.parts.flatMap((part) => {
    if (part.part === run.part || asked.has(part.part)) return [];
    const wrote = new Set(
      stillLeft(part.created, run.earlier?.removalLeft).map((o) => o.objectApiName),
    );
    const held = holders.filter((object) => wrote.has(object));
    return held.length > 0 ? [{ part: part.part, objects: held }] : [];
  });
}

/** What {@link heldByOtherParts} found, said after the removal's result: what takes it. */
function heldByOtherPartsLines(
  held: ReadonlyArray<{ part: number; objects: readonly string[] }>,
): string[] {
  return held.map(
    ({ part, objects }) =>
      `of what this removal kept for records that stay, what the run's part ${part} (its ` +
      `summary's "part") holds — its ${objects.join(', ')} records — goes with --remove of ` +
      "that part's summary, once that part's own records are gone, without --include-changed",
  );
}

/**
 * The run's other parts, as a removal of `part` hands them over to be read
 * before its first write (`RunRemovalOptions.otherParts`): those with records
 * left, each dated as its journal dates it, with what the run's removals
 * stamped and what its later parts wrote. Exported so it can be tested.
 */
export function otherPartsOf(
  run: Pick<RunInParts, 'parts' | 'earlier'>,
  part: number,
  stamps: Readonly<Record<string, string>>,
): Array<{ part: number; alongside: RunPartAlongside }> {
  return run.parts.flatMap((other) => {
    if (other.part === part) return [];
    const plan = stillLeft(other.created, run.earlier?.removalLeft);
    const span = machineSpanOf(other);
    if (plan.length === 0 || !span) return [];
    const laterParts = laterPartsOf(run.parts, other.part);
    return [
      {
        part: other.part,
        alongside: {
          plan,
          span,
          ...(Object.keys(stamps).length > 0 ? { removalStamps: stamps } : {}),
          ...(laterParts.length > 0 ? { laterParts } : {}),
        },
      },
    ];
  });
}

/**
 * What the file beside a run's journal holds once a removal of one of its
 * summaries has run: what the run's removals left on its records, this one's
 * stamps over them — those it left on the records of every part —, when
 * each of its calls ran, the run's records still to take, and the parts it
 * was asked for. Nothing when it stamped nothing, took nothing, did not say
 * when it ran and was asked for no part not asked for before. Exported so it
 * can be tested.
 */
export function runRemovalsAfter(
  run: Pick<RunInParts, 'key' | 'created' | 'earlier'>,
  taken: {
    stamps: Readonly<Record<string, string>>;
    spans: readonly ForgeRemovalSpan[];
    gone: readonly string[];
    parts: readonly number[];
  },
): RunRemovals | undefined {
  const earlier = run.earlier;
  const asked = [...new Set([...(earlier?.partsRemoved ?? []), ...taken.parts])].sort(
    (a, b) => a - b,
  );
  if (
    Object.keys(taken.stamps).length === 0 &&
    taken.spans.length === 0 &&
    taken.gone.length === 0 &&
    asked.length === (earlier?.partsRemoved?.length ?? 0)
  ) {
    return undefined;
  }
  const gone = new Set(taken.gone.map((id) => id.slice(0, 15)));
  const left = (earlier?.removalLeft ?? idsOf(run.created)).filter(
    (id) => !gone.has(id.slice(0, 15)),
  );
  return {
    tool: 'sandforge-clone',
    version: 1,
    run: run.key,
    removalStamps: { ...earlier?.removalStamps, ...taken.stamps },
    removalSpans: spansOf(earlier?.removalSpans, taken.spans),
    removalLeft: left,
    ...(earlier?.sweep ? { sweep: earlier.sweep } : {}),
    ...(earlier?.made ? { made: earlier.made } : {}),
    ...(earlier?.late ? { late: earlier.late } : {}),
    partsRemoved: asked,
  };
}

/**
 * What the removals of the parts of a journal, made one after the other by
 * one command, leave beside it, as one removal leaves it: the stamps of each
 * — those on the records of the parts it did not take too —, when the first
 * began to when the last ended, and every record they took. Exported so it
 * can be tested.
 */
export function removalsOfParts(
  done: ReadonlyArray<Pick<RunRemovalOutcome, 'stamps' | 'otherPartStamps' | 'span' | 'gone'>>,
): Pick<RunRemovalOutcome, 'stamps' | 'span' | 'gone'> {
  const stamps: Record<string, string> = {};
  for (const one of done) {
    for (const each of [...(one.otherPartStamps ?? []), one.stamps]) Object.assign(stamps, each);
  }
  const spans = done.flatMap((one) => (one.span ? [one.span] : []));
  const span = spans.reduce<ForgeRemovalSpan | undefined>(
    (all, one) =>
      all
        ? {
            ...all,
            first: Date.parse(one.first) < Date.parse(all.first) ? one.first : all.first,
            last: Date.parse(one.last) > Date.parse(all.last) ? one.last : all.last,
          }
        : one,
    undefined,
  );
  return { stamps, ...(span ? { span } : {}), gone: done.flatMap((one) => one.gone) };
}

/**
 * What a removal of one part of a run is told of the earlier removals of the
 * run, its own and those of the run's other parts and of its journal: their
 * stamps over its own, when each ran, and what its own left. Exported so it
 * can be tested.
 */
export function earlierOfTheRun(
  own: EarlierRemovals | undefined,
  run: EarlierRemovals | undefined,
): EarlierRemovals | undefined {
  if (!run) return own;
  return {
    ...own,
    removalStamps: { ...own?.removalStamps, ...run.removalStamps },
    removalSpans: spansOf(own?.removalSpans, run.removalSpans),
  };
}

/**
 * Write a JSON file — the removals file, a run's summary — whole or not at
 * all: a process stopped while it wrote would leave half a file, which the
 * next removal refuses. Says why it could not, or nothing once it is written.
 * Exported so it can be tested.
 */
export function writeWhole(path: string, value: unknown): string | undefined {
  const written = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(written, JSON.stringify(value, null, 2) + '\n', 'utf8');
    renameSync(written, path);
    return undefined;
  } catch (err: unknown) {
    try {
      rmSync(written, { force: true });
    } catch {
      // Left where it is: the removals file itself is untouched.
    }
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Remove from its target the records a run created, from the summary the run
 * printed with `--json`: the removal the wizard runs on a run of Recent runs
 * (`removeRunRecords`), on the plan it reads from a history entry, dated by
 * the target's own dates of the run's writes. Exported so it can be tested.
 *
 * The summary, and what earlier removals of it kept beside it, are read and
 * checked before any org is contacted; then the target is typed, and refused
 * unless it is a sandbox and the org the run wrote to. What the removal left
 * on the run's records is kept beside the summary for the next one. Exits 0
 * when every record planned went, deleted or found gone,
 * {@link RECORDS_LEFT_EXIT} when some stayed, 2 on a bad command line or a
 * summary or removals file that cannot be read, 1 when the removal could not
 * run.
 */
export async function removeMain(argv: string[] = process.argv): Promise<void> {
  const t0 = Date.now();
  const args = parseRemoveArgs(argv);
  // In --json mode stdout carries the outcome alone, for a parser to read.
  const say = (line: string): void => (args.json ? console.error(line) : console.log(line));

  let text: string;
  try {
    text = readFileSync(args.summaryPath, 'utf8');
  } catch (err: unknown) {
    process.stderr.write(
      `--remove ${args.summaryPath} cannot be read: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(2);
  }
  let read = await runSummaryOfFile(args.summaryPath, text, args.target);
  if ('refusal' in read) {
    process.stderr.write(`--remove ${args.summaryPath} ${read.refusal}\n`);
    process.exit(2);
  }
  if (args.preview) return previewRemoval(args, read.summary, say, t0);
  /** The org, reached once: before the plan when the run's journal has calls to look for. */
  let reached: { session: SfOrg; conn: Connection; org: TypedOrg } | undefined;
  const reach = async (): Promise<{ session: SfOrg; conn: Connection; org: TypedOrg }> => {
    if (!reached) {
      const session = await loadOrg(args.target);
      const conn = makeConn(session);
      reached = { session, conn, org: await typeOrg(conn) };
    }
    return reached;
  };
  // The insert calls the run had under way when it stopped, their answer
  // never kept: looked for in the target before the removal is planned, and
  // what it holds of them kept in the journal as the run's, removed with the
  // rest. A run killed during a call left that call's records behind.
  const journalOfRun = read.summary.journal;
  if (
    journalOfRun !== undefined &&
    existsSync(journalOfRun) &&
    nodeRunJournal(journalDirOf()).callsInFlightAt(journalOfRun) > 0
  ) {
    const { conn, org } = await reach();
    if (read.summary.targetOrgId !== undefined && !sameRecord(read.summary.targetOrgId, org.id)) {
      refuseBeforeAnyRead(otherOrgRefusal(read.summary.targetOrgId));
    }
    const reconciled = await nodeRunJournal(journalDirOf()).reconcileAt(
      journalOfRun,
      inFlightTargetOf(conn),
    );
    for (const line of inFlightLines(reconciled, args.target, 'removal')) say(line);
    if (uncertainRows(reconciled) > 0) {
      say(
        `  the journal names none of the rows that may be in ${args.target}: they stay, and ` +
          `${sweepOptionWords('--sweep-list')} shows what the run's user created in the run's window`,
      );
    }
    read = await runSummaryOfFile(
      args.summaryPath,
      readFileSync(args.summaryPath, 'utf8'),
      args.target,
    );
    if ('refusal' in read) {
      process.stderr.write(`--remove ${args.summaryPath} ${read.refusal}\n`);
      process.exit(2);
    }
  }
  let { summary } = read;
  // The run's records go from the org it wrote to, and from no other. A
  // summary that names that org by its id is checked against the org's own
  // once it answers, whatever alias names it now; one printed before the
  // summary carried the id has its alias alone.
  if (summary.targetOrgId === undefined && summary.target !== args.target) {
    process.stderr.write(
      `The run wrote to ${summary.target}, and its records are removed from that org only: ` +
        `give --target ${summary.target}.\n`,
    );
    process.exit(2);
  }

  /** Records of the run a call may have written before its answer was lost, which no removal reaches. */
  const unreachable = (summary.result.mayHaveBeenWritten ?? []).reduce(
    (sum, { sourceIds }) => sum + sourceIds.length,
    0,
  );
  /** Records of the run an earlier removal of this summary took: not planned again. */
  let removedEarlier = 0;
  /** What the sweep found, said before its first delete: what it took, and what it listed and kept. */
  let sweepListing: ForgeSweepListing | undefined;
  /** What the removal muted of the target's automation, asked with --mute-automation. */
  let mutedAutomation: MutedAutomation | undefined;
  /** Why it stopped for objects its user may not delete, once it did. */
  let undeletableRefused: RunRefusal | undefined;
  /** Of a run cut and taken up, its parts not removed yet whose records may hold what it kept. */
  let keptForParts: Array<{ part: number; objects: string[] }> = [];
  /**
   * Whether a sweep of the run could not tell the window it wrote in once
   * this removal ended: a sweep is then refused, and none is offered.
   */
  let windowUntold = false;
  /** Whether the run was cut and taken up: its journal says two parts or more. */
  let ranInParts = false;
  /**
   * Of a run cut and taken up, removed by one of its summaries: what this
   * removal took of the summary's own part, and, part by part, of what an
   * earlier removal of another part left, which it took up after: what holds
   * what it kept of those is that part's sweep's to take, not this summary's.
   */
  let byPart:
    | {
        own: ForgeUndoObjectResult[];
        others: Array<{ part: number; objects: ForgeUndoObjectResult[] }>;
      }
    | undefined;
  /** What kept records of the run for what the automation likely made under them, and what takes it. */
  const heldLines = (objects: ForgeUndoObjectResult[]): string[] => {
    const asked = { sweep: args.sweep, windowUntold, inParts: ranInParts };
    if (!byPart) return automationHeldLines(objects, asked);
    return [
      ...automationHeldLines(byPart.own, asked),
      ...byPart.others.flatMap(({ part, objects: ofPart }) =>
        automationHeldLines(ofPart, { ...asked, part }),
      ),
    ];
  };
  /**
   * @param removalsFile - Where what the removal left on the run's records
   *   was kept, when it was.
   * @param sweep - What the sweep did, when one ran.
   */
  const output = (
    status: ForgeUndoStatus,
    objects: ForgeUndoObjectResult[],
    orgId?: string,
    removalsFile?: string,
    sweep?: ForgeSweepResult,
  ) => {
    if (args.json) {
      process.stdout.write(
        JSON.stringify(
          {
            tool: 'sandforge-clone',
            version: 1,
            action: 'remove',
            summary: args.summaryPath,
            target: args.target,
            ...(orgId ? { targetOrgId: orgId } : {}),
            includeChanged: args.includeChanged,
            result: {
              status,
              planned: objects.reduce((sum, o) => sum + o.planned, 0),
              objects,
              ...(unreachable > 0 ? { mayHaveBeenWritten: unreachable } : {}),
              ...(removedEarlier > 0 ? { removedEarlier } : {}),
              ...(sweep ? { sweep } : {}),
              ...(sweepListing ? { sweepListing } : {}),
              ...(mutedAutomation ? { mutedAutomation } : {}),
              ...(keptForParts.length > 0 ? { heldByOtherParts: keptForParts } : {}),
            },
            ...(removalsFile ? { removalsFile } : {}),
            elapsedMs: elapsedSince(t0),
          },
          null,
          2,
        ) + '\n',
      );
      for (const line of heldLines(objects)) console.error(line);
      for (const line of heldByOtherPartsLines(keptForParts)) console.error(line);
      return;
    }
    // A sweep alone took none of the run's records: only its own lines are said.
    if (objects.length > 0 || !sweep) {
      for (const line of removalLines(status, objects, unreachable)) console.log(line);
    }
    if (sweep) for (const line of sweepLines(sweep)) console.log(line);
    for (const line of heldLines(objects)) console.log(line);
    for (const line of heldByOtherPartsLines(keptForParts)) console.log(line);
    if (removalsFile) {
      console.log(
        `what this removal left on the run's records is kept in ${removalsFile}, ` +
          'which the next --remove of this summary reads',
      );
    }
    console.log(`\ndone in ${elapsedSince(t0)}ms`);
  };

  const created = removalPlan(summary);
  if (created.length === 0) {
    say('The run created no record: there is nothing of it to remove.');
    output('success', []);
    return;
  }

  // What earlier removals of this summary left on the run's records, which the
  // wizard keeps in the run's history and the command beside the summary.
  // Unread, a second removal would take what the first wrote to a record it
  // left — a status given back, an amount its deleted children changed — for
  // a change since the run, and keep the record. Read and checked before any
  // org is contacted, as the summary is.
  const run = runKey(created);
  const removalsFile = removalsPath(args.summaryPath);
  let removalsText: string | undefined;
  try {
    removalsText = readFileSync(removalsFile, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
      process.stderr.write(
        `${removalsFile} cannot be read: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(2);
    }
  }
  const before = readEarlierRemovals(removalsText, run);
  if ('refusal' in before) {
    process.stderr.write(`${removalsFile} ${before.refusal}\n`);
    process.exit(2);
  }
  const { otherRun, earlier: ownEarlier } = before;
  // A run cut and taken up: what the removals of its other parts, and of its
  // journal, left on its records is read too, kept beside its journal.
  const inParts = await runInPartsOf(summary);
  if (inParts && 'refusal' in inParts) {
    process.stderr.write(`${inParts.refusal}\n`);
    process.exit(2);
  }
  ranInParts = inParts !== undefined;
  const ofTheRun =
    inParts && resolvePath(removalsFile) !== resolvePath(inParts.file) ? inParts : undefined;
  const earlier = earlierOfTheRun(ownEarlier, ofTheRun?.earlier);

  say(`sandforge-clone --remove  ${args.summaryPath}  from ${args.target}`);
  // What earlier removals took is not planned again, as the panel plans only
  // what a run's history entry says is left (`forgeRemovalPlanLeft`).
  const ownPlan = forgeRemovalPlanLeft({
    objects: created,
    removalLeft: ownEarlier?.removalLeft,
  });
  const plan = stillLeft(ownPlan, ofTheRun?.earlier?.removalLeft);
  const count = (objects: readonly ForgeRunObjectRecords[]): number =>
    objects.reduce((sum, object) => sum + object.ids.length, 0);
  removedEarlier = count(created) - count(plan);
  if (count(created) > count(ownPlan)) {
    say(
      `${count(created) - count(ownPlan)} record(s) removed by an earlier --remove of this summary`,
    );
  }
  if (count(ownPlan) > count(plan)) {
    say(
      `${count(ownPlan) - count(plan)} record(s) removed by an earlier --remove of the run's ` +
        'other part or of its journal',
    );
  }
  // What an earlier removal of another part of the run was asked for and
  // left, its records held by this part's: taken once this part's are gone.
  const leftByOtherParts = ofTheRun ? partsLeft(ofTheRun) : [];
  // The journal of a run cut and taken up, removed whole: each part read
  // against its own span, the last first.
  const wholeRun = inParts && !('refusal' in inParts) && !ofTheRun ? inParts : undefined;
  const byParts = wholeRun ? journalPartsOf(wholeRun, plan) : undefined;
  // A sweep, or its listing, still has the run's window to look in.
  if (plan.length === 0 && leftByOtherParts.length === 0 && !args.sweep && !args.sweepList) {
    say('nothing left of the run to remove');
    output('success', []);
    return;
  }
  const { session, conn, org } = await reach();
  /** The removal's entry in the audit trail, with --audit; one operation id for the process. */
  const audited = new Map([[org.id, { alias: args.target, username: session.username }]]);
  const operationId = `sandforge-clone-${randomUUID()}`;
  /** The removal's mute, planned from what it read; its lease is taken before the first delete. */
  let removalMute: RunMute | undefined;
  const recordRemoval = (run: Omit<WriteRun, 'action' | 'module' | 'operationId' | 'orgId'>) =>
    recordCliRun(args.audit, audited, {
      action: 'cleanup_delete',
      module: 'forge',
      operationId,
      orgId: org.id,
      ...run,
      ...(mutedAutomation ? { muted: auditMutedOf(mutedAutomation) } : {}),
    });
  // A listing deletes nothing; a removal and a sweep delete, and a
  // production org is refused before either reads anything.
  const refusal = args.sweepList ? undefined : productionRefusal(args.target, org, 'remove');
  if (refusal) endRefused({ code: 'PRODUCTION_TARGET', message: refusal });
  if (summary.targetOrgId !== undefined && !sameRecord(summary.targetOrgId, org.id)) {
    refuseBeforeAnyRead(otherOrgRefusal(summary.targetOrgId));
  }
  /** The summary as given, when it said no window of its own: dated from its journal, if at all. */
  const undated = summary.result.writtenBetween === undefined ? summary : undefined;
  summary = await datedFromItsJournal(conn, summary);

  // Read only for a sweep, or its listing.
  const sweepTies = (): Promise<SweepTies> =>
    summarySweepTies(org.id, args.target, summary, created, earlier, ofTheRun);

  if (args.sweepList) {
    // What a sweep would delete, read and said; nothing is deleted, the
    // run's own records included.
    const listing = await listSweep(
      sweepOrgOf(conn, 'sandforge-clone --sweep-list'),
      await cliSweepInput(conn, args.target, summary, created, await sweepTies(), {
        ofTheRun,
      }),
      earlier?.removalSpans ?? [],
    );
    // Read before a sweep, with what --sweep-late and --sweep-untied would
    // take: on stderr with --json, stdout carrying the listing alone. Said
    // only without it, a list read before a sweep lost the warning that what
    // a person made by hand as the run's user reads as the automation's.
    for (const line of sweepListingLines(listing, args.target, args, true)) say(line);
    for (const line of otherPartsSweepLines(ofTheRun, listing)) say(line);
    if (args.json) {
      process.stdout.write(
        JSON.stringify(
          {
            tool: 'sandforge-clone',
            version: 1,
            action: 'sweep-list',
            summary: args.summaryPath,
            target: args.target,
            targetOrgId: org.id,
            listing,
            elapsedMs: elapsedSince(t0),
          },
          null,
          2,
        ) + '\n',
      );
    } else {
      console.log(`\ndone in ${elapsedSince(t0)}ms`);
    }
    // A list a sweep would be refused for ends as that sweep does: ending 0,
    // it read as an empty list to a script.
    if (listing.refusal !== undefined) process.exit(RECORDS_LEFT_EXIT);
    return;
  }
  const runUserId = summary.result.runUserId;

  // Ctrl-C stops the removal, or the sweep, before its next call to the org,
  // as Cancel does in the panel: an order the removal set to Draft for its
  // delete gets its status back on the way out, where a process killed
  // outright left it a draft. A SIGTERM or a SIGHUP stops it the same way.
  const stop = new AbortController();
  const interrupt = (): void => stop.abort();
  // The removal is said first; what the target runs as its records go is
  // asked about once the sweep has read what it takes, below.
  /** Whether the removal takes records of the run: this part's, or what another's left. */
  const takesRecords = plan.length > 0 || leftByOtherParts.length > 0;
  if (takesRecords) {
    sayThePlan();
  } else {
    say('nothing left of the run to remove');
  }

  // The sweep goes in three parts around the run's records, as the panel's
  // does (`sweepParts`): before them, what the target's automation made for
  // the run that neither goes with them nor waits for them — a record it hung
  // under one of them after the run's last write would otherwise hold it back
  // as a record that stays; with them, in cascade, what hangs from them; after
  // them, what one of them points at through a lookup the org restricts the
  // delete by, an asset a case of the run names. The removal makes the first
  // once it has read the run's records: a child it deletes under one of them
  // restamps that record when a roll-up counts it, which read afterwards was a
  // change since the run.
  const parts = args.sweep
    ? sweepParts(
        sweepOrgOf(conn, 'sandforge-clone --sweep', stop.signal),
        await cliSweepInput(conn, args.target, summary, created, await sweepTies(), {
          signal: stop.signal,
          ofTheRun,
        }),
        {
          includeChanged: args.includeChanged,
          // What the earlier removals of the run changed while they ran is no
          // change since the run.
          removalSpans: earlier?.removalSpans ?? [],
          ...sweepClassOptions(args),
          // What it found, said before the first delete: --sweep asked for it.
          approve: async (listing) => {
            sweepListing = listing;
            say('');
            for (const line of sweepListingLines(listing, args.target, args)) say(line);
            for (const line of otherPartsSweepLines(ofTheRun, listing)) say(line);
            return undefined;
          },
        },
      )
    : undefined;

  // The sweep reads what it takes and says it here, before the lease: the
  // lease is held for the deletes alone. It deletes at its turn.
  if (parts) {
    const releaseStop = onStopSignal(interrupt);
    try {
      await parts.ask();
    } finally {
      releaseStop();
    }
    const unsaid = sweepUnsaid(parts, sweepListing);
    if (unsaid) {
      sweepListing = unsaid;
      say('');
      for (const line of sweepListingLines(unsaid, args.target, args)) say(line);
      for (const line of otherPartsSweepLines(ofTheRun, unsaid)) say(line);
    }
  }

  // What the target runs as the records go is read on what the removal and
  // the sweep delete together, before the first delete and before the lease.
  // Read before the sweep, a Flow on an asset the run never wrote refused the
  // sweep's delete after the removal had said that nothing fired. A sweep that
  // goes alone asks too; a Ctrl-C during its read asks nothing.
  const sweptObjects = parts?.takes ?? [];
  if ((takesRecords || sweptObjects.length > 0) && !stop.signal.aborted) {
    await checkTheAutomation(sweptObjects);
  }

  // A Ctrl-C during the sweep stops the removal too; with nothing of the run
  // left, the sweep goes alone, under the lease as the removal's would.
  let outcome: RunRemovalOutcome | undefined;
  /** What the removals of what the run's other parts left took, after this part's. */
  const afterOwn: RunRemovalOutcome[] = [];
  if (takesRecords) {
    outcome = await removeThePlan();
    // Stopped before its first delete, for objects the user may not delete:
    // nothing was removed.
    if (outcome.stoppedForUndeletable) {
      if (undeletableRefused) endRefused(undeletableRefused);
      process.exit(1);
    }
  } else if (parts) {
    const held = await takeTheLease();
    const releaseStop = onStopSignal(interrupt);
    try {
      await parts.first();
      await parts.afterRemoval();
    } finally {
      releaseStop();
      if (held) {
        mutedAutomation = await held.release();
        for (const line of muteLines(mutedAutomation, args.target)) say(line);
      }
    }
  }
  const sweep = parts?.result();
  if (sweep) {
    recordCliRun(args.audit, audited, {
      action: 'cleanup_delete',
      module: 'forge',
      operationId: `${operationId}-sweep`,
      orgId: org.id,
      outcome: sweep.status === 'refused' ? 'stopped' : sweep.status,
      ...(sweep.status === 'refused' ? { code: 'SWEEP_REFUSED' } : {}),
      objects: sweepAuditObjects(sweep),
      details: sweepAuditDetails(sweep, run),
      // A sweep alone has no entry of the removal's to name its mute.
      ...(!takesRecords && mutedAutomation ? { muted: auditMutedOf(mutedAutomation) } : {}),
    });
  }

  /** What the run would remove said, and what earlier removals left that it does not read as a change. */
  function sayThePlan(): void {
    for (const line of removalPlanLines(summary, plan, args)) say(line);
    for (const line of partsLeftLines(leftByOtherParts)) say(line);
    if (ownEarlier) {
      say(
        `what earlier removals of this summary left on the run's records, read from ` +
          `${removalsFile}, is not a change since the run`,
      );
    } else if (otherRun) {
      say(
        `${removalsFile} is of another run: it is not read, and what this removal leaves on ` +
          'the records, if anything, takes its place',
      );
    }
    if (ofTheRun?.earlier) {
      say(
        `what the removals of the run's other part or of its journal left on its records, read ` +
          `from ${ofTheRun.file}, is no change since the run`,
      );
    }
  }

  /**
   * What the target runs as the records go, said before the first delete, and
   * asked as the clone asks about what fires as it inserts: a removal deletes,
   * and what runs before or after a delete runs then, with what fires as an
   * activated order is set back to Draft for its delete.
   *
   * @param swept - The objects the sweep deletes records of, read with the
   *   run's own; it sets none of them back to Draft. So are the copies the
   *   platform made of the run's lines on an object the run never wrote,
   *   which the removal takes with its own.
   */
  /**
   * End the removal refused before its first delete, as a refused run ends:
   * its line names its code, and with --json stdout carries it. Refused for a
   * production org, what fires as it deletes, its mute or objects its user
   * may not delete, it said a sentence on stderr and left stdout empty.
   */
  function endRefused(refused: RunRefusal): never {
    recordRemoval({ outcome: 'stopped', code: refused.code });
    return refuseBeforeAnyRead(refused);
  }

  /**
   * End the removal refused, its line and, with --json, stdout naming its
   * code, with no entry in the audit trail: refused for another org than the
   * one the run wrote to, it deleted nothing from either and reads nothing
   * of the run. It said a sentence on stderr and left stdout empty.
   */
  function refuseBeforeAnyRead(refused: RunRefusal): never {
    process.stderr.write(`${refusedLine(refused)}\n`);
    if (args.json) {
      process.stdout.write(
        refusedRemovalSummary(
          {
            tool: 'sandforge-clone',
            summary: args.summaryPath,
            target: args.target,
            elapsedMs: elapsedSince(t0),
          },
          refused,
        ),
      );
    }
    return process.exit(1);
  }

  /** Why the removal is refused when the org is not the one the run wrote to. */
  function otherOrgRefusal(wroteTo: string): RunRefusal {
    return {
      code: OTHER_ORG,
      message:
        `${args.target} is not the org the run wrote to (${wroteTo}), and its records are ` +
        'removed from that org only. Nothing was deleted.',
    };
  }

  async function checkTheAutomation(swept: readonly string[]): Promise<void> {
    const runObjects = [
      ...new Set(
        [...plan, ...leftByOtherParts.flatMap((left) => left.plan)].map(
          (object) => object.objectApiName,
        ),
      ),
    ];
    const removed = [...new Set([...objectsRemovedOf(runObjects), ...swept])];
    const drafted = setBackToDraftOf(runObjects);
    const read = await targetAutomationReader(conn).read(args.target, removed);
    say('');
    for (const line of removalAutomationLines(read, args.target, removed.length, drafted)) {
      say(line);
    }
    // Asked to mute, the removal plans it from what it read, and asks only
    // for what still runs; refused, it deletes nothing.
    if (args.muteAutomation) {
      const draftedSet = new Set(drafted);
      try {
        removalMute = await muteForRun(async () => muteOrgOf(conn), read, {
          writes: (objectApiName, write) =>
            write === 'delete' || (write === 'update' && draftedSet.has(objectApiName)),
        });
        mutedAutomation = removalMute.muted;
        for (const line of muteLines(removalMute.muted, args.target)) say(`  ${line}`);
      } catch (err: unknown) {
        if (!isMuteRefusedError(err)) throw err;
        endRefused(err.refusal);
      }
    }
    const automation = removalMute?.automation ?? read;
    const automationStop = removalAutomationRefusal(automation, args.target, {
      drafted,
      // The sets that keep it quiet, which --mute-automation assigns under a
      // lease: never a command assigning them by hand, with the user's name.
      assign: bypassesToAssign(automation, removalBypassesOf(automation, drafted)),
      // Relayed by a command that does not mute, the mute is not offered.
      mayMute: removalMute === undefined && relayTakes('--mute-automation'),
    });
    if (automationStop && !args.acceptAutomation) {
      endRefused({ code: 'AUTOMATION_NOT_ACCEPTED', message: automationStop });
    }
  }

  /**
   * The mute's lease, taken before the first delete and given back as the
   * removal ends, whatever it ended on; none once a stop came, or for a
   * removal that mutes nothing. Refused, nothing is deleted.
   */
  async function takeTheLease() {
    const held =
      removalMute?.prepared && !stop.signal.aborted
        ? await removalMute.prepared
            .acquire(`sandforge-clone --remove ${operationId}`)
            .catch((err: unknown) => {
              if (!isMuteRefusedError(err)) throw err;
              return endRefused(err.refusal);
            })
        : undefined;
    if (held) mutedAutomation = held.outcome;
    return held;
  }

  /** The removal of what is left of the run, its sweep first, recorded as it always was. */
  async function removeThePlan(): Promise<RunRemovalOutcome> {
    // The lease, taken right before the first write, once every question is
    // answered: the removal asks what to do of the records its user may not
    // delete once it has read them, and a lease taken before it kept the sets
    // assigned while the question stayed open, for nothing once it was answered
    // no. A stop before then assigns nothing.
    let held: HeldMute | undefined;
    const releaseStop = onStopSignal(interrupt);
    const span = summary.result.writtenBetween;
    // The run's span as the target dated it, as the wizard passes a history
    // entry's. A run the target did not date is dated by its records and by
    // when it ended, read on the org's clock as the removal starts.
    const runSpan = span
      ? { runStartedAt: new Date(span.first), runEndedAt: new Date(span.last) }
      : {
          runDurationMs: summary.elapsedMs,
          ...(summary.finishedAt ? { runRecordedAt: new Date(summary.finishedAt) } : {}),
        };
    let removal: RunRemovalOutcome = NOTHING_REMOVED;
    /** What it took up of each other part's records an earlier removal of that part left. */
    const ofOtherParts: Array<{ part: number; objects: ForgeUndoObjectResult[] }> = [];
    const onUndeletable = undeletableAnswer(args.leaveUndeletable, args.target, (refused) => {
      undeletableRefused = refused;
    });
    // Of the journal of a run in parts, its last part first, against its own
    // span; the parts before it then, each against its own.
    const [first, ...partsBefore] = byParts ?? [];
    const runParts = ofTheRun ?? (first ? wholeRun : undefined);
    const firstPart = ofTheRun?.part ?? first?.part.part;
    // Of a run cut and taken up, its other parts, read before the first write:
    // what this part's deletes restamp of their records is the run's doing.
    const alongside =
      runParts && firstPart !== undefined
        ? otherPartsOf(runParts, firstPart, earlier?.removalStamps ?? {})
        : [];
    const laterParts =
      runParts && firstPart !== undefined ? laterPartsOf(runParts.parts, firstPart) : [];
    // The sizes the deletes go at and the smaller calls a limit may cost,
    // shared by every part's removal and the first part's sweep: a size a
    // limit taught one part holds for the rest, within one bound of 2 000
    // for the whole removal and 500 per object, as the panel's single
    // removal keeps them.
    const removalSizes = new CallSizes();
    const removalAllowance = new SplitAllowance(RUN_SPLIT_CALLS);
    try {
      if (plan.length > 0) {
        const firstPlan = first ? first.plan : plan;
        removal = await removeRunRecords(removalOrg(conn, 'sandforge-clone --remove'), firstPlan, {
          ...((first && machineSpanOf(first.part)) ?? runSpan),
          ...(earlier
            ? {
                removalStamps: earlier.removalStamps,
                removalSpans: earlier.removalSpans,
              }
            : {}),
          ...sweepPartsOptions(parts),
          callSizes: removalSizes,
          allowance: removalAllowance,
          ...(runUserId ? { runUserId } : {}),
          ...(laterParts.length > 0 ? { laterParts } : {}),
          ...(alongside.length > 0
            ? { otherParts: alongside.map((other) => other.alongside) }
            : {}),
          includeChanged: args.includeChanged,
          onUndeletable,
          beforeFirstWrite: async () => {
            held = await takeTheLease();
          },
          signal: stop.signal,
        });
      } else {
        held = await takeTheLease();
      }
      // Then what earlier removals of the run's other parts left, each part
      // read against its own span, as its own removal reads it, and told what
      // this one wrote: with this part's records gone, nothing of the run
      // holds them any more.
      const stamped: Record<string, string> = { ...earlier?.removalStamps, ...removal.stamps };
      for (const stamps of removal.otherPartStamps ?? []) Object.assign(stamped, stamps);
      // Each part's records this removal takes: one of another part that
      // stays under a record of this one is the run's own, not what the
      // target's automation made for the run.
      const takenByPart = [
        ...(firstPart !== undefined ? [{ part: firstPart, plan: first ? first.plan : plan }] : []),
        ...[...partsBefore, ...leftByOtherParts].map((left) => ({
          part: left.part.part,
          plan: left.plan,
        })),
      ];
      for (const { part, plan: left } of [...partsBefore, ...leftByOtherParts]) {
        if (removal.stoppedForUndeletable || removal.cancelled || stop.signal.aborted) break;
        // A part of the journal whose lines say no end is read over the run's
        // whole window, as the journal was before it was read part by part.
        const partSpan = machineSpanOf(part) ?? (first ? runSpan : undefined);
        if (!partSpan) continue;
        const spans = spansOf(
          earlier?.removalSpans,
          [removal, ...afterOwn].flatMap((done) => (done.span ? [done.span] : [])),
        );
        const later = laterPartsOf(runParts?.parts ?? [], part.part);
        const taken = await removeRunRecords(removalOrg(conn, 'sandforge-clone --remove'), left, {
          ...partSpan,
          removalStamps: stamped,
          removalSpans: spans,
          callSizes: removalSizes,
          allowance: removalAllowance,
          ...(runUserId ? { runUserId } : {}),
          ...(later.length > 0 ? { laterParts: later } : {}),
          otherPartRecords: takenByPart.flatMap((taken) =>
            taken.part === part.part ? [] : taken.plan,
          ),
          includeChanged: args.includeChanged,
          onUndeletable,
          signal: stop.signal,
        });
        Object.assign(stamped, taken.stamps);
        afterOwn.push(taken);
        if (ofTheRun) ofOtherParts.push({ part: part.part, objects: taken.objects });
      }
    } finally {
      releaseStop();
      if (held) {
        mutedAutomation = await held.release();
        for (const line of muteLines(mutedAutomation, args.target)) say(line);
      }
    }
    if (ofOtherParts.length > 0) byPart = { own: removal.objects, others: ofOtherParts };
    if (removal.stoppedForUndeletable) return removal;
    // A removal after an earlier one of the summary takes what that one left,
    // as the panel records it: with when that one ended, by the org's clock.
    const leftBy = earlier?.removalSpans.at(-1)?.last;
    const objects = mergedUndoObjects(removal.objects, ...afterOwn.map((done) => done.objects));
    const cancelled = removal.cancelled || afterOwn.some((done) => done.cancelled);
    recordRemoval({
      outcome: removalAuditOutcome({ status: removalStatus(objects, cancelled) }),
      objects: removalAuditObjects(objects),
      ...(leftBy ? { leftBy } : {}),
    });
    return removal;
  }

  // Kept beside the summary whatever the removal ended on, cancelled
  // included, as the wizard adds it to the run's history. A file that cannot
  // be written is said, and the removal's own outcome stands: the next one may
  // then read what this one wrote as changes since the run.
  const swept = sweep && sweepMarkOf(sweep, new Date().toISOString(), earlier?.sweep);
  const removals = removalsAfter(
    run,
    earlier,
    outcome && byParts ? removalsOfParts([outcome, ...afterOwn]) : (outcome ?? { stamps: {} }),
    plan,
    swept,
    parts?.made ?? [],
    parts?.late ?? [],
    parts?.gone ?? [],
  );
  // The journal's own removal asks for every part of the run, as one.
  if (removals && inParts && !ofTheRun) {
    removals.partsRemoved = inParts.parts.map((part) => part.part);
  }
  const failure = removals ? writeWhole(removalsFile, removals) : undefined;
  if (failure) {
    process.stderr.write(
      `What this removal left on the run's records could not be kept in ${removalsFile} ` +
        `(${failure}): a later --remove of this summary may keep a record this removal wrote ` +
        'to as changed since the run, which --include-changed then takes.\n',
    );
  }
  // Of a run cut and taken up, what this removal took and left is kept beside
  // the run's journal too, for the removals of its other parts and of the
  // journal: what this part's deletes restamped of another part's records is
  // what the removal of that part reads as no change since the run.
  if (ofTheRun?.part !== undefined && outcome && !outcome.stoppedForUndeletable) {
    const done = [outcome, ...afterOwn];
    const stamps: Record<string, string> = {};
    for (const one of done) {
      for (const each of [one.stamps, ...(one.otherPartStamps ?? [])]) Object.assign(stamps, each);
    }
    const ofTheRunNow = runRemovalsAfter(ofTheRun, {
      stamps,
      spans: done.flatMap((one) => (one.span ? [one.span] : [])),
      gone: done.flatMap((one) => one.gone),
      parts: [ofTheRun.part, ...leftByOtherParts.map((left) => left.part.part)],
    });
    const notKept = ofTheRunNow ? writeWhole(ofTheRun.file, ofTheRunNow) : undefined;
    if (notKept) {
      process.stderr.write(
        `What this removal left on the run's records could not be kept in ${ofTheRun.file} ` +
          `(${notKept}): a later --remove of the run's other part or of its journal may keep a ` +
          'record this removal wrote to as changed since the run, which --include-changed then ' +
          'takes.\n',
      );
    }
  }
  const objects = mergedUndoObjects(
    outcome?.objects ?? [],
    ...afterOwn.map((done) => done.objects),
  );
  const cancelled = outcome?.cancelled === true || afterOwn.some((done) => done.cancelled);
  const status = removalStatusWithSweep(
    outcome ? removalStatus(objects, cancelled) : 'success',
    sweep,
  );
  if (ofTheRun?.part !== undefined) keptForParts = heldByOtherParts(ofTheRun, objects);
  // A run the target dated only by the records its journal names, or never:
  // read again once they went, a sweep of it may have no window to look in.
  if (undated && !args.sweep && objects.some((object) => (object.heldByAutomation ?? 0) > 0)) {
    windowUntold = (await datedFromItsJournal(conn, undated)).result.writtenBetween === undefined;
  }
  output(status, objects, org.id, removals && !failure ? removalsFile : undefined, sweep);
  if (status !== 'success') process.exit(RECORDS_LEFT_EXIT);
}

// ─── --remove --preview ──────────────────────────────────────────────────────

/** What `--remove --preview` says a removal of the run would do. */
export interface CloneRemovalPreview {
  /** The run's records a removal would set out to take. */
  planned: number;
  /** Per object, in the order a removal would take them: children before their parents. */
  objects: RemovalPreviewObject[];
  /** The objects whose records the user may not delete, with how many are in the org. */
  undeletable?: UndeletableObject[];
  /** The names of the users who changed records of the run since, by user Id. */
  userNames: Record<string, string>;
}

/**
 * What a preview never reads, said with each: what the target's automation
 * does as the records go, and what hangs from them, which a removal reads
 * record by record at each object's turn.
 */
export const CLONE_PREVIEW_UNREAD =
  "not read by a preview: what the target's automation does as the records go — a trigger " +
  'or a flow that deletes, keeps or creates other records — and what hangs from them, which a ' +
  'removal reads at each object’s turn: a record kept for records that stay is counted with ' +
  'those to delete';

/** What `--remove --preview --json` prints: one JSON document, alone on stdout. Exported so it can be tested. */
export function clonePreviewJson(answer: {
  summary: string;
  target: string;
  targetOrgId?: string;
  includeChanged: boolean;
  preview: CloneRemovalPreview;
  /**
   * What a removal run now would be refused for, each in its own words under
   * `refusals`, and beside them, in their order, the code a removal is
   * refused with under `refusalCodes`.
   */
  refusals: readonly RunRefusal[];
  notes: readonly string[];
  elapsedMs: number;
  /** With `--sweep`, what the sweep would take, as `--sweep-list` lists it. */
  sweepListing?: ForgeSweepListing;
}): string {
  return `${JSON.stringify(
    {
      tool: 'sandforge-clone',
      version: 1,
      action: 'remove-preview',
      summary: answer.summary,
      target: answer.target,
      ...(answer.targetOrgId !== undefined ? { targetOrgId: answer.targetOrgId } : {}),
      includeChanged: answer.includeChanged,
      preview: answer.preview,
      ...(answer.sweepListing ? { sweepListing: answer.sweepListing } : {}),
      refusals: answer.refusals.map(({ message }) => message),
      refusalCodes: answer.refusals.map(({ code }) => code),
      notes: answer.notes,
      elapsedMs: answer.elapsedMs,
    },
    null,
    2,
  )}\n`;
}

/** What `--remove --preview` prints without `--json`. Exported so it can be tested. */
export function clonePreviewLines(
  preview: CloneRemovalPreview,
  refusals: readonly RunRefusal[],
  notes: readonly string[],
  includeChanged: boolean,
): string[] {
  const named = (userId: string): string => preview.userNames[userId] ?? userId;
  const lines = ['preview: what a removal would do; nothing was written'];
  for (const o of preview.objects) {
    const counts = [
      o.toDelete > 0 ? `${o.toDelete} to delete` : '',
      includeChanged && o.changedSince > 0 ? `${o.changedSince} of them changed since the run` : '',
      o.alreadyGone > 0 ? `${o.alreadyGone} gone already` : '',
      o.notVisible > 0 ? `${o.notVisible} not visible` : '',
      o.keptChanged > 0 ? `${o.keptChanged} kept, changed since the run` : '',
      o.undeletable > 0 ? `${o.undeletable} left, the user may not delete them` : '',
      o.unread > 0 ? `${o.unread} left, not read` : '',
    ].filter(Boolean);
    lines.push(
      `  ${o.objectApiName}: ${counts.join(', ') || 'nothing'} of ${o.planned}${platformCopiesWords(o)}`,
    );
    const by = Object.entries(o.changedBy).sort((a, b) => b[1] - a[1]);
    if (by.length > 0) {
      lines.push(
        `      last changed by: ${by.map(([userId, n]) => `${named(userId)} ${n}`).join(' · ')}`,
      );
    }
    for (const reason of o.reasons) lines.push(`      ${reason}`);
  }
  for (const refusal of refusals) lines.push(wouldBeRefusedLine(refusal, 'a removal'));
  return [...lines, ...notes];
}

/**
 * Say what a removal of the run would do, and do nothing (`--preview`): the
 * removal's own reading of the run's records before its first write
 * (`removeRunRecords` with `previewOnly`), what the target runs as they go,
 * and what a removal would be refused for, each under the code the removal
 * is refused with — a production org, another org than the one the run
 * wrote to, that automation without `--accept-automation`, objects the user
 * may not delete without `--leave-undeletable`. Nothing is written: not to
 * the org, not to the run's journal, whose calls under way when the run
 * stopped a removal looks for in the target first, not beside the summary;
 * and nothing is asked. A preview only reads, so a production org is read
 * and the refusal a removal would meet is said; an org that is not the one
 * the run wrote to is refused, exit 1, as the removal refuses it, under
 * `OTHER_ORG`.
 *
 * With `--sweep`, what the sweep would take is listed as `--sweep-list` lists
 * it, and what fires as its records go is read with the run's own: previewed
 * without it, `sandforge-env destroy --sweep` blocked nothing, and the
 * removal then refused the sweep's automation, the destroy stopped part way.
 */
async function previewRemoval(
  args: RemoveArgs,
  read: RunSummary,
  say: (line: string) => void,
  t0: number,
): Promise<void> {
  let summary = read;
  const notes: string[] = [];
  /** With --sweep, what the sweep would take, once read. */
  let sweepListing: ForgeSweepListing | undefined;
  const answer = (
    preview: CloneRemovalPreview,
    refusals: readonly RunRefusal[],
    orgId?: string,
  ) => {
    notes.push(CLONE_PREVIEW_UNREAD);
    if (args.json) {
      process.stdout.write(
        clonePreviewJson({
          summary: args.summaryPath,
          target: args.target,
          ...(orgId !== undefined ? { targetOrgId: orgId } : {}),
          includeChanged: args.includeChanged,
          preview,
          refusals,
          notes,
          elapsedMs: elapsedSince(t0),
          ...(sweepListing ? { sweepListing } : {}),
        }),
      );
      return;
    }
    say('');
    for (const line of clonePreviewLines(preview, refusals, notes, args.includeChanged)) say(line);
    say(`\ndone in ${elapsedSince(t0)}ms`);
  };

  say(`sandforge-clone --remove  ${args.summaryPath}  --preview  of ${args.target}`);
  if (summary.targetOrgId === undefined && summary.target !== args.target) {
    process.stderr.write(
      `The run wrote to ${summary.target}, and its records are read in that org only: ` +
        `give --target ${summary.target}.\n`,
    );
    process.exit(2);
  }
  const journalOfRun = summary.journal;
  if (
    journalOfRun !== undefined &&
    existsSync(journalOfRun) &&
    nodeRunJournal(journalDirOf()).callsInFlightAt(journalOfRun) > 0
  ) {
    notes.push(
      "the run's journal names calls under way when it stopped: a removal looks for their rows " +
        'in the target first and removes those it finds with the rest; this preview counts only ' +
        'what the summary names',
    );
  }
  const unreachable = (summary.result.mayHaveBeenWritten ?? []).reduce(
    (sum, { sourceIds }) => sum + sourceIds.length,
    0,
  );
  if (unreachable > 0) {
    notes.push(
      `${unreachable} record(s) a call of the run may have written before its answer was lost ` +
        'may be in the org, under ids the run never learned: no removal reaches them',
    );
  }
  const created = removalPlan(summary);
  if (created.length === 0) {
    notes.push('The run created no record: there is nothing of it to remove.');
    answer({ planned: 0, objects: [], userNames: {} }, []);
    return;
  }
  // What earlier removals of the summary took, and left on the run's records:
  // read, never written, as the removal reads it before its first delete.
  const removalsFile = removalsPath(args.summaryPath);
  let removalsText: string | undefined;
  try {
    removalsText = readFileSync(removalsFile, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
      process.stderr.write(
        `${removalsFile} cannot be read: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(2);
    }
  }
  const before = readEarlierRemovals(removalsText, runKey(created));
  if ('refusal' in before) {
    process.stderr.write(`${removalsFile} ${before.refusal}\n`);
    process.exit(2);
  }
  // A run cut and taken up: what the removals of its other parts, and of its
  // journal, left is read as the removal reads it.
  const inParts = await runInPartsOf(summary);
  if (inParts && 'refusal' in inParts) {
    process.stderr.write(`${inParts.refusal}\n`);
    process.exit(2);
  }
  const ofTheRun =
    inParts && resolvePath(removalsFile) !== resolvePath(inParts.file) ? inParts : undefined;
  const earlier = earlierOfTheRun(before.earlier, ofTheRun?.earlier);
  const ownPlan = forgeRemovalPlanLeft({
    objects: created,
    removalLeft: before.earlier?.removalLeft,
  });
  const plan = stillLeft(ownPlan, ofTheRun?.earlier?.removalLeft);
  const leftByOtherParts = ofTheRun ? partsLeft(ofTheRun) : [];
  const count = (objects: readonly ForgeRunObjectRecords[]): number =>
    objects.reduce((sum, object) => sum + object.ids.length, 0);
  if (count(created) > count(ownPlan)) {
    notes.push(
      `${count(created) - count(ownPlan)} record(s) removed by an earlier --remove of this summary`,
    );
  }
  if (count(ownPlan) > count(plan)) {
    notes.push(
      `${count(ownPlan) - count(plan)} record(s) removed by an earlier --remove of the run's ` +
        'other part or of its journal',
    );
  }
  for (const { part, plan: left } of leftByOtherParts) {
    notes.push(
      `with them, ${count(left)} record(s) of the run's part ${part.part} an earlier --remove ` +
        'of that part left, read against that part, once these are gone',
    );
  }
  // A sweep still has the run's window to look in.
  if (plan.length === 0 && leftByOtherParts.length === 0 && !args.sweep) {
    notes.push('nothing left of the run to remove');
    answer({ planned: 0, objects: [], userNames: {} }, []);
    return;
  }

  const session = await loadOrg(args.target);
  const conn = makeConn(session);
  const org = await typeOrg(conn);
  if (summary.targetOrgId !== undefined && !sameRecord(summary.targetOrgId, org.id)) {
    const refused = {
      code: OTHER_ORG,
      message:
        `${args.target} is not the org the run wrote to (${summary.targetOrgId}): its records ` +
        'are read in that org only. Nothing of the run was read.',
    };
    process.stderr.write(`${refusedLine(refused)}\n`);
    if (args.json) {
      process.stdout.write(
        refusedRemovalSummary(
          {
            tool: 'sandforge-clone',
            action: 'remove-preview',
            summary: args.summaryPath,
            target: args.target,
            elapsedMs: elapsedSince(t0),
          },
          refused,
        ),
      );
    }
    process.exit(1);
  }
  const refusals: RunRefusal[] = [];
  const production = productionRefusal(args.target, org, 'remove');
  if (production) refusals.push({ code: 'PRODUCTION_TARGET', message: production });
  summary = await datedFromItsJournal(conn, summary);
  // With --sweep, what it would take, listed as the removal lists it before
  // its first delete; nothing is deleted.
  if (args.sweep) {
    sweepListing = await listSweep(
      sweepOrgOf(conn, 'sandforge-clone --remove --preview --sweep'),
      await cliSweepInput(
        conn,
        args.target,
        summary,
        created,
        await summarySweepTies(org.id, args.target, summary, created, earlier, ofTheRun),
        { ofTheRun },
      ),
      earlier?.removalSpans ?? [],
    );
    say('');
    for (const line of sweepListingLines(sweepListing, args.target, args, true)) say(line);
    for (const line of otherPartsSweepLines(ofTheRun, sweepListing)) say(line);
  }
  // What the target runs as a removal takes the run back, and as its sweep
  // deletes, read and said as the removal says it before its first delete.
  const runObjects = [
    ...new Set(
      [...plan, ...leftByOtherParts.flatMap((left) => left.plan)].map(
        (object) => object.objectApiName,
      ),
    ),
  ];
  const swept = sweepListing ? sweepTakenObjects(sweepListing, args) : [];
  const removed = [...new Set([...objectsRemovedOf(runObjects), ...swept])];
  const drafted = setBackToDraftOf(runObjects);
  const automation = await targetAutomationReader(conn).read(args.target, removed);
  say('');
  for (const line of removalAutomationLines(automation, args.target, removed.length, drafted)) {
    say(line);
  }
  const automationStop = removalAutomationRefusal(automation, args.target, {
    drafted,
    assign: bypassesToAssign(automation, removalBypassesOf(automation, drafted)),
    mayMute: !args.muteAutomation && relayTakes('--mute-automation'),
  });
  if (automationStop && !args.acceptAutomation) {
    refusals.push({ code: 'AUTOMATION_NOT_ACCEPTED', message: automationStop });
  }
  // Nothing of the run left, the sweep goes alone.
  if (plan.length === 0 && leftByOtherParts.length === 0) {
    notes.push('nothing left of the run to remove');
    answer({ planned: 0, objects: [], userNames: {} }, refusals, org.id);
    return;
  }

  // Ctrl-C stops the reads before the next one; nothing is said of a preview
  // stopped part way.
  const stop = new AbortController();
  let stoppedBy: StopSignal | undefined;
  const releaseStop = onStopSignal((signal) => {
    stoppedBy = signal;
    stop.abort();
  });
  const span = summary.result.writtenBetween;
  const runSpan = span
    ? { runStartedAt: new Date(span.first), runEndedAt: new Date(span.last) }
    : {
        runDurationMs: summary.elapsedMs,
        ...(summary.finishedAt ? { runRecordedAt: new Date(summary.finishedAt) } : {}),
      };
  let outcome: RunRemovalOutcome;
  /** What the previews of what the run's other parts left say, after this part's. */
  const afterOwn: RunRemovalOutcome[] = [];
  // The journal of a run cut and taken up, read whole: each part against its
  // own span, the last first, as its removal reads it.
  const [first, ...partsBefore] = (inParts && !ofTheRun ? journalPartsOf(inParts, plan) : []) ?? [];
  const runParts = ofTheRun ?? (first ? inParts : undefined);
  const firstPart = ofTheRun?.part ?? first?.part.part;
  const laterParts =
    runParts && firstPart !== undefined ? laterPartsOf(runParts.parts, firstPart) : [];
  try {
    outcome = await removeRunRecords(
      removalOrg(conn, 'sandforge-clone --remove --preview'),
      first ? first.plan : plan,
      {
        ...((first && machineSpanOf(first.part)) ?? runSpan),
        ...(earlier
          ? { removalStamps: earlier.removalStamps, removalSpans: earlier.removalSpans }
          : {}),
        ...(laterParts.length > 0 ? { laterParts } : {}),
        includeChanged: args.includeChanged,
        previewOnly: true,
        signal: stop.signal,
      },
    );
    for (const { part, plan: left } of [...partsBefore, ...leftByOtherParts]) {
      const partSpan = machineSpanOf(part) ?? (first ? runSpan : undefined);
      if (!partSpan || !outcome.preview || stop.signal.aborted) continue;
      const later = laterPartsOf(runParts?.parts ?? [], part.part);
      afterOwn.push(
        await removeRunRecords(removalOrg(conn, 'sandforge-clone --remove --preview'), left, {
          ...partSpan,
          ...(earlier
            ? { removalStamps: earlier.removalStamps, removalSpans: earlier.removalSpans }
            : {}),
          ...(later.length > 0 ? { laterParts: later } : {}),
          includeChanged: args.includeChanged,
          previewOnly: true,
          signal: stop.signal,
        }),
      );
    }
  } finally {
    releaseStop();
  }
  const preview =
    outcome.preview && afterOwn.every((done) => done.preview)
      ? {
          objects: mergedPreviewObjects(
            outcome.preview.objects,
            ...afterOwn.map((done) => done.preview?.objects ?? []),
          ),
          userNames: Object.assign(
            {},
            outcome.preview.userNames,
            ...afterOwn.map((done) => done.preview?.userNames ?? {}),
          ) as Record<string, string>,
        }
      : undefined;
  if (!preview) {
    process.stderr.write(
      'interrupted: the preview stopped before it was through, and wrote nothing\n',
    );
    process.exit(stopExitCode(stoppedBy ?? 'SIGINT'));
  }
  const undeletable = [outcome, ...afterOwn].flatMap((done) => done.undeletable ?? []);
  if (undeletable.length > 0 && !args.leaveUndeletable) {
    const named = undeletable.map((o) => `${o.objectApiName} (${o.records} records)`).join(', ');
    refusals.push({
      code: UNDELETABLE_NOT_LEFT,
      message:
        `The user SandForge connects as may not delete the records of ${named} in ` +
        `${args.target}: a removal stops before its first delete, unless given ` +
        '--leave-undeletable, which removes the rest and leaves those.',
    });
  }
  answer(
    {
      planned: count(plan) + leftByOtherParts.reduce((sum, left) => sum + count(left.plan), 0),
      objects: preview.objects,
      ...(undeletable.length > 0 ? { undeletable } : {}),
      userNames: preview.userNames,
    },
    refusals,
    org.id,
  );
}

/**
 * A summary taken from a run's journal alone, dated as the target dated the
 * run's writes (`writtenBetween`, read by `ForgeRunJournal.writtenBetweenAt`,
 * as the panel dates a run a closed window stopped): from when the first
 * record its journal says it created was created to its last write — the last
 * record it created, or, later, the last it wrote to since, a lookup the
 * second pass filled in or a status given back, as that record was last
 * modified, no later than the journal's last line allows. Built from the
 * journal, a summary said no window, and `--remove <journal> --sweep` was
 * refused for want of one. A summary that says its window, or whose journal
 * names no record the target still holds, is left as it is. Exported so it
 * can be tested.
 */
export async function datedFromItsJournal(
  conn: Pick<Connection, 'query'>,
  summary: RunSummary,
  journals: ForgeRunJournal = nodeRunJournal(journalDirOf()),
): Promise<RunSummary> {
  if (summary.result.writtenBetween || summary.journal === undefined) return summary;
  if (!existsSync(summary.journal)) return summary;
  const writtenBetween = await journals.writtenBetweenAt(summary.journal, conn);
  if (!writtenBetween) return summary;
  return { ...summary, result: { ...summary.result, writtenBetween } };
}

/** Whether two ids name the same record, whichever length each is written in. */
function sameRecord(a: string, b: string): boolean {
  return a.slice(0, 15) === b.slice(0, 15);
}

/** What `--verify` was given. */
export interface VerifyArgs {
  /** The summary a run printed with `--json`, saved to a file. */
  summaryPath: string;
  /** sf CLI alias of the org the run wrote to. */
  target: string;
  /** sf CLI alias of the org the run read from; absent, the summary's. */
  source: string | undefined;
  /** Print the verification as JSON on stdout, and every other line on stderr. */
  json: boolean;
  /** The file the verification's entry in the audit trail goes to; undefined = no entry. */
  audit: string | undefined;
}

/** The flags a verification reads. */
const VERIFY_FLAGS: ReadonlySet<string> = new Set([
  '--verify',
  '--target',
  '--source',
  '--json',
  '--audit',
]);

/** The flags of a verification that take a value. */
const VERIFY_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--verify',
  '--target',
  '--source',
  '--audit',
]);

/**
 * The command line of a verification read and checked; exits on `--help` or
 * a bad flag. A flag of the clone or of a removal is refused rather than
 * ignored: `--include-changed` beside `--verify` would read as a removal.
 * Exported so it can be tested.
 */
export function parseVerifyArgs(argv: string[]): VerifyArgs {
  const args = argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    const value = i >= 0 ? args[i + 1] : undefined;
    return value !== undefined && !value.startsWith('--') ? value : undefined;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (VERIFY_VALUE_FLAGS.has(arg)) {
      if (args[i + 1] !== undefined && !args[i + 1].startsWith('--')) i++;
      continue;
    }
    if (!VERIFY_FLAGS.has(arg)) {
      process.stderr.write(
        `--verify takes --target, --source, --json and --audit, not "${arg}". Run with --help for usage.\n`,
      );
      process.exit(2);
    }
  }
  const summaryPath = get('--verify');
  const target = get('--target');
  if (!summaryPath || !target || (args.includes('--source') && !get('--source'))) {
    process.stderr.write(
      '--verify takes the file a run printed its --json summary to, --target the org the run ' +
        'wrote to, and --source, when given, the org it read from. Run with --help for usage.\n',
    );
    process.exit(2);
  }
  return {
    summaryPath,
    target,
    source: get('--source'),
    json: args.includes('--json'),
    audit: auditArg(args),
  };
}

/**
 * The rows a run wrote again without the fields the target refused, as its
 * summary names them: read apart from what a removal reads, and nothing from
 * a summary that names none or names them otherwise.
 */
const writtenWithoutSchema = z.object({
  result: z.object({
    writtenWithoutFields: z.array(
      z.object({
        objectApiName: z.string().regex(API_NAME_RE),
        fields: z.array(z.object({ field: z.string().regex(API_NAME_RE) })),
      }),
    ),
  }),
});

/**
 * The lookups a run left empty on a lookup filter's refusal, by record, as
 * its summary names them: read apart from what a removal reads, and nothing
 * from a summary that names none or names them otherwise.
 */
const leftEmptySchema = z.object({
  result: z.object({
    lookupsLeftEmptyByFilter: z.array(
      z.object({
        objectApiName: z.string().regex(API_NAME_RE),
        field: z.string().regex(API_NAME_RE),
        records: z.number().int().nonnegative(),
        recordIds: z.array(summaryIdSchema),
      }),
    ),
  }),
});

/** The exit code each verdict leaves. */
const VERDICT_EXIT: Readonly<Record<ForgeRunVerification['verdict'], number>> = {
  verified: 0,
  partial: 3,
  unstable: 4,
};

/**
 * What a verification found, as the command says it: the verdict and how
 * many readings it took, then per object the records there and those not,
 * the lookups checked and those that do not hold, the records changed since
 * the run, and what could not be checked. Exported so it can be tested.
 */
export function verificationLines(verification: ForgeRunVerification, target: string): string[] {
  const lines = [
    verification.verdict === 'unstable'
      ? `verification: UNSTABLE — no two of ${verification.attempts} readings of ${target} agreed: ` +
        "something still writes to the run's records; verify again once it is done"
      : `verification: ${verification.verdict.toUpperCase()} (${verification.attempts} readings of ${target})`,
  ];
  const changed: string[] = [];
  for (const o of verification.objects) {
    if (o.error !== undefined) {
      lines.push(`  ${o.objectApiName}: not read (${o.error})`);
      continue;
    }
    const missing = [
      o.deleted > 0 ? `${o.deleted} in the recycle bin` : '',
      o.notVisible > 0 ? `${o.notVisible} neither there nor in the recycle bin, out of sight` : '',
    ].filter(Boolean);
    // The lookups the target explains, counted apart from those that broke.
    const leftEmpty = o.linksLeftEmptyByFilter ?? 0;
    const byAutomation = o.linksSetByAutomation ?? 0;
    const explained = [
      leftEmpty > 0 ? `${leftEmpty} left empty by the target's lookup filter, as the run said` : '',
      byAutomation > 0 ? `${byAutomation} set by the target's automation during the run` : '',
    ].filter(Boolean);
    const held = o.linksChecked - o.linksBroken - leftEmpty - byAutomation;
    const links =
      o.linksUnchecked !== undefined
        ? `lookups not checked (${o.linksUnchecked})`
        : o.linksChecked === 0
          ? 'no lookup the run set to check'
          : o.linksBroken === 0 && explained.length === 0
            ? `lookups: ${o.linksChecked} checked, all hold`
            : `lookups: ${o.linksChecked} checked, ` +
              [
                ...(o.linksBroken > 0 ? [`${o.linksBroken} do not hold`] : [`${held} hold`]),
                ...explained,
              ].join(', ');
    lines.push(
      `  ${o.objectApiName}: ${o.present} of ${o.expected} there` +
        (missing.length > 0 ? `, ${missing.join(', ')}` : '') +
        `; ${links}`,
    );
    for (const link of o.brokenLinks) {
      lines.push(
        link.found === null
          ? `      ${link.recordId}: ${link.field} is empty, the run set it to ${link.expected}`
          : `      ${link.recordId}: ${link.field} points at ${link.found}, the run set it to ${link.expected}`,
      );
    }
    for (const link of o.explainedLinks ?? []) {
      lines.push(
        link.cause === 'automation'
          ? `      ${link.recordId}: ${link.field} points at ${link.found ?? ''}, which the ` +
              `target's automation created during the run; the run set it to ${link.expected}`
          : `      ${link.recordId}: ${link.field} is empty: the target's lookup filter refused ` +
              `${link.expected}, and the run left it empty`,
      );
    }
    if (o.recycleBinUnread !== undefined) {
      lines.push(`      the recycle bin could not be read (${o.recycleBinUnread})`);
    }
    if ((o.moreInTheWindow ?? 0) > 0) {
      lines.push(
        `      ${o.moreInTheWindow} more ${o.objectApiName} record(s) were created in ${target} ` +
          "during the run by the run's user than the run wrote: the target's automation, " +
          'another session writing as that user, or a call written twice',
      );
    }
    for (const change of o.changedRecords) {
      changed.push(
        `      ${o.objectApiName} ${change.recordId}: modified ${change.modifiedAt}` +
          (change.modifiedById ? ` by ${change.modifiedById}` : ''),
      );
    }
  }
  const changedCount = verification.objects.reduce((sum, o) => sum + o.changed, 0);
  if (changedCount > 0) {
    lines.push(
      `changed since the run: ${changedCount} record(s), which --remove keeps unless --include-changed`,
      ...changed,
    );
  }
  if (verification.linksUnchecked !== undefined) {
    lines.push(`lookups not checked: ${verification.linksUnchecked}`);
  }
  return lines;
}

/**
 * Verify what a run created, from the summary it printed with `--json`: the
 * verification the wizard runs from a run's results (`RunVerifier`), on the
 * records the summary says the run created, the lookups of a sample of them
 * checked against the source records in the org the run read from. Exported
 * so it can be tested.
 *
 * The summary is read and checked before any org is contacted; the target
 * must be the org the run wrote to. Nothing is written to either org. Exits
 * 0 when verified, 3 when partial, 4 when unstable, 2 on a bad command line
 * or a summary that cannot be read, 1 when the verification could not run.
 */
export async function verifyMain(argv: string[] = process.argv): Promise<void> {
  const t0 = Date.now();
  const args = parseVerifyArgs(argv);
  const say = (line: string): void => (args.json ? console.error(line) : console.log(line));

  let text: string;
  try {
    text = readFileSync(args.summaryPath, 'utf8');
  } catch (err: unknown) {
    process.stderr.write(
      `--verify ${args.summaryPath} cannot be read: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(2);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // Not JSON: the summary's own reading says so below.
  }
  const dryRun = z.object({ tool: z.literal('sandforge-clone'), dryRun: z.literal(true) });
  if (dryRun.safeParse(raw).success) {
    process.stderr.write(
      `--verify ${args.summaryPath} is the summary of a dry run, which wrote nothing to the ` +
        'target: there is nothing of it to verify.\n',
    );
    process.exit(2);
  }
  const refused = refusalOfSummary(raw, 'sandforge-clone');
  if (refused) {
    process.stderr.write(
      `--verify ${args.summaryPath} ${refusedSummaryWords(refused, 'verify')}\n`,
    );
    process.exit(2);
  }
  const read = await runSummaryOfFile(args.summaryPath, text, args.target);
  if ('refusal' in read) {
    process.stderr.write(`--verify ${args.summaryPath} ${read.refusal}\n`);
    process.exit(2);
  }
  let { summary } = read;
  if (summary.targetOrgId === undefined && summary.target !== args.target) {
    process.stderr.write(
      `The run wrote to ${summary.target}, and its records are verified in that org only: ` +
        `give --target ${summary.target}.\n`,
    );
    process.exit(2);
  }
  const created = removalPlan(summary);
  if (created.length === 0) {
    say('The run created no record: there is nothing of it to verify.');
    return;
  }
  // What earlier removals of the summary left on the run's records, kept
  // beside it: no change since the run. A file that cannot be read is said,
  // and the verification goes on without it.
  let removalStamps: Readonly<Record<string, string>> | undefined;
  const removalsFile = removalsPath(args.summaryPath);
  let removalsText: string | undefined;
  try {
    removalsText = readFileSync(removalsFile, 'utf8');
  } catch {
    // No removal kept anything beside the summary.
  }
  const earlier = readEarlierRemovals(removalsText, runKey(created));
  let records = created;
  if ('refusal' in earlier) say(`${removalsFile} ${earlier.refusal}`);
  else {
    removalStamps = earlier.earlier?.removalStamps;
    // What an earlier --remove took is not looked for, as the panel verifies
    // what a run's history entry says is left: it read as missing.
    records = forgeRemovalPlanLeft({ objects: created, removalLeft: earlier.earlier?.removalLeft });
    if (records.length === 0) {
      say(
        'An earlier --remove of this summary took every record the run created: there is nothing of it to verify.',
      );
      return;
    }
  }
  const written = writtenWithoutSchema.safeParse(raw);
  const leftEmpty = leftEmptySchema.safeParse(raw);

  say(`sandforge-clone --verify  ${args.summaryPath}  in ${args.target}`);
  const session = await loadOrg(args.target);
  const conn = makeConn(session);
  const org = await typeOrg(conn);
  if (summary.targetOrgId !== undefined && !sameRecord(summary.targetOrgId, org.id)) {
    // Under its code, as the removal of the same summary is refused: it said
    // a sentence with no code on stderr and left stdout empty.
    const refused = {
      code: OTHER_ORG,
      message:
        `${args.target} is not the org the run wrote to (${summary.targetOrgId}), and its ` +
        'records are verified in that org only. Nothing of the run was read.',
    };
    process.stderr.write(`${refusedLine(refused)}\n`);
    if (args.json) {
      process.stdout.write(
        refusedRemovalSummary(
          {
            tool: 'sandforge-clone',
            action: 'verify',
            summary: args.summaryPath,
            target: args.target,
            elapsedMs: elapsedSince(t0),
          },
          refused,
        ),
      );
    }
    process.exit(1);
  }
  summary = await datedFromItsJournal(conn, summary);
  const sourceAlias = args.source ?? summary.source;
  let source: SourceOrg | { unavailable: string };
  try {
    source = verifiedOrg(makeConn(await loadOrg(sourceAlias)), 'sandforge-clone --verify source');
  } catch (err: unknown) {
    source = {
      unavailable: `the org the run read from, ${sourceAlias}, could not be reached: ${extractErrorMessage(err)}`,
    };
  }
  /** The verification's entry in the audit trail, with --audit, as the panel records one. */
  const audited = new Map([[org.id, { alias: args.target, username: session.username }]]);
  const recordVerification = (run: Pick<WriteRun, 'outcome' | 'verdict' | 'details'>) =>
    recordCliRun(args.audit, audited, {
      action: 'forge_verify',
      module: 'forge',
      operationId: `sandforge-clone-${randomUUID()}`,
      orgId: org.id,
      ...run,
    });
  let verification: ForgeRunVerification;
  try {
    verification = await new RunVerifier({
      target: verifiedOrg(conn, 'sandforge-clone --verify'),
      source,
    }).verify({
      records,
      remapTable: summary.result.remapTable,
      ...(summary.result.writtenBetween
        ? {
            runStartedAt: new Date(summary.result.writtenBetween.first),
            runEndedAt: new Date(summary.result.writtenBetween.last),
          }
        : summary.finishedAt
          ? { runRecordedAt: new Date(summary.finishedAt) }
          : {}),
      ...(removalStamps ? { removalStamps } : {}),
      ...(written.success
        ? { writtenWithout: writtenWithoutByObject(written.data.result.writtenWithoutFields) }
        : {}),
      ...(leftEmpty.success
        ? { leftEmptyByFilter: leftEmpty.data.result.lookupsLeftEmptyByFilter }
        : {}),
    });
  } catch (err: unknown) {
    recordVerification({ outcome: 'failure' });
    throw err;
  }
  recordVerification({
    outcome: verification.verdict === 'verified' ? 'success' : 'partial',
    verdict: verification.verdict,
    details: verificationTotals(verification),
  });

  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        {
          tool: 'sandforge-clone',
          version: 1,
          action: 'verify',
          summary: args.summaryPath,
          target: args.target,
          targetOrgId: org.id,
          source: sourceAlias,
          result: verification,
          elapsedMs: elapsedSince(t0),
        },
        null,
        2,
      ) + '\n',
    );
  } else {
    for (const line of verificationLines(verification, args.target)) console.log(line);
    console.log(`\ndone in ${elapsedSince(t0)}ms`);
  }
  const code = VERDICT_EXIT[verification.verdict];
  if (code !== 0) process.exit(code);
}

/** The events that end an object, after which the summary file says what the run created. */
const OBJECT_ENDS: ReadonlySet<ForgeProgressEvent['status']> = new Set([
  'done',
  'error',
  'stopped',
]);

/**
 * What a clone Ctrl-C stopped says last: that it was stopped, and what
 * --remove takes it back from. Exported so it can be tested.
 *
 * @param summaryPath - The file --summary wrote, when it was given.
 */
export function interruptedLine(summaryPath: string | undefined): string {
  return summaryPath
    ? `interrupted: the clone stopped before it was through; ${summaryPath} says what it created, ` +
        `and --remove ${summaryPath} takes it back`
    : 'interrupted: the clone stopped before it was through; the summary above says what it ' +
        'created, and --remove takes it back from that summary saved to a file (--json)';
}

/** An object a clone starts from, and how its command line named it. */
export interface CloneRoot {
  objectApiName: string;
  /** `--object Report`, or `--record <id>`. */
  named: string;
}

/** The code of a clone refused for an object to start from that no user can create. */
export const ROOT_NEVER_CREATED = 'ROOT_NEVER_CREATED';

/** What a refusal for a root says it did not do: the target's metadata alone was read. */
const NO_RECORD_READ = 'No record was read or written.';

/**
 * Why a clone may not start from `roots`: one of them no user can create in
 * the target, so nothing of what the clone starts from could be written, and
 * nothing hung from it either. Nothing when each may be created, or the target
 * did not say. Read before a row of either org, from the target's describe of
 * each root, and only for one its user may not create, from what the target
 * says of who may (`whyNotCreatableOver`) — unless every copy leaves it out by
 * name already.
 *
 * Run from a report, a clone read the source's reports and its dry run said
 * Report BLOCKING, asking the target's administrator to tick Create on it.
 * Exported so it can be tested.
 */
export async function rootNeverCreatedRefusal(
  roots: readonly CloneRoot[],
  target: string,
  read: {
    /** Whether the target's user may create the object's records; throws when it would not describe it. */
    createable: (objectApiName: string) => Promise<boolean>;
    whyNot: (objectApiNames: readonly string[]) => Promise<ReadonlyMap<string, NotCreatableBy>>;
  },
): Promise<RunRefusal | undefined> {
  const closed: CloneRoot[] = [];
  for (const root of roots) {
    try {
      if ((await read.createable(root.objectApiName)) === false) closed.push(root);
    } catch {
      // A target that would not describe it says so at the run's own describe.
    }
  }
  if (closed.length === 0) return undefined;
  const leftOut = closed.find((root) => isNeverCopied(root.objectApiName));
  if (leftOut) {
    const object = leftOut.objectApiName;
    return {
      code: ROOT_NEVER_CREATED,
      message:
        `${leftOut.named}: SandForge never copies ${object} records, setup or the platform's own, ` +
        `and ${target}'s user may not create them: a clone has nothing to write of what it ` +
        `starts from. ${NO_RECORD_READ}`,
    };
  }
  let answered: ReadonlyMap<string, NotCreatableBy>;
  try {
    answered = await read.whyNot(closed.map((root) => root.objectApiName));
  } catch {
    return undefined;
  }
  for (const root of closed) {
    const by = answered.get(root.objectApiName);
    if (by === undefined || !noUserCreates(by)) continue;
    const object = root.objectApiName;
    const who =
      by === 'platform'
        ? 'the platform writes them itself'
        : "not even one with Modify All Data: they are setup the org keeps as records, or the platform's own";
    return {
      code: ROOT_NEVER_CREATED,
      message:
        `${root.named}: no user can create ${object} records in ${target}, ${who}, and a clone ` +
        `has nothing to write of what it starts from. ${NO_RECORD_READ}`,
    };
  }
  return undefined;
}

/**
 * The objects a clone starts from: each table named, or the object the record
 * is of, as the source's global describe tells it by the record's key prefix.
 * None when the source names no object of that prefix, or would not list its
 * objects: discovery says so.
 */
async function cloneRootsOf(
  args: Pick<CliArgs, 'record' | 'tables' | 'source'>,
  describeGlobal: (orgId: string) => Promise<Array<{ name: string; keyPrefix?: string | null }>>,
): Promise<CloneRoot[]> {
  if (args.tables) {
    return args.tables.map(({ objectApiName }) => ({
      objectApiName,
      named: `--object ${objectApiName}`,
    }));
  }
  const record = args.record ?? '';
  if (record === '') return [];
  const prefix = record.slice(0, 3);
  let listed: Array<{ name: string; keyPrefix?: string | null }>;
  try {
    listed = await describeGlobal(args.source);
  } catch {
    return [];
  }
  const object = listed.find((entry) => entry.keyPrefix === prefix)?.name;
  return object ? [{ objectApiName: object, named: `--record ${record} (a ${object})` }] : [];
}

/**
 * What reads who may be given Create in an org (`readCreateFacts`) through
 * the command's connections and describes, which the run keeps: the describe
 * of `ObjectPermissions` costs the read of the gaps nothing after it.
 */
function createFactsDepsOf(
  conns: ReadonlyMap<string, Connection>,
  describe: (orgId: string, objectName: string) => Promise<DescribeSObjectResult>,
  described: ReadonlySet<string>,
): CreateFactsDeps {
  const conn = (orgId: string): Connection => {
    const c = conns.get(orgId);
    if (!c) throw new Error(`No connection for ${orgId}`);
    return c;
  };
  return {
    describeFields: async (orgId, objectName) => {
      const sent = !described.has(`${orgId}::${objectName}`);
      return { fields: (await describe(orgId, objectName)).fields.map(gapFieldOf), sent };
    },
    query: async (orgId, soql) =>
      answerOf(
        {
          query: async (q) => conn(orgId).query<Record<string, unknown>>(q),
          queryMore: async (url) => conn(orgId).queryMore<Record<string, unknown>>(url),
        },
        soql,
      ),
  };
}

/** A query on the Tooling API of one of the command's orgs, every page of it. */
async function toolingAnswerOf(
  conns: ReadonlyMap<string, Connection>,
  orgId: string,
  soql: string,
): Promise<QueryAnswer> {
  const c = conns.get(orgId);
  if (!c) throw new Error(`No connection for ${orgId}`);
  return answerOf(
    {
      query: async (q) => c.tooling.query<Record<string, unknown>>(q),
      queryMore: async (url) => c.tooling.queryMore<Record<string, unknown>>(url),
    },
    soql,
  );
}

/**
 * Run one clone from the given command line, or one removal under `--remove`;
 * exported so its flag checks can be tested.
 */
export async function main(argv: string[] = process.argv): Promise<void> {
  if (argv.slice(2).includes('--verify')) return verifyMain(argv);
  if (argv.slice(2).includes('--remove')) return removeMain(argv);
  const interrupts: CloneInterrupts = {};
  try {
    await cloneMain(argv, interrupts);
  } finally {
    // However the clone ended, a refusal at one of its gates included, its
    // Ctrl-C goes with it.
    interrupts.release?.();
  }
}

/** How a clone hears Ctrl-C, for {@link main} to let it go however the clone ends. */
interface CloneInterrupts {
  release?: () => void;
}

/**
 * Thrown from the write gate when Ctrl-C came while the checkpoint asked
 * first was taken: nothing of it was kept, nothing written, and the clone
 * ends as one stopped before it started.
 */
class CheckpointTakeInterrupted extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckpointTakeInterrupted';
  }
}

/** One clone from the given command line: see {@link main}. */
async function cloneMain(argv: string[], interrupts: CloneInterrupts): Promise<void> {
  const t0 = Date.now();
  const args = parseArgs(argv);
  // In --json mode stdout carries the summary alone, for a parser to read: a
  // CI job that saved it to a file read the progress lines in front of the
  // JSON, and failed on them. What the run says on the way goes to stderr.
  const say = (line: string): void => (args.json ? console.error(line) : console.log(line));
  say(`sandforge-clone  ${args.source} -> ${args.target}  ${cloneInputLine(args)}`);
  for (const line of choicesLines(args)) say(line);

  const sourceOrg = await loadOrg(args.source);
  const targetOrg = await loadOrg(args.target);
  /**
   * How the run was set up and let through, as the panel's entry says it: its
   * anonymization, its contact points, its decisions, what fired as it
   * inserted, and what --accept-automation let through. A command-line run
   * goes without the Review screen.
   */
  let audit: ForgeRunAudit | undefined;
  const runAudit = (): ForgeRunAudit =>
    (audit ??= new ForgeRunAudit(
      {
        ...cloneInputOf(args),
        depth: args.depth,
        sourceOrgId: args.source,
        targetOrgId: args.target,
        anonymizePII: args.anonymize,
        keepContactPoints: args.keepContactPoints,
        skipEmpty: true,
        batchSize: 'auto',
        excludedObjects: args.excludedObjects,
        ...args.decisions,
      },
      { reviewSkipped: true },
    ));
  const conns = new Map<string, Connection>();
  conns.set(args.source, makeConn(sourceOrg));
  conns.set(args.target, makeConn(targetOrg));
  // Typed before discovery reads a row, so a production target is refused
  // before the run has cost anything. A dry run and a listing only read.
  let targetOrgId: string | undefined;
  /**
   * The orgs the run's entry in the audit trail names, with --audit, by their
   * own ids: the target once typed, the source typed for it alone.
   */
  const audited = new Map<string, AuditedOrg>();
  let sourceOrgId: string | undefined;
  const operationId = `sandforge-clone-${randomUUID()}`;
  /** A real run's entry; a dry run, a listing and a rehearsal write nothing, and record nothing. */
  /** What the run muted of the target's automation, asked with --mute-automation. */
  let mutedAutomation: MutedAutomation | undefined;
  const recordClone = (run: Omit<WriteRun, 'action' | 'module' | 'operationId' | 'orgId'>) => {
    if (targetOrgId === undefined || args.dryRun || args.listObjects || args.rehearse) return;
    recordCliRun(args.audit, audited, {
      action: 'forge_execute',
      module: 'forge',
      operationId,
      orgId: targetOrgId,
      ...run,
      ...(mutedAutomation ? { muted: auditMutedOf(mutedAutomation) } : {}),
    });
  };
  /** The target as its Organization record says it is, once typed. */
  let typedTarget: TypedOrg | undefined;
  if (!args.dryRun && !args.listObjects) {
    const target = await typeOrg(conns.get(args.target)!);
    typedTarget = target;
    targetOrgId = target.id;
    audited.set(target.id, { alias: args.target, username: targetOrg.username });
    if (args.audit && !args.rehearse) {
      sourceOrgId = (await typeOrg(conns.get(args.source)!)).id;
      audited.set(sourceOrgId, { alias: args.source, username: sourceOrg.username });
    }
    const refusal = productionRefusal(args.target, target, 'clone');
    if (refusal) {
      recordClone({ outcome: 'stopped', code: 'PRODUCTION_TARGET', context: runAudit().context() });
      process.stderr.write(`${refusal}\n`);
      process.exit(1);
    }
  }
  // The checkpoint the run takes of what it writes before its first write:
  // scoped at the write gate once the rows are read, taken once the gate lets
  // them through and before the mute's lease, kept or deleted as the run
  // ends. A dry run says what it would hold and cost, and takes nothing. It
  // reads the target through a connection of its own: the run's calls stay
  // the run's.
  const checkpoints: CommandCheckpoints | undefined = args.checkpointFirst
    ? commandCheckpoints({
        module: 'forge',
        operationId,
        request: args.checkpointFirst,
        session: targetOrg,
        org: checkpointOrgOf(targetOrg, typedTarget ?? (await typeOrg(conns.get(args.target)!))),
        connect: makeConn,
        journalDir: journalDirOf(),
        say,
      })
    : undefined;
  // Every request either org is sent: the run's calls are the record types'
  // read for it and those sent while the executor has it, as the extension
  // counts them; discovery's and the preflight's are not.
  const requestsOf = [...conns.values()].map(countRequests);
  const requestsSent = (): number => requestsOf.reduce((sum, sent) => sum + sent(), 0);

  const config: ForgeConfig = {
    ...cloneInputOf(args),
    depth: args.depth,
    customDepth: args.depth === 'custom' ? args.customDepth : undefined,
    sourceOrgId: args.source,
    targetOrgId: args.target,
    anonymizePII: args.anonymize,
    skipEmpty: true,
    batchSize: 'auto',
    // A table is counted under its filter, as the panel's discovery of a query
    // counts the object after FROM: a count of the whole table would say an
    // empty filter's table held rows.
    ...(args.tables && Object.keys(args.objectSoqlFilters).length > 0
      ? { objectSoqlFilters: args.objectSoqlFilters }
      : {}),
  };

  const piiDetector = new PIIDetector();
  // The describes sent, which the read of the target's gaps does not count again.
  const described = new Set<string>();
  const describe = describeOnce(async (orgId, name) => {
    described.add(`${orgId}::${name}`);
    const c = conns.get(orgId);
    if (!c) throw new Error(`No connection for ${orgId}`);
    return c.sobject(name).describe();
  });
  /** The source's global describe, read once by org. */
  const globalDescribes = new Map<
    string,
    Promise<Array<{ name: string; keyPrefix: string | null }>>
  >();
  const discoveryDeps: GraphDiscoveryDeps = {
    describeObject: async (orgId, name) => adaptDescribe(await describe(orgId, name)),
    queryCount: async (orgId, soql) => {
      const c = conns.get(orgId);
      if (!c) throw new Error(`No connection for ${orgId}`);
      const r = await c.query(soql);
      return r.totalSize;
    },
    // As the extension's discovery reads them: no label, and a text field
    // named for an email address or a phone number read from its API name.
    detectPII: (fields) => personalFieldsByApiName(piiDetector, fields),
    describeGlobal: (orgId) => {
      // Read once: what the record to clone is an object of is asked before
      // discovery, which asks it again.
      let listed = globalDescribes.get(orgId);
      if (!listed) {
        const c = conns.get(orgId);
        if (!c) throw new Error(`No connection for ${orgId}`);
        listed = c
          .describeGlobal()
          .then((r) => r.sobjects.map((s) => ({ name: s.name, keyPrefix: s.keyPrefix ?? null })));
        globalDescribes.set(orgId, listed);
      }
      return listed;
    },
  };

  // An object no user can create is none to start a clone from: refused with
  // its code before a row of either org is read, never said BLOCKING after
  // discovery read the source's reports.
  const roots = await cloneRootsOf(args, discoveryDeps.describeGlobal);
  const rootRefused = await rootNeverCreatedRefusal(roots, args.target, {
    createable: async (name) => (await describe(args.target, name)).createable !== false,
    whyNot: (names) =>
      whyNotCreatableOver(
        (orgId, soql) => toolingAnswerOf(conns, orgId, soql),
        async (orgId) =>
          (await readCreateFacts(createFactsDepsOf(conns, describe, described), orgId)).facts,
      )(args.target, names),
  });
  if (rootRefused) {
    recordClone({ outcome: 'stopped', code: rootRefused.code, context: runAudit().context() });
    process.stderr.write(`${refusedLine(rootRefused)}\n`);
    if (args.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            tool: 'sandforge-clone',
            source: args.source,
            target: args.target,
            dryRun: args.dryRun,
            refused: rootRefused,
            elapsedMs: elapsedSince(t0),
          },
          null,
          2,
        )}\n`,
      );
    }
    process.exit(1);
  }

  say('discovery…');
  const discovery = new GraphDiscoveryService(discoveryDeps);
  const discovered = await discovery.discover(
    config,
    args.maxNodes === undefined ? undefined : { maxNodes: args.maxNodes },
  );
  const root = discovered.nodes[0]?.objectApiName;
  if (root !== undefined && args.excludedObjects.includes(root)) {
    process.stderr.write(
      `--exclude-object ${root}: the ${args.tables ? 'first table' : 'record'} to clone is of ` +
        'this object, and nothing would be left to clone.\n',
    );
    process.exit(2);
  }
  // A table named and never reached would read nothing, and the run would say
  // it had cloned what it was given: refused before a row is read.
  const notReached = args.tables ? tablesNotReached(discovered, args.tables) : [];
  if (notReached.length > 0) {
    // An environment names its tables, depth and maxNodes in its file.
    const env = relayedByAnEnvironment();
    const named = env
      ? `the table${notReached.length === 1 ? '' : 's'} ${notReached.join(', ')}`
      : `--object ${notReached.join(', ')}`;
    process.stderr.write(
      `${named}: discovery from ${root ?? args.tables?.[0]?.objectApiName} ` +
        `did not reach ${notReached.length === 1 ? 'it' : 'them'} ` +
        `(${discovered.nodes.length} object(s), depth ${args.depth === 'custom' ? args.customDepth : args.depth}): ` +
        'name first a table it hangs from or points at, or raise ' +
        `${env ? "the resource's depth or maxNodes" : '--depth or --max-nodes'}.\n`,
    );
    process.exit(2);
  }
  // The config the run goes with: a clone of whole tables leaves out every
  // object discovery reached that the command line does not name.
  const runConfig = args.tables ? tablesRunConfig(args, discovered) : config;
  const objectsLeftOut = runConfig.excludedObjects ?? args.excludedObjects;
  // Listed as excluded and out of the plan; the run leaves them out as well,
  // and those discovery never reached, which it would otherwise add.
  const graph = withTemplateFields(
    withObjectsLeftOut(discovered, new Set(objectsLeftOut)),
    args.anonymizeFields,
  );
  const plan = new ForgePlanGenerator().generate(graph);
  say(graphLine(graph, plan, args.maxNodes ?? DEFAULT_MAX_NODES));

  if (args.listObjects) {
    // The question a user asks when an object they expected is missing from a
    // clone: is it in the graph at all? Nothing answered it before, and the
    // answer decides whether to raise --max-nodes or to look elsewhere.
    const listed = listedObjects(graph);
    const rows = listed.map(
      (o) =>
        `  ${o.objectApiName.padEnd(42)}${String(o.recordCount).padStart(8)}` +
        `  depth ${o.depth}${o.included ? '' : '  (excluded)'}`,
    );
    say(`\nobjects in the graph (${graph.nodes.length}):`);
    say(rows.join('\n'));
    if (graph.truncated) {
      say(
        '\nThe graph was truncated: discovery stopped before it had walked ' +
          'everything. Raise --max-nodes if an object you need is missing.',
      );
    }
    // With --json the lines above go to stderr, and stdout carried nothing at
    // all: saved to a file, the listing was an empty one. stdout carries the
    // objects as JSON, as it carries a clone's summary.
    if (args.json) {
      process.stdout.write(
        JSON.stringify(
          {
            tool: 'sandforge-clone',
            version: 1,
            action: 'list-objects',
            source: args.source,
            target: args.target,
            ...(args.tables ? { tables: args.tables } : { record: args.record }),
            graph: graphJson(graph, plan),
            objects: listed,
            elapsedMs: elapsedSince(t0),
          },
          null,
          2,
        ) + '\n',
      );
    }
    return;
  }

  // The journal of a run that writes, which says how it was set up: a run
  // taken up from one is refused before anything more is read when its org or
  // its setup is not the run's it takes up.
  const journals = !args.dryRun && !args.rehearse ? nodeRunJournal(journalDirOf()) : undefined;
  const fingerprint =
    targetOrgId !== undefined ? forgeRunFingerprint(graph, cliRunSetup(args, targetOrgId)) : '';
  let journalPath: string | undefined;
  /** How the part the run takes up ended: said again of this part when it writes nothing. */
  let resumedEnd: { status: ForgeRunPartEnd; forgeId: string } | undefined;
  /**
   * Whether the run mutes the target's automation: asked to, or taking up a
   * run that was. Its journal did not keep the choice, and a muted run taken
   * up ran unmuted.
   */
  let muteAutomation = args.muteAutomation;
  if (journals && targetOrgId !== undefined && args.resume) {
    journalPath = resumedJournalPath(args.resume, journals);
    const refusal = await resumeRefusal(journals, journalPath, {
      target: args.target,
      targetOrgId,
      graph,
      setup: cliRunSetup(args, targetOrgId),
    });
    if (refusal) {
      recordClone({ outcome: 'stopped', code: refusal.code, context: runAudit().context() });
      process.stderr.write(`${refusal.message}\n`);
      process.exit(2);
    }
    resumedEnd = await journals.lastEndAt(journalPath);
    if ((await journals.headAt(journalPath))?.resume?.muteAutomation === true) {
      muteAutomation = true;
    }
    say(`taking up the run of ${journalPath}`);
    // The insert calls the run had under way when it stopped, their answer
    // never kept: looked for in the target before anything is read or
    // written, and what it holds of them kept as the run's. Taken up from the
    // journal alone, a run killed during a call wrote that call's rows twice.
    const reconciled = await journals.reconcileAt(
      journalPath,
      inFlightTargetOf(conns.get(args.target)!),
    );
    for (const line of inFlightLines(reconciled, args.target)) say(line);
    if (uncertainRows(reconciled) > 0 && !args.writeUncertain) {
      recordClone({
        outcome: 'stopped',
        code: 'RESUME_UNCERTAIN',
        context: runAudit().context(),
      });
      process.stderr.write(`${uncertainRefusal(reconciled, args.target)}\n`);
      process.exit(2);
    }
  }

  // Ctrl-C stops the run as the panel's Stop does, through the same registry
  // of what is under way (`ForgeStops.stop`), from the read of what the
  // target runs until the executor is through. Before the executor has the
  // run, nothing is written, and the run is recorded stopped before it
  // started, as the panel records one stopped while it read the target's
  // automation or record types; once the executor has it, the run stops
  // between two calls to the org and says what it created. Killed outright
  // before then, a clone left no entry in the trail. A second Ctrl-C ends
  // the process at once.
  const stops = new ForgeStops();
  const runController = new AbortController();
  /** The executor, once made: what a stop tells to stop writing. */
  const running: { executor?: ForgeExecutor } = {};
  // A SIGTERM — Jenkins aborting a build, a `timeout` step — or a SIGHUP stops
  // it the same way: the summary and the journal say what it created.
  let interrupted: StopSignal | undefined;
  const interrupt = (signal: StopSignal): void => {
    interrupted = signal;
    process.stderr.write(
      '\ninterrupted: the clone stops after the call under way, and says what it created ' +
        '(Ctrl-C again ends it at once)\n',
    );
    stops.stop(undefined, {
      discovery: () => undefined,
      run: () => {
        runController.abort();
        running.executor?.abort();
      },
    });
  };
  if (!args.dryRun && !args.rehearse && !args.listObjects) {
    stops.beginRun(operationId, runController);
    const releaseStop = onStopSignal(interrupt);
    interrupts.release = () => {
      releaseStop();
      stops.endRun(operationId);
    };
  }
  /**
   * End the clone here when a Ctrl-C came before the executor had the run:
   * nothing written, recorded stopped before it started under the panel's
   * code, `endJournal` letting a journal begun for it go, and exit 130. The
   * executor clears a stop on entry: one that came before is honoured here.
   */
  const stopIfInterrupted = async (endJournal?: () => Promise<void>): Promise<void> => {
    if (!runController.signal.aborted) return;
    recordClone({ outcome: 'stopped', code: ABORTED_BEFORE_START, context: runAudit().context() });
    await endJournal?.();
    say('interrupted: the clone stopped before it wrote anything');
    process.exit(stopExitCode(interrupted ?? 'SIGINT'));
  };

  // What the target runs on the objects the run writes, said before anything
  // is written — on a dry run too, for the requests the read sends alone. Run
  // into a sandbox, a clone fired the target's record-triggered flows on every
  // record it created, and nothing said so before the run.
  const targetAutomation = await targetAutomationReader(conns.get(args.target)!).readForGraph(
    args.target,
    graph,
    new Set(objectsLeftOut),
  );
  say('');
  for (const line of automationLines(targetAutomation, args.target, {
    applyAssignmentRules: args.applyAssignmentRules,
    // Relayed by an environment, which mutes nothing, the flag is not named;
    // nor the rules' flag, which neither it nor the MCP server takes.
    mayMute: relayTakes('--mute-automation'),
    mayApplyAssignmentRules: relayTakes('--apply-assignment-rules'),
  })) {
    say(line);
  }
  // What may refuse taking the run back, said before it writes: a flow before
  // a delete, a trigger on one, a record that locks past Draft.
  const removalRisks = removalRisksOf(targetAutomation, new Set(objectsLeftOut));
  for (const line of removalRiskLines(
    removalRisks,
    args.target,
    targetAutomation.unread,
    // An environment takes its runs back by its destroy, or by a replace.
    envWords('--remove', 'destroy, or a replace'),
  )) {
    say(line);
  }
  // What that automation may reach: the records' own addresses and numbers,
  // unless they go neutralized.
  say(
    args.keepContactPoints
      ? `contact points: written as read (${envWords('--keep-contact-points', 'keepContactPoints')})`
      : 'contact points: neutralized before writing (emails under .invalid, phone numbers in a fictional range)',
  );
  // What the target holds against the rows, read from its metadata before a
  // row is read, on a dry run too: its rules, the fields only it requires,
  // its lookup filters, its budget. It stops nothing.
  const targetGaps = await targetGapReader(conns, describe, described).read(
    args.source,
    args.target,
    graph,
    {
      inputMode: config.inputMode,
      recordId: config.recordId,
      maxRecordsPerObject: args.maxRecordsPerObject,
      fieldExclusions: args.fieldExclusions,
      fieldMappings: args.fieldMappings,
      excludedObjects: objectsLeftOut,
    },
  );
  // A gap a decision of the run answers — a default from --config given to
  // a field only the target requires — is said answered, as Review shows it
  // decided: said BLOCKING, it stood beside the line that applied the default
  // to every row.
  const gapDecisions: GapDecisions = {
    ...args.decisions,
    fieldExclusions: args.fieldExclusions,
    excludedObjects: objectsLeftOut,
  };
  // What fires as it updates the records it inserted is asked with what
  // fires as it inserts them: in a client's sandbox, a flow on orders sent
  // each to an external system as the clone gave it back its status.
  const updated = objectsUpdatedAfterInsert(graph, {
    leftOut: new Set(objectsLeftOut),
    upsert: args.upsert,
  });
  const updatedNames = new Set(updated.map((object) => object.objectApiName));
  /** The writes the run makes, per object: what its mute plans for. */
  const runWrites = (objectApiName: string, write: ForgeAutomationWrite): boolean =>
    write === 'insert' || (write === 'update' && updatedNames.has(objectApiName));
  // A rule the mute would lift refuses no row: its line says so, where it
  // said its rows would go again without a field — on the trap org, the
  // rows went in whole.
  const liftedByMute = muteAutomation
    ? planMute(targetAutomation, runWrites).plan.alsoLifts
    : undefined;
  say('');
  for (const line of gapLines(targetGaps, args.target, {
    decisions: gapDecisions,
    ...(liftedByMute ? { lifted: liftedByMute } : {}),
  })) {
    say(line);
  }
  // What --upsert matches the target's records by, when the run writes it
  // neutralized: an email key went out as `x@y.com.invalid` and matched no
  // copy holding the real address. Said before anything is written, and
  // given to a CI job under `neutralizedUpsertKeys`.
  const upsertKeys =
    args.upsert && !args.keepContactPoints
      ? neutralizedUpsertKeys(
          await Promise.all(
            graph.nodes
              .filter((node) => node.included)
              .map(async ({ objectApiName }) => ({
                objectApiName,
                fields: await describe(args.source, objectApiName)
                  .then((described) => described.fields)
                  .catch(() => []),
              })),
          ),
        )
      : [];
  for (const line of upsertKeyLines(upsertKeys, args.target)) say(line);
  // What fires as the clone inserts its records is no longer only said: the
  // panel puts it to the user before it reads anything, and the command,
  // with no one to ask, writes nothing unless told to go on regardless. A
  // target that would not say what it runs is taken the same way. A dry run
  // writes nothing, and says what a real one would need.
  // Asked to mute, the run plans it from what it read, and its gate asks only
  // for what still runs. Refused on a production org or for a user who cannot
  // assign, a real run writes nothing; a dry run says so, and assigns nothing.
  let mute: RunMute | undefined;
  /** Why a dry run's mute would be refused, said with the rest of its refusals. */
  let muteRefused: RunRefusal | undefined;
  /**
   * End a run refused before its first write as Sync ends one: each refusal's
   * line names its code, and with --json the summary on stdout carries them,
   * where a CI job reads `.refused.code`. Refused past --max-total, its
   * storage or a mute, a clone said a sentence on stderr and left stdout empty.
   */
  const endRefused = (refused: RunRefusal, also: readonly RunRefusal[] = []): never => {
    for (const refusal of [refused, ...also]) process.stderr.write(`${refusedLine(refusal)}\n`);
    if (args.json) {
      process.stdout.write(
        refusedSummary(
          {
            tool: 'sandforge-clone',
            source: args.source,
            target: args.target,
            elapsedMs: elapsedSince(t0),
          },
          refused,
          also,
        ),
      );
    }
    return process.exit(1);
  };
  if (muteAutomation) {
    if (!args.muteAutomation) {
      say('  mute: the run taken up was muted, and so is this part of it');
    }
    try {
      mute = await muteForRun(async () => muteOrgOf(conns.get(args.target)!), targetAutomation, {
        writes: runWrites,
      });
      for (const line of muteLines(mute.muted, args.target)) say(`  ${line}`);
    } catch (err: unknown) {
      if (!isMuteRefusedError(err)) throw err;
      if (!args.dryRun) {
        recordClone({ outcome: 'stopped', code: err.code, context: runAudit().context() });
        endRefused(err.refusal);
      }
      muteRefused = err.refusal;
      say(`  ${wouldBeRefusedLine(err.refusal)}`);
    }
  }
  /** What the run's gate reads: what the mute keeps quiet held quiet. */
  const gated = mute?.automation ?? targetAutomation;
  const automationStop = automationRefusal(gated, args.target, {
    updated,
    // The sets that keep it quiet, which --mute-automation assigns under a
    // lease: never a command assigning them by hand, with the user's name.
    assign: bypassesToAssign(
      gated,
      runBypassesOf(
        gated,
        updated.map((object) => object.objectApiName),
      ),
    ),
    // Relayed by a command that does not mute — an environment's apply —,
    // the mute is not offered.
    mayMute: !muteAutomation && relayTakes('--mute-automation'),
  });
  runAudit().automationRead({ automation: gated }, updated);
  if (automationStop && args.acceptAutomation) runAudit().confirm('automation');
  // Whether the target delivers the emails of what still runs, read once the
  // mute's plan says what does, and only when something may send one, as the
  // user the run writes as. A rehearsal is left out: its emails never leave
  // the call that fails on purpose. No Apex runs in a production org, which a
  // dry run reads: it is typed for it here, the one read a run with nothing
  // to send does not pay for.
  const emails = args.rehearse
    ? undefined
    : await runEmailsOf({
        read: targetAutomation,
        ...(mute?.plan ? { plan: mute.plan } : {}),
        writes: runWrites,
        applyAssignmentRules: args.applyAssignmentRules,
        readDeliverability: async () => {
          const org = conns.get(args.target)!;
          const typed = typedTarget ?? (await typeOrg(org));
          return productionRefusal(args.target, typed, 'clone') !== undefined
            ? NO_APEX_IN_PRODUCTION
            : readEmailDeliverability(org);
        },
        accepted: args.acceptEmails,
        target: args.target,
        run: 'clone',
        keepsAddresses: args.keepContactPoints,
        mayMute: !muteAutomation && relayTakes('--mute-automation'),
      });
  if (emails?.gate.line !== undefined) say(`  ${emails.gate.line}`);
  runAudit().emailsRead(emails?.gate.audit);
  if (emails?.gate.verdict === 'asks' && args.acceptEmails) runAudit().confirm('emails');
  const emailsStop = emails?.gate.stop;
  /**
   * What a dry run says a real run would be refused for, each in its own
   * words and with the code a real run is refused with: given with --json
   * under `wouldBeRefused` and `wouldBeRefusedCodes`, where a pipeline reads
   * them, as the lines say them on stderr.
   */
  const dryRunRefusals: RunRefusal[] = muteRefused !== undefined ? [muteRefused] : [];
  const notAccepted = automationStop !== undefined && !args.acceptAutomation;
  if ((notAccepted || emailsStop) && !args.dryRun) {
    recordClone({
      outcome: 'stopped',
      code: notAccepted ? 'AUTOMATION_NOT_ACCEPTED' : EMAILS_NOT_ACCEPTED,
      context: runAudit().context(),
    });
    // Both at once: a CI job told of one, then of the other, runs twice.
    if (notAccepted) {
      endRefused(
        { code: 'AUTOMATION_NOT_ACCEPTED', message: automationStop },
        emailsStop ? [emailsStop] : [],
      );
    }
    if (emailsStop) endRefused(emailsStop);
  }
  if (notAccepted) {
    dryRunRefusals.push({ code: 'AUTOMATION_NOT_ACCEPTED', message: automationStop });
    say(
      '  a real run would be refused (AUTOMATION_NOT_ACCEPTED): it writes nothing without ' +
        '--accept-automation: see what fires as it inserts and updates, or could not be read, ' +
        'above',
    );
  }
  if (emailsStop) {
    dryRunRefusals.push(emailsStop);
    say(`  ${wouldBeRefusedLine(emailsStop)}`);
  }
  await stopIfInterrupted();

  say('record-type mapping…');
  const requestsBeforeRecordTypes = requestsSent();
  const namespaceWarnings: string[] = [];
  const recordTypeMappings = await loadRecordTypes(
    conns.get(args.source)!,
    conns.get(args.target)!,
    (line) => namespaceWarnings.push(line),
  );
  const recordTypeCalls = requestsSent() - requestsBeforeRecordTypes;
  say(`record-types: ${recordTypeMappings.length} mappings`);
  for (const line of namespaceWarnings) say(`  warning: ${line}`);
  await stopIfInterrupted();

  /** The statements read through the org's cursor, and the pages the org answered them in. */
  const pagedReads = { statements: 0, pages: 0 };
  /**
   * Whether the target took a write of the run: what keeps the checkpoint it
   * took first, however the run ends. One that wrote nothing deletes it.
   */
  let wroteToTarget = false;
  const noting = <T extends { success: boolean }>(outcomes: T[]): T[] => {
    if (outcomes.some((outcome) => outcome.success)) wroteToTarget = true;
    return outcomes;
  };
  const executorDeps: ForgeExecutorDeps = {
    queryRecords: async (orgId, soql, onTruncated) => {
      const c = conns.get(orgId);
      if (!c) throw new Error(`No connection for ${orgId}`);
      // `query` answers with its first page alone, 2 000 records at most: the
      // command read a bigger scope short where the extension, which follows
      // the cursor, read all of it.
      const { records, truncated } = await queryAllPages<Record<string, unknown>>(
        {
          query: async (q) => c.query<Record<string, unknown>>(q),
          queryMore: async (url) => c.queryMore<Record<string, unknown>>(url),
        },
        soql,
        args.readCeiling,
      );
      if (truncated) onTruncated?.();
      return records;
    },
    // Each page as the org answers it, the next asked once the one before
    // is taken: the paged read, which the diagnostic's pages go through. A
    // read asked to take the archived activities goes through the org's
    // `queryAll`, as the extension's does: dropped here, the read would go
    // through `query` and leave them out without a word.
    queryPages: (orgId, soql, options) => {
      const c = conns.get(orgId);
      if (!c) throw new Error(`No connection for ${orgId}`);
      pagedReads.statements++;
      return cursorPages<Record<string, unknown>>(
        {
          query: async (q) => {
            pagedReads.pages++;
            return c.query<Record<string, unknown>>(q);
          },
          queryAll: async (q) => {
            pagedReads.pages++;
            return c.query<Record<string, unknown>>(q, { scanAll: true });
          },
          queryMore: async (url) => {
            pagedReads.pages++;
            return c.queryMore<Record<string, unknown>>(url);
          },
        },
        soql,
        options,
      );
    },
    countRecords: async (orgId, soql, options) => {
      const c = conns.get(orgId);
      if (!c) throw new Error(`No connection for ${orgId}`);
      return (await c.query(soql, options?.all ? { scanAll: true } : undefined)).totalSize;
    },
    // The org's currency settings: whether advanced currency management is
    // on, which the user's access to dated rates cannot always tell.
    queryTooling: async (orgId, soql) => {
      const c = conns.get(orgId);
      if (!c) throw new Error(`No connection for ${orgId}`);
      return (await c.tooling.query<Record<string, unknown>>(soql)).records;
    },
    insertRecords: async (orgId, name, records) => {
      if (args.dryRun) return records.map(() => ({ id: '', success: true, errors: [] }));
      const c = conns.get(orgId);
      if (!c) throw new Error(`No connection for ${orgId}`);
      // A clone is a deliberate duplicate; see `forgeWriteHeaders`. Without
      // this header every root Account of a real UAT → DEV run was refused
      // with DUPLICATES_DETECTED, and its whole graph skipped behind it. The
      // target's assignment rules stay off unless asked: the run sets owners.
      const r = await c.sobject(name).create(records, {
        headers: forgeWriteHeaders({ applyAssignmentRules: args.applyAssignmentRules }),
      });
      // With the records a blocking duplicate rule matched: the run links a
      // row the target already holds to the one record the refusal names.
      return noting(toSaveOutcomes(r, name));
    },
    updateRecords: async (orgId, name, records) => {
      if (args.dryRun) return [];
      const c = conns.get(orgId);
      if (!c) throw new Error(`No connection for ${orgId}`);
      // The records the run writes again — the lookups the second pass fills
      // in, the statuses given back — look like the target's as much as they
      // did at insert: a rule that blocks an edit refuses them all the same.
      const r = await c.sobject(name).update(records as unknown as { Id: string }[], {
        headers: forgeWriteHeaders({ applyAssignmentRules: args.applyAssignmentRules }),
      });
      const arr = Array.isArray(r) ? r : [r];
      // With each error's code and fields, as the panel reads them.
      return noting(
        arr.map((x, i) => ({
          id: x.id ?? (records[i]['Id'] as string) ?? '',
          success: x.success,
          errors: (x.errors ?? []).map(formatSaveError),
          errorDetails: (x.errors ?? []).map(saveErrorDetail),
        })),
      );
    },
    describeFields: async (orgId, name) => {
      const meta = await describe(orgId, name);
      const controllers = controllersOf(meta.fields);
      return meta.fields.map<FieldInfo>((f) => ({
        name: f.name,
        type: f.type,
        queryable: true,
        createable: f.createable ?? false,
        isReference: f.type === 'reference',
        referenceTo: (f.referenceTo ?? []).filter((r): r is string => typeof r === 'string'),
        nillable: f.nillable ?? true,
        picklistValues: (f.picklistValues ?? [])
          .filter((p) => p?.active !== false && typeof p?.value === 'string')
          .map((p) => p.value as string),
        restrictedPicklist: f.restrictedPicklist === true,
        ...(f.controllerName ? { controllerName: f.controllerName } : {}),
        defaultedOnCreate: f.defaultedOnCreate === true,
        // What --upsert matches by. Left out, no field was a key, and every
        // --upsert run inserted, as the extension's describe never did.
        externalId: f.externalId === true,
        updateable: f.updateable !== false,
        // What an email address or a phone number is neutralized within.
        ...(f.length > 0 ? { length: f.length } : {}),
        // What a dry run checks each row against, as the extension does.
        ...fieldBoundsOf(f, controllers),
      }));
    },
    isObjectCreatable: async (orgId, name) => (await describe(orgId, name)).createable !== false,
    // The key prefix a duplicate's id must carry, and the record types the
    // running user may use, from the describe already cached for the object.
    describeObject: async (orgId, name) => {
      const c = conns.get(orgId);
      if (!c) throw new Error(`No connection for ${orgId}`);
      return describeObjectInfo(c, name);
    },
    // The same, asked of the org again once the mute's lease assigned a
    // permission set, which may have opened record types to the user.
    describeObjectAgain: async (orgId, name) => {
      const c = conns.get(orgId);
      if (!c) throw new Error(`No connection for ${orgId}`);
      return describeObjectInfo(c, name, true);
    },
    // What a record type allows of the object's picklists, in one UI API
    // request the run keeps for every row of that record type.
    recordTypePicklists: async (orgId, name, recordTypeId) => {
      const c = conns.get(orgId);
      if (!c) throw new Error(`No connection for ${orgId}`);
      return readRecordTypePicklists(c, name, recordTypeId);
    },
    // Surface upsert path so re-runs against the same source records
    // don't pile DUPLICATE_VALUE errors on objects with external Id fields.
    upsertRecords: async (orgId, name, externalIdField, records) => {
      if (args.dryRun) return records.map(() => ({ id: '', success: true, errors: [] }));
      const c = conns.get(orgId);
      if (!c) throw new Error(`No connection for ${orgId}`);
      const r = await c.sobject(name).upsert(records, externalIdField, {
        headers: forgeWriteHeaders({ applyAssignmentRules: args.applyAssignmentRules }),
      });
      return noting(toSaveOutcomes(r, name));
    },
    // What --files reads and writes: one file per request each way, and the
    // target's file storage before any of them.
    readFileBody: async (orgId, objectApiName, id) => {
      const c = conns.get(orgId);
      if (!c) throw new Error(`No connection for ${orgId}`);
      return readFileBody(c, objectApiName, id);
    },
    insertFile: async (orgId, objectApiName, record) => {
      if (args.dryRun) return { id: '', success: true, errors: [] };
      const c = conns.get(orgId);
      if (!c) throw new Error(`No connection for ${orgId}`);
      const [inserted] = noting([await insertFile(c, objectApiName, record)]);
      return inserted;
    },
    remainingFileStorageMB: async (orgId) => {
      const c = conns.get(orgId);
      if (!c) throw new Error(`No connection for ${orgId}`);
      return remainingFileStorageMB(c);
    },
    requestsSent,
    // The owner of an opportunity the run sends without one, whose team the
    // platform writes with it: what a dry run links a team row to, as the
    // rehearsal below and the run do.
    runningUser: async (orgId) => {
      const c = conns.get(orgId);
      if (!c) throw new Error(`No connection for ${orgId}`);
      return (await c.identity()).user_id;
    },
  };

  // A rehearsal instead of the run: every row read and prepared by the run's
  // own executor, with a writer that keeps the rows instead of writing them,
  // then a sample created in the target in calls each rolled back whole.
  if (args.rehearse) {
    const target = conns.get(args.target)!;
    const headers = forgeWriteHeaders({ applyAssignmentRules: args.applyAssignmentRules });
    say(
      '\nrehearsing… (the rows are read and prepared as the run would; nothing stays in the target)',
    );
    let rehearsal: ForgeRehearsal;
    try {
      rehearsal = await rehearse({
        prepare: async (writer) => {
          await new ForgeExecutor(rehearsalExecutorDeps(executorDeps, writer)).execute(
            graph,
            args.source,
            args.target,
            () => {},
            {
              ...executeOptions(args, graph, recordTypeMappings, (fields) =>
                discovery.personalFields(fields),
              ),
              dryRun: false,
              files: undefined,
            },
          );
        },
        keyPrefixOf: async (name) => (await describeObjectInfo(target, name)).keyPrefix,
        // The owner of an opportunity the run sends without one, whose team
        // the platform writes with it.
        runningUser: async () => (await target.identity()).user_id,
        composite: (body) =>
          target.request({
            method: 'POST',
            url: '/composite',
            body: JSON.stringify(body),
            headers: { 'Content-Type': 'application/json', ...headers },
          }),
        apiPath: `/services/data/v${target.version}`,
        writeHeaders: headers,
        recordTypeNames: new Map(
          recordTypeMappings.map((m) => [m.targetId.slice(0, 15), m.developerName]),
        ),
        // What a refusal of a package's record type says of the target's own of its name.
        targetRecordTypes: targetRecordTypesOf(executorDeps, args.target),
        // Why a restricted picklist refused a value, as the target's describe says it.
        targetFields: (name) => executorDeps.describeFields(args.target, name),
        // The rule a validation refusal is of, from the rules the read of the
        // target's metadata listed above: one the mute lifts is said lifted.
        validationRules: async () => validationRulesOf(targetGaps.gaps),
        // Nobody to ask: --rehearse is the request, and --accept-automation
        // the acceptance of what the target runs, as for a real run.
        confirm: async (rehearsalPlan) => {
          say('');
          for (const line of rehearsalPlanLines(rehearsalPlan, args.target)) say(line);
        },
        onProgress: (progress) => {
          if (progress.phase === 'rehearsing') say(`  call ${progress.call} of ${progress.calls}…`);
        },
      });
    } catch (err: unknown) {
      if (err instanceof RehearsalNotRolledBackError) {
        process.stderr.write(`${err.message}\n`);
        process.exit(1);
      }
      throw err;
    }
    const elapsedMs = elapsedSince(t0);
    // What the target refused, on stderr under --json as every other line:
    // the JSON alone left the terminal at the last call's progress line.
    say('');
    for (const line of rehearsalLines(
      rehearsal,
      args.target,
      liftedByMute ? { lifted: liftedByMute } : {},
    )) {
      say(line);
    }
    if (args.json) {
      process.stdout.write(
        JSON.stringify(
          {
            tool: 'sandforge-clone',
            version: 1,
            action: 'rehearse',
            source: args.source,
            target: args.target,
            ...(targetOrgId ? { targetOrgId } : {}),
            record: args.record,
            graph: graphJson(graph, plan),
            targetAutomation,
            rehearsal: rehearsalJson(rehearsal, liftedByMute),
            elapsedMs,
          },
          null,
          2,
        ) + '\n',
      );
    } else {
      console.log(`\ndone in ${elapsedMs}ms`);
    }
    return;
  }

  // Preflight: pre-count rows on the target for every node in the graph so
  // the user sees how much data already exists before pulling the trigger.
  // Skip with --skip-preflight if it's slow on big graphs (10s+ on 100 nodes).
  if (!args.skipPreflight) {
    say('\npreflight (target row counts)…');
    const targetConn = conns.get(args.target)!;
    const sample = graph.nodes.slice(0, 30); // cap to first 30 to keep it snappy
    const preflight: Array<{ name: string; existing: number }> = [];
    for (const n of sample) {
      try {
        const r = await targetConn.query(`SELECT COUNT() FROM ${n.objectApiName}`);
        preflight.push({ name: n.objectApiName, existing: r.totalSize });
      } catch {
        preflight.push({ name: n.objectApiName, existing: -1 });
      }
    }
    const nonZero = preflight.filter((p) => p.existing > 0);
    if (nonZero.length === 0) {
      say('  target is empty for all sampled objects.');
    } else {
      const top = nonZero.sort((a, b) => b.existing - a.existing).slice(0, 10);
      say(`  ${nonZero.length}/${preflight.length} sampled objects have existing rows. Top 10:`);
      for (const p of top) {
        const flag = p.existing > 1000 ? '  ⚠' : '';
        say(`    ${p.name.padEnd(40)} ${String(p.existing).padStart(8)}${flag}`);
      }
      if (graph.nodes.length > sample.length) {
        say(
          `  (sampled first ${sample.length}/${graph.nodes.length} nodes; --skip-preflight to bypass)`,
        );
      }
    }
  }
  await stopIfInterrupted();

  // Every row in hand and none written: the records the run is about to
  // write, per object, and the data storage they take, held to --max-total
  // and to what the target has left. A dry run says what a real run would
  // meet there, and writes nothing.
  const targetConn = conns.get(args.target)!;
  /**
   * What a dry run's gate counted as the write would have begun: per object
   * the records, the storage they take and the emails they send, and in all
   * the records `--max-total` holds a run to — with why some emails were not
   * counted, when what sends them could not be read, and what was read and is
   * not counted (`leftOut`), the rows the platform writes itself among them.
   * Given with --json under `writePlan`: an environment holds the real run to
   * this count, so a scope that grew since its dry run is refused, not written.
   */
  let dryRunWritePlan:
    | {
        totalRows: number;
        storageBytes: number;
        objects: WritePlan['objects'];
        leftOut?: WritePlan['leftOut'];
        emails?: Array<{ limit: string; emails: number }>;
        emailsUncounted?: string;
        emailSendersOfNothingWritten?: EmailSender[];
      }
    | undefined;
  /**
   * The checkpoint the run takes first, as its gate scoped it: what it is
   * asked to hold and what it would hold and cost. A dry run gives it with
   * --json under `checkpoint`.
   */
  let checkpointPlanned: { ask: CommandCheckpointAsk; estimate: RunCheckpointEstimate } | undefined;
  /**
   * What refused a real run at its gate beside the first reason, each under
   * its own code: given under `alsoRefused`, each on its line, as Autopilot
   * gives them. The first code alone, a CI job told of one was refused again
   * for the next.
   */
  let alsoRefusedAtGate: RunRefusal[] = [];
  const beforeWrite = async (boundary: ForgeWriteBoundary): Promise<void> => {
    const plan = writePlanOf(boundary.objects);
    let storage: DataStorage | { unread: string };
    try {
      storage = await readDataStorage(targetConn);
    } catch (err: unknown) {
      storage = { unread: extractErrorMessage(err) };
    }
    const check = storageCheckOf(plan, storage);
    say('');
    for (const line of writePlanLines(plan, check, args.target)) say(line);
    // The daily API requests the rows take of the target, read with its
    // storage, or on their own when the storage could not be read: a clone
    // into an org whose integrations had spent the day's requests stopped part
    // way through, its records refused with REQUEST_LIMIT_EXCEEDED.
    const budget: ApiBudget | { unread: string } | undefined =
      'unread' in storage
        ? await readApiBudget(targetConn).catch((err: unknown) => ({
            unread: extractErrorMessage(err),
          }))
        : storage.dailyApiRequests;
    // The checkpoint asked first, scoped from the objects the rows go to and
    // what still runs as they go in — what the mute keeps quiet held quiet —
    // before its requests are counted with the run's: they are among them.
    let checkpointFailed: string | undefined;
    if (checkpoints && plan.totalRows > 0) {
      const writing = new Set(plan.objects.map(({ objectApiName }) => objectApiName));
      const ask: CommandCheckpointAsk = {
        written: boundary.objects
          .map(({ objectApiName }) => objectApiName)
          .filter((name) => writing.has(name)),
        running: { firing: stillRunningOf(gated, undefined, runWrites).firing },
      };
      try {
        checkpointPlanned = { ask, estimate: await checkpoints.scope(ask) };
      } catch (err: unknown) {
        checkpointFailed = beforeRunFailedWords(err).replace(/ Nothing was written\.$/, '');
      }
    }
    const gate = forgeWriteBudgetOf({
      plan,
      updatedAfterInsert: [...updatedNames],
      ...(boundary.readBack !== undefined ? { readBack: boundary.readBack } : {}),
      ...(checkpointPlanned ? { checkpoint: checkpointPlanned.estimate } : {}),
      ...deliverabilityPartOf(emails?.ofRun),
      budget,
      target: args.target,
    });
    say(apiRequestsLine(gate.api, args.target));
    if (checkpointPlanned) {
      for (const line of checkpointEstimateLines(checkpointPlanned.estimate)) say(line);
    }
    // The emails the target's flows send as these records go in, against what
    // it has left today, as the target counts them — a Developer Edition's
    // email alerts against its single emails too: read only when they send
    // some. Past them, the run is refused, as Autopilot's and Seed's are: a
    // clone of 36 contacts into a Developer Edition said its alerts fitted in
    // the workflow emails, and took its single emails from −75 to −117.
    const sending = emailsPerInsertOf(gated);
    let overEmails: string | undefined;
    let emailCounts: Array<{ limit: string; emails: number }> | undefined;
    if (sending.length > 0) {
      const limits = await readEmailLimits(targetConn).catch((err: unknown) => ({
        unread: extractErrorMessage(err),
      }));
      const emails = countedEmailChecksOf(plan, sending, limits);
      for (const line of emailCheckLines(emails, args.target)) say(line);
      overEmails = emailRefusal(emails, args.target);
      emailCounts = emails.map((check) => ({ limit: check.limit, emails: check.emails }));
    }
    // What sends and could not be read counted as sending nothing, and the
    // lines said no word of it, a flow a package installed among them, which
    // no one reads. It is said, as Sync and Autopilot say it, and refuses
    // nothing: --accept-automation, without which a run that fires anything
    // unread writes nothing, already covers it.
    const emailsUncounted = emailsUncountedOf(gated, insertsOf(plan));
    if (emailsUncounted !== undefined) {
      say(`  emails: not counted, ${emailsUncounted} could not be read`);
    }
    const overTotal =
      plan.totalRows > args.maxTotal
        ? maxTotalRefusal(plan.totalRows, args.maxTotal, args.dryRun)
        : undefined;
    const overStorage = storageRefusal(check, args.target);
    // The checkpoint's refusal in the command's words, and the requests past
    // what the target has left, each said whatever else refuses the run.
    const checkpointRefused =
      checkpointFailed ??
      (gate.stop?.refusal !== undefined ? checkpointRefusedWords(gate.stop.refusal) : undefined);
    const overBudget = apiBudgetRefusal(gate.api, args.target)?.replace(
      / Nothing was written\.$/,
      '',
    );
    // Each under the code a real run refused for it alone is refused with.
    const refusals = (
      [
        [CHECKPOINT_REFUSED, checkpointRefused],
        ['MAX_TOTAL_EXCEEDED', overTotal],
        ['STORAGE_EXCEEDED', overStorage],
        ['EMAILS_EXCEEDED', overEmails],
        [API_BUDGET_EXCEEDED, overBudget],
      ] as const
    ).flatMap(([code, message]): Array<{ code: ForgeRunGateErrorCode; message: string }> =>
      message !== undefined ? [{ code, message }] : [],
    );
    if (boundary.dryRun) {
      for (const refusal of refusals) say(`  ${wouldBeRefusedLine(refusal)}`);
      dryRunRefusals.push(...refusals);
      // What the refusal for the emails named before a row was read, of an
      // object the run writes nothing of: said here, where the rows are known.
      const idleSenders =
        emailsStop && emails ? sendersOfNothingWritten(emails.ofRun.senders, plan) : [];
      const idleLine = sendersOfNothingWrittenLine(idleSenders);
      if (idleLine !== undefined) say(idleLine);
      dryRunWritePlan = {
        totalRows: plan.totalRows,
        storageBytes: plan.storageBytes,
        objects: plan.objects,
        ...(plan.leftOut ? { leftOut: plan.leftOut } : {}),
        ...(emailCounts !== undefined ? { emails: emailCounts } : {}),
        ...(emailsUncounted !== undefined ? { emailsUncounted } : {}),
        ...(idleSenders.length > 0 ? { emailSendersOfNothingWritten: idleSenders } : {}),
      };
      return;
    }
    if (refusals.length > 0) {
      const words = (message: string): string => `${message} Nothing was written.`;
      alsoRefusedAtGate = refusals
        .slice(1)
        .map(({ code, message }) => ({ code, message: words(message) }));
      throw new ForgeRunGateError(refusals[0].code, words(refusals[0].message));
    }
  };

  say(
    `\nexecuting… (${args.dryRun ? 'DRY-RUN' : 'REAL'}${args.tables ? ', WHOLE TABLES' : ''}${args.upsert ? ', UPSERT' : ''}${args.expandOrphans ? ', EXPAND-ORPHANS' : ''}${args.applyAssignmentRules ? ', ASSIGNMENT-RULES' : ''}${args.files ? ', FILES' : ''}${args.pageSize !== undefined ? `, READ IN PAGES OF ${args.pageSize}` : ''})`,
  );
  // The record types were read for the run, before the executor had it: the
  // extension counts them among its calls. A summary that counts none is left
  // so, as the extension leaves it: theirs alone would read as the run's.
  const withRecordTypeCalls = (counted: ExecutionSummary): ExecutionSummary =>
    counted.apiCalls === undefined
      ? counted
      : { ...counted, apiCalls: counted.apiCalls + recordTypeCalls };
  /**
   * The summary --json prints and --summary writes, of the run as `counted`
   * has it at `at`: the whole run once it ended, what it has created so far
   * while it goes, what it had created when it was stopped.
   *
   * @param ended - How the run ended, once it did: first in `result`, as
   *   Sync and Seed give it. A run that ended with refusals was said only by
   *   its counts, and a CI job reading the summary took it for a success.
   */
  const runDocument = (
    counted: ExecutionSummary,
    at: Date,
    state: { running?: true; interrupted?: true; error?: string } = {},
    ended?: ForgeRunStatus,
  ) => ({
    tool: 'sandforge-clone',
    version: 1,
    source: args.source,
    target: args.target,
    // The org the run wrote to, by its own id: a removal goes to that org and
    // to no other, whatever alias names it by then.
    ...(targetOrgId ? { targetOrgId } : {}),
    // The record it cloned from, or the tables it read, each under its condition.
    ...(args.tables ? { objects: args.tables } : { record: args.record }),
    dryRun: args.dryRun,
    upsert: args.upsert,
    expandOrphans: args.expandOrphans,
    // Whether the run's writes let the target's assignment rules apply.
    applyAssignmentRules: args.applyAssignmentRules,
    files: args.files !== undefined,
    // The file the run's choices came from, and the decisions it held: those
    // the run applied are in result.decisionsApplied, with their rows.
    ...(args.choicesFrom
      ? {
          choices: {
            from: args.choicesFrom.flag,
            file: args.choicesFrom.path,
            ...(args.decisions ? { decisions: args.decisions } : {}),
          },
        }
      : {}),
    graph: graphJson(graph, plan),
    // What the target runs on the objects the run writes, read before the
    // run: flows, triggers, processes and workflow rules per object, what of
    // them sends messages or runs after commit, the assignment and duplicate
    // rules, the custom permissions that keep a flow quiet and whether the
    // user the run writes as holds them, and what could not be read; and
    // whether it delivers the emails of what still runs, read only when
    // something may send one.
    targetAutomation: emails?.ofRun.read
      ? { ...targetAutomation, deliverability: emails.ofRun.read.reading }
      : targetAutomation,
    // What the run muted of it, asked with --mute-automation: the permission
    // sets assigned to its user for the run, what they silenced, what still
    // ran, what they lifted beside, and whether they were taken back. Of a
    // dry run, what a real one would do, and the plan it is made from.
    ...(mutedAutomation ? { mutedAutomation } : args.dryRun ? dryRunMuteOf(mute) : {}),
    // What may refuse a removal of the run's records, per object: the flows
    // before a delete, the Apex triggers on one, the records that lock past
    // Draft.
    removalRisks,
    // What the target holds against the rows, read from its metadata before
    // the run: each gap with its kind, severity, object, field and the
    // decisions it allows, and the decision of the run that answers it
    // (`answeredBy`); what could not be read, and what the read cost.
    targetGaps: gapsWithAnswers(targetGaps, gapDecisions),
    // Of a dry run, the changes to the target's metadata that would let the
    // rows go in as they are, for whoever administers it: none for a rule the
    // mute lifts.
    ...dryRunAdminChanges(args.dryRun, targetGaps, counted.gaps, liftedByMute),
    // The external ids --upsert may match by that the run writes neutralized.
    ...(upsertKeys.length > 0 ? { neutralizedUpsertKeys: upsertKeys } : {}),
    result: {
      ...(ended ? { status: ended } : {}),
      ...jsonResult(counted, args.readCeiling),
    },
    // Of a dry run, what its gate counted, and what a real run would be refused for.
    ...(args.dryRun && dryRunWritePlan !== undefined ? { writePlan: dryRunWritePlan } : {}),
    // The checkpoint it took of what it writes before its first write
    // (--checkpoint-first): kept, or deleted once it wrote nothing; of a dry
    // run, what a real run's would hold and cost.
    ...checkpointDocument(),
    ...(args.dryRun ? wouldBeRefusedJson(dryRunRefusals) : {}),
    elapsedMs: elapsedSince(t0, at.getTime()),
    finishedAt: at.toISOString(),
    // The journal the run wrote as it went, and its part: where the ids are
    // past the bound, and what --resume takes the run up from.
    ...(journalPath && journalStore ? { journal: journalPath } : {}),
    ...(journalPart() !== undefined ? { part: journalPart() } : {}),
    ...state,
  });

  /** The checkpoint the run took before its first write, once taken. */
  let checkpointTaken: RunCheckpointTaken | undefined;
  /** What became of it once the run ended: kept, or deleted for a run that wrote nothing. */
  let checkpointInfo: RunCheckpointInfo | undefined;
  /** The checkpoint as the summary gives it: the dry run's estimate, the run's checkpoint. */
  const checkpointDocument = (): {
    checkpoint?: RunCheckpointEstimate | RunCheckpointInfo;
  } => {
    const checkpoint = args.dryRun
      ? checkpointPlanned?.estimate
      : (checkpointInfo ?? checkpointTaken);
    return checkpoint !== undefined ? { checkpoint } : {};
  };
  /**
   * Keep the checkpoint the run took first once it wrote a record, whatever
   * became of it after; delete it when it wrote none. Once, as the run ends.
   */
  const settleCheckpoint = async (): Promise<void> => {
    if (!checkpoints || !checkpointTaken || checkpointInfo) return;
    try {
      checkpointInfo = await checkpoints.settle(checkpointTaken, wroteToTarget);
    } catch (err: unknown) {
      // Only its deletion can fail: kept, and said, never the run's failure.
      checkpointInfo = checkpointTaken;
      say(
        `warning: the checkpoint '${checkpointTaken.name}' taken before the run, which wrote ` +
          `nothing, could not be deleted (${extractErrorMessage(err)}): delete it with ` +
          `sandforge-checkpoint delete --org ${args.target} --checkpoint ${checkpointTaken.checkpointId}`,
      );
    }
    for (const line of checkpointSettledLines(checkpointInfo)) say(line);
  };

  // The journal the run writes as it goes: begun with how the run was set up,
  // or the journal of the run it takes up, gone on in as a part of its own.
  let journalStore: ForgeRunStore | undefined;
  let journalId: string | undefined;
  if (journals && targetOrgId !== undefined) {
    if (journalPath && args.resume) {
      await journals.resumingAt(journalPath);
      journalId = (await journals.headAt(journalPath))?.journalId;
    } else {
      journalId = `sandforge-clone-${new Date(t0).toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
      journalPath = journals.pathOf(journalId);
      await journals.begin(journalId, targetOrgId, new Date(), {
        sourceOrgId: args.source,
        fingerprint,
        targetSalesforceOrgId: targetOrgId,
        ...(args.record ? { recordId: args.record } : {}),
        // Kept for the run to be muted again when it is taken up.
        ...(args.muteAutomation ? { muteAutomation: true as const } : {}),
        // The command's own choices are in the fingerprint: `cliRunSetup`. A
        // clone of whole tables keeps the config it ran with, its filters and
        // the objects it left out, which the summary of its journal names.
        startedWith: { graph, config: runConfig },
      });
    }
    journalStore = journals.openAt(journalPath);
    // An environment never takes a run up: stopped, its next apply takes the
    // run back and runs it whole, its state knowing nothing of a --resume.
    say(
      relayedByAnEnvironment()
        ? `journal: ${journalPath}`
        : `journal: ${journalPath} (--resume ${journalPath} takes the run up if it stops)`,
    );
  }
  /** The part of the journal this run writes, once it began it. */
  const journalPart = (): number | undefined =>
    journalStore && journalStore.partCount > 0 ? journalStore.partCount - 1 : undefined;
  /**
   * Say in the journal how the part ended, once the run is over: a part that
   * wrote nothing — stopped at its gate — taken up from another leaves that
   * one's end, and a run of its own that wrote nothing leaves no journal.
   */
  const endJournal = async (status: ForgeRunPartEnd, wrote: boolean): Promise<void> => {
    if (!journals || !journalPath || !journalStore) return;
    journalStore.close();
    const path = journalPath;
    try {
      if (!wrote && resumedEnd) await journals.stopAt(path, resumedEnd.status, resumedEnd.forgeId);
      else if (!wrote && !args.resume) {
        rmSync(path, { force: true });
        rmSync(path.replace(/\.ndjson$/, '.end.json'), { force: true });
      } else await journals.stopAt(path, status, `${journalId ?? 'run'}#${journalPart() ?? 0}`);
    } catch (err: unknown) {
      process.stderr.write(
        `The journal ${path} could not be ended (${extractErrorMessage(err)}).\n`,
      );
    }
  };

  let summary: ExecutionSummary;
  const outcomeLine = objectOutcomePrinter(graph);
  const executor = new ForgeExecutor(executorDeps);
  // The summary file follows the run object after object: a process killed
  // part way leaves what the run had created by the last object it ended,
  // which --remove takes back. A file that cannot be written is said once.
  let summaryUnwritable = false;
  const keepSummary = (document: unknown): void => {
    if (!args.summary) return;
    const failure = writeWhole(args.summary, document);
    if (failure && !summaryUnwritable) {
      summaryUnwritable = true;
      process.stderr.write(`The summary could not be written to ${args.summary} (${failure}).\n`);
    }
  };
  let rowsKept = -1;
  const keepSoFar = (): void => {
    const soFar = executor.summarySoFar();
    if (!soFar) return;
    const rows = soFar.successCount + soFar.linkedCount + soFar.updatedCount + soFar.failedCount;
    if (rows === rowsKept) return;
    rowsKept = rows;
    keepSummary(runDocument(withRecordTypeCalls(soFar), new Date(), { running: true }));
  };
  // From here a Ctrl-C stops the run between two calls to the org, as Abort
  // does in the panel, and the summary says what it had created by then.
  // Killed outright, a clone printed nothing, and --remove had nothing to
  // take it back from.
  running.executor = executor;
  await stopIfInterrupted(() => endJournal('cancelled', false));
  // The lease is taken as late as it can be: once the gate has let the rows
  // through, just before the first is written — the executor hands every row
  // to `beforeWrite` before it writes one. Taken before the executor had the
  // run, it held the bypass through every read of the rows. The executor
  // gives it back once its last write is through, before it reads back the
  // record types the target gave; it is given back again as the run ends,
  // written, failed, stopped or thrown alike, before anything is said of it.
  let held: HeldMute | undefined;
  const leaseAtTheGate = async (
    boundary: ForgeWriteBoundary,
  ): Promise<ForgeWriteGateAnswer | undefined> => {
    await beforeWrite(boundary);
    if (boundary.dryRun || args.dryRun) return undefined;
    // The checkpoint asked first is taken once the gate let the rows through,
    // the flag the answer a question would have had, and before the lease:
    // the bypass is held for the writes alone, and the lease dates no record
    // the checkpoint holds.
    if (checkpoints && checkpointPlanned && !checkpointTaken) {
      const planned = checkpointPlanned;
      const took = await takeCheckpointFirst(() =>
        checkpoints.take(planned.ask, planned.estimate, { signal: runController.signal }),
      );
      if ('stop' in took) {
        if (took.stop.code !== CHECKPOINT_REFUSED) {
          throw new CheckpointTakeInterrupted(checkpointStopWords(took.stop));
        }
        throw new ForgeRunGateError(CHECKPOINT_REFUSED, checkpointStopWords(took.stop));
      }
      checkpointTaken = took.checkpoint;
      for (const line of checkpointTakenLines(took.checkpoint, args.target, muteAutomation)) {
        say(line);
      }
    }
    if (!mute?.prepared || held) return undefined;
    const lease = await mute.prepared
      .acquire(`sandforge-clone ${t0}`)
      .catch(async (err: unknown) => {
        if (!isMuteRefusedError(err)) throw err;
        recordClone({ outcome: 'stopped', code: err.code, context: runAudit().context() });
        // Refused before its first write: the checkpoint taken for it goes.
        await settleCheckpoint();
        return endRefused(err.refusal);
      });
    held = lease;
    mutedAutomation = lease.outcome;
    // A set the lease does not hold leaves running what it was to keep quiet:
    // a sender of it the run was not refused for refuses it now, and the
    // run's end gives the lease back, nothing written.
    const relit = emails?.afterLease(lease.outcome, args.acceptEmails);
    if (relit) throw new ForgeRunGateError(relit.code, relit.message);
    return {
      lease: { assigned: lease.outcome.assigned.length, giveBack: () => lease.release() },
    };
  };
  try {
    const executed = await executor
      .execute(
        graph,
        args.source,
        args.target,
        (event) => {
          const line = outcomeLine(event);
          if (line) say(line);
          if (args.summary && OBJECT_ENDS.has(event.status)) keepSoFar();
        },
        withTheJournal(
          {
            // A clone of whole tables goes as the panel's run of a query goes:
            // each table read and written page by page.
            ...(args.tables
              ? tablesExecuteOptions(args, runConfig, graph, recordTypeMappings, (fields) =>
                  discovery.personalFields(fields),
                )
              : executeOptions(args, graph, recordTypeMappings, (fields) =>
                  discovery.personalFields(fields),
                )),
            beforeWrite: leaseAtTheGate,
          },
          journalStore,
        ),
      )
      .finally(async () => {
        if (held) {
          mutedAutomation = await held.release();
          for (const line of muteLines(mutedAutomation, args.target)) say(line);
        }
      });
    summary = withRecordTypeCalls(executed);
    await settleCheckpoint();
    // The diagnostic says what went through the cursor, as the paged read it shows.
    if (args.pageSize !== undefined) {
      say(
        `read in pages of ${args.pageSize}: ${pagedReads.statements} statement(s) through the ` +
          `org's cursor, ${pagedReads.pages} page(s) answered`,
      );
    }
  } catch (err: unknown) {
    // Ctrl-C while the checkpoint was taken first: nothing of it was kept,
    // and nothing written, recorded stopped before it started.
    if (err instanceof CheckpointTakeInterrupted) {
      recordClone({
        outcome: 'stopped',
        code: ABORTED_BEFORE_START,
        context: runAudit().context(),
      });
      await endJournal('cancelled', false);
      say(err.message);
      process.exit(stopExitCode(interrupted ?? 'SIGINT'));
    }
    // A checkpoint taken first is kept once the run wrote a record, and
    // deleted when it wrote none, before what the run did is said.
    await settleCheckpoint();
    // Recorded as the panel records a run that did not end: stopped at its
    // gate under the gate's code, or for its files under theirs, as the panel
    // records the files it was not to copy; stopped by Ctrl-C, partial once
    // it wrote; failed otherwise, with what it wrote before it threw.
    const gate = err instanceof ForgeRunGateError ? err : undefined;
    const filesRefused = err instanceof ForgeFilesRefusedError ? err : undefined;
    const refusedBefore = gate ?? filesRefused;
    const stoppedPartial = refusedBefore ? undefined : partialSummaryOf(err);
    const tallies = stoppedPartial ? auditTalliesOf(stoppedPartial) : undefined;
    const objects = tallies ? forgeAuditObjects(tallies) : [];
    const cancelled = interrupted !== undefined || err instanceof ForgeAbortedError;
    const stoppedOutcome = refusedBefore
      ? 'stopped'
      : cancelled
        ? cancelledRunOutcome(stoppedPartial, objects)
        : 'failure';
    recordClone({
      outcome: stoppedOutcome,
      ...(refusedBefore
        ? { code: refusedBefore.code }
        : stoppedOutcome === 'stopped'
          ? { code: RUN_CANCELLED }
          : {}),
      ...(tallies
        ? {
            objects,
            ...(sourceOrgId ? { source: { origin: 'org' as const, orgId: sourceOrgId } } : {}),
            carried: forgeCarried(tallies),
          }
        : {}),
      ...contactPointsAudit(stoppedPartial?.contactPoints),
      context: runAudit().context(stoppedPartial?.decisionsApplied),
    });
    // Refused before anything was written — the files do not fit in the
    // target, its storage could not be read, or the files could not all be
    // looked up in the source; the records are more than --max-total, or
    // more than the target's data storage has left: said as it is, not as a
    // crash.
    const wrote =
      stoppedPartial !== undefined &&
      stoppedPartial.successCount + stoppedPartial.updatedCount + stoppedPartial.linkedCount > 0;
    await endJournal(cancelled ? 'cancelled' : 'failure', wrote);
    // Refused for its files, it said a sentence with no code and left stdout
    // empty: a CI job could not tell files too big from a crash.
    if (refusedBefore) {
      endRefused(
        { code: refusedBefore.code, message: refusedBefore.message },
        gate ? alsoRefusedAtGate : [],
      );
    }
    const partial = stoppedPartial;
    if (partial && (interrupted !== undefined || err instanceof ForgeAbortedError)) {
      const document = runDocument(withRecordTypeCalls(partial), new Date(), {
        interrupted: true,
      });
      keepSummary(document);
      if (args.json) {
        process.stdout.write(JSON.stringify(document, null, 2) + '\n');
      } else {
        console.log('');
        for (const line of summaryLines(partial, args.dryRun, args.readCeiling)) console.log(line);
      }
      say(interruptedLine(args.summary));
      process.exit(stopExitCode(interrupted ?? 'SIGINT'));
    }
    // A failure past the first objects: what the run had created by then is
    // kept for --remove before the failure is said.
    if (partial) {
      keepSummary(
        runDocument(withRecordTypeCalls(partial), new Date(), { error: extractErrorMessage(err) }),
      );
    }
    throw err;
  } finally {
    interrupts.release?.();
  }

  await endJournal('success', true);

  // The run's entry, as the panel records a run that ended: per object what it
  // created, updated and lost, what it carried from the source, the contact
  // points it neutralized, and how it was set up.
  const tallies = auditTalliesOf(summary);
  // How it ended, as its entry, its summary, its first line and its exit code say it.
  const status = finishedRunStatus(summary);
  recordClone({
    outcome: status,
    objects: forgeAuditObjects(tallies),
    ...(sourceOrgId ? { source: { origin: 'org' as const, orgId: sourceOrgId } } : {}),
    carried: forgeCarried(tallies),
    ...contactPointsAudit(summary.contactPoints),
    context: runAudit().context(summary.decisionsApplied),
  });

  // When the run ended, on this machine's clock: a removal dates by it a run
  // whose writes the target did not date, as the wizard dates a history entry.
  const finishedAt = new Date();
  const elapsed = elapsedSince(t0, finishedAt.getTime());

  // Machine-readable summary for CI/automation. Stable schema. The summary
  // file, when asked for, takes the run's end over what it said as it went:
  // kept before the CSV is written, which could fail once every record was
  // written and left the run with no summary but its journal.
  const document = runDocument(summary, finishedAt, {}, status);
  keepSummary(document);

  // BA reconciliation export. Written before the JSON/text summary so a
  // post-execute script can pick it up by tailing the file. Its path was
  // checked before any org was reached (`remapCsvArg`); written only where no
  // file is, a file made there since is not overwritten either.
  let remapRefused: string | undefined;
  if (args.remapCsv) {
    const lines = ['sourceId,targetId'];
    for (const [src, tgt] of Object.entries(summary.remapTable)) {
      // Both IDs are validated SF IDs (15/18 alphanum) — safe to embed
      // without quoting. Defense: in case a future source returns
      // something odd, double-quote both columns to neutralize commas.
      lines.push(`"${src.replace(/"/g, '""')}","${tgt.replace(/"/g, '""')}"`);
    }
    try {
      writeFileSync(args.remapCsv, lines.join('\n') + '\n', { encoding: 'utf8', flag: 'wx' });
      say(
        `remap-csv: wrote ${Object.keys(summary.remapTable).length} mappings to ${args.remapCsv}`,
      );
    } catch (err: unknown) {
      remapRefused =
        (err as NodeJS.ErrnoException | undefined)?.code === 'EEXIST'
          ? `--remap-csv refuses to overwrite existing file: "${args.remapCsv}"`
          : `--remap-csv ${args.remapCsv} could not be written: ${extractErrorMessage(err)}`;
    }
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(document, null, 2) + '\n');
  } else {
    console.log('');
    console.log(`status:  ${status}`);
    const muteAssigns = (mute?.plan?.assign.length ?? 0) > 0;
    for (const line of summaryLines(summary, args.dryRun, args.readCeiling, muteAssigns)) {
      console.log(line);
    }
    console.log(`\ndone in ${elapsed}ms`);
  }
  if (remapRefused !== undefined) {
    process.stderr.write(`${remapRefused}: the summary names what the run created.\n`);
    process.exit(1);
  }
  // Of the run, as Sync's and Seed's: 1 when it produced only failures, 0 when
  // it did part of its work, unless --fail-on-partial, which makes it 3.
  const code = runExitCode(status, args.failOnPartial);
  if (code !== 0) process.exit(code);
}

// Only when run as a script: importing the module must not start a clone.
if (/sandforge-clone\.[cm]?[jt]s$/.test(process.argv[1] ?? '')) {
  holdOutputWhole();
  main().catch((err) => {
    console.error('FATAL:', err instanceof Error ? err.stack : err);
    process.exit(1);
  });
}
