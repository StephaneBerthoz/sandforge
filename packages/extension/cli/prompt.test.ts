import { afterEach, describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { confirm, hidden, typed, type PromptStreams } from './prompt.js';

/** A terminal, or a CI step's stdin when `tty` is false, and what was written to it. */
function streams(tty: boolean): { io: PromptStreams; input: PassThrough; asked: () => string } {
  const input = new PassThrough();
  Object.assign(input, { isTTY: tty ? true : undefined });
  const output = new PassThrough();
  let asked = '';
  output.on('data', (chunk) => {
    asked += String(chunk);
  });
  return { io: { input, output }, input, asked: () => asked };
}

describe('a question on the terminal', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('takes y or yes for a yes, anything else for a no', async () => {
    for (const [typedIn, answer] of [
      ['y\n', true],
      ['YES\n', true],
      ['n\n', false],
      ['\n', false],
    ] as const) {
      const { io, input } = streams(true);
      const asking = confirm('Restore?', io);
      input.write(typedIn);
      await expect(asking).resolves.toBe(answer);
    }
  });

  it('asks on the stream it is given, stderr for a command, never stdout', async () => {
    const stdout = vi.spyOn(process.stdout, 'write');
    const { io, input, asked } = streams(true);

    const asking = confirm('Load the dataset?', io);
    input.write('y\n');
    await asking;

    expect(asked()).toBe('Load the dataset? [y/N] ');
    expect(stdout).not.toHaveBeenCalled();
  });

  it('answers no when the terminal closes before an answer, where it waited for ever', async () => {
    const { io, input } = streams(true);

    const asking = confirm('Restore?', io);
    input.end();

    await expect(asking).resolves.toBe(false);
  });

  it('hands back the word typed, and nothing when the terminal closes', async () => {
    const one = streams(true);
    const asking = typed('Type TGT to delete them:', one.io);
    one.input.write('TGT\n');
    await expect(asking).resolves.toBe('TGT');

    const two = streams(true);
    const closed = typed('Type TGT to delete them:', two.io);
    two.input.end();
    await expect(closed).resolves.toBe('');
  });

  it('stops the command with exit 2 when no terminal is there to answer, and says to give --yes', async () => {
    // In a CI step the question waited until the job's timeout, or the
    // command exited 0 having written nothing, without a word.
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const { io, asked } = streams(false);

    await expect(confirm('Upsert snapshot op-1 back into TGT?', io)).rejects.toThrow('exit 2');

    expect(exit).toHaveBeenCalledWith(2);
    expect(asked()).toBe(
      'Upsert snapshot op-1 back into TGT? [y/N]\n' +
        'no terminal to answer: give --yes to go ahead without the question.\n',
    );
  });
});

describe('a secret asked on the terminal', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A terminal that records each switch of its raw mode, and what was written to it. */
  function terminal() {
    const made = streams(true);
    const raw: boolean[] = [];
    Object.assign(made.input, { setRawMode: (on: boolean) => raw.push(on) });
    return { ...made, raw };
  }

  it('reads what is typed with nothing of it written back, in raw mode until it is through', async () => {
    const { io, input, asked, raw } = terminal();

    const asking = hidden('Key of the file:', 'give --key-env VAR', io);
    input.write('ABCD-EF');
    input.write('GH\r');

    await expect(asking).resolves.toBe('ABCD-EFGH');
    expect(asked()).toBe('Key of the file: \n');
    expect(raw).toEqual([true, false]);
  });

  it('takes the last letter back at Backspace, and gives up at Ctrl-C, Ctrl-D on nothing typed, or a terminal that closes', async () => {
    const one = terminal();
    const corrected = hidden('Key:', 'give --key-env VAR', one.io);
    one.input.write('ABX\u007fC\n');
    await expect(corrected).resolves.toBe('ABC');

    for (const giveUp of ['AB\u0003', '\u0004']) {
      const two = terminal();
      const asking = hidden('Key:', 'give --key-env VAR', two.io);
      two.input.write(giveUp);
      await expect(asking).resolves.toBeUndefined();
      expect(two.raw).toEqual([true, false]);
    }

    const three = terminal();
    const closed = hidden('Key:', 'give --key-env VAR', three.io);
    three.input.end();
    await expect(closed).resolves.toBeUndefined();
  });

  it('stops the command with exit 2 when no terminal is there, saying what to give instead, and reads nothing', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const { io, input, asked } = streams(false);
    const read = vi.spyOn(input, 'on');

    expect(() => hidden('Key of the file:', 'give --key-env VAR', io)).toThrow('exit 2');

    expect(exit).toHaveBeenCalledWith(2);
    expect(read).not.toHaveBeenCalled();
    expect(asked()).toBe('Key of the file:\nno terminal to type it on: give --key-env VAR.\n');
  });
});
