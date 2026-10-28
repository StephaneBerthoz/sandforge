import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { SeedObjectResult } from '@sandforge/shared';
import '../../../i18n';

import { ScenarioKnowledgeResult } from './ScenarioKnowledgeResult';

/** The articles' object as a run that wrote them all answers it. */
const WRITTEN: SeedObjectResult = {
  objectApiName: 'Knowledge__kav',
  recordsCreated: 6,
  recordsFailed: 0,
  createdIds: [],
  errors: [],
  optional: true,
};

/** The articles' object of an org without Knowledge: skipped, its card saying why. */
const SKIPPED: SeedObjectResult = {
  ...WRITTEN,
  recordsCreated: 0,
  errors: ['Skipped: Knowledge__kav: Salesforce Knowledge is not turned on in it.'],
};

describe('ScenarioKnowledgeResult — what a scenario did with its articles', () => {
  it('says every article published and every closed case linked, and no draft left', () => {
    render(
      <ScenarioKnowledgeResult
        knowledge={{
          publish: { asked: 6, done: 6, notDone: [] },
          links: { asked: 20, done: 20, notDone: [] },
        }}
        articles={WRITTEN}
      />,
    );

    expect(screen.getByTestId('scenario-knowledge-published').textContent).toBe(
      'Articles published: 6 of 6',
    );
    expect(screen.getByTestId('scenario-knowledge-linked').textContent).toBe(
      'Closed cases linked to the article that answers them: 20 of 20',
    );
    expect(screen.queryByTestId('scenario-knowledge-drafts-left')).toBeNull();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('names each article left a draft and each case not linked, in the words given, and says what to do about a draft', () => {
    render(
      <ScenarioKnowledgeResult
        knowledge={{
          publish: {
            asked: 6,
            done: 5,
            notDone: [
              {
                key: 'retail-orders-article-refund',
                reason:
                  'Left a draft: INSUFFICIENT_ACCESS: You do not have the permission to publish articles.',
              },
            ],
          },
          links: {
            asked: 20,
            done: 19,
            notDone: [
              {
                key: 'retail-orders-c03-closed-1',
                reason: 'Not linked: its case was not written.',
              },
            ],
          },
        }}
        articles={WRITTEN}
      />,
    );

    const items = screen.getAllByRole('listitem').map((item) => item.textContent);
    expect(items).toEqual([
      'retail-orders-article-refund: Left a draft: INSUFFICIENT_ACCESS: You do not have the ' +
        'permission to publish articles.',
      'retail-orders-c03-closed-1: Not linked: its case was not written.',
    ]);
    expect(screen.getByTestId('scenario-knowledge-drafts-left').textContent).toBe(
      "An article left a draft is not indexed by the agent's data library: publish it in " +
        'Knowledge, or remove this seed and run it again.',
    );
  });

  it('says why none of it was done when the articles were written but the step failed', () => {
    render(
      <ScenarioKnowledgeResult
        knowledge={{
          skipped: 'The articles were neither published nor linked: socket hang up',
        }}
        articles={WRITTEN}
      />,
    );

    expect(screen.getByTestId('scenario-knowledge-skipped').textContent).toBe(
      'No article was published, and no closed case was linked to one.' +
        'The articles were neither published nor linked: socket hang up',
    );
  });

  it('says nothing when no article was written, which their own card says, or when nothing was asked', () => {
    const { container, rerender } = render(
      <ScenarioKnowledgeResult knowledge={{ skipped: SKIPPED.errors[0] }} articles={SKIPPED} />,
    );
    expect(container.innerHTML).toBe('');

    // Every article refused: its card names the refusals.
    const refused = {
      ...WRITTEN,
      recordsCreated: 0,
      recordsFailed: 6,
      errors: ['STRING_TOO_LONG'],
    };
    rerender(
      <ScenarioKnowledgeResult knowledge={{ skipped: 'STRING_TOO_LONG' }} articles={refused} />,
    );
    expect(container.innerHTML).toBe('');

    rerender(<ScenarioKnowledgeResult knowledge={undefined} articles={WRITTEN} />);
    expect(container.innerHTML).toBe('');
  });
});
