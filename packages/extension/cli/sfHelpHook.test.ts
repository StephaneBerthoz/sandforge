import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import sfHelpHook, {
  binFile,
  helpHook,
  helpLineOf,
  type FoundCommand,
  type HookContext,
} from './sfHelpHook.js';

/** The commands an sf with the plugin installed finds, by every id it answers to. */
const COMMANDS: Record<string, FoundCommand> = {
  sandforge: { id: 'sandforge', pluginName: 'sandforge', hidden: false },
  'sandforge:clone': { id: 'sandforge:clone', pluginName: 'sandforge', hidden: false },
  'sandforge:pipeline': { id: 'sandforge:pipeline', pluginName: 'sandforge', hidden: false },
  'sandforge:hardis-commands': {
    id: 'sandforge:hardis-commands',
    pluginName: 'sandforge',
    hidden: true,
  },
  'org:list': { id: 'org:list', pluginName: '@salesforce/plugin-org', hidden: false },
};

/** sf's flexible taxonomy: the words of an id in another order find the same command. */
const PERMUTATIONS: Record<string, string> = { 'clone:sandforge': 'sandforge:clone' };

const config: HookContext['config'] = {
  findCommand: (id) => COMMANDS[PERMUTATIONS[id] ?? id],
};

/** The hook, its child and its exit recorded instead of run. */
function recorded(status: number | null = 0) {
  const spawn = vi.fn((_file: string, _args: readonly string[]) => status);
  const exit = vi.fn((_code: number) => undefined);
  const hook = helpHook({ spawn, exit, bin: '/pkg/bin/sandforge.mjs' });
  return {
    spawn,
    exit,
    run: (id: string | undefined, argv: readonly string[]) => hook.call({ config }, { id, argv }),
  };
}

describe("sf sandforge … --help, said by the script's own help", () => {
  it('leaves every command of another plugin to sf', async () => {
    const { spawn, exit, run } = recorded();
    await run('org:list', ['--help']);
    await run('org:list', ['-h']);
    await run(undefined, ['--help']);
    await run('no:such:command', ['--help']);
    expect(spawn).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('leaves a hidden command, a line with no help flag, and a help flag after -- to sf', async () => {
    const { spawn, exit, run } = recorded();
    await run('sandforge:hardis-commands', ['--help']);
    await run('sandforge:clone', ['--source', 'SRC', '--dry-run']);
    await run('sandforge:clone', ['--', '--help']);
    await run('sandforge:pipeline', ['plan', '--', '-h']);
    expect(spawn).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('runs bin/sandforge.mjs with the command and the words as typed, and ends on its code', async () => {
    const { spawn, exit, run } = recorded(0);
    await run('sandforge:clone', ['--help']);
    await run('sandforge:clone', ['-h']);
    await run('sandforge:pipeline', ['plan', '--help']);
    await run('sandforge', ['--help']);
    expect(spawn.mock.calls).toEqual([
      ['/pkg/bin/sandforge.mjs', ['clone', '--help']],
      ['/pkg/bin/sandforge.mjs', ['clone', '-h']],
      ['/pkg/bin/sandforge.mjs', ['pipeline', 'plan', '--help']],
      ['/pkg/bin/sandforge.mjs', ['--help']],
    ]);
    expect(exit.mock.calls).toEqual([[0], [0], [0], [0]]);
  });

  it('ends on the code bin/ ended on, and on 1 when the child ended on a signal', async () => {
    // bin/ refuses a Node older than the package's floor on 1, with its sentence.
    const refused = recorded(1);
    await refused.run('sandforge:clone', ['--help']);
    expect(refused.exit).toHaveBeenCalledWith(1);
    const killed = recorded(null);
    await killed.run('sandforge:clone', ['--help']);
    expect(killed.exit).toHaveBeenCalledWith(1);
  });

  it('finds the command by the id sf resolves, words in another order included', () => {
    expect(helpLineOf(config, 'clone:sandforge', ['--help'])).toEqual(['clone', '--help']);
    expect(helpLineOf(config, 'sandforge:clone', ['--org', 'X'])).toBeUndefined();
  });

  it('runs the bin/ of the package the bundled hook is in', () => {
    // Packaged, the hook is lib/sfHelpHook.mjs and the command bin/sandforge.mjs.
    expect(binFile('/pkg/lib')).toBe(join('/pkg/lib', '..', 'bin', 'sandforge.mjs'));
    expect(typeof sfHelpHook).toBe('function');
  });
});
