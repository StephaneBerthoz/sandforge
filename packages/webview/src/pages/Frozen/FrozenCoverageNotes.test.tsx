import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { FrozenCoverageNotes } from './FrozenCoverageNotes';

describe('FrozenCoverageNotes', () => {
  it('says nothing about a dataset that holds everything it reached', () => {
    const { container } = render(
      <FrozenCoverageNotes
        graph={{ objects: 12, truncated: false, maxNodes: 50 }}
        testId="coverage"
      />,
    );
    expect(container.textContent).toBe('');
  });

  it('warns that a graph cut at its cap may have left objects out', () => {
    render(
      <FrozenCoverageNotes
        graph={{ objects: 400, truncated: true, maxNodes: 200 }}
        testId="coverage"
      />,
    );
    const text = screen.getByTestId('coverage').textContent ?? '';
    expect(text).toContain('400 objects (cap 200)');
    expect(text).toContain('maxNodes');
  });

  it('names what was read unbounded and what was left out for its files', () => {
    render(
      <FrozenCoverageNotes
        unboundedObjects={['DashboardComponent']}
        filesLeftOut={['QuoteDocument', 'ContentVersion']}
        testId="coverage"
      />,
    );
    const text = screen.getByTestId('coverage').textContent ?? '';
    expect(text).toContain('DashboardComponent');
    expect(text).toContain('QuoteDocument, ContentVersion');
  });

  it('names what was left out because the platform writes it, or what it depends on, itself', () => {
    render(
      <FrozenCoverageNotes
        leftToThePlatform={[
          { objectApiName: 'FeedItem', count: 2, note: '2 tracked changes left out' },
          { objectApiName: 'FeedComment', count: 1, note: '1 left out' },
        ]}
        testId="coverage"
      />,
    );
    const text = screen.getByTestId('coverage').textContent ?? '';
    expect(text).toContain('the platform writes these records');
    expect(text).toContain('FeedItem (2), FeedComment (1)');
  });

  it('names the records that need an object excludedObjects leaves out, and the object each needs', () => {
    render(
      <FrozenCoverageNotes
        exclusionCosts={[
          {
            objectApiName: 'OpportunityLineItem',
            excludedObject: 'PricebookEntry',
            count: 3,
            note: '3 lines',
          },
          { objectApiName: 'Order', excludedObject: 'PricebookEntry', count: 2, note: '2 orders' },
        ]}
        testId="coverage"
      />,
    );
    const text = screen.getByTestId('coverage').textContent ?? '';
    expect(text).toContain('Cannot be loaded as they are');
    expect(text).toContain('OpportunityLineItem (3) → PricebookEntry, Order (2) → PricebookEntry');
  });
});
