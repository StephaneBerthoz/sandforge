import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  onStopSignal,
  RELAY_WINDOW_MS,
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
    vi.useFakeTimers();
    try {
      const before = STOP_SIGNALS.map((signal) => process.listenerCount(signal));
      const stop = vi.fn();
      onStopSignal(stop);

      process.emit('SIGTERM');

      expect(stop).toHaveBeenCalledTimes(1);
      // Every other signal at once; the same one once its relay has had time to come.
      expect(STOP_SIGNALS.map((signal) => process.listenerCount(signal))).toEqual(
        STOP_SIGNALS.map((signal, i) => (before[i] ?? 0) + (signal === 'SIGTERM' ? 1 : 0)),
      );
      vi.advanceTimersByTime(RELAY_WINDOW_MS);
      expect(STOP_SIGNALS.map((signal) => process.listenerCount(signal))).toEqual(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('takes the same signal again at once for its relay, not for a second stop: the one after ends the process', () => {
    // `npx` (npm exec) sends the script each SIGINT and SIGTERM it gets, and
    // a Ctrl-C reaches both: the script heard two, the second ended it at
    // once, and the summary of what it wrote was never printed.
    const before = process.listenerCount('SIGINT');
    const stop = vi.fn();
    onStopSignal(stop);

    process.emit('SIGINT');
    process.emit('SIGINT');

    expect(stop).toHaveBeenCalledTimes(1);
    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  it('lets the relay go with the rest once the run is over', () => {
    const before = STOP_SIGNALS.map((signal) => process.listenerCount(signal));
    const release = onStopSignal(vi.fn());

    process.emit('SIGHUP');
    release();

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

// Windows has no signals: a process asked to SIGINT ends at once.
describe.skipIf(process.platform === 'win32')('a run of a process of its own', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A script that stops on a signal as a command does, and prints its
   * summary `summaryAfter` ms later; sent SIGINT at each of `at` (ms after it
   * is ready), as a terminal and the npm that started it send theirs.
   */
  async function interrupted(
    summaryAfter: number,
    at: readonly number[],
  ): Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string }> {
    const dir = mkdtempSync(join(tmpdir(), 'sandforge-stop-'));
    dirs.push(dir);
    const file = join(dir, 'run.mts');
    const module = pathToFileURL(join(__dirname, 'stopSignals.ts')).href;
    writeFileSync(
      file,
      [
        `import { onStopSignal, stopExitCode } from ${JSON.stringify(module)};`,
        'const release = onStopSignal((signal) => {',
        "  process.stdout.write('stopping on ' + signal + '\\n');",
        '  setTimeout(() => {',
        "    process.stdout.write('summary printed\\n');",
        '    release();',
        '    process.exit(stopExitCode(signal));',
        `  }, ${summaryAfter});`,
        '});',
        "process.stdout.write('ready\\n');",
        'setInterval(() => undefined, 1_000);',
      ].join('\n'),
    );
    // Its loader in the script's own process: tsx's command would stand
    // between, and relay each signal as npm does.
    const tsx = pathToFileURL(
      createRequire(join(__dirname, 'stopSignals.ts')).resolve('tsx/esm'),
    ).href;
    const child = spawn(process.execPath, ['--import', tsx, file], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const ready = new Promise<void>((resolve) => {
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8');
        if (out.includes('ready\n')) resolve();
      });
    });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.on('close', (code, signal) => resolve({ code, signal })),
    );
    await ready;
    for (const ms of at) setTimeout(() => child.kill('SIGINT'), ms);
    return { ...(await closed), out };
  }

  it('says what it wrote when the npm that started it relays the Ctrl-C right after the terminal’s', async () => {
    const ended = await interrupted(400, [0, 20]);

    expect(ended.out).toContain('stopping on SIGINT\nsummary printed\n');
    expect(ended).toMatchObject({ code: 130, signal: null });
  }, 20_000);

  it('ends at once on a second Ctrl-C past the time a relay takes', async () => {
    const ended = await interrupted(10_000, [0, RELAY_WINDOW_MS + 300]);

    expect(ended.out).toContain('stopping on SIGINT\n');
    expect(ended.out).not.toContain('summary printed');
    expect(ended).toMatchObject({ code: null, signal: 'SIGINT' });
  }, 20_000);
});
