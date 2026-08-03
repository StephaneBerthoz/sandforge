import { describe, it, expect } from 'vitest';

import { OrgSafetyTier } from './org.types.js';

describe('OrgSafetyTier', () => {
  it('should have exactly four members covering all tiers', () => {
    const values = Object.values(OrgSafetyTier);
    expect(values).toHaveLength(4);
    expect(values).toEqual(expect.arrayContaining(['critical', 'high', 'medium', 'low']));
  });
});
