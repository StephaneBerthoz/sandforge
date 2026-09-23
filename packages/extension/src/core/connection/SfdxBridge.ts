import type { SalesforceOrg, ConnectionConfig } from '@sandforge/shared';
import { OrgSafetyTier, SF_LIMITS } from '@sandforge/shared';
import { z } from 'zod';
import { parseSalesforceLoginUrl } from '../common/salesforceLoginHost.js';

const MAX_BUFFER = 10 * 1024 * 1024; // 10 MB

/**
 * Longest `sf org login jwt` or `sf org login sfdx-url` may run: a CLI start,
 * one token request, an identity call and the auth file written.
 */
const CLI_LOGIN_TIMEOUT_MS = 60_000;

/**
 * How long past its own timeout a login run may keep the caller waiting. On
 * Windows the timeout kills only the shell `exec` starts, and sf's node child
 * can keep the output pipe open after it; past this the run is abandoned and
 * its process tree killed (the same bound ConnectionHelper puts on sf reads).
 */
const CLI_LOGIN_GRACE_MS = 2_000;

/**
 * Characters `cmd.exe` still acts on inside double quotes: the quote ends the
 * argument, `%` and `!` expand variables, and control characters end the line.
 * None but `%` and `!` can appear in a Windows file name, and those two rarely do.
 */
// eslint-disable-next-line no-control-regex -- control characters are what this refuses
const CMD_UNSAFE = /["%!\u0000-\u001f\u007f]/;

/**
 * The shape the CLI accepts for the client id and the refresh token of an
 * SFDX authorization URL (`AuthInfo.parseSfdxAuthUrl` in @salesforce/core).
 */
const SFDX_AUTH_URL_PART = /^[A-Za-z0-9._-]+={0,2}$/;

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
 * Mirrors the pattern used by ConnectionHelper.refreshTokenViaCli:
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

/** Why an `sf` run failed: a non-zero exit, a timeout (`killed`), or a process that never started. */
interface SfFailure {
  message: string;
  killed?: boolean;
}

/** What one `sf` run produced. `failure` is set when it did not succeed. */
interface SfRun {
  stdout: string;
  stderr: string;
  failure?: SfFailure;
}

/**
 * Quote one argument for the `cmd.exe` command line `exec` builds on Windows.
 *
 * @throws When the value holds a character cmd.exe would act on even inside
 *   double quotes; the message names the value's role, never the value.
 */
function quoteForCmd(arg: string, role: string): string {
  if (CMD_UNSAFE.test(arg)) {
    throw new Error(
      `The ${role} cannot contain ", %, ! or control characters on Windows: the command prompt that runs sf would act on them.`,
    );
  }
  return `"${arg}"`;
}

/**
 * Run `sf` with `args`, writing `input` to its stdin, and settle with what it
 * printed — even when it exits non-zero: with `--json` the CLI's error is a
 * JSON document on stdout, and its message is what the user should read.
 *
 * POSIX: `execFile` with argv. No shell is involved, so a key file path with
 * spaces, quotes or `$(…)` in it reaches the CLI as one untouched argument.
 *
 * Windows: `sf` is `sf.cmd`, and Node refuses to start a `.cmd` without a
 * shell (CVE-2024-27980), so the command goes through `cmd.exe` as `exec`
 * builds it — the one place a command line is written, as loginWeb and
 * ConnectionHelper already do. Every argument is double-quoted after the
 * characters cmd.exe would still act on are refused (see {@link CMD_UNSAFE}).
 *
 * stdin is always ended: nothing the CLI might prompt for can hold the run
 * open. `input` is how a secret reaches the CLI without ever appearing on a
 * command line, where any process on the machine can read it.
 *
 * @param args - The arguments after `sf`, each with a role for the Windows error message.
 */
async function runSf(
  args: ReadonlyArray<{ value: string; role: string }>,
  options: { timeoutMs: number; input?: string },
): Promise<SfRun> {
  const { exec, execFile } = await import('child_process');
  return new Promise<SfRun>((resolve) => {
    const execOptions = {
      encoding: 'utf8' as const,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
      timeout: options.timeoutMs,
      env: { ...process.env, NO_COLOR: '1' },
    };
    const deadline: { timer?: ReturnType<typeof setTimeout> } = {};
    let settled = false;
    const settle = (run: SfRun): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline.timer);
      resolve(run);
    };
    const done = (error: SfFailure | null, stdout: string, stderr: string): void => {
      settle({
        stdout: String(stdout),
        stderr: String(stderr),
        ...(error ? { failure: { message: error.message, killed: error.killed } } : {}),
      });
    };

    const child =
      process.platform === 'win32'
        ? exec(
            ['sf', ...args.map((arg) => quoteForCmd(arg.value, arg.role))].join(' '),
            execOptions,
            done,
          )
        : execFile(
            'sf',
            args.map((arg) => arg.value),
            execOptions,
            done,
          );

    deadline.timer = setTimeout(() => {
      settle({
        stdout: '',
        stderr: '',
        failure: {
          message: `sf did not finish within ${Math.round(options.timeoutMs / 1000)} s`,
          killed: true,
        },
      });
      if (process.platform === 'win32' && child.pid !== undefined) {
        execFile(
          'taskkill',
          ['/pid', String(child.pid), '/T', '/F'],
          { windowsHide: true },
          () => undefined,
        );
      }
    }, options.timeoutMs + CLI_LOGIN_GRACE_MS);

    // A CLI that exits before reading its input closes the pipe; the write
    // then fails with EPIPE, which must not surface as an uncaught error. A
    // writable stream emits 'error' at most once, so one listener is enough.
    child.stdin?.once('error', () => undefined);
    child.stdin?.end(options.input ?? '');
  });
}

/** The `--json` document every sf command prints, on success and on failure alike. */
const cliJsonSchema = z
  .object({
    status: z.number().optional(),
    result: z.unknown().optional(),
    message: z.string().optional(),
  })
  .passthrough();

/** The fields of a login result SandForge reads; the (redacted) token is not one of them. */
const cliLoginResultSchema = z
  .object({
    username: z.string().min(1),
    orgId: z.string().min(1),
    instanceUrl: z.string().min(1),
  })
  .passthrough();

/**
 * The org a `sf org login … --json` run authorized, or its failure as the CLI
 * worded it.
 *
 * stdout is read for three fields and never logged or quoted: with
 * `SF_TEMP_SHOW_SECRETS` set, the CLI prints the org's live access token in it.
 *
 * @param command - The command, for messages (`sf org login jwt`).
 */
function readLogin(run: SfRun, command: string): CliLogin {
  let document: z.infer<typeof cliJsonSchema> | undefined;
  try {
    const parsed = cliJsonSchema.safeParse(JSON.parse(extractJson(run.stdout)));
    if (parsed.success) document = parsed.data;
  } catch {
    document = undefined;
  }

  if (run.failure || document?.status !== 0) {
    const cliMessage = document?.message?.trim();
    if (cliMessage) throw new Error(cliMessage);
    if (run.failure?.killed) {
      throw new Error(`${command} did not finish within ${CLI_LOGIN_TIMEOUT_MS / 1000} s.`);
    }
    const firstStderrLine = run.stderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    throw new Error(
      firstStderrLine ?? run.failure?.message ?? `${command} failed without saying why.`,
    );
  }

  const login = cliLoginResultSchema.safeParse(document.result);
  if (!login.success) {
    throw new Error(`${command} succeeded but did not say which org it signed in to.`);
  }
  return {
    username: login.data.username,
    orgId: login.data.orgId,
    instanceUrl: login.data.instanceUrl,
  };
}

/**
 * Reduce a Salesforce instance URL to the origin passed to the CLI.
 *
 * This is the shell-injection defense for the Windows exec branch of loginWeb.
 * Checking the hostname alone was not enough: the path went into the command
 * string verbatim, so `https://login.salesforce.com/"&calc&"` reached cmd.exe.
 * Only the origin of an https Salesforce login host — letters, digits, dots
 * and dashes — is ever returned.
 */
function toLoginOrigin(instanceUrl: string): string {
  const parsed = parseSalesforceLoginUrl(instanceUrl);
  if (!parsed.ok) {
    throw new Error(
      `Invalid instanceUrl: "${instanceUrl}" — expected an https:// Salesforce login host with no path (${parsed.reason})`,
    );
  }
  return parsed.origin;
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

/**
 * One org entry of `sf org list --json`, as the CLI writes it.
 *
 * The flag is `isScratch`: an `isScratchOrg` key was read here that no entry
 * carries, so a scratch org was typed from `isSandbox` alone and came in as
 * Production. `orgEdition` is the edition ("Developer Edition"); `name`, read
 * as the edition before, is the org's own name.
 */
export interface SfdxOrgEntry {
  orgId: string;
  username: string;
  alias?: string;
  instanceUrl: string;
  accessToken?: string;
  /**
   * The CLI's reachability verdict. Written on the orgs it pings, not on the
   * entries of the `scratchOrgs` bucket, which carry `status` instead.
   */
  connectedStatus?: string;
  isSandbox?: boolean;
  isScratch?: boolean;
  /** Scratch entries: the Dev Hub's word on the org ("Active", "Expired"…). */
  status?: string;
  /** Scratch entries: whether the org is past its expiration date. */
  isExpired?: boolean;
  instanceApiVersion?: string;
  orgEdition?: string;
}

/**
 * Whether an entry is an org the CLI can still reach.
 *
 * A pinged org says so in `connectedStatus`. The `scratchOrgs` bucket carries
 * no such key: its entries hold the Dev Hub's `status` and an `isExpired`
 * flag, and requiring "Connected" of them dropped every scratch org from an
 * import, active ones included.
 */
function isUsable(entry: SfdxOrgEntry): boolean {
  if (entry.connectedStatus !== undefined) return entry.connectedStatus === 'Connected';
  return entry.isScratch === true && entry.status === 'Active' && entry.isExpired !== true;
}

/** Result of importing orgs from SF CLI */
export interface SfdxImportResult {
  org: SalesforceOrg;
  credentials: ConnectionConfig;
}

/** The org a CLI login authorized, as its `--json` result names it. */
export interface CliLogin {
  username: string;
  orgId: string;
  instanceUrl: string;
}

/** What `sf org login jwt` needs. */
export interface JwtLoginRequest {
  username: string;
  /** Consumer key of the app holding the certificate. */
  clientId: string;
  /**
   * Absolute path of the private key. It goes to the CLI as one argument and
   * the CLI reads the key; SandForge never opens the file.
   */
  keyFile: string;
  /** Login host the token is asked from (production, sandbox or My Domain). */
  loginUrl: string;
  alias?: string;
}

/** A session obtained outside the CLI, to be kept by it from now on. */
export interface RefreshTokenLoginRequest {
  /** Consumer key the refresh token was issued to. */
  clientId: string;
  refreshToken: string;
  /** The org's https origin. */
  instanceUrl: string;
  alias?: string;
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

  /**
   * Read the CLI's default org (`sf config get target-org --json`).
   * Returns the alias or username of the default org, or undefined when the
   * CLI is missing, no default is set, or the output can't be parsed —
   * callers must treat undefined as "no preference", never as an error.
   * The command takes no user input, so the fixed-string invocation is safe
   * on both the Windows (exec) and POSIX (execFile) branches.
   */
  async getDefaultOrgUsername(): Promise<string | undefined> {
    try {
      const { stdout } =
        process.platform === 'win32'
          ? await execAsync('sf config get target-org --json', { timeout: 15_000 })
          : await execFileAsync('sf', ['config', 'get', 'target-org', '--json'], {
              timeout: 15_000,
            });
      const parsed = JSON.parse(extractJson(stdout)) as {
        result?: Array<{ key?: string; value?: string; success?: boolean }>;
      };
      const entry = (parsed.result ?? []).find(
        (e) => (e.key === 'target-org' || e.key === 'targetusername') && e.success !== false,
      );
      return entry?.value || undefined;
    } catch {
      return undefined;
    }
  }

  /** Execute sf org list --json --no-color, parse, dedupe, and return connected orgs */
  async listOrgs(): Promise<SfdxImportResult[]> {
    const deduped = this.dedupeByOrgId(await this.readOrgEntries());
    return deduped
      .filter((entry) => isUsable(entry))
      .map((entry) => this.mapToSalesforceOrg(entry));
  }

  /**
   * The org the CLI holds for `username`, mapped as {@link listOrgs} maps it,
   * or undefined when the CLI does not list it as usable.
   *
   * Looked up before any dedupe: two users of one org share its orgId, and the
   * dedupe in listOrgs keeps whichever the CLI listed first — not necessarily
   * the user who just signed in.
   */
  async findOrg(username: string): Promise<SfdxImportResult | undefined> {
    const wanted = username.toLowerCase();
    const entry = (await this.readOrgEntries()).find(
      (candidate) => candidate.username?.toLowerCase() === wanted && isUsable(candidate),
    );
    return entry ? this.mapToSalesforceOrg(entry) : undefined;
  }

  /**
   * Sign in with the JWT bearer flow: `sf org login jwt --json`.
   *
   * The key file's path is one argv entry and nothing else: SandForge does
   * not open, read, copy or log the file. The CLI reads the key, signs the
   * token and keeps the org, signing a new token whenever the session runs out.
   *
   * @returns The org the CLI signed in to.
   * @throws With the CLI's own message when it refuses.
   */
  async loginJwt(request: JwtLoginRequest): Promise<CliLogin> {
    const args = [
      { value: 'org', role: 'command' },
      { value: 'login', role: 'command' },
      { value: 'jwt', role: 'command' },
      { value: '--username', role: 'flag' },
      { value: request.username, role: 'username' },
      { value: '--jwt-key-file', role: 'flag' },
      { value: request.keyFile, role: 'private key file path' },
      { value: '--client-id', role: 'flag' },
      { value: request.clientId, role: 'consumer key' },
      { value: '--instance-url', role: 'flag' },
      { value: toLoginOrigin(request.loginUrl), role: 'login URL' },
    ];
    if (request.alias) {
      args.push({ value: '--alias', role: 'flag' }, { value: request.alias, role: 'alias' });
    }
    args.push({ value: '--json', role: 'flag' });
    return readLogin(await runSf(args, { timeoutMs: CLI_LOGIN_TIMEOUT_MS }), 'sf org login jwt');
  }

  /**
   * Hand a session SandForge obtained itself to the CLI:
   * `sf org login sfdx-url --sfdx-url-stdin --json`, with the authorization
   * URL written to its stdin.
   *
   * The refresh token travels through the pipe only — never a command line, a
   * file or a log. From then on the CLI refreshes the session like any other
   * it holds, which is what SandForge's own token refresh relies on.
   *
   * @returns The org the CLI signed in to.
   * @throws With the CLI's own message when it refuses the session.
   */
  async loginWithRefreshToken(request: RefreshTokenLoginRequest): Promise<CliLogin> {
    // Checked here rather than left to the CLI: a character outside its
    // pattern would shift the URL's fields, and its error would not say which.
    if (!SFDX_AUTH_URL_PART.test(request.clientId)) {
      throw new Error('The consumer key holds characters the Salesforce CLI does not accept.');
    }
    if (!SFDX_AUTH_URL_PART.test(request.refreshToken)) {
      throw new Error(
        'Salesforce issued a refresh token the Salesforce CLI cannot store (unexpected characters).',
      );
    }
    const host = new URL(toLoginOrigin(request.instanceUrl)).host;
    const args = [
      { value: 'org', role: 'command' },
      { value: 'login', role: 'command' },
      { value: 'sfdx-url', role: 'command' },
    ];
    if (request.alias) {
      args.push({ value: '--alias', role: 'flag' }, { value: request.alias, role: 'alias' });
    }
    // Last, and with no value: the documented way to have the CLI read stdin.
    args.push({ value: '--json', role: 'flag' }, { value: '--sfdx-url-stdin', role: 'flag' });
    const input = `force://${request.clientId}::${request.refreshToken}@${host}\n`;
    return readLogin(
      await runSf(args, { timeoutMs: CLI_LOGIN_TIMEOUT_MS, input }),
      'sf org login sfdx-url',
    );
  }

  /** Every org entry of `sf org list --json`, from every bucket, before any dedupe. */
  private async readOrgEntries(): Promise<SfdxOrgEntry[]> {
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
    return [
      ...(parsed.result?.nonScratchOrgs ?? []),
      ...(parsed.result?.scratchOrgs ?? []),
      ...(parsed.result?.sandboxes ?? []),
      ...(parsed.result?.other ?? []),
      ...(parsed.result?.devHubs ?? []),
    ];
  }

  /** Execute sf org login web to open browser auth flow */
  async loginWeb(alias: string, instanceUrl: string): Promise<void> {
    // Validate before any shell/exec use (same pattern as
    // ConnectionHelper.refreshTokenViaCli). These checks are the only
    // shell-injection defense on the Windows exec branch below.
    if (alias && !/^[\w.-]+$/.test(alias)) {
      throw new Error(`Invalid alias format: "${alias}"`);
    }
    const origin = toLoginOrigin(instanceUrl);

    // POSIX: argv-as-array via execFile — no shell, no interpolation.
    // Windows: `sf` resolves to `sf.cmd` which requires shell-based PATHEXT
    // resolution, so keep exec there; the validated values (word/dot/dash
    // alias + the origin's host characters) are shell-safe inside double quotes.
    if (process.platform === 'win32') {
      let command = `sf org login web --instance-url "${origin}"`;
      if (alias) {
        command += ` --alias "${alias}"`;
      }
      await execAsync(command, { timeout: 120_000 });
    } else {
      const args = ['org', 'login', 'web', '--instance-url', origin];
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
    const orgType = entry.isScratch
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
        edition: entry.orgEdition ?? '',
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
