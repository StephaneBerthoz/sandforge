import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { ObjectSetEditor } from './ObjectSetEditor';
import type { ObjectSetEntry } from './ObjectSetEditor';

const entries: ObjectSetEntry[] = [
  {
    objectApiName: 'Account',
    operation: 'upsert',
    externalIdField: 'Id',
    batchSize: 200,
    where: '',
  },
  {
    objectApiName: 'Contact',
    operation: 'insert',
    externalIdField: '',
    batchSize: 200,
    where: 'IsActive = true',
  },
];

describe('ObjectSetEditor', () => {
  it('should render the editor', () => {
    render(
      <ObjectSetEditor
        entries={entries}
        availableObjects={['Account', 'Contact', 'Lead']}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId('object-set-editor')).toBeDefined();
  });

  it('should show existing entries', () => {
    render(
      <ObjectSetEditor
        entries={entries}
        availableObjects={['Lead']}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId('object-entry-Account')).toBeDefined();
    expect(screen.getByTestId('object-entry-Contact')).toBeDefined();
  });

  it('should call onRemove when remove is clicked', () => {
    const onRemove = vi.fn();
    render(
      <ObjectSetEditor
        entries={entries}
        availableObjects={['Lead']}
        onAdd={vi.fn()}
        onRemove={onRemove}
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('remove-obj-Account'));
    expect(onRemove).toHaveBeenCalledWith(0);
  });

  it('should show object count', () => {
    render(
      <ObjectSetEditor
        entries={entries}
        availableObjects={['Lead']}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText('Object Set (2)')).toBeDefined();
  });

  it('should show empty state when no entries', () => {
    render(
      <ObjectSetEditor
        entries={[]}
        availableObjects={['Account']}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText('No objects configured')).toBeDefined();
  });

  it('should show add object button', () => {
    render(
      <ObjectSetEditor
        entries={[]}
        availableObjects={['Account']}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId('add-object-btn')).toBeDefined();
  });

  it('should display object API names as badges', () => {
    render(
      <ObjectSetEditor
        entries={entries}
        availableObjects={['Lead']}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText('Account')).toBeDefined();
    expect(screen.getByText('Contact')).toBeDefined();
  });
});
