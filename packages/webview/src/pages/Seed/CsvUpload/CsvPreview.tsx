import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { DataTable } from '../../../components/ui/DataTable';
import type { DataTableColumn } from '../../../components/ui/DataTable';
import { EmptyState } from '../../../components/ui/EmptyState';

/** Props for the CsvPreview component. */
export interface CsvPreviewProps {
  /** CSV column headers. */
  headers: string[];
  /** Preview rows (first 10 rows of CSV data). */
  rows: Record<string, string>[];
  /** Total number of rows in the full CSV file. */
  totalRowCount: number;
}

/**
 * Preview display for parsed CSV data. Shows the first 10 rows in a
 * DataTable with column headers from the CSV file. Displays a row
 * count summary below the table.
 */
export const CsvPreview: React.FC<CsvPreviewProps> = ({ headers, rows, totalRowCount }) => {
  const { t } = useTranslation();

  const columns = useMemo((): DataTableColumn<Record<string, string>>[] => {
    const rowNumCol: DataTableColumn<Record<string, string>> = {
      key: '__row_num__',
      header: '#',
      width: '50px',
      render: (_row, index) => String(index + 1),
    };
    const dataCols: DataTableColumn<Record<string, string>>[] = headers.map((h) => ({
      key: h,
      header: h,
      render: (row: Record<string, string>) => row[h] ?? '',
    }));
    return [rowNumCol, ...dataCols];
  }, [headers]);

  if (rows.length === 0) {
    return <EmptyState title={t('seed.csv.preview.noData')} module="seed" />;
  }

  return (
    <div className="flex flex-col gap-2" data-testid="csv-preview">
      <span className="text-sm font-medium text-[var(--sf-text-primary)]">
        {t('seed.csv.preview.title')}
      </span>
      <DataTable<Record<string, string>>
        columns={columns}
        data={rows}
        keyExtractor={(_row, index) => String(index)}
        striped
      />
      <span className="text-xs text-[var(--sf-text-secondary)]" data-testid="csv-preview-count">
        {t('seed.csv.preview.showing', { shown: rows.length, total: totalRowCount })}
      </span>
    </div>
  );
};
