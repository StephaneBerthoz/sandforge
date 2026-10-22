import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import i18n from '../../../i18n';
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

  it('shows no count for an object not counted yet, and the count once it is', () => {
    // The listing counts nothing: an object is counted once it is picked,
    // and a zero drawn for it before would read as an empty table.
    const { rerender } = render(
      <Step2Objects
        availableObjects={[{ apiName: 'Account', label: 'Account' }]}
        selectedObjects={['Account']}
        selectAll
        onToggleObject={vi.fn()}
        onToggleAll={vi.fn()}
      />,
    );
    expect(screen.getByTestId('object-Account').textContent).toBe('Account(Account)');

    rerender(
      <Step2Objects
        availableObjects={[{ apiName: 'Account', label: 'Account', recordCount: 0 }]}
        selectedObjects={['Account']}
        selectAll
        onToggleObject={vi.fn()}
        onToggleAll={vi.fn()}
      />,
    );
    expect(screen.getByTestId('object-Account').textContent).toMatch(/0/);
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

  it('shows an object the target does not have, said so, and does not let it be picked', () => {
    // Offered as any other, it was picked, scanned and planned, and every
    // record of it refused at the write.
    const onToggleObject = vi.fn();
    render(
      <Step2Objects
        availableObjects={[{ apiName: 'Ghost__c', label: 'Ghost', missingInTarget: true }]}
        selectedObjects={[]}
        selectAll={false}
        onToggleObject={onToggleObject}
        onToggleAll={vi.fn()}
      />,
    );

    const row = screen.getByTestId('object-Ghost__c');
    expect(row.querySelector('input')?.disabled).toBe(true);
    expect(screen.getByTestId('object-Ghost__c-missing').textContent).toBe(
      i18n.t('autopilot.step2.notInTarget'),
    );
    fireEvent.click(row);
    expect(onToggleObject).not.toHaveBeenCalled();
  });

  it('shows an object the target user may not create, said so, and does not let it be picked', () => {
    // It was dropped from the list with the platform's own objects, and
    // nothing said why the object the user looked for was not there.
    const onToggleObject = vi.fn();
    render(
      <Step2Objects
        availableObjects={[{ apiName: 'Case', label: 'Case', notCreateableInTarget: true }]}
        selectedObjects={[]}
        selectAll={false}
        onToggleObject={onToggleObject}
        onToggleAll={vi.fn()}
      />,
    );

    const row = screen.getByTestId('object-Case');
    expect(row.querySelector('input')?.disabled).toBe(true);
    expect(screen.getByTestId('object-Case-not-createable').textContent).toBe(
      'The user SandForge writes as may not create these in the target org',
    );
    fireEvent.click(row);
    expect(onToggleObject).not.toHaveBeenCalled();
  });

  it('counts on demand the objects shown whose count is not known, as the search narrows them', () => {
    const onCountShown = vi.fn();
    render(
      <Step2Objects
        availableObjects={[
          { apiName: 'Account', label: 'Account', recordCount: 5 },
          { apiName: 'Contact', label: 'Contact' },
          { apiName: 'Case', label: 'Case', countAsked: true },
          { apiName: 'Ghost__c', label: 'Ghost', missingInTarget: true },
          { apiName: 'Invoice__c', label: 'Invoice' },
        ]}
        selectedObjects={[]}
        selectAll={false}
        onToggleObject={vi.fn()}
        onToggleAll={vi.fn()}
        onCountShown={onCountShown}
      />,
    );

    const button = screen.getByTestId('count-shown-button');
    expect(button.textContent).toBe(i18n.t('autopilot.step2.countShown', { objects: 2 }));
    fireEvent.click(button);
    expect(onCountShown).toHaveBeenLastCalledWith(['Contact', 'Invoice__c']);

    fireEvent.change(screen.getByTestId('object-search-input'), { target: { value: 'Inv' } });
    fireEvent.click(screen.getByTestId('count-shown-button'));
    expect(onCountShown).toHaveBeenLastCalledWith(['Invoice__c']);
  });

  it('offers no count of the objects shown while one is in flight, or when every one is known', () => {
    const { rerender } = render(
      <Step2Objects
        availableObjects={[{ apiName: 'Contact', label: 'Contact' }]}
        selectedObjects={[]}
        selectAll={false}
        onToggleObject={vi.fn()}
        onToggleAll={vi.fn()}
        onCountShown={vi.fn()}
        counting
      />,
    );
    expect((screen.getByTestId('count-shown-button') as HTMLButtonElement).disabled).toBe(true);

    rerender(
      <Step2Objects
        availableObjects={[{ apiName: 'Contact', label: 'Contact', recordCount: 3 }]}
        selectedObjects={[]}
        selectAll={false}
        onToggleObject={vi.fn()}
        onToggleAll={vi.fn()}
        onCountShown={vi.fn()}
      />,
    );
    expect((screen.getByTestId('count-shown-button') as HTMLButtonElement).disabled).toBe(true);
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
