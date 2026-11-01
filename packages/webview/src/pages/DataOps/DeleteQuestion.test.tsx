import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { DeleteQuestion } from './DeleteQuestion';

describe('DeleteQuestion', () => {
  it('asks its question, its delete button saying what it deletes and described by the question', () => {
    render(
      <DeleteQuestion
        id="q-1"
        question="Delete the template “Support desk”? Its rules are gone from this machine."
        confirmLabel="Delete template"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        testId="delete-template"
      />,
    );

    expect(screen.getByTestId('delete-template-question').querySelector('p')?.id).toBe('q-1');
    const confirm = screen.getByTestId('delete-template-confirm');
    expect(confirm.textContent).toBe('Delete template');
    expect(confirm.getAttribute('aria-describedby')).toBe('q-1');
    expect(screen.getByTestId('delete-template-cancel').textContent).toBe('Cancel');
  });

  it('answers yes or no through the button pressed', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <DeleteQuestion
        id="q-2"
        question="Delete this backup?"
        confirmLabel="Delete"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByTestId('delete-backup-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('delete-backup-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
