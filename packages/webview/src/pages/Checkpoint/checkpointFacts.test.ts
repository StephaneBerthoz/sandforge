import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CheckpointLeftOutCode } from '@sandforge/shared';
import {
  CHECKPOINT_NAME_MAX,
  heldPerObject,
  isCheckpointName,
  leftOutForAccess,
  objectsWithRecords,
  recordsHeld,
  refusedBeforeScope,
  roughSeconds,
  takenPerObject,
  undoCannotReasonOf,
  usableCheckpoints,
} from './checkpointFacts';
import {
  listEntry,
  perObjectScope,
  readyCheckpoint,
  scopeAnswer,
} from './testing/checkpointFixtures';
import en from '../../i18n/locales/en.json';

const PACKAGES = join(__dirname, '..', '..', '..', '..');

/** The extension's checkpoint module, whose words the page says in the interface's language. */
const MODULE = join(PACKAGES, 'extension', 'src', 'modules', 'checkpoint');

/** The checkpoint's types, which name each reason. */
const TYPES = join(PACKAGES, 'shared', 'src', 'types', 'checkpoint.types.ts');

/** The members of a union of string literals, as `export type NAME = | 'a' | 'b';` declares it. */
function unionOf<T extends string>(source: string, name: string): T[] {
  const body = new RegExp(`export type ${name} =([\\s\\S]*?);`).exec(source)?.[1];
  if (body === undefined) throw new Error(`${name} is gone: re-point this test`);
  return [...body.matchAll(/'(\w+)'/g)].map((match) => match[1] as T);
}

/** The first literal of each reason of the take's `LEFT_OUT_WORDS`, by reason. */
function leftOutWords(source: string): Map<string, string> {
  const block = /const LEFT_OUT_WORDS[^=]*= \{([\s\S]*?)\n\};/.exec(source)?.[1];
  if (block === undefined) throw new Error('LEFT_OUT_WORDS is gone: re-point this test');
  return new Map(
    [...block.matchAll(/^ {2}(\w+):\s*(['"])(.*?)\2/gm)].map((match) => [match[1], match[3]]),
  );
}

describe('checkpointFacts', () => {
  it('reads an entry of what Undo could not bring back that names no reason as one of the first, as entries made before the second say it', () => {
    expect(undoCannotReasonOf({})).toBe('onlyWithParent');
    expect(undoCannotReasonOf({ reason: 'onlyWithParent' })).toBe('onlyWithParent');
    expect(undoCannotReasonOf({ reason: 'deletedBeforeParent' })).toBe('deletedBeforeParent');
  });

  it('counts the records of every object a checkpoint holds, and the objects holding some', () => {
    const checkpoint = readyCheckpoint();
    // Account 400, Contact 2,012 and an empty Campaign.
    expect(recordsHeld(checkpoint)).toBe(2412);
    expect(objectsWithRecords(checkpoint)).toBe(2);
  });

  it('offers only the checkpoints that can be rewound to, in the order listed', () => {
    const newest = listEntry(readyCheckpoint({ checkpointId: 'ck-20261022-090000-0001' }));
    const failed = listEntry(readyCheckpoint({ checkpointId: 'ck-20261021-090000-0002' }), {
      valid: false,
      why: 'failed',
    });
    const damaged = listEntry(null, { valid: false, why: 'damaged' });
    const older = listEntry(readyCheckpoint({ checkpointId: 'ck-20261020-090000-0003' }));
    expect(
      usableCheckpoints([newest, failed, damaged, older]).map((entry) => entry.checkpointId),
    ).toEqual(['ck-20261022-090000-0001', 'ck-20261020-090000-0003']);
  });

  it('tells a take refused before its scope was read from one refused once it was counted', () => {
    const permissions = { code: 'PERMISSIONS' as const, message: 'refused' };
    // Refused at the guard: nothing of the org was read.
    expect(
      refusedBeforeScope(scopeAnswer({ objects: [], leftOut: [], refusal: permissions })),
    ).toBe(true);
    // Refused once counted: the estimate is what the refusal is about.
    expect(
      refusedBeforeScope(
        scopeAnswer({ refusal: { code: 'TOO_MANY_RECORDS', message: 'too many records' } }),
      ),
    ).toBe(false);
    expect(refusedBeforeScope(scopeAnswer({ objects: [], leftOut: [] }))).toBe(false);
  });

  it('tells an object left out for its user’s permissions by its code, whatever its words say', () => {
    expect(leftOutForAccess({ code: 'activities' })).toBe(true);
    expect(leftOutForAccess({ code: 'chatter' })).toBe(false);
    // An entry of a checkpoint taken before reasons had codes is told apart by nothing.
    expect(leftOutForAccess({})).toBe(false);
  });

  it('counts for a user’s permissions every reason of a take without View All Data and Modify All Data, and no other', () => {
    const types = readFileSync(TYPES, 'utf8');
    const access = unionOf<CheckpointLeftOutCode>(types, 'CheckpointAccessLeftOutCode');
    // Positive control: the seven reasons of a take without View All Data and Modify All Data.
    expect([...access].sort()).toEqual([
      'activities',
      'catalog',
      'filesNotProven',
      'noModifyAll',
      'noViewAll',
      'parentNotSeen',
      'settingNotProven',
    ]);
    for (const code of access) expect(leftOutForAccess({ code }), code).toBe(true);
    const others = unionOf<CheckpointLeftOutCode>(types, 'CheckpointLeftOutCode');
    expect(others.length).toBeGreaterThan(access.length);
    for (const code of others) expect(leftOutForAccess({ code }), code).toBe(false);
  });

  it('words every reason of the take as the extension words it in the file and on the command line', () => {
    const words = leftOutWords(readFileSync(join(MODULE, 'takeCheckpoint.ts'), 'utf8'));
    const said: Record<string, string> = en.checkpoint.take.leftOutReason;
    expect(words.size).toBeGreaterThan(20);
    for (const [reason, first] of words) expect(said[reason], reason).toContain(first);
    // What the take counts past its limit, worded by itself, and nothing the extension no longer gives.
    expect(Object.keys(said).sort()).toEqual([...words.keys(), 'pastTheLimit'].sort());
  });

  it('says a scope is held per object when an object is held so, or one is left out for its user’s permissions alone', () => {
    expect(heldPerObject(perObjectScope())).toBe(true);
    // Every object left out: the take is refused, and it is still one per object.
    expect(heldPerObject(perObjectScope({ objects: [] }))).toBe(true);
    const [account] = scopeAnswer().objects;
    expect(
      heldPerObject(scopeAnswer({ objects: [{ ...account, access: 'parent' }], leftOut: [] })),
    ).toBe(true);
    // With View All Data and Modify All Data, or from an answer that does not say.
    expect(heldPerObject(scopeAnswer())).toBe(false);
    expect(heldPerObject(scopeAnswer({ objects: [{ ...account, access: 'org' }] }))).toBe(false);
  });

  it('says a checkpoint was taken per object when its user lacked View All Data or Modify All Data', () => {
    const { takenBy } = readyCheckpoint();
    expect(takenPerObject({ takenBy })).toBe(false);
    expect(
      takenPerObject({ takenBy: { ...takenBy, viewAllData: false, modifyAllData: false } }),
    ).toBe(true);
    expect(takenPerObject({ takenBy: { ...takenBy, modifyAllData: false } })).toBe(true);
  });

  it('says an estimate of time to ten seconds under a minute and to the minute above', () => {
    expect(roughSeconds(3)).toBe(10);
    expect(roughSeconds(38)).toBe(40);
    expect(roughSeconds(64)).toBe(60);
    expect(roughSeconds(95)).toBe(120);
  });

  it('holds a name to the store’s rule: one line, not blank, at most 120 characters', () => {
    expect(isCheckpointName('Before UAT')).toBe(true);
    expect(isCheckpointName('  Before UAT  ')).toBe(true);
    expect(isCheckpointName('x'.repeat(CHECKPOINT_NAME_MAX))).toBe(true);
    expect(isCheckpointName(` ${'x'.repeat(CHECKPOINT_NAME_MAX)} `)).toBe(true);
    expect(isCheckpointName('x'.repeat(CHECKPOINT_NAME_MAX + 1))).toBe(false);
    expect(isCheckpointName('   ')).toBe(false);
    // A line break would split the line the command line lists it on.
    expect(isCheckpointName('Before\nUAT')).toBe(false);
    expect(isCheckpointName('Before\u0085UAT')).toBe(false);
  });
});
