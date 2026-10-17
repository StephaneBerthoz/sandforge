import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connection } from 'jsforce';

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
vi.mock('../src/core/connection/ConnectionHelper.js', async (original) => ({
  ...(await original<typeof import('../src/core/connection/ConnectionHelper.js')>()),
  getJsforceConnection: vi.fn(),
}));

import { makeConn } from './sfSession.js';
import { getJsforceConnection } from '../src/core/connection/ConnectionHelper.js';
import { SasReferenceIdMappingStore } from '../src/modules/frozendataset/SasReferenceIdMappingStore.js';
import { failsTheStep, main, messageLines } from './sandforge-frozen.js';

/** The target, a sandbox, as its `Organization` record answers. */
const ORG_ID = '00D000000000009AAA';

const argv = (...args: string[]): string[] => ['node', 'sandforge-frozen.ts', ...args];

let sasDir: string;
let configPath: string;
let printed: string[];

beforeEach(() => {
  sasDir = mkdtempSync(join(tmpdir(), 'sandforge-frozen-remove-'));
  configPath = join(sasDir, 'frozen.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      rootObject: 'Account',
      axes: [
        {
          name: 'account',
          label: 'Account',
          filterField: 'Name',
          valuesSoql: 'SELECT Name axisValue FROM Account GROUP BY Name',
        },
      ],
      edgeCases: [],
      budgetMaxRecords: 2500,
      candidatesPerCombination: 1,
      sasDir,
    }),
  );
  const conn = {
    query: vi.fn(async () => ({
      done: true,
      totalSize: 1,
      records: [{ Id: ORG_ID, IsSandbox: true }],
    })),
    queryMore: vi.fn(),
  } as unknown as Connection;
  vi.mocked(makeConn).mockReturnValue(conn);
  vi.mocked(getJsforceConnection).mockResolvedValue(conn as never);
  printed = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
    printed.push(String(chunk));
    return true;
  }) as never);
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  rmSync(sasDir, { recursive: true, force: true });
});

/** A load into the target that created nothing a removal takes: the price book it matched. */
async function loadThatCreatedNothing(): Promise<void> {
  await new SasReferenceIdMappingStore(sasDir, {
    orgId: ORG_ID,
    now: () => new Date('2026-10-17T08:00:10.000Z'),
  }).persist(new Map([['Pricebook2-000001', '01s000000000001AAA']]), {
    created: [],
    startedAt: new Date('2026-10-17T08:00:00.000Z'),
  });
}

describe('sandforge-frozen remove, with nothing to take', () => {
  it('says why and ends the step as done, where it exited on a failure', async () => {
    await loadThatCreatedNothing();

    await main(argv('remove', '--config', configPath, '--target', 'TGT', '--yes'));

    expect(printed.join('')).toContain('nothing to remove: This load created no record to remove.');
    expect(process.exitCode).toBeUndefined();
  });

  it('ends as done when no load into the target is recorded', async () => {
    await main(argv('remove', '--config', configPath, '--target', 'TGT', '--yes'));

    expect(printed.join('')).toContain(
      'No load into TGT is recorded in this sas: nothing to remove.',
    );
    expect(process.exitCode).toBeUndefined();
  });
});

describe('failsTheStep', () => {
  it('fails on an error, but for a removal that has nothing to take', () => {
    const removal = (code: string) => ({
      type: 'frozen:remove:error',
      payload: { message: 'refused', code },
    });

    expect(failsTheStep(removal('ALREADY_REMOVED'))).toBe(false);
    expect(failsTheStep(removal('NOTHING_TO_REMOVE'))).toBe(false);
    expect(failsTheStep(removal('NO_LOAD'))).toBe(false);
    expect(failsTheStep(removal('LOAD_CHANGED'))).toBe(true);
    expect(failsTheStep(removal('GUARD_DECLINED'))).toBe(true);
    expect(
      failsTheStep({ type: 'frozen:load:error', payload: { message: 'x', code: 'NO_LOAD' } }),
    ).toBe(true);
    expect(failsTheStep({ type: 'frozen:remove:response', payload: {} })).toBe(false);
    expect(messageLines(removal('ALREADY_REMOVED'))).toEqual(['nothing to remove: refused']);
  });
});
