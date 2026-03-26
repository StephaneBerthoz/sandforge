import { useMemo } from 'react';
import { useOrgStore } from '../stores/useOrgStore';
import type { SalesforceOrg } from '@sandforge/shared';

/** Result of sandbox detection across connected orgs. */
export interface SandboxDetectionResult {
  /** Whether any connected org has orgType 'Sandbox'. */
  hasSandbox: boolean;
  /** The subset of orgs that are sandboxes. */
  sandboxOrgs: SalesforceOrg[];
}

/**
 * Detects whether any connected org is a Sandbox.
 * Reads from useOrgStore and returns memoized sandbox detection state.
 */
export function useSandboxDetection(): SandboxDetectionResult {
  const orgs = useOrgStore((s) => s.orgs);

  return useMemo(() => {
    const sandboxOrgs = orgs.filter((o) => o.orgType === 'Sandbox');
    return {
      hasSandbox: sandboxOrgs.length > 0,
      sandboxOrgs,
    };
  }, [orgs]);
}
