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
 * Hear each stop signal once, as one stop: the first that comes calls `stop`
 * and lets every one of them go, so a second ends the process as the
 * platform ends it. Heard with `process.once`, as the commands heard Ctrl-C.
 *
 * @returns What lets them go, once the run is over.
 */
export function onStopSignal(stop: (signal: StopSignal) => void): () => void {
  const listeners = new Map<StopSignal, () => void>();
  const release = (): void => {
    for (const [signal, listener] of listeners) process.off(signal, listener);
    listeners.clear();
  };
  for (const signal of STOP_SIGNALS) {
    const listener = (): void => {
      release();
      stop(signal);
    };
    listeners.set(signal, listener);
    process.once(signal, listener);
  }
  return release;
}
