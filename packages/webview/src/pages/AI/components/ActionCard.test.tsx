import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

import { ActionCard, type DiagnoseResultDisplay } from './ActionCard';

const mkResult = (
  actions: DiagnoseResultDisplay['suggestedActions'] = [],
  confidence: DiagnoseResultDisplay['confidence'] = 'medium',
): DiagnoseResultDisplay => ({
  summary: 'Test summary',
  rootCause: 'Test root cause description',
  suggestedActions: actions,
  confidence,
});

describe('ActionCard', () => {
  it('renders summary, rootCause, and confidence badge', () => {
    render(
      <ActionCard
        runId="r1"
        result={mkResult([], 'high')}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect(screen.getByText(/Test summary/)).toBeTruthy();
    expect(screen.getByText(/Test root cause/)).toBeTruthy();
    expect(screen.getByTestId('ai-action-card-confidence').textContent).toBe('HIGH');
  });

  it('slices to 5 actions even if more are supplied (defense in depth)', () => {
    const actions = Array.from({ length: 7 }, (_, i) => ({
      label: `action ${i}`,
      kind: 'copy-soql' as const,
      requiresApproval: false,
    }));
    render(
      <ActionCard
        runId="r1"
        result={mkResult(actions)}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    const rows = screen.getAllByTestId(/^ai-action-card-action-/);
    expect(rows.length).toBe(5);
  });

  it('Approve button click invokes onApprove(index)', () => {
    const onApprove = vi.fn();
    render(
      <ActionCard
        runId="r1"
        result={mkResult([
          { label: 'apply', kind: 'apply-fix', requiresApproval: true, payload: 'p' },
        ])}
        onApprove={onApprove}
        onReject={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('ai-action-card-approve-0'));
    expect(onApprove).toHaveBeenCalledWith(0);
  });

  it('Modify opens textarea modal; Save invokes onApprove(index, modifiedText)', () => {
    const onApprove = vi.fn();
    render(
      <ActionCard
        runId="r1"
        result={mkResult([
          { label: 'apply', kind: 'apply-fix', requiresApproval: true, payload: 'original' },
        ])}
        onApprove={onApprove}
        onReject={vi.fn()}
      />,
    );
    act(() => {
      fireEvent.click(screen.getByTestId('ai-action-card-modify-0'));
    });
    const modal = screen.getByTestId('ai-action-card-modify-modal-0');
    const textarea = modal.querySelector('textarea')!;
    act(() => {
      fireEvent.change(textarea, { target: { value: 'modified text' } });
    });
    act(() => {
      fireEvent.click(screen.getByTestId('ai-action-card-modify-save-0'));
    });
    expect(onApprove).toHaveBeenCalledWith(0, 'modified text');
  });

  it('Reject invokes onReject(index)', () => {
    const onReject = vi.fn();
    render(
      <ActionCard
        runId="r1"
        result={mkResult([
          { label: 'apply', kind: 'apply-fix', requiresApproval: true, payload: 'p' },
        ])}
        onApprove={vi.fn()}
        onReject={onReject}
      />,
    );
    fireEvent.click(screen.getByTestId('ai-action-card-reject-0'));
    expect(onReject).toHaveBeenCalledWith(0);
  });

  it('Read-only action (requiresApproval=false) renders Execute, no Approve/Reject/Modify trio', () => {
    render(
      <ActionCard
        runId="r1"
        result={mkResult([
          { label: 'copy', kind: 'copy-soql', requiresApproval: false, payload: 'SELECT' },
        ])}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onExecute={vi.fn()}
      />,
    );
    expect(screen.getByTestId('ai-action-card-execute-0')).toBeTruthy();
    expect(screen.queryByTestId('ai-action-card-approve-0')).toBeNull();
    expect(screen.queryByTestId('ai-action-card-reject-0')).toBeNull();
    expect(screen.queryByTestId('ai-action-card-modify-0')).toBeNull();
  });

  it('Per-action state badge renders when actionStates[index] is provided', () => {
    render(
      <ActionCard
        runId="r1"
        result={mkResult([
          { label: 'apply', kind: 'apply-fix', requiresApproval: true, payload: 'p' },
        ])}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        actionStates={{ 0: { status: 'executed', message: 'edit applied' } }}
      />,
    );
    const stateBadge = screen.getByTestId('ai-action-card-state-0');
    expect(stateBadge.textContent).toMatch(/Exécuté/);
  });

  it('testid root matches the runId contract', () => {
    render(
      <ActionCard
        runId="my-run-42"
        result={mkResult([])}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect(screen.getByTestId('ai-action-card-my-run-42')).toBeTruthy();
  });
});
