import { useState, useMemo, useCallback } from 'react';

/** Options for configuring the usePagination hook. */
export interface UsePaginationOptions {
  /** Total number of items across all pages. */
  totalItems: number;
  /** Initial page number (1-based). Defaults to 1. */
  initialPage?: number;
  /** Initial number of items per page. Defaults to 25. */
  initialPageSize?: number;
  /** Available page size options. Defaults to [10, 25, 50, 100]. */
  pageSizeOptions?: number[];
}

/** Return type for the usePagination hook. */
export interface UsePaginationResult {
  /** Current page number (1-based). */
  page: number;
  /** Current number of items per page. */
  pageSize: number;
  /** Total number of pages. */
  totalPages: number;
  /** Navigate to a specific page. */
  setPage: (page: number) => void;
  /** Change the page size (resets to page 1). */
  setPageSize: (size: number) => void;
  /** Go to next page (no-op if at last page). */
  nextPage: () => void;
  /** Go to previous page (no-op if at first page). */
  prevPage: () => void;
  /** Whether there is a next page. */
  canNext: boolean;
  /** Whether there is a previous page. */
  canPrev: boolean;
  /** Zero-based start index for the current page slice. */
  startIndex: number;
  /** Zero-based end index (exclusive) for the current page slice. */
  endIndex: number;
  /** Available page size options. */
  pageSizeOptions: number[];
  /** Helper to extract the current page slice from an array. */
  paginatedSlice: <T>(data: T[]) => T[];
}

/** Default page size options. */
const DEFAULT_PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

/**
 * Hook for managing client-side pagination state.
 *
 * Provides page navigation, page size control, boundary clamping,
 * and a `paginatedSlice` helper for easy data wiring.
 */
export function usePagination(options: UsePaginationOptions): UsePaginationResult {
  const {
    totalItems,
    initialPage = 1,
    initialPageSize = 25,
    pageSizeOptions = DEFAULT_PAGE_SIZE_OPTIONS,
  } = options;

  const [page, setPageRaw] = useState(initialPage);
  const [pageSize, setPageSizeRaw] = useState(initialPageSize);

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(totalItems / pageSize)),
    [totalItems, pageSize],
  );

  // Clamp page to valid range when totalPages changes
  const clampedPage = useMemo(
    () => Math.min(Math.max(1, page), totalPages),
    [page, totalPages],
  );

  const canNext = clampedPage < totalPages;
  const canPrev = clampedPage > 1;

  const startIndex = (clampedPage - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, totalItems);

  const setPage = useCallback(
    (newPage: number) => {
      setPageRaw(Math.min(Math.max(1, newPage), totalPages));
    },
    [totalPages],
  );

  const setPageSize = useCallback((size: number) => {
    setPageSizeRaw(size);
    setPageRaw(1);
  }, []);

  const nextPage = useCallback(() => {
    if (canNext) {
      setPageRaw((p) => p + 1);
    }
  }, [canNext]);

  const prevPage = useCallback(() => {
    if (canPrev) {
      setPageRaw((p) => p - 1);
    }
  }, [canPrev]);

  const paginatedSlice = useCallback(
    <T,>(data: T[]): T[] => data.slice(startIndex, endIndex),
    [startIndex, endIndex],
  );

  return {
    page: clampedPage,
    pageSize,
    totalPages,
    setPage,
    setPageSize,
    nextPage,
    prevPage,
    canNext,
    canPrev,
    startIndex,
    endIndex,
    pageSizeOptions,
    paginatedSlice,
  };
}
