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

/**
 * Every row repeats the same controls, so the editor announced a dozen
 * anonymous comboboxes and text boxes: unreadable row by row. Names are
 * qualified with the object API name and come from the locale bundles.
 */
describe('ObjectSetEditor accessible names', () => {
  function renderEditor(): void {
    render(
      <ObjectSetEditor
        entries={entries}
        availableObjects={['Account', 'Contact', 'Lead']}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onChange={vi.fn()}
      />,
    );
  }

  function accessibleName(el: HTMLElement): string {
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel;
    const labelled = el.getAttribute('aria-labelledby');
    if (labelled) return document.getElementById(labelled)?.textContent ?? '';
    return el.id ? (document.querySelector(`label[for="${el.id}"]`)?.textContent ?? '') : '';
  }

  it('names every combobox', () => {
    renderEditor();
    const comboboxes = screen.getAllByRole('combobox');
    expect(comboboxes.length).toBe(3);
    for (const el of comboboxes) {
      expect(accessibleName(el)).not.toBe('');
    }
  });

  it('names every text box', () => {
    renderEditor();
    for (const el of screen.getAllByRole('textbox')) {
      expect(accessibleName(el)).not.toBe('');
    }
  });

  it('tells the operation selects of two rows apart', () => {
    renderEditor();
    expect(screen.getByLabelText('Operation — Account').tagName).toBe('SELECT');
    expect(screen.getByLabelText('Operation — Contact').tagName).toBe('SELECT');
  });

  it('names the row inputs after their object', () => {
    renderEditor();
    expect(screen.getByLabelText('External ID — Account')).toBeDefined();
    expect(screen.getByLabelText('Batch Size — Account')).toBeDefined();
    expect(screen.getByLabelText('WHERE clause — Contact')).toBeDefined();
  });

  it('names each remove button after its object', () => {
    renderEditor();
    expect(screen.getByRole('button', { name: 'Remove Object — Account' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Remove Object — Contact' })).toBeDefined();
  });

  it('names the add-object select from its placeholder', () => {
    renderEditor();
    expect(screen.getByLabelText('Add Object').tagName).toBe('SELECT');
  });

  it('translates the WHERE clause placeholder instead of hardcoding English', () => {
    renderEditor();
    const whereInput = screen.getByLabelText('WHERE clause — Account') as HTMLInputElement;
    expect(whereInput.placeholder).toBe('WHERE clause');
    expect(whereInput.placeholder).not.toBe('undefined');
    expect(whereInput.placeholder).not.toBe('automation.stepConfigWhere');
  });
});
