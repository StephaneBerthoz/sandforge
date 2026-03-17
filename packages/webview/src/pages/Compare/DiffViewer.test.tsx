import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import type { CompareItem } from '@sandforge/shared';
import { DiffViewer } from './DiffViewer';

const mockItems: CompareItem[] = [
  {
    componentType: 'ApexClass',
    fullName: 'AccountController',
    status: 'modified',
    sourceValue: 'class v1',
    targetValue: 'class v2',
    severity: 'warning',
    deployable: true,
  },
  {
    componentType: 'CustomField',
    fullName: 'Account.NewField__c',
    status: 'added',
    targetValue: 'field def',
    severity: 'info',
    deployable: true,
  },
  {
    componentType: 'Flow',
    fullName: 'OldFlow',
    status: 'removed',
    sourceValue: 'flow def',
    severity: 'breaking',
    deployable: false,
  },
  {
    componentType: 'Layout',
    fullName: 'Account-Layout',
    status: 'unchanged',
    severity: 'info',
    deployable: true,
  },
];

describe('DiffViewer', () => {
  it('should render the diff card', () => {
    render(<DiffViewer items={mockItems} />);
    expect(screen.getByText('Diff Viewer')).toBeDefined();
  });

  it('should show changed item count (excluding unchanged)', () => {
    render(<DiffViewer items={mockItems} />);
    expect(screen.getByText('3 changes')).toBeDefined();
  });

  it('should not display unchanged items', () => {
    render(<DiffViewer items={mockItems} />);
    expect(screen.queryByTestId('diff-item-Account-Layout')).toBeNull();
  });

  it('should display changed items', () => {
    render(<DiffViewer items={mockItems} />);
    expect(screen.getByTestId('diff-item-AccountController')).toBeDefined();
    expect(screen.getByTestId('diff-item-Account.NewField__c')).toBeDefined();
    expect(screen.getByTestId('diff-item-OldFlow')).toBeDefined();
  });

  it('should show status badges', () => {
    render(<DiffViewer items={mockItems} />);
    expect(screen.getByText('modified')).toBeDefined();
    expect(screen.getByText('added')).toBeDefined();
    expect(screen.getByText('removed')).toBeDefined();
  });

  it('should call onSelectItem when item clicked', () => {
    const handler = vi.fn();
    render(<DiffViewer items={mockItems} onSelectItem={handler} />);
    fireEvent.click(screen.getByTestId('diff-item-AccountController'));
    expect(handler).toHaveBeenCalledWith(mockItems[0]);
  });

  it('should show inline diff when item is selected', () => {
    render(<DiffViewer items={mockItems} selectedItem={mockItems[0]} />);
    expect(screen.getByTestId('diff-content')).toBeDefined();
    expect(screen.getByText('class v1')).toBeDefined();
    expect(screen.getByText('class v2')).toBeDefined();
  });

  it('should show no data when all items are unchanged', () => {
    const unchanged: CompareItem[] = [mockItems[3]];
    render(<DiffViewer items={unchanged} />);
    expect(screen.getByText('No data available')).toBeDefined();
  });

  it('should show (empty) for missing source/target', () => {
    render(<DiffViewer items={mockItems} selectedItem={mockItems[1]} />);
    expect(screen.getByText('(empty)')).toBeDefined();
  });

  it('should accept custom className', () => {
    const { container } = render(<DiffViewer items={mockItems} className="custom" />);
    expect((container.firstChild as HTMLElement).className).toContain('custom');
  });
});
