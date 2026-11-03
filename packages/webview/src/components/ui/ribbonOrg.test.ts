import { describe, it, expect } from 'vitest';
import type { SalesforceOrg } from '@sandforge/shared';
import { isNotHeld, ribbonOrg } from './ribbonOrg';

const HELD = { id: 'org-held', alias: 'QASandbox' } as SalesforceOrg;

describe('ribbonOrg', () => {
  it('names an org this machine holds by the org itself', () => {
    expect(ribbonOrg([HELD], 'org-held', 'Another-Name')).toBe(HELD);
  });

  it('names an org this machine no longer holds by the name the page kept of it', () => {
    expect(ribbonOrg([HELD], 'org-gone', 'Frozen-Source')).toBe('Frozen-Source');
  });

  it('keeps the id of an org nothing names apart, not as its name', () => {
    // Printed as the name, the id read as an alias nobody had given.
    const org = ribbonOrg([HELD], 'org-gone', undefined);
    expect(org).toEqual({ notHeld: 'org-gone' });
    expect(isNotHeld(org)).toBe(true);
    expect(ribbonOrg([HELD], 'org-gone', '')).toEqual({ notHeld: 'org-gone' });
  });

  it('names no org before one is chosen', () => {
    expect(ribbonOrg([HELD], '')).toBeUndefined();
    expect(ribbonOrg([HELD], null)).toBeUndefined();
    expect(ribbonOrg([HELD], undefined, 'Frozen-Source')).toBe('Frozen-Source');
  });

  it('tells an org known by its id alone from one the store holds, and from a name', () => {
    expect(isNotHeld(HELD)).toBe(false);
    expect(isNotHeld('QASandbox')).toBe(false);
    expect(isNotHeld(undefined)).toBe(false);
  });
});
