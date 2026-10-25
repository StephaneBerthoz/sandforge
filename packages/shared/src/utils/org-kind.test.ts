import { describe, it, expect } from 'vitest';

import { OrgSafetyTier } from '../types/org.types.js';
import {
  expiredScratchDate,
  DEVELOPMENT_ORG_COLOR,
  PRODUCTION_ORG_COLOR,
  guardTierOf,
  isDeveloperEdition,
  isDevelopmentOrg,
  orgRegistrationOf,
  orgTypeOf,
  orgTypeToGuardTier,
  registeredOrgType,
} from './org-kind.js';

describe('isDeveloperEdition', () => {
  it('reads the edition a Developer Edition org and a Trailhead playground give, whatever its case and spaces', () => {
    expect(isDeveloperEdition('Developer Edition')).toBe(true);
    expect(isDeveloperEdition(' developer edition ')).toBe(true);
  });

  it('takes no other edition, and nothing that is not a string, for one', () => {
    expect(isDeveloperEdition('Enterprise Edition')).toBe(false);
    expect(isDeveloperEdition('Partner Developer Edition')).toBe(false);
    expect(isDeveloperEdition('')).toBe(false);
    expect(isDeveloperEdition(undefined)).toBe(false);
    expect(isDeveloperEdition(42)).toBe(false);
  });
});

describe('orgTypeOf', () => {
  it('types a scratch org as one, though it says it is a sandbox and a Developer Edition', () => {
    expect(orgTypeOf({ isScratch: true, isSandbox: true, edition: 'Developer Edition' })).toBe(
      'Scratch',
    );
  });

  it('types a sandbox as one, whatever its edition', () => {
    expect(orgTypeOf({ isSandbox: true, edition: 'Enterprise Edition' })).toBe('Sandbox');
  });

  it('types an org that is no sandbox and says it is a Developer Edition as a Developer org', () => {
    expect(orgTypeOf({ isSandbox: false, edition: 'Developer Edition' })).toBe('Developer');
  });

  it('keeps every other org a production org, one whose edition was never read too', () => {
    expect(orgTypeOf({ isSandbox: false, edition: 'Enterprise Edition' })).toBe('Production');
    expect(orgTypeOf({ isSandbox: false, edition: 'Unlimited Edition' })).toBe('Production');
    expect(orgTypeOf({ isSandbox: false })).toBe('Production');
    expect(orgTypeOf({})).toBe('Production');
  });
});

describe('registeredOrgType', () => {
  it('reads a Developer Edition org an earlier build registered as Production as a Developer org', () => {
    expect(registeredOrgType('Production', 'Developer Edition')).toBe('Developer');
  });

  it('reads a type the guard does not know as a Developer org when its edition says it is one', () => {
    expect(registeredOrgType('', 'Developer Edition')).toBe('Developer');
  });

  it('reads every other stored type as stored', () => {
    expect(registeredOrgType('Production', 'Enterprise Edition')).toBe('Production');
    expect(registeredOrgType('', undefined)).toBe('');
    expect(registeredOrgType('Production', undefined)).toBe('Production');
    expect(registeredOrgType('Sandbox', 'Developer Edition')).toBe('Sandbox');
    expect(registeredOrgType('Scratch', 'Developer Edition')).toBe('Scratch');
  });
});

describe('orgTypeToGuardTier', () => {
  it('should map Production to production', () => {
    expect(orgTypeToGuardTier('Production')).toBe('production');
  });

  it('should map Sandbox to development', () => {
    expect(orgTypeToGuardTier('Sandbox')).toBe('development');
  });

  it('should map Scratch to scratch', () => {
    expect(orgTypeToGuardTier('Scratch')).toBe('scratch');
  });

  it('should map Developer to development', () => {
    expect(orgTypeToGuardTier('Developer')).toBe('development');
  });

  it('gives a Developer Edition org registered as Production, or of a type it does not know, the development tier', () => {
    expect(orgTypeToGuardTier('Production', 'Developer Edition')).toBe('development');
    expect(orgTypeToGuardTier('', 'Developer Edition')).toBe('development');
  });

  it('leaves a sandbox and a scratch org their tier, whatever edition they say', () => {
    expect(orgTypeToGuardTier('Sandbox', 'Enterprise Edition')).toBe('development');
    expect(orgTypeToGuardTier('Scratch', 'Developer Edition')).toBe('scratch');
  });

  it('keeps a real production org, and a production org whose edition is unknown, production', () => {
    expect(orgTypeToGuardTier('Production', 'Enterprise Edition')).toBe('production');
    expect(orgTypeToGuardTier('Production', '')).toBe('production');
    expect(orgTypeToGuardTier('Production', undefined)).toBe('production');
  });

  it('should give an unknown or empty type the production tier, the most restrictive one', () => {
    expect(orgTypeToGuardTier('Unknown')).toBe('production');
    expect(orgTypeToGuardTier('')).toBe('production');
  });

  it('should not read an inherited property name as a known type', () => {
    expect(orgTypeToGuardTier('constructor')).toBe('production');
    expect(orgTypeToGuardTier('toString')).toBe('production');
  });
});

describe('guardTierOf and isDevelopmentOrg', () => {
  it('read a registered org by its type and the edition kept with it', () => {
    const legacyDe = { orgType: 'Production', metadata: { edition: 'Developer Edition' } };
    expect(guardTierOf(legacyDe)).toBe('development');
    expect(isDevelopmentOrg(legacyDe)).toBe(true);
    expect(
      isDevelopmentOrg({ orgType: 'Developer', metadata: { edition: 'Developer Edition' } }),
    ).toBe(true);
    expect(isDevelopmentOrg({ orgType: 'Sandbox' })).toBe(true);
    expect(isDevelopmentOrg({ orgType: 'Scratch' })).toBe(true);
  });

  it('take a production org, and an org the registry does not know, for a production org', () => {
    const production = { orgType: 'Production', metadata: { edition: 'Enterprise Edition' } };
    expect(guardTierOf(production)).toBe('production');
    expect(isDevelopmentOrg(production)).toBe(false);
    expect(guardTierOf(undefined)).toBe('production');
    expect(isDevelopmentOrg(undefined)).toBe(false);
  });

  it('take a sandbox marked Staging for a staging org, still no production one, and read the mark of a sandbox alone', () => {
    expect(guardTierOf({ orgType: 'Sandbox', staging: true })).toBe('staging');
    expect(isDevelopmentOrg({ orgType: 'Sandbox', staging: true })).toBe(true);
    expect(guardTierOf({ orgType: 'Sandbox', staging: false })).toBe('development');
    expect(guardTierOf({ orgType: 'Sandbox' })).toBe('development');
    expect(guardTierOf({ orgType: 'Scratch', staging: true })).toBe('scratch');
    expect(guardTierOf({ orgType: 'Developer', staging: true })).toBe('development');
    expect(
      guardTierOf({
        orgType: 'Production',
        metadata: { edition: 'Developer Edition' },
        staging: true,
      }),
    ).toBe('development');
    expect(guardTierOf({ orgType: 'Production', staging: true })).toBe('production');
  });
});

describe('orgRegistrationOf', () => {
  it('registers a production org critical and red', () => {
    expect(orgRegistrationOf('Production')).toEqual({
      safetyTier: OrgSafetyTier.CRITICAL,
      color: PRODUCTION_ORG_COLOR,
    });
  });

  it('registers a sandbox medium, and a scratch or Developer Edition org low, all blue', () => {
    expect(orgRegistrationOf('Sandbox')).toEqual({
      safetyTier: OrgSafetyTier.MEDIUM,
      color: DEVELOPMENT_ORG_COLOR,
    });
    expect(orgRegistrationOf('Scratch')).toEqual({
      safetyTier: OrgSafetyTier.LOW,
      color: DEVELOPMENT_ORG_COLOR,
    });
    expect(orgRegistrationOf('Developer')).toEqual({
      safetyTier: OrgSafetyTier.LOW,
      color: DEVELOPMENT_ORG_COLOR,
    });
  });

  it('registers a type none of these as a production org', () => {
    expect(orgRegistrationOf('Unknown').safetyTier).toBe(OrgSafetyTier.CRITICAL);
  });
});

describe('expiredScratchDate', () => {
  it('names the day a scratch org expired on once it is past, and nothing for any other org', () => {
    const scratch = (expirationDate?: string) => ({
      orgType: 'Scratch',
      metadata: { expirationDate },
    });
    expect(expiredScratchDate(scratch('2026-10-01'), '2026-10-22')).toBe('2026-10-01');
    expect(expiredScratchDate(scratch('2026-10-22'), '2026-10-22')).toBeUndefined();
    expect(expiredScratchDate(scratch(), '2026-10-22')).toBeUndefined();
    expect(
      expiredScratchDate(
        { orgType: 'Sandbox', metadata: { expirationDate: '2020-01-01' } },
        '2026-10-22',
      ),
    ).toBeUndefined();
  });
});
