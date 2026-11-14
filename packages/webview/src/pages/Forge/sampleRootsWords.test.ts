import { describe, it, expect } from 'vitest';
import i18n from '../../i18n';
import { rootsChosenWords, windowInstantWords, windowWords } from './sampleRootsWords';

const t = i18n.t.bind(i18n);

describe('the words of the roots a sample was drawn among', () => {
  it('says an instant of a window in UTC, and one that does not read as written', () => {
    expect(windowInstantWords('2025-07-01T00:00:00Z')).toBe('Jul 1, 2025, 12:00 AM UTC');
    expect(windowInstantWords('not an instant')).toBe('not an instant');
  });

  it('says a window by its date and bounds, or by its last days', () => {
    expect(
      windowWords(t, {
        field: 'CreatedDate',
        from: '2025-01-01T00:00:00Z',
        to: '2025-07-01T00:00:00Z',
      }),
    ).toBe('roots made from Jan 1, 2025, 12:00 AM UTC to before Jul 1, 2025, 12:00 AM UTC');
    expect(windowWords(t, { field: 'LastModifiedDate', to: '2025-07-01T00:00:00Z' })).toBe(
      'roots last modified before Jul 1, 2025, 12:00 AM UTC',
    );
    expect(windowWords(t, { field: 'CreatedDate', lastDays: 1 })).toBe(
      'roots made in the last day',
    );
    expect(
      windowWords(t, { field: 'CreatedDate', lastDays: 90, from: '2026-08-17T09:30:00Z' }),
    ).toBe('roots made in the last 90 days, from Aug 17, 2026, 9:30 AM UTC');
  });

  it('lists how the roots were chosen, by the filters’ text or their objects alone', () => {
    expect(
      rootsChosenWords(t, {
        where: [{ objectApiName: 'Account', where: "BillingCountry = 'France'" }],
        strata: [{ objectApiName: 'Lead', field: 'Status', values: [] }],
      }),
    ).toBe("Account where BillingCountry = 'France'; Lead stratified by Status");
    expect(rootsChosenWords(t, { whereObjects: ['Account'], strataFields: ['Lead.Status'] })).toBe(
      'the roots of Account filtered; stratified by Lead.Status',
    );
    expect(rootsChosenWords(t, {})).toBe('');
  });
});
