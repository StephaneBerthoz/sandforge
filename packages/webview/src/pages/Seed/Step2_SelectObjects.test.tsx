import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { Step2SelectObjects } from './Step2_SelectObjects';
import type { SeedObjectInfo } from './Step2_SelectObjects';

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

  it('should show smart suggest button', () => {
    const onSmartSuggest = vi.fn();
    render(
      <Step2SelectObjects
        availableObjects={objects}
        selectedObjects={[]}
        onToggle={vi.fn()}
        onSmartSuggest={onSmartSuggest}
      />,
    );
    fireEvent.click(screen.getByTestId('smart-suggest-btn'));
    expect(onSmartSuggest).toHaveBeenCalled();
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
});
