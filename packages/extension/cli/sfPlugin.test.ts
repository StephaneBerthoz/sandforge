import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HARDIS_MENUS, dispatcherFile, hardisCommands, runTool } from './sfPlugin.js';
import { TOOLS, main } from './sandforge.js';

const here = __dirname;

/** The commands a menu entry may run: each reads no org and writes nothing. */
const READ_ONLY = [
  'sf sandforge --help',
  'sf sandforge seed --list-templates',
  'sf sandforge env validate',
  'sf sandforge env state',
];

describe('sf sandforge <command>, run in the process of sf', () => {
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

  it('hands the dispatcher the line bin/sandforge.mjs would, its file beside this one', async () => {
    const dispatch = vi.fn(async () => undefined);
    await runTool('clone', ['--no-such-flag'], dispatch, '/pkg/lib', '/pkg/lib/sfPlugin.mjs');
    expect(dispatch).toHaveBeenCalledWith([
      process.execPath,
      join('/pkg/lib', 'sandforge.mjs'),
      'clone',
      '--no-such-flag',
    ]);
    // From a checkout the dispatcher is the source beside this file.
    expect(dispatcherFile()).toBe(join(here, 'sandforge.ts'));
  });

  it('runs the root command as sandforge alone', async () => {
    const dispatch = vi.fn(async () => undefined);
    await runTool('', [], dispatch, '/pkg/lib', '/pkg/lib/sfPlugin.mjs');
    expect(dispatch).toHaveBeenCalledWith([process.execPath, join('/pkg/lib', 'sandforge.mjs')]);
  });

  it('passes -- and --help as they were typed: the line is the script’s, not rewritten', async () => {
    const dispatch = vi.fn(async () => undefined);
    await runTool(
      'pipeline',
      ['plan', '--file', 'p.json', '--', '--help'],
      dispatch,
      '/pkg/lib',
      '/pkg/lib/sfPlugin.mjs',
    );
    expect(dispatch).toHaveBeenCalledWith([
      process.execPath,
      join('/pkg/lib', 'sandforge.mjs'),
      'pipeline',
      'plan',
      '--file',
      'p.json',
      '--',
      '--help',
    ]);
  });

  it('starts the script with the line its own file would have been given, through the dispatcher', async () => {
    const seen: { file: string; argv: string[] }[] = [];
    await runTool('clone', ['--no-such-flag'], (line) =>
      main(line, async (file) => {
        seen.push({ file, argv: [...process.argv] });
      }),
    );
    const file = join(here, 'sandforge-clone.ts');
    expect(seen).toEqual([{ file, argv: [process.execPath, file, '--no-such-flag'] }]);
  });

  it('says to name a command, and ends on 2 having loaded nothing, for sf sandforge alone', async () => {
    const load = vi.fn(async () => undefined);
    await runTool('', [], (line) => main(line, load));
    expect(load).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(err.join('')).toMatch(/^Name the command to run\. Nothing was run\./);
  });
});

describe('the menus sfdx-hardis shows for SandForge', () => {
  let out: string[];
  let err: string[];
  const write = {
    out: (text: string) => {
      out.push(text);
    },
    err: (text: string) => {
      err.push(text);
    },
  };

  beforeEach(() => {
    out = [];
    err = [];
  });

  it('holds four entries, each a command that reads no org and writes nothing', () => {
    const commands = HARDIS_MENUS.flatMap((menu) => menu.commands);
    expect(commands.map((entry) => entry.command).sort()).toEqual([...READ_ONLY].sort());
    for (const entry of commands) {
      expect(entry.command.startsWith('sf sandforge ')).toBe(true);
      expect(entry.helpUrl).toMatch(/^https:\/\/github\.com\/StephaneBerthoz\/sandforge\/blob\//);
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.tooltip.length).toBeGreaterThan(0);
    }
    const ids = [...HARDIS_MENUS.map((menu) => menu.id), ...commands.map((entry) => entry.id)];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('names only commands sandforge has', () => {
    for (const entry of HARDIS_MENUS.flatMap((menu) => menu.commands)) {
      const word = entry.command.split(' ')[2] as string;
      expect(word === '--help' || Object.prototype.hasOwnProperty.call(TOOLS, word)).toBe(true);
    }
  });

  it('answers --json with one document on stdout, the shape sfdx-hardis reads, and nothing on stderr', () => {
    expect(hardisCommands(['--json'], write)).toBe(0);
    expect(out).toHaveLength(1);
    const answer = JSON.parse(out[0] as string) as unknown;
    expect(answer).toEqual({ status: 0, result: { customCommands: HARDIS_MENUS } });
    expect((out[0] as string).endsWith('}\n')).toBe(true);
    expect(err).toEqual([]);
  });

  it('lists the entries for a reader without --json', () => {
    expect(hardisCommands([], write)).toBe(0);
    const text = out.join('');
    for (const entry of HARDIS_MENUS.flatMap((menu) => menu.commands)) {
      expect(text).toContain(entry.label);
      expect(text).toContain(entry.command);
    }
    expect(err).toEqual([]);
  });

  it('refuses a word it does not read, on 2, having printed nothing on stdout', () => {
    expect(hardisCommands(['--json', '--target-org', 'DEV'], write)).toBe(2);
    expect(out).toEqual([]);
    expect(err.join('')).toContain('"--target-org" is not a flag sandforge:hardis-commands reads');
    expect(err.join('')).toContain('Nothing was run.');
  });
});
