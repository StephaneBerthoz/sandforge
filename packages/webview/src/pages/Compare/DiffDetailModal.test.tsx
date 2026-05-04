import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { DiffDetailModal } from './DiffDetailModal';
import type { EnrichedDiff } from '@sandforge/shared';

const sampleDiff: EnrichedDiff = {
  category: 'ApexClass',
  changeType: 'modified',
  name: 'AccountController',
  sourceValue: 'public class AccountController { /* v1 */ }',
  targetValue: 'public class AccountController { /* v2 */ }',
  riskLevel: 'high',
  riskReasons: [
    'This is a breaking change that requires careful review.',
    'Run all Apex tests in the target org.',
  ],
  group: 'Apex Code',
  dependencies: ['ApexTrigger', 'Flow'],
};

const addedDiff: EnrichedDiff = {
  category: 'CustomLabel',
  changeType: 'added',
  name: 'MyNewLabel',
  riskLevel: 'low',
  riskReasons: ['New component — low risk.'],
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
    expect(screen.getByText('modified')).toBeDefined();
    expect(screen.getByText('high')).toBeDefined();
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
    expect(
      screen.getByText('This is a breaking change that requires careful review.'),
    ).toBeDefined();
    expect(screen.getByText('Run all Apex tests in the target org.')).toBeDefined();
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

  it('should not show source/target section for added items without values', () => {
    render(<DiffDetailModal diff={addedDiff} onClose={vi.fn()} />);
    expect(screen.queryByTestId('diff-source-value')).toBeNull();
    expect(screen.queryByTestId('diff-target-value')).toBeNull();
  });
});
