import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { spawnRunner } from './scriptRunner.js';
import { RUN_USER_TIMEOUT_MS } from '../src/modules/sync/runUser.js';

/*
 * A script's answer read through a pipe, as `sandforge-env`, the MCP server
 * and a CI step read it: a real process, run under tsx's loader as the
 * scripts run, that writes more than a pipe takes at once and ends with
 * `process.exit()`, as every script does.
 */

const PROBE = join(__dirname, 'testing', 'bigOutput.ts');
const SILENT_TARGET = join(__dirname, 'testing', 'silentRunUser.ts');
/** Past the 64 KB a pipe takes at once: a checkpoint's estimate of an org of 200 objects is about 190 KB. */
const SIZE = 300_000;
/** Long enough for tsx to start on a loaded Windows runner. */
const STARTS_WITHIN = 120_000;

let inherited: string[];

beforeEach(() => {
  inherited = process.execArgv;
  process.execArgv = ['--import', 'tsx'];
});

afterEach(() => {
  process.execArgv = inherited;
});

/** The probe's stdout, read through a pipe; `loose` leaves its output as Node gives it. */
async function readThroughPipe(mode: 'whole' | 'loose'): Promise<string> {
  const run = spawnRunner({ scriptPath: () => PROBE });
  const ran = await run('sandforge-seed', [mode, String(SIZE)], new AbortController().signal);
  expect(ran.code).toBe(0);
  return ran.stdout;
}

/** How long a run's process stayed, in milliseconds, once its main returned, its target silent. */
async function heldAfterItsEnd(mode: 'ended' | 'left'): Promise<number> {
  const run = spawnRunner({ scriptPath: () => SILENT_TARGET });
  const ran = await run('sandforge-sync', [mode], new AbortController().signal);
  expect(ran.code).toBe(0);
  return Date.now() - Number(ran.stdout);
}

describe('a run whose target does not say who the session is', () => {
  it(
    'ends as its main returns',
    async () => {
      expect(await heldAfterItsEnd('ended')).toBeLessThan(RUN_USER_TIMEOUT_MS / 3);
    },
    STARTS_WITHIN,
  );

  it(
    'would stay for the read otherwise',
    async () => {
      // Positive control: what ending the process is there for. The read is
      // waited for by nothing in the run, and held the process all the same.
      expect(await heldAfterItsEnd('left')).toBeGreaterThan(RUN_USER_TIMEOUT_MS / 2);
    },
    STARTS_WITHIN,
  );

  it('ends so on every script that leaves that read behind it', () => {
    const scripts = readdirSync(__dirname)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .filter((name) => readFileSync(join(__dirname, name), 'utf8').includes('keepRunUser('));
    expect(scripts.sort()).toEqual(['sandforge-seed.ts', 'sandforge-sync.ts']);
    for (const name of scripts) {
      const source = readFileSync(join(__dirname, name), 'utf8');
      expect(source, name).toMatch(
        /\n {2}main\(\)\n {4}\.then\(\(\) => process\.exit\(process\.exitCode \?\? 0\)\)/,
      );
    }
  });
});

describe('a script’s output read through a pipe', () => {
  it(
    'reaches the reader whole although the script ends at once with process.exit()',
    async () => {
      expect((await readThroughPipe('whole')).length).toBe(SIZE);
    },
    STARTS_WITHIN,
  );

  it.skipIf(process.platform === 'win32')(
    'is cut where the pipe stopped taking it without it, on POSIX, where a pipe is written asynchronously',
    async () => {
      // Positive control: what holdOutputWhole is there for. A Windows pipe
      // is written synchronously, and loses nothing either way.
      expect((await readThroughPipe('loose')).length).toBeLessThan(SIZE);
    },
    STARTS_WITHIN,
  );

  it('is held whole by every script, before its main runs', () => {
    const scripts = readdirSync(__dirname).filter(
      (name) => /^sandforge-[a-z]+\.ts$/.test(name) && !name.endsWith('.test.ts'),
    );
    expect(scripts.length).toBeGreaterThanOrEqual(13);
    for (const name of scripts) {
      const source = readFileSync(join(__dirname, name), 'utf8');
      expect(source, name).toMatch(/\n {2}holdOutputWhole\(\);\n {2}main\(\)/);
    }
  });
});
