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
 * Usage:
 *   sandforge-clone --record <recordId> --source <alias> --target <alias>
 *                   [--depth direct|full|custom] [--custom-depth <n>]
 *                   [--max <n>] [--anonymize] [--dry-run]
 *
 * Example:
 *   sandforge-clone --record 500AP00000fXeQsYAK \
 *                   --source ORG-UAT --target ORG-DEV \
 *                   --depth custom --custom-depth 5 --max 50 --dry-run
 */
import { execFileSync } from 'node:child_process';
import jsforce from 'jsforce';

import type { ForgeConfig } from '@sandforge/shared';
import { GraphDiscoveryService } from '../src/modules/forge/GraphDiscoveryService.js';
import type {
  GraphDiscoveryDeps,
  ObjectDescribe,
  FieldDescribe as GraphFieldDescribe,
} from '../src/modules/forge/GraphDiscoveryService.js';
import { ForgePlanGenerator } from '../src/modules/forge/ForgePlanGenerator.js';
import { ForgeExecutor } from '../src/modules/forge/ForgeExecutor.js';
import type { ForgeExecutorDeps, FieldInfo } from '../src/modules/forge/ForgeExecutor.js';
import { RecordTypeMapper } from '../src/modules/sync/RecordTypeMapper.js';
import type { RecordTypeInfo, RecordTypeMapping } from '../src/modules/sync/RecordTypeMapper.js';
import { PIIDetector } from '../src/core/precheck/PIIDetector.js';

interface CliArgs {
  record: string;
  source: string;
  target: string;
  depth: 'direct' | 'full' | 'custom';
  customDepth: number;
  maxRecordsPerObject: number | undefined;
  anonymize: boolean;
  dryRun: boolean;
}

interface SfOrg {
  alias: string;
  username: string;
  instanceUrl: string;
  accessToken: string;
}

const HELP = `sandforge-clone — Forge a record-scoped clone from a source org to a target sandbox.

Usage:
  sandforge-clone --record <id> --source <alias> --target <alias> [options]

Required:
  --record <id>          Source record ID (any object type — prefix detected automatically)
  --source <alias>       sf CLI alias of the source org
  --target <alias>       sf CLI alias of the target sandbox

Options:
  --depth <mode>         direct | full | custom    (default: custom)
  --custom-depth <n>     traversal depth when --depth=custom    (default: 5)
  --max <n>              max records cloned per object          (default: unlimited)
  --anonymize            anonymize PII fields                   (default: off)
  --dry-run              skip writes, surface scoped queries    (default: off)
  -h, --help             show this help and exit
`;

function parseArgs(argv: string[]): CliArgs {
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

  const record = get('--record');
  const source = get('--source');
  const target = get('--target');
  if (!record || !source || !target) {
    process.stderr.write('Missing required flag. Run with --help for usage.\n');
    process.exit(2);
  }

  const depthRaw = (get('--depth', 'custom') ?? 'custom') as 'direct' | 'full' | 'custom';
  const customDepthRaw = get('--custom-depth', '5');
  const maxRaw = get('--max');
  return {
    record,
    source,
    target,
    depth: depthRaw,
    customDepth: customDepthRaw ? Number(customDepthRaw) : 5,
    maxRecordsPerObject: maxRaw ? Number(maxRaw) : undefined,
    anonymize: has('--anonymize'),
    dryRun: has('--dry-run'),
  };
}

/** SF alias = letters/digits/underscore/dash/dot. Defends against shell metachars. */
const SF_ALIAS_RE = /^[A-Za-z0-9_.-]+$/;

function loadOrg(alias: string): SfOrg {
  // shell:true on Windows is required to resolve `.cmd` files but lets cmd.exe
  // interpret metacharacters (`&`, `|`, `>`, `^`, `"`). Validate alias before
  // passing — block any shell-injection vector via crafted CLI args.
  if (!SF_ALIAS_RE.test(alias)) {
    throw new Error(`Invalid SF org alias: "${alias}" (allowed: letters, digits, underscore, dash, dot)`);
  }
  const json = execFileSync('sf', ['org', 'display', '--target-org', alias, '--json'], {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    shell: process.platform === 'win32',
  });
  const parsed = JSON.parse(json) as {
    result?: { accessToken?: string; instanceUrl?: string; username?: string };
  };
  if (!parsed.result?.accessToken || !parsed.result?.instanceUrl) {
    throw new Error(`sf org display did not return a usable session for alias '${alias}'.`);
  }
  return {
    alias,
    username: parsed.result.username ?? '',
    instanceUrl: parsed.result.instanceUrl,
    accessToken: parsed.result.accessToken,
  };
}

function makeConn(org: SfOrg): jsforce.Connection {
  return new jsforce.Connection({
    instanceUrl: org.instanceUrl,
    accessToken: org.accessToken,
    version: '66.0',
  });
}

function adaptDescribe(raw: jsforce.DescribeSObjectResult): ObjectDescribe {
  return {
    name: raw.name,
    fields: raw.fields.map((f) => ({
      name: f.name,
      type: String(f.type),
      referenceTo: (f.referenceTo ?? []).filter((r): r is string => typeof r === 'string'),
      relationshipName: f.relationshipName ?? null,
    })),
    childRelationships: raw.childRelationships.map((c) => ({
      childSObject: c.childSObject,
      field: c.field,
      relationshipName: c.relationshipName ?? '',
      isCascadeDelete: Boolean(c.cascadeDelete),
    })),
  };
}

async function loadRecordTypes(
  sourceConn: jsforce.Connection,
  targetConn: jsforce.Connection,
): Promise<RecordTypeMapping[]> {
  const soql = 'SELECT Id, Name, DeveloperName FROM RecordType WHERE IsActive = true';
  const [s, tgt] = await Promise.all([
    sourceConn.query<{ Id: string; Name: string; DeveloperName: string }>(soql),
    targetConn.query<{ Id: string; Name: string; DeveloperName: string }>(soql),
  ]);
  const toInfo = (r: { Id: string; Name: string; DeveloperName: string }): RecordTypeInfo => ({
    id: r.Id,
    name: r.Name,
    developerName: r.DeveloperName,
  });
  return new RecordTypeMapper().buildMapping(s.records.map(toInfo), tgt.records.map(toInfo));
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const args = parseArgs(process.argv);
  console.log(`sandforge-clone  ${args.source} -> ${args.target}  record=${args.record}`);

  const sourceOrg = loadOrg(args.source);
  const targetOrg = loadOrg(args.target);
  const conns = new Map<string, jsforce.Connection>();
  conns.set(args.source, makeConn(sourceOrg));
  conns.set(args.target, makeConn(targetOrg));

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
  const fullDescribes = new Map<string, ObjectDescribe>();
  const discoveryDeps: GraphDiscoveryDeps = {
    describeObject: async (orgId, name) => {
      const c = conns.get(orgId);
      if (!c) throw new Error(`No connection for ${orgId}`);
      const raw = await c.sobject(name).describe();
      const adapted = adaptDescribe(raw);
      fullDescribes.set(name, adapted);
      return adapted;
    },
    queryCount: async (orgId, soql) => {
      const c = conns.get(orgId);
      if (!c) throw new Error(`No connection for ${orgId}`);
      const r = await c.query(soql);
      return r.totalSize;
    },
    detectPII: (fields: GraphFieldDescribe[]) => {
      const adapted = fields.map((f) => ({ apiName: f.name, label: f.name, type: f.type }));
      return piiDetector.detectPII('graph-node', adapted).piiFields.map((p) => p.fieldApiName);
    },
    describeGlobal: async (orgId) => {
      const c = conns.get(orgId);
      if (!c) throw new Error(`No connection for ${orgId}`);
      const r = await c.describeGlobal();
      return r.sobjects.map((s) => ({ name: s.name, keyPrefix: s.keyPrefix ?? null }));
    },
  };

  console.log('discovery…');
  const graph = await new GraphDiscoveryService(discoveryDeps).discover(config);
  const plan = new ForgePlanGenerator().generate(graph);
  console.log(`graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges, ${plan.waves.length} waves, ${plan.cycleResolutions.length} cycles${graph.truncated ? ' (TRUNCATED)' : ''}`);

  console.log('record-type mapping…');
  const recordTypeMappings = await loadRecordTypes(
    conns.get(args.source)!,
    conns.get(args.target)!,
  );
  console.log(`record-types: ${recordTypeMappings.length} mappings`);

  const executorDeps: ForgeExecutorDeps = {
    queryRecords: async (orgId, soql) => {
      const c = conns.get(orgId);
      if (!c) throw new Error(`No connection for ${orgId}`);
      const r = await c.query<Record<string, unknown>>(soql);
      return r.records;
    },
    insertRecords: async (orgId, name, records) => {
      if (args.dryRun) return records.map(() => ({ id: '', success: true, errors: [] }));
      const c = conns.get(orgId);
      if (!c) throw new Error(`No connection for ${orgId}`);
      const r = await c.sobject(name).create(records);
      const arr = Array.isArray(r) ? r : [r];
      return arr.map((x) => ({
        id: x.id ?? '',
        success: x.success,
        errors: x.errors?.map((e: { statusCode?: string; message?: string }) =>
          e.statusCode ? `${e.statusCode}: ${e.message ?? ''}` : (e.message ?? '')
        ) ?? [],
      }));
    },
    updateRecords: async (orgId, name, records) => {
      if (args.dryRun) return [];
      const c = conns.get(orgId);
      if (!c) throw new Error(`No connection for ${orgId}`);
      const r = await c.sobject(name).update(records as unknown as { Id: string }[]);
      const arr = Array.isArray(r) ? r : [r];
      return arr.map((x, i) => ({
        id: x.id ?? (records[i]['Id'] as string) ?? '',
        success: x.success,
        errors: x.errors?.map((e: { statusCode?: string; message?: string }) =>
          e.statusCode ? `${e.statusCode}: ${e.message ?? ''}` : (e.message ?? '')
        ) ?? [],
      }));
    },
    describeFields: async (orgId, name) => {
      const c = conns.get(orgId);
      if (!c) throw new Error(`No connection for ${orgId}`);
      const meta = await c.sobject(name).describe();
      return meta.fields.map<FieldInfo>((f) => ({
        name: f.name,
        queryable: true,
        createable: f.createable ?? false,
        isReference: f.type === 'reference',
        referenceTo: (f.referenceTo ?? []).filter((r): r is string => typeof r === 'string'),
        nillable: f.nillable ?? true,
        picklistValues: (f.picklistValues ?? [])
          .filter((p) => p?.active !== false && typeof p?.value === 'string')
          .map((p) => p.value as string),
      }));
    },
    isObjectCreatable: async (orgId, name) => {
      const c = conns.get(orgId);
      if (!c) throw new Error(`No connection for ${orgId}`);
      const meta = await c.sobject(name).describe();
      return meta.createable !== false;
    },
  };

  console.log(`executing… (${args.dryRun ? 'DRY-RUN' : 'REAL'})`);
  const summary = await new ForgeExecutor(executorDeps).execute(
    graph,
    args.source,
    args.target,
    () => undefined,
    {
      rootRecordId: args.record,
      rootObjectApiName: graph.nodes[0]?.objectApiName ?? '',
      dryRun: args.dryRun,
      recordTypeMappings,
      maxRecordsPerObject: args.maxRecordsPerObject,
      // CR-014: Force 'nullify' for cross-org CLI clones. The default
      // ('keep' for non-scoped) preserves source IDs which would be
      // invalid on the target unless source and target share state, which
      // is never the case for a real cross-org clone via this CLI.
      referenceFallback: 'nullify',
    },
  );

  console.log('');
  console.log(`success: ${summary.successCount}`);
  console.log(`failed:  ${summary.failedCount}`);
  console.log(`skipped: ${summary.skippedCount}`);
  console.log(`remaps:  ${summary.remapCount}`);
  if (summary.errors.length > 0) {
    console.log(`\nerrors (${summary.errors.length} object(s)):`);
    for (const e of summary.errors) {
      console.log(`  [${e.stage}] ${e.objectApiName}  ${e.failedCount}/${e.attemptedCount}`);
      for (const s of e.samples.slice(0, 2)) {
        console.log(`    ${s.recordSummary}`);
        for (const m of s.messages) console.log(`      └ ${m}`);
      }
    }
  }
  console.log(`\ndone in ${Date.now() - t0}ms`);
  if (summary.failedCount > 0 && summary.successCount === 0) process.exit(1);
}

main().catch((err) => {
  console.error('FATAL:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
