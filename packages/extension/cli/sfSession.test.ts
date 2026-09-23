import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('../src/core/connection/ConnectionHelper.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/connection/ConnectionHelper.js')>()),
  refreshTokenViaCli: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import { refreshTokenViaCli } from '../src/core/connection/ConnectionHelper.js';
import { loadOrg } from './sfSession.js';

const mockExecFileSync = vi.mocked(execFileSync);

/** What CLI 2.150 prints where `sf org display` used to print the token. */
const PLACEHOLDER = "[REDACTED] Use 'sf org auth show-access-token' to view";

/** A token of the shape Salesforce takes, and of no org. */
const LIVE_TOKEN = 'live-session-token';

/**
 * The `sf` CLI as CLI 2.150 answers: `org display` with the placeholder, and
 * `org auth show-access-token` with nothing usable, as when it fails or is
 * missing — the case the session used to fall back on display's token for.
 */
function cliHidingTheToken(): void {
  mockExecFileSync.mockImplementation(((_file: string, args: readonly string[]) => {
    if (args.includes('display')) {
      return JSON.stringify({
        result: {
          accessToken: PLACEHOLDER,
          instanceUrl: 'https://example.my.salesforce.com',
          username: 'user@example.com',
        },
      });
    }
    throw new Error('show-access-token failed');
  }) as unknown as typeof execFileSync);
}

describe('loadOrg', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cliHidingTheToken();
  });

  it('takes the token from the CLI read, never the placeholder sf org display prints', async () => {
    const readToken = vi.fn().mockResolvedValue({
      accessToken: LIVE_TOKEN,
      instanceUrl: 'https://example.my.salesforce.com',
    });

    const org = await loadOrg('TARGET-DEV', readToken);

    expect(org).toEqual({
      alias: 'TARGET-DEV',
      username: 'user@example.com',
      instanceUrl: 'https://example.my.salesforce.com',
      accessToken: LIVE_TOKEN,
    });
    expect(readToken).toHaveBeenCalledWith('TARGET-DEV');
  });

  it('fails when the CLI read fails, rather than sending the placeholder as a token', async () => {
    const readToken = vi
      .fn()
      .mockRejectedValue(new Error('Neither show-access-token nor display returned a token'));

    await expect(loadOrg('TARGET-DEV', readToken)).rejects.toThrow(/returned a token/);
  });

  it('fails when the CLI read hands back the placeholder, and says how to sign in again', async () => {
    const readToken = vi.fn().mockResolvedValue({ accessToken: PLACEHOLDER });

    await expect(loadOrg('TARGET-DEV', readToken)).rejects.toThrow(
      /no usable access token for alias 'TARGET-DEV'.*sf org login web --alias TARGET-DEV/,
    );
  });

  it('reads the token as the extension does when no reader is given', async () => {
    vi.mocked(refreshTokenViaCli).mockResolvedValue({ accessToken: LIVE_TOKEN });

    const org = await loadOrg('TARGET-DEV');

    expect(refreshTokenViaCli).toHaveBeenCalledWith('TARGET-DEV');
    expect(org.accessToken).toBe(LIVE_TOKEN);
    expect(org.instanceUrl).toBe('https://example.my.salesforce.com');
  });

  it('refuses an alias a shell could read as a command, before running anything', async () => {
    await expect(loadOrg('dev & calc', vi.fn())).rejects.toThrow(/Invalid SF org alias/);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });
});
