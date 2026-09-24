import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import de from '../../i18n/locales/de.json';
import en from '../../i18n/locales/en.json';
import es from '../../i18n/locales/es.json';
import fr from '../../i18n/locales/fr.json';
import ja from '../../i18n/locales/ja.json';
import ptBR from '../../i18n/locales/pt-BR.json';
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
        graph={{ objects: 200, truncated: true, maxNodes: 200 }}
        testId="coverage"
      />,
    );
    const text = screen.getByTestId('coverage').textContent ?? '';
    expect(text).toContain('200 objects (cap 200)');
    expect(text).toContain('maxNodes');
  });

  it('says the cap was raised when the graph holds more objects than it', () => {
    // Discovery raises its cap, up to twice it, for the parents a record
    // cannot be written without: "400 objects (cap 200)" read as a cap that
    // did not hold.
    render(
      <FrozenCoverageNotes
        graph={{ objects: 400, truncated: true, maxNodes: 200 }}
        testId="coverage"
      />,
    );
    const text = screen.getByTestId('coverage').textContent ?? '';
    expect(text).toContain(
      'Discovery stopped at 400 objects at a cap of 200 (raised for the parents their records cannot be written without)',
    );
    expect(text).not.toContain('(cap 200)');
    expect(text).toContain('maxNodes');
  });

  it.each(Object.entries({ en, fr, de, es, 'pt-BR': ptBR, ja }))(
    '%s says the raised cap in a note of its own, with both numbers',
    (_locale, catalogue) => {
      const { truncated, truncatedRaised } = catalogue.frozen.coverage;
      expect(truncatedRaised).toContain('{{objects}}');
      expect(truncatedRaised).toContain('{{maxNodes}}');
      expect(truncatedRaised).not.toBe(truncated);
    },
  );

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
