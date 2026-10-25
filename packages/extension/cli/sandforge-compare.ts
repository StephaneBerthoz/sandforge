#!/usr/bin/env tsx
/**
 * sandforge-compare — headless Compare runner.
 *
 * Compare had full unit-test coverage and had never been pointed at a real
 * pair of orgs; the five modules run against real orgs before it had yielded
 * twenty-five defects between them, none of which any gate had seen.
 *
 * It sends the Compare page's requests through the extension's own
 * composition (see `panelHost.ts`) and prints what the page would receive.
 * The four comparison requests only read. The fifth validates a deployment:
 * the target compiles and tests the components check-only and keeps none of
 * them. The page's other deployment request, the one that deploys, is not
 * one this tool can send.
 *
 * Usage:
 *   pnpm exec tsx packages/extension/cli/sandforge-compare.ts \
 *     --source SRC --target TGT --type ApexClass --type Flow
 *   pnpm exec tsx packages/extension/cli/sandforge-compare.ts \
 *     --source SRC --target TGT --op permissions --op drift
 *   pnpm exec tsx packages/extension/cli/sandforge-compare.ts \
 *     --source SRC --target TGT --validate ApexClass:Invoicing \
 *     --tests RunSpecifiedTests --run-test InvoicingTest
 *
 * Run from the repository root of a checkout, after pnpm install and
 * pnpm build:shared.
 */

import {
  DEPLOYABLE_COMPONENT_TYPES,
  DEPLOY_TEST_LEVELS,
  DEPLOY_TEST_NAME_PATTERN,
  DEPLOY_WAIT_MINUTES,
} from '@sandforge/shared';
import type {
  CompareItem,
  CompareResult,
  DeploymentComponentRef,
  DeploymentReport,
  DeployTestLevel,
  MetadataComponentType,
} from '@sandforge/shared';
import { createPanelHost } from './panelHost.js';
import type { PanelAnswer } from './panelHost.js';
import { refuseUnreadArguments, type CommandFlags } from './commandLine.js';
import { openBackupStore, toolStoreOf } from './backupStore.js';
import { DONE_EXIT, endWith, FAILED_EXIT, PARTIAL_EXIT } from './exitCodes.js';
import { holdOutputWhole } from './wholeOutput.js';

const HELP = `sandforge-compare — compare two orgs the way the Compare page does, without the editor.

Usage:
  pnpm exec tsx packages/extension/cli/sandforge-compare.ts --source <alias> --target <alias> [options]

Required:
  --source <alias>       sf CLI alias of the source org
  --target <alias>       sf CLI alias of the target org

Options:
  --op <name>            execute | permissions | snapshots | drift |
                         validate-deployment; repeat for more
                         (default: the first four, or validate-deployment
                         alone when --validate is given)
  --type <Type>          a metadata category to diff (execute); repeat for more
  --all-types            every category the page offers, as "Select all" does
  --exclude-managed      leave out what a managed package installed (execute),
                         as the page does with its box unticked
  --validate <Type:Name> a component to validate a deployment of, from the
                         source to the target; repeat for more
  --tests <level>        the Apex tests the validation runs: NoTestRun |
                         RunLocalTests | RunSpecifiedTests (default: NoTestRun)
  --run-test <Class>     a test class RunSpecifiedTests runs; repeat for more
  --store <dir>          where the host keeps its config store, a folder of your
                         own (default: ~/.sandforge/compare, under the folder
                         SANDFORGE_JOURNAL_DIR names when it is set)
  --wait <seconds>       how long to keep waiting for an answer     (default: 300)
  --fail-on-drift        exit 3 when a diff (execute) finds a component added,
                         removed or modified                         (default: off)
  --json                 emit what the page would receive, every other line on
                         stderr
  --help                 this text

Nothing is written to either org. A validation deploys check-only: the
target compiles the components and runs the tests, keeps none of them, and
lists the validation in Setup › Deployment Status. This tool never deploys.

Exit codes: 0 every request was answered, and every validation succeeded (a
diff is read, whatever it found, unless --fail-on-drift); 1 it could not
start, or a request failed, was refused or was not answered in time; 2 a bad
command line; 3 a validation came back with no success, a component error or
a failed test, or --fail-on-drift and a diff found differences.
`;

/**
 * The requests this tool sends: the page's four comparison requests, and its
 * validation. The page's `compare:deploy` is not among them.
 */
const OPERATIONS = ['execute', 'permissions', 'snapshots', 'drift', 'validate-deployment'] as const;
type Operation = (typeof OPERATIONS)[number];

/** What runs when no --op is given and no --validate either. */
const READ_OPERATIONS: readonly Operation[] = ['execute', 'permissions', 'snapshots', 'drift'];

/**
 * The categories the page's CategorySelector offers, in its order. "Select
 * all" sends exactly these; the page can send nothing else.
 */
export const PAGE_COMPONENT_TYPES: readonly MetadataComponentType[] = [
  'CustomObject',
  'CustomField',
  'RecordType',
  'ApexClass',
  'ApexTrigger',
  'LightningComponentBundle',
  'Flow',
  'WorkflowRule',
  'ValidationRule',
  'Profile',
  'PermissionSet',
  'Layout',
  'CustomLabel',
  'CustomMetadata',
  'StaticResource',
  'EmailTemplate',
  'Report',
  'Dashboard',
];

/** How long the page waits for a diff (`COMPARE_TIMEOUT_MS` in ComparePage). */
const PAGE_EXECUTE_TIMEOUT_MS = 5 * 60_000;

/** How long the page waits for a validation (`VALIDATE_TIMEOUT_MS` in DeployPanel). */
const PAGE_VALIDATE_TIMEOUT_MS =
  (2 * DEPLOY_WAIT_MINUTES.retrieve + DEPLOY_WAIT_MINUTES.deploy + 1) * 60_000;

/** The validation asked for: the components, and the tests the target runs. */
interface ValidationArgs {
  components: DeploymentComponentRef[];
  testLevel: DeployTestLevel;
  runTests: string[];
}

/** Everything the command line settled. */
interface CliArgs {
  source: string;
  target: string;
  operations: Operation[];
  types: MetadataComponentType[];
  /** Whether the diff compares what a managed package installed; the page's box. */
  includeManaged: boolean;
  validation: ValidationArgs;
  storeDir: string;
  waitMs: number;
  json: boolean;
  /** Exit 3 when a diff finds a component added, removed or modified. */
  failOnDrift: boolean;
}

/** What the line reads. */
const FLAGS: CommandFlags = {
  switches: ['--all-types', '--exclude-managed', '--json', '--fail-on-drift'],
  values: [
    '--source',
    '--target',
    '--op',
    '--type',
    '--validate',
    '--tests',
    '--run-test',
    '--store',
    '--wait',
  ],
};

/** Read the command line, or explain why it cannot be read. */
export function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  // A misspelt flag, or `--validate=ApexClass:A`, was dropped without a word.
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
  const refuse = (line: string): never => {
    process.stderr.write(`${line}\n`);
    process.exit(2);
  };

  const source = get('--source');
  const target = get('--target');
  if (!source || !target) refuse('Missing --source or --target. Run with --help.');
  if (source === target) {
    // The page's Run button stays disabled for one org compared with itself.
    refuse('--source and --target name the same org.');
  }

  const asked = collect('--op');
  for (const op of asked) {
    if (!(OPERATIONS as readonly string[]).includes(op)) {
      refuse(`Not an operation: "${op}". One of: ${OPERATIONS.join(', ')}.`);
    }
  }
  const validation = parseValidation(collect, get, refuse);
  const operations =
    asked.length > 0
      ? [...new Set(asked as Operation[])]
      : validation.components.length > 0
        ? (['validate-deployment'] as Operation[])
        : [...READ_OPERATIONS];
  if (operations.includes('validate-deployment') && validation.components.length === 0) {
    // Nor does the page validate with nothing picked.
    refuse('validate-deployment needs a component: give --validate Type:Name.');
  }

  const named = collect('--type');
  for (const type of named) {
    if (!(PAGE_COMPONENT_TYPES as readonly string[]).includes(type)) {
      refuse(`Not a category the page offers: "${type}".`);
    }
  }
  const types = args.includes('--all-types')
    ? [...PAGE_COMPONENT_TYPES]
    : [...new Set(named as MetadataComponentType[])];
  if (operations.includes('execute') && types.length === 0) {
    // Nor does it run a diff with no category ticked.
    refuse('execute needs a category: give --type or --all-types, or leave execute out with --op.');
  }

  const waitRaw = get('--wait', '300') ?? '300';
  const waitSeconds = Number(waitRaw);
  if (!Number.isInteger(waitSeconds) || waitSeconds < 1) {
    refuse('--wait takes a whole number of seconds.');
  }

  return {
    source: source as string,
    target: target as string,
    operations,
    types,
    includeManaged: !args.includes('--exclude-managed'),
    validation,
    storeDir: get('--store') ?? toolStoreOf('compare'),
    waitMs: waitSeconds * 1000,
    json: args.includes('--json'),
    failOnDrift: args.includes('--fail-on-drift'),
  };
}

/**
 * The validation the command line asks for, refused where the page would not
 * send it: a type a deployment does not carry, a test that is no class name,
 * named tests at another level.
 */
function parseValidation(
  collect: (flag: string) => string[],
  get: (flag: string, fallback?: string) => string | undefined,
  refuse: (line: string) => never,
): ValidationArgs {
  const components: DeploymentComponentRef[] = [];
  for (const spec of collect('--validate')) {
    const at = spec.indexOf(':');
    const componentType = spec.slice(0, at);
    const fullName = spec.slice(at + 1);
    if (at < 1 || fullName === '') refuse(`--validate takes Type:Name, got "${spec}".`);
    if (!(DEPLOYABLE_COMPONENT_TYPES as readonly string[]).includes(componentType)) {
      refuse(`Not a type a deployment carries: "${componentType}".`);
    }
    components.push({ componentType: componentType as MetadataComponentType, fullName });
  }
  const level = get('--tests', 'NoTestRun') ?? 'NoTestRun';
  if (!(DEPLOY_TEST_LEVELS as readonly string[]).includes(level)) {
    refuse(`Not a test level: "${level}". One of: ${DEPLOY_TEST_LEVELS.join(', ')}.`);
  }
  const testLevel = level as DeployTestLevel;
  const runTests = collect('--run-test');
  for (const name of runTests) {
    if (!DEPLOY_TEST_NAME_PATTERN.test(name)) refuse(`Not an Apex class name: "${name}".`);
  }
  if (testLevel === 'RunSpecifiedTests' && runTests.length === 0) {
    refuse('RunSpecifiedTests needs a test class: give --run-test.');
  }
  if (testLevel !== 'RunSpecifiedTests' && runTests.length > 0) {
    refuse('--run-test names the tests of --tests RunSpecifiedTests only.');
  }
  return { components, testLevel, runTests };
}

/** Lines for one deployment report: the verdict, each component, each failed test. */
export function describeDeployment(report: DeploymentReport): string[] {
  const { counts } = report;
  const lines = [
    `  ${report.checkOnly ? 'validation' : 'deployment'} ${report.deployId ?? '(none sent)'}: ` +
      `${report.status}, ${report.success ? 'success' : 'no success'}` +
      (report.errorMessage ? ` — ${report.errorMessage}` : ''),
    `  components: ${counts.componentsDeployed} of ${counts.componentsTotal} without an error, ` +
      `${counts.componentErrors} with one; tests (${report.testLevel}` +
      `${report.runTests.length > 0 ? `: ${report.runTests.join(', ')}` : ''}): ` +
      `${counts.testsCompleted} of ${counts.testsTotal} passed, ${counts.testErrors} failed`,
  ];
  for (const c of report.components) {
    const at =
      c.line !== undefined
        ? ` (line ${c.line}${c.column !== undefined ? `, column ${c.column}` : ''})`
        : '';
    const problem = c.problem ? ` — ${c.problem}${at}` : '';
    lines.push(`    ${c.outcome.padEnd(13)} ${c.componentType} ${c.fullName}${problem}`);
  }
  for (const f of report.testFailures) {
    const name = f.methodName ? `${f.className}.${f.methodName}` : f.className;
    const at = f.line !== undefined ? ` (line ${f.line})` : '';
    lines.push(`    test failed  ${name}${at} — ${f.message}`);
  }
  for (const w of report.coverageWarnings) lines.push(`    coverage     ${w}`);
  for (const p of report.retrieveProblems ?? []) lines.push(`    source said  ${p}`);
  return lines;
}

/**
 * The components called modified, by type, in the order the diff lists them.
 * Each verdict rests on content read from both orgs; these are the names to
 * read back when checking one.
 */
export function modifiedByType(diffs: readonly CompareItem[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const item of diffs) {
    if (item.status !== 'modified') continue;
    const names = out.get(item.componentType) ?? [];
    names.push(item.fullName);
    out.set(item.componentType, names);
  }
  return out;
}

/** What the content comparison covered, in one line. */
export function describeCoverage(result: Pick<CompareResult, 'summary' | 'content'>): string {
  const { content, summary } = result;
  const inBoth = summary.modified + summary.unchanged + summary.notCompared;
  const { over_budget: overBudget, unreadable, read_failed: readFailed } = content.notCompared;
  const leftOut = content.managedLeftOut
    ? `; left out, as asked: ${content.managedLeftOut} installed by a managed package`
    : '';
  return (
    `  content compared for ${content.compared} of ${inBoth} in both orgs; not compared: ` +
    `${overBudget} over the budget (${content.budget.components} per org, ${content.budget.seconds} s), ` +
    `${unreadable} unreadable, ${readFailed} read failed${leftOut}`
  );
}

/** Lines for one diff answer. */
function describeExecute(result: CompareResult): string[] {
  const { summary } = result;
  const lines = [
    `  mode ${result.mode}, ${summary.totalItems} item(s): +${summary.added} added  ` +
      `-${summary.removed} removed  ~${summary.modified} modified  =${summary.unchanged} unchanged  ` +
      `?${summary.notCompared} not compared`,
  ];
  const byType = new Map<string, Record<string, number>>();
  for (const item of result.diffs) {
    const row = byType.get(item.componentType) ?? {};
    row[item.status] = (row[item.status] ?? 0) + 1;
    byType.set(item.componentType, row);
  }
  for (const [type, row] of byType) {
    const inBoth = (row.modified ?? 0) + (row.unchanged ?? 0) + (row.not_compared ?? 0);
    const inSource = (row.removed ?? 0) + inBoth;
    const inTarget = (row.added ?? 0) + inBoth;
    lines.push(
      `    ${type.padEnd(26)} source ${String(inSource).padStart(5)}  target ${String(inTarget).padStart(5)}` +
        `   +${row.added ?? 0} -${row.removed ?? 0} ~${row.modified ?? 0} =${row.unchanged ?? 0} ?${row.not_compared ?? 0}`,
    );
  }
  lines.push(describeCoverage(result));
  for (const [type, names] of modifiedByType(result.diffs)) {
    lines.push(`  modified ${type}: ${someOf(names)}`);
  }
  return lines;
}

/** Up to `max` names, then how many more. */
function someOf(names: readonly string[], max = 8): string {
  if (names.length === 0) return '—';
  const shown = names.slice(0, max).join(', ');
  return names.length > max ? `${shown} … (+${names.length - max})` : shown;
}

/** Lines for one presence answer (permission sets and profiles). */
function describePresence(
  label: string,
  side: {
    sourceOnly?: Array<{ name: string }>;
    targetOnly?: Array<{ name: string }>;
    shared?: unknown[];
  },
): string[] {
  const sourceOnly = (side.sourceOnly ?? []).map((p) => p.name);
  const targetOnly = (side.targetOnly ?? []).map((p) => p.name);
  return [
    `  ${label}: ${sourceOnly.length} source only, ${targetOnly.length} target only, ` +
      `${(side.shared ?? []).length} in both`,
    `    source only: ${someOf(sourceOnly)}`,
    `    target only: ${someOf(targetOnly)}`,
  ];
}

/** Readable lines for what the page would receive. */
export function describeAnswer(op: Operation, answer: PanelAnswer): string[] {
  const took = `${(answer.elapsedMs / 1000).toFixed(1)}s`;
  const head = `compare:${op}  ${answer.outcome} in ${took}`;
  const lines = [answer.late ? `${head}  — past the page's timeout: the page dropped it` : head];
  const payload = (answer.message?.payload ?? {}) as Record<string, unknown>;
  if (answer.outcome !== 'answered') {
    if (answer.message) lines.push(`  ${String(payload.message ?? JSON.stringify(payload))}`);
    return lines;
  }
  if (op === 'execute') return [...lines, ...describeExecute(payload as unknown as CompareResult)];
  if (op === 'validate-deployment') {
    const report = payload.report as DeploymentReport | undefined;
    return report ? [...lines, ...describeDeployment(report)] : [...lines, '  (no report)'];
  }
  if (op === 'permissions') {
    const permissions = (payload.permissions ?? {}) as Record<
      string,
      Parameters<typeof describePresence>[1]
    >;
    return [
      ...lines,
      ...describePresence('permission sets', permissions.permissionSets ?? {}),
      ...describePresence('profiles', permissions.profiles ?? {}),
    ];
  }
  if (op === 'snapshots') {
    const snapshot = (payload.snapshot ?? {}) as {
      source?: Record<string, number>;
      target?: Record<string, number>;
      diff?: { sourceOnly?: string[]; targetOnly?: string[]; sharedCount?: number };
    };
    const count = (side?: Record<string, number>): string =>
      side
        ? `${side.totalObjects} objects (${side.customObjects} custom, ${side.standardObjects} standard, ` +
          `${side.queryableObjects} queryable)`
        : '—';
    return [
      ...lines,
      `  source: ${count(snapshot.source)}`,
      `  target: ${count(snapshot.target)}`,
      `  ${snapshot.diff?.sharedCount ?? 0} in both; source only: ${someOf(snapshot.diff?.sourceOnly ?? [])}`,
      `  target only: ${someOf(snapshot.diff?.targetOnly ?? [])}`,
    ];
  }
  const drift = (payload.drift ?? {}) as {
    items?: Array<{ setting: string; sourceValue: string; targetValue: string; status: string }>;
  };
  return [
    ...lines,
    ...(drift.items ?? []).map(
      (item) =>
        `  ${item.status.padEnd(14)} ${item.setting}: ${item.sourceValue} | ${item.targetValue}`,
    ),
  ];
}

/**
 * The exit code of a run, from its answers: 1 when a request was not answered
 * — it failed, was refused, or nothing came back in time —; 3 when a
 * validation came back with no success, a component error or a failed test,
 * or, with `--fail-on-drift`, when a diff found a component added, removed or
 * modified; 0 otherwise. A diff is read, and said, whatever it found.
 *
 * The run exited 0 whatever it received: a check-only deployment that failed
 * to compile, or whose tests failed, passed the pipeline it was to gate.
 * Exported so it can be tested.
 */
export function compareExitCode(
  results: ReadonlyArray<{ op: Operation; answer: PanelAnswer }>,
  failOnDrift = false,
): number {
  if (results.some(({ answer }) => answer.outcome !== 'answered')) return FAILED_EXIT;
  const payloadOf = (answer: PanelAnswer): Record<string, unknown> =>
    (answer.message?.payload ?? {}) as Record<string, unknown>;
  const failedValidation = results.some(({ op, answer }) => {
    if (op !== 'validate-deployment') return false;
    const report = payloadOf(answer).report as DeploymentReport | undefined;
    return (
      report === undefined ||
      !report.success ||
      report.counts.componentErrors > 0 ||
      report.counts.testErrors > 0
    );
  });
  if (failedValidation) return PARTIAL_EXIT;
  const drifted = results.some(({ op, answer }) => {
    if (op !== 'execute') return false;
    const summary = (payloadOf(answer) as unknown as Partial<CompareResult>).summary;
    return summary !== undefined && summary.added + summary.removed + summary.modified > 0;
  });
  return failOnDrift && drifted ? PARTIAL_EXIT : DONE_EXIT;
}

/** Run the page's requests; exported so its parsing can be tested. */
export async function main(argv: string[] = process.argv): Promise<void> {
  const args = parseArgs(argv);
  // On stderr with --json, where stdout carries the JSON alone.
  const log = (line: string): void => {
    process[args.json ? 'stderr' : 'stdout'].write(`${line}\n`);
  };

  // The host's folder, its owner's alone: a fixed folder of the system's
  // temp directory was every user's of a shared runner to make first, and two
  // jobs there wrote over each other's store.
  const refused = openBackupStore(args.storeDir);
  if (refused !== undefined) {
    process.stderr.write(`${refused}\n`);
    process.exitCode = FAILED_EXIT;
    return;
  }
  const host = createPanelHost({
    storeDir: args.storeDir,
    // The extension's own warnings and failures, not its routine traffic.
    log: (line) => {
      if (/^\s*!|\[(ERR|WARN)\]/.test(line)) log(line);
    },
    waitMs: args.waitMs,
  });
  const source = await host.connect(args.source);
  const target = await host.connect(args.target);
  log(
    `sandforge-compare  ${args.source} (${source.orgType}) -> ${args.target} (${target.orgType})`,
  );

  const results: Array<{ op: Operation; answer: PanelAnswer }> = [];
  for (const op of args.operations) {
    const payload: Record<string, unknown> = { sourceOrgId: source.id, targetOrgId: target.id };
    if (op === 'execute') {
      payload.types = args.types;
      payload.includeManaged = args.includeManaged;
    }
    if (op === 'validate-deployment') {
      // What DeployPanel sends: the components, the level, and the names
      // only for the level that runs named tests.
      payload.components = args.validation.components;
      payload.testLevel = args.validation.testLevel;
      if (args.validation.testLevel === 'RunSpecifiedTests') {
        payload.runTests = args.validation.runTests;
      }
    }
    const answer = await host.request({
      type: `compare:${op}`,
      payload,
      ...(op === 'execute' ? { timeoutMs: PAGE_EXECUTE_TIMEOUT_MS } : {}),
      ...(op === 'validate-deployment' ? { timeoutMs: PAGE_VALIDATE_TIMEOUT_MS } : {}),
    });
    results.push({ op, answer });
    for (const line of describeAnswer(op, answer)) log(line);
  }

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify({ tool: 'sandforge-compare', results, posted: host.posted }, null, 2)}\n`,
    );
  }
  endWith(compareExitCode(results, args.failOnDrift));
}

// `tsx` runs this file directly; the check keeps it silent under test.
if (process.argv[1]?.includes('sandforge-compare')) {
  holdOutputWhole();
  main()
    .then(() => process.exit(process.exitCode ?? 0))
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
