import { describe, expect, it, vi } from 'vitest';
import { onStopSignal, STOP_SIGNALS, stopExitCode } from './stopSignals.js';

describe('the signals that stop a run', () => {
  it('stops a run on a SIGTERM and a SIGHUP as on a Ctrl-C, saying which', () => {
    // Jenkins aborts a build with SIGTERM, and its timeout step too: the
    // process was killed outright, and its summary never printed.
    for (const signal of STOP_SIGNALS) {
      const stop = vi.fn();
      const release = onStopSignal(stop);
      process.emit(signal);
      expect(stop).toHaveBeenCalledWith(signal);
      release();
    }
  });

  it('hears one stop, then lets every signal go, so a second ends the process', () => {
    const before = STOP_SIGNALS.map((signal) => process.listenerCount(signal));
    const stop = vi.fn();
    onStopSignal(stop);

    process.emit('SIGTERM');

    expect(stop).toHaveBeenCalledTimes(1);
    expect(STOP_SIGNALS.map((signal) => process.listenerCount(signal))).toEqual(before);
  });

  it('lets them go once the run is over, nothing heard', () => {
    const before = STOP_SIGNALS.map((signal) => process.listenerCount(signal));
    const stop = vi.fn();

    onStopSignal(stop)();

    expect(STOP_SIGNALS.map((signal) => process.listenerCount(signal))).toEqual(before);
    expect(stop).not.toHaveBeenCalled();
  });

  it('ends with the code a shell gives a process each signal ended', () => {
    expect(stopExitCode('SIGINT')).toBe(130);
    expect(stopExitCode('SIGTERM')).toBe(143);
    expect(stopExitCode('SIGHUP')).toBe(129);
  });
});
