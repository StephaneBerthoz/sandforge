#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * sandforge-clone — headless record-scoped clone CLI.
 *
 * Wraps the production discovery + scoped-execute pipeline so devs can
 * run a Forge from the terminal without opening VSCode. The script
 * delegates org auth to the `sf` CLI (`sf org display`) and reuses the
 * exact same orchestrator/executor as the wizard.
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
 *     --remove <summary.json> --target <alias> [--include-changed] [--accept-automation] [--json]
 *       [--audit <file>]
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
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { Connection, DescribeSObjectResult } from 'jsforce';
import { z } from 'zod';
import { countRequests, loadOrg, makeConn } from './sfSession.js';
import { fileConfigStore } from './fileConfigStore.js';

import type {
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
  ForgeRunObjectRecords,
  ForgeTemplateInput,
  ForgeUndoObjectResult,
  ForgeUndoStatus,
} from '@sandforge/shared';
import {
  BYTES_PER_MB,
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
  forgeWriteHeaders,
  formatFileSize,
  leftOutAsEmptyTable,
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
import { ForgeAbortedError, ForgeExecutor } from '../src/modules/forge/ForgeExecutor.js';
import { queryAllPages } from '../src/modules/forge/queryAllPages.js';
import { controllersOf, fieldBoundsOf } from '../src/modules/forge/describeBounds.js';
import { withObjectsLeftOut } from '../src/modules/forge/stages/ScopeResolver.js';
import {
  runAnonymization,
  type ForgeAnonymizationMethods,
  type PIIFieldInfo,
} from '../src/modules/forge/ForgeAnonymizer.js';
import {
  runDecisionsOf,
  type ForgeRunDecisions,
} from '../src/modules/forge/stages/RunDecisions.js';
import type {
  ExecuteOptions,
  ExecutionSummary,
  ForgeExecutorDeps,
  ForgeProgressEvent,
  ForgeWriteBoundary,
  FieldInfo,
  TargetObjectInfo,
} from '../src/modules/forge/ForgeExecutor.js';
import { RecordTypeMapper } from '../src/modules/sync/RecordTypeMapper.js';
import type { RecordTypeInfo, RecordTypeMapping } from '../src/modules/sync/RecordTypeMapper.js';
import {
  PIIDetector,
  contactPointOf,
  personalFieldsByApiName,
} from '../src/core/precheck/PIIDetector.js';
import { formatSaveError, toSaveOutcomes } from '../src/core/common/existingRecordMatch.js';
import { parseRecordTypeInfos } from '../src/core/metadata/recordTypeAvailability.js';
import { readRecordTypePicklists } from '../src/core/metadata/recordTypePicklists.js';
import { describePicklistChange } from '../src/modules/forge/stages/RecordTypePicklists.js';
import { ForgeFilesRefusedError } from '../src/modules/forge/stages/FileCopier.js';
import {
  insertFile,
  readFileBody,
  remainingFileStorageMB,
} from '../src/modules/forge/fileTransfer.js';
import {
  removalOrg,
  removeRunRecords,
  setBackToDraftOf,
  type RunRemovalOutcome,
} from '../src/modules/forge/ForgeRunRemoval.js';
import {
  removalAuditObjects,
  removalAuditOutcome,
  removalStatus,
} from '../src/modules/forge/removalOutcome.js';
import { recordWriteRun } from '../src/modules/audit/auditTrail.js';
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
import { finishedRunStatus } from '../src/modules/forge/runResult.js';
import {
  TargetAutomationReader,
  answerOf,
  automationLines,
} from '../src/modules/forge/TargetAutomationReader.js';
import { TargetGapReader, gapFieldOf, gapLines } from '../src/modules/forge/TargetGapReader.js';
import {
  DEFAULT_MAX_TOTAL,
  ForgeRunGateError,
  automationRefusal,
  bypassesToAssign,
  emailCheckLines,
  emailChecksOf,
  isDeveloperEdition,
  objectsUpdatedAfterInsert,
  removalAutomationLines,
  removalAutomationRefusal,
  runBypassesOf,
  readDataStorage,
  readEmailLimits,
  removalRiskLines,
  storageCheckOf,
  storageRefusal,
  writePlanLines,
  writePlanOf,
  type DataStorage,
} from '../src/modules/forge/ForgeRunGate.js';
import { partialSummaryOf } from '../src/modules/forge/interruptedRun.js';
import { extractErrorMessage } from '../src/core/common/extractErrorMessage.js';
import type { ForgeRehearsal } from '@sandforge/shared';
import { rehearsalExecutorDeps } from '../src/modules/forge/rehearsal/RehearsalWriter.js';
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

export interface CliArgs {
  record: string;
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
  /** The most records a run may write in all; past it, nothing is written (`--max-total`). */
  maxTotal: number;
  /**
   * Rehearse the clone instead of writing it (`--rehearse`): a sample of its
   * rows created in the target in calls each rolled back whole, for the
   * platform's verdict on every one. Nothing stays in the target.
   */
  rehearse: boolean;
  /**
   * The decisions taken on Review's Gaps tab, from `--config` or `--template`:
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
}

/** The flags that read a run's choices from a file. */
type ChoicesFlag = '--config' | '--template';

const HELP = `sandforge-clone — Forge a record-scoped clone from a source org to a target sandbox,
or remove what a run of it created.

Usage:
  pnpm exec tsx packages/extension/cli/sandforge-clone.ts \\
    --record <id> --source <alias> --target <alias> [options]
  pnpm exec tsx packages/extension/cli/sandforge-clone.ts \\
    --remove <summary.json> --target <alias> [--include-changed] [--accept-automation] [--json]
      [--audit <file>]
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
  given with the permission set of the target that holds it and the
  sf org assign permset command that would assign it, never run.

  It then says what the target holds against the rows, read from its
  metadata: its active validation rules and what keeps them quiet, its
  active duplicate rules and whether each blocks an insert or lets it
  through, the fields only the target requires that the clone does not
  write, the lookup filters of the lookups it writes, and the daily API
  requests the target has left against those the run takes (with --json,
  under targetGaps). None of it stops the clone.

  Once every row is read and before the first is written, the clone counts
  the records it is about to write, per object, and the data storage they
  take by the sizes Salesforce documents. It writes nothing past --max-total,
  nor more than the target's data storage has left. It says the emails the
  target's flows send as the records go in, against the daily limits it has
  left: past them, a record whose flow fails in the save is refused.

Required:
  --record <id>          Source record ID (any object type — prefix detected automatically);
                         may come from --template instead
  --source <alias>       sf CLI alias of the source org
  --target <alias>       sf CLI alias of the target sandbox

Options:
  --depth <mode>         direct | full | custom    (default: custom)
  --custom-depth <n>     traversal depth when --depth=custom    (default: 5)
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
                         the cap, as do the items of an activated order. Each
                         parent a record reached cannot be written without
                         takes the cap one object further, up to twice it.
                         An empty table takes no place under it, and nothing
                         is reached through it; discovery reads four times
                         the cap in objects at most.
  --anonymize            anonymize PII fields                   (default: off)
  --keep-contact-points  write emails and phone numbers as read (default: off)
                         Off, every record is written with its email addresses
                         under .invalid and its phone numbers in a fictional
                         range, anonymized or not, so the target's flows and
                         email alerts reach no one. On, they may reach the
                         real people the records name.
  --dry-run              skip writes, surface scoped queries    (default: off)
                         It reads the automation and counts the records as a
                         real run does, and says what would stop that run.
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
  --max-total <n>        most records the run may write in all  (default: 10000)
                         Counted once every row is read: past it, nothing is
                         written. --max caps each object, this the whole run.
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
  --summary <file>       write the summary to <file> as the run goes
                         The JSON --json prints, written after each object
                         with what the run has created so far ("running":
                         true), then whole once it ends. Ctrl-C stops the run
                         between two calls to the org and writes what it had
                         created by then ("interrupted": true), as --json then
                         prints it: --remove takes the run back from either.
                         A file already there is not overwritten. Not with
                         --list-objects or --rehearse.
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
                         taken on Review's Gaps tab (picklistValueMappings,
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
                         given; a template of a query needs --record. Not
                         with --config.
  --remap-csv <file>     write the source→target ID remap table to a CSV
                         file (header: sourceId,targetId). BA reconciliation:
                         "where did source X go on the target sandbox?"
  --files                copy the files of the cloned records   (default: off)
                         Salesforce Files (the latest version of each) and
                         attachments, after the records they hang on. The
                         total is checked against the target's file storage
                         before anything is written.
  --max-file-size <MB>   largest file --files copies, 1 to 35   (default: 10)
                         A larger file is left out and listed, never cut.
  --files-as-is          accept that files are copied as they are: their
                         content cannot be anonymized. Required with --files
                         when --anonymize is on.
  --audit <file>         record the run in an audit trail kept in <file>
                         The entry the panel keeps in Reports -> Audit Trail:
                         per object the records created, updated and lost,
                         the orgs, the outcome, the user as a hash of the
                         username, and, for a run refused before it wrote,
                         the code of what refused it. Counts only, never a
                         value of a record. Each run adds its entry to the
                         file; a dry run, --list-objects and --rehearse write
                         nothing, and add none.
  -h, --help             show this help and exit

Remove what a run created:
  --remove <file>        the summary a run printed with --json, saved to a file
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
  --include-changed      remove also the records changed since the run, and
                         what was added to them since           (default: kept)
  --accept-automation    delete although the target runs flows, Apex triggers,
                         processes or workflow rules as the records go —
                         before or after a delete, or as an activated order
                         is set back to Draft for its delete — or could not
                         say what it runs                       (default: off)
  --json                 print what became of the records as JSON on stdout,
                         every other line on stderr
  --audit <file>         record the removal in the audit trail kept in <file>

Verify what a run created:
  --verify <file>        the summary a run printed with --json, saved to a file
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
                         line on stderr
  --audit <file>         record the verification in the audit trail kept in
                         <file>

Exit codes:
  0  the clone ran; the rehearsal ran, whatever it found refused; the removal
     took every record it set out to take
  1  the clone or the removal could not run; the clone produced only failures,
     or its files were refused; the target is a production org; the target
     runs automation on insert or on the updates the clone makes after its
     inserts, or the removal's deletes fire automation, and
     --accept-automation was not given; the run would write more than
     --max-total records, or more than the target's data storage has left
     (nothing is written or deleted then)
  2  a bad command line, or a summary --remove cannot take a run back from, or
     a file beside it that is not what a removal kept there
  3  the removal left records of the run in the org: kept, or refused, or
     found neither in the org nor in its recycle bin, as the user it ran as
     sees them
  130  Ctrl-C stopped the clone: the summary says what it created by then
`;

/** A 15- or 18-character Salesforce ID. */
const SF_ID_RE = /^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$/;

/** An SObject or field API name — the pattern the ForgeConfig schema enforces. */
const API_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;

/** What refused a field rows were written again without, as the summary says it. */
const REFUSED_IT: Readonly<Record<ForgeFieldRefusal, string>> = {
  'validation-rule': 'a validation rule refused it',
  'restricted-picklist': 'a restricted picklist refused its value',
  'lookup-filter': 'a lookup filter refused the record it names',
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

/** The command line read and checked; exits on `--help` or a bad flag. Exported so it can be tested. */
export function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    process.stdout.write(HELP);
    process.exit(0);
  }
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

  const templateRecord =
    template?.config.inputMode === 'record' ? template.config.recordId : undefined;
  if (template && !has('--record') && !templateRecord) {
    process.stderr.write(
      `--template: the template clones from a ${template.config.inputMode === 'record' ? 'record it does not name' : 'query'}, ` +
        'and the command clones from a record: give --record.\n',
    );
    process.exit(2);
  }
  const record = get('--record') ?? templateRecord;
  const source = get('--source');
  const target = get('--target');
  if (!record || !source || !target) {
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
    inputMode: 'record',
    recordId: record,
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

  return {
    record,
    source,
    target,
    depth: checked.data.depth,
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
    summary,
    fieldExclusions,
    excludedObjects,
    ownerMappings,
    objectSoqlFilters,
    fieldMappings,
    remapCsv: get('--remap-csv'),
    files,
    acceptAutomation: has('--accept-automation'),
    maxTotal,
    rehearse: has('--rehearse'),
    decisions,
    anonymizationRules: { ...template?.anonymization?.rules },
    anonymizeFields: template?.anonymization?.fields,
    choicesFrom: choicesFlag && choicesPath ? { flag: choicesFlag, path: choicesPath } : undefined,
    audit: auditArg(args),
  };
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

/** Match the active record types of both orgs; exported so the match can be tested. */
export async function loadRecordTypes(
  sourceConn: Connection,
  targetConn: Connection,
): Promise<RecordTypeMapping[]> {
  // SobjectType is read so the match stays within one object: Account and
  // Opportunity can each have a "Business" record type.
  const soql = 'SELECT Id, Name, DeveloperName, SobjectType FROM RecordType WHERE IsActive = true';
  type RecordTypeRow = { Id: string; Name: string; DeveloperName: string; SobjectType: string };
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
    sobjectType: r.SobjectType,
  });
  return new RecordTypeMapper().buildMapping(s.map(toInfo), tgt.map(toInfo));
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
 * the field describe of the same object filled. Exported so it can be tested.
 */
export async function describeObjectInfo(
  conn: Connection,
  objectName: string,
): Promise<TargetObjectInfo> {
  const meta = await conn.describe$(objectName);
  return {
    keyPrefix: meta.keyPrefix ?? null,
    recordTypes: parseRecordTypeInfos(meta.recordTypeInfos),
  };
}

/**
 * Whether a run failed outright: records failed, or the read of an object did,
 * and none was created, updated or linked, nor — for a dry run — would have
 * been inserted. A failed read counts no record — the clone never learned how
 * many of its rows it held — so a run whose every read failed has none failed.
 * A run that linked what it could not create, or wrote over what its external
 * ids matched, has done part of its job. Exported so it can be tested.
 */
export function failedOutright(summary: ExecutionSummary): boolean {
  const settled =
    summary.successCount + summary.updatedCount + summary.linkedCount + summary.wouldInsertCount;
  const failed = summary.failedCount > 0 || summary.failedReads.length > 0;
  return failed && settled === 0;
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
 * The text summary of a run. Records the target already held are named apart
 * from the created and the failed ones: linked is neither, and a duplicate
 * nobody could identify is a failure whose children lost their lookup.
 * Exported so it can be tested.
 *
 * @param dryRun - Whether the run wrote nothing, for the files it would copy.
 */
export function summaryLines(summary: ExecutionSummary, dryRun = false): string[] {
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
    `linked:  ${summary.linkedCount} (already in the target, not created)`,
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
      'may be in the target, under ids the run never learned (--remove cannot reach them):',
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
  if (typeof detail['colliding'] === 'number') {
    parts.push(`${detail['colliding']} value(s) already in the target`);
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
  const lines = [
    `choices from ${args.choicesFrom.flag} ${args.choicesFrom.path}, the flags over it:`,
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
      return `  ${entry.object}.${gap?.field ?? '?'}  skip_rows "${gap?.value ?? ''}"${scope(gap?.recordType)}`;
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
      "contact points: written as read (--keep-contact-points): the target's flows and email " +
        'alerts may reach the people the records name',
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
 * The `result` of the `--json` summary, a stable schema for CI.
 *
 * `remapTable` maps every source id the run gave a counterpart in the target.
 * `existingSourceIds` names the entries the target already held and
 * `updatedSourceIds` the ones `--upsert` wrote over, so the table's other
 * entries are exactly the records the run created. Exported so it can be
 * tested.
 */
export function jsonResult(summary: ExecutionSummary) {
  return {
    successCount: summary.successCount,
    // Written over by `--upsert`: the target held them before the run.
    updatedCount: summary.updatedCount,
    // Neither created nor failed: the target already held these records —
    // it named them, or they were matched by name — and their children link
    // to them.
    linkedCount: summary.linkedCount,
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
    // Only with --files: what became of the files. The ones copied are in
    // remapTable too, under their document or attachment id.
    ...(summary.files ? { files: summary.files } : {}),
    // Per object, the fields left empty because they hold a file's content;
    // only when there were any.
    ...(summary.fileContentFieldsLeftOut
      ? { fileContentFieldsLeftOut: summary.fileContentFieldsLeftOut }
      : {}),
    // Per object and field, the picklist values replaced or left out, with
    // why; only when there were any.
    ...(summary.picklistValuesChanged
      ? { picklistValuesChanged: summary.picklistValuesChanged }
      : {}),
    // Per object, the rows written again without the fields a validation rule
    // or a restricted picklist refused, each field with what refused it
    // (`refusedBy`) and the refusal; only when there were any.
    ...(summary.writtenWithoutFields ? { writtenWithoutFields: summary.writtenWithoutFields } : {}),
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
 * Exported so it can be tested.
 */
export function objectOutcomeLine(event: ForgeProgressEvent): string | undefined {
  // What a dry run's read brings is a step the simulated write ends: printed
  // as it was before the write was simulated, the line the read says it on.
  if (event.status === 'running' && event.message.startsWith('[dry-run] ')) {
    return `  ${event.message}`;
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
      return `  Skipped ${emptyTables.size} objects (excluded: empty tables; --list-objects names them)`;
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
  return (
    `graph: ${graph.nodes.length} objects at a cap of ${maxNodes}${emptyNote}${raised}, ` +
    `${included} included; ` +
    `${graph.edges.length} lookups, ${between} between these objects; ` +
    `${plan.waves.length} waves, ${plan.cycleResolutions.length} cycles` +
    (graph.truncated ? ' (TRUNCATED)' : '')
  );
}

/**
 * The `graph` of the `--json` summary, and of `--list-objects --json`: the
 * objects discovery described, the lookups it met, the plan's waves and
 * cycles, and whether discovery stopped at its cap before it had walked
 * everything.
 */
function graphJson(graph: ForgeGraph, plan: Pick<ForgePlan, 'waves' | 'cycleResolutions'>) {
  return {
    nodes: graph.nodes.length,
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
  };
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
      return { sent, fields: meta.fields.map(gapFieldOf) };
    },
    readDuplicateRules: async (orgId, fullNames) => {
      const answer: unknown = await conn(orgId).metadata.read('DuplicateRule', fullNames);
      return Array.isArray(answer) ? answer : [answer];
    },
    readLimits: async (orgId) => conn(orgId).request({ method: 'GET', url: '/limits' }),
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
 * and no sandbox nowhere to clone into, as the panel does not. Exported so it
 * can be tested.
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
export function rehearsalLines(rehearsal: ForgeRehearsal, target: string): string[] {
  const updates =
    rehearsal.updatesJudged > 0
      ? `; ${rehearsal.updatesJudged} update(s) judged, ${rehearsal.updatesPassed} would save, ` +
        `${rehearsal.updatesJudged - rehearsal.updatesPassed} refused`
      : '';
  const lines = [
    `rehearsed in ${target}: ${rehearsal.judged} judged, ${rehearsal.passed} would save, ` +
      `${rehearsal.judged - rehearsal.passed} refused, ${rehearsal.notJudged} not judged${updates} ` +
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
    lines.push(
      `  ${gap.severity === 'blocking' ? 'REFUSED' : 'refused'}  ${gap.objectApiName}${field}${value}${recordType}: ` +
        `${code}, ${gap.rows} row(s)${standsFor}` +
        (gap.detail?.writtenWithoutTheField === true
          ? ' (a real run writes it again without the field)'
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
  /** The file the removal's entry in the audit trail goes to; undefined = no entry. */
  audit: string | undefined;
}

/** The flags a removal reads. */
const REMOVE_FLAGS: ReadonlySet<string> = new Set([
  '--remove',
  '--target',
  '--include-changed',
  '--json',
  '--accept-automation',
  '--audit',
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
    if (!REMOVE_FLAGS.has(arg)) {
      process.stderr.write(
        `--remove takes --target, --include-changed, --accept-automation, --json and --audit, not "${arg}". ` +
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
  return {
    summaryPath,
    target,
    includeChanged: has('--include-changed'),
    json: has('--json'),
    acceptAutomation: has('--accept-automation'),
    audit: auditArg(args),
  };
}

/** A Salesforce id, as every id of a summary is. */
const summaryIdSchema = z.string().regex(SF_ID_RE, 'not a Salesforce id');

/** A date as the command writes one, `toISOString()`. */
const summaryDateSchema = z.iso.datetime();

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
  record: z.string(),
  dryRun: z.literal(false),
  elapsedMs: z.number().nonnegative(),
  finishedAt: summaryDateSchema.optional(),
  result: z.object({
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
  }),
});

/** A summary a removal can take its run back from. */
export type RunSummary = z.infer<typeof runSummarySchema>;

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
    `the clone of ${summary.record} wrote to ${args.target}${ended ? ` until ${ended}` : ''}; ` +
      `a removal deletes the ${planned} record(s) it created, children first:`,
    ...plan.map((object) => `  ${object.objectApiName}: ${object.ids.length}`),
    `${stay} record(s) the target already held, which the run linked to or wrote over, stay`,
    args.includeChanged
      ? 'records changed since the run go too, and what was added to them since'
      : 'records changed since the run stay, as do those records added since depend on ' +
        '(--include-changed takes them)',
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
      `  ${o.objectApiName}: ${removalCounts(o) || 'nothing'} of ${o.planned}`,
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
});

/** What a removal keeps beside the summary for the next one. */
export type RunRemovals = z.infer<typeof runRemovalsSchema>;

/** What earlier removals of a run left on its records, for the next removal to be told. */
export type EarlierRemovals = Pick<RunRemovals, 'removalStamps' | 'removalSpans' | 'removalLeft'>;

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
  const { removalStamps, removalSpans, removalLeft } = parsed.data;
  return { earlier: { removalStamps, removalSpans, ...(removalLeft ? { removalLeft } : {}) } };
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
 */
export function removalsAfter(
  run: string,
  earlier: EarlierRemovals | undefined,
  outcome: Pick<RunRemovalOutcome, 'stamps' | 'span'> & { gone?: readonly string[] },
  plan: readonly ForgeRunObjectRecords[] = [],
): RunRemovals | undefined {
  const gone = new Set(outcome.gone ?? []);
  if (Object.keys(outcome.stamps).length === 0 && !outcome.span && gone.size === 0) {
    return undefined;
  }
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
  const read = parseRunSummary(text);
  if ('refusal' in read) {
    process.stderr.write(`--remove ${args.summaryPath} ${read.refusal}\n`);
    process.exit(2);
  }
  const { summary } = read;
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
  /**
   * @param removalsFile - Where what the removal left on the run's records
   *   was kept, when it was.
   */
  const output = (
    status: ForgeUndoStatus,
    objects: ForgeUndoObjectResult[],
    orgId?: string,
    removalsFile?: string,
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
            },
            ...(removalsFile ? { removalsFile } : {}),
            elapsedMs: Date.now() - t0,
          },
          null,
          2,
        ) + '\n',
      );
      return;
    }
    for (const line of removalLines(status, objects, unreachable)) console.log(line);
    if (removalsFile) {
      console.log(
        `what this removal left on the run's records is kept in ${removalsFile}, ` +
          'which the next --remove of this summary reads',
      );
    }
    console.log(`\ndone in ${Date.now() - t0}ms`);
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

  say(`sandforge-clone --remove  ${args.summaryPath}  from ${args.target}`);
  // What earlier removals took is not planned again, as the panel plans only
  // what a run's history entry says is left (`forgeRemovalPlanLeft`).
  const plan = forgeRemovalPlanLeft({
    objects: created,
    removalLeft: before.earlier?.removalLeft,
  });
  const count = (objects: readonly ForgeRunObjectRecords[]): number =>
    objects.reduce((sum, object) => sum + object.ids.length, 0);
  removedEarlier = count(created) - count(plan);
  if (removedEarlier > 0) {
    say(`${removedEarlier} record(s) removed by an earlier --remove of this summary`);
  }
  if (plan.length === 0) {
    say('nothing left of the run to remove');
    output('success', []);
    return;
  }
  const session = await loadOrg(args.target);
  const conn = makeConn(session);
  const org = await typeOrg(conn);
  /** The removal's entry in the audit trail, with --audit; one operation id for the process. */
  const audited = new Map([[org.id, { alias: args.target, username: session.username }]]);
  const operationId = `sandforge-clone-${randomUUID()}`;
  const recordRemoval = (run: Omit<WriteRun, 'action' | 'module' | 'operationId' | 'orgId'>) =>
    recordCliRun(args.audit, audited, {
      action: 'cleanup_delete',
      module: 'forge',
      operationId,
      orgId: org.id,
      ...run,
    });
  const refusal = productionRefusal(args.target, org, 'remove');
  if (refusal) {
    recordRemoval({ outcome: 'stopped', code: 'PRODUCTION_TARGET' });
    process.stderr.write(`${refusal}\n`);
    process.exit(1);
  }
  if (summary.targetOrgId !== undefined && !sameRecord(summary.targetOrgId, org.id)) {
    process.stderr.write(
      `${args.target} is not the org the run wrote to (${summary.targetOrgId}), and its records ` +
        'are removed from that org only. Nothing was deleted.\n',
    );
    process.exit(1);
  }
  for (const line of removalPlanLines(summary, plan, args)) say(line);
  // What the target runs as the records go, said before the first delete,
  // and asked as the clone asks about what fires as it inserts: a removal
  // deletes, and what runs before or after a delete runs then, with what
  // fires as an activated order is set back to Draft for its delete.
  const removed = plan.map((object) => object.objectApiName);
  const drafted = setBackToDraftOf(removed);
  const automation = await targetAutomationReader(conn).read(args.target, removed);
  say('');
  for (const line of removalAutomationLines(automation, args.target, removed.length, drafted)) {
    say(line);
  }
  const automationStop = removalAutomationRefusal(automation, args.target, {
    drafted,
    assign: bypassesToAssign(
      automation,
      removalBypassesOf(automation, drafted),
      session.username ? { alias: args.target, username: session.username } : undefined,
    ),
  });
  if (automationStop && !args.acceptAutomation) {
    recordRemoval({ outcome: 'stopped', code: 'AUTOMATION_NOT_ACCEPTED' });
    process.stderr.write(`${automationStop}\n`);
    process.exit(1);
  }
  if (before.earlier) {
    say(
      `what earlier removals of this summary left on the run's records, read from ` +
        `${removalsFile}, is not a change since the run`,
    );
  } else if (before.otherRun) {
    say(
      `${removalsFile} is of another run: it is not read, and what this removal leaves on ` +
        'the records, if anything, takes its place',
    );
  }

  // Ctrl-C stops the removal before its next call to the org, as Cancel does
  // in the panel: an order it set to Draft for its delete gets its status
  // back on the way out, where a process killed outright left it a draft.
  const stop = new AbortController();
  const interrupt = (): void => stop.abort();
  process.once('SIGINT', interrupt);
  const span = summary.result.writtenBetween;
  let outcome: Awaited<ReturnType<typeof removeRunRecords>>;
  try {
    // The run's span as the target dated it, as the wizard passes a history
    // entry's. A run the target did not date is dated by its records and by
    // when it ended, read on the org's clock as the removal starts.
    outcome = await removeRunRecords(removalOrg(conn, 'sandforge-clone --remove'), plan, {
      ...(span
        ? { runStartedAt: new Date(span.first), runEndedAt: new Date(span.last) }
        : {
            runDurationMs: summary.elapsedMs,
            ...(summary.finishedAt ? { runRecordedAt: new Date(summary.finishedAt) } : {}),
          }),
      ...(before.earlier
        ? {
            removalStamps: before.earlier.removalStamps,
            removalSpans: before.earlier.removalSpans,
          }
        : {}),
      includeChanged: args.includeChanged,
      signal: stop.signal,
    });
  } finally {
    process.off('SIGINT', interrupt);
  }
  const status = removalStatus(outcome.objects, outcome.cancelled);
  // A removal after an earlier one of the summary takes what that one left,
  // as the panel records it: with when that one ended, by the org's clock.
  const leftBy = before.earlier?.removalSpans.at(-1)?.last;
  recordRemoval({
    outcome: removalAuditOutcome({ status, objects: outcome.objects }),
    objects: removalAuditObjects(outcome.objects),
    ...(leftBy ? { leftBy } : {}),
  });
  // Kept beside the summary whatever the removal ended on, cancelled
  // included, as the wizard adds it to the run's history. A file that cannot
  // be written is said, and the removal's own outcome stands: the next one may
  // then read what this one wrote as changes since the run.
  const removals = removalsAfter(run, before.earlier, outcome, plan);
  const failure = removals ? writeWhole(removalsFile, removals) : undefined;
  if (failure) {
    process.stderr.write(
      `What this removal left on the run's records could not be kept in ${removalsFile} ` +
        `(${failure}): a later --remove of this summary may keep a record this removal wrote ` +
        'to as changed since the run, which --include-changed then takes.\n',
    );
  }
  output(status, outcome.objects, org.id, removals && !failure ? removalsFile : undefined);
  if (status !== 'success') process.exit(RECORDS_LEFT_EXIT);
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
    const links =
      o.linksUnchecked !== undefined
        ? `lookups not checked (${o.linksUnchecked})`
        : o.linksChecked === 0
          ? 'no lookup the run set to check'
          : o.linksBroken === 0
            ? `lookups: ${o.linksChecked} checked, all hold`
            : `lookups: ${o.linksChecked} checked, ${o.linksBroken} do not hold`;
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
    if (o.recycleBinUnread !== undefined) {
      lines.push(`      the recycle bin could not be read (${o.recycleBinUnread})`);
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
  const read = parseRunSummary(text);
  if ('refusal' in read) {
    process.stderr.write(`--verify ${args.summaryPath} ${read.refusal}\n`);
    process.exit(2);
  }
  const { summary } = read;
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

  say(`sandforge-clone --verify  ${args.summaryPath}  in ${args.target}`);
  const session = await loadOrg(args.target);
  const conn = makeConn(session);
  const org = await typeOrg(conn);
  if (summary.targetOrgId !== undefined && !sameRecord(summary.targetOrgId, org.id)) {
    process.stderr.write(
      `${args.target} is not the org the run wrote to (${summary.targetOrgId}), and its records ` +
        'are verified in that org only.\n',
    );
    process.exit(1);
  }
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
        ? { runEndedAt: new Date(summary.result.writtenBetween.last) }
        : summary.finishedAt
          ? { runRecordedAt: new Date(summary.finishedAt) }
          : {}),
      ...(removalStamps ? { removalStamps } : {}),
      ...(written.success
        ? { writtenWithout: writtenWithoutByObject(written.data.result.writtenWithoutFields) }
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
          elapsedMs: Date.now() - t0,
        },
        null,
        2,
      ) + '\n',
    );
  } else {
    for (const line of verificationLines(verification, args.target)) console.log(line);
    console.log(`\ndone in ${Date.now() - t0}ms`);
  }
  const code = VERDICT_EXIT[verification.verdict];
  if (code !== 0) process.exit(code);
}

/** The exit code of a clone Ctrl-C stopped, as a shell gives a process SIGINT ended. */
const INTERRUPTED_EXIT = 130;

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

/**
 * Run one clone from the given command line, or one removal under `--remove`;
 * exported so its flag checks can be tested.
 */
export async function main(argv: string[] = process.argv): Promise<void> {
  if (argv.slice(2).includes('--verify')) return verifyMain(argv);
  if (argv.slice(2).includes('--remove')) return removeMain(argv);
  const t0 = Date.now();
  const args = parseArgs(argv);
  // In --json mode stdout carries the summary alone, for a parser to read: a
  // CI job that saved it to a file read the progress lines in front of the
  // JSON, and failed on them. What the run says on the way goes to stderr.
  const say = (line: string): void => (args.json ? console.error(line) : console.log(line));
  say(`sandforge-clone  ${args.source} -> ${args.target}  record=${args.record}`);
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
        inputMode: 'record',
        recordId: args.record,
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
  const recordClone = (run: Omit<WriteRun, 'action' | 'module' | 'operationId' | 'orgId'>) => {
    if (targetOrgId === undefined || args.dryRun || args.listObjects || args.rehearse) return;
    recordCliRun(args.audit, audited, {
      action: 'forge_execute',
      module: 'forge',
      operationId,
      orgId: targetOrgId,
      ...run,
    });
  };
  if (!args.dryRun && !args.listObjects) {
    const target = await typeOrg(conns.get(args.target)!);
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
  // Every request either org is sent: the run's calls are the record types'
  // read for it and those sent while the executor has it, as the extension
  // counts them; discovery's and the preflight's are not.
  const requestsOf = [...conns.values()].map(countRequests);
  const requestsSent = (): number => requestsOf.reduce((sum, sent) => sum + sent(), 0);

  const config: ForgeConfig = {
    inputMode: 'record',
    recordId: args.record,
    depth: args.depth,
    customDepth: args.depth === 'custom' ? args.customDepth : undefined,
    sourceOrgId: args.source,
    targetOrgId: args.target,
    anonymizePII: args.anonymize,
    skipEmpty: true,
    batchSize: 'auto',
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
    describeGlobal: async (orgId) => {
      const c = conns.get(orgId);
      if (!c) throw new Error(`No connection for ${orgId}`);
      const r = await c.describeGlobal();
      return r.sobjects.map((s) => ({ name: s.name, keyPrefix: s.keyPrefix ?? null }));
    },
  };

  say('discovery…');
  const discovery = new GraphDiscoveryService(discoveryDeps);
  const discovered = await discovery.discover(
    config,
    args.maxNodes === undefined ? undefined : { maxNodes: args.maxNodes },
  );
  const root = discovered.nodes[0]?.objectApiName;
  if (root !== undefined && args.excludedObjects.includes(root)) {
    process.stderr.write(
      `--exclude-object ${root}: the record to clone is of this object, and nothing would be ` +
        'left to clone.\n',
    );
    process.exit(2);
  }
  // Listed as excluded and out of the plan; the run leaves them out as well,
  // and those discovery never reached, which it would otherwise add.
  const graph = withTemplateFields(
    withObjectsLeftOut(discovered, new Set(args.excludedObjects)),
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
            record: args.record,
            graph: graphJson(graph, plan),
            objects: listed,
            elapsedMs: Date.now() - t0,
          },
          null,
          2,
        ) + '\n',
      );
    }
    return;
  }

  // What the target runs on the objects the run writes, said before anything
  // is written — on a dry run too, for the requests the read sends alone. Run
  // into a sandbox, a clone fired the target's record-triggered flows on every
  // record it created, and nothing said so before the run.
  const targetAutomation = await targetAutomationReader(conns.get(args.target)!).readForGraph(
    args.target,
    graph,
    new Set(args.excludedObjects),
  );
  say('');
  for (const line of automationLines(targetAutomation, args.target, {
    applyAssignmentRules: args.applyAssignmentRules,
    username: targetOrg.username,
  })) {
    say(line);
  }
  // What may refuse taking the run back, said before it writes: a flow before
  // a delete, a trigger on one, a record that locks past Draft.
  const removalRisks = removalRisksOf(targetAutomation, new Set(args.excludedObjects));
  for (const line of removalRiskLines(removalRisks, args.target)) say(line);
  // What that automation may reach: the records' own addresses and numbers,
  // unless they go neutralized.
  say(
    args.keepContactPoints
      ? 'contact points: written as read (--keep-contact-points)'
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
      excludedObjects: args.excludedObjects,
    },
  );
  say('');
  for (const line of gapLines(targetGaps, args.target, { username: targetOrg.username })) {
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
  // What fires as it updates the records it inserted is asked with it: in a
  // client's sandbox, a flow on orders sent each to an external system as the
  // clone gave it back its status.
  const updated = objectsUpdatedAfterInsert(graph, {
    leftOut: new Set(args.excludedObjects),
    upsert: args.upsert,
  });
  const automationStop = automationRefusal(targetAutomation, args.target, {
    updated,
    assign: bypassesToAssign(
      targetAutomation,
      runBypassesOf(
        targetAutomation,
        updated.map((object) => object.objectApiName),
      ),
      targetOrg.username ? { alias: args.target, username: targetOrg.username } : undefined,
    ),
  });
  runAudit().automationRead({ automation: targetAutomation }, updated);
  if (automationStop && args.acceptAutomation) runAudit().confirm('automation');
  if (automationStop && !args.acceptAutomation) {
    if (!args.dryRun) {
      recordClone({
        outcome: 'stopped',
        code: 'AUTOMATION_NOT_ACCEPTED',
        context: runAudit().context(),
      });
      process.stderr.write(`${automationStop}\n`);
      process.exit(1);
    }
    say(
      '  a real run writes nothing without --accept-automation: see what fires as it inserts ' +
        'and updates, or could not be read, above',
    );
  }

  say('record-type mapping…');
  const requestsBeforeRecordTypes = requestsSent();
  const recordTypeMappings = await loadRecordTypes(
    conns.get(args.source)!,
    conns.get(args.target)!,
  );
  const recordTypeCalls = requestsSent() - requestsBeforeRecordTypes;
  say(`record-types: ${recordTypeMappings.length} mappings`);

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
      );
      if (truncated) onTruncated?.();
      return records;
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
      return toSaveOutcomes(r, name);
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
      return arr.map((x, i) => ({
        id: x.id ?? (records[i]['Id'] as string) ?? '',
        success: x.success,
        errors: (x.errors ?? []).map(formatSaveError),
      }));
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
      return toSaveOutcomes(r, name);
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
      return insertFile(c, objectApiName, record);
    },
    remainingFileStorageMB: async (orgId) => {
      const c = conns.get(orgId);
      if (!c) throw new Error(`No connection for ${orgId}`);
      return remainingFileStorageMB(c);
    },
    requestsSent,
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
    const elapsedMs = Date.now() - t0;
    // What the target refused, on stderr under --json as every other line:
    // the JSON alone left the terminal at the last call's progress line.
    say('');
    for (const line of rehearsalLines(rehearsal, args.target)) say(line);
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
            rehearsal,
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

  // Every row in hand and none written: the records the run is about to
  // write, per object, and the data storage they take, held to --max-total
  // and to what the target has left. A dry run says what a real run would
  // meet there, and writes nothing.
  const targetConn = conns.get(args.target)!;
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
    // The emails the target's flows send as these records go in, against what
    // it has left today: read only when they send some. Past it, records are
    // refused one by one; the run is not stopped for it.
    const sending = emailsPerInsertOf(targetAutomation);
    if (sending.length > 0) {
      const limits = await readEmailLimits(targetConn).catch((err: unknown) => ({
        unread: extractErrorMessage(err),
      }));
      for (const line of emailCheckLines(emailChecksOf(plan, sending, limits), args.target)) {
        say(line);
      }
    }
    const overTotal =
      plan.totalRows > args.maxTotal
        ? `The run would write ${plan.totalRows} records, more than --max-total ` +
          `${args.maxTotal}: narrow the clone (--max, --exclude-object, --filter), or raise ` +
          '--max-total.'
        : undefined;
    const overStorage = storageRefusal(check, args.target);
    const reasons = [overTotal, overStorage].filter(
      (reason): reason is string => reason !== undefined,
    );
    if (boundary.dryRun) {
      for (const reason of reasons) say(`  a real run would be refused: ${reason}`);
      return;
    }
    if (reasons.length > 0) {
      throw new ForgeRunGateError(
        overTotal ? 'MAX_TOTAL_EXCEEDED' : 'STORAGE_EXCEEDED',
        `${reasons.join(' ')} Nothing was written.`,
      );
    }
  };

  say(
    `\nexecuting… (${args.dryRun ? 'DRY-RUN' : 'REAL'}${args.upsert ? ', UPSERT' : ''}${args.expandOrphans ? ', EXPAND-ORPHANS' : ''}${args.applyAssignmentRules ? ', ASSIGNMENT-RULES' : ''}${args.files ? ', FILES' : ''})`,
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
   */
  const runDocument = (
    counted: ExecutionSummary,
    at: Date,
    state: { running?: true; interrupted?: true; error?: string } = {},
  ) => ({
    tool: 'sandforge-clone',
    version: 1,
    source: args.source,
    target: args.target,
    // The org the run wrote to, by its own id: a removal goes to that org and
    // to no other, whatever alias names it by then.
    ...(targetOrgId ? { targetOrgId } : {}),
    record: args.record,
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
    // user the run writes as holds them, and what could not be read.
    targetAutomation,
    // What may refuse a removal of the run's records, per object: the flows
    // before a delete, the Apex triggers on one, the records that lock past
    // Draft.
    removalRisks,
    // What the target holds against the rows, read from its metadata before
    // the run: each gap with its kind, severity, object, field and the
    // decisions it allows; what could not be read, and what the read cost.
    targetGaps,
    // The external ids --upsert may match by that the run writes neutralized.
    ...(upsertKeys.length > 0 ? { neutralizedUpsertKeys: upsertKeys } : {}),
    result: jsonResult(counted),
    elapsedMs: at.getTime() - t0,
    finishedAt: at.toISOString(),
    ...state,
  });

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
  // Ctrl-C stops the run between two calls to the org, as Abort does in the
  // panel, and the summary says what it had created by then. Killed outright,
  // a clone printed nothing, and --remove had nothing to take it back from.
  // A second Ctrl-C ends the process at once.
  let interrupted = false;
  const interrupt = (): void => {
    interrupted = true;
    process.stderr.write(
      '\ninterrupted: the clone stops after the call under way, and says what it created ' +
        '(Ctrl-C again ends it at once)\n',
    );
    executor.abort();
  };
  process.once('SIGINT', interrupt);
  try {
    const executed = await executor.execute(
      graph,
      args.source,
      args.target,
      (event) => {
        const line = outcomeLine(event);
        if (line) say(line);
        if (args.summary && OBJECT_ENDS.has(event.status)) keepSoFar();
      },
      {
        ...executeOptions(args, graph, recordTypeMappings, (fields) =>
          discovery.personalFields(fields),
        ),
        beforeWrite,
      },
    );
    summary = withRecordTypeCalls(executed);
  } catch (err: unknown) {
    // Recorded as the panel records a run that did not end: stopped at its
    // gate under the gate's code; stopped by Ctrl-C, partial once it wrote;
    // failed otherwise, with what it wrote before it threw.
    const gate = err instanceof ForgeRunGateError ? err : undefined;
    const stoppedPartial = gate ? undefined : partialSummaryOf(err);
    const tallies = stoppedPartial ? auditTalliesOf(stoppedPartial) : undefined;
    const objects = tallies ? forgeAuditObjects(tallies) : [];
    const cancelled = interrupted || err instanceof ForgeAbortedError;
    const stoppedOutcome = gate
      ? 'stopped'
      : cancelled
        ? cancelledRunOutcome(stoppedPartial, objects)
        : 'failure';
    recordClone({
      outcome: stoppedOutcome,
      ...(gate ? { code: gate.code } : stoppedOutcome === 'stopped' ? { code: RUN_CANCELLED } : {}),
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
    if (err instanceof ForgeFilesRefusedError || err instanceof ForgeRunGateError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    const partial = stoppedPartial;
    if (partial && (interrupted || err instanceof ForgeAbortedError)) {
      const document = runDocument(withRecordTypeCalls(partial), new Date(), {
        interrupted: true,
      });
      keepSummary(document);
      if (args.json) {
        process.stdout.write(JSON.stringify(document, null, 2) + '\n');
      } else {
        console.log('');
        for (const line of summaryLines(partial, args.dryRun)) console.log(line);
      }
      say(interruptedLine(args.summary));
      process.exit(INTERRUPTED_EXIT);
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
    process.off('SIGINT', interrupt);
  }

  // The run's entry, as the panel records a run that ended: per object what it
  // created, updated and lost, what it carried from the source, the contact
  // points it neutralized, and how it was set up.
  const tallies = auditTalliesOf(summary);
  recordClone({
    outcome: finishedRunStatus(summary),
    objects: forgeAuditObjects(tallies),
    ...(sourceOrgId ? { source: { origin: 'org' as const, orgId: sourceOrgId } } : {}),
    carried: forgeCarried(tallies),
    ...contactPointsAudit(summary.contactPoints),
    context: runAudit().context(summary.decisionsApplied),
  });

  // When the run ended, on this machine's clock: a removal dates by it a run
  // whose writes the target did not date, as the wizard dates a history entry.
  const finishedAt = new Date();
  const elapsed = finishedAt.getTime() - t0;

  // BA reconciliation export. Written before the JSON/text summary so a
  // post-execute script can pick it up by tailing the file.
  if (args.remapCsv) {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    // Containment check: resolve against cwd and refuse anything that
    // escapes (path traversal). Force `.csv` extension and refuse to
    // overwrite an existing file so a misuse can't clobber sensitive
    // files (e.g. authorized_keys, profile.ps1, scheduled-task XML).
    const resolved = path.resolve(process.cwd(), args.remapCsv);
    const cwdResolved = path.resolve(process.cwd());
    const inside = resolved === cwdResolved || resolved.startsWith(cwdResolved + path.sep);
    if (!inside) {
      throw new Error(
        `--remap-csv must stay inside cwd: "${args.remapCsv}" resolves outside ${cwdResolved}`,
      );
    }
    if (!resolved.toLowerCase().endsWith('.csv')) {
      throw new Error(`--remap-csv must use a .csv extension: "${args.remapCsv}"`);
    }
    try {
      await fs.access(resolved);
      throw new Error(`--remap-csv refuses to overwrite existing file: "${resolved}"`);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'ENOENT') throw err;
    }
    const lines = ['sourceId,targetId'];
    for (const [src, tgt] of Object.entries(summary.remapTable)) {
      // Both IDs are validated SF IDs (15/18 alphanum) — safe to embed
      // without quoting. Defense: in case a future source returns
      // something odd, double-quote both columns to neutralize commas.
      lines.push(`"${src.replace(/"/g, '""')}","${tgt.replace(/"/g, '""')}"`);
    }
    await fs.writeFile(resolved, lines.join('\n') + '\n', 'utf8');
    say(`remap-csv: wrote ${Object.keys(summary.remapTable).length} mappings to ${resolved}`);
  }

  // Machine-readable summary for CI/automation. Stable schema. The summary
  // file, when asked for, takes the run's end over what it said as it went.
  const document = runDocument(summary, finishedAt);
  keepSummary(document);
  if (args.json) {
    process.stdout.write(JSON.stringify(document, null, 2) + '\n');
  } else {
    console.log('');
    for (const line of summaryLines(summary, args.dryRun)) console.log(line);
    console.log(`\ndone in ${elapsed}ms`);
  }
  if (failedOutright(summary)) {
    process.exit(1);
  }
}

// Only when run as a script: importing the module must not start a clone.
if (/sandforge-clone\.[cm]?[jt]s$/.test(process.argv[1] ?? '')) {
  main().catch((err) => {
    console.error('FATAL:', err instanceof Error ? err.stack : err);
    process.exit(1);
  });
}
