import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MaskingTemplatePanel } from './MaskingTemplatePanel';
import type { ObjectTemplate } from './MaskingTemplatePanel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, defaultValue: string) => defaultValue,
  }),
}));

const mockTemplates: ObjectTemplate[] = [
  {
    objectApiName: 'Account',
    label: 'Account',
    rules: [
      {
        fieldApiName: 'Name',
        ruleType: 'fake',
        description: 'Replace with fake company name',
        recommended: true,
      },
      { fieldApiName: 'Phone', ruleType: 'mask', description: 'Mask phone', recommended: true },
      {
        fieldApiName: 'Description',
        ruleType: 'constant',
        description: 'Replace with placeholder',
        recommended: false,
      },
    ],
  },
  {
    objectApiName: 'Contact',
    label: 'Contact',
    rules: [
      {
        fieldApiName: 'FirstName',
        ruleType: 'fake',
        description: 'Replace with fake first name',
        recommended: true,
      },
      {
        fieldApiName: 'Email',
        ruleType: 'fake',
        description: 'Replace with fake email',
        recommended: true,
      },
    ],
  },
];

describe('MaskingTemplatePanel', () => {
  it('renders empty state when no templates', () => {
    render(<MaskingTemplatePanel templates={[]} />);
    expect(screen.getByTestId('masking-empty')).toBeTruthy();
  });

  it('renders template list', () => {
    render(<MaskingTemplatePanel templates={mockTemplates} />);
    expect(screen.getByTestId('masking-template-panel')).toBeTruthy();
    expect(screen.getByTestId('masking-obj-Account')).toBeTruthy();
    expect(screen.getByTestId('masking-obj-Contact')).toBeTruthy();
  });

  it('expands an object when clicked', () => {
    render(<MaskingTemplatePanel templates={mockTemplates} />);
    fireEvent.click(screen.getByTestId('masking-toggle-Account'));
    expect(screen.getByTestId('rule-Account-Name')).toBeTruthy();
    expect(screen.getByTestId('rule-Account-Phone')).toBeTruthy();
  });

  it('toggles rule selection', () => {
    render(<MaskingTemplatePanel templates={mockTemplates} />);
    fireEvent.click(screen.getByTestId('masking-toggle-Account'));
    const checkbox = screen.getByTestId('rule-Account-Name').querySelector('input');
    expect(checkbox).toBeTruthy();
    fireEvent.click(checkbox!);
    expect(checkbox!.checked).toBe(true);
  });

  it('selects recommended rules', () => {
    render(<MaskingTemplatePanel templates={mockTemplates} />);
    fireEvent.click(screen.getByTestId('masking-toggle-Account'));
    fireEvent.click(screen.getByTestId('select-recommended-Account'));
    // Two recommended rules: Name and Phone
    const nameCheckbox = screen.getByTestId('rule-Account-Name').querySelector('input');
    const phoneCheckbox = screen.getByTestId('rule-Account-Phone').querySelector('input');
    expect(nameCheckbox!.checked).toBe(true);
    expect(phoneCheckbox!.checked).toBe(true);
  });

  it('selects all rules', () => {
    render(<MaskingTemplatePanel templates={mockTemplates} />);
    fireEvent.click(screen.getByTestId('masking-toggle-Account'));
    fireEvent.click(screen.getByTestId('select-all-Account'));
    const descCheckbox = screen.getByTestId('rule-Account-Description').querySelector('input');
    expect(descCheckbox!.checked).toBe(true);
  });

  it('clears all rules', () => {
    render(<MaskingTemplatePanel templates={mockTemplates} />);
    fireEvent.click(screen.getByTestId('masking-toggle-Account'));
    fireEvent.click(screen.getByTestId('select-all-Account'));
    fireEvent.click(screen.getByTestId('clear-all-Account'));
    const nameCheckbox = screen.getByTestId('rule-Account-Name').querySelector('input');
    expect(nameCheckbox!.checked).toBe(false);
  });

  it('shows apply button when rules are selected', () => {
    const onApply = vi.fn();
    render(<MaskingTemplatePanel templates={mockTemplates} onApply={onApply} />);
    fireEvent.click(screen.getByTestId('masking-toggle-Account'));
    fireEvent.click(screen.getByTestId('select-recommended-Account'));
    expect(screen.getByTestId('apply-Account')).toBeTruthy();
    fireEvent.click(screen.getByTestId('apply-Account'));
    expect(onApply).toHaveBeenCalledWith(
      'Account',
      expect.arrayContaining([
        expect.objectContaining({ fieldApiName: 'Name' }),
        expect.objectContaining({ fieldApiName: 'Phone' }),
      ]),
    );
  });

  it('filters templates by search', () => {
    render(<MaskingTemplatePanel templates={mockTemplates} />);
    const searchInput = screen.getByTestId('masking-search');
    fireEvent.change(searchInput, { target: { value: 'Account' } });
    expect(screen.getByTestId('masking-obj-Account')).toBeTruthy();
    expect(screen.queryByTestId('masking-obj-Contact')).toBeNull();
  });
});
