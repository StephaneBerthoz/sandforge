import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DataTable } from './DataTable';
import type { DataTableColumn } from './DataTable';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

/* Mock framer-motion to render plain elements in tests */
const MOTION_KEYS = new Set([
  'variants',
  'initial',
  'animate',
  'whileHover',
  'whileTap',
  'transition',
  'exit',
]);

vi.mock('framer-motion', async () => {
  const React = await import('react');
  const makeMotion = <E extends keyof HTMLElementTagNameMap>(tag: E) =>
    React.forwardRef<HTMLElementTagNameMap[E], Record<string, unknown>>((props, ref) => {
      const filtered: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        if (!MOTION_KEYS.has(k)) filtered[k] = v;
      }
      return React.createElement(tag, { ...filtered, ref });
    });
  return {
    m: {
      div: makeMotion('div'),
      tbody: makeMotion('tbody'),
      tr: makeMotion('tr'),
    },
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  };
});

/* Mock @tanstack/react-virtual */
let mockVirtualItems: Array<{ index: number; start: number; size: number }> = [];
let mockTotalSize = 0;

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number; estimateSize: () => number; overscan: number }) => {
    const rowHeight = opts.estimateSize();
    const overscan = opts.overscan ?? 5;
    /* Simulate: visible area fits ~10 rows, plus overscan on each side */
    const visibleCount = Math.min(opts.count, 10 + overscan * 2);
    const items: Array<{ index: number; start: number; size: number }> = [];
    for (let i = 0; i < visibleCount; i++) {
      items.push({ index: i, start: i * rowHeight, size: rowHeight });
    }
    mockVirtualItems = items;
    mockTotalSize = opts.count * rowHeight;
    return {
      getVirtualItems: () => mockVirtualItems,
      getTotalSize: () => mockTotalSize,
    };
  },
}));

interface TestRow {
  id: string;
  name: string;
  count: number;
  [key: string]: unknown;
}

const columns: DataTableColumn<TestRow>[] = [
  { key: 'name', header: 'Name', sortable: true },
  { key: 'count', header: 'Count', sortable: true, align: 'right' },
];

const data: TestRow[] = [
  { id: '1', name: 'Alpha', count: 10 },
  { id: '2', name: 'Beta', count: 5 },
  { id: '3', name: 'Gamma', count: 20 },
];

const keyExtractor = (row: TestRow) => row.id;

describe('DataTable', () => {
  it('should render with data-testid', () => {
    render(<DataTable columns={columns} data={data} keyExtractor={keyExtractor} />);
    expect(screen.getByTestId('data-table')).toBeDefined();
  });

  it('should render column headers', () => {
    render(<DataTable columns={columns} data={data} keyExtractor={keyExtractor} />);
    expect(screen.getByText('Name')).toBeDefined();
    expect(screen.getByText('Count')).toBeDefined();
  });

  it('should render all data rows', () => {
    render(<DataTable columns={columns} data={data} keyExtractor={keyExtractor} />);
    expect(screen.getByText('Alpha')).toBeDefined();
    expect(screen.getByText('Beta')).toBeDefined();
    expect(screen.getByText('Gamma')).toBeDefined();
  });

  it('should render empty message when data is empty', () => {
    render(
      <DataTable
        columns={columns}
        data={[]}
        keyExtractor={keyExtractor}
        emptyMessage="Nothing here"
      />,
    );
    expect(screen.getByText('Nothing here')).toBeDefined();
  });

  it('should render default empty message when no emptyMessage prop', () => {
    render(<DataTable columns={columns} data={[]} keyExtractor={keyExtractor} />);
    expect(screen.getByText('No data available')).toBeDefined();
  });

  it('should sort ascending on first click', () => {
    render(<DataTable columns={columns} data={data} keyExtractor={keyExtractor} />);
    fireEvent.click(screen.getByText('Name'));
    const row0 = screen.getByTestId('table-row-0');
    const row1 = screen.getByTestId('table-row-1');
    const row2 = screen.getByTestId('table-row-2');
    expect(row0.textContent).toContain('Alpha');
    expect(row1.textContent).toContain('Beta');
    expect(row2.textContent).toContain('Gamma');
  });

  it('should sort descending on second click', () => {
    render(<DataTable columns={columns} data={data} keyExtractor={keyExtractor} />);
    fireEvent.click(screen.getByText('Name'));
    fireEvent.click(screen.getByText('Name'));
    const row0 = screen.getByTestId('table-row-0');
    const row2 = screen.getByTestId('table-row-2');
    expect(row0.textContent).toContain('Gamma');
    expect(row2.textContent).toContain('Alpha');
  });

  it('should clear sort on third click', () => {
    render(<DataTable columns={columns} data={data} keyExtractor={keyExtractor} />);
    fireEvent.click(screen.getByText('Name'));
    fireEvent.click(screen.getByText('Name'));
    fireEvent.click(screen.getByText('Name'));
    const row0 = screen.getByTestId('table-row-0');
    const row1 = screen.getByTestId('table-row-1');
    const row2 = screen.getByTestId('table-row-2');
    // Original order restored
    expect(row0.textContent).toContain('Alpha');
    expect(row1.textContent).toContain('Beta');
    expect(row2.textContent).toContain('Gamma');
  });

  it('should call onRowClick when a row is clicked', () => {
    const handler = vi.fn();
    render(
      <DataTable columns={columns} data={data} keyExtractor={keyExtractor} onRowClick={handler} />,
    );
    fireEvent.click(screen.getByTestId('table-row-1'));
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(data[1], 1);
  });

  it('should apply custom className', () => {
    render(
      <DataTable columns={columns} data={data} keyExtractor={keyExtractor} className="my-table" />,
    );
    expect(screen.getByTestId('data-table').className).toContain('my-table');
  });

  it('should render with custom render function', () => {
    const customColumns: DataTableColumn<TestRow>[] = [
      {
        key: 'name',
        header: 'Name',
        render: (row) => <strong data-testid="custom-cell">{row.name}</strong>,
      },
    ];
    render(<DataTable columns={customColumns} data={data} keyExtractor={keyExtractor} />);
    const customCells = screen.getAllByTestId('custom-cell');
    expect(customCells).toHaveLength(3);
    expect(customCells[0].textContent).toBe('Alpha');
  });

  it('should apply striped class on odd rows when striped is true', () => {
    render(<DataTable columns={columns} data={data} keyExtractor={keyExtractor} striped />);
    // Second row (index 1) should have the striped class
    expect(screen.getByTestId('table-row-1').className).toContain('bg-[var(--sf-bg-secondary)]');
    // First row (index 0) should not
    expect(screen.getByTestId('table-row-0').className).not.toContain(
      'bg-[var(--sf-bg-secondary)]',
    );
  });

  it('should set aria-sort on sorted column header', () => {
    render(<DataTable columns={columns} data={data} keyExtractor={keyExtractor} />);
    fireEvent.click(screen.getByText('Name'));
    const nameHeader = screen.getByText('Name').closest('th');
    expect(nameHeader?.getAttribute('aria-sort')).toBe('ascending');
  });

  it('should handle sticky header (default true)', () => {
    render(<DataTable columns={columns} data={data} keyExtractor={keyExtractor} />);
    const headerRow = screen.getByText('Name').closest('tr');
    expect(headerRow?.className).toContain('sticky');
  });

  it('should not apply sticky header when stickyHeader is false', () => {
    render(
      <DataTable columns={columns} data={data} keyExtractor={keyExtractor} stickyHeader={false} />,
    );
    const headerRow = screen.getByText('Name').closest('tr');
    expect(headerRow?.className).not.toContain('sticky');
  });

  it('should have role="grid" on the table element', () => {
    render(<DataTable columns={columns} data={data} keyExtractor={keyExtractor} />);
    const table = screen.getByRole('grid');
    expect(table).toBeDefined();
    expect(table.tagName).toBe('TABLE');
  });

  it('should set tabIndex={0} on the first row and tabIndex={-1} on others', () => {
    render(<DataTable columns={columns} data={data} keyExtractor={keyExtractor} />);
    const row0 = screen.getByTestId('table-row-0');
    const row1 = screen.getByTestId('table-row-1');
    const row2 = screen.getByTestId('table-row-2');
    expect(row0.tabIndex).toBe(0);
    expect(row1.tabIndex).toBe(-1);
    expect(row2.tabIndex).toBe(-1);
  });

  it('should have aria-selected on rows', () => {
    render(<DataTable columns={columns} data={data} keyExtractor={keyExtractor} />);
    const row0 = screen.getByTestId('table-row-0');
    // Initially no row is focused so all are aria-selected=false
    expect(row0.getAttribute('aria-selected')).toBe('false');
  });

  it('should set aria-selected=true on a clicked row', () => {
    render(<DataTable columns={columns} data={data} keyExtractor={keyExtractor} />);
    fireEvent.click(screen.getByTestId('table-row-1'));
    expect(screen.getByTestId('table-row-1').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('table-row-0').getAttribute('aria-selected')).toBe('false');
  });

  it('should navigate rows with ArrowDown and ArrowUp keys', () => {
    render(<DataTable columns={columns} data={data} keyExtractor={keyExtractor} />);
    const row0 = screen.getByTestId('table-row-0');
    // Focus the first row
    fireEvent.click(row0);
    expect(screen.getByTestId('table-row-0').getAttribute('aria-selected')).toBe('true');
    // Press ArrowDown
    fireEvent.keyDown(row0, { key: 'ArrowDown' });
    expect(screen.getByTestId('table-row-1').getAttribute('aria-selected')).toBe('true');
    // Press ArrowDown again
    fireEvent.keyDown(screen.getByTestId('table-row-1'), { key: 'ArrowDown' });
    expect(screen.getByTestId('table-row-2').getAttribute('aria-selected')).toBe('true');
    // Press ArrowUp
    fireEvent.keyDown(screen.getByTestId('table-row-2'), { key: 'ArrowUp' });
    expect(screen.getByTestId('table-row-1').getAttribute('aria-selected')).toBe('true');
  });

  it('should call onRowClick with Enter key on focused row', () => {
    const handler = vi.fn();
    render(
      <DataTable columns={columns} data={data} keyExtractor={keyExtractor} onRowClick={handler} />,
    );
    const row0 = screen.getByTestId('table-row-0');
    fireEvent.click(row0);
    fireEvent.keyDown(row0, { key: 'Enter' });
    expect(handler).toHaveBeenCalledWith(data[0], 0);
  });

  it('should have data-testid="table-row-{index}" on each row', () => {
    render(<DataTable columns={columns} data={data} keyExtractor={keyExtractor} />);
    expect(screen.getByTestId('table-row-0')).toBeDefined();
    expect(screen.getByTestId('table-row-1')).toBeDefined();
    expect(screen.getByTestId('table-row-2')).toBeDefined();
  });
});

describe('DataTable - Virtual Scrolling', () => {
  const generateLargeData = (count: number): TestRow[] =>
    Array.from({ length: count }, (_, i) => ({
      id: String(i),
      name: `Item ${String(i).padStart(4, '0')}`,
      count: i,
    }));

  it('should render only visible rows in virtual mode', () => {
    const largeData = generateLargeData(500);
    render(
      <DataTable
        columns={columns}
        data={largeData}
        keyExtractor={keyExtractor}
        enableVirtualization
        maxHeight="400px"
      />,
    );
    // With mock: 10 visible + 2*5 overscan = 20 rows max, not all 500
    const renderedRows = screen.getAllByTestId(/^table-row-/);
    expect(renderedRows.length).toBeLessThan(500);
    expect(renderedRows.length).toBeGreaterThan(0);
  });

  it('should have a virtual scroll container in virtual mode', () => {
    render(
      <DataTable columns={columns} data={data} keyExtractor={keyExtractor} enableVirtualization />,
    );
    expect(screen.getByTestId('virtual-scroll-container')).toBeDefined();
  });

  it('should not have a virtual scroll container in non-virtual mode', () => {
    render(<DataTable columns={columns} data={data} keyExtractor={keyExtractor} />);
    expect(screen.queryByTestId('virtual-scroll-container')).toBeNull();
  });

  it('should render with sorting in virtual mode', () => {
    const unsortedData: TestRow[] = [
      { id: '1', name: 'Charlie', count: 30 },
      { id: '2', name: 'Alpha', count: 10 },
      { id: '3', name: 'Bravo', count: 20 },
    ];
    render(
      <DataTable
        columns={columns}
        data={unsortedData}
        keyExtractor={keyExtractor}
        enableVirtualization
      />,
    );
    // Sort ascending by name
    fireEvent.click(screen.getByText('Name'));
    const row0 = screen.getByTestId('table-row-0');
    const row1 = screen.getByTestId('table-row-1');
    const row2 = screen.getByTestId('table-row-2');
    expect(row0.textContent).toContain('Alpha');
    expect(row1.textContent).toContain('Bravo');
    expect(row2.textContent).toContain('Charlie');
  });

  it('should render sticky header in virtual mode', () => {
    render(
      <DataTable
        columns={columns}
        data={data}
        keyExtractor={keyExtractor}
        enableVirtualization
        stickyHeader
      />,
    );
    const headerRow = screen.getByText('Name').closest('tr');
    expect(headerRow?.className).toContain('sticky');
  });

  it('should call onRowClick in virtual mode', () => {
    const handler = vi.fn();
    render(
      <DataTable
        columns={columns}
        data={data}
        keyExtractor={keyExtractor}
        enableVirtualization
        onRowClick={handler}
      />,
    );
    fireEvent.click(screen.getByTestId('table-row-1'));
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(data[1], 1);
  });

  it('should render empty state in virtual mode', () => {
    render(
      <DataTable
        columns={columns}
        data={[]}
        keyExtractor={keyExtractor}
        enableVirtualization
        emptyMessage="No virtual items"
      />,
    );
    expect(screen.getByText('No virtual items')).toBeDefined();
  });

  it('should apply absolute positioning on virtual rows', () => {
    render(
      <DataTable columns={columns} data={data} keyExtractor={keyExtractor} enableVirtualization />,
    );
    const row0 = screen.getByTestId('table-row-0');
    expect(row0.style.position).toBe('absolute');
    expect(row0.style.transform).toContain('translateY');
  });
});
