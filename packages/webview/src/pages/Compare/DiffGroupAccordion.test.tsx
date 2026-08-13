import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { DiffGroupAccordion } from './DiffGroupAccordion';
import type { EnrichedDiff } from '@sandforge/shared';

/* jsdom gives every element a zero height, so the real virtualizer would report
   an empty window and render nothing. Same stand-in as VirtualList.test.tsx. */
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

function createDiff(overrides: Partial<EnrichedDiff> = {}): EnrichedDiff {
  return {
    category: 'ApexClass',
    changeType: 'modified',
    name: 'AccountController',
    riskLevel: 'medium',
    riskReasons: ['This is a breaking change that requires careful review.'],
    group: 'Apex Code',
    dependencies: ['ApexTrigger', 'Flow'],
    ...overrides,
  };
}

describe('DiffGroupAccordion', () => {
  it('should render empty state when no diffs', () => {
    render(<DiffGroupAccordion diffs={[]} />);
    expect(screen.getByTestId('no-diffs')).toBeDefined();
  });

  it('should render groups from diffs', () => {
    const diffs = [
      createDiff({ group: 'Apex Code' }),
      createDiff({ group: 'Data Model', category: 'CustomField', name: 'Account.Field__c' }),
    ];
    render(<DiffGroupAccordion diffs={diffs} />);
    expect(screen.getByTestId('diff-group-Apex Code')).toBeDefined();
    expect(screen.getByTestId('diff-group-Data Model')).toBeDefined();
  });

  it('should sort groups by highest risk first', () => {
    const diffs = [
      createDiff({ group: 'Configuration', riskLevel: 'low' }),
      createDiff({ group: 'Apex Code', riskLevel: 'critical' }),
    ];
    render(<DiffGroupAccordion diffs={diffs} />);
    const groups = screen.getByTestId('diff-groups');
    // Use toggle buttons to identify group order (they have unique testids)
    const toggleButtons = groups.querySelectorAll('[data-testid^="diff-group-toggle-"]');
    expect(toggleButtons[0].getAttribute('data-testid')).toBe('diff-group-toggle-Apex Code');
    expect(toggleButtons[1].getAttribute('data-testid')).toBe('diff-group-toggle-Configuration');
  });

  it('should show group change counts', () => {
    const diffs = [
      createDiff({ group: 'Apex Code', changeType: 'added' }),
      createDiff({ group: 'Apex Code', changeType: 'removed', name: 'OldClass' }),
      createDiff({ group: 'Apex Code', changeType: 'modified', name: 'ModClass' }),
    ];
    render(<DiffGroupAccordion diffs={diffs} />);
    expect(screen.getByText('3 changes')).toBeDefined();
    expect(screen.getByText('1+')).toBeDefined();
    expect(screen.getByText('1-')).toBeDefined();
    expect(screen.getByText('1~')).toBeDefined();
  });

  it('should show max risk badge for group', () => {
    const diffs = [
      createDiff({ group: 'Apex Code', riskLevel: 'low' }),
      createDiff({ group: 'Apex Code', riskLevel: 'high', name: 'HighRisk' }),
    ];
    render(<DiffGroupAccordion diffs={diffs} />);
    // The group header should show the max risk level
    const groupHeader = screen.getByTestId('diff-group-toggle-Apex Code');
    expect(groupHeader.textContent).toContain('high');
  });

  it('should expand and collapse groups', () => {
    const diffs = [createDiff({ name: 'TestClass' })];
    render(<DiffGroupAccordion diffs={diffs} />);

    // Initially collapsed
    expect(screen.queryByTestId('diff-group-items-Apex Code')).toBeNull();

    // Expand
    fireEvent.click(screen.getByTestId('diff-group-toggle-Apex Code'));
    expect(screen.getByTestId('diff-group-items-Apex Code')).toBeDefined();
    expect(screen.getByTestId('diff-item-TestClass')).toBeDefined();

    // Collapse
    fireEvent.click(screen.getByTestId('diff-group-toggle-Apex Code'));
    expect(screen.queryByTestId('diff-group-items-Apex Code')).toBeNull();
  });

  it('should display diff item details when expanded', () => {
    const diffs = [
      createDiff({
        name: 'AccountController',
        category: 'ApexClass',
        changeType: 'modified',
        riskLevel: 'medium',
        dependencies: ['ApexTrigger', 'Flow'],
      }),
    ];
    render(<DiffGroupAccordion diffs={diffs} />);

    fireEvent.click(screen.getByTestId('diff-group-toggle-Apex Code'));
    expect(screen.getByText('AccountController')).toBeDefined();
    // Category, change type, risk level, and deps appear in diff item
    const diffItem = screen.getByTestId('diff-item-AccountController');
    expect(diffItem.textContent).toContain('ApexClass');
    expect(diffItem.textContent).toContain('modified');
    expect(diffItem.textContent).toContain('medium');
    expect(diffItem.textContent).toContain('2 deps');
  });

  it('should call onSelectDiff when diff item is clicked', () => {
    const onSelect = vi.fn();
    const diff = createDiff({ name: 'TestClass' });
    render(<DiffGroupAccordion diffs={[diff]} onSelectDiff={onSelect} />);

    fireEvent.click(screen.getByTestId('diff-group-toggle-Apex Code'));
    fireEvent.click(screen.getByTestId('diff-item-TestClass'));
    expect(onSelect).toHaveBeenCalledWith(diff);
  });

  it('should show change type symbols', () => {
    const diffs = [
      createDiff({ name: 'Added', changeType: 'added', group: 'G' }),
      createDiff({ name: 'Removed', changeType: 'removed', group: 'G' }),
      createDiff({ name: 'Modified', changeType: 'modified', group: 'G' }),
    ];
    render(<DiffGroupAccordion diffs={diffs} />);

    fireEvent.click(screen.getByTestId('diff-group-toggle-G'));
    expect(screen.getByText('+')).toBeDefined();
    expect(screen.getByText('-')).toBeDefined();
    expect(screen.getByText('~')).toBeDefined();
  });

  it('should virtualize a large group instead of mounting every diff row', () => {
    const diffs = Array.from({ length: 500 }, (_, i) =>
      createDiff({ name: `Class${i}`, group: 'Apex Code' }),
    );
    render(<DiffGroupAccordion diffs={diffs} />);

    fireEvent.click(screen.getByTestId('diff-group-toggle-Apex Code'));

    // The header still accounts for all 500, but only a window of rows is mounted.
    expect(screen.getByText('500 changes')).toBeDefined();
    const rows = screen
      .getByTestId('diff-group-items-Apex Code')
      .querySelectorAll('[data-testid^="diff-item-"]');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(50);
  });

  it('should render multiple groups independently', () => {
    const diffs = [
      createDiff({ name: 'ApexItem', group: 'Apex Code' }),
      createDiff({ name: 'FieldItem', group: 'Data Model', category: 'CustomField' }),
    ];
    render(<DiffGroupAccordion diffs={diffs} />);

    // Expand only Apex Code
    fireEvent.click(screen.getByTestId('diff-group-toggle-Apex Code'));
    expect(screen.getByTestId('diff-group-items-Apex Code')).toBeDefined();
    expect(screen.queryByTestId('diff-group-items-Data Model')).toBeNull();

    // Expand Data Model too
    fireEvent.click(screen.getByTestId('diff-group-toggle-Data Model'));
    expect(screen.getByTestId('diff-group-items-Data Model')).toBeDefined();
    expect(screen.getByTestId('diff-group-items-Apex Code')).toBeDefined();
  });
});
