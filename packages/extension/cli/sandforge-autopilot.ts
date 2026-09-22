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
 * same executor, scanner, graph builder, plan generator and remapper. What it
 * leaves out is what the panel adds around a run: events posted to a webview,
 * grappe partitioning, and the anonymizer's rules beyond the compliance
 * profile asked for.
 *
 * Usage:
 *   pnpm exec tsx packages/extension/cli/sandforge-autopilot.ts \
 *     --source SRC --target TGT --object Account --object Contact
 *
 * Run from the repository root of a checkout, after pnpm install and
 * pnpm build:shared.
 */

import type { Connection } from 'jsforce';
import type { ComplianceFrameworkType } from '@sandforge/shared';
import { duplicateRuleHeaders } from '@sandforge/shared';
import { loadOrg, makeConn } from './sfSession.js';
import { AutopilotOrchestrator } from '../src/modules/autopilot/AutopilotOrchestrator.js';
import { SchemaScanner } from '../src/modules/autopilot/SchemaScanner.js';
import type { AutopilotConnection } from '../src/modules/autopilot/SchemaScanner.js';
import { DependencyGraphBuilder } from '../src/modules/autopilot/DependencyGraphBuilder.js';
import { ComplianceEngine } from '../src/modules/autopilot/ComplianceEngine.js';
import { SmartAnonymizer } from '../src/modules/autopilot/SmartAnonymizer.js';
import { ExecutionPlanGenerator } from '../src/modules/autopilot/ExecutionPlanGenerator.js';
import { RecordIdRemapper } from '../src/modules/autopilot/RecordIdRemapper.js';
import { AutopilotExecutor } from '../src/modules/autopilot/AutopilotExecutor.js';
import { AutopilotGrappeAdapter } from '../src/modules/autopilot/AutopilotGrappeAdapter.js';

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
  --compliance <name>    none | gdpr | ccpa | hipaa | pci_dss      (default: none)
  --batch-size <n>       records per write call                   (default: 200)
  --plan-only            scan, graph and plan, then stop          (default: off)
  --json                 emit the run summary as JSON             (default: off)
  --help                 this text

Exit codes: 0 the run finished (read the summary for per-object failures),
1 the run could not be started, 2 a bad command line.
`;

/** Everything the command line settled. */
interface CliArgs {
  source: string;
  target: string;
  objects: string[];
  includeStandardObjects: boolean;
  compliance: ComplianceFrameworkType;
  batchSize: number;
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

  return {
    source,
    target,
    objects,
    includeStandardObjects: args.includes('--standard-objects'),
    compliance,
    batchSize,
    planOnly: args.includes('--plan-only'),
    json: args.includes('--json'),
  };
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

  const sourceConn = makeConn(loadOrg(args.source));
  const targetConn = makeConn(loadOrg(args.target));

  // One describe of the target per object, shared across the executors a run
  // creates.
  const creatableByObject = new Map<string, ReadonlySet<string>>();
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
        query: async (objectApiName, offset, limit) => {
          const result = await sourceConn.query<Record<string, unknown>>(
            `SELECT FIELDS(ALL) FROM ${objectApiName} LIMIT ${limit} OFFSET ${offset}`,
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
          const written = (await targetConn
            .sobject(objectApiName)
            .create(cleaned, { headers: duplicateRuleHeaders(true) })) as Array<{
            success: boolean;
            id?: string;
            errors?: Array<{ message: string }>;
          }>;
          const successIds: string[] = [];
          const sourceIds: string[] = [];
          const errors: string[] = [];
          written.forEach((one, i) => {
            if (one.success && one.id) {
              successIds.push(one.id);
              sourceIds.push(String(records[i]['Id'] ?? ''));
            } else {
              errors.push(one.errors?.[0]?.message ?? `Insert failed for ${objectApiName} #${i}`);
            }
          });
          return { successIds, sourceIds, errors };
        },
        anonymizer,
        remapper: new RecordIdRemapper(),
        describeCreateableFields: async (objectApiName) => {
          const cached = creatableByObject.get(objectApiName);
          if (cached) return cached;
          const described = await targetConn.sobject(objectApiName).describe();
          const names = new Set(described.fields.filter((f) => f.createable).map((f) => f.name));
          creatableByObject.set(objectApiName, names);
          return names;
        },
      }),
    grappeAdapter: new AutopilotGrappeAdapter(),
  });

  log('\nscanning…');
  const scan = await orchestrator.scanSchemas(
    sourceConn as unknown as AutopilotConnection,
    targetConn as unknown as AutopilotConnection,
    { selectedObjects: args.objects, includeStandardObjects: args.includeStandardObjects },
  );
  const graph = orchestrator.buildGraph(scan, args.batchSize);
  log(`graph: ${graph.nodes.length} node(s), ${graph.edges.length} edge(s)`);

  // No rules of its own: what a framework implies is the compliance engine's
  // to say, and asking for one here would be a second opinion.
  const rules: Parameters<typeof orchestrator.generatePlan>[2] = [];
  const plan = orchestrator.generatePlan(graph, args.compliance, rules);
  log(`plan: ${plan.waves.length} wave(s), ${plan.totalRecords} record(s)`);
  plan.waves.forEach((wave, index) => {
    log(`  wave ${index + 1}: ${wave.objects.join(', ')}`);
  });

  if (args.planOnly) {
    if (args.json) {
      process.stdout.write(
        `${JSON.stringify({ tool: 'sandforge-autopilot', planOnly: true, graph, plan }, null, 2)}\n`,
      );
    }
    return;
  }

  const recordCounts = new Map<string, number>(
    graph.nodes.map((node) => [node.objectApiName, node.recordCount]),
  );

  log('\nexecuting… (REAL)');
  const result = await orchestrator.executePlan(plan, graph, rules, recordCounts);
  const elapsedMs = Date.now() - t0;

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify({ tool: 'sandforge-autopilot', source: args.source, target: args.target, result, elapsedMs }, null, 2)}\n`,
    );
    return;
  }

  log(
    `\nwritten: ${result.totalSuccess}   refused: ${result.totalFailure}   ` +
      `skipped: ${result.totalSkipped}`,
  );
  if (result.completedObjects.length > 0) log(`  done:    ${result.completedObjects.join(', ')}`);
  if (result.skippedObjects.length > 0) log(`  skipped: ${result.skippedObjects.join(', ')}`);
  if (result.fatalError) log(`  the run died with: ${result.fatalError}`);
  for (const name of result.failedObjects) {
    log(`  FAILED  ${name}: ${result.nodeErrors?.[name] ?? '(no message)'}`);
  }
  log(`\ndone in ${elapsedMs}ms`);
}

// `tsx` runs this file directly; the check keeps it silent under test.
if (process.argv[1]?.includes('sandforge-autopilot')) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

export type { Connection };
