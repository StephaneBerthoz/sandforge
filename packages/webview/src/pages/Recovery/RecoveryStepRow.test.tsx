import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import '../../i18n';
import type { RecoveryStep } from '@sandforge/shared';
import { RecoveryStepRow } from './RecoveryStepRow';

/** Draw one step in its list. */
function draw(step: RecoveryStep, onMark = vi.fn(), marking = false): ReturnType<typeof vi.fn> {
  render(
    <ol>
      <RecoveryStepRow
        number={7}
        step={step}
        line="What it does."
        onMark={onMark}
        marking={marking}
      />
    </ol>,
  );
  return onMark;
}

describe('RecoveryStepRow', () => {
  it('names the step by its number and title, with its status and its line', () => {
    draw({ id: 'deliverability', status: 'todo', reason: 'toDo' });
    expect(screen.getByRole('heading', { name: '7. Email deliverability' })).toBeInTheDocument();
    expect(screen.getByTestId('recovery-step-deliverability-status')).toHaveTextContent('To do');
    expect(screen.getByTestId('recovery-step-deliverability-line')).toHaveTextContent(
      'What it does.',
    );
  });

  it('offers Mark as done and Skip on a step a person checks in Setup', () => {
    const onMark = draw({ id: 'deliverability', status: 'todo', reason: 'toDo' });
    fireEvent.click(screen.getByRole('button', { name: 'Mark as done' }));
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(onMark.mock.calls).toEqual([['done'], ['skipped']]);
  });

  it('offers Skip alone on a step done when what it runs has run', () => {
    draw({ id: 'masking', status: 'todo', reason: 'toDo' });
    expect(screen.getByRole('button', { name: 'Skip' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark as done' })).toBeNull();
  });

  it('offers neither on the refresh, which the page is about', () => {
    draw({ id: 'refresh', status: 'done', reason: 'refreshDetected' });
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('offers Undo on a mark kept by hand, and nothing on a status read from what ran', () => {
    const onMark = draw({ id: 'endpoints', status: 'done', reason: 'markedDone' });
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onMark).toHaveBeenCalledWith('cleared');
  });

  it('offers nothing on a step done by what ran, nor on one that does not apply', () => {
    draw({ id: 'masking', status: 'done', reason: 'ranAfterRefresh' });
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('offers Skip on a refused step, which nothing else ends', () => {
    draw({ id: 'frozen', status: 'refused', reason: 'stagingSandbox' });
    expect(screen.getByTestId('recovery-step-frozen-status')).toHaveTextContent('Refused');
    expect(screen.getByRole('button', { name: 'Skip' })).toBeInTheDocument();
  });

  it('holds its buttons while a mark is being kept', () => {
    draw({ id: 'masking', status: 'skipped', reason: 'skipped' }, vi.fn(), true);
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
  });
});
