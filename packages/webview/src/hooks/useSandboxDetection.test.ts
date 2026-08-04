import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useOrgStore } from '../stores/useOrgStore';
import { useSandboxDetection } from './useSandboxDetection';
import { OrgSafetyTier } from '@sandforge/shared';
import type { SalesforceOrg } from '@sandforge/shared';

function createOrg(overrides: Partial<SalesforceOrg> = {}): SalesforceOrg {
  return {
    id: 'org-1',
    alias: 'TestOrg',
    username: 'admin@test.com',
    instanceUrl: 'https://test.salesforce.com',
    orgId: '00D000000000001',
    orgType: 'Sandbox',
    authMethod: 'oauth_web',
    safetyTier: OrgSafetyTier.LOW,
    appearance: { color: '#3B82F6', icon: 'cloud', position: 0 },
    metadata: { apiVersion: '59.0', edition: 'Developer Edition', features: [] },
    status: 'connected',
    lastConnected: '2024-01-01T00:00:00Z',
    tags: [],
    ...overrides,
  };
}

describe('useSandboxDetection', () => {
  beforeEach(() => {
    useOrgStore.setState({ orgs: [] });
  });

  it('should return hasSandbox false when no orgs', () => {
    const { result } = renderHook(() => useSandboxDetection());
    expect(result.current.hasSandbox).toBe(false);
    expect(result.current.sandboxOrgs).toEqual([]);
  });

  it('should return hasSandbox true when a Sandbox org exists', () => {
    useOrgStore.setState({ orgs: [createOrg({ orgType: 'Sandbox' })] });
    const { result } = renderHook(() => useSandboxDetection());
    expect(result.current.hasSandbox).toBe(true);
    expect(result.current.sandboxOrgs).toHaveLength(1);
  });

  it('should return hasSandbox false when only Production orgs exist', () => {
    useOrgStore.setState({ orgs: [createOrg({ orgType: 'Production' })] });
    const { result } = renderHook(() => useSandboxDetection());
    expect(result.current.hasSandbox).toBe(false);
    expect(result.current.sandboxOrgs).toHaveLength(0);
  });

  it('should return multiple sandbox orgs', () => {
    useOrgStore.setState({
      orgs: [
        createOrg({ id: 'org-1', orgType: 'Sandbox' }),
        createOrg({ id: 'org-2', orgType: 'Production' }),
        createOrg({ id: 'org-3', orgType: 'Sandbox' }),
      ],
    });
    const { result } = renderHook(() => useSandboxDetection());
    expect(result.current.hasSandbox).toBe(true);
    expect(result.current.sandboxOrgs).toHaveLength(2);
  });
});
