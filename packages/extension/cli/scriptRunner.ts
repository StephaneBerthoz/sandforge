/**
 * Running a script of this folder in a process of its own, with the
 * arguments after its name, and keeping what it said: how the MCP server runs
 * each of its tools, and how an environment runs each of its steps.
 *
 * Both run the script that already does the work rather than its modules in
 * their own process: every guard of the script holds as it holds on a
 * terminal, and none of them is written a second time by whoever runs it.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { FAILED_EXIT } from './exitCodes.js';
import { STOP_CHANNEL_VARIABLE, STOP_MESSAGE, STOP_SIGNALS, stopExitCode } from './stopSignals.js';

/**
 * The scripts of this folder a runner starts: those the MCP server's tools
 * run (its own closed list, `Script`), `sandforge-env` among them, and those
 * an environment's steps run. Nothing else: a runner is never handed a path.
 */
export type RunnableScript =
  | 'sandforge-seed'
  | 'sandforge-clone'
  | 'sandforge-sync'
  | 'sandforge-checkpoint'
  | 'sandforge-frozen'
  | 'sandforge-dataops'
  | 'sandforge-empty'
  | 'sandforge-env';

/** What one run of a script came to. */
export interface CommandRun {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs a script of this folder with the arguments after its name, and settles
 * once it has ended. The signal stops it as Ctrl-C stops it on a terminal.
 *
 * @typeParam S - The scripts it is asked to run: the MCP server narrows it to
 *   those its tools run.
 */
export type CommandRunner<S extends RunnableScript = RunnableScript> = (
  script: S,
  args: readonly string[],
  signal: AbortSignal,
) => Promise<CommandRun>;

/** The runtime flags a script inherits: tsx's loader, never a debugger's port. */
function inheritedRuntimeFlags(): string[] {
  return process.execArgv.filter((flag) => !/^--inspect/.test(flag));
}

/** The file a script of this folder runs from. */
export function scriptFile(script: RunnableScript): string {
  return join(__dirname, `${script}.ts`);
}

/**
 * The variable a script finds set to the command that relays its lines, when
 * one does: `sandforge-env`, whose reader cannot give that command the
 * options a script's own advice names (`--sweep-late`, `--sweep-untied`,
 * `--sweep-list`). Relayed as they were, "(--sweep-untied takes them)" sent
 * that reader to a flag the destroy refused, exit 2.
 */
export const RELAYED_BY_VARIABLE = 'SANDFORGE_RELAYED_BY';

/** How {@link spawnRunner} starts a script; each defaults to the runner's own. */
export interface SpawnOptions {
  /** The platform it runs on, which says how a script is stopped. */
  platform?: NodeJS.Platform;
  /** The file a script runs from: the script of this folder by that name. */
  scriptPath?: (script: RunnableScript) => string;
  /** The command whose output relays the script's lines ({@link RELAYED_BY_VARIABLE}). */
  relayedBy?: string;
}

/**
 * Run a script of this folder in a process of its own, under the runtime this
 * process runs under, from the folder it was started in. It has no terminal: a
 * question it asks stops it. Its lines go on to this process's stderr as they
 * come, for whoever reads it, and are kept for the answer.
 *
 * On POSIX it leads a process group of its own: a Ctrl-C typed at the
 * terminal that started this process reaches this process alone, which stops
 * the script with one SIGINT. Two would end it at once, past where it stops
 * cleanly. Windows has no signals, and Node ends a child it is asked to
 * SIGINT there at once: the script is started with an IPC channel instead,
 * and stopped with the message its stop signals hear as Ctrl-C
 * (`STOP_MESSAGE`).
 */
export function spawnRunner(options: SpawnOptions = {}): CommandRunner {
  const windows = (options.platform ?? process.platform) === 'win32';
  const scriptPath = options.scriptPath ?? scriptFile;
  return (script, args, signal) =>
    new Promise((resolve, reject) => {
      // Read as each script starts: what this process sets meanwhile reaches it.
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ...(options.relayedBy !== undefined ? { [RELAYED_BY_VARIABLE]: options.relayedBy } : {}),
        ...(windows ? { [STOP_CHANNEL_VARIABLE]: 'ipc' } : {}),
      };
      const child = spawn(
        process.execPath,
        [...inheritedRuntimeFlags(), scriptPath(script), ...args],
        {
          stdio: windows ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
          env,
          detached: !windows,
          windowsHide: true,
        },
      );
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => {
        err.push(chunk);
        process.stderr.write(chunk);
      });
      const stop = (): void => {
        if (!windows || !child.connected) {
          child.kill('SIGINT');
          return;
        }
        child.send(STOP_MESSAGE, (error) => {
          if (error) child.kill('SIGINT');
        });
      };
      if (signal.aborted) stop();
      else signal.addEventListener('abort', stop, { once: true });
      child.on('error', (error) => {
        signal.removeEventListener('abort', stop);
        reject(error);
      });
      child.on('close', (code, ended) => {
        signal.removeEventListener('abort', stop);
        const bySignal = STOP_SIGNALS.find((each) => each === ended);
        resolve({
          code: code ?? (bySignal !== undefined ? stopExitCode(bySignal) : FAILED_EXIT),
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8'),
        });
      });
    });
}
