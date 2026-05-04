import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePagination } from './usePagination';

describe('usePagination', () => {
  it('should initialize with default values', () => {
    const { result } = renderHook(() => usePagination({ totalItems: 100 }));

    expect(result.current.page).toBe(1);
    expect(result.current.pageSize).toBe(25);
    expect(result.current.totalPages).toBe(4);
    expect(result.current.canPrev).toBe(false);
    expect(result.current.canNext).toBe(true);
    expect(result.current.startIndex).toBe(0);
    expect(result.current.endIndex).toBe(25);
    expect(result.current.pageSizeOptions).toEqual([10, 25, 50, 100]);
  });

  it('should initialize with custom values', () => {
    const { result } = renderHook(() =>
      usePagination({
        totalItems: 50,
        initialPage: 2,
        initialPageSize: 10,
        pageSizeOptions: [5, 10, 20],
      }),
    );

    expect(result.current.page).toBe(2);
    expect(result.current.pageSize).toBe(10);
    expect(result.current.totalPages).toBe(5);
    expect(result.current.startIndex).toBe(10);
    expect(result.current.endIndex).toBe(20);
    expect(result.current.pageSizeOptions).toEqual([5, 10, 20]);
  });

  it('should navigate to next and previous pages', () => {
    const { result } = renderHook(() => usePagination({ totalItems: 100, initialPageSize: 25 }));

    act(() => {
      result.current.nextPage();
    });
    expect(result.current.page).toBe(2);
    expect(result.current.canPrev).toBe(true);

    act(() => {
      result.current.prevPage();
    });
    expect(result.current.page).toBe(1);
    expect(result.current.canPrev).toBe(false);
  });

  it('should clamp page at boundaries', () => {
    const { result } = renderHook(() => usePagination({ totalItems: 50, initialPageSize: 25 }));

    // Try going before page 1
    act(() => {
      result.current.prevPage();
    });
    expect(result.current.page).toBe(1);

    // Go to last page
    act(() => {
      result.current.setPage(2);
    });
    expect(result.current.page).toBe(2);
    expect(result.current.canNext).toBe(false);

    // Try going past last page
    act(() => {
      result.current.nextPage();
    });
    expect(result.current.page).toBe(2);

    // Try setting page beyond range
    act(() => {
      result.current.setPage(999);
    });
    expect(result.current.page).toBe(2);

    // Try setting page below range
    act(() => {
      result.current.setPage(0);
    });
    expect(result.current.page).toBe(1);
  });

  it('should reset to page 1 when pageSize changes', () => {
    const { result } = renderHook(() => usePagination({ totalItems: 100, initialPageSize: 25 }));

    act(() => {
      result.current.setPage(3);
    });
    expect(result.current.page).toBe(3);

    act(() => {
      result.current.setPageSize(50);
    });
    expect(result.current.page).toBe(1);
    expect(result.current.pageSize).toBe(50);
    expect(result.current.totalPages).toBe(2);
  });

  it('should compute paginatedSlice correctly', () => {
    const data = Array.from({ length: 30 }, (_, i) => `item-${i}`);

    const { result } = renderHook(() => usePagination({ totalItems: 30, initialPageSize: 10 }));

    let slice = result.current.paginatedSlice(data);
    expect(slice).toEqual(data.slice(0, 10));

    act(() => {
      result.current.setPage(2);
    });

    slice = result.current.paginatedSlice(data);
    expect(slice).toEqual(data.slice(10, 20));

    act(() => {
      result.current.setPage(3);
    });

    slice = result.current.paginatedSlice(data);
    expect(slice).toEqual(data.slice(20, 30));
  });

  it('should handle zero total items', () => {
    const { result } = renderHook(() => usePagination({ totalItems: 0 }));

    expect(result.current.page).toBe(1);
    expect(result.current.totalPages).toBe(1);
    expect(result.current.canNext).toBe(false);
    expect(result.current.canPrev).toBe(false);
    expect(result.current.startIndex).toBe(0);
    expect(result.current.endIndex).toBe(0);
  });

  it('should clamp endIndex to totalItems on last page', () => {
    const { result } = renderHook(() => usePagination({ totalItems: 27, initialPageSize: 10 }));

    act(() => {
      result.current.setPage(3);
    });

    expect(result.current.startIndex).toBe(20);
    expect(result.current.endIndex).toBe(27);
  });

  it('should adjust page when totalItems shrinks', () => {
    const { result, rerender } = renderHook(
      ({ totalItems }) => usePagination({ totalItems, initialPageSize: 10 }),
      { initialProps: { totalItems: 50 } },
    );

    act(() => {
      result.current.setPage(5);
    });
    expect(result.current.page).toBe(5);

    // Shrink totalItems so there are only 2 pages
    rerender({ totalItems: 15 });
    expect(result.current.page).toBe(2);
  });
});
