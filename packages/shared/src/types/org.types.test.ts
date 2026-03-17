import { describe, it, expect } from 'vitest';

import { OrgSafetyTier } from './org.types.js';
import type {
  SalesforceOrg,
  HealthProbeResult,
  OrgAppearance,
  OrgMetadata,
} from './org.types.js';

describe('OrgSafetyTier', () => {
  it('should expose all four safety tiers with correct values', () => {
    expect(OrgSafetyTier.CRITICAL).toBe('critical');
    expect(OrgSafetyTier.HIGH).toBe('high');
    expect(OrgSafetyTier.MEDIUM).toBe('medium');
    expect(OrgSafetyTier.LOW).toBe('low');
  });

  it('should have exactly four members', () => {
    const values = Object.values(OrgSafetyTier);
    expect(values).toHaveLength(4);
    expect(values).toEqual(
      expect.arrayContaining(['critical', 'high', 'medium', 'low']),
    );
  });
});

describe('SalesforceOrg', () => {
  function createSalesforceOrg(
    overrides: Partial<SalesforceOrg> = {},
  ): SalesforceOrg {
    const appearance: OrgAppearance = {
      color: '#FF5733',
      icon: 'cloud',
      position: 0,
    };

    const metadata: OrgMetadata = {
      apiVersion: '60.0',
      edition: 'Enterprise',
      features: ['API', 'Bulk API'],
    };

    return {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      alias: 'dev-sandbox',
      username: 'admin@sandbox.example.com',
      instanceUrl: 'https://cs42.salesforce.com',
      orgId: '00D000000000001',
      orgType: 'Sandbox',
      authMethod: 'oauth_web',
      safetyTier: OrgSafetyTier.LOW,
      appearance,
      metadata,
      status: 'connected',
      lastConnected: '2026-02-20T10:00:00.000Z',
      tags: ['dev', 'team-alpha'],
      ...overrides,
    };
  }

  it('should create a valid SalesforceOrg with all required fields', () => {
    const org = createSalesforceOrg();

    expect(org.id).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
    expect(org.alias).toBe('dev-sandbox');
    expect(org.username).toBe('admin@sandbox.example.com');
    expect(org.instanceUrl).toBe('https://cs42.salesforce.com');
    expect(org.orgId).toBe('00D000000000001');
    expect(org.orgType).toBe('Sandbox');
    expect(org.authMethod).toBe('oauth_web');
    expect(org.safetyTier).toBe(OrgSafetyTier.LOW);
    expect(org.status).toBe('connected');
    expect(org.tags).toEqual(['dev', 'team-alpha']);
  });

  it('should support optional sandboxType field', () => {
    const orgWithoutSandboxType = createSalesforceOrg();
    expect(orgWithoutSandboxType.sandboxType).toBeUndefined();

    const orgWithSandboxType = createSalesforceOrg({
      sandboxType: 'DeveloperPro',
    });
    expect(orgWithSandboxType.sandboxType).toBe('DeveloperPro');
  });

  it('should accept production org with CRITICAL safety tier', () => {
    const prodOrg = createSalesforceOrg({
      orgType: 'Production',
      safetyTier: OrgSafetyTier.CRITICAL,
      alias: 'production',
      tags: ['production', 'critical'],
    });

    expect(prodOrg.orgType).toBe('Production');
    expect(prodOrg.safetyTier).toBe('critical');
    expect(prodOrg.tags).toContain('production');
  });
});

describe('HealthProbeResult', () => {
  function createHealthProbe(
    overrides: Partial<HealthProbeResult> = {},
  ): HealthProbeResult {
    return {
      orgId: '00D000000000001',
      healthy: true,
      latency: 142,
      apiVersion: '60.0',
      timestamp: '2026-02-20T10:05:00.000Z',
      ...overrides,
    };
  }

  it('should create a healthy probe result', () => {
    const probe = createHealthProbe();

    expect(probe.orgId).toBe('00D000000000001');
    expect(probe.healthy).toBe(true);
    expect(probe.latency).toBe(142);
    expect(probe.apiVersion).toBe('60.0');
    expect(probe.limitsSnapshot).toBeUndefined();
  });

  it('should include optional limitsSnapshot when provided', () => {
    const probe = createHealthProbe({
      limitsSnapshot: {
        DailyApiRequests: { max: 100000, remaining: 98500 },
        DailyBulkV2QueryJobs: { max: 10000, remaining: 9999 },
      },
    });

    expect(probe.limitsSnapshot).toBeDefined();
    expect(probe.limitsSnapshot!['DailyApiRequests'].max).toBe(100000);
    expect(probe.limitsSnapshot!['DailyBulkV2QueryJobs'].remaining).toBe(9999);
  });

  it('should represent an unhealthy org with high latency', () => {
    const probe = createHealthProbe({
      healthy: false,
      latency: 12000,
    });

    expect(probe.healthy).toBe(false);
    expect(probe.latency).toBe(12000);
  });
});
