import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { windowJournalLocks, type WindowJournalLocks } from './windowJournalLocks.js';

const JOURNAL = join('/storage', 'forge-runs', 'forge-run-1.ndjson');
const RUN = { journalId: 'forge-run-1', target: 'DEV' };

describe('the journal locks of the windows of a test', () => {
  let locks: WindowJournalLocks;
  afterEach(() => locks.dispose());

  it('holds the lock a run of the open window takes, and refuses a second run of it, naming the first', () => {
    locks = windowJournalLocks();
    const window = locks.opened();

    const taken = window.take(JOURNAL, RUN);
    if ('busy' in taken) throw new Error('the lock was not taken');

    expect(window.holder(JOURNAL)).toMatchObject({ journalId: 'forge-run-1', ranFrom: 'editor' });
    expect(window.take(JOURNAL, { ...RUN, resumes: true })).toMatchObject({
      busy: { journalId: 'forge-run-1', target: 'DEV' },
    });
    taken.release();
    expect(window.holder(JOURNAL)).toBeUndefined();
  });

  it('lets the lock of a run go with its window: the window opened next finds none, and takes it', () => {
    locks = windowJournalLocks();
    const closed = locks.opened();
    expect('busy' in closed.take(JOURNAL, RUN)).toBe(false);

    const next = locks.opened();

    expect(next.holder(JOURNAL)).toBeUndefined();
    expect('busy' in next.take(JOURNAL, { ...RUN, removes: true })).toBe(false);
    expect(next.holder(JOURNAL)).toMatchObject({ removes: true });
  });
});
