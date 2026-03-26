import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { TemplateCustomizeModal } from './TemplateCustomizeModal';
import type { SeedTemplate } from '@sandforge/shared';

/* Polyfill dialog showModal/close for jsdom */
HTMLDialogElement.prototype.showModal = HTMLDialogElement.prototype.showModal ?? function showModal(this: HTMLDialogElement) { this.setAttribute('open', ''); };
HTMLDialogElement.prototype.close = HTMLDialogElement.prototype.close ?? function close(this: HTMLDialogElement) { this.removeAttribute('open'); };

const mockTemplate: SeedTemplate = {
  id: 'prebuilt-minimal-demo',
  name: 'seed.templates.minimalDemo.name',
  description: 'seed.templates.minimalDemo.description',
  version: 1,
  strategy: 'faker',
  objects: [
    { objectApiName: 'Account', recordCount: 50, fieldRules: [], excludedFields: [], insertOrder: 0, batchSize: 200 },
    { objectApiName: 'Contact', recordCount: 100, fieldRules: [], excludedFields: [], insertOrder: 1, batchSize: 200 },
    { objectApiName: 'Opportunity', recordCount: 200, fieldRules: [], excludedFields: [], insertOrder: 2, batchSize: 200 },
  ],
  tags: ['prebuilt', 'demo'],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('TemplateCustomizeModal', () => {
  it('renders all objects with default record counts', () => {
    render(
      <TemplateCustomizeModal
        template={mockTemplate}
        isOpen={true}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    expect(screen.getByTestId('template-customize-modal')).toBeDefined();
    expect(screen.getByText('Account')).toBeDefined();
    expect(screen.getByText('Contact')).toBeDefined();
    expect(screen.getByText('Opportunity')).toBeDefined();

    const accountInput = screen.getByTestId('customize-count-Account') as HTMLInputElement;
    expect(accountInput.value).toBe('50');

    const contactInput = screen.getByTestId('customize-count-Contact') as HTMLInputElement;
    expect(contactInput.value).toBe('100');
  });

  it('allows changing record count for an object', () => {
    render(
      <TemplateCustomizeModal
        template={mockTemplate}
        isOpen={true}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    const accountInput = screen.getByTestId('customize-count-Account') as HTMLInputElement;
    fireEvent.change(accountInput, { target: { value: '250' } });

    expect(accountInput.value).toBe('250');
  });

  it('calls onConfirm with updated counts when Start Seeding is clicked', () => {
    const onConfirm = vi.fn();
    render(
      <TemplateCustomizeModal
        template={mockTemplate}
        isOpen={true}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    const accountInput = screen.getByTestId('customize-count-Account');
    fireEvent.change(accountInput, { target: { value: '999' } });

    fireEvent.click(screen.getByTestId('btn-start-seeding'));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(
      mockTemplate,
      expect.objectContaining({ Account: 999, Contact: 100, Opportunity: 200 }),
    );
  });

  it('calls onClose when Cancel is clicked', () => {
    const onClose = vi.fn();
    render(
      <TemplateCustomizeModal
        template={mockTemplate}
        isOpen={true}
        onClose={onClose}
        onConfirm={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('Cancel'));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
