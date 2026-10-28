/**
 * The questions a command line asks on its terminal before it writes.
 *
 * The backup, DataOps and Frozen command lines each asked with a copy of the
 * same few lines: the question on stdout, the answer on the first `data` of
 * stdin. In a CI step stdin is no terminal, closed or never written: `data`
 * never came, the promise never settled, and the command either waited until
 * the job's timeout or exited 0 once nothing kept Node alive — having written
 * nothing, and without saying so. Under `--json`, the question also landed on
 * stdout ahead of the JSON.
 *
 * Here a question with no terminal to answer it stops the command, exit 2,
 * and says to give `--yes`; one whose terminal closes before an answer is
 * answered no; and the question goes to stderr.
 */

/** Where a question is asked and answered. */
export interface PromptStreams {
  /** A terminal's sets raw mode: what is typed then reaches the command alone, never the screen. */
  input: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (raw: boolean) => unknown };
  /** stderr: under --json, stdout carries the JSON alone. */
  output: NodeJS.WritableStream;
}

/** The exit code of a question that no terminal is there to answer: the line wants --yes. */
export const NO_TERMINAL_EXIT = 2;

/** The command's own terminal. */
const terminal = (): PromptStreams => ({ input: process.stdin, output: process.stderr });

/** The line typed in answer, or undefined when the input closed first. */
function answerOf(question: string, streams: PromptStreams): Promise<string | undefined> {
  const { input, output } = streams;
  if (input.isTTY !== true) {
    output.write(
      `${question}\nno terminal to answer: give --yes to go ahead without the question.\n`,
    );
    process.exit(NO_TERMINAL_EXIT);
  }
  output.write(`${question} `);
  return new Promise((resolve) => {
    const settle = (answer: string | undefined): void => {
      input.off('data', onData);
      input.off('end', onEnd);
      input.pause();
      resolve(answer);
    };
    const onData = (chunk: Buffer | string): void => settle(String(chunk).trim());
    const onEnd = (): void => settle(undefined);
    input.on('data', onData);
    input.on('end', onEnd);
    input.resume();
  });
}

/** Ask a yes-or-no question; anything but y or yes, and a closed terminal, is no. */
export async function confirm(question: string, streams = terminal()): Promise<boolean> {
  const answer = await answerOf(`${question} [y/N]`, streams);
  return answer !== undefined && /^y(es)?$/i.test(answer);
}

/** Ask for a word to be typed, and hand back what was; nothing when the terminal closed. */
export async function typed(question: string, streams = terminal()): Promise<string> {
  return (await answerOf(question, streams)) ?? '';
}

/** What ends, takes back or gives up a secret typed in raw mode. */
const ENTER = new Set(['\r', '\n']);
const BACKSPACE = new Set(['\u007f', '\b']);
const CTRL_C = '\u0003';
const CTRL_D = '\u0004';

/**
 * Ask for a secret — a key — that the terminal does not echo: typed or
 * pasted, nothing of it is written back, not even a mark a letter, so
 * neither the screen nor a recording of it holds it. The terminal is read in
 * raw mode, a key at a time: Enter ends it, Backspace takes the last letter
 * back, Ctrl-C, and Ctrl-D on nothing typed, give up, and so does a terminal
 * that closes first. With no terminal the command stops, exit 2, and says
 * what to give instead: a secret is never read from a pipe it was not
 * meant for.
 *
 * @param instead - What to give in place of a terminal: `give --key-env VAR`.
 * @returns What was typed; undefined when it was given up.
 */
export function hidden(
  question: string,
  instead: string,
  streams = terminal(),
): Promise<string | undefined> {
  const { input, output } = streams;
  if (input.isTTY !== true) {
    output.write(`${question}\nno terminal to type it on: ${instead}.\n`);
    process.exit(NO_TERMINAL_EXIT);
  }
  output.write(`${question} `);
  input.setRawMode?.(true);
  return new Promise((resolve) => {
    let secret = '';
    const settle = (answer: string | undefined): void => {
      input.off('data', onData);
      input.off('end', onEnd);
      input.setRawMode?.(false);
      input.pause();
      output.write('\n');
      resolve(answer);
    };
    const onData = (chunk: Buffer | string): void => {
      for (const char of String(chunk)) {
        if (ENTER.has(char)) return settle(secret);
        if (char === CTRL_C || (char === CTRL_D && secret === '')) return settle(undefined);
        if (BACKSPACE.has(char)) secret = secret.slice(0, -1);
        else if (char >= ' ') secret += char;
      }
    };
    const onEnd = (): void => settle(undefined);
    input.on('data', onData);
    input.on('end', onEnd);
    input.resume();
  });
}
