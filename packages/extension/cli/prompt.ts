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
  input: NodeJS.ReadableStream & { isTTY?: boolean };
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
