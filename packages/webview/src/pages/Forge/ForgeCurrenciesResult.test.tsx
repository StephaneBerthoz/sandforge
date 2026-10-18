import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { CurrencyReplaced } from '@sandforge/shared';
import '../../i18n';
import { ForgeCurrenciesResult } from './ForgeCurrenciesResult';

const ENTRIES: CurrencyReplaced[] = [
  {
    objectApiName: 'Opportunity',
    from: 'GBP',
    to: 'USD',
    chosenBy: 'corporate',
    rows: 4,
    fields: ['Amount'],
  },
  {
    objectApiName: 'Account',
    from: 'GBP',
    to: 'EUR',
    chosenBy: 'record-type-default',
    rows: 1,
    fields: ['AnnualRevenue'],
    atTargetRate: true,
  },
  {
    objectApiName: 'Contact',
    from: 'GBP',
    to: 'USD',
    chosenBy: 'corporate',
    rows: 2,
    fields: [],
  },
  {
    objectApiName: 'Order__c',
    from: 'JPY',
    to: 'EUR',
    chosenBy: 'decision',
    rows: 1,
    fields: [],
    notConverted: true,
  },
];

describe('ForgeCurrenciesResult', () => {
  it('says per object the rows written in another currency, which one and why, and what became of their amounts', () => {
    render(<ForgeCurrenciesResult entries={ENTRIES} />);

    expect(screen.getByRole('heading', { name: 'Written in another currency' })).toBeDefined();
    expect(
      screen.getAllByTestId('forge-results-currencies-row').map((row) => row.textContent),
    ).toEqual([
      "Opportunity — 4 rows in GBP, written in USD, the target org's corporate currency — amounts converted at the source org's rates: Amount",
      "Account — 1 row in GBP, written in EUR, the default of their record type — amounts converted at the source org's rate for GBP and the target org's for EUR: AnnualRevenue",
      "Contact — 2 rows in GBP, written in USD, the target org's corporate currency — no amount to convert",
      'Order__c — 1 row in JPY, written in EUR, as decided — amounts written as read: no rate converts JPY into EUR',
    ]);
  });

  it('says the rows that took the currency of the record they belong to, and the date field whose dated rates converted the amounts', () => {
    render(
      <ForgeCurrenciesResult
        entries={[
          {
            objectApiName: 'Opportunity',
            from: 'GBP',
            to: 'USD',
            chosenBy: 'corporate',
            rows: 1,
            fields: ['Amount'],
            datedBy: 'CloseDate',
          },
          {
            objectApiName: 'OpportunityLineItem',
            from: 'GBP',
            to: 'USD',
            chosenBy: 'parent',
            rows: 2,
            fields: ['UnitPrice'],
            datedBy: 'CloseDate',
          },
        ]}
      />,
    );

    expect(
      screen.getAllByTestId('forge-results-currencies-row').map((row) => row.textContent),
    ).toEqual([
      "Opportunity — 1 row in GBP, written in USD, the target org's corporate currency — amounts converted at the source org's rates: Amount — at the dated rates of CloseDate",
      "OpportunityLineItem — 2 rows in GBP, written in USD, the currency of the record they belong to — amounts converted at the source org's rates: UnitPrice — at the dated rates of CloseDate",
    ]);
  });
});
