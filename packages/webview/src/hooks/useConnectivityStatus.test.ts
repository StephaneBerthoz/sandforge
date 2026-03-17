import { describe, it, expect, vi } from 'vitest';

vi.mock('./useBridgeQuery', () => ({
  useBridgeQuery: vi.fn(() => ({
    data: null,
    loading: false,
    error: null,
    refetch: vi.fn(),
  })),
}));

import { useBridgeQuery } from './useBridgeQuery';
import { useConnectivityStatus } from './useConnectivityStatus';

describe('useConnectivityStatus', () => {
  it('calls useBridgeQuery with connectivity:status', () => {
    useConnectivityStatus();
    expect(useBridgeQuery).toHaveBeenCalledWith('connectivity:status');
  });
});
