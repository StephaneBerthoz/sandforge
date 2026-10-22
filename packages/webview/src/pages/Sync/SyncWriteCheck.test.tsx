import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { SyncWriteCheck } from '@sandforge/shared';
import '../../i18n';
import { SyncAlreadyCopiedLine, SyncWriteCheckCard } from './SyncWriteCheck';

/** 30 contacts into a Developer Edition whose contact flow sends two emails each. */
const PAST_EMAILS: SyncWriteCheck = {
  objects: [{ objectApiName: 'Contact', rows: 30 }],
  total: 30,
  alreadyCopied: 40,
  storage: { verdict: 'fits', estimateMB: 0.06, maxMB: 5, remainingMB: 3 },
  emails: [
    {
      limit: 'SingleEmail',
      emails: 60,
      verdict: 'exceeds',
      remaining: 15,
      max: 15,
      objects: [{ objectApiName: 'Contact', perRecord: 2 }],
    },
  ],
  verdict: 'asks',
};

describe('SyncWriteCheckCard', () => {
  it('says what a run would meet before its first write, and that it asks first', () => {
    render(<SyncWriteCheckCard check={PAST_EMAILS} />);

    expect(screen.getByTestId('sync-write-check-records').textContent).toBe(
      '30 records to write (Contact 30)',
    );
    expect(screen.getByTestId('sync-write-check').textContent).toContain(
      'Not counted: 40 records an earlier run of this configuration copied, still in the target, left as they are.',
    );
    expect(screen.getByTestId('sync-write-check-storage').textContent).toBe(
      'Data storage: about 0.06 MB, of the 3 MB the target org has left out of 5 MB.',
    );
    expect(screen.getByTestId('sync-write-check-emails-SingleEmail').textContent).toBe(
      "Single emails: about 60 sent by the target org's automation as these records go in, more than the 15 of 15 left today. Past them, a record whose Flow fails in the save is refused.",
    );
    expect(screen.getByTestId('sync-write-check-verdict').textContent).toBe(
      'The run asks you before it writes.',
    );
  });

  it('says how many records it may write over, kept first and put back by its removal', () => {
    render(<SyncWriteCheckCard check={{ ...PAST_EMAILS, overwrites: 30 }} />);

    expect(screen.getByTestId('sync-write-check-overwrites').textContent).toBe(
      'Of them, up to 30 may write over records the target org holds: what they hold is read ' +
        'and kept first, and removing the run puts it back.',
    );
  });

  it('says a run past the storage is refused before it writes anything', () => {
    render(
      <SyncWriteCheckCard
        check={{
          ...PAST_EMAILS,
          emails: [],
          alreadyCopied: 0,
          storage: { verdict: 'exceeds', estimateMB: 5.86, maxMB: 5, remainingMB: 4 },
          verdict: 'refused',
        }}
      />,
    );

    expect(screen.getByTestId('sync-write-check-storage').textContent).toBe(
      'Data storage: about 5.86 MB, more than the 4 MB the target org has left out of 5 MB.',
    );
    expect(screen.getByTestId('sync-write-check-verdict').textContent).toBe(
      'The run is refused before it writes anything.',
    );
  });

  it('says the write order, and when the records could not be counted', () => {
    render(
      <SyncWriteCheckCard
        unread="INVALID_FIELD"
        order={{
          objects: ['Account', 'Contact'],
          moved: [{ objectApiName: 'Contact', after: 'Account', field: 'AccountId' }],
          cycles: [],
        }}
      />,
    );

    expect(screen.getByTestId('sync-write-check-order').textContent).toBe(
      'Written in this order: Account and Contact.',
    );
    expect(screen.getByTestId('sync-write-check').textContent).toContain(
      'Contact — Written after Account, which its AccountId names.',
    );
    expect(screen.getByTestId('sync-write-check-unread').textContent).toBe(
      'The records to write could not be counted (INVALID_FIELD): a run is refused until they can be.',
    );
  });

  it('shows nothing when there is nothing to say', () => {
    const { container } = render(<SyncWriteCheckCard />);
    expect(container.textContent).toBe('');
  });
});

describe('SyncAlreadyCopiedLine', () => {
  it('says what a run left, and what a simulated one would leave, as an earlier run copied it', () => {
    const { rerender } = render(<SyncAlreadyCopiedLine count={2} testId="copied" />);
    expect(screen.getByTestId('copied').textContent).toBe(
      '2 records already copied by an earlier run of this configuration, left as they were.',
    );

    rerender(<SyncAlreadyCopiedLine count={1} simulated testId="copied" />);
    expect(screen.getByTestId('copied').textContent).toBe(
      '1 already copied by an earlier run of this configuration, left as it is.',
    );
  });
});
