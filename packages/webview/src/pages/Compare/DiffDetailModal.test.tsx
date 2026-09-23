import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import i18n from '../../i18n';
import fr from '../../i18n/locales/fr.json';
import { DiffDetailModal } from './DiffDetailModal';
import type { EnrichedDiff } from '@sandforge/shared';

const sampleDiff: EnrichedDiff = {
  category: 'ApexClass',
  changeType: 'modified',
  name: 'AccountController',
  sourceValue: 'public class AccountController { /* v1 */ }',
  targetValue: 'public class AccountController { /* v2 */ }',
  riskLevel: 'high',
  riskReasons: ['breaking'],
  group: 'Apex Code',
  dependencies: ['ApexTrigger', 'Flow'],
};

const addedDiff: EnrichedDiff = {
  category: 'CustomLabel',
  changeType: 'added',
  name: 'MyNewLabel',
  riskLevel: 'low',
  riskReasons: [],
  group: 'Configuration',
  dependencies: [],
};

describe('DiffDetailModal', () => {
  it('should render the modal with diff name', () => {
    render(<DiffDetailModal diff={sampleDiff} onClose={vi.fn()} />);
    expect(screen.getByTestId('diff-detail-modal')).toBeDefined();
    expect(screen.getByTestId('diff-detail-name').textContent).toBe('AccountController');
  });

  it('should show change type and risk level badges', () => {
    render(<DiffDetailModal diff={sampleDiff} onClose={vi.fn()} />);
    expect(screen.getByText('Modified')).toBeDefined();
    expect(screen.getByText('High risk')).toBeDefined();
  });

  it('marks what only the target holds as a removal, and what only the source holds as an addition', () => {
    // `added` is only in the target: the badge said "added", in green, over a
    // component no deployment adds.
    const { unmount } = render(<DiffDetailModal diff={addedDiff} onClose={vi.fn()} />);
    const targetOnly = screen.getByText('Only in the target');
    expect(targetOnly.classList.contains('bg-status-error')).toBe(true);
    unmount();

    render(<DiffDetailModal diff={{ ...addedDiff, changeType: 'removed' }} onClose={vi.fn()} />);
    const sourceOnly = screen.getByText('Only in the source');
    expect(sourceOnly.classList.contains('bg-status-success')).toBe(true);
  });

  it('names the change and its risk in the language of the page', async () => {
    i18n.addResourceBundle('fr', 'translation', fr);
    await i18n.changeLanguage('fr');
    try {
      render(<DiffDetailModal diff={sampleDiff} onClose={vi.fn()} />);
      expect(screen.getByText('Modifié')).toBeDefined();
      expect(screen.getByText('Risque élevé')).toBeDefined();
      expect(screen.queryByText('high')).toBeNull();
    } finally {
      await i18n.changeLanguage('en');
    }
  });

  it('should show metadata (category and group)', () => {
    render(<DiffDetailModal diff={sampleDiff} onClose={vi.fn()} />);
    expect(screen.getByTestId('diff-detail-meta')).toBeDefined();
    expect(screen.getByText('ApexClass')).toBeDefined();
    expect(screen.getByText('Apex Code')).toBeDefined();
  });

  it('should show source and target values side by side', () => {
    render(<DiffDetailModal diff={sampleDiff} onClose={vi.fn()} />);
    expect(screen.getByTestId('diff-source-value').textContent).toContain('v1');
    expect(screen.getByTestId('diff-target-value').textContent).toContain('v2');
  });

  it('should show risk reasons', () => {
    render(<DiffDetailModal diff={sampleDiff} onClose={vi.fn()} />);
    expect(screen.getByTestId('diff-risk-reasons')).toBeDefined();
    expect(screen.getByText('This is a breaking change.')).toBeDefined();
  });

  it('words each reason from the catalogue, in the language of the page', () => {
    // The reasons were English sentences built where the diffs are enriched,
    // and one of them told a component only the source holds that it was
    // being removed.
    render(
      <DiffDetailModal
        diff={{
          ...sampleDiff,
          changeType: 'removed',
          category: 'CustomField',
          riskLevel: 'low',
          riskReasons: ['sourceOnly'],
        }}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId('diff-risk-reasons').textContent).toContain(
      'Only the source holds it: a deployment creates it in the target.',
    );
    expect(screen.getByTestId('diff-risk-reasons').textContent).not.toMatch(/sourceOnly|Removing/);
  });

  it('should show dependencies', () => {
    render(<DiffDetailModal diff={sampleDiff} onClose={vi.fn()} />);
    expect(screen.getByTestId('diff-dependencies')).toBeDefined();
    expect(screen.getByText('ApexTrigger')).toBeDefined();
    expect(screen.getByText('Flow')).toBeDefined();
  });

  it('should not show dependencies section when empty', () => {
    render(<DiffDetailModal diff={addedDiff} onClose={vi.fn()} />);
    expect(screen.queryByTestId('diff-dependencies')).toBeNull();
  });

  it('should call onClose when close button is clicked', () => {
    const onClose = vi.fn();
    render(<DiffDetailModal diff={sampleDiff} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('close-diff-modal'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('should call onClose when clicking backdrop', () => {
    const onClose = vi.fn();
    render(<DiffDetailModal diff={sampleDiff} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('diff-detail-modal'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('focuses the close button on open and closes on Escape', () => {
    const onClose = vi.fn();
    render(<DiffDetailModal diff={sampleDiff} onClose={onClose} />);
    expect(document.activeElement).toBe(screen.getByTestId('close-diff-modal'));
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps Tab on the close button, the only control inside the modal', () => {
    render(<DiffDetailModal diff={sampleDiff} onClose={vi.fn()} />);
    const close = screen.getByTestId('close-diff-modal');
    fireEvent.keyDown(close, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(close);
  });

  it('does not pull focus back to the close button when the parent re-renders', () => {
    // In Compare the opener is the clicked diff row; a trap that re-subscribed
    // on each render would hand focus to it and then back to the close button.
    const row = document.createElement('button');
    document.body.appendChild(row);
    row.focus();
    const { rerender } = render(<DiffDetailModal diff={sampleDiff} onClose={vi.fn()} />);
    const meta = screen.getByTestId('diff-detail-meta');
    meta.tabIndex = -1;
    meta.focus();
    rerender(<DiffDetailModal diff={sampleDiff} onClose={vi.fn()} />);
    expect(document.activeElement).toBe(meta);
    row.remove();
  });

  it('should not show source/target section for added items without values', () => {
    render(<DiffDetailModal diff={addedDiff} onClose={vi.fn()} />);
    expect(screen.queryByTestId('diff-source-value')).toBeNull();
    expect(screen.queryByTestId('diff-target-value')).toBeNull();
  });
});
