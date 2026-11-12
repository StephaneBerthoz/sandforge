import { afterEach, describe, expect, it, vi } from 'vitest';

import { removeRunRecords } from './ForgeRunRemoval.js';
import { MemoryRemovalOrg } from '../../test/memoryRemovalOrg.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * A removal whose delete the org refuses for a record it could not lock —
 * another transaction held it — sends that record again after a wait, as a
 * write sends again a row refused so, and says so on its object.
 */

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const CONTACTS = [fakeId('003', 1), fakeId('003', 2)];

/** The memory org, a record refused for a lock for as many tries as told. */
class LockingOrg extends MemoryRemovalOrg {
  readonly locked = new Map<string, number>();
  readonly sent: string[][] = [];

  override async destroy(objectApiName: string, ids: string[]): Promise<unknown> {
    this.sent.push([...ids]);
    const locked = new Set(
      ids.filter((id) => {
        const tries = this.locked.get(id) ?? 0;
        if (tries > 0) this.locked.set(id, tries - 1);
        return tries > 0;
      }),
    );
    const rest = ids.filter((id) => !locked.has(id));
    const answers =
      rest.length > 0 ? ((await super.destroy(objectApiName, rest)) as unknown[]) : [];
    return ids.map((id) =>
      locked.has(id)
        ? {
            success: false,
            errors: [
              {
                statusCode: 'UNABLE_TO_LOCK_ROW',
                message: 'unable to obtain exclusive access to this record',
              },
            ],
          }
        : answers[rest.indexOf(id)],
    );
  }
}

/** Two contacts a run wrote ten minutes ago. */
function target(): LockingOrg {
  const org = new LockingOrg({});
  const at = new Date(Date.now() - 10 * 60_000).toISOString();
  for (const id of CONTACTS) org.add('Contact', { Id: id }, at);
  return org;
}

const OPTIONS = {
  runStartedAt: new Date(Date.now() - 11 * 60_000),
  runEndedAt: new Date(Date.now() - 9 * 60_000),
  includeChanged: false,
};

/** The removal, its waits run out at once. */
async function removed(org: LockingOrg): ReturnType<typeof removeRunRecords> {
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  const removal = removeRunRecords(org, [{ objectApiName: 'Contact', ids: CONTACTS }], OPTIONS);
  let done = false;
  void removal.finally(() => {
    done = true;
  });
  while (!done) {
    await vi.advanceTimersByTimeAsync(1_000);
    // The event loop's own turn: what the removal awaits besides its waits.
    await new Promise((resolve) => setImmediate(resolve));
  }
  return removal;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('a removal the org could not lock a record for', () => {
  it('sends that record again on its own after a wait, deletes it, and says so', async () => {
    const org = target();
    org.locked.set(CONTACTS[1], 1);

    const outcome = await removed(org);

    expect(org.sent).toEqual([CONTACTS, [CONTACTS[1]]]);
    expect(outcome.objects).toEqual([
      expect.objectContaining({
        objectApiName: 'Contact',
        deleted: 2,
        refused: 0,
        reasons: [
          'The org could not lock 1 record(s) (UNABLE_TO_LOCK_ROW), each sent again up to 3 times, a wait before each: 1 deleted.',
        ],
      }),
    ]);
  });

  it("leaves one still locked after its last send refused, with the org's words and what was tried", async () => {
    const org = target();
    // Locked through the three sends again and the second try's.
    org.locked.set(CONTACTS[0], 8);

    const outcome = await removed(org);

    expect(outcome.objects[0]).toEqual(
      expect.objectContaining({
        deleted: 1,
        refused: 1,
        reasons: [
          'The org could not lock 1 record(s) (UNABLE_TO_LOCK_ROW), each sent again up to 3 times, a wait before each: 1 still refused.',
          'Refused at first, sent again once the rest had gone: 1 refused again.',
          'UNABLE_TO_LOCK_ROW: unable to obtain exclusive access to this record',
        ],
      }),
    );
  });
});
