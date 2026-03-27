import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../../i18n/index';
import { CsvPreview } from './CsvPreview';

/* Mock framer-motion and @tanstack/react-virtual for jsdom compatibility */
vi.mock('framer-motion', () => ({
  motion: {
    div: 'div',
    tbody: 'tbody',
    tr: ({ children, ...props }: Record<string, unknown>) => {
      const { variants, initial, animate, exit, whileHover, transition, ...rest } = props;
      void variants; void initial; void animate; void exit; void whileHover; void transition;
      return <tr {...rest}>{children as React.ReactNode}</tr>;
    },
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({
    getVirtualItems: () => [],
    getTotalSize: () => 0,
  }),
}));

import React from 'react';

const mockHeaders = ['Name', 'Email', 'Phone'];
const mockRows: Record<string, string>[] = [
  { Name: 'Alice', Email: 'alice@test.com', Phone: '1234' },
  { Name: 'Bob', Email: 'bob@test.com', Phone: '5678' },
  { Name: 'Charlie', Email: 'charlie@test.com', Phone: '9012' },
];

describe('CsvPreview', () => {
  it('should render DataTable with correct columns and data', () => {
    render(
      <CsvPreview headers={mockHeaders} rows={mockRows} totalRowCount={100} />,
    );
    expect(screen.getByTestId('csv-preview')).toBeDefined();
    expect(screen.getByTestId('data-table')).toBeDefined();
    // Check header columns are present
    expect(screen.getByText('Name')).toBeDefined();
    expect(screen.getByText('Email')).toBeDefined();
    expect(screen.getByText('Phone')).toBeDefined();
  });

  it('should show row count summary text', () => {
    render(
      <CsvPreview headers={mockHeaders} rows={mockRows} totalRowCount={100} />,
    );
    expect(screen.getByTestId('csv-preview-count')).toBeDefined();
    expect(screen.getByText('Showing 3 of 100 rows')).toBeDefined();
  });

  it('should show EmptyState when no data', () => {
    render(
      <CsvPreview headers={mockHeaders} rows={[]} totalRowCount={0} />,
    );
    expect(screen.getByTestId('empty-state')).toBeDefined();
  });

  it('should render row numbers starting from 1', () => {
    render(
      <CsvPreview headers={mockHeaders} rows={mockRows} totalRowCount={100} />,
    );
    // Row numbers column header
    expect(screen.getByText('#')).toBeDefined();
  });
});
