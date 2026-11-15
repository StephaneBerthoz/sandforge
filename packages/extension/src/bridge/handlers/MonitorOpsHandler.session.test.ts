import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SalesforceOrg, UUID } from '@sandforge/shared';
import { OrgSafetyTier } from '@sandforge/shared';
import type { ExternalBrowserAdapter } from '../../adapters/browser/ExternalBrowserAdapter.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { SecretVault } from '../../core/storage/SecretVault.js';
import { OrgManager } from '../../core/connection/OrgManager.js';
import { OrgRegistry } from '../../core/connection/OrgRegistry.js';
import {
  getConnectionPool,
  renewSessionsFrom,
  resetCircuitBreakers,
  resetConnectionValidation,
} from '../../core/connection/ConnectionHelper.js';
import { proxiedConnection } from '../../core/connection/proxiedConnection.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import type { HandlerDeps } from './HandlerTypes.js';
import { MonitorOpsHandler } from './MonitorOpsHandler.js';

/*
 * A pipeline's Pre-check read through the extension's own connections, past
 * the end of the org's session: the registry's token, the identity check of
 * a new connection, the token the Salesforce CLI renews, and the vault that
 * keeps it. Only the org and `sf` are stood in for.
 *
 * Its first try at a Developer Edition whose sessions last 2 h, past a Delay
 * of 2 h 05, lost the API usage as "Unable to fetch limits" while the
 * storage, read next, went through on the session the CLI had renewed
 * meanwhile: one sign-in in the org's login history, a step of 6.7 s. What
 * failed first was written nowhere; a Delay that had lasted 330 s past its
 * 7 500 says the host may have slept, and a host just woken loses its first
 * request before the org sees it.
 */

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../core/connection/proxiedConnection.js', () => ({ proxiedConnection: vi.fn() }));

/** What `sf` answers, by its arguments: set by the org below. */
const sf = vi.hoisted(() => ({
  answer: (_args: readonly string[]): Promise<string> => Promise.reject(new Error('no sf')),
}));

vi.mock('child_process', async (original) => {
  const actual = await original<typeof import('child_process')>();
  const { promisify } = await import('util');
  // POSIX: `execFile`, promisified. Windows: `exec` in its callback form,
  // the command line split back into its words.
  const execFile = Object.assign(
    (...args: Parameters<typeof actual.execFile>) => actual.execFile(...args),
    {
      [promisify.custom]: (file: string, args: readonly string[]) =>
        file === 'sf'
          ? sf.answer(args).then((stdout) => ({ stdout, stderr: '' }))
          : Promise.reject(new Error(`no ${file} here`)),
    },
  );
  const exec = (
    command: string,
    _options: unknown,
    callback: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    const words = command.split(' ').map((word) => word.replace(/^"|"$/g, ''));
    sf.answer(words.slice(1)).then(
      (stdout) => callback(null, stdout, ''),
      (err: Error) => callback(err, '', ''),
    );
    return { pid: 4242 };
  };
  return { ...actual, execFile, exec };
});

const ORG_ID = '00D000000000001AAA';
const USERNAME = 'admin@example.com';
const INSTANCE = 'https://example.my.salesforce.com';

/** The org at the far end: the tokens it takes, and what `sf` holds for it. */
class SessionOrg {
  /** The tokens the org takes. The one the registry holds has expired. */
  readonly live = new Set<string>();
  /** The token `sf` keeps for the org. */
  cliToken = 'expired-token';
  /** Whether `sf` can renew the session: its refresh token is still good. */
  renewable = true;
  /** The sign-ins `sf` made to renew it, as the org's login history lists them. */
  logins = 0;
  /** Requests the network loses before the org sees them: the first after the host woke. */
  lost = 0;
  /** The `/limits` reads the org answered. */
  limitsRead = 0;

  constructor() {
    vi.mocked(proxiedConnection).mockImplementation(
      async (config) => this.connection(String(config.accessToken)) as never,
    );
    sf.answer = (args) => this.sf(args);
  }

  /** The org's answer to a request on `token`, or its refusal. */
  private reach(token: string): void {
    if (this.lost > 0) {
      this.lost -= 1;
      throw new Error(
        `request to ${INSTANCE}/services/data/v62.0 failed, reason: getaddrinfo EAI_AGAIN ` +
          'example.my.salesforce.com',
      );
    }
    if (!this.live.has(token)) {
      throw Object.assign(new Error('Session expired or invalid'), {
        errorCode: 'INVALID_SESSION_ID',
      });
    }
  }

  private connection(token: string): unknown {
    return {
      accessToken: token,
      limitInfo: undefined,
      identity: async () => {
        this.reach(token);
        return { organization_id: ORG_ID, user_id: '005000000000001AAA' };
      },
      request: async (url: string) => {
        this.reach(token);
        if (!url.endsWith('/limits')) throw new Error(`The org answers no request to ${url}`);
        this.limitsRead += 1;
        return {
          DailyApiRequests: { Max: 15_000, Remaining: 10_800 },
          DataStorageMB: { Max: 5, Remaining: 5 },
        };
      },
    };
  }

  /** `sf org display` and `sf org auth show-access-token`, as the CLI 2.15x answers them. */
  private async sf(args: readonly string[]): Promise<string> {
    const [, verb, sub] = args;
    if (verb === 'display') {
      return JSON.stringify({
        status: 0,
        result: {
          instanceUrl: INSTANCE,
          accessToken: "[REDACTED] Use 'sf org auth show-access-token' to view",
        },
      });
    }
    if (verb === 'auth' && sub === 'show-access-token') {
      if (!this.live.has(this.cliToken)) {
        if (!this.renewable) {
          throw new Error(
            'Command failed: sf org auth show-access-token: Error authenticating with the refresh ' +
              'token due to: expired access/refresh token',
          );
        }
        this.cliToken = 'renewed-token';
        this.live.add(this.cliToken);
        this.logins += 1;
      }
      return JSON.stringify({ status: 0, result: { accessToken: this.cliToken } });
    }
    throw new Error(`sf ${args.join(' ')} is not stood in for`);
  }
}

/** The registered org, as connecting it in the extension registers it. */
const ORG: SalesforceOrg = {
  id: ORG_ID,
  alias: 'DEVED',
  username: USERNAME,
  instanceUrl: INSTANCE,
  orgId: ORG_ID,
  orgType: 'Developer',
  authMethod: 'sfdx_import',
  safetyTier: OrgSafetyTier.LOW,
  appearance: { color: '#4a9eff', icon: 'cloud', position: 0 },
  metadata: { apiVersion: '62.0', edition: 'Developer Edition', features: [] },
  status: 'connected',
  lastConnected: '2026-11-15T00:35:21.000Z',
  tags: [],
};

/** A handler over the extension's registry, the org in it with the token it was connected with. */
async function handlerOf(): Promise<{ handler: MonitorOpsHandler; registry: OrgRegistry }> {
  const configStore = new ConfigStore(new InMemoryConfigStoreBackend());
  configStore.initialize();
  const secrets = new Map<string, string>();
  const vault = new SecretVault({
    get: async (key) => secrets.get(key),
    store: async (key, value) => {
      secrets.set(key, value);
    },
    delete: async (key) => {
      secrets.delete(key);
    },
  });
  const orgManager = new OrgManager();
  const registry = new OrgRegistry(configStore, vault, orgManager);
  await registry.saveOrg(ORG, {
    loginUrl: INSTANCE,
    instanceUrl: INSTANCE,
    accessToken: 'expired-token',
    username: USERNAME,
  });
  const deps = {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() },
    stateSync: {},
    orgManager,
    orgRegistry: registry,
    configStore,
    secretVault: vault,
    authProvider: {},
    sfdxBridge: {},
    nextId: () => 'id',
  } as unknown as HandlerDeps;
  return { handler: new MonitorOpsHandler(deps, {} as ExternalBrowserAdapter), registry };
}

beforeEach(() => {
  getConnectionPool().remove(ORG_ID as UUID);
  resetConnectionValidation();
  resetCircuitBreakers();
});
afterEach(() => {
  renewSessionsFrom('panel');
});

describe("a Pre-check's reading past the end of the org's session", () => {
  it('reads the API usage and the storage on the session the CLI renews when the org refuses the old one', async () => {
    const org = new SessionOrg();
    const { handler, registry } = await handlerOf();

    const signals = await handler.readOrgHealth(ORG_ID, ['apiLimits', 'storage']);

    expect(signals.map((signal) => [signal.name, signal.status, signal.message])).toEqual([
      ['apiLimits', 'ok', 'API usage at 28%'],
      ['storage', 'ok', 'Storage usage at 0%'],
    ]);
    expect(org.logins).toBe(1);
    expect((await registry.getCredentials(ORG_ID))?.accessToken).toBe('renewed-token');
  });

  it('reads both when the first request does not reach the org and the next meets the expired session', async () => {
    const org = new SessionOrg();
    org.lost = 1;
    const { handler } = await handlerOf();

    const signals = await handler.readOrgHealth(ORG_ID, ['apiLimits', 'storage']);

    expect(signals.map((signal) => [signal.name, signal.status, signal.message])).toEqual([
      ['apiLimits', 'ok', 'API usage at 28%'],
      ['storage', 'ok', 'Storage usage at 0%'],
    ]);
    // One sign-in, as the org's history listed, and `/limits` read once.
    expect(org.logins).toBe(1);
    expect(org.limitsRead).toBe(1);
  });

  it('reads again on a connection checked anew when the org ends a session the pool still holds', async () => {
    const org = new SessionOrg();
    org.live.add('expired-token');
    const { handler } = await handlerOf();
    // Read once: the connection is checked and pooled, its token taken.
    await handler.readOrgHealth(ORG_ID, ['apiLimits']);
    // The org ends the session minutes later; the pool still trusts it.
    org.live.delete('expired-token');
    handler.forgetOrg(ORG_ID);

    const [apiLimits] = await handler.readOrgHealth(ORG_ID, ['apiLimits']);

    expect(apiLimits).toMatchObject({ status: 'ok', message: 'API usage at 28%' });
    expect(org.logins).toBe(1);
  });

  it('says the session expired and could not be renewed, and how to sign in again, when the CLI cannot renew it', async () => {
    renewSessionsFrom('command line');
    const org = new SessionOrg();
    org.renewable = false;
    const { handler } = await handlerOf();

    const [apiLimits, storage] = await handler.readOrgHealth(ORG_ID, ['apiLimits', 'storage']);

    for (const signal of [apiLimits, storage]) {
      expect(signal?.status).toBe('unknown');
      expect(signal?.message).toContain(
        'ORG_AUTH_EXPIRED: The session with "DEVED" has expired and could not be renewed. Sign in ' +
          'to it again with "sf org login web --alias DEVED"',
      );
    }
    expect(apiLimits?.message).toMatch(/^Unable to fetch limits: /);
    expect(storage?.message).toMatch(/^Unable to fetch storage: /);
    expect(org.logins).toBe(0);
  });
});
