/**
 * The output of a command line kept whole when it is read through a pipe.
 *
 * On POSIX a pipe is written asynchronously, and every script ends with
 * `process.exit()`, which drops what the pipe has not taken yet: past 64 KB
 * the reader gets the start of the answer and nothing more. `sandforge-env`,
 * the MCP server and a CI step read the scripts' `--json` answers through a
 * pipe; a checkpoint's estimate of an org of 200 objects, about 190 KB, came
 * cut, and the environment took a checkpoint it had just written for one not
 * taken. Written to a terminal or a file, nothing was lost, so a run by hand
 * never showed it. Writes block until the pipe has taken them instead.
 */

/** A stream as Node holds it underneath: its handle, when it has one that can block. */
interface HandleOf {
  _handle?: { setBlocking?: (blocking: boolean) => unknown };
}

/** Make stdout and stderr block, so that `process.exit()` loses none of what they were given. */
export function holdOutputWhole(): void {
  for (const stream of [process.stdout, process.stderr]) {
    (stream as unknown as HandleOf)._handle?.setBlocking?.(true);
  }
}
