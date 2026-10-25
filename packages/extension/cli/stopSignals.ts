/**
 * The signals that stop a command line's run, and the exit code each leaves.
 *
 * Each command heard Ctrl-C alone (SIGINT): it stopped before its next call,
 * said what it wrote and where its run is kept. Jenkins aborts a build, and
 * its `timeout` step ends one, with SIGTERM; a closed terminal or a dropped
 * SSH session sends SIGHUP. Either killed the process outright, and the
 * summary that names what the run created, which `--remove` takes it back
 * from, was never printed. Both now stop a run as Ctrl-C does; a second
 * signal still ends the process at once.
 */

/** The signals a run stops on. */
export const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/** One of them. */
export type StopSignal = (typeof STOP_SIGNALS)[number];

/** The exit code a shell gives a process each signal ended: 128 and its number. */
const SIGNAL_EXIT: Readonly<Record<StopSignal, number>> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};

/** The exit code of a run that `signal` stopped. */
export function stopExitCode(signal: StopSignal): number {
  return SIGNAL_EXIT[signal];
}

/**
 * What a parent that started the run with an IPC channel sends to stop it as
 * Ctrl-C does. Windows has no signals: Node ends a child it is asked to
 * SIGINT at once, before it says what it wrote, so the MCP server stops a
 * script there with this message.
 */
export const STOP_MESSAGE = 'sandforge:stop';

/**
 * Hear each stop signal once, as one stop: the first that comes calls `stop`
 * and lets every one of them go, so a second ends the process as the
 * platform ends it. Heard with `process.once`, as the commands heard Ctrl-C.
 * Started with an IPC channel, the run hears {@link STOP_MESSAGE} as Ctrl-C
 * too; the channel is let go of at once, so it never keeps alive a run whose
 * work is done.
 *
 * @returns What lets them go, once the run is over.
 */
export function onStopSignal(stop: (signal: StopSignal) => void): () => void {
  const listeners = new Map<StopSignal, () => void>();
  let message: ((sent: unknown) => void) | undefined;
  const release = (): void => {
    for (const [signal, listener] of listeners) process.off(signal, listener);
    listeners.clear();
    if (message) process.off('message', message);
    message = undefined;
  };
  for (const signal of STOP_SIGNALS) {
    const listener = (): void => {
      release();
      stop(signal);
    };
    listeners.set(signal, listener);
    process.once(signal, listener);
  }
  if (typeof process.send === 'function') {
    message = (sent: unknown): void => {
      if (sent !== STOP_MESSAGE) return;
      release();
      stop('SIGINT');
    };
    process.on('message', message);
    process.channel?.unref();
  }
  return release;
}
