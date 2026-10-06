import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { ForgeDecisionApplied } from '@sandforge/shared';
import '../../i18n';
import { ForgeDecisionsResult } from './ForgeDecisionsResult';

/** A value mapped for one record type, a default given, and rows held back. */
const APPLIED: ForgeDecisionApplied[] = [
  {
    kind: 'map_value',
    objectApiName: 'Case',
    field: 'Origin',
    recordType: 'Support',
    from: 'Fax',
    to: 'Phone',
    rows: 12,
  },
  { kind: 'set_default', objectApiName: 'Account', field: 'Region__c', to: 'North', rows: 3 },
  {
    kind: 'skip_rows',
    objectApiName: 'Opportunity',
    field: 'CurrencyIsoCode',
    from: 'CHF',
    rows: 2,
  },
];

describe('ForgeDecisionsResult', () => {
  it('lists each decision the run applied: its kind, object, field, values and rows', () => {
    render(<ForgeDecisionsResult decisions={APPLIED} simulated={false} />);

    const rows = screen.getAllByTestId('forge-results-decision');
    expect(
      rows.map((row) =>
        within(row)
          .getAllByRole('cell')
          .map((c) => c.textContent),
      ),
    ).toEqual([
      ['another value is written', 'Case', 'Origin (record type Support)', '“Fax” → “Phone”', '12'],
      ['a default value is written', 'Account', 'Region__c', '“North”', '3'],
      ['these rows are skipped', 'Opportunity', 'CurrencyIsoCode', '“CHF”', '2'],
    ]);
    expect(screen.getByRole('heading').textContent).toBe('Decisions applied');
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Decision',
      'Object',
      'Field',
      'Values',
      'Rows',
    ]);
  });

  it('says a simulation changed no record in the target', () => {
    render(<ForgeDecisionsResult decisions={APPLIED} simulated />);

    expect(screen.getByTestId('forge-results-decisions').textContent).toContain(
      'nothing was written',
    );
  });
});
