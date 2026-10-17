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
  AutopilotPlanScope,
  AutopilotRefusal,
  ComplianceFrameworkType,
  ExecutionPlan,
} from '@sandforge/shared';
import { recordWriteHeaders } from '@sandforge/shared';
import { loadOrg, makeConn } from './sfSession.js';
import { AutopilotOrchestrator } from '../src/modules/autopilot/AutopilotOrchestrator.js';
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
  pageSoql,
  type ExecutionResult,
} from '../src/modules/autopilot/AutopilotExecutor.js';
import { AutopilotGrappeAdapter } from '../src/modules/autopilot/AutopilotGrappeAdapter.js';
import { toSaveOutcomes } from '../src/core/common/existingRecordMatch.js';
import {
  parseRecordTypeCounts,
  parseRecordTypeInfos,
  recordTypeCountSoql,
  type RecordTypeAvailability,
} from '../src/core/metadata/recordTypeAvailability.js';
import { describedLookups, type DescribedLookup } from '../src/core/metadata/describedLookups.js';
import { queryAllPages } from '../src/modules/forge/queryAllPages.js';
import { leftToThePlatformNote } from '../src/core/common/platformRecords.js';
import { sanitizeSoqlValue } from '../src/core/common/soqlValidator.js';
import { extractErrorMessage } from '../src/core/common/extractErrorMessage.js';
import { PIIDetector } from '../src/core/precheck/PIIDetector.js';
import { detectPersonalFields } from '../src/modules/autopilot/personalFields.js';
import {
  autopilotEmails,
  autopilotWritePlan,
  emailRefusal,
  objectsThePlanWrites,
} from '../src/modules/autopilot/AutopilotRunGate.js';
import {
  DEFAULT_MAX_TOTAL,
  emailCheckLines,
  readDataStorage,
  readEmailLimits,
  storageCheckOf,
  storageRefusal,
  writePlanLines,
  type DataStorage,
} from '../src/modules/forge/ForgeRunGate.js';
import { targetAutomationReader } from './sandforge-clone.js';

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
                         A standard object a record cannot be written without
                         is taken either way, and said.
  --max-depth <n>        lookups followed from a selected object  (default: 5)
  --max-objects <n>      objects the plan holds, the selected ones included;
                         each parent a record needs raises it, to twice
                                                                   (default: 50)
  --max-total <n>        most records the run may write in all    (default: 10000)
  --compliance <name>    none | gdpr | ccpa | hipaa | pci_dss      (default: none)
  --batch-size <n>       records per write call                   (default: 200)
  --plan-only            scan, graph and plan, then stop          (default: off)
  --json                 emit the run summary as JSON, with the id
                         of every record the run created          (default: off)
  --help                 this text

A selected object is copied whole. Of any other object, only the records the
selection references are read, by id; a lookup past the bounds is left empty,
and the plan says which. Before it writes, the run is held to --max-total, to
the data storage the target has left, and to the daily emails the target's
flows would send for its records: past any, nothing is written.

Exit codes: 0 the run finished (read the summary for per-object failures),
1 the run could not be started or was refused, 2 a bad command line.
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
  json: boolean;
}

/** SObject API name — letter-prefixed, alphanumeric and underscore. */
const API_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;

/** Read the command line, or explain why it cannot be read. */
export function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    process.exit(0);
  }
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
    json: args.includes('--json'),
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
  const log = (line: string): void => {
    if (!args.json) process.stdout.write(`${line}\n`);
  };

  log(`sandforge-autopilot  ${args.source} -> ${args.target}`);
  log(`objects: ${args.objects.join(', ')}`);

  const sourceConn = makeConn(await loadOrg(args.source));
  const targetConn = makeConn(await loadOrg(args.target));
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
    };
    targetByObject.set(objectApiName, answer);
    return answer;
  };
  const anonymizer = new SmartAnonymizer();
  const orchestrator = new AutopilotOrchestrator({
    schemaScanner: new SchemaScanner(),
    graphBuilder: new DependencyGraphBuilder(),
    complianceEngine: new ComplianceEngine(),
    anonymizer,
    planGenerator: new ExecutionPlanGenerator(),
    remapper: new RecordIdRemapper(),
    createExecutor: () =>
      new AutopilotExecutor({
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
            await targetConn
              .sobject(objectApiName)
              .create(cleaned, { headers: recordWriteHeaders() }),
            objectApiName,
          );
          // Every id a run creates is reported, so the run can be undone to
          // the record: nothing else tells its records from anyone else's.
          const ids = outcomes.filter((o) => o.success && o.id).map((o) => o.id);
          created.set(objectApiName, [...(created.get(objectApiName) ?? []), ...ids]);
          return outcomes;
        },
        update: async (objectApiName, records) =>
          toSaveOutcomes(
            await targetConn
              .sobject(objectApiName)
              .update(records as Array<Record<string, unknown> & { Id: string }>, {
                headers: recordWriteHeaders(),
              }),
            objectApiName,
          ),
        // Each read of the source is bounded, as it is for the panel; the
        // target is read to its last page.
        querySource: async (soql) =>
          (await sourceConn.query<Record<string, unknown>>(soql)).records,
        queryTarget: everyPage(targetConn),
        describeKeyPrefix: async (objectApiName) => (await describeTarget(objectApiName)).keyPrefix,
        describeLookups: async (objectApiName) => (await describeTarget(objectApiName)).lookups,
        anonymizer,
        remapper: new RecordIdRemapper(),
        describeCreateableFields: async (objectApiName) =>
          (await describeTarget(objectApiName)).creatable,
        describeRecordTypes: async (objectApiName) =>
          (await describeTarget(objectApiName)).recordTypes,
        // The same count the panel asks, for the same reason: every record
        // type an object carries has to be known before its first page.
        countRecordTypes: async (objectApiName) => {
          const counted = await sourceConn.query<Record<string, unknown>>(
            recordTypeCountSoql(objectApiName),
          );
          return parseRecordTypeCounts(counted.records);
        },
      }),
    grappeAdapter: new AutopilotGrappeAdapter(),
  });

  log('\nscanning…');
  const scan = await orchestrator.scanSchemas(
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
  const graph = orchestrator.buildGraph(scan, args.batchSize);
  log(`graph: ${graph.nodes.length} node(s), ${graph.edges.length} edge(s)`);

  // The personal fields the detector names, whenever the framework
  // anonymizes: the compliance engine maps them to its rules. Without them a
  // GDPR plan anonymized nothing.
  const detected =
    args.compliance === 'none' ? [] : detectPersonalFields(new PIIDetector(), scan.objectDescribes);
  const { rules } = orchestrator.buildCompliance(args.compliance, [], detected);
  const plan = orchestrator.generatePlan(graph, args.compliance, rules, scan.scope);
  log(`plan: ${plan.waves.length} wave(s), ${plan.totalRecords} record(s)`);
  plan.waves.forEach((wave, index) => {
    log(`  wave ${index + 1}: ${wave.objects.join(', ')}`);
  });
  for (const line of scopeLines(scan.scope)) log(line);
  for (const line of anonymizationLines(plan)) log(line);

  const recordCounts = new Map<string, number>(
    graph.nodes.map((node) => [node.objectApiName, node.recordCount]),
  );

  // The records the plan writes and the data storage they take, held to
  // --max-total and to what the target has left, as a clone is. With
  // --plan-only, what a real run would meet there.
  const writePlan = autopilotWritePlan(plan, recordCounts);
  let storage: DataStorage | { unread: string };
  try {
    storage = await readDataStorage(targetConn);
  } catch (err: unknown) {
    storage = { unread: extractErrorMessage(err) };
  }
  const check = storageCheckOf(writePlan, storage);
  log('');
  for (const line of writePlanLines(writePlan, check, args.target)) log(line);
  // The emails the target's flows send as the plan's records go in, against
  // what it has left today: its automation read as Forge reads it, its limits
  // when something sends. Past them, the run is refused, as past the storage.
  const emails = await autopilotEmails({
    plan: writePlan,
    objects: objectsThePlanWrites(plan),
    readAutomation: (objects) => targetAutomationReader(targetConn).read(args.target, objects),
    readLimits: () => readEmailLimits(targetConn),
  });
  for (const line of emailCheckLines(emails.checks, args.target)) log(line);
  if (emails.unread !== undefined) {
    log(`  emails: not counted, ${emails.unread} could not be read`);
  }
  const refusals = [
    writePlan.totalRows > args.maxTotal
      ? `The run would write ${writePlan.totalRows} records, more than --max-total ` +
        `${args.maxTotal}: narrow it (--object, --max-depth, --max-objects), or raise --max-total.`
      : undefined,
    storageRefusal(check, args.target),
    emailRefusal(emails.checks, args.target),
  ].filter((reason): reason is string => reason !== undefined);

  if (args.planOnly) {
    for (const reason of refusals) log(`  a real run would be refused: ${reason}`);
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
              emails: emails.checks,
              ...(emails.unread !== undefined ? { emailsUnread: emails.unread } : {}),
              refusals,
            },
          },
          null,
          2,
        )}\n`,
      );
    }
    return;
  }
  if (refusals.length > 0) {
    throw new Error(`${refusals.join(' ')} Nothing was written.`);
  }

  log('\nexecuting… (REAL)');
  const result = await orchestrator.executePlan(
    plan,
    graph,
    rules,
    recordCounts,
    undefined,
    undefined,
    scan.parentIds,
  );
  const elapsedMs = Date.now() - t0;

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify({ tool: 'sandforge-autopilot', source: args.source, target: args.target, result, created: Object.fromEntries(created), elapsedMs }, null, 2)}\n`,
    );
    return;
  }

  log(
    `\nwritten: ${result.totalSuccess}   linked: ${result.totalLinked ?? 0}   ` +
      `refused: ${result.totalFailure}   skipped: ${result.totalSkipped}`,
  );
  if (result.skippedObjects.length > 0) log(`  skipped: ${result.skippedObjects.join(', ')}`);
  if (result.fatalError) log(`  the run died with: ${result.fatalError}`);
  for (const line of outcomeLines(result)) log(line);
  log(`\ndone in ${elapsedMs}ms`);
}

/**
 * What the plan copies of each object and what it leaves out: the selected
 * objects whole, the others by the records the selection references, and
 * each lookup left empty with why. Exported so it can be tested.
 */
export function scopeLines(scope: AutopilotPlanScope): string[] {
  const lines = [
    `scope: depth ${scope.maxDepth}, at most ${scope.maxObjects} object(s)`,
    `  copied whole, as selected: ${scope.selected.join(', ') || '(none)'}`,
  ];
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
  return lines;
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
    lines.push(
      `  ${name.padEnd(28)} written ${outcome.written}  linked ${outcome.linked}  ` +
        `refused ${outcome.failed}`,
    );
    reasons(outcome.refusals);
    // Not sent: the target filled each in itself — the running user as owner.
    for (const lookup of outcome.leftToDefault ?? []) {
      lines.push(`      left to the target's default: ${lookup.field} x${lookup.count}`);
    }
    // Not sent either: rows the platform writes itself, and what hangs from them.
    for (const left of outcome.leftToThePlatform ?? []) {
      lines.push(`      ${leftToThePlatformNote(left.count, left.why)}`);
    }
  }
  for (const name of result.failedObjects) {
    if (result.objectOutcomes?.[name]) continue;
    lines.push(`  ${name.padEnd(28)} FAILED: ${result.nodeErrors?.[name] ?? '(no message)'}`);
  }
  for (const [name, lookups] of Object.entries(result.lookups ?? {})) {
    const refused = lookups.refusals.reduce((sum, refusal) => sum + refusal.count, 0);
    lines.push(`  ${name.padEnd(28)} lookups filled ${lookups.filled}  refused ${refused}`);
    reasons(lookups.refusals);
  }
  for (const [name, statuses] of Object.entries(result.statuses ?? {})) {
    const refused = statuses.refusals.reduce((sum, refusal) => sum + refusal.count, 0);
    lines.push(`  ${name.padEnd(28)} statuses applied ${statuses.applied}  refused ${refused}`);
    reasons(statuses.refusals);
  }
  return lines;
}

// `tsx` runs this file directly; the check keeps it silent under test.
if (process.argv[1]?.includes('sandforge-autopilot')) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

export type { Connection };
