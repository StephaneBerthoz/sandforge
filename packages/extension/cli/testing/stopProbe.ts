/**
 * A script for the MCP server's tests of how it starts and stops a script
 * (`sandforge-mcp.spawn.test.ts`), hearing its stop signals as every command
 * of this folder does. `exit` prints its arguments and ends, its stop signals
 * still heard; `wait` says so on stderr and waits until it is stopped, then
 * leaves as a run stopped by that signal leaves.
 */
import { onStopSignal, stopExitCode } from '../stopSignals.js';

const [mode, ...rest] = process.argv.slice(2);

if (mode === 'exit') {
  onStopSignal(() => undefined);
  process.stdout.write(
    `${JSON.stringify({ args: rest, ipc: typeof process.send === 'function' })}\n`,
  );
} else {
  const waiting = setInterval(() => undefined, 1_000);
  onStopSignal((signal) => {
    clearInterval(waiting);
    process.stderr.write(`stopped by ${signal}\n`);
    process.exitCode = stopExitCode(signal);
  });
  process.stderr.write('waiting\n');
}
