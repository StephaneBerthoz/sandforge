import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../../i18n';
import { ClonePreviewPanel } from './ClonePreviewPanel';
import type { ClonePreviewResult } from '@sandforge/shared';

const mockPreview: ClonePreviewResult = {
  insertOrder: ['Account', 'Contact', 'Opportunity'],
  objects: [
    {
      objectApiName: 'Account',
      recordCount: 50,
      sampleRecords: [
        { Id: '001xx001', Name: 'Acme Corp', Industry: 'Technology' },
        { Id: '001xx002', Name: 'Globex', Industry: 'Manufacturing' },
      ],
      relationships: [],
    },
    {
      objectApiName: 'Contact',
      recordCount: 120,
      sampleRecords: [{ Id: '003xx001', FirstName: 'John', LastName: 'Doe' }],
      relationships: [{ field: 'AccountId', referenceTo: 'Account' }],
    },
    {
      objectApiName: 'Opportunity',
      recordCount: 30,
      sampleRecords: [],
      relationships: [{ field: 'AccountId', referenceTo: 'Account' }],
    },
  ],
};

const largeMockPreview: ClonePreviewResult = {
  insertOrder: ['Account'],
  objects: [
    {
      objectApiName: 'Account',
      recordCount: 15000,
      sampleRecords: [],
      relationships: [],
    },
  ],
};

describe('ClonePreviewPanel', () => {
  it('should render insert order list', () => {
    render(<ClonePreviewPanel previewResult={mockPreview} onExecute={vi.fn()} onBack={vi.fn()} />);

    expect(screen.getByTestId('clone-preview-panel')).toBeDefined();
    expect(screen.getByTestId('clone-insert-order')).toBeDefined();

    const orderItems = screen.getByTestId('clone-insert-order');
    expect(orderItems.textContent).toContain('Account');
    expect(orderItems.textContent).toContain('Contact');
    expect(orderItems.textContent).toContain('Opportunity');
  });

  it('should render record counts per object', () => {
    render(<ClonePreviewPanel previewResult={mockPreview} onExecute={vi.fn()} onBack={vi.fn()} />);

    const counts = screen.getByTestId('clone-record-counts');
    expect(counts.textContent).toContain('50');
    expect(counts.textContent).toContain('120');
    expect(counts.textContent).toContain('30');
  });

  it('should show total record count', () => {
    render(<ClonePreviewPanel previewResult={mockPreview} onExecute={vi.fn()} onBack={vi.fn()} />);

    const totalEl = screen.getByTestId('clone-total-records');
    expect(totalEl.textContent).toContain('200');
  });

  it('should show large clone warning when records exceed threshold', () => {
    render(
      <ClonePreviewPanel previewResult={largeMockPreview} onExecute={vi.fn()} onBack={vi.fn()} />,
    );

    expect(screen.getByTestId('clone-large-warning')).toBeDefined();
  });

  it('should not show large clone warning for small clones', () => {
    render(<ClonePreviewPanel previewResult={mockPreview} onExecute={vi.fn()} onBack={vi.fn()} />);

    expect(screen.queryByTestId('clone-large-warning')).toBeNull();
  });

  it('should call onExecute when clicking Execute button', () => {
    const onExecute = vi.fn();
    render(
      <ClonePreviewPanel previewResult={mockPreview} onExecute={onExecute} onBack={vi.fn()} />,
    );

    fireEvent.click(screen.getByTestId('clone-preview-execute'));
    expect(onExecute).toHaveBeenCalledTimes(1);
  });

  it('should call onBack when clicking Back button', () => {
    const onBack = vi.fn();
    render(<ClonePreviewPanel previewResult={mockPreview} onExecute={vi.fn()} onBack={onBack} />);

    fireEvent.click(screen.getByTestId('clone-preview-back'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
