import { afterEach, describe, expect, it, vi } from 'vitest';
import { refuseUnreadArguments, unreadArgument, type CommandFlags } from './commandLine.js';

const FLAGS: CommandFlags = {
  switches: ['--dry-run', '--json'],
  values: ['--target', '--object'],
};

describe('the words a command line reads', () => {
  it('reads its switches, its flags with their values, and --help', () => {
    expect(
      unreadArgument(
        ['--target', 'TGT', '--object', 'Account', '--object', 'Contact', '--dry-run', '--json'],
        FLAGS,
      ),
    ).toBeUndefined();
    expect(unreadArgument(['-h'], FLAGS)).toBeUndefined();
  });

  it('refuses a switch given a value after "=", the way a pipeline writes --dry-run=$DRY_RUN', () => {
    expect(unreadArgument(['--target', 'TGT', '--dry-run=true'], FLAGS)).toBe(
      '"--dry-run=true" is not read: --dry-run takes no value, it is on when given and off ' +
        'when left out. Nothing was run.',
    );
    expect(unreadArgument(['--dry-run=false'], FLAGS)).toContain('"--dry-run=false" is not read');
  });

  it('refuses a flag given its value after "=", and says how to give it', () => {
    expect(unreadArgument(['--target=TGT'], FLAGS)).toBe(
      '"--target=TGT" is not read: give its value after a space, as --target TGT. Nothing was run.',
    );
  });

  it('refuses a flag it does not know, a misspelt switch among them', () => {
    expect(unreadArgument(['--target', 'TGT', '--dryrun'], FLAGS)).toBe(
      '"--dryrun" is not a flag this command reads. Nothing was run.',
    );
    expect(unreadArgument(['-n'], FLAGS)).toContain('"-n" is not a flag');
  });

  it('refuses a word that follows no flag, which it dropped', () => {
    expect(unreadArgument(['--object', 'Account', 'Contact'], FLAGS)).toBe(
      '"Contact" is not read: a value goes after the flag it is for. Nothing was run.',
    );
  });

  it('reads the words a command takes before its flags', () => {
    expect(unreadArgument(['load', '--target', 'TGT'], { ...FLAGS, words: 1 })).toBeUndefined();
    expect(unreadArgument(['load', 'now', '--target', 'TGT'], { ...FLAGS, words: 1 })).toContain(
      '"now" is not read',
    );
  });

  it("leaves a flag given no value to the command's own check, and reads the flag after it", () => {
    // The command says which value its flag wants; a flag after it is read as one.
    expect(unreadArgument(['--target', '--dry-run'], FLAGS)).toBeUndefined();
    expect(unreadArgument(['--target', '--dryrun'], FLAGS)).toContain('"--dryrun" is not a flag');
  });
});

describe('the refusal of a word the command does not read', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stops the command with exit 2 and says why on stderr', () => {
    let stderr = '';
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
      stderr += chunk;
      return true;
    }) as never);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);

    expect(() => refuseUnreadArguments(['--dry-run=true'], FLAGS)).toThrow('exit 2');
    expect(stderr).toBe(
      '"--dry-run=true" is not read: --dry-run takes no value, it is on when given and off ' +
        'when left out. Nothing was run. Run with --help.\n',
    );

    exit.mockClear();
    refuseUnreadArguments(['--dry-run'], FLAGS);
    expect(exit).not.toHaveBeenCalled();
  });
});
