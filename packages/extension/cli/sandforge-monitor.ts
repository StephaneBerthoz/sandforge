#!/usr/bin/env tsx
/**
 * sandforge-monitor — headless Monitor runner.
 *
 * Monitor, like Compare, had full unit-test coverage and had never been run
 * against a real org. This sends the Monitor page's requests through the
 * extension's own composition (see `panelHost.ts`) and prints what the page
 * would receive.
 *
 * Every request reads. Acknowledging or dismissing an alert changes the
 * extension's own state and nothing in the org. `monitor:open-apex-jobs` is
 * not offered: all it does is open a browser.
 *
 * `--repeat` sends the whole set again in the same host, as a page left open
 * does: the parts of the Monitor that remember — the error-log window, the job
 * progress log, the trend history, the alert cooldowns — only show what they
 * do on the second pass. `--org` given twice reads both orgs in turn from the
 * same host, as a window whose Monitor is switched from one org to the other:
 * the alerts are kept for every org together, and only show what they do then.
 *
 * Usage:
 *   npx tsx packages/extension/cli/sandforge-monitor.ts --org TGT
 *   npx tsx packages/extension/cli/sandforge-monitor.ts --org TGT --op refresh --repeat 3
 *   npx tsx packages/extension/cli/sandforge-monitor.ts --org SRC --org TGT --op refresh --op alerts
 *
 * Run from the repository root of a checkout, after pnpm install and
 * pnpm build:shared.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SalesforceOrg } from '@sandforge/shared';
import { createPanelHost } from './panelHost.js';
import type { PanelAnswer, PanelRequest } from './panelHost.js';

const HELP = `sandforge-monitor — read an org the way the Monitor page does, without the editor.

Usage:
  npx tsx packages/extension/cli/sandforge-monitor.ts --org <alias> [options]

Required:
  --org <alias>          sf CLI alias of the org; repeat to read several in turn

Options:
  --op <name>            one of the page's requests; repeat for more (default: all):
                         refresh, live-operations, storage, deployments, api-usage,
                         error-logs, sessions, apex-insights, sandbox-refresh, alerts
  --acknowledge <id>     acknowledge an alert (extension state only)
  --dismiss <id>         dismiss an alert (extension state only)
  --repeat <n>           send the set n times in the same host   (default: 1)
  --pause <seconds>      wait between two passes                 (default: 0)
  --store <dir>          where the host keeps its config store (default: a temp directory)
  --wait <seconds>       how long to keep waiting for an answer  (default: 300)
  --json                 emit what the page would receive
  --help                 this text

Nothing is written to the org.

Exit codes: 0 the run finished (read the answers), 1 it could not start,
2 a bad command line.
`;

/** The page's read requests, in the order the page mounts them. */
const OPERATIONS = [
  'refresh',
  'live-operations',
  'storage',
  'deployments',
  'api-usage',
  'error-logs',
  'sessions',
  'apex-insights',
  'sandbox-refresh',
  'alerts',
] as const;
type Operation = (typeof OPERATIONS)[number];

/** Everything the command line settled. */
interface CliArgs {
  orgs: string[];
  operations: Operation[];
  acknowledge: string[];
  dismiss: string[];
  repeat: number;
  pauseMs: number;
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
  const wholeNumber = (flag: string, fallback: string, min: number): number => {
    const value = Number(get(flag, fallback) ?? fallback);
    if (!Number.isInteger(value) || value < min)
      refuse(`${flag} takes a whole number from ${min}.`);
    return value;
  };

  const orgs = [...new Set(collect('--org'))];
  if (orgs.length === 0) refuse('Missing --org. Run with --help.');

  const asked = collect('--op');
  for (const op of asked) {
    if (op === 'open-apex-jobs') {
      refuse('open-apex-jobs opens a browser and reads nothing: it is not run from here.');
    }
    if (!(OPERATIONS as readonly string[]).includes(op)) {
      refuse(`Not a Monitor request: "${op}". One of: ${OPERATIONS.join(', ')}.`);
    }
  }
  const acknowledge = collect('--acknowledge');
  const dismiss = collect('--dismiss');
  // Given only an alert to act on, the run does that and nothing else.
  const operations =
    asked.length > 0
      ? [...new Set(asked as Operation[])]
      : acknowledge.length + dismiss.length > 0
        ? []
        : [...OPERATIONS];

  return {
    orgs,
    operations,
    acknowledge,
    dismiss,
    repeat: wholeNumber('--repeat', '1', 1),
    pauseMs: wholeNumber('--pause', '0', 0) * 1000,
    storeDir: get('--store', join(tmpdir(), 'sandforge-monitor')) ?? '',
    waitMs: wholeNumber('--wait', '300', 1) * 1000,
    json: args.includes('--json'),
  };
}

/** The request the page sends for one operation, with the answer its hook waits for. */
export function pageRequest(op: Operation, orgId: string): PanelRequest {
  switch (op) {
    case 'refresh':
      return { type: 'monitor:refresh', payload: { orgId }, responseType: 'monitor:data' };
    // Both are sent with no payload by the page: neither names an org.
    case 'live-operations':
      return { type: 'monitor:live-operations' };
    case 'alerts':
      return { type: 'monitor:alerts', responseType: 'monitor:alerts:result' };
    default:
      return { type: `monitor:${op}`, payload: { orgId } };
  }
}

/** Up to `max` entries, then how many more. */
function someOf(items: readonly string[], max = 6): string {
  if (items.length === 0) return '—';
  const shown = items.slice(0, max).join('; ');
  return items.length > max ? `${shown} … (+${items.length - max})` : shown;
}

/** Readable lines for the payload of one answered request about the org `orgId`. */
function describePayload(op: Operation, p: Record<string, unknown>, orgId: string): string[] {
  const list = <T>(key: string): T[] => (Array.isArray(p[key]) ? (p[key] as T[]) : []);
  switch (op) {
    case 'refresh': {
      const limits = list<{ name: string; max: number; remaining: number; usedPercent: number }>(
        'limits',
      );
      const top = [...limits].sort((a, b) => b.usedPercent - a.usedPercent).slice(0, 5);
      const jobs = list<{ status: string; jobType: string }>('jobs');
      const byStatus: Record<string, number> = {};
      for (const job of jobs) byStatus[job.status] = (byStatus[job.status] ?? 0) + 1;
      const info = (p.orgInfo ?? undefined) as Record<string, unknown> | undefined;
      const health = (p.orgHealthStatus ?? undefined) as Record<string, unknown> | undefined;
      const insights = Array.isArray(p.jobInsights)
        ? (p.jobInsights as Array<{ title: string }>)
        : null;
      const trends = (p.trends ?? {}) as Record<
        string,
        { sparklineData: number[]; direction: string }
      >;
      return [
        `  health score ${String(p.healthScore)}; ${limits.length} limit(s), highest: ${someOf(
          top.map((l) => `${l.name} ${l.usedPercent}% (${l.max - l.remaining}/${l.max})`),
          5,
        )}`,
        `  ${jobs.length} job(s): ${someOf(Object.entries(byStatus).map(([s, n]) => `${s} ${n}`))}`,
        `  job insights: ${insights === null ? 'none sent' : someOf(insights.map((i) => i.title))}`,
        info
          ? `  org: type ${String(info.type)}, edition ${String(info.edition)}, instance ${String(
              info.instanceName,
            )}, API ${String(info.apiVersion)}, users ${String(info.userCount)}, custom objects ${String(
              info.customObjectCount,
            )}, Apex classes ${String(info.apexClassCount)}, active flows ${String(info.flowCount)}`
          : '  org: no org info sent',
        health
          ? `  health check: ${String(health.overall)}; api ${String(health.apiLimitsStatus)}, storage ${String(
              health.storageStatus,
            )}, failed jobs ${String(health.failedJobs)}, recent error logs ${String(health.recentErrorLogs)}`
          : '  health check: none sent',
        `  trends: ${someOf(
          Object.entries(trends).map(
            ([name, t]) => `${name} ${t.direction} (${t.sparklineData.length} pt)`,
          ),
          7,
        )}`,
      ];
    }
    case 'live-operations':
      return [`  ${list('operations').length} operation(s)`];
    case 'storage': {
      const objects = list<{ objectName: string; recordCount: number }>('objects');
      return [
        `  ${objects.length} object(s), total ${String(p.totalRecords)} record(s)`,
        `    ${someOf(
          objects.map((o) => `${o.objectName} ${o.recordCount}`),
          10,
        )}`,
      ];
    }
    case 'deployments': {
      const deployments = list<{ status: string; startDate: string; componentCount: number }>(
        'deployments',
      );
      return [
        `  ${deployments.length} deployment(s)`,
        `    ${someOf(
          deployments.map((d) => `${d.status} ${d.startDate} (${d.componentCount})`),
          5,
        )}`,
      ];
    }
    case 'api-usage': {
      const categories = list<{ category: string; used: number; max: number; usedPercent: number }>(
        'categories',
      );
      return [
        `  ${categories.length} categor(ies)`,
        `    ${someOf(
          categories.map((c) => `${c.category} ${c.usedPercent}% (${c.used}/${c.max})`),
          16,
        )}`,
      ];
    }
    case 'error-logs': {
      const errors = list<{ errorType: string; timestamp: string }>('errors');
      return [
        `  total ${String(p.totalCount)}; ${errors.length} listed; by type ${someOf(
          list<{ type: string; count: number }>('errorsByType').map((e) => `${e.type} ${e.count}`),
        )}`,
        errors.length > 0
          ? `    newest ${errors[0].timestamp}, oldest ${errors[errors.length - 1].timestamp}`
          : '    —',
      ];
    }
    case 'sessions': {
      const sessions = list<{ sessionType: string }>('sessions');
      const byType: Record<string, number> = {};
      for (const s of sessions) byType[s.sessionType] = (byType[s.sessionType] ?? 0) + 1;
      return [
        `  ${sessions.length} session(s), ${String(p.activeUserCount)} active user(s)`,
        `    ${someOf(
          Object.entries(byType).map(([t, n]) => `${t} ${n}`),
          10,
        )}`,
      ];
    }
    case 'apex-insights':
      return [
        `  ${list('analyses').length} log(s) analysed; top issues: ${someOf(
          list<{ message: string }>('topIssues').map((i) => i.message),
        )}`,
      ];
    case 'sandbox-refresh':
      return [
        `  supported ${String(p.supported)}; ${list('refreshes').length} refresh(es); in progress ${String(
          p.inProgress,
        )}`,
      ];
    case 'alerts': {
      // The answer holds every org's alerts; the page shows the org on screen.
      const alerts = list<{ id: string; status: string; orgId: string; message: string }>('alerts');
      const history = list<{ orgId: string }>('history');
      const own = alerts.filter((a) => a.orgId === orgId);
      return [
        `  ${alerts.length} active alert(s), ${own.length} of this org; ${history.length} in history, ` +
          `${history.filter((a) => a.orgId === orgId).length} of this org`,
        ...alerts.map(
          (a) =>
            `    ${a.id} ${a.status} ${a.orgId === orgId ? 'this org' : 'another org'}: ${a.message}`,
        ),
      ];
    }
  }
}

/** Readable lines for what the page would receive about the org `orgId`. */
export function describeAnswer(
  label: string,
  op: Operation | undefined,
  answer: PanelAnswer,
  orgId = '',
): string[] {
  const took = `${(answer.elapsedMs / 1000).toFixed(1)}s`;
  const head = `${label}  ${answer.outcome} in ${took}`;
  const lines = [answer.late ? `${head}  — past the page's timeout: the page dropped it` : head];
  const payload = (answer.message?.payload ?? {}) as Record<string, unknown>;
  if (answer.outcome !== 'answered') {
    if (answer.message) lines.push(`  ${String(payload.message ?? JSON.stringify(payload))}`);
    return lines;
  }
  return op
    ? [...lines, ...describePayload(op, payload, orgId)]
    : [...lines, `  ${JSON.stringify(payload)}`];
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
    // The extension's own warnings, failures and alerts, not its routine traffic.
    log: (line) => {
      if (/^\s*!|\[(ERR|WARN|ALERT)\]/.test(line)) log(line);
    },
    waitMs: args.waitMs,
  });
  const orgs: SalesforceOrg[] = [];
  for (const alias of args.orgs) {
    const org = await host.connect(alias);
    orgs.push(org);
    log(`sandforge-monitor  ${alias} (${org.orgType})  store: ${args.storeDir}`);
  }

  const results: Array<{ pass: number; org: string; label: string; answer: PanelAnswer }> = [];
  for (let pass = 1; pass <= args.repeat; pass++) {
    if (args.repeat > 1) log(`\n— pass ${pass} of ${args.repeat}`);
    for (const org of orgs) {
      if (orgs.length > 1) log(`\n[${org.alias}]`);
      for (const op of args.operations) {
        const answer = await host.request(pageRequest(op, org.id));
        results.push({ pass, org: org.alias, label: `monitor:${op}`, answer });
        for (const line of describeAnswer(`monitor:${op}`, op, answer, org.id)) log(line);
      }
    }
    for (const [verb, ids] of [
      ['acknowledge', args.acknowledge],
      ['dismiss', args.dismiss],
    ] as const) {
      for (const alertId of ids) {
        const label = `monitor:alert:${verb}`;
        const answer = await host.request({ type: label, payload: { alertId } });
        results.push({ pass, org: '', label, answer });
        for (const line of describeAnswer(`${label} ${alertId}`, undefined, answer)) log(line);
      }
    }
    if (pass < args.repeat && args.pauseMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, args.pauseMs));
    }
  }

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify({ tool: 'sandforge-monitor', results, posted: host.posted }, null, 2)}\n`,
    );
  }
}

// `tsx` runs this file directly; the check keeps it silent under test.
if (process.argv[1]?.includes('sandforge-monitor')) {
  main()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
