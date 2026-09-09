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
 *   sandforge-clone --record 500XX00000000001AAA \
 *                   --source SOURCE-UAT --target TARGET-DEV \
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
  /** Enable upsert path on objects with externalId fields (skips DUPLICATE_VALUE on re-runs). */
  upsert: boolean;
  /** Single-hop orphan parent expansion when a required FK is out-of-graph. */
  expandOrphans: boolean;
  /** Skip the pre-execute target preflight (counts existing rows on target). */
  skipPreflight: boolean;
  /** Emit JSON summary on stdout (machine-readable for CI integration). */
  json: boolean;
  /** Per-object field exclusions: { Account: ['Description', 'NumberOfEmployees'] }. */
  fieldExclusions: Record<string, string[]>;
  /** Source User Id → target User Id remap for OwnerId. */
  ownerMappings: Record<string, string>;
  /** Per-object SOQL WHERE filter: { Case: "Status = 'Open' AND CreatedDate > LAST_N_DAYS:30" }. */
  objectSoqlFilters: Record<string, string>;
  /** Per-object source→target field rename: { Account: { 'Region__c': 'Region__pc' } }. */
  fieldMappings: Record<string, Record<string, string>>;
  /** Output path for the remap-table CSV (sourceId,targetId). undefined = no export. */
  remapCsv: string | undefined;
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
  --upsert               use external Id upsert when available  (default: insert)
                         Skips DUPLICATE_VALUE on re-runs of the same source records.
  --expand-orphans       single-hop expand orphan parent FKs    (default: off)
                         Clones missing parents (out-of-graph) so child FKs resolve.
  --skip-preflight       skip pre-execute target row count      (default: off)
                         The preflight queries each object on target so the user
                         can see existing volume before pressing through.
  --json                 emit JSON summary on stdout (CI mode)  (default: off)
  --exclude <obj.field>  skip a field on an object during clone (repeatable)
                         e.g. --exclude Account.Description --exclude Account.NumberOfEmployees
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
  --remap-csv <file>     write the source→target ID remap table to a CSV
                         file (header: sourceId,targetId). BA reconciliation:
                         "where did source X go on the target sandbox?"
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
  // Repeatable flags: scan all positions for matches.
  const collectRepeated = (flag: string): string[] => {
    const out: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === flag && i + 1 < args.length) out.push(args[i + 1]);
    }
    return out;
  };
  const fieldExclusions: Record<string, string[]> = {};
  for (const raw of collectRepeated('--exclude')) {
    const dotIdx = raw.indexOf('.');
    if (dotIdx <= 0 || dotIdx === raw.length - 1) {
      process.stderr.write(`Invalid --exclude value "${raw}" (expected Object.field)\n`);
      process.exit(2);
    }
    const obj = raw.slice(0, dotIdx);
    const field = raw.slice(dotIdx + 1);
    (fieldExclusions[obj] ??= []).push(field);
  }
  const ownerMappings: Record<string, string> = {};
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
  const objectSoqlFilters: Record<string, string> = {};
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
  const fieldMappings: Record<string, Record<string, string>> = {};
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
    const fieldRe = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;
    if (!fieldRe.test(src) || !fieldRe.test(tgt)) {
      process.stderr.write(
        `Invalid --map field name in "${raw}" (must match SObject API name pattern)\n`,
      );
      process.exit(2);
    }
    (fieldMappings[obj] ??= {})[src] = tgt;
  }
  return {
    record,
    source,
    target,
    depth: depthRaw,
    customDepth: customDepthRaw ? Number(customDepthRaw) : 5,
    maxRecordsPerObject: maxRaw ? Number(maxRaw) : undefined,
    anonymize: has('--anonymize'),
    dryRun: has('--dry-run'),
    upsert: has('--upsert'),
    expandOrphans: has('--expand-orphans'),
    skipPreflight: has('--skip-preflight'),
    json: has('--json'),
    fieldExclusions,
    ownerMappings,
    objectSoqlFilters,
    fieldMappings,
    remapCsv: get('--remap-csv'),
  };
}

/** SF alias = letters/digits/underscore/dash/dot. Defends against shell metachars. */
const SF_ALIAS_RE = /^[A-Za-z0-9_.-]+$/;

function loadOrg(alias: string): SfOrg {
  // shell:true on Windows is required to resolve `.cmd` files but lets cmd.exe
  // interpret metacharacters (`&`, `|`, `>`, `^`, `"`). Validate alias before
  // passing — block any shell-injection vector via crafted CLI args.
  if (!SF_ALIAS_RE.test(alias)) {
    throw new Error(
      `Invalid SF org alias: "${alias}" (allowed: letters, digits, underscore, dash, dot)`,
    );
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
  console.log(
    `graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges, ${plan.waves.length} waves, ${plan.cycleResolutions.length} cycles${graph.truncated ? ' (TRUNCATED)' : ''}`,
  );

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
        errors:
          x.errors?.map((e: { statusCode?: string; message?: string }) =>
            e.statusCode ? `${e.statusCode}: ${e.message ?? ''}` : (e.message ?? ''),
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
        errors:
          x.errors?.map((e: { statusCode?: string; message?: string }) =>
            e.statusCode ? `${e.statusCode}: ${e.message ?? ''}` : (e.message ?? ''),
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
    // CR-016: surface upsert path so re-runs against the same source records
    // don't pile DUPLICATE_VALUE errors on objects with external Id fields.
    upsertRecords: async (orgId, name, externalIdField, records) => {
      if (args.dryRun) return records.map(() => ({ id: '', success: true, errors: [] }));
      const c = conns.get(orgId);
      if (!c) throw new Error(`No connection for ${orgId}`);
      const r = await c.sobject(name).upsert(records, externalIdField);
      const arr = Array.isArray(r) ? r : [r];
      return arr.map((x) => ({
        id: x.id ?? '',
        success: x.success,
        errors:
          x.errors?.map((e: { statusCode?: string; message?: string }) =>
            e.statusCode ? `${e.statusCode}: ${e.message ?? ''}` : (e.message ?? ''),
          ) ?? [],
      }));
    },
  };

  // Preflight: pre-count rows on the target for every node in the graph so
  // the user sees how much data already exists before pulling the trigger.
  // Skip with --skip-preflight if it's slow on big graphs (10s+ on 100 nodes).
  if (!args.skipPreflight) {
    console.log('\npreflight (target row counts)…');
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
      console.log('  target is empty for all sampled objects.');
    } else {
      const top = nonZero.sort((a, b) => b.existing - a.existing).slice(0, 10);
      console.log(
        `  ${nonZero.length}/${preflight.length} sampled objects have existing rows. Top 10:`,
      );
      for (const p of top) {
        const flag = p.existing > 1000 ? '  ⚠' : '';
        console.log(`    ${p.name.padEnd(40)} ${String(p.existing).padStart(8)}${flag}`);
      }
      if (graph.nodes.length > sample.length) {
        console.log(
          `  (sampled first ${sample.length}/${graph.nodes.length} nodes; --skip-preflight to bypass)`,
        );
      }
    }
  }

  console.log(
    `\nexecuting… (${args.dryRun ? 'DRY-RUN' : 'REAL'}${args.upsert ? ', UPSERT' : ''}${args.expandOrphans ? ', EXPAND-ORPHANS' : ''})`,
  );
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
      upsertMode: args.upsert ? 'auto' : undefined,
      expandOrphanParents: args.expandOrphans,
      fieldExclusions:
        Object.keys(args.fieldExclusions).length > 0 ? args.fieldExclusions : undefined,
      ownerMappings: Object.keys(args.ownerMappings).length > 0 ? args.ownerMappings : undefined,
      objectSoqlFilters:
        Object.keys(args.objectSoqlFilters).length > 0 ? args.objectSoqlFilters : undefined,
      fieldMappings: Object.keys(args.fieldMappings).length > 0 ? args.fieldMappings : undefined,
    },
  );

  const elapsed = Date.now() - t0;

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
    if (!args.json) {
      console.log(
        `remap-csv: wrote ${Object.keys(summary.remapTable).length} mappings to ${resolved}`,
      );
    }
  }

  if (args.json) {
    // Machine-readable summary for CI/automation. Stable schema.
    process.stdout.write(
      JSON.stringify(
        {
          tool: 'sandforge-clone',
          version: 1,
          source: args.source,
          target: args.target,
          record: args.record,
          dryRun: args.dryRun,
          upsert: args.upsert,
          expandOrphans: args.expandOrphans,
          graph: {
            nodes: graph.nodes.length,
            edges: graph.edges.length,
            waves: plan.waves.length,
            cycles: plan.cycleResolutions.length,
            truncated: graph.truncated ?? false,
          },
          result: {
            successCount: summary.successCount,
            failedCount: summary.failedCount,
            skippedCount: summary.skippedCount,
            remapCount: summary.remapCount,
            errors: summary.errors.map((e) => ({
              objectApiName: e.objectApiName,
              stage: e.stage,
              failedCount: e.failedCount,
              attemptedCount: e.attemptedCount,
              samples: e.samples,
            })),
            // remapTable only included in JSON output for CI consumers; the
            // text output stays terse (use --remap-csv for the file dump).
            remapTable: summary.remapTable,
          },
          elapsedMs: elapsed,
        },
        null,
        2,
      ) + '\n',
    );
  } else {
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
    console.log(`\ndone in ${elapsed}ms`);
  }
  if (summary.failedCount > 0 && summary.successCount === 0) process.exit(1);
}

main().catch((err) => {
  console.error('FATAL:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
