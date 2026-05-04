import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { SyncTemplatePicker } from './SyncTemplatePicker';
import { PREBUILT_SYNC_TEMPLATES } from '@sandforge/shared';

describe('SyncTemplatePicker', () => {
  it('should render the picker root element', () => {
    render(<SyncTemplatePicker onApply={vi.fn()} />);
    expect(screen.getByTestId('sync-template-picker')).toBeDefined();
  });

  it('should render 3 template cards', () => {
    render(<SyncTemplatePicker onApply={vi.fn()} />);
    for (const template of PREBUILT_SYNC_TEMPLATES) {
      expect(screen.getByTestId(`sync-template-card-${template.templateId}`)).toBeDefined();
    }
  });

  it('should display translated template names', () => {
    render(<SyncTemplatePicker onApply={vi.fn()} />);
    expect(screen.getByText('Full Account Hierarchy')).toBeDefined();
    expect(screen.getByText('Opportunities + Products')).toBeDefined();
    expect(screen.getByText('Cases + Attachments')).toBeDefined();
  });

  it('should display object count badges', () => {
    render(<SyncTemplatePicker onApply={vi.fn()} />);
    const badges = screen.getAllByText(/\d+ objects/);
    expect(badges.length).toBe(3);
  });

  it('should call onApply with the correct template when Use This is clicked', () => {
    const onApply = vi.fn();
    render(<SyncTemplatePicker onApply={onApply} />);

    const firstButton = screen.getByTestId(
      `sync-template-apply-${PREBUILT_SYNC_TEMPLATES[0].templateId}`,
    );
    fireEvent.click(firstButton);

    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith(PREBUILT_SYNC_TEMPLATES[0]);
  });

  it('should render apply buttons with correct data-testid', () => {
    render(<SyncTemplatePicker onApply={vi.fn()} />);
    for (const template of PREBUILT_SYNC_TEMPLATES) {
      expect(screen.getByTestId(`sync-template-apply-${template.templateId}`)).toBeDefined();
    }
  });

  it('should display object API names as comma-separated list', () => {
    render(<SyncTemplatePicker onApply={vi.fn()} />);
    // Account Hierarchy template objects
    expect(screen.getByText('Account, Contact, Opportunity, Task, Note')).toBeDefined();
  });
});
