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
 * them. `--deploy` sends the Deploy tab's two requests in its order: the
 * validation, then, once the target's alias is typed or `--yes` given, the
 * deployment of the package the target validated. It refused to, and named
 * the tab, which left a pipeline that had validated a change with no way to
 * ship it but a person at VS Code.
 *
 * Usage:
 *   pnpm exec tsx packages/extension/cli/sandforge-compare.ts \
 *     --source SRC --target TGT --type ApexClass --type Flow
 *   pnpm exec tsx packages/extension/cli/sandforge-compare.ts \
 *     --source SRC --target TGT --op permissions --op drift
 *   pnpm exec tsx packages/extension/cli/sandforge-compare.ts \
 *     --source SRC --target TGT --validate ApexClass:Invoicing \
 *     --tests RunSpecifiedTests --run-test InvoicingTest
 *   pnpm exec tsx packages/extension/cli/sandforge-compare.ts \
 *     --source SRC --target TGT --deploy ApexClass:Invoicing --yes
 *
 * Run from the repository root of a checkout, after pnpm install and
 * pnpm build:shared.
 */

import { randomUUID } from 'node:crypto';
import {
  DEPLOYABLE_COMPONENT_TYPES,
  DEPLOY_TEST_LEVELS,
  DEPLOY_TEST_NAME_PATTERN,
  DEPLOY_WAIT_MINUTES,
  guardTierOf,
} from '@sandforge/shared';
import type {
  CompareItem,
  CompareResult,
  DeploymentComponentRef,
  DeploymentComponentResult,
  DeploymentReport,
  DeployTestLevel,
  MetadataComponentType,
  SalesforceOrg,
} from '@sandforge/shared';
import { createPanelHost } from './panelHost.js';
import type {
  PanelAnswer,
  PanelHost,
  PanelHostOptions,
  PanelHostWiring,
  PostedMessage,
} from './panelHost.js';
import { refuseUnreadArguments, type CommandFlags } from './commandLine.js';
import { commandLineGuard } from './commandLineGuard.js';
import { openBackupStore, toolStoreOf } from './backupStore.js';
import { DONE_EXIT, endWith, FAILED_EXIT, PARTIAL_EXIT } from './exitCodes.js';
import { nameOf } from './invocation.js';
import { NO_TERMINAL_EXIT, typed, type PromptStreams } from './prompt.js';
import { productionTargetRefusal } from './targetKind.js';
import { holdOutputWhole } from './wholeOutput.js';
import type { InfraServices } from '../src/bridge/handlers/HandlerTypes.js';

const HELP = `sandforge compare — compare two orgs the way the Compare page does, without the editor, and deploy what differs as its Deploy tab does.

Usage:
  pnpm exec tsx packages/extension/cli/sandforge-compare.ts --source <alias> --target <alias> [options]
  pnpm exec tsx packages/extension/cli/sandforge-compare.ts --source <alias> --target <alias> --deploy <Type:Name> (--dry-run | --yes) [options]

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
  --deploy <Type:Name>   a component to deploy from the source to the target,
                         validated there first; repeat for more. It runs on
                         its own: no --op, --validate, --type, --all-types,
                         --exclude-managed or --fail-on-drift beside it
  --tests <level>        the Apex tests the validation runs, and the deployment
                         after it: NoTestRun | RunLocalTests | RunSpecifiedTests
                         (default: NoTestRun; with --deploy, RunLocalTests when
                         an Apex class or trigger is among the components, as
                         the Deploy tab advises)
  --run-test <Class>     a test class RunSpecifiedTests runs; repeat for more
  --yes                  (--deploy) deploy without asking for the target's alias
                         to be typed. Without it and with no terminal, refused,
                         exit 2, before any org is reached
  --dry-run              (--deploy) list what would be deployed and the tests,
                         sending nothing to either org
  --store <dir>          where the host keeps its config store, a folder of your
                         own (default: ~/.sandforge/compare, under the folder
                         SANDFORGE_JOURNAL_DIR names when it is set)
  --wait <seconds>       how long to keep waiting for an answer     (default: 300)
  --fail-on-drift        exit 3 when a diff (execute) finds a component in one
                         org only, or modified                       (default: off)
  --json                 emit what the page would receive, every other line on
                         stderr. Its messages name a component only the source
                         holds "removed" and one only the target holds "added";
                         beside a diff's answer, "changes" lists them as
                         onlyInSource, onlyInTarget and modified, as Type:Name
  --help                 this text

A comparison writes nothing to either org. A validation deploys check-only:
the target compiles the components and runs the tests, keeps none of them,
and lists the validation in Setup › Deployment Status.

--deploy deploys, as the Deploy tab of the Compare page does: it validates the
components in the target first, then, once the validation succeeds and the
target's alias is typed (or with --yes), deploys the package the target
validated, with the same tests. A deployment is all or nothing: the target
rolls a failed one back. It deletes nothing from the target, and the audit
trail of the store records it. A production target, or one that cannot be
told from one, is refused before anything is sent to either org, --dry-run
included; no flag lifts it.

Exit codes: 0 every request was answered, every validation succeeded and,
with --deploy, the deployment succeeded (a diff is read, whatever it found,
unless --fail-on-drift); 1 it could not start, it was refused before it sent
anything (a production target, an alias typed wrong), or a request failed,
was refused or was not answered in time; 2 a bad command line, or --deploy
with no terminal to type the alias on and no --yes; 3 a validation or a
deployment came back with no success, a component error or a failed test (a
deployment rolled back leaves nothing in the target), or --fail-on-drift and
a diff found differences.
`;

/**
 * The requests `--op` sends: the page's four comparison requests, and its
 * validation. Its deployment, `compare:deploy`, goes only after a validation
 * of the same run succeeded, which `--deploy` sends first.
 */
const OPERATIONS = ['execute', 'permissions', 'snapshots', 'drift', 'validate-deployment'] as const;
type Operation = (typeof OPERATIONS)[number];

/** A request this tool sends: an operation, or the deployment `--deploy` sends after its validation. */
export type Sent = Operation | 'deploy';

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

/** How long the page waits for a deployment (`DEPLOY_TIMEOUT_MS` in DeployPanel). */
const PAGE_DEPLOY_TIMEOUT_MS = (DEPLOY_WAIT_MINUTES.deploy + 1) * 60_000;

/**
 * The types whose components hold Apex, for which the Deploy tab picks the
 * target's own tests unless told otherwise (the page's `advisedTestLevel`,
 * after the risk card's "Run all Apex tests").
 */
const APEX_TYPES: ReadonlySet<string> = new Set(['ApexClass', 'ApexTrigger']);

/** The validation asked for: the components, and the tests the target runs. */
interface ValidationArgs {
  components: DeploymentComponentRef[];
  testLevel: DeployTestLevel;
  runTests: string[];
}

/** A deployment asked for: what it validates first, then deploys, and how it goes ahead. */
interface DeployArgs extends ValidationArgs {
  /** No --tests given and Apex among the components: the level is the Deploy tab's advice. */
  testsAdvised: boolean;
  /** Deploy without asking for the target's alias. */
  yes: boolean;
  /** List what would be deployed, sending nothing. */
  dryRun: boolean;
}

/** Everything the command line settled. */
interface CliArgs {
  source: string;
  target: string;
  /** The requests of a comparison; none with --deploy, which sends its own two. */
  operations: Operation[];
  types: MetadataComponentType[];
  /** Whether the diff compares what a managed package installed; the page's box. */
  includeManaged: boolean;
  validation: ValidationArgs;
  /** What --deploy asks for; undefined without it. */
  deploy?: DeployArgs;
  storeDir: string;
  waitMs: number;
  json: boolean;
  /** Exit 3 when a diff finds a component in one org only, or modified. */
  failOnDrift: boolean;
}

/** What the line reads. */
const FLAGS: CommandFlags = {
  switches: ['--all-types', '--exclude-managed', '--json', '--fail-on-drift', '--yes', '--dry-run'],
  values: [
    '--source',
    '--target',
    '--op',
    '--type',
    '--validate',
    '--deploy',
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
    if (op === 'deploy') {
      // The deployment goes only after a validation of the same run: it is
      // given the components, as the Deploy tab is.
      refuse(
        'deploy is no --op: give each component to --deploy Type:Name, which validates them in ' +
          'the target, then deploys what the target validated.',
      );
    }
    if (!(OPERATIONS as readonly string[]).includes(op)) {
      refuse(`Not an operation: "${op}". One of: ${OPERATIONS.join(', ')}.`);
    }
  }
  const deploy = parseDeploy(args, collect, get, refuse);
  if (deploy !== undefined) {
    return {
      source: source as string,
      target: target as string,
      operations: [],
      types: [],
      includeManaged: true,
      validation: { components: [], testLevel: 'NoTestRun', runTests: [] },
      deploy,
      storeDir: get('--store') ?? toolStoreOf('compare'),
      waitMs: parseWait(get, refuse),
      json: args.includes('--json'),
      failOnDrift: false,
    };
  }
  for (const flag of ['--yes', '--dry-run']) {
    if (args.includes(flag)) {
      refuse(`${flag} goes with --deploy, the one request of this command that writes to an org.`);
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
      refuse(
        `Not a category the page offers: "${type}". One of: ${PAGE_COMPONENT_TYPES.join(', ')}.`,
      );
    }
  }
  const types = args.includes('--all-types')
    ? [...PAGE_COMPONENT_TYPES]
    : [...new Set(named as MetadataComponentType[])];
  if (operations.includes('execute') && types.length === 0) {
    // Nor does it run a diff with no category ticked.
    refuse('execute needs a category: give --type or --all-types, or leave execute out with --op.');
  }

  return {
    source: source as string,
    target: target as string,
    operations,
    types,
    includeManaged: !args.includes('--exclude-managed'),
    validation,
    storeDir: get('--store') ?? toolStoreOf('compare'),
    waitMs: parseWait(get, refuse),
    json: args.includes('--json'),
    failOnDrift: args.includes('--fail-on-drift'),
  };
}

/** How long to keep waiting for an answer, in milliseconds. */
function parseWait(
  get: (flag: string, fallback?: string) => string | undefined,
  refuse: (line: string) => never,
): number {
  const waitSeconds = Number(get('--wait', '300') ?? '300');
  if (!Number.isInteger(waitSeconds) || waitSeconds < 1) {
    refuse('--wait takes a whole number of seconds.');
  }
  return waitSeconds * 1000;
}

/** The flags of a comparison, which a run that deploys does not make. */
const COMPARISON_FLAGS = [
  '--op',
  '--validate',
  '--type',
  '--all-types',
  '--exclude-managed',
  '--fail-on-drift',
] as const;

/**
 * The deployment the command line asks for, refused where the Deploy tab
 * would not send it; undefined when it asks for none.
 *
 * It runs on its own: beside it, a comparison's flags would be read by
 * nothing, and --validate would have the target validate the same package
 * twice. With no --tests, the level is the tab's: the target's own tests when
 * Apex is among the components, none otherwise.
 */
function parseDeploy(
  args: readonly string[],
  collect: (flag: string) => string[],
  get: (flag: string, fallback?: string) => string | undefined,
  refuse: (line: string) => never,
): DeployArgs | undefined {
  if (collect('--deploy').length === 0) return undefined;
  const beside = COMPARISON_FLAGS.filter((flag) => args.includes(flag));
  if (beside.includes('--validate')) {
    refuse(
      '--deploy validates what it deploys first, as the Deploy tab does: give the components ' +
        'to --deploy alone, without --validate.',
    );
  }
  if (beside.length > 0) {
    refuse(
      `${beside.join(', ')} ${beside.length === 1 ? 'goes' : 'go'} with a comparison, which a ` +
        'run with --deploy does not make: compare in a run of its own, without --deploy.',
    );
  }
  const yes = args.includes('--yes');
  const dryRun = args.includes('--dry-run');
  if (yes && dryRun) refuse('--dry-run sends nothing and --yes deploys: give one of them.');
  const asked = parseValidation(collect, get, refuse, '--deploy');
  const testsAdvised =
    get('--tests') === undefined && asked.components.some((c) => APEX_TYPES.has(c.componentType));
  return {
    ...asked,
    ...(testsAdvised ? { testLevel: 'RunLocalTests' as const } : {}),
    testsAdvised,
    yes,
    dryRun,
  };
}

/**
 * The validation the command line asks for, refused where the page would not
 * send it: a type a deployment does not carry, a test that is no class name,
 * named tests at another level.
 *
 * @param flag - The flag that names the components: --validate, or --deploy.
 */
function parseValidation(
  collect: (flag: string) => string[],
  get: (flag: string, fallback?: string) => string | undefined,
  refuse: (line: string) => never,
  flag: '--validate' | '--deploy' = '--validate',
): ValidationArgs {
  const components: DeploymentComponentRef[] = [];
  for (const spec of collect(flag)) {
    const at = spec.indexOf(':');
    const componentType = spec.slice(0, at);
    const fullName = spec.slice(at + 1);
    if (at < 1 || fullName === '') refuse(`${flag} takes Type:Name, got "${spec}".`);
    if (!(DEPLOYABLE_COMPONENT_TYPES as readonly string[]).includes(componentType)) {
      refuse(
        `Not a type a deployment carries: "${componentType}". ` +
          `One of: ${DEPLOYABLE_COMPONENT_TYPES.join(', ')}.`,
      );
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

/**
 * What a validation says of a component the target would take, in the Deploy
 * tab's words: it is check-only, and the target keeps nothing of it.
 */
const CHECK_ONLY_OUTCOME: Readonly<Partial<Record<DeploymentComponentResult['outcome'], string>>> =
  {
    created: 'would be created',
    changed: 'would change',
  };

/** Lines for one deployment report: the verdict, each component, each failed test. */
export function describeDeployment(report: DeploymentReport): string[] {
  const { counts } = report;
  // A validation's words are the longer: "would be created".
  const width = report.checkOnly ? 16 : 13;
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
    const outcome = (report.checkOnly ? CHECK_ONLY_OUTCOME[c.outcome] : undefined) ?? c.outcome;
    lines.push(`    ${outcome.padEnd(width)} ${c.componentType} ${c.fullName}${problem}`);
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
  return byTypeOf(diffs, 'modified');
}

/** The components of one status, by type, in the order the diff lists them. */
function byTypeOf(
  diffs: readonly CompareItem[],
  status: CompareItem['status'],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const item of diffs) {
    if (item.status !== status) continue;
    const names = out.get(item.componentType) ?? [];
    names.push(item.fullName);
    out.set(item.componentType, names);
  }
  return out;
}

/**
 * The changes of a diff as the page reads them, each as `Type:Name`, the form
 * --deploy takes: what only the source holds, which a deployment creates in
 * the target; what only the target holds, which a deployment leaves; and
 * what both hold differently.
 *
 * The page's messages name them by the diff engine's codes, `removed` for
 * what only the source holds and `added` for what only the target holds, and
 * the line printed them as such: a field only in the source read "-1
 * removed", the one change a deployment from it would make.
 */
export function changesOf(result: Pick<CompareResult, 'diffs'>): {
  onlyInSource: string[];
  onlyInTarget: string[];
  modified: string[];
} {
  const named = (status: CompareItem['status']): string[] =>
    result.diffs.filter((d) => d.status === status).map((d) => `${d.componentType}:${d.fullName}`);
  return {
    onlyInSource: named('removed'),
    onlyInTarget: named('added'),
    modified: named('modified'),
  };
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

/**
 * Lines for one diff answer, signed as the page signs them: + for what only
 * the source holds (the code `removed`), which a deployment creates in the
 * target; - for what only the target holds (`added`), which it leaves.
 */
function describeExecute(result: CompareResult): string[] {
  const { summary } = result;
  const lines = [
    `  mode ${result.mode}, ${summary.totalItems} item(s): +${summary.removed} only in the source  ` +
      `-${summary.added} only in the target  ~${summary.modified} modified  ` +
      `=${summary.unchanged} unchanged  ?${summary.notCompared} not compared`,
    '  + a deployment creates it in the target, - a deployment leaves it there (SandForge ' +
      'deploys no deletion), ~ a deployment replaces what the target holds',
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
        `   +${row.removed ?? 0} -${row.added ?? 0} ~${row.modified ?? 0} =${row.unchanged ?? 0} ?${row.not_compared ?? 0}`,
    );
  }
  lines.push(describeCoverage(result));
  const named: ReadonlyArray<[CompareItem['status'], string]> = [
    ['removed', 'only in the source'],
    ['added', 'only in the target'],
    ['modified', 'modified'],
  ];
  for (const [status, words] of named) {
    for (const [type, names] of byTypeOf(result.diffs, status)) {
      lines.push(`  ${words} ${type}: ${someOf(names)}`);
    }
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

/** The components a managed package owns, as a validation's refusal names them. */
function managedOf(payload: Record<string, unknown>): DeploymentComponentRef[] {
  if (payload.code !== 'MANAGED' || !Array.isArray(payload.managed)) return [];
  return (payload.managed as unknown[]).filter(
    (c): c is DeploymentComponentRef =>
      typeof c === 'object' &&
      c !== null &&
      typeof (c as DeploymentComponentRef).componentType === 'string' &&
      typeof (c as DeploymentComponentRef).fullName === 'string',
  );
}

/** A validation that came back with success, no component error and no failed test. */
function validationPassed(report: DeploymentReport): boolean {
  return report.success && report.counts.componentErrors === 0 && report.counts.testErrors === 0;
}

/**
 * Readable lines for what the page would receive.
 *
 * @param flag - The flag that named the components of a validation, which a
 *   refusal tells the reader to drop: --validate, or --deploy.
 */
export function describeAnswer(
  op: Sent,
  answer: PanelAnswer,
  flag: '--validate' | '--deploy' = '--validate',
): string[] {
  const took = `${(answer.elapsedMs / 1000).toFixed(1)}s`;
  const head = `compare:${op}  ${answer.outcome} in ${took}`;
  const lines = [answer.late ? `${head}  — past the page's timeout: the page dropped it` : head];
  const payload = (answer.message?.payload ?? {}) as Record<string, unknown>;
  if (answer.outcome !== 'answered') {
    const managed = managedOf(payload);
    if (managed.length > 0) {
      // The handler's words are the page's — "untick them" —, and the line
      // has no box: it names the components to drop.
      lines.push(
        `  a managed package installed ${managed.map((c) => `${c.componentType} ${c.fullName}`).join(', ')} ` +
          'in the source, and it owns them: drop ' +
          managed.map((c) => `${flag} ${c.componentType}:${c.fullName}`).join(' ') +
          ' from the line and run it again. Nothing was sent to the target.',
      );
      return lines;
    }
    if (answer.message) lines.push(`  ${String(payload.message ?? JSON.stringify(payload))}`);
    // Nothing came back: the line exited 1 with no word of what to change.
    if (answer.outcome === 'unanswered') {
      lines.push(
        op === 'deploy'
          ? `  nothing came back in ${Math.round(answer.elapsedMs / 1000)} s: the deployment may ` +
              'go on in the target, whose Setup › Deployment Status follows it; give a longer --wait'
          : `  nothing came back in ${Math.round(answer.elapsedMs / 1000)} s: give a longer --wait` +
              (op === 'execute' ? ', or fewer --type' : ''),
      );
    }
    return lines;
  }
  if (op === 'execute') return [...lines, ...describeExecute(payload as unknown as CompareResult)];
  if (op === 'validate-deployment' || op === 'deploy') {
    const report = payload.report as DeploymentReport | undefined;
    if (!report) return [...lines, '  (no report)'];
    return [...lines, ...describeDeployment(report)];
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
 * validation or a deployment came back with no success, a component error or
 * a failed test, or, with `--fail-on-drift`, when a diff found a component
 * in one org only, or modified; 0 otherwise. A diff is read, and said, whatever
 * it found.
 *
 * The run exited 0 whatever it received: a check-only deployment that failed
 * to compile, or whose tests failed, passed the pipeline it was to gate.
 * Exported so it can be tested.
 */
export function compareExitCode(
  results: ReadonlyArray<{ op: Sent; answer: PanelAnswer }>,
  failOnDrift = false,
): number {
  if (results.some(({ answer }) => answer.outcome !== 'answered')) return FAILED_EXIT;
  const payloadOf = (answer: PanelAnswer): Record<string, unknown> =>
    (answer.message?.payload ?? {}) as Record<string, unknown>;
  const failedValidation = results.some(({ op, answer }) => {
    if (op !== 'validate-deployment' && op !== 'deploy') return false;
    const report = payloadOf(answer).report as DeploymentReport | undefined;
    return report === undefined || !validationPassed(report);
  });
  if (failedValidation) return PARTIAL_EXIT;
  const drifted = results.some(({ op, answer }) => {
    if (op !== 'execute') return false;
    const summary = (payloadOf(answer) as unknown as Partial<CompareResult>).summary;
    return summary !== undefined && summary.added + summary.removed + summary.modified > 0;
  });
  return failOnDrift && drifted ? PARTIAL_EXIT : DONE_EXIT;
}

/** What `main` is handed besides its line; a test gives its own. */
export interface CompareCliDeps {
  /** Stands the host up: the product's own unless a test gives another. */
  createHost?: (options: PanelHostOptions) => PanelHost;
  /** Where --deploy asks for the target's alias: the command's own terminal unless a test gives another. */
  terminal?: PromptStreams;
}

/** What the Deploy tab's progress line says of a step, in its words. */
const PROGRESS_WORDS: Readonly<Record<string, string>> = {
  retrieve: 'retrieving from the source: {done} of {total} components',
  components: 'checking the components: {done} of {total}',
  tests: 'running the Apex tests: {done} of {total}',
};

/**
 * The progress of the request `following` names, as it comes, a line each
 * time it moves: a deployment that runs the target's tests takes minutes,
 * which the line spent saying nothing.
 */
export function progressLines(log: (line: string) => void): {
  onPost: (message: PostedMessage) => void;
  follow: (requestId: string | undefined) => void;
} {
  let following: string | undefined;
  let last = '';
  return {
    follow: (requestId) => {
      following = requestId;
      last = '';
    },
    onPost: (message) => {
      if (message.type !== 'operation:progress' || following === undefined) return;
      const p = (message.payload ?? {}) as {
        operationId?: unknown;
        currentStep?: unknown;
        processedRecords?: unknown;
        totalRecords?: unknown;
      };
      const words = typeof p.currentStep === 'string' ? PROGRESS_WORDS[p.currentStep] : undefined;
      if (p.operationId !== following || words === undefined) return;
      const line = words
        .replace('{done}', String(p.processedRecords ?? 0))
        .replace('{total}', String(p.totalRecords ?? 0));
      if (line === last) return;
      last = line;
      log(`  ${line}`);
    },
  };
}

/** Run the page's requests; exported so its parsing can be tested. */
export async function main(
  argv: string[] = process.argv,
  deps: CompareCliDeps = {},
): Promise<void> {
  const args = parseArgs(argv);
  // On stderr with --json, where stdout carries the JSON alone.
  const log = (line: string): void => {
    process[args.json ? 'stderr' : 'stdout'].write(`${line}\n`);
  };
  const terminal = deps.terminal ?? { input: process.stdin, output: process.stderr };
  const { deploy } = args;
  if (deploy && !deploy.dryRun && !deploy.yes && terminal.input.isTTY !== true) {
    // Said before any org is reached: found once the validation is in, it
    // would have had the target validate a package nobody could then deploy.
    process.stderr.write(
      `--deploy asks for ${args.target} to be typed before it deploys, and no terminal is here ` +
        'to type it on: give --yes to deploy without the question, or --dry-run to list what it ' +
        'would deploy. Nothing was sent to either org.\n',
    );
    process.exit(NO_TERMINAL_EXIT);
  }

  // The host's folder, its owner's alone: a fixed folder of the system's
  // temp directory was every user's of a shared runner to make first, and two
  // jobs there wrote over each other's store.
  const refused = openBackupStore(args.storeDir);
  if (refused !== undefined) {
    process.stderr.write(`${refused}\n`);
    process.exitCode = FAILED_EXIT;
    return;
  }
  const progress = progressLines(log);
  const host = (deps.createHost ?? createPanelHost)({
    storeDir: args.storeDir,
    // The extension's own warnings and failures, not its routine traffic.
    log: (line) => {
      if (/^\s*!|\[(ERR|WARN)\]/.test(line)) log(line);
    },
    waitMs: args.waitMs,
    onPost: progress.onPost,
    ...(deploy
      ? {
          // The handler's Production Guard is a command line's: no for a
          // production org, which this command refuses before it, and yes
          // for any other, whose alias was typed or --yes given.
          compose: (wiring: PanelHostWiring) =>
            wiring.handlers.setInfraServices({
              productionGuard: commandLineGuard(log, args.target),
            } as Partial<InfraServices> as InfraServices),
        }
      : {}),
  });
  const source = await host.connect(args.source);
  const target = await host.connect(args.target);
  log(
    `sandforge compare  ${args.source} (${source.orgType}) -> ${args.target} (${target.orgType})`,
  );

  if (deploy) {
    await deployFromLine({ args, deploy, host, source, target, log, terminal, progress });
    return;
  }

  // A diff's answer carries `changes` beside it: the page's message names
  // what only the source holds `removed`, and keeps that published word.
  const results: Array<{
    op: Operation;
    answer: PanelAnswer;
    changes?: ReturnType<typeof changesOf>;
  }> = [];
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
    const diff =
      op === 'execute' && answer.outcome === 'answered'
        ? (answer.message?.payload as Partial<CompareResult> | undefined)
        : undefined;
    results.push({
      op,
      answer,
      ...(Array.isArray(diff?.diffs) ? { changes: changesOf({ diffs: diff.diffs }) } : {}),
    });
    for (const line of describeAnswer(op, answer)) log(line);
    if (op === 'validate-deployment' && validated(answer) !== undefined) {
      log(
        '  --deploy in place of each --validate deploys it: it validates it again, then deploys ' +
          'what the target validated',
      );
    }
  }

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify({ tool: 'sandforge-compare', results, posted: host.posted }, null, 2)}\n`,
    );
  }
  endWith(compareExitCode(results, args.failOnDrift));
}

/** The report of a validation that passed, which a deployment may follow; undefined otherwise. */
function validated(answer: PanelAnswer): DeploymentReport | undefined {
  if (answer.outcome !== 'answered') return undefined;
  const report = (answer.message?.payload as { report?: DeploymentReport } | undefined)?.report;
  return report !== undefined && report.deployId !== undefined && validationPassed(report)
    ? report
    : undefined;
}

/**
 * How a run with --deploy ended, as its JSON names it: `rolled-back`, the
 * target refused the deployment and kept nothing of it; `deployment-unsettled`,
 * no report came back, and the request's answer says why.
 */
type DeployOutcome =
  | 'dry-run'
  | 'validation-failed'
  | 'declined'
  | 'deployed'
  | 'rolled-back'
  | 'deployment-unsettled';

/** What a run with --deploy is handed. */
interface DeployRun {
  args: CliArgs;
  deploy: DeployArgs;
  host: PanelHost;
  source: SalesforceOrg;
  target: SalesforceOrg;
  log: (line: string) => void;
  terminal: PromptStreams;
  progress: ReturnType<typeof progressLines>;
}

/**
 * The Deploy tab's two requests, in its order: the validation of the
 * components, then the deployment of the package the target validated, with
 * the same tests, once the target's alias is typed or --yes given. The
 * deployment names the validation and nothing else, as the tab's does, and
 * the handler deploys what it kept of it: what the target takes is what it
 * checked.
 *
 * A production target is refused before either request, as every command
 * line that writes refuses one, and as the tab offers nothing to pick: the
 * handler's Production Guard would refuse it too, but only once the source
 * had been asked for the package.
 */
async function deployFromLine(run: DeployRun): Promise<void> {
  const { args, deploy, host, target, log } = run;
  if (guardTierOf(target) === 'production') {
    const edition = target.metadata?.edition;
    const refusal =
      productionTargetRefusal(
        args.target,
        {
          id: target.id,
          sandbox: target.orgType === 'Sandbox' || target.orgType === 'Scratch',
          ...(edition ? { edition } : {}),
        },
        { tool: nameOf('sandforge-compare'), action: 'write', readOnly: READ_ONLY_RUN },
      ) ??
      `${args.target} is taken for a production org: ${nameOf('sandforge-compare')} deploys to ` +
        `sandboxes, scratch orgs and Developer Edition orgs only. Nothing was written; ` +
        `${READ_ONLY_RUN}, which only reads, runs against it.`;
    process.stderr.write(`${refusal}\n`);
    process.exitCode = FAILED_EXIT;
    return;
  }

  for (const line of deployPlanLines(args.source, args.target, deploy)) log(line);
  const summary = {
    source: args.source,
    target: args.target,
    components: deploy.components,
    testLevel: deploy.testLevel,
    runTests: deploy.runTests,
  };
  const results: Array<{ op: Sent; answer: PanelAnswer }> = [];
  const answerJson = (outcome: DeployOutcome, ids: Record<string, string> = {}): void => {
    if (!args.json) return;
    process.stdout.write(
      `${JSON.stringify(
        {
          tool: 'sandforge-compare',
          results,
          deploy: { ...summary, outcome, ...ids },
          posted: host.posted,
        },
        null,
        2,
      )}\n`,
    );
  };

  if (deploy.dryRun) {
    log(
      `dry run: nothing was sent to ${args.source} or ${args.target}. The run validates ` +
        `${countOf(deploy.components.length)} in ${args.target}, then deploys what it validated ` +
        `once ${args.target} is typed, or with --yes.`,
    );
    answerJson('dry-run');
    return;
  }

  // What DeployPanel sends: the components, the level, and the names only
  // for the level that runs named tests.
  const validationRequest = `cli-validate-${randomUUID()}`;
  run.progress.follow(validationRequest);
  const validation = await host.request({
    id: validationRequest,
    type: 'compare:validate-deployment',
    payload: {
      sourceOrgId: run.source.id,
      targetOrgId: target.id,
      components: deploy.components,
      testLevel: deploy.testLevel,
      ...(deploy.testLevel === 'RunSpecifiedTests' ? { runTests: deploy.runTests } : {}),
    },
    timeoutMs: PAGE_VALIDATE_TIMEOUT_MS,
  });
  run.progress.follow(undefined);
  results.push({ op: 'validate-deployment', answer: validation });
  for (const line of describeAnswer('validate-deployment', validation, '--deploy')) log(line);
  const report = validated(validation);
  if (report?.deployId === undefined) {
    log(`  the validation did not succeed: nothing was deployed to ${args.target}`);
    answerJson('validation-failed');
    endWith(compareExitCode(results));
    return;
  }
  const validationId = report.deployId;

  // The tab's confirmation, in its words: what the target keeps.
  const count = deploy.components.length;
  log(
    `Deploy to ${args.target}: ` +
      (count === 1
        ? `the component validated as ${validationId} will be deployed to ${args.target}, with the ` +
          `same tests, and ${args.target} keeps it.`
        : `the ${count} components validated as ${validationId} will be deployed to ` +
          `${args.target}, with the same tests, and ${args.target} keeps them.`),
  );
  if (!deploy.yes) {
    const answer = await typed(`Type ${args.target} to deploy it:`, run.terminal);
    if (answer !== args.target) {
      log(
        `Nothing was deployed: what was typed is not ${args.target}. The validation ` +
          `${validationId} changed nothing there.`,
      );
      answerJson('declined', { validationId });
      process.exitCode = FAILED_EXIT;
      return;
    }
  }

  const deploymentRequest = `cli-deploy-${randomUUID()}`;
  run.progress.follow(deploymentRequest);
  const deployment = await host.request({
    id: deploymentRequest,
    type: 'compare:deploy',
    payload: { validationId, targetOrgId: target.id },
    timeoutMs: PAGE_DEPLOY_TIMEOUT_MS,
  });
  run.progress.follow(undefined);
  results.push({ op: 'deploy', answer: deployment });
  for (const line of describeAnswer('deploy', deployment)) log(line);
  const deployed = (deployment.message?.payload as { report?: DeploymentReport } | undefined)
    ?.report;
  const deploymentId = deployed?.deployId;
  const settled = deployment.outcome === 'answered' && deployed !== undefined;
  if (settled) {
    log(
      validationPassed(deployed)
        ? `  deployed to ${args.target}, which lists it in Setup › Deployment Status as ` +
            `${deploymentId ?? '(no id)'}. SandForge deploys no deletion: what it created stays ` +
            `in ${args.target} until it is deleted there.`
        : `  the deployment failed in ${args.target} and was rolled back: ${args.target} kept nothing.`,
    );
  }
  // With no report, the request's own message says why, and whether the
  // target may still take it.
  answerJson(
    !settled ? 'deployment-unsettled' : validationPassed(deployed) ? 'deployed' : 'rolled-back',
    { validationId, ...(deploymentId !== undefined ? { deploymentId } : {}) },
  );
  endWith(compareExitCode(results));
}

/** What runs against a production org, which a deployment refuses. */
const READ_ONLY_RUN = 'a comparison without --deploy';

/** "1 component", "2 components". */
function countOf(n: number): string {
  return `${n} component${n === 1 ? '' : 's'}`;
}

/**
 * What the Deploy tab says before a deployment, said before the validation:
 * the two orgs and what each step does, the components, and the tests the
 * target runs, with the tab's advice when Apex is among them.
 */
export function deployPlanLines(source: string, target: string, deploy: DeployArgs): string[] {
  const tests =
    deploy.testLevel === 'RunSpecifiedTests'
      ? `${deploy.testLevel}: ${deploy.runTests.join(', ')}`
      : deploy.testLevel;
  return [
    `deploy from ${source} to ${target}, validated in ${target} first: it compiles the ` +
      'components, runs the tests asked for and keeps nothing; then the package it validated is ' +
      `deployed, once ${target} is typed or with --yes. Nothing is deleted from ${target}.`,
    ...deploy.components.map((c) => `  ${c.componentType} ${c.fullName}`),
    `  Apex tests in ${target}: ${tests}` +
      (deploy.testsAdvised
        ? ' — Apex is among the components: as the Deploy tab advises, the target’s own tests ' +
          'run unless --tests says otherwise'
        : ''),
  ];
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
