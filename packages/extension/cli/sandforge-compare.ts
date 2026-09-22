#!/usr/bin/env tsx
/**
 * sandforge-compare — headless Compare runner.
 *
 * Compare had full unit-test coverage and had never been pointed at a real
 * pair of orgs; the five modules run against real orgs before it had yielded
 * twenty-five defects between them, none of which any gate had seen.
 *
 * It sends the Compare page's four requests through the extension's own
 * composition (see `panelHost.ts`) and prints what the page would receive.
 * Every request only reads: the page deploys nothing, and neither does this.
 *
 * Usage:
 *   npx tsx packages/extension/cli/sandforge-compare.ts \
 *     --source SRC --target TGT --type ApexClass --type Flow
 *   npx tsx packages/extension/cli/sandforge-compare.ts \
 *     --source SRC --target TGT --op permissions --op drift
 *
 * Run from the repository root of a checkout, after pnpm install and
 * pnpm build:shared.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CompareItem, CompareResult, MetadataComponentType } from '@sandforge/shared';
import { createPanelHost } from './panelHost.js';
import type { PanelAnswer } from './panelHost.js';

const HELP = `sandforge-compare — compare two orgs the way the Compare page does, without the editor.

Usage:
  npx tsx packages/extension/cli/sandforge-compare.ts --source <alias> --target <alias> [options]

Required:
  --source <alias>       sf CLI alias of the source org
  --target <alias>       sf CLI alias of the target org

Options:
  --op <name>            execute | permissions | snapshots | drift; repeat for
                         more                                 (default: all four)
  --type <Type>          a metadata category to diff (execute); repeat for more
  --all-types            every category the page offers, as "Select all" does
  --store <dir>          where the host keeps its config store (default: a temp directory)
  --wait <seconds>       how long to keep waiting for an answer     (default: 300)
  --json                 emit what the page would receive
  --help                 this text

Nothing is written to either org.

Exit codes: 0 the run finished (read the answers), 1 it could not start,
2 a bad command line.
`;

/** The four requests the page sends. */
const OPERATIONS = ['execute', 'permissions', 'snapshots', 'drift'] as const;
type Operation = (typeof OPERATIONS)[number];

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

/** Everything the command line settled. */
interface CliArgs {
  source: string;
  target: string;
  operations: Operation[];
  types: MetadataComponentType[];
  storeDir: string;
  waitMs: number;
  json: boolean;
}

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
  const operations = asked.length > 0 ? [...new Set(asked as Operation[])] : [...OPERATIONS];

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
    storeDir: get('--store', join(tmpdir(), 'sandforge-compare')) ?? '',
    waitMs: waitSeconds * 1000,
    json: args.includes('--json'),
  };
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
  return (
    `  content compared for ${content.compared} of ${inBoth} in both orgs; not compared: ` +
    `${overBudget} over the budget (${content.budget.components} per org, ${content.budget.seconds} s), ` +
    `${unreadable} unreadable, ${readFailed} read failed`
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

/** Run the page's requests; exported so its parsing can be tested. */
export async function main(argv: string[] = process.argv): Promise<void> {
  const args = parseArgs(argv);
  const log = (line: string): void => {
    if (!args.json) process.stdout.write(`${line}\n`);
  };

  mkdirSync(args.storeDir, { recursive: true });
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
    if (op === 'execute') payload.types = args.types;
    const answer = await host.request({
      type: `compare:${op}`,
      payload,
      ...(op === 'execute' ? { timeoutMs: PAGE_EXECUTE_TIMEOUT_MS } : {}),
    });
    results.push({ op, answer });
    for (const line of describeAnswer(op, answer)) log(line);
  }

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify({ tool: 'sandforge-compare', results, posted: host.posted }, null, 2)}\n`,
    );
  }
}

// `tsx` runs this file directly; the check keeps it silent under test.
if (process.argv[1]?.includes('sandforge-compare')) {
  main()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
