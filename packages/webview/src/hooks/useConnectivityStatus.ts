/**
 * Hook for monitoring connectivity status.
 */

import type { ConnectivityStatusResponse } from '@sandforge/shared';

import { useBridgeQuery } from './useBridgeQuery';

/** Query connectivity status (auto-fires on mount). */
export function useConnectivityStatus() {
  return useBridgeQuery<ConnectivityStatusResponse['payload']>('connectivity:status');
}
