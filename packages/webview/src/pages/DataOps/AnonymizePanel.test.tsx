import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { AnonymizePanel } from './AnonymizePanel';
import type { AnonymizationTemplate } from '@sandforge/shared';

const templates: AnonymizationTemplate[] = [
  {
    id: 'tpl-1',
    name: 'GDPR Template',
    description: 'Anonymize PII for GDPR compliance',
    rules: [
      {
        objectApiName: 'Contact',
        fieldApiName: 'Email',
        method: 'mask',
        config: { maskChar: '*' },
      },
      { objectApiName: 'Contact', fieldApiName: 'Phone', method: 'fake', config: {} },
    ],
    complianceFramework: 'gdpr',
    tags: ['gdpr', 'pii'],
    createdAt: '2026-01-01T00:00:00Z',
  },
];

describe('AnonymizePanel', () => {
  it('should render the panel', () => {
    render(<AnonymizePanel />);
    expect(screen.getByTestId('anonymize-panel')).toBeDefined();
  });

  it('should show empty state when no templates', () => {
    render(<AnonymizePanel />);
    expect(screen.getByText('No templates available')).toBeDefined();
  });

  it('should show template selector', () => {
    render(<AnonymizePanel templates={templates} />);
    expect(screen.getByTestId('template-select')).toBeDefined();
  });

  it('should call onSelectTemplate when template selected', () => {
    const onSelect = vi.fn();
    render(<AnonymizePanel templates={templates} onSelectTemplate={onSelect} />);
    fireEvent.change(screen.getByTestId('template-select'), { target: { value: 'tpl-1' } });
    expect(onSelect).toHaveBeenCalledWith('tpl-1');
  });

  it('should show template detail when selected', () => {
    render(<AnonymizePanel templates={templates} selectedTemplateId="tpl-1" />);
    expect(screen.getByTestId('template-detail')).toBeDefined();
    expect(screen.getAllByText('GDPR Template').length).toBeGreaterThan(0);
  });

  it('should show compliance badge', () => {
    render(<AnonymizePanel templates={templates} selectedTemplateId="tpl-1" />);
    expect(screen.getByText('GDPR')).toBeDefined();
  });

  it('should show rule badges', () => {
    render(<AnonymizePanel templates={templates} selectedTemplateId="tpl-1" />);
    expect(screen.getByText('Email: Mask')).toBeDefined();
    expect(screen.getByText('Phone: Fake')).toBeDefined();
  });

  it('should leave the preview button inert instead of masking data for real', () => {
    // Preview and Apply were wired to one handler, so "Preview" ran the
    // irreversible org write. No dry-run exists in the message contract.
    const onApply = vi.fn();
    render(<AnonymizePanel templates={templates} selectedTemplateId="tpl-1" onApply={onApply} />);
    const preview = screen.getByTestId('preview-btn') as HTMLButtonElement;
    expect(preview.disabled).toBe(true);
    fireEvent.click(preview);
    expect(onApply).not.toHaveBeenCalled();
  });

  it('should say the preview is not built yet', () => {
    render(<AnonymizePanel templates={templates} selectedTemplateId="tpl-1" />);
    expect(screen.getByTestId('preview-unavailable').textContent).toBe('Coming soon');
  });

  it('should not anonymize on the apply click alone', () => {
    const onApply = vi.fn();
    render(<AnonymizePanel templates={templates} selectedTemplateId="tpl-1" onApply={onApply} />);
    fireEvent.click(screen.getByTestId('apply-btn'));
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getByTestId('danger-title')).toBeDefined();
  });

  it('should anonymize once the confirmation word is typed', () => {
    const onApply = vi.fn();
    render(<AnonymizePanel templates={templates} selectedTemplateId="tpl-1" onApply={onApply} />);
    fireEvent.click(screen.getByTestId('apply-btn'));
    fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'Anonymize' } });
    fireEvent.click(screen.getByTestId('danger-confirm-btn'));
    expect(onApply).toHaveBeenCalledWith('tpl-1');
  });

  it('should not anonymize when the typed confirmation does not match', () => {
    const onApply = vi.fn();
    render(<AnonymizePanel templates={templates} selectedTemplateId="tpl-1" onApply={onApply} />);
    fireEvent.click(screen.getByTestId('apply-btn'));
    fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByTestId('danger-confirm-btn'));
    expect(onApply).not.toHaveBeenCalled();
  });

  it('should show preview data table', () => {
    const previewData = [{ Name: 'J***', Email: '***@***.com' }];
    render(
      <AnonymizePanel templates={templates} selectedTemplateId="tpl-1" previewData={previewData} />,
    );
    expect(screen.getByTestId('preview-data')).toBeDefined();
    expect(screen.getByText('J***')).toBeDefined();
  });

  it('should call onCreateTemplate', () => {
    const onCreate = vi.fn();
    render(<AnonymizePanel onCreateTemplate={onCreate} />);
    fireEvent.click(screen.getByTestId('create-template-btn'));
    expect(onCreate).toHaveBeenCalled();
  });
});
