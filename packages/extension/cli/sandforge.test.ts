import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOOLS, dispatchOf, helpText, main, toolFile, versionOf, type Tool } from './sandforge.js';

const here = __dirname;

/** The scripts of this folder that start themselves: `sandforge-<name>.ts`. */
const scripts = readdirSync(here)
  .map((file) => /^sandforge-([a-z]+)\.ts$/.exec(file)?.[1])
  .filter((name): name is string => name !== undefined)
  .sort();

/**
 * The test a script's last lines make of `process.argv[1]` before it starts:
 * `process.argv[1]?.includes('sandforge-seed')`, or a regular expression.
 */
function guardOf(tool: string): (file: string) => boolean {
  const source = readFileSync(join(here, `sandforge-${tool}.ts`), 'utf8');
  const includes = /^if \(process\.argv\[1\]\?\.includes\('([^']+)'\)\) \{$/m.exec(source);
  if (includes) return (file) => file.includes(includes[1] as string);
  const pattern = /^if \(\/(.+)\/\.test\(process\.argv\[1\] \?\? ''\)\) \{$/m.exec(source);
  if (pattern) return (file) => new RegExp(pattern[1] as string).test(file);
  throw new Error(`sandforge-${tool}.ts starts itself under a test this file does not read`);
}

describe('sandforge, the scripts of this folder under one command', () => {
  it('names every script of this folder, and nothing else', () => {
    expect(Object.keys(TOOLS).sort()).toEqual(scripts);
  });

  it('gives each script the file its own start reads, from a checkout and packaged', () => {
    // A script loaded under another file's name would load, start nothing and
    // end on 0: the guard is what makes it run.
    for (const tool of scripts as Tool[]) {
      const guard = guardOf(tool);
      for (const [folder, self] of [
        ['/repo/packages/extension/cli', '/repo/packages/extension/cli/sandforge.ts'],
        [
          '/usr/lib/node_modules/sandforge/lib',
          '/usr/lib/node_modules/sandforge/lib/sandforge.mjs',
        ],
        ['C:\\npm\\sandforge\\lib', 'C:\\npm\\sandforge\\lib\\sandforge.mjs'],
      ] as const) {
        const file = toolFile(tool, folder, self);
        expect(guard(file), `${tool} from ${file}`).toBe(true);
        // And no other script starts under it: they share the process.
        for (const other of scripts.filter((name) => name !== tool)) {
          expect(guardOf(other)(file), `${other} under ${file}`).toBe(false);
        }
      }
    }
  });

  it('runs the script the first word names, with the words after it', () => {
    expect(dispatchOf(['seed', '--target', 'DEV', '--dry-run'])).toEqual({
      kind: 'run',
      tool: 'seed',
      args: ['--target', 'DEV', '--dry-run'],
    });
    expect(dispatchOf(['mcp'])).toEqual({ kind: 'run', tool: 'mcp', args: [] });
    // A script's own --help and --version are its own.
    expect(dispatchOf(['clone', '--help'])).toEqual({
      kind: 'run',
      tool: 'clone',
      args: ['--help'],
    });
  });

  it('answers its own help and version before any script', () => {
    expect(dispatchOf(['--help'])).toEqual({ kind: 'help' });
    expect(dispatchOf(['-h'])).toEqual({ kind: 'help' });
    expect(dispatchOf(['help'])).toEqual({ kind: 'help' });
    expect(dispatchOf(['--version'])).toEqual({ kind: 'version' });
    expect(dispatchOf(['-v'])).toEqual({ kind: 'version' });
  });

  it('refuses a line with no command, a word that is none, and a flag before the command', () => {
    expect(dispatchOf([])).toMatchObject({ kind: 'refused' });
    expect(dispatchOf(['deploy'])).toEqual({
      kind: 'refused',
      reason: '"deploy" is not a command of sandforge.',
    });
    expect(dispatchOf(['--dry-run', 'seed'])).toMatchObject({
      kind: 'refused',
      reason: expect.stringContaining('"--dry-run" is not a flag sandforge reads'),
    });
    // A script's own name, from a message that names it, is pointed at its command.
    expect(dispatchOf(['sandforge-checkpoint', 'list'])).toEqual({
      kind: 'refused',
      reason: '"sandforge-checkpoint" is named checkpoint here: sandforge checkpoint ….',
    });
  });

  it('lists every command with what it does', () => {
    const help = helpText();
    for (const [name, summary] of Object.entries(TOOLS)) {
      expect(help).toMatch(
        new RegExp(`^  ${name} +${summary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'),
      );
    }
    expect(help).toContain('claude mcp add sandforge -- npx -y sandforge mcp');
  });

  it('says the version of the package the folder belongs to', () => {
    const manifest = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(versionOf()).toBe(manifest.version);
  });

  describe('main', () => {
    const argv = process.argv;
    let out: string[];
    let err: string[];

    beforeEach(() => {
      out = [];
      err = [];
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        out.push(String(chunk));
        return true;
      });
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        err.push(String(chunk));
        return true;
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
      process.argv = argv;
      process.exitCode = undefined;
    });

    it('loads the script with the line its own file would have been given', async () => {
      const seen: { file: string; argv: string[] }[] = [];
      await main(
        ['/bin/node', join(here, 'sandforge.ts'), 'checkpoint', 'list', '--json'],
        async (file) => {
          seen.push({ file, argv: [...process.argv] });
        },
      );
      const file = join(here, 'sandforge-checkpoint.ts');
      expect(seen).toEqual([{ file, argv: ['/bin/node', file, 'list', '--json'] }]);
      expect(process.exitCode).toBeUndefined();
    });

    it('ends on 2, having loaded nothing, on a line it refuses', async () => {
      const load = vi.fn(async () => undefined);
      await main(['/bin/node', 'sandforge.ts', 'deploy', '--target', 'DEV'], load);
      expect(load).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(2);
      expect(err.join('')).toBe(
        `"deploy" is not a command of sandforge. Nothing was run. The commands: ` +
          `${Object.keys(TOOLS).join(', ')}. Run with --help.\n`,
      );
      expect(out).toEqual([]);
    });

    it('prints its help on stdout and its version, ending on 0', async () => {
      const load = vi.fn(async () => undefined);
      await main(['/bin/node', 'sandforge.ts', '--help'], load);
      await main(['/bin/node', 'sandforge.ts', '--version'], load);
      expect(load).not.toHaveBeenCalled();
      expect(out).toEqual([helpText(), `${versionOf()}\n`]);
      expect(process.exitCode).toBeUndefined();
    });
  });
});
