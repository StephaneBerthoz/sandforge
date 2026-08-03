import jsforce, { type Connection } from 'jsforce';
import type { UUID } from '@sandforge/shared';
import type { OrgRegistry } from './OrgRegistry';
import type { OrgManager } from './OrgManager';
import { ConnectionPool } from './ConnectionPool';
import { CircuitBreaker } from './CircuitBreaker';
import { extractErrorMessage } from '../common/extractErrorMessage.js';

const MAX_BUFFER = 10 * 1024 * 1024;

/** Module-level singleton connection pool */
const connectionPool = new ConnectionPool();

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

/** Reset and drop all per-org breakers (for testing). */
export function resetCircuitBreakers(): void {
  for (const breaker of circuitBreakers.values()) {
    breaker.reset();
  }
  circuitBreakers.clear();
}

/**
 * Refresh an access token by querying the SF CLI for the latest org display info.
 * Returns the new accessToken or throws.
 */
async function refreshTokenViaCli(username: string): Promise<string> {
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

  // POSIX: pass argv as array to execFile — no shell, no interpolation, the
  // username could contain anything safely. Audit RT-#8 hardening.
  // Windows: `sf` resolves to `sf.cmd` which requires shell-based PATHEXT
  // resolution, so keep exec there. The regex on `username` above is the
  // shell-injection defense for that branch (allowed chars: word, dot, @,
  // plus, dash — all shell-safe inside double quotes).
  const { stdout } =
    process.platform === 'win32'
      ? await promisify(exec)(`sf org display -u "${username}" --json`, opts)
      : await promisify(execFile)('sf', ['org', 'display', '-u', username, '--json'], opts);

  // eslint-disable-next-line no-control-regex -- Intentional ANSI escape code stripping
  const stripped = stdout.replace(/\u001b\[[0-9;]*m/g, '');
  const start = stripped.search(/[{[]/);
  if (start === -1) {
    throw new Error(
      'Failed to parse "sf org display" output: no JSON found. Ensure Salesforce CLI (sf) is installed and the org is authenticated.',
    );
  }

  const parsed = JSON.parse(stripped.slice(start)) as {
    result?: { accessToken?: string };
  };

  if (!parsed.result?.accessToken) {
    throw new Error(
      'No accessToken returned by "sf org display". The org session may have expired — try re-authenticating with "sf org login".',
    );
  }

  return parsed.result.accessToken;
}

/**
 * Create a jsforce Connection for a given org.
 *
 * 1. Reads credentials from OrgRegistry (SecretVault)
 * 2. Builds a jsforce.Connection
 * 3. On INVALID_SESSION_ID, attempts token refresh via SF CLI
 * 4. Persists the refreshed token back to SecretVault
 */
export async function getJsforceConnection(
  orgId: string,
  orgRegistry: OrgRegistry,
  orgManager: OrgManager,
): Promise<Connection> {
  const uid = orgId as UUID;

  const org = orgManager.getOrg(orgId);
  if (!org) {
    throw new Error(`Org not found: ${orgId}`);
  }

  const credentials = await orgRegistry.getCredentials(orgId);
  if (!credentials?.accessToken || !credentials.instanceUrl) {
    throw new Error(`No credentials for org "${org.alias}" (${orgId}). Reconnect the org.`);
  }

  const apiVersion = org.metadata.apiVersion || '62.0';

  // Check the pool for an existing connection with a matching token
  const pooled = connectionPool.get(uid);
  if (pooled && pooled.active && pooled.accessToken === credentials.accessToken) {
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
    return conn;
  } catch (err: unknown) {
    const latency = Date.now() - start;
    circuitBreaker.recordFailure();
    connectionPool.remove(uid);
    const message = extractErrorMessage(err);

    // Token expired — try refreshing via SF CLI
    if (message.includes('INVALID_SESSION_ID') || message.includes('Session expired')) {
      try {
        const newToken = await refreshTokenViaCli(org.username);

        // Persist refreshed token
        await orgRegistry.saveOrg(org, {
          ...credentials,
          accessToken: newToken,
        });

        const refreshedConn = new jsforce.Connection({
          instanceUrl: credentials.instanceUrl,
          accessToken: newToken,
          version: apiVersion,
        });

        // Record the refreshed connection in the pool
        connectionPool.acquire(uid, credentials.instanceUrl, newToken);
        connectionPool.recordLatency(uid, latency);

        return refreshedConn;
      } catch (refreshErr: unknown) {
        connectionPool.remove(uid);
        const refreshMsg = extractErrorMessage(refreshErr);
        throw new Error(
          `Token expired for "${org.alias}" and refresh failed: ${refreshMsg}. ` +
            'Try disconnecting and re-importing the org.',
        );
      }
    }

    throw new Error(`Connection failed for "${org.alias}": ${message}`);
  } finally {
    // Always release the half-open permit, on every success/failure/refresh
    // path. Without this a failure in half-open leaves halfOpenInFlight stuck
    // at 1 and canExecute() never returns true again — a total connection
    // lockout for the org until the extension host restarts.
    circuitBreaker.releasePermit();
  }
}
