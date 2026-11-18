import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { SnapshotComparison, readSnapshotComparison } from './SnapshotComparison';
import type { OrgSnapshotComparison } from './SnapshotComparison';

const SNAPSHOT: OrgSnapshotComparison = {
  source: {
    orgId: 'org-1',
    totalObjects: 812,
    customObjects: 44,
    standardObjects: 768,
    queryableObjects: 790,
  },
  target: {
    orgId: 'org-2',
    totalObjects: 806,
    customObjects: 41,
    standardObjects: 765,
    queryableObjects: 784,
  },
  diff: { sourceOnly: ['Legacy__c'], targetOnly: ['Survey__c'], sharedCount: 805 },
  capturedAt: '2026-09-10T12:05:00.000Z',
};

describe('SnapshotComparison', () => {
  it('says when the two orgs were read, as a date in the panel’s language, not a raw stamp', () => {
    // It printed "2026-09-10T09:05:00.000Z" under the lists.
    render(<SnapshotComparison snapshot={SNAPSHOT} sourceLabel="Dev" targetLabel="QA" />);
    const readAt = screen.getByTestId('snapshot-captured-at').textContent ?? '';
    // In the time zone of the machine, which moves the day east of UTC+11.
    expect(readAt).toMatch(/^Read at Sep 1[01], 2026, \d{1,2}:\d{2}\s?[AP]M$/);
    expect(readAt).not.toContain('T12:05');
  });

  it('says no read time for a stamp that is not a date', () => {
    render(
      <SnapshotComparison
        snapshot={{ ...SNAPSHOT, capturedAt: 'later' }}
        sourceLabel="Dev"
        targetLabel="QA"
      />,
    );
    expect(screen.queryByTestId('snapshot-captured-at')).toBeNull();
  });

  it('names each object only one org holds, in the words of the diff', () => {
    render(<SnapshotComparison snapshot={SNAPSHOT} sourceLabel="Dev" targetLabel="QA" />);
    expect(screen.getByRole('heading').textContent).toBe('Objects');
    expect(screen.getByTestId('snapshot-object-status-Legacy__c').textContent).toBe(
      'Only in the source',
    );
    expect(screen.getByTestId('snapshot-object-status-Survey__c').textContent).toBe(
      'Only in the target',
    );
  });

  it('takes a capture in which neither org described an object for no answer', () => {
    const empty = {
      ...SNAPSHOT,
      source: { ...SNAPSHOT.source, totalObjects: 0 },
      target: { ...SNAPSHOT.target, totalObjects: 0 },
    };
    expect(readSnapshotComparison(empty)).toBeUndefined();
    expect(readSnapshotComparison(SNAPSHOT)).toEqual(SNAPSHOT);
  });
});
