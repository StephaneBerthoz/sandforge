import { describe, it, expect } from 'vitest';
import type { MutePlan } from '@sandforge/shared';
import { muteOffered } from './muteOffer';

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

  it('holds nothing before a read, nor a plan that silences nothing, whatever still runs', () => {
    expect(muteOffered({ assign: [], silenced: [], stillRuns: PLAN.stillRuns })).toBe(false);
    expect(muteOffered(null)).toBe(false);
    expect(muteOffered(undefined)).toBe(false);
  });
});
