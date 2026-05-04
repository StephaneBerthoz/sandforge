import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { VirtualCombobox } from './VirtualCombobox';
import type { VirtualComboboxOption } from './VirtualCombobox';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string, opts?: Record<string, unknown>) => {
      if (fallback && opts) {
        return fallback.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(opts[k] ?? ''));
      }
      return fallback ?? key;
    },
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
      scrollToIndex: vi.fn(),
    };
  },
}));

const simpleOptions: VirtualComboboxOption[] = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
  { value: 'c', label: 'Charlie' },
  { value: 'd', label: 'Delta' },
];

const optionsWithDesc: VirtualComboboxOption[] = [
  { value: 'account', label: 'Account', description: 'Standard Salesforce object' },
  { value: 'contact', label: 'Contact', description: 'Person linked to account' },
];

describe('VirtualCombobox', () => {
  it('should render with data-testid', () => {
    render(<VirtualCombobox options={simpleOptions} value="" onChange={vi.fn()} />);
    expect(screen.getByTestId('virtual-combobox')).toBeDefined();
  });

  it('should display placeholder when no value selected', () => {
    render(
      <VirtualCombobox
        options={simpleOptions}
        value=""
        onChange={vi.fn()}
        placeholder="Select an option"
      />,
    );
    expect(screen.getByText('Select an option')).toBeDefined();
  });

  it('should display selected option label', () => {
    render(<VirtualCombobox options={simpleOptions} value="b" onChange={vi.fn()} />);
    expect(screen.getByText('Beta')).toBeDefined();
  });

  it('should open dropdown on click', () => {
    render(<VirtualCombobox options={simpleOptions} value="" onChange={vi.fn()} />);
    expect(screen.queryByTestId('combobox-dropdown')).toBeNull();
    fireEvent.click(screen.getByTestId('combobox-trigger'));
    expect(screen.getByTestId('combobox-dropdown')).toBeDefined();
  });

  it('should not open when disabled', () => {
    render(<VirtualCombobox options={simpleOptions} value="" onChange={vi.fn()} disabled />);
    fireEvent.click(screen.getByTestId('combobox-trigger'));
    expect(screen.queryByTestId('combobox-dropdown')).toBeNull();
  });

  it('should filter options on search input', () => {
    render(<VirtualCombobox options={simpleOptions} value="" onChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId('combobox-trigger'));
    const searchInput = screen.getByTestId('combobox-search');
    fireEvent.change(searchInput, { target: { value: 'pha' } });
    // Only "Alpha" should match
    expect(screen.getByText('Alpha')).toBeDefined();
    expect(screen.queryByText('Beta')).toBeNull();
  });

  it('should show no results message when filter matches nothing', () => {
    render(<VirtualCombobox options={simpleOptions} value="" onChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId('combobox-trigger'));
    const searchInput = screen.getByTestId('combobox-search');
    fireEvent.change(searchInput, { target: { value: 'zzzzz' } });
    expect(screen.getByTestId('combobox-no-results')).toBeDefined();
    expect(screen.getByText('No results found')).toBeDefined();
  });

  it('should call onChange with selected value on click', () => {
    const handler = vi.fn();
    render(<VirtualCombobox options={simpleOptions} value="" onChange={handler} />);
    fireEvent.click(screen.getByTestId('combobox-trigger'));
    fireEvent.click(screen.getByTestId('combobox-option-1'));
    expect(handler).toHaveBeenCalledWith('b');
  });

  it('should close dropdown after single-select', () => {
    render(<VirtualCombobox options={simpleOptions} value="" onChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId('combobox-trigger'));
    expect(screen.getByTestId('combobox-dropdown')).toBeDefined();
    fireEvent.click(screen.getByTestId('combobox-option-0'));
    expect(screen.queryByTestId('combobox-dropdown')).toBeNull();
  });

  it('should handle multi-select mode', () => {
    const handler = vi.fn();
    render(<VirtualCombobox options={simpleOptions} value={['a']} onChange={handler} multiple />);
    fireEvent.click(screen.getByTestId('combobox-trigger'));
    // Select another option
    fireEvent.click(screen.getByTestId('combobox-option-1'));
    expect(handler).toHaveBeenCalledWith(['a', 'b']);
  });

  it('should deselect in multi-select mode', () => {
    const handler = vi.fn();
    render(
      <VirtualCombobox options={simpleOptions} value={['a', 'b']} onChange={handler} multiple />,
    );
    fireEvent.click(screen.getByTestId('combobox-trigger'));
    // Click 'Alpha' (index 0) to deselect it
    fireEvent.click(screen.getByTestId('combobox-option-0'));
    expect(handler).toHaveBeenCalledWith(['b']);
  });

  it('should show check icons for selected options in multi-select', () => {
    render(<VirtualCombobox options={simpleOptions} value={['a']} onChange={vi.fn()} multiple />);
    fireEvent.click(screen.getByTestId('combobox-trigger'));
    const checkIcons = screen.getAllByTestId('icon-check');
    expect(checkIcons.length).toBeGreaterThan(0);
  });

  it('should display count text for multiple selections', () => {
    render(
      <VirtualCombobox
        options={simpleOptions}
        value={['a', 'b', 'c']}
        onChange={vi.fn()}
        multiple
      />,
    );
    expect(screen.getByText('3 selected')).toBeDefined();
  });

  it('should navigate with keyboard ArrowDown and Enter', () => {
    const handler = vi.fn();
    render(<VirtualCombobox options={simpleOptions} value="" onChange={handler} />);
    const trigger = screen.getByTestId('combobox-trigger');
    // Open with ArrowDown
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(screen.getByTestId('combobox-dropdown')).toBeDefined();
    // Navigate down
    fireEvent.keyDown(screen.getByTestId('virtual-combobox'), { key: 'ArrowDown' });
    // Select with Enter
    fireEvent.keyDown(screen.getByTestId('virtual-combobox'), { key: 'Enter' });
    expect(handler).toHaveBeenCalledWith('b');
  });

  it('should close with Escape key', () => {
    render(<VirtualCombobox options={simpleOptions} value="" onChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId('combobox-trigger'));
    expect(screen.getByTestId('combobox-dropdown')).toBeDefined();
    fireEvent.keyDown(screen.getByTestId('virtual-combobox'), { key: 'Escape' });
    expect(screen.queryByTestId('combobox-dropdown')).toBeNull();
  });

  it('should render description text when provided', () => {
    render(<VirtualCombobox options={optionsWithDesc} value="" onChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId('combobox-trigger'));
    const descriptions = screen.getAllByTestId('option-description');
    expect(descriptions.length).toBe(2);
    expect(descriptions[0].textContent).toBe('Standard Salesforce object');
  });

  it('should handle 1000+ options without excessive DOM nodes', () => {
    const largeOptions: VirtualComboboxOption[] = Array.from({ length: 1500 }, (_, i) => ({
      value: String(i),
      label: `Option ${i}`,
    }));
    render(<VirtualCombobox options={largeOptions} value="" onChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId('combobox-trigger'));
    const renderedOptions = screen.getAllByTestId(/^combobox-option-/);
    // Virtualizer should limit DOM nodes (mock: 10 + 2*5 = 20 max)
    expect(renderedOptions.length).toBeLessThan(1500);
    expect(renderedOptions.length).toBeLessThan(50);
  });

  it('should have aria-haspopup and aria-expanded attributes', () => {
    render(<VirtualCombobox options={simpleOptions} value="" onChange={vi.fn()} />);
    const trigger = screen.getByTestId('combobox-trigger');
    expect(trigger.getAttribute('aria-haspopup')).toBe('listbox');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });

  it('should have role="listbox" on the options container', () => {
    render(<VirtualCombobox options={simpleOptions} value="" onChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId('combobox-trigger'));
    expect(screen.getByRole('listbox')).toBeDefined();
  });

  it('should have role="option" on each option', () => {
    render(<VirtualCombobox options={simpleOptions} value="" onChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId('combobox-trigger'));
    const optionElements = screen.getAllByRole('option');
    expect(optionElements.length).toBe(4);
  });

  it('should apply className to root element', () => {
    render(
      <VirtualCombobox
        options={simpleOptions}
        value=""
        onChange={vi.fn()}
        className="my-combobox"
      />,
    );
    expect(screen.getByTestId('virtual-combobox').className).toContain('my-combobox');
  });

  it('should not show search input when searchable is false', () => {
    render(
      <VirtualCombobox options={simpleOptions} value="" onChange={vi.fn()} searchable={false} />,
    );
    fireEvent.click(screen.getByTestId('combobox-trigger'));
    expect(screen.queryByTestId('combobox-search')).toBeNull();
  });
});
