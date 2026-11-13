import { describe, it, expect, vi } from 'vitest';
import { ForgeRunGateError, OWNER_MAP_INACTIVE, OWNER_MAP_UNKNOWN } from './ForgeRunGate.js';
import {
  NOTHING_WRITTEN,
  ownerMapInactiveRefusal,
  ownerMapRefusalOf,
  ownerMapUnknownRefusal,
} from './ownerMapRefusal.js';

const SOURCE_OWNER = '005000000000001AAA';
const OTHER_SOURCE = '005000000000002AAA';
const INACTIVE = '005000000000003AAA';
const ACTIVE = '005000000000004AAA';
const UNKNOWN = '005000000000009AAA';
const QUEUE = '00G000000000001AAA';

/**
 * A target holding an inactive user and an active one, answering a statement
 * of users as an org does: the users it holds among those asked, no other.
 */
function target() {
  const users: Record<string, { Name: string; IsActive: boolean }> = {
    [INACTIVE]: { Name: 'Former Admin', IsActive: false },
    [ACTIVE]: { Name: 'Current Admin', IsActive: true },
  };
  return vi.fn(async (soql: string): Promise<Array<Record<string, unknown>>> =>
    Object.entries(users)
      .filter(([id]) => soql.includes(`'${id}'`))
      .map(([Id, user]) => ({ Id, ...user })),
  );
}

describe('ownerMapRefusalOf', () => {
  it('refuses a mapping to a user the target holds no user of under its own code, naming the id', async () => {
    const refused = await ownerMapRefusalOf({ [SOURCE_OWNER]: UNKNOWN }, target());

    expect(refused).toBeInstanceOf(ForgeRunGateError);
    expect(refused?.code).toBe(OWNER_MAP_UNKNOWN);
    expect(refused?.message).toBe(
      `Owners given to users the target does not hold: ${UNKNOWN}, given the records of ` +
        `${SOURCE_OWNER}. The target refuses a record owned by a user it does not hold ` +
        '(INVALID_CROSS_REFERENCE_KEY), and the run will not give it to the user it writes as ' +
        'instead of the one chosen. Give those records to a user of the target under Owners ' +
        '(Review → Controls, or --owner-map on the command line). Nothing was read or written.',
    );
  });

  it('refuses a mapping to an inactive user under its code, naming the user', async () => {
    const refused = await ownerMapRefusalOf({ [SOURCE_OWNER]: INACTIVE }, target());

    expect(refused?.code).toBe(OWNER_MAP_INACTIVE);
    expect(refused?.message).toBe(
      ownerMapInactiveRefusal([{ user: INACTIVE, name: 'Former Admin', sources: [SOURCE_OWNER] }]),
    );
  });

  it('names both in one refusal, under the code of the user the target lacks, and ends it once', async () => {
    const refused = await ownerMapRefusalOf(
      { [SOURCE_OWNER]: UNKNOWN, [OTHER_SOURCE]: INACTIVE },
      target(),
    );

    expect(refused?.code).toBe(OWNER_MAP_UNKNOWN);
    expect(refused?.message).toContain(`does not hold: ${UNKNOWN}, given the records of`);
    expect(refused?.message).toContain(
      `holds inactive: Former Admin (${INACTIVE}), given the records of ${OTHER_SOURCE}.`,
    );
    expect(refused?.message.match(/Nothing was read or written\./g)).toHaveLength(1);
    expect(refused?.message.endsWith('Nothing was read or written.')).toBe(true);
  });

  it('ends on what its caller says is true by then, once each, both users named', async () => {
    const refused = await ownerMapRefusalOf(
      { [SOURCE_OWNER]: UNKNOWN, [OTHER_SOURCE]: INACTIVE },
      target(),
      NOTHING_WRITTEN,
    );

    expect(refused?.message).not.toContain('Nothing was read');
    expect(refused?.message.match(/Nothing was written\./g)).toHaveLength(1);
    expect(refused?.message.endsWith(` ${NOTHING_WRITTEN}`)).toBe(true);
    expect(refused?.message).toContain(`holds inactive: Former Admin (${INACTIVE})`);
  });

  it('refuses nothing of a mapping to an active user, nor to a queue, which no statement of users holds', async () => {
    expect(
      await ownerMapRefusalOf({ [SOURCE_OWNER]: ACTIVE, [OTHER_SOURCE]: QUEUE }, target()),
    ).toBeUndefined();
  });

  it('refuses nothing when the target will not say which users it holds', async () => {
    const refused = await ownerMapRefusalOf({ [SOURCE_OWNER]: UNKNOWN }, async () => {
      throw new Error('INSUFFICIENT_ACCESS');
    });

    expect(refused).toBeUndefined();
  });
});

describe('ownerMapUnknownRefusal', () => {
  it('names ten users at most, and counts the others', () => {
    const unknown = Array.from({ length: 12 }, (_, n) => ({
      user: `005${String(n).padStart(12, '0')}AAA`,
      sources: [SOURCE_OWNER],
    }));

    const said = ownerMapUnknownRefusal(unknown);

    expect(said).toContain(`${unknown[9]?.user}, given the records of`);
    expect(said).not.toContain(unknown[10]?.user ?? '');
    expect(said).toContain('; and 2 more.');
  });
});
