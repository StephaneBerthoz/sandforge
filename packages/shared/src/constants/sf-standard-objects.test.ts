import { describe, it, expect } from 'vitest';

import {
  SF_STANDARD_OBJECTS,
  SF_READ_ONLY_OBJECTS,
  SF_BULK_API_SUPPORTED_OBJECTS,
  SF_COMMON_RELATIONSHIPS,
} from './sf-standard-objects.js';
import type { StandardObjectName } from './sf-standard-objects.js';

describe('SF_STANDARD_OBJECTS', () => {
  it('should be a non-empty array', () => {
    expect(SF_STANDARD_OBJECTS.length).toBeGreaterThan(0);
  });

  it('should contain core CRM objects', () => {
    const coreObjects: StandardObjectName[] = [
      'Account', 'Contact', 'Lead', 'Opportunity', 'Case',
    ];

    for (const obj of coreObjects) {
      expect(SF_STANDARD_OBJECTS).toContain(obj);
    }
  });

  it('should contain no duplicate entries', () => {
    const unique = new Set(SF_STANDARD_OBJECTS);
    expect(unique.size).toBe(SF_STANDARD_OBJECTS.length);
  });
});

describe('SF_READ_ONLY_OBJECTS', () => {
  it('should be a non-empty array', () => {
    expect(SF_READ_ONLY_OBJECTS.length).toBeGreaterThan(0);
  });

  it('should be a subset of SF_STANDARD_OBJECTS', () => {
    for (const obj of SF_READ_ONLY_OBJECTS) {
      expect(
        SF_STANDARD_OBJECTS as readonly string[],
        `${obj} should be in SF_STANDARD_OBJECTS`,
      ).toContain(obj);
    }
  });

  it('should contain User and Profile', () => {
    expect(SF_READ_ONLY_OBJECTS).toContain('User');
    expect(SF_READ_ONLY_OBJECTS).toContain('Profile');
  });

  it('should contain no duplicate entries', () => {
    const unique = new Set(SF_READ_ONLY_OBJECTS);
    expect(unique.size).toBe(SF_READ_ONLY_OBJECTS.length);
  });
});

describe('SF_BULK_API_SUPPORTED_OBJECTS', () => {
  it('should be a non-empty array', () => {
    expect(SF_BULK_API_SUPPORTED_OBJECTS.length).toBeGreaterThan(0);
  });

  it('should be a subset of SF_STANDARD_OBJECTS', () => {
    for (const obj of SF_BULK_API_SUPPORTED_OBJECTS) {
      expect(
        SF_STANDARD_OBJECTS as readonly string[],
        `${obj} should be in SF_STANDARD_OBJECTS`,
      ).toContain(obj);
    }
  });

  it('should not include read-only objects', () => {
    for (const readOnly of SF_READ_ONLY_OBJECTS) {
      expect(
        SF_BULK_API_SUPPORTED_OBJECTS as readonly string[],
        `${readOnly} should not be in bulk-supported objects`,
      ).not.toContain(readOnly);
    }
  });

  it('should contain no duplicate entries', () => {
    const unique = new Set(SF_BULK_API_SUPPORTED_OBJECTS);
    expect(unique.size).toBe(SF_BULK_API_SUPPORTED_OBJECTS.length);
  });
});

describe('SF_COMMON_RELATIONSHIPS', () => {
  it('should have Account as a parent with children', () => {
    expect(SF_COMMON_RELATIONSHIPS['Account']).toBeDefined();
    expect(SF_COMMON_RELATIONSHIPS['Account'].length).toBeGreaterThan(0);
  });

  it('should have Account->Contact relationship', () => {
    expect(SF_COMMON_RELATIONSHIPS['Account']).toContain('Contact');
  });

  it('should have Account->Opportunity relationship', () => {
    expect(SF_COMMON_RELATIONSHIPS['Account']).toContain('Opportunity');
  });

  it('should have Opportunity->OpportunityLineItem relationship', () => {
    expect(SF_COMMON_RELATIONSHIPS['Opportunity']).toContain('OpportunityLineItem');
  });

  it('should have all parent objects as standard objects', () => {
    for (const parent of Object.keys(SF_COMMON_RELATIONSHIPS)) {
      expect(
        SF_STANDARD_OBJECTS as readonly string[],
        `Parent ${parent} should be a standard object`,
      ).toContain(parent);
    }
  });
});
