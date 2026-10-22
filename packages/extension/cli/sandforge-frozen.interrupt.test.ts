import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connection } from 'jsforce';
import type { BackgroundOperationRegistry } from '../src/core/engine/BackgroundOperationRegistry.js';

vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./sfSession.js', () => ({
  loadOrg: vi.fn(async (alias: string) => ({
    alias,
    username: 'someone@example.invalid',
    instanceUrl: 'https://target.example.invalid',
    accessToken: 'token',
  })),
  makeConn: vi.fn(),
}));

/** What the load the fake handler runs saw: whether its run was stopped through the registry. */
const seen = vi.hoisted(() => ({
  aborted: false,
  registered: false,
  signal: 'SIGINT' as 'SIGINT' | 'SIGTERM',
}));

// The handler's load, as the registry sees it: registered under the request's
// id with its controller, going on until that controller is aborted — a
// Ctrl-C comes once it runs — and ending as the handler ends a cancelled load.
vi.mock('../src/bridge/handlers/FrozenDatasetHandler.js', () => ({
  FrozenDatasetHandler: class {
    private registry?: BackgroundOperationRegistry;
    constructor(
      private readonly deps: {
        broker: { postToWebview: (message: Record<string, unknown>) => void };
      },
    ) {}
    setRegistry(registry: BackgroundOperationRegistry): void {
      this.registry = registry;
    }
    setTargetAutomation(): void {}
    setSaltKeeper(): void {}
    async handle(msg: { id: string; type: string }): Promise<boolean> {
      if (msg.type !== 'frozen:load') return true;
      const controller = new AbortController();
      const stopped = new Promise<void>((resolve) =>
        controller.signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      this.registry?.register(msg.id, 'frozen', 'Loading', stopped, controller);
      seen.registered = this.registry !== undefined;
      process.emit(seen.signal);
      await stopped;
      seen.aborted = controller.signal.aborted;
      this.deps.broker.postToWebview({
        type: 'frozen:load:error',
        correlationId: msg.id,
        payload: { message: 'Operation cancelled', code: 'LOAD_CANCELLED' },
      });
      return true;
    }
  },
}));

import { makeConn } from './sfSession.js';
import { frozenInterruptedLine, main } from './sandforge-frozen.js';

const argv = (...args: string[]): string[] => ['node', 'sandforge-frozen.ts', ...args];

let sasDir: string;
let configPath: string;
let errors: string[];

beforeEach(() => {
  sasDir = mkdtempSync(join(tmpdir(), 'sandforge-frozen-interrupt-'));
  configPath = join(sasDir, 'frozen.json');
  writeFileSync(configPath, JSON.stringify({ rootObject: 'Account', sasDir }));
  vi.mocked(makeConn).mockReturnValue({
    query: vi.fn(async () => ({
      done: true,
      totalSize: 1,
      records: [{ Id: '00D000000000009AAA', IsSandbox: true }],
    })),
  } as unknown as Connection);
  errors = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
    errors.push(String(chunk));
    return true;
  }) as never);
  seen.aborted = false;
  seen.registered = false;
  seen.signal = 'SIGINT';
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  rmSync(sasDir, { recursive: true, force: true });
});

describe('sandforge-frozen at Ctrl-C', () => {
  it("stops the load through the handler's registry, says what keeps it, and exits 130", async () => {
    // Killed outright, a load left the records it had written in the target
    // and no record of them in the sas.
    await main(argv('load', '--config', configPath, '--target', 'TGT', '--yes'));

    expect(seen).toMatchObject({ registered: true, aborted: true });
    expect(errors.join('')).toContain(frozenInterruptedLine('load'));
    expect(frozenInterruptedLine('load')).toContain('`remove` takes it back');
    expect(process.exitCode).toBe(130);
    expect(process.listenerCount('SIGINT')).toBe(0);
  });

  it('stops the load the same way at a SIGTERM, as Jenkins sends on abort or timeout, and exits 143', async () => {
    seen.signal = 'SIGTERM';

    await main(argv('load', '--config', configPath, '--target', 'TGT', '--yes'));

    expect(seen).toMatchObject({ registered: true, aborted: true });
    expect(errors.join('')).toContain(frozenInterruptedLine('load'));
    expect(process.exitCode).toBe(143);
    expect(process.listenerCount('SIGTERM')).toBe(0);
  });
});
