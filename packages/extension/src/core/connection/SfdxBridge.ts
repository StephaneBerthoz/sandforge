import type { SalesforceOrg, ConnectionConfig } from '@sandforge/shared';
import { OrgSafetyTier, SF_LIMITS } from '@sandforge/shared';

const MAX_BUFFER = 10 * 1024 * 1024; // 10 MB

/** Error from exec that includes stdout/stderr even on non-zero exit */
interface ExecError extends Error {
  stdout?: string;
  stderr?: string;
  code?: number;
}

/**
 * Execute a shell command asynchronously.
 * Uses exec (with shell) so that .cmd/.ps1 shims resolve correctly on Windows.
 * windowsHide prevents cmd.exe flash on Windows.
 */
async function execAsync(
  command: string,
  options?: { timeout?: number; maxBuffer?: number },
): Promise<{ stdout: string; stderr: string }> {
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const result = await promisify(exec)(command, {
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
    env: { ...process.env, NO_COLOR: '1' },
    ...options,
  });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
}

/**
 * Execute a command without a shell (POSIX argv-as-array hardening).
 * Mirrors the RT-#8 pattern used by ConnectionHelper.refreshTokenViaCli:
 * no shell means no interpolation, so args need no escaping.
 */
async function execFileAsync(
  file: string,
  args: string[],
  options?: { timeout?: number },
): Promise<{ stdout: string; stderr: string }> {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const result = await promisify(execFile)(file, args, {
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
    env: { ...process.env, NO_COLOR: '1' },
    ...options,
  });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
}

/**
 * Validate a Salesforce instance URL for CLI use.
 * Must be an https:// URL whose hostname contains only shell-safe characters
 * (letters, digits, dot, dash) — this is the shell-injection defense for the
 * Windows exec branch of loginWeb.
 */
function validateInstanceUrl(instanceUrl: string): void {
  let url: URL;
  try {
    url = new URL(instanceUrl);
  } catch {
    throw new Error(`Invalid instanceUrl: "${instanceUrl}"`);
  }
  if (url.protocol !== 'https:' || !/^[\w.-]+$/.test(url.hostname)) {
    throw new Error(
      `Invalid instanceUrl: "${instanceUrl}" — expected an https:// URL with a valid hostname`,
    );
  }
}

/**
 * Extract the first valid JSON object or array from a raw string.
 * SF CLI may emit warnings, ANSI escape codes, or other text before JSON.
 */
function extractJson(raw: string): string {
  // Strip ANSI escape codes first (ESC[ ... m sequences)
  // eslint-disable-next-line no-control-regex -- Intentional ANSI escape code stripping
  const stripped = raw.replace(/\u001b\[[0-9;]*m/g, '');
  const start = stripped.search(/[{[]/);
  if (start === -1) {
    throw new Error(`No JSON found in output (${raw.length} chars): ${raw.slice(0, 200)}`);
  }
  return stripped.slice(start);
}

/** Result from parsing a single SF CLI org entry */
export interface SfdxOrgEntry {
  orgId: string;
  username: string;
  alias?: string;
  instanceUrl: string;
  accessToken?: string;
  connectedStatus: string;
  isSandbox?: boolean;
  isScratchOrg?: boolean;
  instanceApiVersion?: string;
  name?: string;
}

/** Result of importing orgs from SF CLI */
export interface SfdxImportResult {
  org: SalesforceOrg;
  credentials: ConnectionConfig;
}

/**
 * Bridge to Salesforce CLI (sf).
 * Executes sf commands, parses output, and maps to SandForge types.
 */
export class SfdxBridge {
  /** Verify that sf CLI is available on PATH */
  async isCliAvailable(): Promise<boolean> {
    try {
      await execAsync('sf --version', { timeout: 10_000 });
      return true;
    } catch {
      return false;
    }
  }

  /** Execute sf org list --json --no-color, parse, dedupe, and return connected orgs */
  async listOrgs(): Promise<SfdxImportResult[]> {
    let stdout: string;
    try {
      const result = await execAsync('sf org list --json', { timeout: 30_000 });
      stdout = result.stdout;
    } catch (err: unknown) {
      // SF CLI returns non-zero exit code on some errors but still outputs JSON
      const execErr = err as ExecError;
      stdout = String(execErr.stdout ?? '');
      if (!stdout) {
        throw new Error(`SF CLI failed with no output: ${execErr.message}`);
      }
    }

    const jsonStr = extractJson(stdout);
    let parsed: {
      result: {
        nonScratchOrgs?: SfdxOrgEntry[];
        scratchOrgs?: SfdxOrgEntry[];
        sandboxes?: SfdxOrgEntry[];
        other?: SfdxOrgEntry[];
        devHubs?: SfdxOrgEntry[];
      };
    };
    try {
      parsed = JSON.parse(jsonStr) as typeof parsed;
    } catch (parseErr: unknown) {
      throw new Error(
        `Failed to parse SF CLI JSON: ${parseErr instanceof Error ? parseErr.message : parseErr}. ` +
          `Output starts with: ${stdout.slice(0, 300)}`,
      );
    }

    // SF CLI v2 returns orgs in multiple buckets: nonScratchOrgs, scratchOrgs, sandboxes, other, devHubs
    const allEntries: SfdxOrgEntry[] = [
      ...(parsed.result?.nonScratchOrgs ?? []),
      ...(parsed.result?.scratchOrgs ?? []),
      ...(parsed.result?.sandboxes ?? []),
      ...(parsed.result?.other ?? []),
      ...(parsed.result?.devHubs ?? []),
    ];

    const deduped = this.dedupeByOrgId(allEntries);
    return deduped
      .filter((entry) => entry.connectedStatus === 'Connected')
      .map((entry) => this.mapToSalesforceOrg(entry));
  }

  /** Execute sf org login web to open browser auth flow */
  async loginWeb(alias: string, instanceUrl: string): Promise<void> {
    // Validate before any shell/exec use (audit RT-#8 hardening, same pattern
    // as ConnectionHelper.refreshTokenViaCli). These checks are the only
    // shell-injection defense on the Windows exec branch below.
    if (alias && !/^[\w.-]+$/.test(alias)) {
      throw new Error(`Invalid alias format: "${alias}"`);
    }
    validateInstanceUrl(instanceUrl);

    // POSIX: argv-as-array via execFile — no shell, no interpolation.
    // Windows: `sf` resolves to `sf.cmd` which requires shell-based PATHEXT
    // resolution, so keep exec there; the validated values (word/dot/dash
    // alias + https URL) are shell-safe inside double quotes.
    if (process.platform === 'win32') {
      let command = `sf org login web --instance-url "${instanceUrl}"`;
      if (alias) {
        command += ` --alias "${alias}"`;
      }
      await execAsync(command, { timeout: 120_000 });
    } else {
      const args = ['org', 'login', 'web', '--instance-url', instanceUrl];
      if (alias) {
        args.push('--alias', alias);
      }
      await execFileAsync('sf', args, { timeout: 120_000 });
    }
  }

  private dedupeByOrgId(entries: SfdxOrgEntry[]): SfdxOrgEntry[] {
    const map = new Map<string, SfdxOrgEntry>();
    for (const entry of entries) {
      if (entry.orgId && !map.has(entry.orgId)) {
        map.set(entry.orgId, entry);
      }
    }
    return Array.from(map.values());
  }

  private mapToSalesforceOrg(entry: SfdxOrgEntry): SfdxImportResult {
    const orgType = entry.isScratchOrg
      ? ('Scratch' as const)
      : entry.isSandbox
        ? ('Sandbox' as const)
        : ('Production' as const);

    // Production orgs are critical; sandboxes may hold production-shaped data
    // so they sit one tier above scratch orgs (medium vs low).
    const safetyTier =
      orgType === 'Production'
        ? OrgSafetyTier.CRITICAL
        : orgType === 'Sandbox'
          ? OrgSafetyTier.MEDIUM
          : OrgSafetyTier.LOW;

    const org: SalesforceOrg = {
      id: entry.orgId,
      alias: entry.alias || entry.username,
      username: entry.username,
      instanceUrl: entry.instanceUrl,
      orgId: entry.orgId,
      orgType,
      authMethod: 'sfdx_import',
      safetyTier,
      appearance: {
        color: orgType === 'Production' ? '#e74c3c' : '#4a9eff',
        icon: 'cloud',
        position: 0,
      },
      metadata: {
        apiVersion: entry.instanceApiVersion ?? SF_LIMITS.DEFAULT_API_VERSION,
        edition: entry.name ?? '',
        features: [],
      },
      status: 'connected',
      lastConnected: new Date().toISOString(),
      tags: [],
    };

    const credentials: ConnectionConfig = {
      loginUrl: entry.instanceUrl,
      accessToken: entry.accessToken,
      instanceUrl: entry.instanceUrl,
      username: entry.username,
    };

    return { org, credentials };
  }
}
