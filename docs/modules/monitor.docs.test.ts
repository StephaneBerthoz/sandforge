/**
 * Doc/code drift guard for the Monitor module page.
 *
 * `MonitorPage` mounts panels that each read their own data from the org, and
 * `docs/modules/monitor.md` described none of nine of them: a reader met a
 * Sessions table or a Governance score with no word on what it shows or where
 * its figures come from. This test reads the page back and fails when a
 * mounted panel has no section, or when a section names a source the
 * extension no longer reads.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

// Normalised: the section split below is LF-anchored and misses on a CRLF checkout.
const DOC = readFileSync(resolve(HERE, 'monitor.md'), 'utf8').replace(/\r\n/g, '\n');

function source(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8');
}

const MONITOR_PAGE = source('packages/webview/src/pages/Monitor/MonitorPage.tsx');

/** Where the extension reads what those panels show. */
const EXTENSION_SOURCES = [
  'packages/extension/src/bridge/handlers/MonitorOpsHandler.ts',
  'packages/extension/src/bridge/handlers/GovernanceOpsHandler.ts',
  'packages/extension/src/modules/monitor/MonitorOpsFactory.ts',
]
  .map(source)
  .join('\n');

/**
 * Each panel the page mounts, the heading that documents it, and the source
 * its section must name. The heading is prose and the component is code, so
 * the link is stated rather than derived.
 */
const PANELS: ReadonlyArray<{ component: string; heading: string; reads: string }> = [
  { component: 'StorageBreakdownPanel', heading: 'Records by Object', reads: 'EntityDefinition' },
  { component: 'ApiUsagePanel', heading: 'API Usage Breakdown', reads: '/limits' },
  { component: 'DeploymentTimeline', heading: 'Recent Deployments', reads: 'DeployRequest' },
  { component: 'ErrorLogsPanel', heading: 'Error Logs', reads: 'ApexLog' },
  { component: 'SessionsPanel', heading: 'Active Sessions', reads: 'AuthSession' },
  { component: 'ApexInsightsPanel', heading: 'Apex Insights', reads: 'ApexLog' },
  { component: 'RefreshPanel', heading: 'Sandbox Refreshes', reads: 'SandboxProcess' },
  { component: 'HealthCheckPanel', heading: 'Org Health Check', reads: 'AsyncApexJob' },
  { component: 'GovernancePanelConnected', heading: 'Governance', reads: '/limits' },
];

/** The body of the `### heading` section, up to the next heading of any level. */
function section(heading: string): string | undefined {
  const start = DOC.indexOf(`\n### ${heading}\n`);
  if (start === -1) return undefined;
  const body = DOC.slice(start + heading.length + 6);
  const end = body.search(/\n#{2,3} /);
  return end === -1 ? body : body.slice(0, end);
}

/** The section's prose with its line breaks folded, so a claim can span a wrap. */
function prose(heading: string): string {
  return (section(heading) ?? '').replace(/\s+/g, ' ');
}

describe('docs/modules/monitor.md', () => {
  it.each(PANELS)('documents the $component panel under "$heading"', ({ component, heading }) => {
    // The roster must track the page: a panel it no longer mounts is not a
    // reason to keep a section, and this row would pass for nothing.
    expect(MONITOR_PAGE).toContain(`<${component}`);
    expect(section(heading)?.trim()).toBeTruthy();
  });

  it('says which built-in governance rules are not measured, instead of claiming they pass', () => {
    const governance = section('Governance') ?? '';
    expect(governance).not.toContain('API and storage rules pass');
    expect(governance).toContain('not measured');
  });

  it('gives the Org Health Check job and error-log figures as counts', () => {
    const health = section('Org Health Check') ?? '';
    expect(health).not.toMatch(/points\b[^.]*\blost/);
    expect(health).toContain('number of failed jobs');
  });

  it('leaves a health signal that cannot be read out of the average, and says so', () => {
    // The page said an unread signal counted as a full 100, and that its count
    // showed 0: HealthCheck.computeScore averages the signals read only, and
    // the panel says "not read".
    const health = prose('Org Health Check');
    expect(health).not.toContain('counts as a full 100');
    expect(health).not.toMatch(/shows 0 when/);
    expect(health).toContain('left out of the average');
    expect(health).toContain('"not read"');
    expect(source('packages/extension/src/modules/monitor/HealthCheck.ts')).toContain(
      "s.status !== 'unknown'",
    );
  });

  it('says how many of the latest jobs Failed Jobs is counted among, the bound the read has', () => {
    const health = prose('Org Health Check');
    const bound = /monitorJobs: (\d+),/.exec(source('packages/shared/src/constants/defaults.ts'));
    expect(bound).not.toBeNull();
    expect(health).toContain(`the ${bound?.[1]} most recent \`AsyncApexJob\` rows`);
    expect(health).toContain(`(at most ${bound?.[1]})`);
  });

  it('says every error-log reading covers the whole day, not where the last one stopped', () => {
    // Each reading used to start from the oldest log of the one before; the
    // page kept saying so after ErrorLogMonitor read the whole window again.
    const errorLogs = prose('Error Logs');
    expect(errorLogs).not.toContain('starts from the oldest log the previous one returned');
    expect(errorLogs).toContain('Every reading covers the whole 24 hours again');
    expect(source('packages/extension/src/modules/monitor/ErrorLogMonitor.ts')).toContain(
      'Date.now() - 24 * 60 * 60 * 1000',
    );
  });

  it('says a scan judges a bounded sample of records, and which bound', () => {
    const limits = prose('Governor Limits');
    const bound = /anomalyScan: (\d+),/.exec(source('packages/shared/src/constants/defaults.ts'));
    expect(bound).not.toBeNull();
    expect(limits).toContain(`the most a scan reads: ${bound?.[1]}, or 200`);
  });

  it.each(PANELS)(
    'says the $component panel reads $reads, which the extension still reads',
    ({ heading, reads }) => {
      expect(EXTENSION_SOURCES).toContain(reads);
      expect(section(heading) ?? '').toContain(reads);
    },
  );
});
