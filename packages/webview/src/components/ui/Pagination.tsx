import React from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '../../theme';

/** Props for the Pagination component. */
export interface PaginationProps {
  /** Current page (1-based). */
  page: number;
  /** Current page size. */
  pageSize: number;
  /** Total number of items across all pages. */
  totalItems: number;
  /** Total number of pages. */
  totalPages: number;
  /** Whether there is a next page. */
  canNext: boolean;
  /** Whether there is a previous page. */
  canPrev: boolean;
  /** Callback when page changes. */
  onPageChange: (page: number) => void;
  /** Callback when page size changes. */
  onPageSizeChange: (pageSize: number) => void;
  /** Available page size options. Defaults to [10, 25, 50, 100]. */
  pageSizeOptions?: number[];
  /** Additional CSS class name. */
  className?: string;
}

/** Default page size options. */
const DEFAULT_PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

/**
 * Pagination component with page navigation, page size selector, and total count display.
 *
 * Uses VSCode theme variables for consistent styling and i18n for all labels.
 */
export const Pagination: React.FC<PaginationProps> = ({
  page,
  pageSize,
  totalItems,
  totalPages,
  canNext,
  canPrev,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = DEFAULT_PAGE_SIZE_OPTIONS,
  className,
}) => {
  const { t } = useTranslation();

  const start = totalItems === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, totalItems);

  return (
    <nav
      role="navigation"
      aria-label={t('pagination.navigation', 'Pagination')}
      className={cn(
        'flex items-center justify-between gap-4 px-2 py-1.5 text-xs',
        'text-[var(--vscode-descriptionForeground,#999)]',
        className,
      )}
    >
      {/* Showing X-Y of Z */}
      <span data-testid="pagination-summary">
        {t('pagination.showing', 'Showing {{start}}-{{end}} of {{total}}', {
          start,
          end,
          total: totalItems,
        })}
      </span>

      <div className="flex items-center gap-3">
        {/* Rows per page selector */}
        <label className="flex items-center gap-1.5">
          <span>{t('pagination.rowsPerPage', 'Rows per page')}</span>
          <select
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
            className={cn(
              'px-1 py-0.5 text-xs rounded',
              'bg-[var(--vscode-input-background,#3c3c3c)]',
              'text-[var(--vscode-input-foreground,#d4d4d4)]',
              'border border-[var(--vscode-input-border,#3c3c3c)]',
            )}
            aria-label={t('pagination.rowsPerPage', 'Rows per page')}
          >
            {pageSizeOptions.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </label>

        {/* Page N of M */}
        <span data-testid="pagination-page-info">
          {t('pagination.pageOf', 'Page {{page}} of {{totalPages}}', {
            page,
            totalPages,
          })}
        </span>

        {/* Navigation buttons */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onPageChange(page - 1)}
            disabled={!canPrev}
            aria-label={t('pagination.previous', 'Previous page')}
            className={cn(
              'p-0.5 rounded',
              'hover:bg-[var(--vscode-toolbar-hoverBackground,#ffffff1a)]',
              'disabled:opacity-40 disabled:cursor-not-allowed',
            )}
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => onPageChange(page + 1)}
            disabled={!canNext}
            aria-label={t('pagination.next', 'Next page')}
            className={cn(
              'p-0.5 rounded',
              'hover:bg-[var(--vscode-toolbar-hoverBackground,#ffffff1a)]',
              'disabled:opacity-40 disabled:cursor-not-allowed',
            )}
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </nav>
  );
};
