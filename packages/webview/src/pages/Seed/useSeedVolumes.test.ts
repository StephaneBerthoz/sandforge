import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useSeedVolumes } from './useSeedVolumes';

describe('useSeedVolumes', () => {
  it('should initialize with empty volumes', () => {
    const { result } = renderHook(() => useSeedVolumes());

    expect(result.current.volumes).toEqual({});
  });

  it('should set volume with default batch size of 200', () => {
    const { result } = renderHook(() => useSeedVolumes());

    act(() => {
      result.current.handleChangeVolume('Account', 500);
    });

    expect(result.current.volumes['Account']).toEqual({ count: 500, batchSize: 200 });
  });

  it('should preserve existing batch size when changing volume', () => {
    const { result } = renderHook(() => useSeedVolumes());

    act(() => {
      result.current.handleChangeBatchSize('Account', 50);
    });
    act(() => {
      result.current.handleChangeVolume('Account', 300);
    });

    expect(result.current.volumes['Account']).toEqual({ count: 300, batchSize: 50 });
  });

  it('should set batch size with default count of 100', () => {
    const { result } = renderHook(() => useSeedVolumes());

    act(() => {
      result.current.handleChangeBatchSize('Contact', 25);
    });

    expect(result.current.volumes['Contact']).toEqual({ count: 100, batchSize: 25 });
  });

  it('should preserve existing count when changing batch size', () => {
    const { result } = renderHook(() => useSeedVolumes());

    act(() => {
      result.current.handleChangeVolume('Contact', 750);
    });
    act(() => {
      result.current.handleChangeBatchSize('Contact', 10);
    });

    expect(result.current.volumes['Contact']).toEqual({ count: 750, batchSize: 10 });
  });

  it('should manage volumes independently per object', () => {
    const { result } = renderHook(() => useSeedVolumes());

    act(() => {
      result.current.handleChangeVolume('Account', 100);
    });
    act(() => {
      result.current.handleChangeVolume('Contact', 200);
    });

    expect(result.current.volumes['Account']?.count).toBe(100);
    expect(result.current.volumes['Contact']?.count).toBe(200);
  });

  it('should return stable callback references', () => {
    const { result, rerender } = renderHook(() => useSeedVolumes());

    const firstVolumeRef = result.current.handleChangeVolume;
    const firstBatchRef = result.current.handleChangeBatchSize;

    rerender();

    expect(result.current.handleChangeVolume).toBe(firstVolumeRef);
    expect(result.current.handleChangeBatchSize).toBe(firstBatchRef);
  });
});
