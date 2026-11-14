#!/usr/bin/env tsx
/**
 * sandforge-autopilot — headless Autopilot runner.
 *
 * The fourth of these. The first three found eighteen defects between them,
 * every one against a real org and none against any gate. Autopilot is the
 * module that orchestrates the others, so it is where a defect of composition
 * shows: it scans both orgs, builds a dependency graph, generates waves and
 * writes them, with its own query and insert paths rather than Forge's or
 * Seed's.
 *
 * It drives the same `AutopilotOrchestrator` the panel drives, through the
 * same executor, scanner, graph builder, plan generator and remapper, the
 * same personal-field detector and the same write gate. What it leaves out is
 * what the panel adds around a run: events posted to a webview and grappe
 * partitioning.
 *
 * Usage:
 *   pnpm exec tsx packages/extension/cli/sandforge-autopilot.ts \
 *     --source SRC --target TGT --object Account --object Contact
 *
 * Run from the repository root of a checkout, after pnpm install and
 * pnpm build:shared.
 */

import type { Connection } from 'jsforce';
import type {
  AutopilotFitMode,
  AutopilotPlanScope,
  AutopilotRefusal,
  ComplianceFrameworkType,
  ExecutionPlan,
  ForgeTargetAutomation,
  RunCheckpointEstimate,
  RunCheckpointInfo,
  RunCheckpointRequest,
  RunCheckpointTaken,
  StorageRoomNotCounted,
} from '@sandforge/shared';
import { recordWriteHeaders, stillRunningOf } from '@sandforge/shared';
import { loadOrg, makeConn } from './sfSession.js';
import { isProductionTarget, refuseProductionTarget, typeTarget } from './targetKind.js';
import { refuseUnreadArguments, type CommandFlags } from './commandLine.js';
import { onStopSignal, stopExitCode, type StopSignal } from './stopSignals.js';
import { endWith, runExitCode } from './exitCodes.js';
import { refusedLine, refusedSummary, wouldBeRefusedLine, type RunRefusal } from './runRefused.js';
import {
  AutopilotOrchestrator,
  type AutopilotPlanFit,
} from '../src/modules/autopilot/AutopilotOrchestrator.js';
import {
  DEFAULT_SCAN_DEPTH,
  DEFAULT_SCAN_OBJECTS,
  SchemaScanner,
} from '../src/modules/autopilot/SchemaScanner.js';
import type { AutopilotConnection } from '../src/modules/autopilot/SchemaScanner.js';
import { DependencyGraphBuilder } from '../src/modules/autopilot/DependencyGraphBuilder.js';
import { ComplianceEngine } from '../src/modules/autopilot/ComplianceEngine.js';
import { SmartAnonymizer } from '../src/modules/autopilot/SmartAnonymizer.js';
import { ExecutionPlanGenerator } from '../src/modules/autopilot/ExecutionPlanGenerator.js';
import { RecordIdRemapper } from '../src/modules/autopilot/RecordIdRemapper.js';
import {
  AutopilotExecutor,
  CUT_WITH_PARENT,
  pageSoql,
  type AutopilotExecutorDeps,
  type ExecutionResult,
} from '../src/modules/autopilot/AutopilotExecutor.js';
import { AutopilotGrappeAdapter } from '../src/modules/autopilot/AutopilotGrappeAdapter.js';
import { autopilotRunStatus } from '../src/modules/autopilot/autopilotRunStatus.js';
import type { FieldInfo } from '../src/modules/forge/ForgeExecutor.js';
import { toSaveOutcomes } from '../src/core/common/existingRecordMatch.js';
import {
  parseRecordTypeCountsWithMaster,
  parseRecordTypeInfos,
  recordTypeCountSoql,
  type RecordTypeAvailability,
} from '../src/core/metadata/recordTypeAvailability.js';
import { describedLookups, type DescribedLookup } from '../src/core/metadata/describedLookups.js';
import { queryAllPages } from '../src/modules/forge/queryAllPages.js';
import { leftToThePlatformNote } from '../src/core/common/platformRecords.js';
import { currencyFieldsOf, describeCurrencyReplaced } from '../src/core/common/recordCurrencies.js';
import { describeSettledPrices } from '../src/modules/forge/stages/PriceCurrencies.js';
import { sanitizeSoqlValue } from '../src/core/common/soqlValidator.js';
import { extractErrorMessage } from '../src/core/common/extractErrorMessage.js';
import { PIIDetector } from '../src/core/precheck/PIIDetector.js';
import { detectPersonalFields } from '../src/modules/autopilot/personalFields.js';
import {
  autopilotApiCheck,
  autopilotEmails,
  autopilotReadBackOf,
  autopilotWritePlan,
  objectsThePlanWrites,
  AUTOPILOT_FIT_CODES,
  AUTOPILOT_GATE_CODES,
} from '../src/modules/autopilot/AutopilotRunGate.js';
import { fitBudgetOf, storageRecountWords } from '../src/modules/forge/fitBudget.js';
import {
  CHECKPOINT_REFUSED,
  DEFAULT_MAX_TOTAL,
  apiBudgetRefusal,
  checkpointPartOf,
  deliverabilityPartOf,
  emailCheckLines,
  emailRefusal,
  formatMB,
  readApiBudget,
  readDataStorage,
  readEmailLimits,
  storageCheckOf,
  storageRefusal,
  takeCheckpointFirst,
  writePlanLines,
  type ApiBudget,
  type DataStorage,
} from '../src/modules/forge/ForgeRunGate.js';
import { beforeRunFailedWords } from '../src/modules/checkpoint/beforeRunCheckpoint.js';
import { apiRequestsLine, journalDirOf, targetAutomationReader } from './sandforge-clone.js';
import { fitOfArgs, type CliFit } from './sandforge-seed.js';
import { recordTypeGivenOfObjectsLines } from './sandforge-sync.js';
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
} from './beforeRunCheckpoint.js';
import {
  dryRunMuteOf,
  isMuteRefusedError,
  muteForRun,
  muteLines,
  muteOrgOf,
  mutePartOf,
  type RunMute,
} from '../src/modules/forge/AutomationMuteLease.js';
import type { MutedAutomation } from '@sandforge/shared';
import { holdOutputWhole } from './wholeOutput.js';
import {
  NO_APEX_IN_PRODUCTION,
  readEmailDeliverability,
  runEmailsOf,
  type RunEmailsInput,
} from '../src/modules/forge/targetDeliverability.js';

const HELP = `sandforge-autopilot — run an Autopilot copy between two orgs, without the editor.

Usage:
  pnpm exec tsx packages/extension/cli/sandforge-autopilot.ts \\
    --source <alias> --target <alias> --object <ApiName> [options]

Required:
  --source <alias>       sf CLI alias of the source org
  --target <alias>       sf CLI alias of the target org
  --object <ApiName>     object to carry; repeat for more. Autopilot works out
                         the order from the dependencies between them.

Options:
  --standard-objects     include standard objects the scan finds  (default: off)
                         The accounts the selection references are taken
                         either way, as is a standard object a record cannot
                         be written without, and said.
  --max-depth <n>        lookups followed from a selected object  (default: 5)
  --max-objects <n>      objects the plan holds, the selected ones included;
                         each parent a record needs raises it, to twice
                                                                   (default: 50)
  --max-total <n>        most records the run may write in all    (default: 10000)
  --compliance <name>    none | gdpr | ccpa | hipaa | pci_dss      (default: none)
  --keep-contact-points  write emails and phone numbers as read. Without it,
                         as in the panel, every address is written under
                         .invalid and every phone number as a fictional one,
                         whatever the framework                   (default: off)
  --batch-size <n>       records per write call                   (default: 200)
  --plan-only            scan, graph and plan, then stop          (default: off)
                         Says what a real run would be refused for, each under
                         its code: a real run would be refused (CODE): ...;
                         with --json, under writeGate.refusals, the codes
                         under writeGate.refusalCodes
  --mute-automation      mute the target's automation for the run through
                         its own bypass: assign the user the run writes as,
                         for the run alone, the permission sets holding the
                         custom permissions its flows, processes and
                         workflow rules test to stay quiet, and take them
                         back as it ends; what no bypass keeps quiet still
                         runs, and is named. Refused on a production org and
                         for a user who cannot assign permission sets, exit
                         1; with --plan-only, says what would be muted and
                         assigns nothing                   (default: off)
  --fit share            fit the plan to the data storage the target has left:
                         keep the largest share of every selected object that
                         fits, spread over its ids. A record goes with the
                         parent written before it: a contact of a cut account
                         is cut, an account kept comes with all its contacts.
                         A self-reference and a lookup filled after its wave
                         stay empty when their record is cut, and are named.
                         It may take 80 % of what the target says it has left,
                         half a MB off first for the rounding of what it says,
                         less room for what its flows still running create
                         under the records (what --mute-automation keeps quiet
                         creates nothing); what its Apex triggers create is
                         named, not counted. Its writes leave a tenth of the
                         day's API requests, and --max-total holds. It reads
                         the lookups of each selected object first. The
                         records are said object by object, then the gate is
                         met again by them; a plan that cannot be cut to fit
                         is refused, exit 1. With --plan-only, says them and
                         what they meet, and --json names the ids kept
                                                           (default: off)
  --fit-cap <Object>=<n> | <n>
                         at most n records of that selected object, or of
                         every one another --fit-cap does not name; repeat for
                         more. What follows them goes with them. Caps alone
                         that leave the plan past what fits refuse it; with
                         --fit share, the share is taken of what the caps leave
  --fit-within <MB>      with --fit or --fit-cap: take no more than this many
                         MB, whatever the target has left
  --accept-emails        write although the target delivers the emails its
                         flows, processes and workflow rules send as the plan
                         writes (Setup > Deliverability: All email), or would
                         not say whether it does. Read only when something
                         that still runs sends one, with one line of
                         anonymous Apex that sends nothing; without the flag
                         the run is refused, exit 1 (EMAILS_NOT_ACCEPTED),
                         nothing written. On System email only or No access
                         it is not needed. --mute-automation keeps quiet what
                         tests the org's bypass; what an Apex trigger sends is
                         read nowhere                     (default: off)
${checkpointFirstHelp({
  run: 'the run',
  simulation: '--plan-only',
  note: ['An Autopilot run has no removal: a rewind to this', 'checkpoint is what takes it back.'],
})}
  --json                 emit the run summary as JSON, with the id
                         of every record the run created          (default: off)
  --fail-on-partial      exit 3, not 0, when the run was partial: the target
                         refused some of its records, or a record it wrote keeps
                         a lookup it could not fill or stays a draft, its
                         status refused                           (default: off)
  --help                 this text

A selected object is copied whole, unless the plan is fitted. Of any other
object, only the records the selection references are read, by id; a lookup
past the bounds is left empty, and the plan says which. Before it writes, the
run is held to --max-total, to the data storage and the daily API requests the
target has left, and to the daily emails the target's flows would send for its
records: past any, nothing is written. Where the target delivers those emails,
or would not say whether it does, it writes only with --accept-emails.

Ctrl-C stops the run between two calls, as the panel's Stop does: the summary
says what it wrote, which objects it did not, and the records it left with a
lookup empty or as drafts, and --json names every record it created. Ctrl-C
again ends the process at once.

A production target is refused before the scan: Autopilot writes to sandboxes
and Developer Edition orgs only, and --plan-only, which only reads, runs
against any org.

A run refused before its first write says each reason on a line of its own,
refused (CODE): ..., and --json prints "refused": {"code", "message"}, the
other reasons under "alsoRefused": past --max-total (MAX_TOTAL_EXCEEDED), the
data storage (AUTOPILOT_STORAGE_EXCEEDED), the API requests
(API_BUDGET_EXCEEDED) or the emails (AUTOPILOT_EMAILS_EXCEEDED) the target has
left, its emails not accepted (EMAILS_NOT_ACCEPTED), its checkpoint
(CHECKPOINT_REFUSED), its mute (MUTE_PRODUCTION, MUTE_NO_RIGHT, MUTE_FAILED),
or its fit (AUTOPILOT_CANNOT_FIT, AUTOPILOT_FIT_STORAGE_UNREAD,
AUTOPILOT_FIT_READ_REFUSED).

Exit codes: 0 the run finished, some of its records refused, left without a
lookup or left a draft included (read the summary for per-object failures, and
--json's result.status); 1 the run could not be started or was
refused, among them emails not accepted (EMAILS_NOT_ACCEPTED) and a checkpoint
asked first refused or not taken, or it died or produced only failures -- a run
that died prints no summary, and what it wrote before it died stays; 2 a bad
command line; 3 the run was partial and --fail-on-partial was given; 130 Ctrl-C
stopped the run, 143 a SIGTERM (a CI job cancelled or timed out), 129 a SIGHUP.
`;

/** Everything the command line settled. */
interface CliArgs {
  source: string;
  target: string;
  objects: string[];
  includeStandardObjects: boolean;
  compliance: ComplianceFrameworkType;
  batchSize: number;
  maxDepth: number;
  maxObjects: number;
  maxTotal: number;
  planOnly: boolean;
  /** Write emails and phone numbers as read rather than neutralized. */
  keepContactPoints: boolean;
  json: boolean;
  /** Exit 3, not 0, when the run wrote some records and the target refused others. */
  failOnPartial: boolean;
  /** Mute the target's automation for the run, through its own bypass (`--mute-automation`). */
  muteAutomation: boolean;
  /**
   * Write although the target delivers the emails of what still runs, or
   * would not say whether it does (`--accept-emails`).
   */
  acceptEmails: boolean;
  /**
   * Take a checkpoint of what the run writes before its first write
   * (`--checkpoint-first`): the days it is kept and the objects left out of
   * it. undefined = none.
   */
  checkpointFirst?: RunCheckpointRequest;
  /** The fit asked of the plan (`--fit`, `--fit-cap`, `--fit-within`); absent when none was. */
  fit?: CliFit;
}

/** SObject API name — letter-prefixed, alphanumeric and underscore. */
const API_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;

/**
 * The codes a run of the command is refused under that the panel never
 * meets, beside those it shares with it (`AUTOPILOT_GATE_CODES`,
 * `AUTOPILOT_FIT_CODES`): past --max-total, as a clone past its own; past a
 * daily email limit the target's automation sends against, as a Sync or a
 * seed past one; and a plan --fit could not cut to fit.
 */
const MAX_TOTAL_EXCEEDED = 'MAX_TOTAL_EXCEEDED';
const AUTOPILOT_EMAILS_EXCEEDED = 'AUTOPILOT_EMAILS_EXCEEDED';
const AUTOPILOT_CANNOT_FIT = 'AUTOPILOT_CANNOT_FIT';

/** What the line reads. */
const FLAGS: CommandFlags = {
  switches: [
    '--standard-objects',
    '--keep-contact-points',
    '--plan-only',
    '--json',
    '--fail-on-partial',
    '--mute-automation',
    '--accept-emails',
    ...CHECKPOINT_FIRST_FLAGS.switches,
  ],
  values: [
    '--source',
    '--target',
    '--object',
    '--max-depth',
    '--max-objects',
    '--max-total',
    '--compliance',
    '--batch-size',
    '--fit',
    '--fit-cap',
    '--fit-within',
    ...CHECKPOINT_FIRST_FLAGS.values,
  ],
};

/** Read the command line, or explain why it cannot be read. */
export function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  // `--plan-only=true` or `--planonly` dropped without a word ran for real.
  refuseUnreadArguments(args, FLAGS);
  const get = (flag: string, fallback?: string): string | undefined => {
    const at = args.indexOf(flag);
    return at >= 0 && at + 1 < args.length ? args[at + 1] : fallback;
  };
  const collect = (flag: string): string[] => {
    const out: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === flag && i + 1 < args.length) out.push(args[i + 1]);
    }
    return out;
  };

  const source = get('--source');
  const target = get('--target');
  const objects = collect('--object');
  if (!source || !target || objects.length === 0) {
    process.stderr.write('Missing --source, --target or --object. Run with --help.\n');
    process.exit(2);
  }
  for (const name of objects) {
    if (!API_NAME_RE.test(name)) {
      process.stderr.write(`Not an SObject API name: "${name}"\n`);
      process.exit(2);
    }
  }

  const frameworks: ComplianceFrameworkType[] = ['none', 'gdpr', 'ccpa', 'hipaa', 'pci_dss'];
  const compliance = (get('--compliance', 'none') ?? 'none') as ComplianceFrameworkType;
  if (!frameworks.includes(compliance)) {
    process.stderr.write(`--compliance takes ${frameworks.join(', ')} — not "${compliance}".\n`);
    process.exit(2);
  }

  const batchSize = Number(get('--batch-size', '200') ?? '200');
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
    process.stderr.write('--batch-size takes a whole number between 1 and 10000.\n');
    process.exit(2);
  }
  /** A whole number of 1 or more given to `flag`, or its default. */
  const whole = (flag: string, fallback: number): number => {
    const value = Number(get(flag, String(fallback)) ?? fallback);
    if (!Number.isInteger(value) || value < 1) {
      process.stderr.write(`${flag} takes a whole number, 1 or more.\n`);
      process.exit(2);
    }
    return value;
  };
  const maxDepth = whole('--max-depth', DEFAULT_SCAN_DEPTH);
  const maxObjects = whole('--max-objects', DEFAULT_SCAN_OBJECTS);
  const maxTotal = whole('--max-total', DEFAULT_MAX_TOTAL);
  // A checkpoint of what the run writes, taken before its first write; with
  // --plan-only, what it would hold and cost.
  const checkpointFirst = checkpointFirstArgs(args);
  /** A line that does not read: said, exit 2. */
  const refuse = (line: string): never => {
    process.stderr.write(`${line}\n`);
    process.exit(2);
  };
  const fit = fitOfArgs(args, refuse);
  // A cap holds an object the run selects: a parent is read by id, and follows
  // the records that name it.
  for (const name of Object.keys(fit?.caps?.objects ?? {})) {
    if (!objects.includes(name)) refuse(`--fit-cap ${name}: give ${name} with --object too.`);
  }

  return {
    source,
    target,
    objects,
    includeStandardObjects: args.includes('--standard-objects'),
    compliance,
    batchSize,
    maxDepth,
    maxObjects,
    maxTotal,
    planOnly: args.includes('--plan-only'),
    keepContactPoints: args.includes('--keep-contact-points'),
    json: args.includes('--json'),
    failOnPartial: args.includes('--fail-on-partial'),
    muteAutomation: args.includes('--mute-automation'),
    acceptEmails: args.includes('--accept-emails'),
    ...(checkpointFirst !== undefined ? { checkpointFirst } : {}),
    ...(fit ? { fit } : {}),
  };
}

/** The fit the line asks, as the engine reads it. */
function fitModeOf(fit: CliFit): AutopilotFitMode {
  return {
    ...(fit.share ? { share: true as const } : {}),
    ...(fit.caps?.objects ? { caps: fit.caps.objects } : {}),
    ...(fit.caps?.all !== undefined ? { all: fit.caps.all } : {}),
    ...(fit.withinMB !== undefined ? { withinMB: fit.withinMB } : {}),
  };
}

/**
 * A read of every page of what `conn` answers, as the panel reads the target:
 * asked of two hundred activities at a time, the target answers with every
 * relation they hold, and an event's invitees take it past the 2 000 records
 * of a page. Exported so the read can be tested.
 */
export function everyPage(conn: Connection): (soql: string) => Promise<Record<string, unknown>[]> {
  return async (soql) =>
    (
      await queryAllPages<Record<string, unknown>>(
        {
          query: async (q) => conn.query<Record<string, unknown>>(q),
          queryMore: async (url) => conn.queryMore<Record<string, unknown>>(url),
        },
        soql,
      )
    ).records;
}

/** Run one autopilot from the given command line; exported so its parsing can be tested. */
export async function main(argv: string[] = process.argv): Promise<void> {
  const t0 = Date.now();
  const args = parseArgs(argv);
  // On stderr with --json, where stdout carries the summary alone: dropped
  // there, the plan and the gate's counts said nothing beside the JSON.
  const log = (line: string): void => {
    process[args.json ? 'stderr' : 'stdout'].write(`${line}\n`);
  };

  log(`sandforge-autopilot  ${args.source} -> ${args.target}`);
  log(`objects: ${args.objects.join(', ')}`);

  const sourceConn = makeConn(await loadOrg(args.source));
  const targetSession = await loadOrg(args.target);
  const targetConn = makeConn(targetSession);
  // Refused before the scan on a production org, or one that will not say
  // what it is: nothing keeps what an Autopilot run creates, and its write
  // gate held it to volumes alone. --plan-only only reads.
  const typedTarget = !args.planOnly
    ? await refuseProductionTarget(targetConn, args.target, {
        tool: 'sandforge-autopilot',
        action: 'write',
        readOnly: '--plan-only',
      })
    : undefined;
  // The checkpoint the run takes of what it writes before its first write:
  // scoped once the plan and its mute are known, taken once the gate lets the
  // run through and before the mute's lease, kept or deleted as the run ends.
  // With --plan-only, what it would hold and cost. It reads the target
  // through a connection of its own.
  const checkpoints = args.checkpointFirst
    ? commandCheckpoints({
        module: 'autopilot',
        operationId: `sandforge-autopilot-${t0}`,
        request: args.checkpointFirst,
        session: targetSession,
        org: checkpointOrgOf(targetSession, typedTarget ?? (await typeTarget(targetConn))),
        connect: makeConn,
        journalDir: journalDirOf(),
        say: log,
      })
    : undefined;
  /** Whether the target took a write of the run: what keeps the checkpoint it took first. */
  let wroteToTarget = false;
  /** Ids of the records this run created, per object. */
  const created = new Map<string, string[]>();

  // One describe of the target per object, shared across the executors a run
  // creates: the fields it may send, the record types the running user may
  // use and the key prefix of the records a refusal may name are read from it.
  const targetByObject = new Map<
    string,
    {
      creatable: ReadonlySet<string>;
      recordTypes: RecordTypeAvailability[];
      keyPrefix: string | null;
      lookups: DescribedLookup[];
      currencyFields: ReadonlyMap<string, number | undefined>;
      fields: FieldInfo[];
    }
  >();
  const describeTarget = async (objectApiName: string) => {
    const cached = targetByObject.get(objectApiName);
    if (cached) return cached;
    const described = await targetConn.sobject(objectApiName).describe();
    const answer = {
      creatable: new Set(described.fields.filter((f) => f.createable).map((f) => f.name)),
      recordTypes: parseRecordTypeInfos(described.recordTypeInfos),
      keyPrefix: described.keyPrefix ?? null,
      lookups: describedLookups(described.fields),
      currencyFields: currencyFieldsOf(described.fields),
      // What the emails and phone numbers are found by, as the panel finds them.
      fields: described.fields.map((f): FieldInfo => ({
        name: f.name,
        queryable: true,
        createable: f.createable,
        isReference: f.type === 'reference',
        type: f.type,
        ...(f.length > 0 ? { length: f.length } : {}),
        ...(f.externalId ? { externalId: true } : {}),
      })),
    };
    targetByObject.set(objectApiName, answer);
    return answer;
  };
  const anonymizer = new SmartAnonymizer();
  /** What an executor of the run reads and writes the two orgs with: the run's, and the plan's. */
  const executorDeps = (): AutopilotExecutorDeps => ({
    // A page of the table after the last id read, as the panel reads it:
    // an OFFSET past 2 000 is refused.
    query: async (objectApiName, afterId, limit) => {
      const result = await sourceConn.query<Record<string, unknown>>(
        pageSoql(objectApiName, afterId, limit),
      );
      return result.records;
    },
    // A parent of the selection, by the ids its records reference.
    queryByIds: async (objectApiName, ids) => {
      const list = ids.map((id) => `'${sanitizeSoqlValue(id)}'`).join(', ');
      const result = await sourceConn.query<Record<string, unknown>>(
        `SELECT FIELDS(ALL) FROM ${objectApiName} WHERE Id IN (${list}) LIMIT ${ids.length}`,
      );
      return result.records;
    },
    insert: async (objectApiName, records) => {
      // The same stripping the panel does: Salesforce refuses a create
      // carrying a source Id or jsforce's own envelope.
      const cleaned = records.map((r) => {
        const copy = { ...r };
        delete copy['Id'];
        delete copy['attributes'];
        return copy;
      });
      const outcomes = toSaveOutcomes(
        await targetConn.sobject(objectApiName).create(cleaned, { headers: recordWriteHeaders() }),
        objectApiName,
      );
      if (outcomes.some((o) => o.success)) wroteToTarget = true;
      // Every id a run creates is reported, so the run can be undone to
      // the record: nothing else tells its records from anyone else's.
      const ids = outcomes.filter((o) => o.success && o.id).map((o) => o.id);
      created.set(objectApiName, [...(created.get(objectApiName) ?? []), ...ids]);
      return outcomes;
    },
    update: async (objectApiName, records) => {
      const outcomes = toSaveOutcomes(
        await targetConn
          .sobject(objectApiName)
          .update(records as Array<Record<string, unknown> & { Id: string }>, {
            headers: recordWriteHeaders(),
          }),
        objectApiName,
      );
      if (outcomes.some((o) => o.success)) wroteToTarget = true;
      return outcomes;
    },
    // Each read of the source is bounded, as it is for the panel; the
    // target is read to its last page.
    querySource: async (soql) => (await sourceConn.query<Record<string, unknown>>(soql)).records,
    queryTarget: everyPage(targetConn),
    // Each org's currency settings: whether advanced currency management
    // is on, which the user's access to dated rates cannot always tell.
    toolingSource: async (soql) =>
      (await sourceConn.tooling.query<Record<string, unknown>>(soql)).records,
    toolingTarget: async (soql) =>
      (await targetConn.tooling.query<Record<string, unknown>>(soql)).records,
    describeKeyPrefix: async (objectApiName) => (await describeTarget(objectApiName)).keyPrefix,
    describeLookups: async (objectApiName) => (await describeTarget(objectApiName)).lookups,
    // Emails and phone numbers neutralized before they are written, unless
    // --keep-contact-points: found by the target's types.
    describeFields: async (objectApiName) => (await describeTarget(objectApiName)).fields,
    anonymizer,
    remapper: new RecordIdRemapper(),
    describeCreateableFields: async (objectApiName) =>
      (await describeTarget(objectApiName)).creatable,
    describeRecordTypes: async (objectApiName) => (await describeTarget(objectApiName)).recordTypes,
    // The same, asked of the org again once the mute's lease assigned a
    // permission set, which may have opened record types to the user.
    describeRecordTypesAgain: async (objectApiName) =>
      parseRecordTypeInfos((await targetConn.sobject(objectApiName).describe()).recordTypeInfos),
    // From the same describe: what a record's amounts are converted in
    // when its currency is one the target does not hold active.
    describeCurrencyFields: async (objectApiName) =>
      (await describeTarget(objectApiName)).currencyFields,
    // The same count the panel asks, for the same reason: whether any
    // record of an object carries a type the running user cannot use,
    // known before its first page. The records on Master kept: what a
    // plan says goes in with the type the target gives.
    countRecordTypes: async (objectApiName) => {
      const counted = await sourceConn.query<Record<string, unknown>>(
        recordTypeCountSoql(objectApiName),
      );
      return parseRecordTypeCountsWithMaster(counted.records);
    },
  });
  const orchestrator = new AutopilotOrchestrator({
    schemaScanner: new SchemaScanner(),
    graphBuilder: new DependencyGraphBuilder(),
    complianceEngine: new ComplianceEngine(),
    anonymizer,
    planGenerator: new ExecutionPlanGenerator(),
    remapper: new RecordIdRemapper(),
    createExecutor: () => new AutopilotExecutor(executorDeps()),
    grappeAdapter: new AutopilotGrappeAdapter(),
  });

  log('\nscanning…');
  let scan = await orchestrator.scanSchemas(
    sourceConn as unknown as AutopilotConnection,
    targetConn as unknown as AutopilotConnection,
    {
      selectedObjects: args.objects,
      includeStandardObjects: args.includeStandardObjects,
      maxDepth: args.maxDepth,
      maxObjects: args.maxObjects,
    },
    (line) => log(`  ${line}`),
  );
  let graph = orchestrator.buildGraph(scan, args.batchSize);
  log(`graph: ${graph.nodes.length} node(s), ${graph.edges.length} edge(s)`);

  // The personal fields the detector names, whenever the framework
  // anonymizes: the compliance engine maps them to its rules. Without them a
  // GDPR plan anonymized nothing.
  const detected =
    args.compliance === 'none' ? [] : detectPersonalFields(new PIIDetector(), scan.objectDescribes);
  const { rules } = orchestrator.buildCompliance(args.compliance, [], detected);
  let plan = orchestrator.generatePlan(graph, args.compliance, rules, scan.scope);
  /** What the plan writes and in what order, and what it copies of each object. */
  const sayThePlan = (): void => {
    log(`plan: ${plan.waves.length} wave(s), ${plan.totalRecords} record(s)`);
    plan.waves.forEach((wave, index) => {
      log(`  wave ${index + 1}: ${wave.objects.join(', ')}`);
    });
    for (const line of scopeLines(scan.scope)) log(line);
    for (const line of anonymizationLines(plan)) log(line);
  };
  sayThePlan();

  /** Records per object, as the graph of the plan counts them. */
  const countsOf = (nodes: typeof graph.nodes): Map<string, number> =>
    new Map<string, number>(nodes.map((node) => [node.objectApiName, node.recordCount]));
  let recordCounts = countsOf(graph.nodes);

  // The records the plan writes and the data storage they take, held to
  // --max-total and to what the target has left, as a clone is. With
  // --plan-only, what a real run would meet there.
  let writePlan = autopilotWritePlan(plan, recordCounts, scan.personAccounts);
  /** What the target says of its storage, or why it said nothing. */
  const readStorage = async (): Promise<DataStorage | { unread: string }> => {
    try {
      return await readDataStorage(targetConn);
    } catch (err: unknown) {
      return { unread: extractErrorMessage(err) };
    }
  };
  let storage = await readStorage();
  let check = storageCheckOf(writePlan, storage);
  // Its calls against the daily API requests the target has left, as the
  // panel's run is held to them: a run past them stopped part way through,
  // its records refused with REQUEST_LIMIT_EXCEEDED. Asked of the target
  // once, whatever counts them again.
  let budget: Promise<ApiBudget> | undefined;
  const readBudget = (): Promise<ApiBudget> => (budget ??= readApiBudget(targetConn));
  // The emails the target's flows send as the plan's records go in, against
  // what it has left today: its automation read as Forge reads it, its limits
  // when something sends. Past them, the run is refused, as past the storage.
  // Asked to mute, the run plans it from what the target runs on the objects
  // it writes before it counts their emails, which then leave out what the
  // mute keeps quiet. Refused on a production org or for a user who cannot
  // assign, a real run writes nothing; --plan-only says so, and assigns nothing.
  /** What the target runs on the objects the plan writes, read once for its mute and its checkpoint. */
  let automationRead: Promise<ForgeTargetAutomation | { unread: string }> | undefined;
  const readTheAutomation = (): Promise<ForgeTargetAutomation | { unread: string }> =>
    (automationRead ??= targetAutomationReader(targetConn)
      .read(args.target, objectsThePlanWrites(plan))
      .catch((err: unknown) => ({ unread: err instanceof Error ? err.message : String(err) })));
  let mute: RunMute | undefined;
  let muteRefused: RunRefusal | undefined;
  // Planned before the plan's requests are priced, said after them: the
  // lease of the mute is among them. Priced nowhere, a run that muted the
  // target sent seven requests or more beside what its price said.
  if (args.muteAutomation) {
    const read = await readTheAutomation();
    try {
      mute = await muteForRun(async () => muteOrgOf(targetConn), read, {
        writes: (_objectApiName, write) => write === 'insert' || write === 'update',
      });
    } catch (err: unknown) {
      if (!isMuteRefusedError(err)) throw err;
      muteRefused = {
        code: err.code,
        message: err.message.replace(/ Nothing was assigned\.$/, ''),
      };
    }
  }
  let api = await autopilotApiCheck(writePlan, storage, readBudget, undefined, {
    readBack: autopilotReadBackOf(writePlan),
    ...mutePartOf(mute?.plan),
  });
  log('');
  for (const line of writePlanLines(writePlan, check, args.target)) log(line);
  // A run that takes a checkpoint first says them once it is scoped, its
  // requests among them.
  if (!checkpoints) log(apiRequestsLine(api, args.target));
  for (const line of personAccountLines(scan.personAccounts)) log(line);
  if (mute) for (const line of muteLines(mute.muted, args.target)) log(`  ${line}`);
  // The checkpoint asked first, scoped from the objects the plan writes and
  // what still runs as it inserts and updates them — what the mute keeps
  // quiet held quiet — before its requests are counted with the plan's.
  // What could not be read creates nothing the scope can name.
  let checkpointPlanned: { ask: CommandCheckpointAsk; estimate: RunCheckpointEstimate } | undefined;
  let checkpointFailed: string | undefined;
  if (checkpoints && writePlan.totalRows > 0) {
    const writing = new Set(writePlan.objects.map(({ objectApiName }) => objectApiName));
    const read = mute?.automation ?? (await readTheAutomation());
    const ask: CommandCheckpointAsk = {
      written: objectsThePlanWrites(plan).filter((name) => writing.has(name)),
      running:
        typeof read.unread === 'string'
          ? { firing: [] }
          : {
              firing: stillRunningOf(
                read as ForgeTargetAutomation,
                undefined,
                (_objectApiName, write) => write === 'insert' || write === 'update',
              ).firing,
            },
    };
    try {
      checkpointPlanned = { ask, estimate: await checkpoints.scope(ask) };
    } catch (err: unknown) {
      checkpointFailed = beforeRunFailedWords(err).replace(/ Nothing was written\.$/, '');
    }
  }
  if (checkpoints) {
    api = await autopilotApiCheck(writePlan, storage, readBudget, checkpointPlanned?.estimate, {
      readBack: autopilotReadBackOf(writePlan),
      ...mutePartOf(mute?.plan),
    });
    log(apiRequestsLine(api, args.target));
    if (checkpointPlanned) {
      for (const line of checkpointEstimateLines(checkpointPlanned.estimate)) log(line);
    }
  }
  // The fit asked: what still runs once the mute's plan holds is known and
  // nothing is assigned or taken yet, and the room it needs is computed from
  // it. The plan it answers replaces the plan, and meets the run's gate again
  // from here on, /limits read again: a fit is never a pass.
  let fit: AutopilotPlanFit | undefined;
  let fitRefused: RunRefusal | undefined;
  if (args.fit) {
    log('\nfitting…');
    const fitBudget = fitBudgetOf({
      storage,
      ...(args.fit.withinMB !== undefined ? { withinMB: args.fit.withinMB } : {}),
      api:
        'unread' in storage
          ? await readBudget().catch((err: unknown) => ({ unread: extractErrorMessage(err) }))
          : (storage.dailyApiRequests ?? { unread: `${args.target}'s /limits did not list them` }),
      otherRequests: checkpointPartOf(checkpointPlanned?.estimate),
    });
    if ('unread' in fitBudget) {
      fitRefused = {
        code: AUTOPILOT_FIT_CODES.STORAGE_UNREAD,
        message:
          `The plan cannot be fitted to ${args.target}, whose data storage left could not be ` +
          `read (${fitBudget.unread}).`,
      };
    } else {
      try {
        fit = await orchestrator.fitPlan(sourceConn as unknown as AutopilotConnection, {
          scan,
          graph,
          plan,
          rules,
          mode: fitModeOf(args.fit),
          budget: fitBudget,
          automation: await readTheAutomation(),
          ...(mute?.plan ? { mutePlan: mute.plan } : {}),
          describeLookups: async (objectApiName) => (await describeTarget(objectApiName)).lookups,
          maxRecords: args.maxTotal,
          batchSize: args.batchSize,
          onProgress: (line) => log(`  ${line}`),
        });
        const muted = (mute?.plan?.assign.length ?? 0) > 0;
        for (const line of autopilotFitLines(fit, args.target, muted)) log(line);
        if (fit.cannotFit !== undefined) {
          fitRefused = {
            code: AUTOPILOT_CANNOT_FIT,
            message: `The plan cannot be fitted to ${args.target}: ${fit.cannotFit}.`,
          };
        }
      } catch (err: unknown) {
        // Nothing is chosen from what was not read: a refusal, which
        // --plan-only reports and a real run stops on.
        fitRefused = {
          code: AUTOPILOT_FIT_CODES.READ_REFUSED,
          message:
            'The plan could not be fitted: the source refused a read of it ' +
            `(${extractErrorMessage(err)}).`,
        };
      }
    }
    if (fit?.fitted) {
      ({ scan, graph, plan } = fit.fitted);
      recordCounts = countsOf(graph.nodes);
      writePlan = autopilotWritePlan(plan, recordCounts, scan.personAccounts);
      storage = await readStorage();
      check = storageCheckOf(writePlan, storage);
      budget = undefined;
      // An object the fit left no record of takes nothing in the checkpoint.
      const writing = new Set(writePlan.objects.map(({ objectApiName }) => objectApiName));
      if (checkpoints && checkpointPlanned) {
        const { ask } = checkpointPlanned;
        const written = ask.written.filter((name) => writing.has(name));
        if (written.length < ask.written.length) {
          const narrowed: CommandCheckpointAsk = {
            written,
            running: {
              firing: ask.running.firing.filter((entry) => writing.has(entry.objectApiName)),
            },
          };
          try {
            checkpointPlanned = { ask: narrowed, estimate: await checkpoints.scope(narrowed) };
          } catch (err: unknown) {
            checkpointPlanned = undefined;
            checkpointFailed = beforeRunFailedWords(err).replace(/ Nothing was written\.$/, '');
          }
        }
      }
      api = await autopilotApiCheck(writePlan, storage, readBudget, checkpointPlanned?.estimate, {
        readBack: autopilotReadBackOf(writePlan),
        ...mutePartOf(mute?.plan),
      });
      log('');
      sayThePlan();
      log('');
      for (const line of writePlanLines(writePlan, check, args.target)) log(line);
      log(apiRequestsLine(api, args.target));
      for (const line of personAccountLines(scan.personAccounts)) log(line);
    }
  }
  const emails = await autopilotEmails({
    plan: writePlan,
    objects: objectsThePlanWrites(plan),
    readAutomation: async (objects) => {
      if (mute?.automation) return mute.automation;
      // The read the mute or the checkpoint made, when it was made and held.
      const read = automationRead ? await automationRead : undefined;
      return read !== undefined && typeof read.unread !== 'string'
        ? (read as ForgeTargetAutomation)
        : targetAutomationReader(targetConn).read(args.target, objects);
    },
    readLimits: () => readEmailLimits(targetConn),
  });
  for (const line of emailCheckLines(emails.checks, args.target)) log(line);
  if (emails.unread !== undefined) {
    log(`  emails: not counted, ${emails.unread} could not be read`);
  }
  // Whether the target delivers the emails of what still runs once the
  // mute's plan holds, on the objects the plan writes records of: read last
  // before the run's gate, as the user the run writes as, only when something
  // may send one, and never in a production org, which --plan-only reads. Its
  // requests are the run's: counted, and said. The emails go out on
  // --accept-emails alone: nothing else on the line stands for it.
  const planObjects = new Set(writePlan.objects.map(({ objectApiName }) => objectApiName));
  const writes: RunEmailsInput['writes'] = (objectApiName, write) =>
    planObjects.has(objectApiName) && (write === 'insert' || write === 'update');
  const runEmails =
    writePlan.totalRows > 0
      ? await runEmailsOf({
          read: await readTheAutomation(),
          ...(mute?.plan ? { plan: mute.plan } : {}),
          writes,
          readDeliverability: async () =>
            isProductionTarget(typedTarget ?? (await typeTarget(targetConn)))
              ? NO_APEX_IN_PRODUCTION
              : readEmailDeliverability(targetConn),
          accepted: args.acceptEmails,
          target: args.target,
          run: 'autopilot',
          keepsAddresses: args.keepContactPoints,
          mayMute: !args.muteAutomation,
        })
      : undefined;
  const emailsGate = runEmails?.gate;
  if (emailsGate?.line !== undefined) log(`  ${emailsGate.line}`);
  const deliverability = deliverabilityPartOf(runEmails?.ofRun);
  if (deliverability.deliverability !== undefined) {
    api = await autopilotApiCheck(writePlan, storage, readBudget, checkpointPlanned?.estimate, {
      readBack: autopilotReadBackOf(writePlan),
      ...mutePartOf(mute?.plan),
      ...deliverability,
    });
    log(apiRequestsLine(api, args.target));
  }
  /** Each reason a real run is refused for, under its code, in the order the lines say them. */
  const coded = (code: string, message: string | undefined): RunRefusal | undefined =>
    message === undefined ? undefined : { code, message };
  const refusedFor = [
    // The checkpoint's refusal in the command's words, said with the rest.
    coded(
      CHECKPOINT_REFUSED,
      checkpointFailed ??
        (checkpointPlanned?.estimate.refusal !== undefined
          ? checkpointRefusedWords(checkpointPlanned.estimate.refusal)
          : undefined),
    ),
    coded(
      MAX_TOTAL_EXCEEDED,
      writePlan.totalRows > args.maxTotal
        ? `The run would write ${writePlan.totalRows} records, more than --max-total ` +
            `${args.maxTotal}: narrow it (--object, --max-depth, --max-objects), or raise --max-total.`
        : undefined,
    ),
    coded(AUTOPILOT_GATE_CODES.STORAGE_EXCEEDED, storageRefusal(check, args.target)),
    // Its own refusal closes on the sentence the summary adds once.
    coded(
      AUTOPILOT_GATE_CODES.API_BUDGET_EXCEEDED,
      apiBudgetRefusal(api, args.target)?.replace(/ Nothing was written\.$/, ''),
    ),
    coded(AUTOPILOT_EMAILS_EXCEEDED, emailRefusal(emails.checks, args.target)),
    // Its own refusal says nothing was written before what lifts it: the
    // sentence the summary closes on says it once.
    emailsGate?.stop
      ? coded(emailsGate.stop.code, emailsGate.stop.message.replace(/ Nothing was written\./, ''))
      : undefined,
    muteRefused,
    fitRefused,
  ].filter((refused): refused is RunRefusal => refused !== undefined);
  const refusals = refusedFor.map(({ message }) => message);
  // Past what the org or --max-total allow, a person is told there is a way
  // through: unasked, a fit reads nothing.
  if (
    !args.fit &&
    !('unread' in storage) &&
    (check.verdict === 'exceeds' ||
      writePlan.totalRows > args.maxTotal ||
      apiBudgetRefusal(api, args.target) !== undefined)
  ) {
    log('  --fit share keeps the largest share of the plan that fits, its records whole');
  }

  if (args.planOnly) {
    // What the target gives the records that go in without a record type,
    // as the describe of the user the run writes as says: on each node of
    // the graph, its lines said, and in --json. A real run reads it back.
    const given = await new AutopilotExecutor(executorDeps()).recordTypesGivenOf(
      plan,
      recordCounts,
      scan.parentIds,
      scan.scope.cutShort,
    );
    for (const node of graph.nodes) {
      const entry = given.get(node.objectApiName);
      if (entry) node.recordTypeGiven = entry;
    }
    const muteAssigns = (mute?.plan?.assign.length ?? 0) > 0;
    for (const line of recordTypeGivenOfObjectsLines(graph.nodes, true, muteAssigns)) log(line);
    for (const refused of refusedFor) log(`  ${wouldBeRefusedLine(refused)}`);
    if (args.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            tool: 'sandforge-autopilot',
            planOnly: true,
            graph,
            plan,
            writeGate: {
              records: writePlan.totalRows,
              storage: check,
              apiRequests: api,
              personAccounts: Object.fromEntries(scan.personAccounts),
              emails: emails.checks,
              ...(emails.unread !== undefined ? { emailsUnread: emails.unread } : {}),
              // Whether the target delivers them: absent when nothing sends.
              ...(emailsGate?.deliverability ? { deliverability: emailsGate.deliverability } : {}),
              refusals,
              // The code a real run is refused with for each, in their order:
              // the words alone, a pipeline could not tell them apart.
              refusalCodes: refusedFor.map(({ code }) => code),
            },
            // What a real run's mute would assign, silence, leave running
            // and lift beside, as the lines say it.
            ...dryRunMuteOf(mute),
            // What the checkpoint a real run takes first would hold and cost.
            ...(checkpointPlanned ? { checkpoint: checkpointPlanned.estimate } : {}),
            // What the fit kept and cut, and the ids a real run would copy.
            ...(fit ? { fit: autopilotFitJson(fit) } : {}),
          },
          null,
          2,
        )}\n`,
      );
    }
    return;
  }
  /**
   * Refuse the run before its first write: each reason on its line under its
   * code, and with --json the summary on stdout, where a CI job reads
   * `.refused.code`. Refused once the gate let it through — at its
   * checkpoint's take, its lease, or the lease read back —, a run said a
   * sentence on stderr alone and left stdout empty.
   */
  const refuse = (refused: RunRefusal, also: readonly RunRefusal[] = []): never => {
    if (args.json) {
      process.stdout.write(
        refusedSummary(
          {
            tool: 'sandforge-autopilot',
            source: args.source,
            target: args.target,
            elapsedMs: Date.now() - t0,
          },
          refused,
          also,
        ),
      );
    }
    throw new Error([refused, ...also].map(refusedLine).join('\n'));
  };
  if (refusedFor.length > 0) {
    // Every reason under its code, as a clone refused for several says them:
    // the first under `refused`, the others under `alsoRefused`, each its own
    // line, so a CI job told of one is not refused again for the next. A run
    // refused past --max-total, its storage or its API requests said a
    // sentence with no code, and printed nothing on stdout.
    const [refused, ...also] = refusedFor.map(({ code, message }) => ({
      code,
      message: `${message} Nothing was written.`,
    }));
    refuse(refused, also);
  }

  log('\nexecuting… (REAL)');
  // Ctrl-C stops the run as the panel's Stop does: between two calls, the
  // batch in flight let through, and the result says what it wrote and which
  // objects it did not. Killed outright, a run printed nothing of the records
  // it had created. A second Ctrl-C ends the process at once. A SIGTERM — a
  // CI job cancelled or timed out — or a SIGHUP stops it the same way.
  const stop = new AbortController();
  let stoppedBy: StopSignal | undefined;
  const interrupt = (signal: StopSignal): void => {
    stoppedBy = signal;
    process.stderr.write(
      '\ninterrupted: the run stops after the call under way, and says what it wrote ' +
        '(Ctrl-C again ends it at once)\n',
    );
    stop.abort();
  };
  const releaseStop = onStopSignal(interrupt);
  let result: ExecutionResult;
  /** What the run muted of the target's automation, once it ended. */
  let mutedAutomation: MutedAutomation | undefined;
  /** The checkpoint the run took before its first write, once taken. */
  let checkpointTaken: RunCheckpointTaken | undefined;
  /** What became of it once the run ended: kept, or deleted for a run that wrote nothing. */
  let checkpointInfo: RunCheckpointInfo | undefined;
  try {
    // The checkpoint asked first is taken once the gate let the run through,
    // the flag the answer a question would have had, and before the lease:
    // the bypass is held for the writes alone. Ctrl-C stops it between two
    // reads, keeping nothing.
    if (checkpoints && checkpointPlanned) {
      const planned = checkpointPlanned;
      const took = await takeCheckpointFirst(() =>
        checkpoints.take(planned.ask, planned.estimate, { signal: stop.signal }),
      );
      if ('stop' in took) {
        if (took.stop.code === CHECKPOINT_REFUSED) {
          refuse({ code: CHECKPOINT_REFUSED, message: checkpointStopWords(took.stop) });
        }
        process.stderr.write(`${checkpointStopWords(took.stop)}\n`);
        endWith(stopExitCode(stoppedBy ?? 'SIGINT'));
        return;
      }
      checkpointTaken = took.checkpoint;
      for (const line of checkpointTakenLines(took.checkpoint, args.target, args.muteAutomation)) {
        log(line);
      }
    }
    // The lease is taken before the first write and given back as the run
    // ends, written, failed, stopped or thrown alike.
    const held = mute?.prepared
      ? await mute.prepared.acquire(`sandforge-autopilot ${t0}`).catch((err: unknown) => {
          if (!isMuteRefusedError(err)) throw err;
          return refuse(err.refusal);
        })
      : undefined;
    mutedAutomation = held?.outcome ?? mute?.muted;
    // Read back against its plan: a set it does not hold leaves running a
    // sender of emails the gate was not told of. The run writes nothing, and
    // gives the lease back.
    const relit = held ? runEmails?.afterLease(held.outcome, args.acceptEmails) : undefined;
    if (held && relit) {
      mutedAutomation = await held.release();
      for (const line of muteLines(mutedAutomation, args.target)) log(line);
      refuse({ code: relit.code, message: relit.message });
    }
    result = await orchestrator
      .executePlan(plan, graph, rules, recordCounts, undefined, stop.signal, scan.parentIds, {
        ...(args.keepContactPoints ? { keepContactPoints: true } : {}),
        // Given back by the executor once its last write is through,
        // before it reads back the record types the target gave; given
        // back again here, it answers the same.
        ...(held
          ? { lease: { assigned: held.outcome.assigned.length, giveBack: () => held.release() } }
          : {}),
        // What a record read must not have come to name since the fit.
        ...(fit?.fitted ? { fit: fit.fitted.run } : {}),
      })
      .finally(async () => {
        if (held) mutedAutomation = await held.release();
      });
  } finally {
    releaseStop();
    // Kept once the run wrote a record, whatever became of it after;
    // deleted when it wrote none — its lease refused, a stop before its
    // first write. Only the deletion can fail: then it is kept, and said.
    if (checkpoints && checkpointTaken) {
      const taken = checkpointTaken;
      checkpointInfo = await checkpoints.settle(taken, wroteToTarget).catch((err: unknown) => {
        log(
          `warning: the checkpoint '${taken.name}' taken before the run, which wrote nothing, ` +
            `could not be deleted (${extractErrorMessage(err)}): delete it with ` +
            `sandforge-checkpoint delete --org ${args.target} --checkpoint ${taken.checkpointId}`,
        );
        return taken;
      });
      for (const line of checkpointSettledLines(checkpointInfo)) log(line);
    }
  }
  for (const line of mutedAutomation ? muteLines(mutedAutomation, args.target) : []) log(line);
  const elapsedMs = Date.now() - t0;
  const interrupted = stop.signal.aborted;
  const status = autopilotRunStatus(result);
  // A run that died, or whose every record the target refused, exited 0 as
  // one that wrote them all: it only said so on a line of its summary.
  endWith(
    interrupted ? stopExitCode(stoppedBy ?? 'SIGINT') : runExitCode(status, args.failOnPartial),
  );

  if (args.json) {
    // A stopped run is `cancelled`, as Live Operations and the audit trail
    // name it, and as Sync's and a seed's summaries say it beside their
    // status: the summary said `stopped` alone, a word neither used.
    const ended = { status, ...result, ...(result.stopped === true ? { cancelled: true } : {}) };
    process.stdout.write(
      `${JSON.stringify({ tool: 'sandforge-autopilot', source: args.source, target: args.target, result: ended, created: Object.fromEntries(created), ...(mutedAutomation ? { mutedAutomation } : {}), ...(checkpointInfo ? { checkpoint: checkpointInfo } : {}), ...(fit ? { fit: autopilotFitJson(fit) } : {}), elapsedMs, ...(interrupted ? { interrupted: true } : {}) }, null, 2)}\n`,
    );
    if (interrupted) process.stderr.write(`${autopilotInterruptedLine(result)}\n`);
    return;
  }

  log(`\nstatus:  ${status}`);
  log(
    `written: ${result.totalSuccess}   linked: ${result.totalLinked ?? 0}   ` +
      `refused: ${result.totalFailure}   skipped: ${result.totalSkipped}`,
  );
  if (result.skippedObjects.length > 0) log(`  skipped: ${result.skippedObjects.join(', ')}`);
  if (result.cutSinceFit !== undefined) {
    log(`  cut since the fit: ${result.cutSinceFit}, read naming a record the fit cut`);
  }
  if (result.fatalError) log(`  the run died with: ${result.fatalError}`);
  for (const line of contactPointLines(result)) log(line);
  for (const line of outcomeLines(result)) log(line);
  if (interrupted) {
    process.stderr.write(`${autopilotInterruptedLine(result)}\n`);
    return;
  }
  log(`\ndone in ${elapsedMs}ms`);
}

/**
 * What a run Ctrl-C stopped says last: that it stopped, the objects it did
 * not write, and where the ids of what it created are. Exported so it can be
 * tested.
 */
export function autopilotInterruptedLine(
  result: Pick<ExecutionResult, 'stoppedObjects' | 'totalSuccess'>,
): string {
  const cut = result.stoppedObjects ?? [];
  return (
    `interrupted: the run stopped before it was through, ${result.totalSuccess} record(s) ` +
    `written${cut.length > 0 ? `, ${cut.join(', ')} cut short or not written` : ''}; ` +
    '--json names every record it created'
  );
}

/**
 * What the run did with the emails and phone numbers it wrote: how many it
 * neutralized, in which fields, or that it kept them as read. Exported so it
 * can be tested.
 */
export function contactPointLines(result: Pick<ExecutionResult, 'contactPoints'>): string[] {
  const report = result.contactPoints;
  if (!report) return ['emails and phone numbers: written as read (--keep-contact-points)'];
  if (report.values === 0) return ['emails and phone numbers: none to neutralize'];
  const fields = report.fields.map((f) => `${f.objectApiName}.${f.field} ${f.values}`).join(', ');
  return [
    `emails and phone numbers: ${report.values} neutralized (${fields}) -- addresses under ` +
      '.invalid, numbers fictional',
  ];
}

/** A share, as a line says it: a percentage, rounded down to a tenth. */
function shareWords(share: number): string {
  return `${Math.floor(share * 1000) / 10} %`;
}

/** What a fit leaves out of the room it keeps, as a line names it. */
function notCountedWords(entry: StorageRoomNotCounted): string {
  switch (entry.kind) {
    case 'trigger':
      return `what Apex trigger ${entry.name} on ${entry.objectApiName} creates`;
    case 'notRead':
      return `what "${entry.name}" on ${entry.objectApiName} creates: it was not read`;
    case 'share':
      return `the ${entry.name} rows the flows of ${entry.objectApiName} create`;
  }
}

/**
 * What the run says of a fit before it writes: the share and what held it,
 * the budget and its terms, what each selected object kept and why the rest
 * was cut, the parents read for them, the lookups left empty, what the room
 * leaves out, and what the plan fitted comes to. Exported so it can be tested.
 *
 * @param muted - Whether the run's mute keeps some of the target's automation quiet.
 */
export function autopilotFitLines(fit: AutopilotPlanFit, target: string, muted: boolean): string[] {
  const { heldBy, report } = fit;
  const { budget } = report;
  if (fit.cannotFit !== undefined) return [`fit: the plan cannot be fitted: ${fit.cannotFit}`];
  if (heldBy === 'whole') {
    return [
      `fit: the plan fits as it is, ${report.records} record(s), about ` +
        `${formatMB(report.estimateMB)} MB: nothing cut`,
    ];
  }
  const fits = formatMB(budget.budgetMB + budget.automationMB);
  const heldWords: Record<Exclude<typeof heldBy, 'whole' | 'caps'>, string> = {
    apiRequests: `the largest whose writes leave ${target} a tenth of its daily API requests`,
    maxTotal: 'the largest --max-total lets through',
    within: `the largest that fits the ${budget.withinMB ?? fits} MB asked (--fit-within)`,
    storage:
      `the largest that fits ${fits} MB: ${budget.share * 100} % of the ${budget.remainingMB} ` +
      `MB ${target} says it has left of ${budget.maxMB}, ${budget.roundingMB} MB kept first for ` +
      'the rounding of what it says',
  };
  const room =
    fit.automationUnread !== undefined
      ? `no room kept for what its automation creates: it could not be read (${fit.automationUnread})`
      : budget.automationMB > 0
        ? `${formatMB(budget.automationMB)} MB of it kept for what its flows still running create ` +
          'under these records'
        : 'nothing kept for its flows: none still running creates records under these' +
          (muted ? ' (--mute-automation keeps the others quiet)' : '');
  const head =
    heldBy === 'caps'
      ? `fit: the caps asked, within the ${fits} MB that fit`
      : `fit: share ${shareWords(report.share ?? 1)}, ${heldWords[heldBy]}`;
  const width = Math.max(...report.objects.map((o) => o.objectApiName.length));
  const objectLine = (object: (typeof report.objects)[number]): string => {
    const withParent = object.cutWithParent.reduce((sum, cut) => sum + cut.count, 0);
    const cut = object.cutSpread + withParent;
    const parts = [
      ...object.cutWithParent.map(
        (entry) => `${entry.count} with their ${entry.parent} (${entry.field})`,
      ),
      ...(object.cutSpread > 0 ? [`${object.cutSpread} spread over the table`] : []),
    ];
    return (
      `  ${object.objectApiName.padEnd(width)}  ${object.kept} of ${object.inSource}` +
      (cut > 0 ? `  cut ${cut}: ${parts.join(', ')}` : '')
    );
  };
  const emptied = report.emptied.map(
    (entry) =>
      `${entry.objectApiName}.${entry.field} on ${entry.count} (` +
      (entry.why === 'selfReference'
        ? 'the record of its own object it names was cut'
        : 'the record it names, written after, was cut') +
      ')',
  );
  return [
    `${head}; ${room}`,
    ...report.objects.map(objectLine),
    ...report.parents.map(
      (parent) => `  ${parent.objectApiName}: ${parent.records}, those the kept records name`,
    ),
    ...(emptied.length > 0 ? [`  left empty: ${emptied.join(', ')}`] : []),
    ...(budget.notCounted ?? []).map((entry) => `  not counted: ${notCountedWords(entry)}`),
    `  fitted plan: ${report.records} record(s), about ${formatMB(report.estimateMB)} MB` +
      (budget.automationMB > 0
        ? ` and ${formatMB(budget.automationMB)} MB for what its flows create under them`
        : '') +
      `; ${report.requestsRead} requests read to fit it`,
    `  ${storageRecountWords(target)}`,
  ];
}

/**
 * What the summary's JSON says of a fit: its report, what held it, and when
 * the plan was fitted, the ids of the records kept, as it names the ids it
 * created. Exported so it can be tested.
 */
export function autopilotFitJson(fit: AutopilotPlanFit): Record<string, unknown> {
  return {
    applied: fit.fitted !== undefined,
    ...fit.report,
    heldBy: fit.heldBy,
    ...(fit.cannotFit !== undefined ? { cannotFit: fit.cannotFit } : {}),
    ...(fit.automationUnread !== undefined ? { automationUnread: fit.automationUnread } : {}),
    ...(fit.fitted ? { keptIds: Object.fromEntries(fit.keptIds) } : {}),
  };
}

/**
 * What the plan copies of each object and what it leaves out: the selected
 * objects whole, the others by the records the selection references, and
 * each lookup left empty with why. Exported so it can be tested.
 */
export function scopeLines(scope: AutopilotPlanScope): string[] {
  // A selected table larger than a run copies of one is copied from its
  // first records by Id: said before the run on a line of its own, with what
  // the source holds, and not among those copied whole, as Step 4 lists them.
  const cutNames = new Set((scope.cutShort ?? []).map((cut) => cut.objectApiName));
  const whole = scope.selected.filter((name) => !cutNames.has(name));
  const lines = [`scope: depth ${scope.maxDepth}, at most ${scope.maxObjects} object(s)`];
  // A fitted plan copies no object whole: the fit's lines say what it keeps.
  if (scope.fitted) {
    const kept = scope.fitted.objects.map(
      (object) => `${object.objectApiName} ${object.kept} of ${object.inSource}`,
    );
    lines.push(`  fitted to the target's storage, read by id: ${kept.join(', ')}`);
  } else if (whole.length > 0 || scope.selected.length === 0) {
    lines.push(`  copied whole, as selected: ${whole.join(', ') || '(none)'}`);
  }
  for (const cut of scope.cutShort ?? []) {
    const of = cut.total !== undefined ? ` of ${cut.total}` : '';
    lines.push(
      `  ${cut.objectApiName}: ${cut.copied}${of} record(s) copied, the first by Id -- a run ` +
        'copies no more of a selected object',
    );
  }
  if (scope.parents.length > 0) {
    lines.push('  read by id, only the records the selection references:');
    for (const parent of scope.parents) {
      lines.push(`    ${parent.objectApiName.padEnd(40)}${String(parent.records).padStart(8)}`);
    }
  }
  for (const needed of scope.standardNeeded) {
    lines.push(
      `  ${needed.objectApiName} taken though standard objects are off: ` +
        `${needed.neededBy} cannot be left empty`,
    );
  }
  // The account is followed with standard objects off, as it is by default:
  // left empty, the opportunities of a plan went in without theirs.
  for (const followed of scope.followedByDefault ?? []) {
    lines.push(
      `  ${followed.objectApiName} followed by default though standard objects are off: ` +
        `${followed.referencedBy.join(', ')} reference${followed.referencedBy.length === 1 ? 's' : ''} it`,
    );
  }
  const why: Record<AutopilotPlanScope['leftEmpty'][number]['reason'], string> = {
    depth: `further than ${scope.maxDepth} lookup(s)`,
    objects: `past ${scope.maxObjects} object(s)`,
    standard: 'a standard object (--standard-objects to take it)',
  };
  if (scope.leftEmpty.length > 0) {
    lines.push(`  left empty (${scope.leftEmpty.length} lookup(s)):`);
    for (const lookup of scope.leftEmpty) {
      lines.push(
        `    ${lookup.objectApiName}.${lookup.fieldApiName} -> ${lookup.target}: ` +
          `${why[lookup.reason]}` +
          (lookup.required ? ' — required: its records will be refused' : ''),
      );
    }
  }
  // A record in a currency the target does not hold active goes in its
  // corporate currency, its amounts converted: said before the run.
  const currencies = scope.currencies;
  if (currencies) {
    lines.push(
      `  currencies the target does not hold active: ${currencies.notInTarget.join(', ')} — a ` +
        `record in one is written in ${currencies.writtenIn}, its corporate currency, its ` +
        `amounts converted at the source's rates (${currencies.objects.join(', ')})`,
    );
  }
  return lines;
}

/**
 * How the write gate sized the person accounts it counted, as Salesforce
 * counts their storage: 4 KB an account, being an account and a contact, and
 * nothing of its own for the contact the platform writes with it. Nothing
 * when the plan copies none. Exported so it can be tested.
 */
export function personAccountLines(personAccounts: ReadonlyMap<string, number>): string[] {
  const accounts = personAccounts.get('Account') ?? 0;
  const contacts = personAccounts.get('Contact') ?? 0;
  if (accounts === 0 && contacts === 0) return [];
  const parts = [
    ...(accounts > 0 ? [`${accounts} person account(s) at 4 KB each`] : []),
    ...(contacts > 0 ? [`${contacts} contact(s) of person accounts at none of their own`] : []),
  ];
  return [`  sized as Salesforce counts them: ${parts.join(', ')}`];
}

/**
 * What the plan anonymizes, and on which person objects it finds no rule for
 * a name, an email or a phone. Exported so it can be tested.
 */
export function anonymizationLines(plan: ExecutionPlan): string[] {
  if (plan.complianceFramework === 'none') return [];
  const summary = plan.anonymizationSummary;
  const lines = [
    `anonymization (${plan.complianceFramework}): ${summary.totalFieldsToAnonymize} field(s) ` +
      `on ${summary.objectsWithPii.join(', ') || 'no object'}`,
  ];
  for (const object of summary.notCovered ?? []) {
    lines.push(
      `  ${object.objectApiName}: no rule for its ${object.missing.join(', ')} — ` +
        'copied as the source holds them',
    );
  }
  return lines;
}

/**
 * One line per object — written, linked, refused — then one per reason the
 * target gave, by status code and fields, one per lookup left to the target's
 * default, and one per kind of record left to the platform; then the lookups
 * the second pass filled and the statuses applied once the children were in.
 * The code is printed rather than read from the message: the message is in
 * the language of the target's running user.
 */
export function outcomeLines(result: ExecutionResult): string[] {
  const lines: string[] = [];
  const reasons = (refusals: readonly AutopilotRefusal[]): void => {
    for (const refusal of refusals) {
      const fields = refusal.fields.length > 0 ? ` [${refusal.fields.join(', ')}]` : '';
      lines.push(`      ${refusal.statusCode}${fields} x${refusal.count}: ${refusal.message}`);
    }
  };
  for (const [name, outcome] of Object.entries(result.objectOutcomes ?? {})) {
    // What a stop kept from the target, as the audit counts it: an object
    // cut short or never reached read as one written whole, its line
    // counting what it wrote and nothing it did not send.
    const notSent = outcome.notSent ?? 0;
    lines.push(
      `  ${name.padEnd(28)} written ${outcome.written}  linked ${outcome.linked}  ` +
        `refused ${outcome.failed}${notSent > 0 ? `  not sent ${notSent}` : ''}`,
    );
    reasons(outcome.refusals);
    // Its read or write threw part way: failed, beside what went before it.
    if (outcome.threw !== undefined) lines.push(`      FAILED part way: ${outcome.threw}`);
    // Written, and left unfinished by a stop: the panel and the audit said
    // them, and a Ctrl-C's summary named neither.
    if (outcome.lookupsLeftEmpty !== undefined) {
      lines.push(
        `      ${outcome.lookupsLeftEmpty} record(s) keep a lookup empty: the stop came before ` +
          'the second pass filled it',
      );
    }
    if (outcome.statusesNotGivenBack !== undefined) {
      lines.push(
        `      ${outcome.statusesNotGivenBack} record(s) stay drafts: the stop came before their ` +
          'status was given back',
      );
    }
    // Not sent: the target filled each in itself — the running user as owner.
    for (const lookup of outcome.leftToDefault ?? []) {
      lines.push(`      left to the target's default: ${lookup.field} x${lookup.count}`);
    }
    // Not sent either: rows the platform writes itself, and what hangs from them.
    for (const left of outcome.leftToThePlatform ?? []) {
      lines.push(`      ${leftToThePlatformNote(left.count, left.why)}`);
    }
    // Nor the contacts of person accounts: the platform wrote each with its account.
    if (outcome.withTheirPersonAccount !== undefined && outcome.withTheirPersonAccount > 0) {
      lines.push(
        `      ${outcome.withTheirPersonAccount} contact(s) of person accounts left to the ` +
          'platform, which wrote each with its account: linked to it, not sent',
      );
    }
    // Nor what came to name a record the fit cut: it stays out with that record.
    if (outcome.cutSinceFit !== undefined) {
      lines.push(
        `      ${CUT_WITH_PARENT} x${outcome.cutSinceFit}: read naming a record the fit cut, ` +
          'and left out with it: neither written nor refused',
      );
    }
    // Sent in another currency than read: the target does not hold theirs active.
    for (const entry of outcome.currenciesReplaced ?? []) {
      lines.push(`      ${describeCurrencyReplaced(entry)}`);
    }
    // Prices read in a currency the target lacks: linked to the source's own.
    for (const sentence of describeSettledPrices(outcome.pricesSettled ?? [])) {
      lines.push(`      ${sentence}`);
    }
  }
  for (const name of result.failedObjects) {
    if (result.objectOutcomes?.[name]) continue;
    lines.push(`  ${name.padEnd(28)} FAILED: ${result.nodeErrors?.[name] ?? '(no message)'}`);
  }
  // The records refused, each once: a reason counts a record under each it
  // was refused for, and summed, one order refused for two read as two.
  for (const [name, lookups] of Object.entries(result.lookups ?? {})) {
    lines.push(
      `  ${name.padEnd(28)} lookups filled ${lookups.filled}  refused ${lookups.leftEmpty ?? 0}`,
    );
    reasons(lookups.refusals);
  }
  for (const [name, statuses] of Object.entries(result.statuses ?? {})) {
    lines.push(
      `  ${name.padEnd(28)} statuses applied ${statuses.applied}  refused ${statuses.leftDraft ?? 0}`,
    );
    reasons(statuses.refusals);
  }
  // The record types the target gave the records created without one, read
  // back once the last write was through, as a clone says them.
  lines.push(...recordTypeGivenOfObjectsLines(Object.values(result.objectOutcomes ?? {}), false));
  return lines;
}

// `tsx` runs this file directly; the check keeps it silent under test.
if (process.argv[1]?.includes('sandforge-autopilot')) {
  holdOutputWhole();
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

export type { Connection };
