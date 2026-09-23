import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('../src/core/connection/ConnectionHelper.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/connection/ConnectionHelper.js')>()),
  refreshTokenViaCli: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import { refreshTokenViaCli } from '../src/core/connection/ConnectionHelper.js';
import { loadSfOrgs } from './recipe-forge-grappe.js';

/** What CLI 2.150 prints where `sf org display` used to print the token. */
const PLACEHOLDER = "[REDACTED] Use 'sf org auth show-access-token' to view";

/** A token of the shape Salesforce takes, and of no org. */
const LIVE_TOKEN = 'live-session-token';

describe('loadSfOrgs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The `sf` CLI as CLI 2.150 answers: `org display` with the placeholder
    // where the token was, and any other command failing.
    vi.mocked(execFileSync).mockImplementation(((_file: string, args: readonly string[]) => {
      if (args.includes('display')) {
        return JSON.stringify({
          result: {
            accessToken: PLACEHOLDER,
            instanceUrl: 'https://example.my.salesforce.com',
            username: 'user@example.com',
          },
        });
      }
      throw new Error('not answered');
    }) as unknown as typeof execFileSync);
    vi.mocked(refreshTokenViaCli).mockResolvedValue({
      accessToken: LIVE_TOKEN,
      instanceUrl: 'https://example.my.salesforce.com',
    });
  });

  it('gives each org the token the CLI session reads, never the placeholder sf org display prints', async () => {
    const orgs = await loadSfOrgs(['SOURCE-UAT', 'TARGET-DEV']);

    expect([...orgs.keys()]).toEqual(['SOURCE-UAT', 'TARGET-DEV']);
    expect([...orgs.values()].map((org) => org.accessToken)).toEqual([LIVE_TOKEN, LIVE_TOKEN]);
    expect(orgs.get('TARGET-DEV')?.username).toBe('user@example.com');
    expect(refreshTokenViaCli).toHaveBeenCalledWith('SOURCE-UAT');
    expect(refreshTokenViaCli).toHaveBeenCalledWith('TARGET-DEV');
  });

  it('stops with the way to sign in again when the CLI has no usable token for an org', async () => {
    vi.mocked(refreshTokenViaCli).mockResolvedValue({ accessToken: PLACEHOLDER });

    await expect(loadSfOrgs(['TARGET-DEV'])).rejects.toThrow(
      /no usable access token for alias 'TARGET-DEV'.*sf org login web --alias TARGET-DEV/,
    );
  });
});
