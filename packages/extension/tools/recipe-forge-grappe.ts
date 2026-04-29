/* eslint-disable no-console */
/**
 * Phase A — Forge "5 niveaux" recette (READ-ONLY).
 *
 * Replays the production Forge discovery + plan pipeline against real orgs,
 * using the live tokens from the `sf` CLI. Does NOT call ForgeExecutor —
 * no writes are performed against the target org.
 *
 * Usage:
 *   pnpm --filter @sandforge/extension exec tsx tools/recipe-forge-grappe.ts
 *
 * Default scenario: clone Case 500AP00000fXeQsYAK from MUT-UAT2 → MUT-SBER
 * with depth=custom=5 (matches the Forge wizard screenshot).
 */
import { execFileSync } from 'node:child_process';
import jsforce from 'jsforce';

import type { ForgeConfig, ForgeGraph, ForgeGraphNode } from '@sandforge/shared';
import { GraphDiscoveryService } from '../src/modules/forge/GraphDiscoveryService.js';
import type {
  GraphDiscoveryDeps,
  ObjectDescribe,
  FieldDescribe as GraphFieldDescribe,
} from '../src/modules/forge/GraphDiscoveryService.js';
import { ForgePlanGenerator } from '../src/modules/forge/ForgePlanGenerator.js';
import { PIIDetector } from '../src/core/precheck/PIIDetector.js';

interface SfOrg {
  alias: string;
  username: string;
  instanceUrl: string;
  accessToken: string;
}

const SCENARIO = {
  sourceAlias: 'MUT-UAT2',
  targetAlias: 'MUT-SBER',
  recordId: '500AP00000fXeQsYAK',
  depth: 'custom' as const,
  customDepth: 5,
  anonymizePII: true,
  skipEmpty: true,
  apiVersion: '66.0',
};

function loadSfOrgs(): Map<string, SfOrg> {
  const json = execFileSync('sf', ['org', 'list', '--json'], {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    shell: process.platform === 'win32',
  });
  const parsed = JSON.parse(json) as {
    result?: { sandboxes?: unknown[]; nonScratchOrgs?: unknown[]; other?: unknown[] };
  };
  const buckets = [
    ...(parsed.result?.sandboxes ?? []),
    ...(parsed.result?.nonScratchOrgs ?? []),
    ...(parsed.result?.other ?? []),
  ];
  const map = new Map<string, SfOrg>();
  for (const raw of buckets) {
    const o = raw as Record<string, unknown>;
    const alias = typeof o.alias === 'string' ? o.alias : undefined;
    const accessToken = typeof o.accessToken === 'string' ? o.accessToken : undefined;
    const instanceUrl = typeof o.instanceUrl === 'string' ? o.instanceUrl : undefined;
    const username = typeof o.username === 'string' ? o.username : '';
    if (alias && accessToken && instanceUrl) {
      map.set(alias, { alias, username, instanceUrl, accessToken });
    }
  }
  return map;
}

function makeConnection(org: SfOrg): jsforce.Connection {
  return new jsforce.Connection({
    instanceUrl: org.instanceUrl,
    accessToken: org.accessToken,
    version: SCENARIO.apiVersion,
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

function buildDeps(connections: Map<string, jsforce.Connection>, fullDescribes: Map<string, ObjectDescribe>): GraphDiscoveryDeps {
  const piiDetector = new PIIDetector();
  return {
    describeObject: async (orgId, objectApiName) => {
      const conn = connections.get(orgId);
      if (!conn) throw new Error(`No connection for org ${orgId}`);
      const raw = await conn.sobject(objectApiName).describe();
      const adapted = adaptDescribe(raw);
      fullDescribes.set(objectApiName, adapted);
      return adapted;
    },
    queryCount: async (orgId, soql) => {
      const conn = connections.get(orgId);
      if (!conn) throw new Error(`No connection for org ${orgId}`);
      const result = await conn.query(soql);
      return result.totalSize;
    },
    detectPII: (fields: GraphFieldDescribe[]) => {
      const adaptedFields = fields.map((f) => ({
        apiName: f.name,
        label: f.name,
        type: f.type,
      }));
      const result = piiDetector.detectPII('graph-node', adaptedFields);
      return result.piiFields.map((p) => p.fieldApiName);
    },
    describeGlobal: async (orgId) => {
      const conn = connections.get(orgId);
      if (!conn) throw new Error(`No connection for org ${orgId}`);
      const result = await conn.describeGlobal();
      return result.sobjects.map((s) => ({ name: s.name, keyPrefix: s.keyPrefix ?? null }));
    },
  };
}

function bar(width: number, ratio: number): string {
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function printGraph(graph: ForgeGraph): void {
  const sorted = [...graph.nodes].sort((a, b) => a.level - b.level || b.recordCount - a.recordCount);
  const maxRec = Math.max(1, ...sorted.map((n) => n.recordCount));
  console.log(`\n══════════ DISCOVERY GRAPH ══════════`);
  console.log(`Nodes: ${graph.nodes.length}  |  Edges: ${graph.edges.length}  |  Total records: ${graph.totalRecords}`);
  console.log(`Est size: ${graph.estimatedSizeMB.toFixed(2)} MB  |  Est duration: ${graph.estimatedDurationSeconds.toFixed(0)}s`);
  console.log(`\n${'lvl'.padEnd(4)} ${'object'.padEnd(45)} ${'records'.padStart(8)} ${'fields'.padStart(7)} ${'pii'.padStart(4)}  bar`);
  console.log('-'.repeat(110));
  for (const n of sorted) {
    const pii = n.piiFields.length;
    const piiStr = pii > 0 ? `\x1b[33m${String(pii).padStart(3)}!\x1b[0m` : '   .';
    const ratio = n.recordCount / maxRec;
    console.log(
      `${String(n.level).padEnd(4)} ${n.objectApiName.padEnd(45)} ${String(n.recordCount).padStart(8)} ${String(n.fieldCount).padStart(7)} ${piiStr}  ${bar(20, ratio)}`,
    );
  }
}

function printEdges(graph: ForgeGraph): void {
  const grouped = new Map<string, { ml: number; lk: number }>();
  for (const e of graph.edges) {
    const k = `${e.sourceObject} → ${e.targetObject}`;
    const v = grouped.get(k) ?? { ml: 0, lk: 0 };
    if (e.type === 'master-detail') v.ml++;
    else v.lk++;
    grouped.set(k, v);
  }
  console.log(`\n══════════ EDGES (${graph.edges.length}) — grouped by source→target ══════════`);
  const lines = [...grouped.entries()].sort();
  for (const [k, v] of lines) {
    const parts: string[] = [];
    if (v.ml > 0) parts.push(`MD×${v.ml}`);
    if (v.lk > 0) parts.push(`LK×${v.lk}`);
    console.log(`  ${k.padEnd(70)} [${parts.join(' ')}]`);
  }
}

function printPIIDetail(graph: ForgeGraph): void {
  const withPii = graph.nodes.filter((n) => n.piiFields.length > 0);
  if (withPii.length === 0) {
    console.log(`\n══════════ PII DETECTION ══════════\n  (no PII detected)`);
    return;
  }
  console.log(`\n══════════ PII DETECTION (${withPii.length} objects) ══════════`);
  for (const n of withPii) {
    console.log(`  ${n.objectApiName} (${n.piiFields.length}) → ${n.piiFields.slice(0, 8).join(', ')}${n.piiFields.length > 8 ? ', …' : ''}`);
  }
}

interface PlanLite {
  waves: Array<{ order: number; objectApiNames: string[]; totalRecords: number; estimatedDurationSeconds: number; estimatedApiCalls: number }>;
  totalRecords: number;
  totalApiCalls: number;
  estimatedDurationSeconds: number;
  cycleResolutions: Array<{ objects: string[]; strategy: string; description: string }>;
}

function printPlan(plan: PlanLite): void {
  console.log(`\n══════════ EXECUTION PLAN ══════════`);
  console.log(`Waves: ${plan.waves.length}  |  Total API calls: ${plan.totalApiCalls}  |  Est duration: ${plan.estimatedDurationSeconds.toFixed(1)}s`);
  for (const w of plan.waves) {
    console.log(`  wave ${w.order}: ${w.objectApiNames.length} obj | ${w.totalRecords} rec | ${w.estimatedApiCalls} api | ${w.estimatedDurationSeconds.toFixed(1)}s`);
    console.log(`           ${w.objectApiNames.join(', ')}`);
  }
  if (plan.cycleResolutions.length > 0) {
    console.log(`\n══════════ CYCLES DETECTED (${plan.cycleResolutions.length}) ══════════`);
    for (const c of plan.cycleResolutions) {
      console.log(`  [${c.strategy}] ${c.description}`);
    }
  } else {
    console.log(`\nCycles: none`);
  }
}

function printAnomalies(graph: ForgeGraph): void {
  const issues: string[] = [];
  if (graph.truncated) issues.push(`⚠ Graph TRUNCATED — BFS hit DEFAULT_MAX_NODES cap (some objects skipped).`);
  else if (graph.nodes.length >= 50) issues.push(`⚠ Reached MAX_NODES=50 cap exactly — verify nothing was skipped.`);
  const noFields = graph.nodes.filter((n) => n.fieldCount === 0);
  if (noFields.length > 0) issues.push(`⚠ ${noFields.length} node(s) with 0 fields: ${noFields.map((n) => n.objectApiName).join(', ')}`);
  const isolated = graph.nodes.filter((n) => !graph.edges.some((e) => e.sourceObject === n.objectApiName || e.targetObject === n.objectApiName));
  if (isolated.length > 0) issues.push(`⚠ ${isolated.length} isolated node(s) (no edge): ${isolated.map((n) => n.objectApiName).join(', ')}`);
  const emptyIncluded = graph.nodes.filter((n: ForgeGraphNode) => n.recordCount === 0 && n.included);
  if (emptyIncluded.length > 0) issues.push(`ℹ skipEmpty was true but ${emptyIncluded.length} node(s) with 0 records still marked included — verify GraphDiscoveryService:190.`);
  if (issues.length === 0) {
    console.log(`\nAnomalies: none ✓`);
    return;
  }
  console.log(`\n══════════ ANOMALIES ══════════`);
  for (const i of issues) console.log(`  ${i}`);
}

async function main(): Promise<void> {
  const t0 = Date.now();
  console.log(`Loading sf orgs…`);
  const orgs = loadSfOrgs();
  const source = orgs.get(SCENARIO.sourceAlias);
  const target = orgs.get(SCENARIO.targetAlias);
  if (!source) throw new Error(`Source alias '${SCENARIO.sourceAlias}' not found in sf orgs`);
  if (!target) throw new Error(`Target alias '${SCENARIO.targetAlias}' not found in sf orgs`);
  console.log(`✓ Source: ${source.alias} (${source.username}) @ ${source.instanceUrl}`);
  console.log(`✓ Target: ${target.alias} (${target.username}) @ ${target.instanceUrl}`);

  const connections = new Map<string, jsforce.Connection>();
  connections.set(source.alias, makeConnection(source));
  connections.set(target.alias, makeConnection(target));

  const config: ForgeConfig = {
    inputMode: 'record',
    recordId: SCENARIO.recordId,
    depth: SCENARIO.depth,
    customDepth: SCENARIO.customDepth,
    sourceOrgId: source.alias,
    targetOrgId: target.alias,
    anonymizePII: SCENARIO.anonymizePII,
    skipEmpty: SCENARIO.skipEmpty,
    batchSize: 'auto',
  };

  console.log(`\nConfig: depth=${config.depth} customDepth=${config.customDepth} skipEmpty=${config.skipEmpty} anonymizePII=${config.anonymizePII}`);
  console.log(`Record: ${config.recordId} (probable Case — prefix 500)`);

  const fullDescribes = new Map<string, ObjectDescribe>();
  const deps = buildDeps(connections, fullDescribes);
  const service = new GraphDiscoveryService(deps);

  console.log(`\n[${new Date().toISOString()}] BFS discovery starting…`);
  let lastProgressTime = Date.now();
  const graph = await service.discover(config, {
    onProgress: (e) => {
      const now = Date.now();
      if (now - lastProgressTime > 250 || e.queueRemaining === 0) {
        process.stdout.write(`\r  discovered=${String(e.discoveredCount).padStart(3)} queue=${String(e.queueRemaining).padStart(3)} latest=${e.objectApiName.padEnd(40)}`);
        lastProgressTime = now;
      }
    },
  });
  process.stdout.write('\n');
  const tDiscovery = Date.now() - t0;
  console.log(`✓ Discovery complete in ${tDiscovery}ms`);

  printGraph(graph);
  printPIIDetail(graph);
  printEdges(graph);

  console.log(`\n[${new Date().toISOString()}] Plan generation…`);
  const plan = new ForgePlanGenerator().generate(graph);
  printPlan(plan as PlanLite);

  printAnomalies(graph);

  console.log(`\n══════════ SUMMARY ══════════`);
  console.log(`Total wallclock: ${Date.now() - t0}ms`);
  console.log(`Discovery: ${tDiscovery}ms  |  Plan: ${Date.now() - t0 - tDiscovery}ms`);
  console.log(`READ-ONLY recipe — no records were written to ${target.alias}.`);
}

main().catch((err) => {
  console.error('\n✗ FATAL:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
