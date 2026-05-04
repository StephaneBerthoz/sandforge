import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../../i18n';
import { CloneObjectSelector } from './CloneObjectSelector';
import type { SourceObjectInfo } from './useClone';

const sourceObjects: SourceObjectInfo[] = [
  { name: 'Account', label: 'Account' },
  { name: 'Contact', label: 'Contact' },
  { name: 'Opportunity', label: 'Opportunity' },
  { name: 'Custom__c', label: 'Custom Object' },
];

describe('CloneObjectSelector', () => {
  it('should render object list with checkboxes', () => {
    render(
      <CloneObjectSelector
        sourceObjects={sourceObjects}
        selectedObjects={[]}
        onObjectToggle={vi.fn()}
        onWhereClauseChange={vi.fn()}
      />,
    );

    expect(screen.getByTestId('clone-object-selector')).toBeDefined();
    expect(screen.getByTestId('clone-obj-Account')).toBeDefined();
    expect(screen.getByTestId('clone-obj-Contact')).toBeDefined();
    expect(screen.getByTestId('clone-obj-Opportunity')).toBeDefined();
    expect(screen.getByTestId('clone-obj-Custom__c')).toBeDefined();
  });

  it('should call onObjectToggle when checking an object', () => {
    const onObjectToggle = vi.fn();
    render(
      <CloneObjectSelector
        sourceObjects={sourceObjects}
        selectedObjects={[]}
        onObjectToggle={onObjectToggle}
        onWhereClauseChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('clone-obj-check-Account'));
    expect(onObjectToggle).toHaveBeenCalledWith('Account');
  });

  it('should show WHERE input when an object is selected', () => {
    render(
      <CloneObjectSelector
        sourceObjects={sourceObjects}
        selectedObjects={[{ objectApiName: 'Account' }]}
        onObjectToggle={vi.fn()}
        onWhereClauseChange={vi.fn()}
      />,
    );

    expect(screen.getByTestId('clone-where-section-Account')).toBeDefined();
    expect(screen.getByTestId('clone-where-input-Account')).toBeDefined();
  });

  it('should not show WHERE input for unselected objects', () => {
    render(
      <CloneObjectSelector
        sourceObjects={sourceObjects}
        selectedObjects={[{ objectApiName: 'Account' }]}
        onObjectToggle={vi.fn()}
        onWhereClauseChange={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('clone-where-section-Contact')).toBeNull();
  });

  it('should call onWhereClauseChange when typing in WHERE input', () => {
    const onWhereClauseChange = vi.fn();
    render(
      <CloneObjectSelector
        sourceObjects={sourceObjects}
        selectedObjects={[{ objectApiName: 'Account' }]}
        onObjectToggle={vi.fn()}
        onWhereClauseChange={onWhereClauseChange}
      />,
    );

    const input = screen.getByTestId('clone-where-input-Account');
    fireEvent.change(input, { target: { value: "Industry = 'Technology'" } });

    expect(onWhereClauseChange).toHaveBeenCalledWith('Account', "Industry = 'Technology'");
  });

  it('should filter objects by search term', () => {
    render(
      <CloneObjectSelector
        sourceObjects={sourceObjects}
        selectedObjects={[]}
        onObjectToggle={vi.fn()}
        onWhereClauseChange={vi.fn()}
      />,
    );

    const searchInput = screen.getByTestId('clone-object-search');
    fireEvent.change(searchInput, { target: { value: 'custom' } });

    // Only Custom__c should remain visible
    expect(screen.getByTestId('clone-obj-Custom__c')).toBeDefined();
    expect(screen.queryByTestId('clone-obj-Account')).toBeNull();
  });

  it('should show selected count in header', () => {
    render(
      <CloneObjectSelector
        sourceObjects={sourceObjects}
        selectedObjects={[{ objectApiName: 'Account' }, { objectApiName: 'Contact' }]}
        onObjectToggle={vi.fn()}
        onWhereClauseChange={vi.fn()}
      />,
    );

    const selector = screen.getByTestId('clone-object-selector');
    // The component renders a badge with the selected count text (key fallback includes "selected")
    expect(selector.textContent).toContain('selected');
  });

  it('should show loading skeleton when loading', () => {
    render(
      <CloneObjectSelector
        sourceObjects={[]}
        selectedObjects={[]}
        onObjectToggle={vi.fn()}
        onWhereClauseChange={vi.fn()}
        loading
      />,
    );

    expect(screen.getByTestId('clone-objects-loading')).toBeDefined();
  });
});
