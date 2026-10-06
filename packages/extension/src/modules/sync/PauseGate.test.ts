import { describe, it, expect } from 'vitest';
import { PauseGate } from './PauseGate';

/** Whether `promise` has settled once the microtask queue has drained. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return done;
}

describe('PauseGate', () => {
  it('lets a run that is not paused through at once', async () => {
    const gate = new PauseGate();

    expect(await settled(gate.whilePaused())).toBe(true);
    expect(gate.isPaused).toBe(false);
  });

  it('holds a paused run until it is resumed', async () => {
    const gate = new PauseGate();
    gate.pause();

    const wait = gate.whilePaused();
    expect(await settled(wait)).toBe(false);

    gate.resume();
    expect(await settled(wait)).toBe(true);
    expect(gate.isPaused).toBe(false);
  });

  it('releases every wait under way when the run is resumed', async () => {
    const gate = new PauseGate();
    gate.pause();

    const first = gate.whilePaused();
    const second = gate.whilePaused();
    gate.resume();

    expect(await settled(Promise.all([first, second]))).toBe(true);
  });

  it('ends a pause when the run is cancelled, so the run can stop', async () => {
    const gate = new PauseGate();
    const controller = new AbortController();
    gate.pause();

    const wait = gate.whilePaused(controller.signal);
    expect(await settled(wait)).toBe(false);

    controller.abort();
    expect(await settled(wait)).toBe(true);
  });

  it('does not hold a run whose cancel came before the pause was reached', async () => {
    const gate = new PauseGate();
    const controller = new AbortController();
    controller.abort();
    gate.pause();

    expect(await settled(gate.whilePaused(controller.signal))).toBe(true);
  });

  it('holds the run again at its next stopping point when paused once more', async () => {
    const gate = new PauseGate();
    gate.pause();
    gate.pause();
    gate.resume();
    expect(await settled(gate.whilePaused())).toBe(true);

    gate.pause();
    expect(await settled(gate.whilePaused())).toBe(false);
  });
});
