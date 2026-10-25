import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { spawnRunner } from './scriptRunner.js';

/*
 * A script's answer read through a pipe, as `sandforge-env`, the MCP server
 * and a CI step read it: a real process, run under tsx's loader as the
 * scripts run, that writes more than a pipe takes at once and ends with
 * `process.exit()`, as every script does.
 */

const PROBE = join(__dirname, 'testing', 'bigOutput.ts');
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
