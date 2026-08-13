import React, { useState, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import { m } from 'framer-motion';
import { cn } from '../../theme';
import { Icon } from './Icon';
import { staggerContainer, fadeIn } from '../../motion/presets';

/** Column definition for the DataTable component. */
export interface DataTableColumn<T> {
  /** Unique key identifying the column, used for data access and sorting. */
  key: string;
  /** Display header text. */
  header: string;
  /** Custom render function for cell content. */
  render?: (row: T, index: number) => React.ReactNode;
  /** Whether this column supports sorting. */
  sortable?: boolean;
  /** CSS width for the column (e.g. "200px", "30%"). */
  width?: string;
  /** Text alignment within the column. */
  align?: 'left' | 'center' | 'right';
}

/** Props for the DataTable component. */
export interface DataTableProps<T> {
  /** Column definitions. */
  columns: DataTableColumn<T>[];
  /** Data rows to display. */
  data: T[];
  /** Function to extract a unique key from each row. */
  keyExtractor: (row: T, index: number) => string;
  /** Callback when a row is clicked. */
  onRowClick?: (row: T, index: number) => void;
  /** Message displayed when data is empty. */
  emptyMessage?: string;
  /** Additional CSS classes for the root element. */
  className?: string;
  /** Whether the header row stays fixed on scroll. */
  stickyHeader?: boolean;
  /** Whether to alternate row background colors. */
  striped?: boolean;
  /** Enable virtual scrolling for large datasets. When false, renders all rows normally. */
  enableVirtualization?: boolean;
  /** Estimated height of each row in pixels (used by the virtualizer). */
  estimatedRowHeight?: number;
  /** Maximum height of the scroll container when virtualization is enabled. */
  maxHeight?: string;
}

/**
 * Largest table that still gets the entrance stagger. Each row waits 40 ms more
 * than the one before it, so the reveal grows with the row count: 50 rows take
 * ~2 s, 500 would take ~20 s of rows trickling in. Past this size the whole body
 * appears at once.
 */
export const STAGGER_MAX_ROWS = 50;

/** Sort direction type. */
type SortDirection = 'asc' | 'desc';

/** Internal sort state. */
interface SortState {
  key: string;
  direction: SortDirection;
}

/**
 * Generic data table with sortable columns, sticky header, striped rows, and empty state.
 * Supports virtual scrolling for large datasets via enableVirtualization prop.
 * All colors use design system CSS variables.
 */
export function DataTable<T extends Record<string, unknown>>({
  columns,
  data,
  keyExtractor,
  onRowClick,
  emptyMessage,
  className,
  stickyHeader = true,
  striped = false,
  enableVirtualization = false,
  estimatedRowHeight = 40,
  maxHeight = '400px',
}: DataTableProps<T>): React.ReactElement {
  const { t } = useTranslation();
  const [sort, setSort] = useState<SortState | null>(null);
  const [focusedRow, setFocusedRow] = useState<number>(-1);
  const tbodyRef = useRef<HTMLTableSectionElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const handleSort = useCallback((column: DataTableColumn<T>) => {
    if (!column.sortable) return;
    setSort((prev) => {
      if (prev?.key === column.key) {
        return prev.direction === 'asc' ? { key: column.key, direction: 'desc' } : null;
      }
      return { key: column.key, direction: 'asc' };
    });
  }, []);

  const sortedData = useMemo(() => {
    if (!sort) return data;
    const { key, direction } = sort;
    return [...data].sort((a, b) => {
      const aVal = a[key];
      const bVal = b[key];
      if (aVal === bVal) return 0;
      if (aVal == null) return 1;
      if (bVal == null) return -1;
      const cmp = aVal < bVal ? -1 : 1;
      return direction === 'asc' ? cmp : -cmp;
    });
  }, [data, sort]);

  const useStagger = sortedData.length <= STAGGER_MAX_ROWS;

  const virtualizer = useVirtualizer({
    count: enableVirtualization ? sortedData.length : 0,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => estimatedRowHeight,
    overscan: 5,
  });

  const alignClass = (align?: 'left' | 'center' | 'right'): string => {
    if (align === 'center') return 'text-center';
    if (align === 'right') return 'text-right';
    return 'text-left';
  };

  const getSortIcon = (columnKey: string): string | null => {
    if (!sort || sort.key !== columnKey) return null;
    return sort.direction === 'asc' ? 'chevron-up' : 'chevron-down';
  };

  const handleTableKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const rowCount = sortedData.length;
      if (rowCount === 0) return;

      let nextIndex = focusedRow;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        nextIndex = focusedRow < rowCount - 1 ? focusedRow + 1 : focusedRow;
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        nextIndex = focusedRow > 0 ? focusedRow - 1 : 0;
      } else if (e.key === 'Enter' && focusedRow >= 0 && onRowClick) {
        e.preventDefault();
        onRowClick(sortedData[focusedRow], focusedRow);
        return;
      } else {
        return;
      }

      setFocusedRow(nextIndex);
      const row = tbodyRef.current?.querySelector<HTMLElement>(
        `[data-testid="table-row-${nextIndex}"]`,
      );
      row?.focus();
    },
    [sortedData, focusedRow, onRowClick],
  );

  const renderHeader = () => (
    <thead>
      <tr className={cn('bg-[var(--sf-bg-secondary)]', stickyHeader && 'sticky top-0 z-10')}>
        {columns.map((col) => (
          <th
            key={col.key}
            className={cn(
              'font-semibold border-b border-[var(--sf-border)]',
              alignClass(col.align),
              col.sortable && 'select-none',
            )}
            style={{
              padding: 'var(--sf-space-2) var(--sf-space-3)',
              color: 'var(--sf-text-secondary)',
              fontSize: 'var(--sf-font-size-sm)',
              width: col.width,
            }}
            aria-sort={
              sort?.key === col.key
                ? sort.direction === 'asc'
                  ? 'ascending'
                  : 'descending'
                : undefined
            }
          >
            {/* The sort trigger is a real button: a click handler on the <th>
                alone is unreachable by keyboard, and <th> keeps the aria-sort
                semantics that a wrapping button would not carry. */}
            {col.sortable ? (
              <button
                type="button"
                onClick={() => handleSort(col)}
                className={cn(
                  'inline-flex w-full cursor-pointer items-center',
                  col.align === 'right' && 'justify-end',
                  col.align === 'center' && 'justify-center',
                )}
                style={{ gap: 'var(--sf-space-1)' }}
              >
                {col.header}
                {getSortIcon(col.key) ? (
                  <Icon name={getSortIcon(col.key) as string} className="text-xs" />
                ) : (
                  <Icon name="arrow-swap" className="text-xs opacity-30" />
                )}
              </button>
            ) : (
              <span className="inline-flex items-center" style={{ gap: 'var(--sf-space-1)' }}>
                {col.header}
              </span>
            )}
          </th>
        ))}
      </tr>
    </thead>
  );

  const renderEmptyRow = () => (
    <tr>
      <td
        colSpan={columns.length}
        className="text-center"
        style={{
          padding: 'var(--sf-space-8) var(--sf-space-4)',
          color: 'var(--sf-text-muted)',
        }}
      >
        {emptyMessage ?? t('common.noData', 'No data available')}
      </td>
    </tr>
  );

  if (enableVirtualization) {
    return (
      <div
        data-testid="data-table"
        className={cn('rounded-[var(--sf-radius-md)] border border-[var(--sf-border)]', className)}
      >
        <table
          className="w-full border-collapse"
          style={{ fontSize: 'var(--sf-font-size)' }}
          role="grid"
        >
          {renderHeader()}
        </table>
        <div
          ref={scrollContainerRef}
          data-testid="virtual-scroll-container"
          style={{ maxHeight, overflowY: 'auto' }}
        >
          {sortedData.length === 0 ? (
            <table className="w-full border-collapse" style={{ fontSize: 'var(--sf-font-size)' }}>
              <tbody>{renderEmptyRow()}</tbody>
            </table>
          ) : (
            <div
              style={{
                height: `${virtualizer.getTotalSize()}px`,
                width: '100%',
                position: 'relative',
              }}
            >
              <table className="w-full border-collapse" style={{ fontSize: 'var(--sf-font-size)' }}>
                <tbody ref={tbodyRef} onKeyDown={handleTableKeyDown}>
                  {virtualizer.getVirtualItems().map((virtualItem) => {
                    const row = sortedData[virtualItem.index];
                    const rowIndex = virtualItem.index;
                    return (
                      <tr
                        key={keyExtractor(row, rowIndex)}
                        className={cn(
                          'transition-colors hover:bg-[var(--sf-bg-hover)]',
                          onRowClick && 'cursor-pointer',
                          striped && rowIndex % 2 === 1 && 'bg-[var(--sf-bg-secondary)]',
                          focusedRow === rowIndex && 'ring-1 ring-[var(--sf-accent)] outline-none',
                        )}
                        style={{
                          transitionDuration: 'var(--sf-transition-fast)',
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          height: `${virtualItem.size}px`,
                          transform: `translateY(${virtualItem.start}px)`,
                          display: 'table-row',
                        }}
                        onClick={() => {
                          setFocusedRow(rowIndex);
                          onRowClick?.(row, rowIndex);
                        }}
                        onFocus={() => setFocusedRow(rowIndex)}
                        tabIndex={rowIndex === 0 ? 0 : -1}
                        aria-selected={focusedRow === rowIndex}
                        aria-rowindex={rowIndex + 2}
                        data-testid={`table-row-${rowIndex}`}
                      >
                        {columns.map((col) => (
                          <td
                            key={col.key}
                            className={cn(
                              'border-b border-[var(--sf-border-subtle)]',
                              alignClass(col.align),
                            )}
                            style={{
                              padding: 'var(--sf-space-2) var(--sf-space-3)',
                              color: 'var(--sf-text-primary)',
                            }}
                          >
                            {col.render ? col.render(row, rowIndex) : String(row[col.key] ?? '')}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="data-table"
      className={cn(
        'overflow-auto rounded-[var(--sf-radius-md)] border border-[var(--sf-border)]',
        className,
      )}
    >
      <table
        className="w-full border-collapse"
        style={{ fontSize: 'var(--sf-font-size)' }}
        role="grid"
      >
        {renderHeader()}
        <m.tbody
          ref={tbodyRef}
          onKeyDown={handleTableKeyDown}
          variants={useStagger ? staggerContainer : undefined}
          initial="hidden"
          animate="visible"
        >
          {sortedData.length === 0
            ? renderEmptyRow()
            : sortedData.map((row, rowIndex) => (
                <m.tr
                  key={keyExtractor(row, rowIndex)}
                  variants={useStagger ? fadeIn : undefined}
                  className={cn(
                    'transition-colors hover:bg-[var(--sf-bg-hover)]',
                    onRowClick && 'cursor-pointer',
                    striped && rowIndex % 2 === 1 && 'bg-[var(--sf-bg-secondary)]',
                    focusedRow === rowIndex && 'ring-1 ring-[var(--sf-accent)] outline-none',
                  )}
                  style={{
                    transitionDuration: 'var(--sf-transition-fast)',
                  }}
                  onClick={() => {
                    setFocusedRow(rowIndex);
                    onRowClick?.(row, rowIndex);
                  }}
                  onFocus={() => setFocusedRow(rowIndex)}
                  tabIndex={rowIndex === 0 ? 0 : -1}
                  aria-selected={focusedRow === rowIndex}
                  aria-rowindex={rowIndex + 2}
                  data-testid={`table-row-${rowIndex}`}
                >
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className={cn(
                        'border-b border-[var(--sf-border-subtle)]',
                        alignClass(col.align),
                      )}
                      style={{
                        padding: 'var(--sf-space-2) var(--sf-space-3)',
                        color: 'var(--sf-text-primary)',
                      }}
                    >
                      {col.render ? col.render(row, rowIndex) : String(row[col.key] ?? '')}
                    </td>
                  ))}
                </m.tr>
              ))}
        </m.tbody>
      </table>
    </div>
  );
}
