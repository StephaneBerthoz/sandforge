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
 *
 * Started by `npx` (npm exec), a script hears each Ctrl-C twice: from the
 * terminal, which signals the whole group, and from npm, which sends its
 * children every SIGINT and SIGTERM it gets. Where `/bin/sh` runs a lone
 * command without a fork of its own, as bash does on macOS, the script is
 * npm's child, and npm's copy, a few milliseconds later, ended it at once:
 * a script run by `npm exec --script-shell=/bin/bash` said it was stopping,
 * then ended on 130 with no summary.
 */

/**
 * How long after a stop the same signal is taken for its relay, not for a
 * second Ctrl-C: npm's comes within milliseconds, a person's after reading
 * the line that says a second one ends the run at once.
 */
export const RELAY_WINDOW_MS = 1_000;

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
 * The variable a parent sets, with the IPC channel it opens, when the channel
 * is the run's way to stop. Only then is the channel heard and let go of: a
 * process that has one for another purpose — a test runner's worker, whose
 * channel to its parent is what keeps it alive — kept the channel unheld, and
 * the worker ended in the middle of its tests.
 */
export const STOP_CHANNEL_VARIABLE = 'SANDFORGE_STOP_CHANNEL';

/**
 * Hear each stop signal once, as one stop: the first that comes calls `stop`
 * and lets every one of them go, so a second ends the process as the
 * platform ends it — but for the same signal again within
 * {@link RELAY_WINDOW_MS}, its relay by the npm that started the script,
 * which is let go of and heard no more. Heard with `process.once`, as the
 * commands heard Ctrl-C. Started with an IPC channel for it
 * ({@link STOP_CHANNEL_VARIABLE}), the run hears {@link STOP_MESSAGE} as
 * Ctrl-C too; the channel is let go of at once, so it never keeps alive a
 * run whose work is done.
 *
 * @returns What lets them go, once the run is over.
 */
export function onStopSignal(stop: (signal: StopSignal) => void): () => void {
  const listeners = new Map<StopSignal, () => void>();
  /**
   * Of each signal, what takes its relay once a stop came on it, and does
   * nothing before. Added before the stop's own listener, it is still there
   * once `process.once` let that one go: a signal with no listener at all,
   * for an instant, is the platform's, and ends the process. And it is
   * called before that listener for the stop's own signal, so the stop is
   * never taken for its relay.
   */
  const holds = new Map<StopSignal, () => void>();
  let message: ((sent: unknown) => void) | undefined;
  /** The signal a stop came on, while its relay may still come. */
  let relayOf: { signal: StopSignal; timer?: ReturnType<typeof setTimeout> } | undefined;
  const letGo = (signal: StopSignal): void => {
    const hold = holds.get(signal);
    if (hold) process.off(signal, hold);
    holds.delete(signal);
    if (relayOf?.signal === signal) {
      clearTimeout(relayOf.timer);
      relayOf = undefined;
    }
  };
  const letStopsGo = (): void => {
    for (const [signal, listener] of listeners) process.off(signal, listener);
    listeners.clear();
    if (message) process.off('message', message);
    message = undefined;
  };
  const release = (): void => {
    letStopsGo();
    for (const signal of STOP_SIGNALS) letGo(signal);
  };
  for (const signal of STOP_SIGNALS) {
    const hold = (): void => {
      if (relayOf?.signal === signal) letGo(signal);
    };
    holds.set(signal, hold);
    process.on(signal, hold);
    const listener = (): void => {
      letStopsGo();
      for (const other of STOP_SIGNALS) if (other !== signal) letGo(other);
      const held: NonNullable<typeof relayOf> = { signal };
      relayOf = held;
      const timer = setTimeout(() => letGo(signal), RELAY_WINDOW_MS);
      // Kept alive by nothing but its run. A stand-in for the timers, as a
      // test that answers every pause at once makes, may give back no handle.
      if (typeof timer === 'object') timer.unref();
      if (relayOf === held) held.timer = timer;
      stop(signal);
    };
    listeners.set(signal, listener);
    process.once(signal, listener);
  }
  if (process.env[STOP_CHANNEL_VARIABLE] === 'ipc' && typeof process.send === 'function') {
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
