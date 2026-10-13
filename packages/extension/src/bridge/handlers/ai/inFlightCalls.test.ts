import { describe, it, expect } from 'vitest';
import { InFlightCalls, untilAborted } from './inFlightCalls.js';

describe('InFlightCalls', () => {
  it('aborts the call waiting under the key a stop names, and only that one', () => {
    const calls = new InFlightCalls();
    const first = calls.begin('req-1');
    const other = calls.begin('req-2');

    expect(calls.abort('req-1')).toBe(true);

    expect(first.signal.aborted).toBe(true);
    expect(other.signal.aborted).toBe(false);
  });

  it('lets a second call under a key take nothing from the first: the stop still reaches the first', () => {
    const calls = new InFlightCalls();
    const first = calls.begin('conversation-1');
    const second = calls.begin('conversation-1');

    // The second settles first; the first is still the one to stop.
    second.end();
    calls.abort('conversation-1');

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
  });

  it('leaves alone a key nothing waits under any more', () => {
    const calls = new InFlightCalls();
    const call = calls.begin('req-1');
    call.end();

    expect(calls.abort('req-1')).toBe(false);
    expect(call.signal.aborted).toBe(false);
    expect(calls.abort('never-started')).toBe(false);
  });
});

describe('untilAborted', () => {
  it('answers what the step answers while nothing stops it', async () => {
    const controller = new AbortController();

    await expect(untilAborted(Promise.resolve('catalogue'), controller.signal)).resolves.toBe(
      'catalogue',
    );
    await expect(
      untilAborted(Promise.reject(new Error('describe failed')), controller.signal),
    ).rejects.toThrow('describe failed');
  });

  it('stops waiting as soon as the signal aborts, without the step’s answer', async () => {
    const controller = new AbortController();
    let answer: (value: string) => void = () => {};
    const slow = new Promise<string>((resolve) => {
      answer = resolve;
    });

    const waited = untilAborted(slow, controller.signal);
    controller.abort();
    answer('too late');

    await expect(waited).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('does not wait at all on a step started after the stop', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      untilAborted(Promise.reject(new Error('not waited on')), controller.signal),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
