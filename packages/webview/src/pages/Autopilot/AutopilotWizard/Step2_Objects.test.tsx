import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../../i18n';
import { Step2Objects } from './Step2_Objects';
import type { AutopilotObjectInfo } from './AutopilotWizard';

const mockObjects: AutopilotObjectInfo[] = [
  { apiName: 'Account', label: 'Account', recordCount: 5200 },
  { apiName: 'Contact', label: 'Contact', recordCount: 12400 },
  { apiName: 'Opportunity', label: 'Opportunity', recordCount: 3100 },
];

describe('Step2_Objects', () => {
  it('should render without crashing', () => {
    render(
      <Step2Objects
        availableObjects={mockObjects}
        selectedObjects={[]}
        selectAll={false}
        onToggleObject={vi.fn()}
        onToggleAll={vi.fn()}
      />,
    );
    expect(screen.getByTestId('step2-objects')).toBeDefined();
  });

  it('should display all objects', () => {
    render(
      <Step2Objects
        availableObjects={mockObjects}
        selectedObjects={[]}
        selectAll={false}
        onToggleObject={vi.fn()}
        onToggleAll={vi.fn()}
      />,
    );
    expect(screen.getByTestId('object-Account')).toBeDefined();
    expect(screen.getByTestId('object-Contact')).toBeDefined();
    expect(screen.getByTestId('object-Opportunity')).toBeDefined();
  });

  it('should show record counts', () => {
    render(
      <Step2Objects
        availableObjects={mockObjects}
        selectedObjects={[]}
        selectAll={false}
        onToggleObject={vi.fn()}
        onToggleAll={vi.fn()}
      />,
    );
    // Record counts are locale-formatted (5,200 or 5 200 depending on locale)
    const accountRow = screen.getByTestId('object-Account');
    expect(accountRow.textContent).toContain('5');
    expect(accountRow.textContent).toContain('200');
    const contactRow = screen.getByTestId('object-Contact');
    expect(contactRow.textContent).toContain('12');
    expect(contactRow.textContent).toContain('400');
  });

  it('should call onToggleObject when object clicked', () => {
    const onToggleObject = vi.fn();
    render(
      <Step2Objects
        availableObjects={mockObjects}
        selectedObjects={[]}
        selectAll={false}
        onToggleObject={onToggleObject}
        onToggleAll={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('object-Account'));
    expect(onToggleObject).toHaveBeenCalledWith('Account');
  });

  it('should show select all checkbox', () => {
    render(
      <Step2Objects
        availableObjects={mockObjects}
        selectedObjects={[]}
        selectAll={false}
        onToggleObject={vi.fn()}
        onToggleAll={vi.fn()}
      />,
    );
    expect(screen.getByTestId('select-all-checkbox')).toBeDefined();
  });

  it('should filter objects by search input', () => {
    render(
      <Step2Objects
        availableObjects={mockObjects}
        selectedObjects={[]}
        selectAll={false}
        onToggleObject={vi.fn()}
        onToggleAll={vi.fn()}
      />,
    );
    const searchInput = screen.getByTestId('object-search-input');
    fireEvent.change(searchInput, { target: { value: 'Acc' } });

    expect(screen.getByTestId('object-Account')).toBeDefined();
    expect(screen.queryByTestId('object-Contact')).toBeNull();
  });
});
