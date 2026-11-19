import { describe, it, expect } from 'vitest';
import type { MutePlan } from '@sandforge/shared';
import { muteOffered, muteRefusedForRight } from './muteOffer';

/** A plan whose bypass silences one flow, and leaves a trigger running. */
const PLAN: MutePlan = {
  assign: [{ permissionSet: 'Data_Load', label: 'Data load', permissions: ['Load_Data'] }],
  silenced: [{ objectApiName: 'Account', kind: 'flow', name: 'Welcome', permission: 'Load_Data' }],
  stillRuns: [
    { objectApiName: 'Account', kind: 'trigger', name: 'AccountTrigger', why: 'noBypass' },
  ],
};

describe('muteOffered', () => {
  it('holds a plan that silences something, and a read at the run’s start', () => {
    expect(muteOffered(PLAN)).toBe(true);
    expect(muteOffered('atStart')).toBe(true);
  });

  it('holds no plan whose sets the user the run writes as cannot assign: the run would be refused', () => {
    expect(muteOffered({ ...PLAN, cannotAssign: true })).toBe(false);
  });

  it('holds nothing before a read, nor a plan that silences nothing, whatever still runs', () => {
    expect(muteOffered({ assign: [], silenced: [], stillRuns: PLAN.stillRuns })).toBe(false);
    expect(muteOffered(null)).toBe(false);
    expect(muteOffered(undefined)).toBe(false);
  });
});

describe('muteRefusedForRight', () => {
  it('holds a plan that would silence something for a user who cannot assign its sets', () => {
    expect(muteRefusedForRight({ ...PLAN, cannotAssign: true })).toBe(true);
  });

  it('holds neither an offered plan, a read at the run’s start, nor a plan that silences nothing', () => {
    expect(muteRefusedForRight(PLAN)).toBe(false);
    expect(muteRefusedForRight('atStart')).toBe(false);
    expect(
      muteRefusedForRight({ assign: [], silenced: [], stillRuns: [], cannotAssign: true }),
    ).toBe(false);
    expect(muteRefusedForRight(null)).toBe(false);
  });
});
