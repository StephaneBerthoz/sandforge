import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../../i18n';
import type { PersonaMsg } from '@sandforge/shared';
import { PersonaPreviewPopover } from './PersonaPreviewPopover';

const mockPersona: PersonaMsg = {
  id: 'assureur-fr',
  name: 'Assureur francais',
  description: "Compagnie d'assurance",
  industry: 'Insurance',
  locale: 'fr-FR',
  dataPatterns: {
    Name: { fieldType: 'string', generator: 'faker', examples: ['AXA', 'Mutuelle', 'Groupe'] },
    Premium__c: { fieldType: 'currency', generator: 'range', examples: ['450', '1200', '3200'] },
  },
};

const sampleRecords = [
  { Name: 'AXA', Premium__c: '450' },
  { Name: 'Mutuelle', Premium__c: '1200' },
  { Name: 'Groupe', Premium__c: '3200' },
  { Name: 'AXA', Premium__c: '450' },
  { Name: 'Mutuelle', Premium__c: '1200' },
];

describe('PersonaPreviewPopover', () => {
  it('renders the popover with persona name and sample data heading', () => {
    render(
      <PersonaPreviewPopover
        persona={mockPersona}
        sampleRecords={sampleRecords}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByTestId('persona-preview-popover')).toBeDefined();
    expect(screen.getByText('French insurer')).toBeDefined();
  });

  it('renders a DataTable with sample record values', () => {
    render(
      <PersonaPreviewPopover
        persona={mockPersona}
        sampleRecords={sampleRecords}
        onClose={vi.fn()}
      />,
    );

    // Should show header columns matching field names
    expect(screen.getByText('Name')).toBeDefined();
    expect(screen.getByText('Premium__c')).toBeDefined();
    // Should show sample values
    expect(screen.getAllByText('AXA').length).toBeGreaterThanOrEqual(1);
  });

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn();
    render(
      <PersonaPreviewPopover
        persona={mockPersona}
        sampleRecords={sampleRecords}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByTestId('preview-close-btn'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when Escape key is pressed', () => {
    const onClose = vi.fn();
    render(
      <PersonaPreviewPopover
        persona={mockPersona}
        sampleRecords={sampleRecords}
        onClose={onClose}
      />,
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose on outside click', () => {
    const onClose = vi.fn();
    render(
      <div>
        <div data-testid="outside">Outside</div>
        <PersonaPreviewPopover
          persona={mockPersona}
          sampleRecords={sampleRecords}
          onClose={onClose}
        />
      </div>,
    );

    fireEvent.mouseDown(screen.getByTestId('outside'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('is a modal that takes the focus on its close button, keeps Tab in, and gives the focus back', () => {
    // Over a dimmed gallery, it took no focus and Tab walked the gallery behind it.
    function Gallery(): React.ReactElement {
      const [open, setOpen] = React.useState(false);
      return (
        <>
          <button data-testid="preview-btn" onClick={() => setOpen(true)}>
            Preview
          </button>
          {open && (
            <PersonaPreviewPopover
              persona={mockPersona}
              sampleRecords={sampleRecords}
              onClose={() => setOpen(false)}
            />
          )}
        </>
      );
    }
    render(<Gallery />);
    const opener = screen.getByTestId('preview-btn');
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByRole('dialog', { name: 'Persona Preview' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(screen.getByTestId('preview-close-btn'));
    // Shift+Tab from its first control wraps to its last, held back from the gallery.
    expect(
      fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Tab', shiftKey: true }),
    ).toBe(false);
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(screen.getByTestId('preview-close-btn'));

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('shows empty state when no sample records', () => {
    render(<PersonaPreviewPopover persona={mockPersona} sampleRecords={[]} onClose={vi.fn()} />);

    expect(screen.getByText(/No data/i)).toBeDefined();
  });
});
