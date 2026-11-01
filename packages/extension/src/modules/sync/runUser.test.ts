import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { keepRunUser, readRunUser, RUN_USER_TIMEOUT_MS } from './runUser.js';

const USER = '005000000000001AAA';

describe('readRunUser', () => {
  it('reads the id the identity service names', async () => {
    await expect(readRunUser(async () => ({ user_id: USER }), 'run')).resolves.toBe(USER);
  });

  it('is undefined for anything that is no id, and for a target that refuses', async () => {
    await expect(readRunUser(async () => ({ user_id: 'nobody' }), 'run')).resolves.toBeUndefined();
    await expect(readRunUser(async () => ({}), 'run')).resolves.toBeUndefined();
    await expect(
      readRunUser(() => Promise.reject(new Error('INVALID_SESSION_ID')), 'run'),
    ).resolves.toBeUndefined();
    // A fake connection with no `identity` at all, as an older test's.
    await expect(
      readRunUser(() => (undefined as unknown as { identity(): never }).identity(), 'run'),
    ).resolves.toBeUndefined();
  });

  describe('on a target that does not answer', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('gives up once its bound has passed', async () => {
      const read = readRunUser(() => new Promise(() => undefined), 'run');
      let answered = false;
      void read.then(() => {
        answered = true;
      });

      await vi.advanceTimersByTimeAsync(RUN_USER_TIMEOUT_MS - 1);
      expect(answered).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      await expect(read).resolves.toBeUndefined();
    });
  });
});

describe('keepRunUser', () => {
  it('tells the recorder once the target says, past the first write if it comes late', async () => {
    let answer: (identity: { user_id: string }) => void = () => undefined;
    const identity = vi.fn(
      () =>
        new Promise<{ user_id: string }>((resolve) => {
          answer = resolve;
        }),
    );
    const runUser = vi.fn();

    keepRunUser({ runUser }, identity, 'run');

    // Asked at once, and nothing waited: the run is already on its way.
    expect(identity).toHaveBeenCalledTimes(1);
    expect(runUser).not.toHaveBeenCalled();

    answer({ user_id: USER });
    await vi.waitFor(() => expect(runUser).toHaveBeenCalledWith(USER));
    expect(runUser).toHaveBeenCalledTimes(1);
  });

  it('returns at once on a silent target, and tells the recorder nothing', async () => {
    const runUser = vi.fn();
    const silent = vi.fn(() => new Promise<{ user_id: string }>(() => undefined));

    // Synchronous: there is nothing a run could be held by.
    expect(keepRunUser({ runUser }, silent, 'run')).toBeUndefined();

    await Promise.resolve();
    expect(silent).toHaveBeenCalledTimes(1);
    expect(runUser).not.toHaveBeenCalled();
  });

  it('tells nothing of an answer that is no id', async () => {
    const runUser = vi.fn();

    keepRunUser({ runUser }, async () => ({ user_id: 'nobody' }), 'run');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runUser).not.toHaveBeenCalled();
  });

  it('asks nothing for a run that keeps no file, or a recorder that takes no user', () => {
    const identity = vi.fn(async () => ({ user_id: USER }));

    keepRunUser(undefined, identity, 'run');
    keepRunUser({}, identity, 'run');

    expect(identity).not.toHaveBeenCalled();
  });
});
