import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { SoqlBuilder } from './SoqlBuilder';

const baseProps = {
  objectApiName: 'Account',
  availableFields: ['Id', 'Name', 'Industry', 'CreatedDate'],
  selectedFields: ['Id', 'Name'],
  whereClause: '',
  orderBy: '',
  limit: 0,
  onToggleField: vi.fn(),
  onWhereChange: vi.fn(),
  onOrderByChange: vi.fn(),
  onLimitChange: vi.fn(),
};

describe('SoqlBuilder', () => {
  it('should render the builder', () => {
    render(<SoqlBuilder {...baseProps} />);
    expect(screen.getByTestId('soql-builder')).toBeDefined();
  });

  it('should show SOQL preview', () => {
    render(<SoqlBuilder {...baseProps} />);
    const preview = screen.getByTestId('soql-preview');
    expect(preview.textContent).toContain('SELECT Id, Name FROM Account');
  });

  it('should include WHERE clause in preview', () => {
    render(<SoqlBuilder {...baseProps} whereClause="IsActive = true" />);
    expect(screen.getByTestId('soql-preview').textContent).toContain('WHERE IsActive = true');
  });

  it('should include ORDER BY in preview', () => {
    render(<SoqlBuilder {...baseProps} orderBy="CreatedDate DESC" />);
    expect(screen.getByTestId('soql-preview').textContent).toContain('ORDER BY CreatedDate DESC');
  });

  it('should include LIMIT in preview', () => {
    render(<SoqlBuilder {...baseProps} limit={1000} />);
    expect(screen.getByTestId('soql-preview').textContent).toContain('LIMIT 1000');
  });

  it('should show field selection buttons', () => {
    render(<SoqlBuilder {...baseProps} />);
    expect(screen.getByTestId('field-Id')).toBeDefined();
    expect(screen.getByTestId('field-Name')).toBeDefined();
    expect(screen.getByTestId('field-Industry')).toBeDefined();
  });

  it('should call onToggleField when field is clicked', () => {
    const onToggle = vi.fn();
    render(<SoqlBuilder {...baseProps} onToggleField={onToggle} />);
    fireEvent.click(screen.getByTestId('field-Industry'));
    expect(onToggle).toHaveBeenCalledWith('Industry');
  });

  it('should mark selected fields as checked', () => {
    render(<SoqlBuilder {...baseProps} />);
    expect(screen.getByTestId('field-Id').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('field-Industry').getAttribute('aria-checked')).toBe('false');
  });

  it('should show copy button', () => {
    render(<SoqlBuilder {...baseProps} />);
    expect(screen.getByTestId('copy-soql-btn')).toBeDefined();
  });

  it('should default to Id when no fields selected', () => {
    render(<SoqlBuilder {...baseProps} selectedFields={[]} />);
    expect(screen.getByTestId('soql-preview').textContent).toContain('SELECT Id FROM Account');
  });
});
