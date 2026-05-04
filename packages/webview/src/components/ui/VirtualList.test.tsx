import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VirtualList } from './VirtualList';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

/* Mock @tanstack/react-virtual */
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number; estimateSize: () => number; overscan: number }) => {
    const rowHeight = opts.estimateSize();
    const overscan = opts.overscan ?? 5;
    const visibleCount = Math.min(opts.count, 10 + overscan * 2);
    const items: Array<{ index: number; start: number; size: number }> = [];
    for (let i = 0; i < visibleCount; i++) {
      items.push({ index: i, start: i * rowHeight, size: rowHeight });
    }
    return {
      getVirtualItems: () => items,
      getTotalSize: () => opts.count * rowHeight,
    };
  },
}));

interface TestItem {
  id: string;
  label: string;
}

const generateItems = (count: number): TestItem[] =>
  Array.from({ length: count }, (_, i) => ({
    id: String(i),
    label: `Item ${i}`,
  }));

describe('VirtualList', () => {
  it('should render with data-testid', () => {
    const items = generateItems(5);
    render(
      <VirtualList
        items={items}
        renderItem={(item) => <span>{item.label}</span>}
        keyExtractor={(item) => item.id}
      />,
    );
    expect(screen.getByTestId('virtual-list')).toBeDefined();
  });

  it('should render only visible items from a large list', () => {
    const items = generateItems(500);
    render(
      <VirtualList
        items={items}
        renderItem={(item) => <span>{item.label}</span>}
        keyExtractor={(item) => item.id}
      />,
    );
    const rendered = screen.getAllByTestId(/^virtual-list-item-/);
    expect(rendered.length).toBeLessThan(500);
    expect(rendered.length).toBeGreaterThan(0);
  });

  it('should render emptyMessage when items array is empty', () => {
    render(
      <VirtualList
        items={[]}
        renderItem={() => <span />}
        keyExtractor={() => ''}
        emptyMessage="Nothing to show"
      />,
    );
    expect(screen.getByText('Nothing to show')).toBeDefined();
  });

  it('should render default empty message when no emptyMessage prop', () => {
    render(<VirtualList items={[]} renderItem={() => <span />} keyExtractor={() => ''} />);
    expect(screen.getByText('No items')).toBeDefined();
  });

  it('should have role="list" on the root element', () => {
    const items = generateItems(3);
    render(
      <VirtualList
        items={items}
        renderItem={(item) => <span>{item.label}</span>}
        keyExtractor={(item) => item.id}
      />,
    );
    expect(screen.getByRole('list')).toBeDefined();
  });

  it('should have role="listitem" on each rendered item', () => {
    const items = generateItems(3);
    render(
      <VirtualList
        items={items}
        renderItem={(item) => <span>{item.label}</span>}
        keyExtractor={(item) => item.id}
      />,
    );
    const listItems = screen.getAllByRole('listitem');
    expect(listItems.length).toBe(3);
  });

  it('should apply className to root element', () => {
    const items = generateItems(3);
    render(
      <VirtualList
        items={items}
        renderItem={(item) => <span>{item.label}</span>}
        keyExtractor={(item) => item.id}
        className="my-list"
      />,
    );
    expect(screen.getByTestId('virtual-list').className).toContain('my-list');
  });

  it('should use keyExtractor for item keys', () => {
    const items = generateItems(3);
    const keyFn = vi.fn((item: TestItem) => item.id);
    render(
      <VirtualList
        items={items}
        renderItem={(item) => <span>{item.label}</span>}
        keyExtractor={keyFn}
      />,
    );
    expect(keyFn).toHaveBeenCalledTimes(3);
  });
});
