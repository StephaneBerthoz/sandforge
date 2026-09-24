import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SasPathGuard, findRepoRoot } from './SasPathGuard.js';
import {
  contractCountsLoad,
  readCountingContract,
  writeCountingContract,
  type CountingContract,
} from './CountingContract.js';

const repoRoot = findRepoRoot(process.cwd());
const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
  }
});

/** A contract of one account, written when `writtenAt` says, of the load `loadStartedAt` names. */
function contract(overrides: Partial<CountingContract> = {}): CountingContract {
  return {
    version: 1,
    orgId: '00D-target',
    datasetVersion: '1.0.0',
    writtenAt: '2026-09-24T10:05:01.000Z',
    objects: {
      Account: { fromFiles: 1, exclusionReasons: {}, excluded: 0, added: 0, expected: 1 },
    },
    ...overrides,
  };
}

describe('the counting contract', () => {
  it('keeps the load it counts, as it reads back', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandforge-contract-test-'));
    tmpDirs.push(dir);
    const guard = new SasPathGuard(repoRoot);

    const written = writeCountingContract(
      guard,
      dir,
      contract({ loadStartedAt: '2026-09-24T10:00:00.000Z' }),
    );

    expect(readCountingContract(guard, written).loadStartedAt).toBe('2026-09-24T10:00:00.000Z');
  });

  describe('which load it counts', () => {
    const LAST_LOAD = {
      startedAt: '2026-09-24T10:00:00.000Z',
      endedAt: '2026-09-24T10:05:00.000Z',
    };

    it('counts the load that began when it says', () => {
      expect(
        contractCountsLoad(contract({ loadStartedAt: '2026-09-24T10:00:00.000Z' }), LAST_LOAD),
      ).toBe(true);
    });

    it('does not count a load that stopped after the one it counts', () => {
      // A cancelled load kept its mapping and wrote no contract: the one in
      // the sas is the load's before it.
      const stopped = {
        startedAt: '2026-09-24T11:00:00.000Z',
        endedAt: '2026-09-24T11:02:00.000Z',
      };

      expect(
        contractCountsLoad(contract({ loadStartedAt: '2026-09-24T10:00:00.000Z' }), stopped),
      ).toBe(false);
    });

    it('does not count a load whose mapping does not say when it began', () => {
      expect(
        contractCountsLoad(contract({ loadStartedAt: '2026-09-24T10:00:00.000Z' }), {
          endedAt: '2026-09-24T10:05:00.000Z',
        }),
      ).toBe(false);
    });

    describe('when written before contracts named their load', () => {
      it('counts the load whose mapping was written before it: the one that wrote it', () => {
        expect(contractCountsLoad(contract(), { endedAt: '2026-09-24T10:05:00.000Z' })).toBe(true);
      });

      it('does not count a load whose mapping was written after it', () => {
        expect(contractCountsLoad(contract(), { endedAt: '2026-09-24T11:02:00.000Z' })).toBe(false);
      });

      it('counts nothing it cannot date', () => {
        expect(
          contractCountsLoad(contract({ writtenAt: 'soon' }), {
            endedAt: '2026-09-24T10:05:00.000Z',
          }),
        ).toBe(false);
      });
    });
  });
});
