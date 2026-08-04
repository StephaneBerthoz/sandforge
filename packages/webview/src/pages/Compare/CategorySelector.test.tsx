import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import type { MetadataComponentType } from '@sandforge/shared';
import { CategorySelector, ALL_COMPONENT_TYPES, CATEGORY_GROUPS } from './CategorySelector';

describe('CategorySelector', () => {
  const defaultProps = {
    selected: [] as MetadataComponentType[],
    onChange: vi.fn(),
  };

  it('should render the category selector', () => {
    render(<CategorySelector {...defaultProps} />);
    expect(screen.getByTestId('category-selector')).toBeDefined();
  });

  it('should render all component types', () => {
    render(<CategorySelector {...defaultProps} />);
    for (const type of ALL_COMPONENT_TYPES) {
      expect(screen.getByTestId(`cat-${type}`)).toBeDefined();
    }
    expect(ALL_COMPONENT_TYPES.length).toBe(20);
  });

  it('should render 8 category groups', () => {
    render(<CategorySelector {...defaultProps} />);
    for (const group of CATEGORY_GROUPS) {
      expect(screen.getByTestId(`cat-group-${group.label}`)).toBeDefined();
    }
    expect(CATEGORY_GROUPS.length).toBe(8);
  });

  it('should show selected count', () => {
    render(<CategorySelector {...defaultProps} selected={['ApexClass', 'Flow']} />);
    expect(screen.getByText(/2\/20/)).toBeDefined();
  });

  it('should call onChange when toggling a type on', () => {
    const handler = vi.fn();
    render(<CategorySelector selected={[]} onChange={handler} />);
    fireEvent.click(screen.getByTestId('cat-ApexClass'));
    expect(handler).toHaveBeenCalledWith(['ApexClass']);
  });

  it('should call onChange when toggling a type off', () => {
    const handler = vi.fn();
    render(<CategorySelector selected={['ApexClass', 'Flow']} onChange={handler} />);
    fireEvent.click(screen.getByTestId('cat-ApexClass'));
    expect(handler).toHaveBeenCalledWith(['Flow']);
  });

  it('should select all on select all click', () => {
    const handler = vi.fn();
    render(<CategorySelector selected={[]} onChange={handler} />);
    fireEvent.click(screen.getByTestId('select-all-btn'));
    expect(handler).toHaveBeenCalledWith([...ALL_COMPONENT_TYPES]);
  });

  it('should clear all on clear click', () => {
    const handler = vi.fn();
    render(<CategorySelector selected={['ApexClass']} onChange={handler} />);
    fireEvent.click(screen.getByTestId('clear-all-btn'));
    expect(handler).toHaveBeenCalledWith([]);
  });

  it('should toggle a full group on click', () => {
    const handler = vi.fn();
    render(<CategorySelector selected={[]} onChange={handler} />);
    fireEvent.click(screen.getByTestId('cat-group-toggle-Apex Code'));
    expect(handler).toHaveBeenCalledWith(['ApexClass', 'ApexTrigger']);
  });

  it('should deselect full group when all are already selected', () => {
    const handler = vi.fn();
    render(<CategorySelector selected={['ApexClass', 'ApexTrigger']} onChange={handler} />);
    fireEvent.click(screen.getByTestId('cat-group-toggle-Apex Code'));
    expect(handler).toHaveBeenCalledWith([]);
  });

  it('should mark selected types with aria-checked', () => {
    render(<CategorySelector selected={['ApexClass']} onChange={vi.fn()} />);
    expect(screen.getByTestId('cat-ApexClass').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('cat-Flow').getAttribute('aria-checked')).toBe('false');
  });

  it('should accept custom className', () => {
    render(<CategorySelector {...defaultProps} className="custom" />);
    expect(screen.getByTestId('category-selector').className).toContain('custom');
  });
});
