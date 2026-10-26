import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { scriptFile, spawnRunner, type CommandRun, type RunnableScript } from './scriptRunner.js';

/*
 * How the MCP server, and an environment, start a script and stop it, on a
 * real process: a probe
 * that hears its stop signals as every command of the folder does
 * (`testing/stopProbe.ts`), run under tsx's loader as the server's scripts
 * run. Each CI runner runs it, Windows's included, where Node ends a child
 * asked to SIGINT at once, before it says what it wrote.
 */

const PROBE = join(__dirname, 'testing', 'stopProbe.ts');
/** Long enough for tsx to start on a loaded Windows runner. */
const STARTS_WITHIN = 120_000;

let inherited: string[];

beforeEach(() => {
  // The server is started by tsx, and its scripts inherit tsx's loader.
  inherited = process.execArgv;
  process.execArgv = ['--import', 'tsx'];
});

afterEach(() => {
  process.execArgv = inherited;
  vi.restoreAllMocks();
});

/**
 * Run the probe as the server runs a script on `platform`: in `mode`, and
 * stopped as a cancelled call is, once it says it waits.
 */
function runProbe(
  platform: NodeJS.Platform,
  mode: 'exit' | 'wait',
  ...args: string[]
): Promise<CommandRun> {
  const call = new AbortController();
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    if (String(chunk).includes('waiting')) call.abort();
    return true;
  }) as typeof process.stderr.write);
  const run = spawnRunner({ platform, scriptPath: () => PROBE });
  return run('sandforge-seed', [mode, ...args], call.signal);
}

describe('a script in a process of its own', () => {
  it(
    'runs a script under the runtime the server runs under, its arguments as given and its output kept',
    async () => {
      const ran = await runProbe(process.platform, 'exit', 'two words', 'a "quoted" one');

      expect(ran.code).toBe(0);
      expect(JSON.parse(ran.stdout)).toEqual({
        args: ['two words', 'a "quoted" one'],
        ipc: process.platform === 'win32',
      });
    },
    STARTS_WITHIN,
  );

  it(
    'stops a script on Windows with the message it hears as Ctrl-C, so that it says what it did and leaves 130',
    async () => {
      const ran = await runProbe('win32', 'wait');

      expect(ran.stderr).toContain('stopped by SIGINT');
      expect(ran.code).toBe(130);
    },
    STARTS_WITHIN,
  );

  it(
    'lets a script started with an IPC channel end once its work is done, the channel still open',
    async () => {
      const ran = await runProbe('win32', 'exit');

      expect(ran.code).toBe(0);
      expect(JSON.parse(ran.stdout)).toMatchObject({ ipc: true });
    },
    STARTS_WITHIN,
  );

  it.skipIf(process.platform === 'win32')(
    'stops a script on POSIX with one SIGINT',
    async () => {
      const ran = await runProbe('linux', 'wait');

      expect(ran.stderr).toContain('stopped by SIGINT');
      expect(ran.code).toBe(130);
    },
    STARTS_WITHIN,
  );
});

describe('the scripts a runner starts', () => {
  /** Every script the runner may be asked for: the type refuses a name missing here. */
  const RUNNABLE: Record<RunnableScript, true> = {
    'sandforge-seed': true,
    'sandforge-clone': true,
    'sandforge-sync': true,
    'sandforge-checkpoint': true,
    'sandforge-frozen': true,
    'sandforge-dataops': true,
    'sandforge-env': true,
  };

  it('starts each of them from its own file in this folder', () => {
    for (const script of Object.keys(RUNNABLE) as RunnableScript[]) {
      expect(scriptFile(script)).toBe(join(__dirname, `${script}.ts`));
      expect(existsSync(scriptFile(script)), script).toBe(true);
    }
  });

  it(
    'runs a script the MCP server has no tool for by its name, as an environment runs its steps',
    async () => {
      const asked: string[] = [];
      const run = spawnRunner({
        platform: process.platform,
        scriptPath: (script) => {
          asked.push(script);
          return PROBE;
        },
      });

      const ran = await run('sandforge-frozen', ['exit', 'load'], new AbortController().signal);

      expect(asked).toEqual(['sandforge-frozen']);
      expect(ran.code).toBe(0);
      expect(JSON.parse(ran.stdout)).toMatchObject({ args: ['load'] });
    },
    STARTS_WITHIN,
  );
});
