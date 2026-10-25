import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  onStopSignal,
  STOP_CHANNEL_VARIABLE,
  STOP_MESSAGE,
  STOP_SIGNALS,
  stopExitCode,
} from './stopSignals.js';

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

describe('the IPC channel a parent stops a run through', () => {
  const send = Object.getOwnPropertyDescriptor(process, 'send');
  const channel = Object.getOwnPropertyDescriptor(process, 'channel');

  /** This process as one started with an IPC channel, whatever the test runner gave it. */
  function withChannel(): { unref: ReturnType<typeof vi.fn> } {
    const control = { unref: vi.fn(), ref: vi.fn() };
    Object.defineProperty(process, 'send', {
      value: () => true,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(process, 'channel', { value: control, configurable: true });
    return control;
  }

  afterEach(() => {
    for (const [key, descriptor] of [
      ['send', send],
      ['channel', channel],
    ] as const) {
      if (descriptor) Object.defineProperty(process, key, descriptor);
      else Reflect.deleteProperty(process, key);
    }
    vi.unstubAllEnvs();
  });

  it('leaves alone a channel opened for another purpose, which a test runner’s worker lives by', () => {
    // Let go of whenever there was one, it ended a worker in the middle of
    // its tests: its channel to the runner was what kept it alive.
    vi.stubEnv(STOP_CHANNEL_VARIABLE, '');
    const control = withChannel();
    const before = process.listenerCount('message');

    const release = onStopSignal(() => undefined);

    expect(process.listenerCount('message')).toBe(before);
    expect(control.unref).not.toHaveBeenCalled();
    release();
  });

  it('hears the stop message on a channel opened for it, and lets the channel go', () => {
    vi.stubEnv(STOP_CHANNEL_VARIABLE, 'ipc');
    const control = withChannel();
    const before = process.listenerCount('message');
    const stop = vi.fn();

    const release = onStopSignal(stop);
    expect(control.unref).toHaveBeenCalledTimes(1);
    process.emit('message', 'something else', undefined);
    expect(stop).not.toHaveBeenCalled();
    process.emit('message', STOP_MESSAGE, undefined);

    expect(stop).toHaveBeenCalledWith('SIGINT');
    expect(process.listenerCount('message')).toBe(before);
    release();
  });
});
