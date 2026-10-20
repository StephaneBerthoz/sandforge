import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { Step2SelectObjects } from './Step2_SelectObjects';
import type { SeedObjectInfo } from './Step2_SelectObjects';

/**
 * Mock VirtualList to render all items directly (jsdom has no layout engine,
 * so the real @tanstack/react-virtual would not measure any visible row).
 */
vi.mock('../../components/ui/VirtualList', () => ({
  VirtualList: <T,>({
    items,
    renderItem,
    keyExtractor,
  }: {
    items: T[];
    renderItem: (item: T, index: number) => React.ReactNode;
    keyExtractor: (item: T, index: number) => string;
  }) => (
    <div data-testid="virtual-list" role="list">
      {items.map((item, index) => (
        <div key={keyExtractor(item, index)} role="listitem">
          {renderItem(item, index)}
        </div>
      ))}
    </div>
  ),
}));

const objects: SeedObjectInfo[] = [
  { apiName: 'Account', label: 'Account', recordCount: 1000, dependencies: [] },
  { apiName: 'Contact', label: 'Contact', recordCount: 5000, dependencies: ['Account'] },
  {
    apiName: 'Opportunity',
    label: 'Opportunity',
    recordCount: 200,
    dependencies: ['Account', 'Contact'],
  },
];

describe('Step2SelectObjects', () => {
  it('should render object list', () => {
    render(
      <Step2SelectObjects availableObjects={objects} selectedObjects={[]} onToggle={vi.fn()} />,
    );
    expect(screen.getByTestId('step-select-objects')).toBeDefined();
    expect(screen.getByTestId('obj-Account')).toBeDefined();
    expect(screen.getByTestId('obj-Contact')).toBeDefined();
  });

  it('should call onToggle when an object is clicked', () => {
    const onToggle = vi.fn();
    render(
      <Step2SelectObjects availableObjects={objects} selectedObjects={[]} onToggle={onToggle} />,
    );
    fireEvent.click(screen.getByTestId('obj-Account'));
    expect(onToggle).toHaveBeenCalledWith('Account');
  });

  it('should show selected state', () => {
    render(
      <Step2SelectObjects
        availableObjects={objects}
        selectedObjects={['Account']}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByTestId('obj-Account').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('obj-Contact').getAttribute('aria-checked')).toBe('false');
  });

  it('should show dependency badge', () => {
    render(
      <Step2SelectObjects availableObjects={objects} selectedObjects={[]} onToggle={vi.fn()} />,
    );
    const contactRow = screen.getByTestId('obj-Contact');
    expect(contactRow.textContent).toContain('1');
  });

  it('should show empty state when no objects', () => {
    render(<Step2SelectObjects availableObjects={[]} selectedObjects={[]} onToggle={vi.fn()} />);
    expect(screen.getByText('No objects selected')).toBeDefined();
  });

  it('should display object API names', () => {
    render(
      <Step2SelectObjects availableObjects={objects} selectedObjects={[]} onToggle={vi.fn()} />,
    );
    expect(screen.getAllByText('Account').length).toBeGreaterThan(0);
  });

  /** About 670 objects on a Developer Edition, in the order describe-global gives them. */
  const orgObjects: SeedObjectInfo[] = [
    'AcceptedEventRelation',
    'ActionCadence',
    'Opportunity',
    'Invoice__c',
    'Account',
    'Contact',
  ].map((apiName) => ({ apiName, label: apiName, recordCount: 0, dependencies: [] }));

  /** The object rows in the order they are drawn. */
  const rows = (): string[] =>
    screen
      .getAllByRole('checkbox')
      .map((row) => (row.getAttribute('data-testid') ?? '').replace(/^obj-/, ''));

  it('pins the common objects at the top, the others under them in the order the org gave', () => {
    // Opportunity sat wherever the API put it, in a frame of a few rows.
    render(
      <Step2SelectObjects availableObjects={orgObjects} selectedObjects={[]} onToggle={vi.fn()} />,
    );

    expect(rows()).toEqual([
      'Account',
      'Contact',
      'Opportunity',
      'AcceptedEventRelation',
      'ActionCadence',
      'Invoice__c',
    ]);
    expect(screen.getByTestId('seed-common-objects').textContent).toContain('Common objects');
  });

  it('finds an object by a part of its name', () => {
    render(
      <Step2SelectObjects availableObjects={orgObjects} selectedObjects={[]} onToggle={vi.fn()} />,
    );

    fireEvent.change(screen.getByTestId('seed-object-search'), { target: { value: 'invo' } });
    expect(rows()).toEqual(['Invoice__c']);

    fireEvent.change(screen.getByTestId('seed-object-search'), { target: { value: 'nothing' } });
    expect(screen.queryAllByRole('checkbox')).toEqual([]);
    expect(screen.getByText('No objects selected')).toBeDefined();
  });

  it('offers the parent of an object ticked without it', () => {
    const onToggle = vi.fn();
    render(
      <Step2SelectObjects
        availableObjects={orgObjects}
        selectedObjects={['Opportunity']}
        onToggle={onToggle}
      />,
    );

    fireEvent.click(screen.getByTestId('seed-add-parent-Account'));
    expect(onToggle).toHaveBeenCalledWith('Account');
  });
});
