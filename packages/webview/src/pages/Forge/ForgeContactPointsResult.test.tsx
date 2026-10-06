import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ForgeContactPointsReport } from '@sandforge/shared';
import i18n from '../../i18n';
import { ForgeContactPointsResult } from './ForgeContactPointsResult';

const NEUTRALIZED: ForgeContactPointsReport = {
  neutralized: true,
  fields: [
    { objectApiName: 'Contact', field: 'Email', kind: 'email', values: 3 },
    { objectApiName: 'Contact', field: 'SMS_Number__c', kind: 'phone', values: 1 },
  ],
  values: 4,
};

describe('ForgeContactPointsResult', () => {
  it('says the run neutralized the contact points, how many values in how many fields, field by field', () => {
    render(<ForgeContactPointsResult report={NEUTRALIZED} />);

    expect(screen.getByRole('heading', { name: 'Emails and phone numbers' })).toBeDefined();
    expect(screen.getByTestId('forge-results-contact-points-summary').textContent).toBe(
      i18n.t('forge.contactPoints.neutralized', { values: '4 values', fields: '2 fields' }),
    );
    expect(
      screen.getAllByTestId('forge-results-contact-points-row').map((row) => row.textContent),
    ).toEqual(['Contact.Email — 3 values', 'Contact.SMS_Number__c — 1 value']);
    expect(screen.queryByTestId('forge-results-contact-points-kept')).toBeNull();
  });

  it('says so when the records written held none', () => {
    render(<ForgeContactPointsResult report={{ neutralized: true, fields: [], values: 0 }} />);

    expect(screen.getByTestId('forge-results-contact-points-summary').textContent).toBe(
      i18n.t('forge.contactPoints.none'),
    );
    expect(screen.queryAllByTestId('forge-results-contact-points-row')).toEqual([]);
  });

  it('warns that the records went with their own addresses and numbers when the run kept them', () => {
    render(<ForgeContactPointsResult report={{ neutralized: false, fields: [], values: 0 }} />);

    expect(screen.getByTestId('forge-results-contact-points-kept').textContent).toBe(
      "Written as the source holds them, as the run was asked: the target org's automation may have emailed or texted real people.",
    );
    expect(screen.queryByTestId('forge-results-contact-points-summary')).toBeNull();
  });
});
