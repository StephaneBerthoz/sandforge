import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import '../../../i18n';
import { EmptyPreview, type EmptyPreviewProps } from './EmptyPreview';
import { NO_BOXES } from './emptyFacts';
import { previewAnswer } from './testing/emptyAnswers';

function renderPreview(props: Partial<EmptyPreviewProps> = {}) {
  const handlers = {
    onBoxChange: vi.fn(),
    onMuteChange: vi.fn(),
    onReadAgain: vi.fn(),
    onEmpty: vi.fn(),
    onResume: vi.fn(),
    onUndoOpen: vi.fn(),
  };
  render(
    <EmptyPreview
      orgId="org-1"
      orgName="dev"
      answer={previewAnswer()}
      boxes={NO_BOXES}
      muted={false}
      reading={false}
      stale={false}
      busy={false}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

describe('EmptyPreview', () => {
  it('says each object in the order the run takes it, what goes along, refuses and blocks', () => {
    renderPreview();
    expect(screen.getByTestId('empty-preview-summary')).toHaveTextContent(
      '670 records of 3 objects go to the recycle bin.',
    );
    expect(screen.getByTestId('empty-preview-pass-Contact')).toHaveTextContent('340251 call');
    expect(screen.getByTestId('empty-preview-along-Opportunity')).toHaveTextContent(
      '210 Opportunity, by AccountId → Account',
    );
    expect(screen.getByTestId('empty-preview-likely-activatedOrder')).toHaveTextContent(
      '3 Order past Draft: set back to Draft first',
    );
    expect(screen.getByTestId('empty-preview-blocker-Case')).toHaveTextContent(
      'pick Case too, or leave Account out.',
    );
    expect(screen.getByTestId('empty-preview-cost-requests')).toHaveTextContent(
      'About 31 API requests, 99,000 of 100,000 left today.',
    );
  });

  it('draws the button that empties under it all, saying the act and its size', () => {
    const { onEmpty } = renderPreview();
    const button = screen.getByTestId('empty-preview-empty');
    expect(button).toHaveTextContent('Delete 670 records from 3 objects…');
    fireEvent.click(button);
    expect(onEmpty).toHaveBeenCalledTimes(1);
  });

  it('holds the button while a refusal no box lifts stands, and says the refusal', () => {
    renderPreview({
      answer: previewAnswer({
        refusals: [
          { code: 'PEOPLE_ACTIVE', message: '2 people changed records in the last hour.' },
        ],
      }),
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      '2 people changed records in the last hour.',
    );
    expect(screen.getByTestId('empty-preview-empty')).toBeDisabled();
  });

  it('offers the box that accepts what Undo leaves, and lifts its refusal once ticked', () => {
    const answer = previewAnswer({
      refusals: [{ code: 'NO_UNDO', message: 'Undo cannot bring 4 records back.' }],
    });
    const { onBoxChange } = renderPreview({ answer });
    expect(screen.getByTestId('empty-preview-empty')).toBeDisabled();
    fireEvent.click(screen.getByTestId('empty-preview-accept-no-undo'));
    expect(onBoxChange).toHaveBeenCalledWith('acceptNoUndo', true);
  });

  it('says each loss to Undo by why: before a record named, standard prices with their product, an object Salesforce does not bring back', () => {
    const answer = previewAnswer();
    renderPreview({
      answer: {
        ...answer,
        preview: {
          ...answer.preview,
          undoLost: [
            {
              objectApiName: 'Entitlement',
              field: 'AccountId',
              parent: 'Account',
              reason: 'restricted',
              records: { records: 1 },
            },
            {
              objectApiName: 'PricebookEntry',
              field: 'Product2Id',
              parent: 'Product2',
              reason: 'standardPrices',
              records: { records: 2 },
            },
            {
              objectApiName: 'PricebookEntry',
              reason: 'notRestorable',
              records: { records: 34 },
            },
          ],
        },
      },
    });
    const lost = screen.getByTestId('empty-preview-undo-lost');
    expect(lost).toHaveTextContent('1 Entitlement: gone before Account');
    expect(lost).toHaveTextContent('2 PricebookEntry: standard prices that go with Product2');
    expect(lost).toHaveTextContent(
      "34 PricebookEntry: sent on their own, which Salesforce doesn't bring back",
    );
    expect(lost).not.toHaveTextContent('undefined');
  });

  it('lets what the boxes ticked lift their refusals', () => {
    renderPreview({
      answer: previewAnswer({
        refusals: [{ code: 'NO_UNDO', message: 'Undo cannot bring 4 records back.' }],
      }),
      boxes: { acceptNoUndo: true, acceptEmails: false },
    });
    expect(screen.queryByTestId('empty-preview-holding')).toBeNull();
    expect(screen.getByTestId('empty-preview-empty')).toBeEnabled();
  });

  it('holds the button once the options changed since the read, and says so', () => {
    renderPreview({ stale: true });
    expect(screen.getByTestId('empty-preview-stale')).toBeInTheDocument();
    expect(screen.getByTestId('empty-preview-empty')).toBeDisabled();
  });

  it('says a delete for good leaves no Undo, the bin left alone', () => {
    const answer = previewAnswer();
    renderPreview({
      answer: { ...answer, preview: { ...answer.preview, deleteMode: 'hard', undo: false } },
    });
    expect(screen.getByTestId('empty-preview-hard')).toHaveTextContent(
      'Undo will not be possible.',
    );
    expect(screen.getByTestId('empty-preview-summary')).toHaveTextContent('deleted for good');
    expect(screen.getByTestId('empty-preview-cost-bin')).toHaveTextContent(
      'Nothing goes to the recycle bin.',
    );
  });

  it('offers to take up or undo the last emptying left open', () => {
    const { onResume, onUndoOpen } = renderPreview({
      answer: previewAnswer({
        openRun: { runId: 'em-20261112-100000-abcd', startedAt: '2026-11-12T10:00:00.000Z' },
      }),
    });
    fireEvent.click(screen.getByTestId('empty-preview-resume'));
    expect(onResume).toHaveBeenCalledWith('em-20261112-100000-abcd');
    fireEvent.click(screen.getByTestId('empty-preview-undo-open'));
    expect(onUndoOpen).toHaveBeenCalledWith('em-20261112-100000-abcd');
  });

  it('draws no button when the org holds nothing to delete', () => {
    const answer = previewAnswer();
    renderPreview({
      answer: {
        ...answer,
        preview: { ...answer.preview, total: { records: 0, objects: 0, uncounted: [] } },
      },
    });
    expect(screen.queryByTestId('empty-preview-empty')).toBeNull();
    expect(screen.getByTestId('empty-preview-summary')).toHaveTextContent(
      'dev holds nothing these objects would delete.',
    );
  });

  it('says what a user without View All Data does not see, object by object', () => {
    renderPreview({
      answer: previewAnswer({
        access: {
          kind: 'perObject',
          viewAllData: false,
          modifyAllData: false,
          unseen: [{ objectApiName: 'Task', reason: 'activities' }],
        },
      }),
    });
    expect(screen.getByTestId('empty-preview-unseen')).toHaveTextContent(
      'Task · Salesforce has no View All for activities',
    );
  });
});
