import { useMemo } from 'react';
import { useOrgStore } from '../stores/useOrgStore';
import type { SalesforceOrg } from '@sandforge/shared';
import { isDevelopmentOrg } from '@sandforge/shared';

/** Result of sandbox detection across connected orgs. */
export interface SandboxDetectionResult {
  /** Whether any connected org is one to fill: a sandbox, a scratch or a Developer Edition org. */
  hasSandbox: boolean;
  /** The subset of orgs that are. */
  sandboxOrgs: SalesforceOrg[];
}

/**
 * Detects whether any connected org is one SandForge fills: a sandbox, a
 * scratch org or a Developer Edition org (`isDevelopmentOrg`). Only sandboxes
 * were kept, so those who connect a Trailhead playground or a scratch org
 * never saw the Home page's "Populate Sandbox" nor the banner that offers
 * Seed and Sync. Reads from useOrgStore and returns memoized detection state.
 */
export function useSandboxDetection(): SandboxDetectionResult {
  const orgs = useOrgStore((s) => s.orgs);

  return useMemo(() => {
    const sandboxOrgs = orgs.filter((o) => isDevelopmentOrg(o));
    return {
      hasSandbox: sandboxOrgs.length > 0,
      sandboxOrgs,
    };
  }, [orgs]);
}
