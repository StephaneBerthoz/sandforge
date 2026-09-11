import type { Connection } from 'jsforce';
import type { UUID } from '@sandforge/shared';
import { SF_LIMITS } from '@sandforge/shared';
import type { OrgRegistry } from './OrgRegistry';
import type { OrgManager } from './OrgManager';
import { ConnectionPool } from './ConnectionPool';
import { CircuitBreaker } from './CircuitBreaker';
import { extractErrorMessage } from '../common/extractErrorMessage.js';
import { isAuthError } from '../common/isAuthError.js';

const MAX_BUFFER = 10 * 1024 * 1024;

/** Module-level singleton connection pool */
const connectionPool = new ConnectionPool();

/**
 * Max age of a pooled connection before its access token must be re-validated.
 *
 * A pool hit used to be handed back blind for the whole VS Code session: once
 * the org's token expired mid-session, every subsequent call rebuilt a
 * Connection around the same dead token, the org stayed unusable until the
 * window was reloaded, and nothing told the user why. Re-validating on every
 * call would cost an identity() round-trip per request, so pooled entries
 * simply age out instead: past this window the next call falls through to the
 * normal identity() + CLI-refresh path, which replaces the pooled entry (and
 * the vault token) exactly like a cold connection.
 */
const POOL_REVALIDATE_AFTER_MS = 5 * 60 * 1000;

/**
 * Epoch ms of the last successful identity() validation, per orgId.
 *
 * Kept here rather than on the pooled entry because `ConnectionPool.acquire()`
 * preserves `createdAt` when it refreshes an existing entry — reusing it would
 * mark the connection permanently stale and re-validate on every call.
 */
const lastValidatedAt = new Map<string, number>();

/** Circuit breaker config — identical for every org. */
const BREAKER_CONFIG = {
  failureThreshold: 3,
  resetTimeout: 30_000,
} as const;

/**
 * Per-org circuit breakers for identity validation calls, keyed by orgId.
 * A shared singleton let one failing org block connections to every other
 * org; per-org instances isolate the blast radius.
 */
const circuitBreakers = new Map<string, CircuitBreaker>();

/** Get the singleton ConnectionPool instance (for testing/monitoring) */
export function getConnectionPool(): ConnectionPool {
  return connectionPool;
}

/**
 * Get the CircuitBreaker for a given org, creating it on first access
 * (for testing/monitoring).
 */
export function getCircuitBreaker(orgId: string): CircuitBreaker {
  let breaker = circuitBreakers.get(orgId);
  if (!breaker) {
    breaker = new CircuitBreaker({ ...BREAKER_CONFIG });
    circuitBreakers.set(orgId, breaker);
  }
  return breaker;
}

/** Forget every recorded validation timestamp (for testing). */
export function resetConnectionValidation(): void {
  lastValidatedAt.clear();
}

/** Reset and drop all per-org breakers (for testing). */
export function resetCircuitBreakers(): void {
  for (const breaker of circuitBreakers.values()) {
    breaker.reset();
  }
  circuitBreakers.clear();
}

/** Fresh credentials as currently known by the SF CLI. */
interface CliCredentials {
  accessToken: string;
  /** Present when the CLI reports one (always in practice) — may differ from the stored URL. */
  instanceUrl?: string;
}

/**
 * Refresh credentials via the SF CLI.
 *
 * Token source: `sf org auth show-access-token` — the ONLY CLI command that
 * guarantees a live token (it refreshes through the stored OAuth session when
 * the cached one is expired). `sf org display` merely dumps the stored
 * accessToken as-is: proven on a live org (2026-08, CLI 2.146) that a
 * "Connected" org's display token can be rejected with HTTP 403 while
 * show-access-token's token is accepted — that difference is what Org
 * Browser gets right and this extension previously got wrong.
 *
 * URL source: `sf org display` (its instanceUrl is the org's CURRENT
 * instance — after a sandbox refresh or My Domain change the stored URL
 * points at the wrong instance and even a fresh token is rejected there).
 *
 * Falls back to the legacy display-token behavior on CLIs too old to have
 * `org auth show-access-token`. Throws when no usable session exists.
 */
async function refreshTokenViaCli(username: string): Promise<CliCredentials> {
  // Validate username (defense in depth — argv-as-array on POSIX makes
  // shell-injection moot, but the regex still catches obviously malformed
  // input early and is the only defense on the Windows shell branch below).
  if (!/^[\w.@+-]+$/.test(username)) {
    throw new Error(`Invalid username format: "${username}"`);
  }
  const { execFile, exec } = await import('child_process');
  const { promisify } = await import('util');
  const opts = {
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
    env: { ...process.env, NO_COLOR: '1' },
  } as const;

  // POSIX: argv-as-array via execFile — no shell, no interpolation.
  // Windows: `sf` resolves to `sf.cmd` which requires shell-based PATHEXT
  // resolution, so keep exec there; the regex above is the injection defense.
  const run = (argsDisplay: string, argsArray: string[]): Promise<{ stdout: string }> =>
    process.platform === 'win32'
      ? (promisify(exec)(argsDisplay, opts) as Promise<{ stdout: string }>)
      : (promisify(execFile)('sf', argsArray, opts) as Promise<{ stdout: string }>);

  const parseResult = (stdout: string, cmdLabel: string): Record<string, unknown> => {
    // eslint-disable-next-line no-control-regex -- Intentional ANSI escape stripping
    const stripped = stdout.replace(/\[[0-9;]*m/g, '');
    const start = stripped.search(/[{[]/);
    if (start === -1) {
      throw new Error(
        `Failed to parse "${cmdLabel}" output: no JSON found. Ensure Salesforce CLI (sf) is installed and the org is authenticated.`,
      );
    }
    const parsed = JSON.parse(stripped.slice(start)) as { result?: Record<string, unknown> };
    return parsed.result ?? {};
  };

  // The org's current instance URL (local store read — token field ignored).
  let instanceUrl: string | undefined;
  try {
    const { stdout } = await run(`sf org display -u "${username}" --json`, [
      'org',
      'display',
      '-u',
      username,
      '--json',
    ]);
    const result = parseResult(stdout, 'sf org display');
    instanceUrl = typeof result.instanceUrl === 'string' ? result.instanceUrl : undefined;
  } catch {
    // Non-fatal: the stored URL stays as fallback.
    instanceUrl = undefined;
  }

  // The live token. Preferred: show-access-token (refreshing). Legacy
  // fallback for old CLIs: display's stored token (may be stale — the
  // identity() revalidation in the caller is the safety net either way).
  try {
    const { stdout } = await run(`sf org auth show-access-token -o "${username}" --json`, [
      'org',
      'auth',
      'show-access-token',
      '-o',
      username,
      '--json',
    ]);
    const result = parseResult(stdout, 'sf org auth show-access-token');
    if (typeof result.accessToken === 'string' && result.accessToken) {
      return { accessToken: result.accessToken, instanceUrl };
    }
  } catch {
    // Older CLI without `org auth show-access-token` — fall through to legacy.
  }

  const { stdout } = await run(`sf org display -u "${username}" --json`, [
    'org',
    'display',
    '-u',
    username,
    '--json',
  ]);
  const legacy = parseResult(stdout, 'sf org display');
  if (typeof legacy.accessToken !== 'string' || !legacy.accessToken) {
    throw new Error(
      'No accessToken returned by "sf org display". The org session may have expired — try re-authenticating with "sf org login".',
    );
  }
  if (!instanceUrl && typeof legacy.instanceUrl === 'string') {
    instanceUrl = legacy.instanceUrl;
  }
  return { accessToken: legacy.accessToken, instanceUrl };
}

/**
 * Create a jsforce Connection for a given org.
 *
 * 1. Reads credentials from OrgRegistry (SecretVault)
 * 2. Builds a jsforce.Connection and validates it with a lightweight identity() call
 * 3. On an authentication error (INVALID_SESSION_ID, INVALID_AUTH_HEADER,
 *    SESSION_EXPIRED, or HTTP 401), attempts ONE token refresh via the SF CLI,
 *    persists the new token to SecretVault, and re-validates the rebuilt
 *    connection ONCE
 * 4. Propagates an actionable error when recovery fails
 *
 * Circuit breaker accounting: an auth failure recovered by the refresh is NOT
 * recorded as a failure (an expired token is not an infrastructure problem);
 * a failed refresh or failed retry IS recorded.
 *
 * Recovery scope / documented limit: authentication is recovered at connection
 * *establishment* only. A token that expires mid-operation — after this
 * function has returned its Connection — surfaces to the caller as the raw
 * jsforce error. Request-level retry would require wrapping every jsforce
 * entry point used by handlers and was rejected as too invasive. Pool hits
 * still skip the identity() call, but only for POOL_REVALIDATE_AFTER_MS after
 * the last successful validation: past that the pooled entry is treated as
 * expired and goes through validation and refresh again, so an expired session
 * heals on its own instead of lasting until the window is reloaded.
 */
export async function getJsforceConnection(
  orgId: string,
  orgRegistry: OrgRegistry,
  orgManager: OrgManager,
): Promise<Connection> {
  // Lazy boundary: keeps jsforce and its 107-package cluster out of the
  // activation path. See jsforceEntry.ts for why the named export matters.
  const { jsforce } = await import('./jsforceEntry.js');

  const uid = orgId as UUID;

  const org = orgManager.getOrg(orgId);
  if (!org) {
    throw new Error(`Org not found: ${orgId}`);
  }

  const credentials = await orgRegistry.getCredentials(orgId);
  if (!credentials?.accessToken || !credentials.instanceUrl) {
    throw new Error(`No credentials for org "${org.alias}" (${orgId}). Reconnect the org.`);
  }

  const apiVersion = org.metadata.apiVersion || SF_LIMITS.DEFAULT_API_VERSION;

  // Check the pool for an existing connection with a matching token. The entry
  // is trusted only while its last identity() validation is recent: past
  // POOL_REVALIDATE_AFTER_MS it counts as expired and is rebuilt below.
  const pooled = connectionPool.get(uid);
  const pooledIsFresh = Date.now() - (lastValidatedAt.get(orgId) ?? 0) < POOL_REVALIDATE_AFTER_MS;
  if (pooled && pooled.active && pooled.accessToken === credentials.accessToken && pooledIsFresh) {
    pooled.lastUsedAt = Date.now();
    return new jsforce.Connection({
      instanceUrl: pooled.instanceUrl,
      accessToken: pooled.accessToken,
      version: apiVersion,
    });
  }

  const conn = new jsforce.Connection({
    instanceUrl: credentials.instanceUrl,
    accessToken: credentials.accessToken,
    version: apiVersion,
  });

  // Check this org's circuit breaker before attempting validation
  const circuitBreaker = getCircuitBreaker(orgId);
  if (!circuitBreaker.acquirePermit()) {
    throw new Error(
      `Circuit breaker is open for org "${org.alias}". ` +
        `Too many recent failures — retries paused. Try again shortly.`,
    );
  }

  // Validate with a lightweight call, wrapped by the circuit breaker
  const start = Date.now();
  try {
    await conn.identity();
    const latency = Date.now() - start;
    circuitBreaker.recordSuccess();
    connectionPool.acquire(uid, credentials.instanceUrl, credentials.accessToken);
    connectionPool.recordLatency(uid, latency);
    lastValidatedAt.set(orgId, Date.now());
    return conn;
  } catch (err: unknown) {
    const latency = Date.now() - start;
    connectionPool.remove(uid);
    lastValidatedAt.delete(orgId);

    // Authentication failure (expired/revoked token): attempt ONE token
    // refresh via the SF CLI, then re-validate the rebuilt connection ONCE.
    if (isAuthError(err)) {
      try {
        const fresh = await refreshTokenViaCli(org.username);

        // The CLI's current instance URL wins over the stored one: after a
        // sandbox refresh or My Domain change, the vault URL points at the
        // wrong instance and even a fresh token is rejected there with
        // INVALID_AUTH_HEADER.
        const instanceUrl = fresh.instanceUrl ?? credentials.instanceUrl;

        // The CLI handed back the exact token that just failed on the SAME
        // instance — its store is stale too (no usable refresh token, e.g. a
        // strict Connected App policy). Retrying would fail identically, and
        // persisting it would overwrite the vault with a known-bad token:
        // bail out now with a precise cause instead.
        if (
          fresh.accessToken === credentials.accessToken &&
          instanceUrl === credentials.instanceUrl
        ) {
          throw new Error(
            'sf CLI token store is stale too (same expired token) — re-authenticate the org',
          );
        }

        const refreshedConn = new jsforce.Connection({
          instanceUrl,
          accessToken: fresh.accessToken,
          version: apiVersion,
        });
        await refreshedConn.identity();

        // Persist only AFTER the new credentials have been validated — a CLI
        // token rejected by identity() must never reach the vault.
        await orgRegistry.saveOrg(org, {
          ...credentials,
          accessToken: fresh.accessToken,
          instanceUrl,
        });

        // Recovered: an expired token is not an infrastructure failure, so
        // it must not count towards the circuit breaker threshold.
        circuitBreaker.recordSuccess();
        connectionPool.acquire(uid, instanceUrl, fresh.accessToken);
        connectionPool.recordLatency(uid, latency);
        lastValidatedAt.set(orgId, Date.now());
        return refreshedConn;
      } catch (recoveryErr: unknown) {
        // Refresh failed or the new token was rejected too: this DOES count
        // as a breaker failure, and the user gets an actionable message.
        circuitBreaker.recordFailure();
        const cause = extractErrorMessage(recoveryErr);
        throw new Error(
          `Authentication expired for org "${org.alias}". ` +
            `Reconnect it from the Orgs page (SFDX import) or run: sf org login web --alias ${org.alias}. ` +
            `(cause: ${cause})`,
        );
      }
    }

    circuitBreaker.recordFailure();
    const message = extractErrorMessage(err);
    throw new Error(`Connection failed for "${org.alias}": ${message}`);
  } finally {
    // Always release the half-open permit, on every success/failure/refresh
    // path. Without this a failure in half-open leaves halfOpenInFlight stuck
    // at 1 and canExecute() never returns true again — a total connection
    // lockout for the org until the extension host restarts.
    circuitBreaker.releasePermit();
  }
}
