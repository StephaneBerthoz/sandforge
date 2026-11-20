import { describe, it, expect, vi } from 'vitest';
import { translateError } from '@sandforge/shared';
import {
  lockedRowsLine,
  lockResendDelay,
  refusedForALock,
  RESENDS_OF_A_LOCKED_ROW,
  sendLockedRowsAgain,
  stillLockedNote,
  waitUnlessStopped,
  withStillLockedNote,
} from './lockedRows.js';

/** The account a lock was met on, as the platform names it. */
const HUB = `001${'0'.repeat(11)}9AAA`;
const LOCKED_REST = `UNABLE_TO_LOCK_ROW: unable to obtain exclusive access to this record or 1 records: ${HUB}`;
const LOCKED_BULK = `UNABLE_TO_LOCK_ROW:unable to obtain exclusive access to this record or 1 records: ${HUB}:--`;
const TRIGGER_MESSAGE =
  'ParentRollup: execution of AfterInsert caused by: System.DmlException: Update failed. ' +
  `First exception on row 0 with id ${HUB}; first error: UNABLE_TO_LOCK_ROW, unable to obtain ` +
  'exclusive access to this record: []';

describe('refusedForALock', () => {
  it('reads the lock in the text of a REST refusal and of a Bulk API one', () => {
    expect(refusedForALock([LOCKED_REST])).toBe(true);
    expect(refusedForALock([LOCKED_BULK])).toBe(true);
  });

  it("reads it in a trigger's refusal whose update met the lock, by text or by code", () => {
    expect(refusedForALock([`CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY: ${TRIGGER_MESSAGE}`])).toBe(
      true,
    );
    expect(refusedForALock([`CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY:${TRIGGER_MESSAGE}:--`])).toBe(
      true,
    );
    expect(
      refusedForALock(
        ['ignored'],
        [{ statusCode: 'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY', message: TRIGGER_MESSAGE }],
      ),
    ).toBe(true);
  });

  it('reads the codes the row carries before its text', () => {
    expect(
      refusedForALock(
        [LOCKED_REST],
        [{ statusCode: 'UNABLE_TO_LOCK_ROW', message: 'unable to obtain exclusive access' }],
      ),
    ).toBe(true);
    expect(
      refusedForALock(
        [LOCKED_REST],
        [
          { statusCode: 'UNABLE_TO_LOCK_ROW', message: 'unable to obtain exclusive access' },
          { statusCode: 'REQUIRED_FIELD_MISSING', message: 'Required fields are missing' },
        ],
      ),
    ).toBe(false);
  });

  it('is no lock for another refusal, a trigger that met something else, or a call that threw', () => {
    expect(
      refusedForALock(['REQUIRED_FIELD_MISSING: Required fields are missing: [LastName]']),
    ).toBe(false);
    expect(
      refusedForALock([
        'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY: ParentRollup: execution of AfterInsert caused by: ' +
          'System.NullPointerException: Attempt to de-reference a null object',
      ]),
    ).toBe(false);
    // jsforce words a call the org refused whole with the message alone.
    expect(refusedForALock(['unable to obtain exclusive access to this record'])).toBe(false);
    expect(refusedForALock([LOCKED_REST, 'FIELD_CUSTOM_VALIDATION_EXCEPTION: Phone'])).toBe(false);
    expect(refusedForALock([])).toBe(false);
  });

  /*
   * The hint under a refused row is read by the shared catalogue, apart from
   * this: a trigger's refusal for a lock went again here, then was explained
   * as the trigger failing, and the reader told to fix it or turn it off.
   */
  it('reads a lock where the hint under the row speaks of one, and nowhere else', () => {
    const refusals = [
      LOCKED_REST,
      LOCKED_BULK,
      `CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY: ${TRIGGER_MESSAGE}`,
      `CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY:${TRIGGER_MESSAGE}:--`,
      'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY: ParentRollup: execution of AfterInsert caused by: ' +
        'System.NullPointerException: Attempt to de-reference a null object',
      `CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY: ${TRIGGER_MESSAGE.replace('UNABLE_TO_LOCK_ROW', 'FIELD_CUSTOM_VALIDATION_EXCEPTION')}`,
      'REQUIRED_FIELD_MISSING: Required fields are missing: [LastName]',
    ];
    const read = refusals.map((refusal) => ({
      refusal,
      sentAgain: refusedForALock([refusal]),
      hintOfALock:
        translateError(refusal)?.explanationKey?.startsWith('errors.rowLocked.') ?? false,
    }));
    // Positive control: both readings meet a lock and something else.
    expect(read.filter((r) => r.sentAgain)).toHaveLength(4);
    expect(read.filter((r) => r.sentAgain !== r.hintOfALock)).toEqual([]);
  });
});

describe('lockResendDelay', () => {
  it('waits two seconds at most before the first send, then twice as long before each next one', () => {
    for (let draw = 0; draw < 20; draw++) {
      expect(lockResendDelay(0)).toBeGreaterThanOrEqual(1_000);
      expect(lockResendDelay(0)).toBeLessThanOrEqual(2_000);
      expect(lockResendDelay(1)).toBeGreaterThanOrEqual(2_000);
      expect(lockResendDelay(1)).toBeLessThanOrEqual(4_000);
      expect(lockResendDelay(2)).toBeGreaterThanOrEqual(4_000);
      expect(lockResendDelay(2)).toBeLessThanOrEqual(8_000);
    }
  });
});

describe('waitUnlessStopped', () => {
  it('ends the wait as the run is cancelled', async () => {
    vi.useFakeTimers();
    try {
      const abort = new AbortController();
      let over = false;
      const waiting = waitUnlessStopped(60_000, abort.signal).then(() => {
        over = true;
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(over).toBe(false);
      abort.abort();
      await waiting;
      expect(over).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits out the delay when nothing cancels it', async () => {
    vi.useFakeTimers();
    try {
      let over = false;
      const waiting = waitUnlessStopped(2_000).then(() => {
        over = true;
      });
      await vi.advanceTimersByTimeAsync(1_999);
      expect(over).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await waiting;
      expect(over).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

/** A row's answer, as the tests below lay them. */
interface Answer {
  ok: boolean;
  error?: string;
}

const LOCKED: Answer = { ok: false, error: LOCKED_REST };
const WRITTEN: Answer = { ok: true };

/** The loop over `outcomes`, the target answering each send with the next of `rounds`. */
async function sendAgain(
  outcomes: Answer[],
  rounds: Array<(at: readonly number[]) => Answer[]>,
  stopped: () => boolean = () => false,
) {
  const sent: Array<readonly number[]> = [];
  const waits: number[] = [];
  const result = await sendLockedRowsAgain<Answer>({
    outcomes,
    locked: (answer) => !answer.ok && refusedForALock([answer.error ?? '']),
    written: (answer) => answer.ok,
    send: async (at) => {
      sent.push(at);
      return (rounds[sent.length - 1] ?? ((places) => places.map(() => LOCKED)))(at);
    },
    note: (answer, times) => ({ ...answer, error: withStillLockedNote(answer.error ?? '', times) }),
    wait: async (ms) => {
      waits.push(ms);
    },
    stopped,
  });
  return { result, sent, waits };
}

describe('sendLockedRowsAgain', () => {
  it('sends again only the rows refused for a lock, each answer in its place', async () => {
    const other: Answer = {
      ok: false,
      error: 'REQUIRED_FIELD_MISSING: Required fields are missing',
    };
    const { result, sent } = await sendAgain(
      [WRITTEN, LOCKED, other, LOCKED],
      [(at) => at.map(() => WRITTEN)],
    );

    expect(sent).toEqual([[1, 3]]);
    expect(result.outcomes).toEqual([WRITTEN, WRITTEN, other, WRITTEN]);
    expect(result).toMatchObject({ refused: 2, sentAgain: 2, written: 2, stillLocked: 0 });
  });

  it('sends a row the lock still holds again, three times at most, and says so in its answer', async () => {
    const { result, sent, waits } = await sendAgain([LOCKED, LOCKED], []);

    expect(sent).toEqual([
      [0, 1],
      [0, 1],
      [0, 1],
    ]);
    expect(sent).toHaveLength(RESENDS_OF_A_LOCKED_ROW);
    expect(waits).toHaveLength(3);
    expect(result.stillLocked).toBe(2);
    expect(result.outcomes[0].error).toBe(`${LOCKED_REST} — ${stillLockedNote(3)}`);
  });

  it('sends again only the rows still locked, and counts one refused for another reason apart', async () => {
    const other: Answer = { ok: false, error: 'FIELD_CUSTOM_VALIDATION_EXCEPTION: Phone' };
    const { result, sent } = await sendAgain(
      [LOCKED, LOCKED, LOCKED],
      [
        (at) => at.map((i) => (i === 0 ? WRITTEN : i === 1 ? other : LOCKED)),
        (at) => at.map(() => WRITTEN),
      ],
    );

    expect(sent).toEqual([[0, 1, 2], [2]]);
    expect(result.outcomes).toEqual([WRITTEN, other, WRITTEN]);
    expect(result).toMatchObject({ refused: 3, sentAgain: 3, written: 2, stillLocked: 0 });
    expect(lockedRowsLine('row(s)', result)).toContain('2 written, 1 refused for another reason');
  });

  it('sends nothing once the run is stopped, and the rows keep the refusal they had', async () => {
    const { result, sent } = await sendAgain([LOCKED, WRITTEN], [], () => true);

    expect(sent).toEqual([]);
    expect(result.outcomes[0]).toEqual(LOCKED);
    expect(result).toMatchObject({ refused: 1, sentAgain: 0, notSentAgain: 1 });
  });

  it('keeps the answer they had for the rows a send the stop cut short never reached', async () => {
    const { result, sent } = await sendAgain(
      [LOCKED, LOCKED, LOCKED],
      [(at) => at.slice(0, 1).map(() => LOCKED)],
    );

    expect(sent).toHaveLength(1);
    expect(result.outcomes[0].error).toContain(stillLockedNote(1));
    expect(result.outcomes[1]).toEqual(LOCKED);
    expect(result).toMatchObject({ sentAgain: 1, stillLocked: 1, notSentAgain: 2 });
  });

  it('sends nothing, and waits for nothing, when no row was refused for a lock', async () => {
    const { result, sent, waits } = await sendAgain([WRITTEN], []);

    expect(sent).toEqual([]);
    expect(waits).toEqual([]);
    expect(lockedRowsLine('row(s)', result)).toBeUndefined();
  });
});

describe('lockedRowsLine', () => {
  it('says how many rows were refused for the lock, how often they went, and what became of them', () => {
    expect(
      lockedRowsLine('record(s)', {
        refused: 37,
        sentAgain: 37,
        written: 35,
        stillLocked: 2,
        notSentAgain: 0,
      }),
    ).toBe(
      '37 record(s) refused because the target could not lock a record their write needed ' +
        '(UNABLE_TO_LOCK_ROW), sent again up to 3 times, waiting longer each time: 35 written, ' +
        '2 still refused for the lock',
    );
  });

  it('says what the rows a delete sent again became in the words of a delete', () => {
    // "Written" said of the records a purge deleted read as records it wrote.
    expect(
      lockedRowsLine(
        'record(s)',
        { refused: 3, sentAgain: 3, written: 2, stillLocked: 1, notSentAgain: 0 },
        'deleted',
      ),
    ).toBe(
      '3 record(s) refused because the target could not lock a record their write needed ' +
        '(UNABLE_TO_LOCK_ROW), sent again up to 3 times, waiting longer each time: 2 deleted, ' +
        '1 still refused for the lock',
    );
  });

  it('says "once" of a row sent again a single time, and the count of the others', () => {
    expect(stillLockedNote(1)).toMatch(/^sent again once,/);
    expect(stillLockedNote(3)).toMatch(/^sent again 3 times,/);
  });
});
