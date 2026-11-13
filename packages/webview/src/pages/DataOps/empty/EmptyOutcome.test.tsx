import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import '../../../i18n';
import { EmptyOutcome, type EmptyOutcomeProps } from './EmptyOutcome';
import { RUN_ID, runResultOf, undoResultOf } from './testing/emptyAnswers';

vi.mock('../../../hooks/useOperationProgress', () => ({
  useOperationProgress: () => ({
    getProgress: (operationId: string) =>
      operationId === 'req-1'
        ? {
            operationId,
            percentage: 40,
            processedRecords: 0,
            totalRecords: 0,
            currentStep: 'Contact: 10 of about 25 settled',
          }
        : undefined,
  }),
}));

const ended = { loading: false, requestId: 'req-1', error: null, errorCode: null };

function renderOutcome(props: Partial<EmptyOutcomeProps> = {}) {
  const handlers = {
    onStop: vi.fn(),
    onUndo: vi.fn(),
    onPreviewAgain: vi.fn(),
    onDone: vi.fn(),
  };
  render(
    <EmptyOutcome
      orgId="org-1"
      orgName="dev"
      kind="run"
      state={ended}
      run={null}
      undo={null}
      stopRequested={false}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

describe('EmptyOutcome', () => {
  it('says what a run under way is doing, and stops it', () => {
    const { onStop } = renderOutcome({ state: { ...ended, loading: true } });
    expect(screen.getByTestId('empty-outcome-title')).toHaveTextContent('Emptying dev');
    expect(screen.getByTestId('empty-outcome-step')).toHaveTextContent(
      'Contact: 10 of about 25 settled',
    );
    fireEvent.click(screen.getByTestId('empty-outcome-stop'));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('says a stop asked for, and asks it no more', () => {
    renderOutcome({ state: { ...ended, loading: true }, stopRequested: true });
    expect(screen.getByTestId('empty-outcome-stop')).toBeDisabled();
    expect(screen.getByTestId('empty-outcome-stopping')).toHaveTextContent('dev');
  });

  it('says what the run did with each object, and offers its Undo', () => {
    const { onUndo } = renderOutcome({ run: runResultOf() });
    expect(screen.getByTestId('empty-outcome-title')).toHaveTextContent('dev emptied');
    expect(screen.getByTestId('empty-result-totals')).toHaveTextContent('143 deleted');
    expect(screen.getByTestId('empty-result-pass-Account')).toHaveTextContent('Account118020');
    fireEvent.click(screen.getByTestId('empty-result-undo'));
    expect(onUndo).toHaveBeenCalledWith(RUN_ID);
  });

  it('says why there is no Undo after a delete for good', () => {
    renderOutcome({
      run: runResultOf({ hard: true, undo: { offered: false, why: 'hard' } }),
    });
    expect(screen.queryByTestId('empty-result-undo')).toBeNull();
    expect(screen.getByTestId('empty-result-no-undo')).toHaveTextContent(
      'Undo is not possible: this emptying deleted for good.',
    );
    expect(screen.getByTestId('empty-result-totals')).toHaveTextContent('143 deleted for good');
  });

  it('names the org words for each record refused, and what was made since', () => {
    renderOutcome({
      run: runResultOf({
        status: 'partial',
        passes: [
          {
            objectApiName: 'Account',
            planned: 120,
            deleted: 118,
            gone: 0,
            refused: 2,
            madeSince: 3,
            reasons: ['DELETE_FAILED: a Case still names it in AccountId'],
          },
        ],
      }),
    });
    expect(screen.getByTestId('empty-outcome-title')).toHaveTextContent('dev emptied in part');
    expect(screen.getByTestId('empty-result-pass-Account')).toHaveTextContent(
      '3 records made since the preview are left as they are',
    );
    expect(screen.getByTestId('empty-result-pass-Account')).toHaveTextContent(
      'DELETE_FAILED: a Case still names it in AccountId',
    );
  });

  it('says what an undo brought back and what the bin no longer held', () => {
    renderOutcome({ kind: 'undo', undo: undoResultOf() });
    expect(screen.getByTestId('empty-outcome-title')).toHaveTextContent(
      'Part of what the emptying deleted is back in dev',
    );
    expect(screen.getByTestId('empty-undo-object-Account')).toHaveTextContent(
      '110 of 118 brought back. 8 not in the recycle bin any more.',
    );
  });

  it('says a stop before anything was deleted, and a refusal in its words', () => {
    renderOutcome({ state: { ...ended, error: 'Stopped.', errorCode: 'CANCELLED' } });
    expect(screen.getByTestId('empty-outcome-stopped-nothing')).toHaveTextContent(
      'It was stopped before anything was deleted.',
    );
  });

  it('shows the extension refusal with its code', () => {
    renderOutcome({
      state: {
        ...ended,
        error: 'dev changed since the preview, beyond what was confirmed.',
        errorCode: 'ORG_CHANGED',
      },
    });
    expect(screen.getByTestId('empty-outcome-title')).toHaveTextContent(
      'The emptying of dev was refused',
    );
    expect(screen.getByTestId('empty-outcome-error')).toHaveTextContent(
      'dev changed since the preview',
    );
  });
});
