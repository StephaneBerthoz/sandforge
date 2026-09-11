import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as vscode from 'vscode';

// Stands in for the real API on the one path that has no injected host, so
// that path is exercised rather than skipped.
const vscodeMock = vi.hoisted(() => ({
  openExternal: vi.fn(),
  parse: vi.fn((value: string) => ({ toString: () => value })),
}));
vi.mock('vscode', () => ({
  env: { openExternal: vscodeMock.openExternal },
  Uri: { parse: vscodeMock.parse },
}));

import { ExternalBrowserAdapter, type ExternalBrowserHost } from './ExternalBrowserAdapter.js';

const PAGE = 'https://acme.my.salesforce.com/lightning/setup/AsyncApexJobs/home';

/** A stand-in for the two VS Code calls the adapter makes. */
function makeHost(openExternal: ExternalBrowserHost['openExternal']): {
  host: ExternalBrowserHost;
  parseUri: ReturnType<typeof vi.fn>;
} {
  const parseUri = vi.fn((value: string) => ({ toString: () => value }) as unknown as vscode.Uri);
  return { host: { openExternal, parseUri }, parseUri };
}

describe('ExternalBrowserAdapter', () => {
  beforeEach(() => {
    vscodeMock.openExternal.mockReset();
    vscodeMock.parse.mockClear();
  });

  it('opens the page through the host and reports it opened', async () => {
    const openExternal = vi.fn().mockResolvedValue(true);
    const { host, parseUri } = makeHost(openExternal);

    const outcome = await new ExternalBrowserAdapter(host).open(PAGE);

    expect(outcome).toEqual({ status: 'opened' });
    expect(parseUri).toHaveBeenCalledWith(PAGE);
    expect(String(openExternal.mock.calls[0][0])).toBe(PAGE);
  });

  it('reports an error when VS Code answers that it did not open the page', async () => {
    const { host } = makeHost(vi.fn().mockResolvedValue(false));

    const outcome = await new ExternalBrowserAdapter(host).open(PAGE);

    expect(outcome.status).toBe('error');
    expect(outcome.status === 'error' && outcome.message).toMatch(/did not open/);
  });

  it('reports a failed open as an error carrying its cause', async () => {
    const { host } = makeHost(vi.fn().mockRejectedValue(new Error('no browser available')));

    const outcome = await new ExternalBrowserAdapter(host).open(PAGE);

    expect(outcome).toEqual({ status: 'error', message: 'no browser available' });
  });

  it('without an injected host, goes through vscode.env.openExternal', async () => {
    vscodeMock.openExternal.mockResolvedValue(true);

    const outcome = await new ExternalBrowserAdapter().open(PAGE);

    expect(outcome).toEqual({ status: 'opened' });
    expect(vscodeMock.parse).toHaveBeenCalledWith(PAGE, true);
    expect(String(vscodeMock.openExternal.mock.calls[0][0])).toBe(PAGE);
  });
});
