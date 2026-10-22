import { afterEach, describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { confirm, typed, type PromptStreams } from './prompt.js';

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
