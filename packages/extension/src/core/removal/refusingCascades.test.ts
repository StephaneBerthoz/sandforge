import { describe, expect, it } from 'vitest';
import { setBackToDraftOf } from './recordsToDraft';
import { alwaysRefused, REFUSING_CASCADES } from './refusingCascades';

describe('REFUSING_CASCADES', () => {
  it('meets every refusal of its table a way of its own: what is refused whatever goes first, an order past Draft set back to Draft, a closed won opportunity counted by its rows', () => {
    expect(
      REFUSING_CASCADES.filter((entry) => entry.refused === 'always').map((entry) => entry.child),
    ).toEqual(['Entitlement']);
    const drafted = REFUSING_CASCADES.filter((entry) => entry.refused === 'pastDraft').map(
      (entry) => entry.child,
    );
    expect(drafted).toEqual(['Order']);
    expect(setBackToDraftOf(drafted)).toEqual(drafted);
    expect(
      REFUSING_CASCADES.filter((entry) => entry.refused === 'closedWon').map((entry) => [
        entry.child,
        entry.rows,
      ]),
    ).toEqual([['Opportunity', { field: 'IsWon', value: true }]]);
  });
});

describe('alwaysRefused', () => {
  it('says the org refuses an entitlement’s account whatever goes first, by any case of its names, its parent checked when given', () => {
    expect(alwaysRefused('Entitlement', 'AccountId')).toBe(true);
    expect(alwaysRefused('entitlement', 'accountid', 'ACCOUNT')).toBe(true);
    expect(alwaysRefused('Entitlement', 'AccountId', 'Contact')).toBe(false);
    expect(alwaysRefused('Entitlement', 'ServiceContractId')).toBe(false);
  });

  it('says nothing of a refusal met only while a record is past Draft or closed won: those records are told apart', () => {
    expect(alwaysRefused('Order', 'AccountId', 'Account')).toBe(false);
    expect(alwaysRefused('Opportunity', 'AccountId', 'Account')).toBe(false);
  });
});
