import { describe, it, expect } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { DATA_STORAGE_NOT_TOLD, type SyncWriteCheck } from '@sandforge/shared';
import i18n from '../../i18n';
import fr from '../../i18n/locales/fr.json';
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
  it('says why a run would be refused for a checkpoint whose scope could not be read', () => {
    const why = 'The checkpoint before the run could not be taken: the org would not say.';
    render(
      <SyncWriteCheckCard check={{ ...PAST_EMAILS, verdict: 'refused', checkpointUnread: why }} />,
    );
    expect(screen.getByTestId('sync-write-check-checkpoint-unread').textContent).toBe(why);
    expect(screen.getByTestId('sync-write-check-verdict').className).toContain('text-status-error');
  });

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

  it("says in the page's language that the target does not tell a Standard User its storage", async () => {
    // Its `/limits` leave the storage out: the card quoted the reason the
    // command line prints, a JSON dump before it was put in words.
    const notTold: SyncWriteCheck = {
      ...PAST_EMAILS,
      storage: { verdict: 'unread', estimateMB: 0.06, unread: DATA_STORAGE_NOT_TOLD },
    };
    const { unmount } = render(<SyncWriteCheckCard check={notTold} />);

    expect(screen.getByTestId('sync-write-check-storage').textContent).toBe(
      'Data storage: about 0.06 MB. The target org does not tell the user the run writes as what it has left.',
    );
    unmount();
    i18n.addResourceBundle('fr', 'translation', fr);
    await act(async () => {
      await i18n.changeLanguage('fr');
    });
    try {
      render(<SyncWriteCheckCard check={notTold} />);
      expect(screen.getByTestId('sync-write-check-storage').textContent).toBe(
        "Stockage de données : environ 0,06 Mo. L'org cible ne dit pas à l'utilisateur avec lequel l'exécution écrit ce qu'il lui reste.",
      );
    } finally {
      await act(async () => {
        await i18n.changeLanguage('en');
      });
    }
  });

  it('says how many records it may write over, kept first and put back by its removal', () => {
    render(<SyncWriteCheckCard check={{ ...PAST_EMAILS, overwrites: 30 }} />);

    expect(screen.getByTestId('sync-write-check-overwrites').textContent).toBe(
      'Of them, up to 30 may write over records the target org holds: what they hold is read ' +
        'and kept first, and removing the run puts it back.',
    );
  });

  it('names each object the target would take none of, and that the run asks whether to leave it out', () => {
    // Nothing said it: the run wrote the objects before, then had every
    // record of these refused.
    render(
      <SyncWriteCheckCard
        check={{
          ...PAST_EMAILS,
          unwritable: [
            { objectApiName: 'Case', rows: 120, why: 'notCreateable' },
            { objectApiName: 'Invoice__c', rows: 8, why: 'notInTarget' },
          ],
        }}
      />,
    );

    expect(screen.getByTestId('sync-write-check-unwritable-Case').textContent).toBe(
      'Case (120 records): the user the run writes as may not create its records in the target ' +
        'org. None of them can be written.',
    );
    expect(screen.getByTestId('sync-write-check-unwritable-Invoice__c').textContent).toBe(
      'Invoice__c (8 records): the target org has no such object, or the user the run writes as ' +
        'cannot see it. None of its records can be written.',
    );
    expect(screen.getByTestId('sync-write-check').textContent).toContain(
      'Started from the page, the run asks whether to leave these objects out and writes the rest',
    );
  });

  it('counts what a simulation found the run would write, and says what of the count it would not', () => {
    render(<SyncWriteCheckCard check={{ ...PAST_EMAILS, total: 4, notWritten: 3 }} />);

    expect(screen.getByTestId('sync-write-check-records').textContent).toContain(
      '1 record to write',
    );
    expect(screen.getByTestId('sync-write-check-not-written').textContent).toBe(
      'Of the 4 a run counts from the source, 3 would not be written: held back or refused, as each object says. What follows is measured on all of them.',
    );
  });

  it('says what of the count it would not write under the count, above the figures measured on all of it', () => {
    // Said below the storage, the API requests and the emails, "what follows"
    // spoke of the lines above it, read as measured on the records written.
    render(<SyncWriteCheckCard check={{ ...PAST_EMAILS, total: 4, notWritten: 3 }} />);

    const notWritten = screen.getByTestId('sync-write-check-not-written');
    expect(screen.getByTestId('sync-write-check-records').nextElementSibling).toBe(notWritten);
    for (const figure of ['sync-write-check-storage', 'sync-write-check-emails-SingleEmail']) {
      expect(
        notWritten.compareDocumentPosition(screen.getByTestId(figure)) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  it('names the field of an upsert the target matches none on', () => {
    render(
      <SyncWriteCheckCard
        check={{
          ...PAST_EMAILS,
          unwritable: [{ objectApiName: 'Account', rows: 2, why: 'notAKey', key: 'Name' }],
        }}
      />,
    );

    expect(screen.getByTestId('sync-write-check-unwritable-Account').textContent).toContain(
      'its upsert matches on Name, neither an External ID nor an idLookup field',
    );
  });

  it('says the contacts an account left out holds back, and the cases under them, none of them to write', async () => {
    // Counted under each filter alone, they were said to be written: "4
    // records to write" of a run that would write none.
    const check: SyncWriteCheck = {
      ...PAST_EMAILS,
      objects: [],
      total: 0,
      alreadyCopied: 0,
      emails: [],
      verdict: 'refused',
      unwritable: [{ objectApiName: 'Account', rows: 2, why: 'notAKey', key: 'Name' }],
      heldBack: [
        { objectApiName: 'Contact', rows: 4, parent: 'Account', field: 'AccountId' },
        { objectApiName: 'Case', rows: 1, parent: 'Contact', field: 'ContactId' },
      ],
    };
    const { unmount } = render(<SyncWriteCheckCard check={check} />);

    expect(screen.getByTestId('sync-write-check-records').textContent).toBe('0 records to write');
    expect(screen.getByTestId('sync-write-check-held-back-Contact').textContent).toBe(
      'Contact (4 records): held back, not written — their AccountId names Account records ' +
        'left out, and written without them, they would stand without their Account.',
    );
    expect(screen.getByTestId('sync-write-check-held-back-Case').textContent).toBe(
      'Case (1 record): held back, not written — its ContactId names a Contact record held back.',
    );
    unmount();

    // In the page's language.
    await act(async () => {
      await i18n.changeLanguage('fr');
    });
    try {
      render(<SyncWriteCheckCard check={check} />);
      expect(screen.getByTestId('sync-write-check-held-back-Contact').textContent).toBe(
        fr.sync.writeCheck.heldBack.leftOut_other
          .replace('{{object}}', 'Contact')
          .replace('{{count}}', '4')
          .replace('{{field}}', 'AccountId')
          .split('{{parent}}')
          .join('Account'),
      );
    } finally {
      await act(async () => {
        await i18n.changeLanguage('en');
      });
    }
  });

  it('says each lookup that holds back rows of an object, with its rows', () => {
    // Named by their first row alone, 13 prices were said held back by
    // Pricebook2Id where the dry run held 9 back by Product2Id.
    render(
      <SyncWriteCheckCard
        check={{
          ...PAST_EMAILS,
          objects: [],
          total: 0,
          alreadyCopied: 0,
          emails: [],
          verdict: 'refused',
          unwritable: [
            { objectApiName: 'Product2', rows: 3, why: 'notAKey', key: 'Description' },
            { objectApiName: 'Pricebook2', rows: 1, why: 'notAKey', key: 'Description' },
          ],
          heldBack: [
            {
              objectApiName: 'PricebookEntry',
              rows: 13,
              parent: 'Pricebook2',
              field: 'Pricebook2Id',
              parents: [
                { parent: 'Pricebook2', field: 'Pricebook2Id', rows: 4 },
                { parent: 'Product2', field: 'Product2Id', rows: 9 },
              ],
            },
          ],
        }}
      />,
    );

    expect(screen.getByTestId('sync-write-check-held-back-PricebookEntry').textContent).toBe(
      'PricebookEntry (4 records): held back, not written — their Pricebook2Id names ' +
        'Pricebook2 records left out, and written without them, they would stand without ' +
        'their Pricebook2. PricebookEntry (9 records): held back, not written — their ' +
        'Product2Id names Product2 records left out, and written without them, they would ' +
        'stand without their Product2.',
    );
  });

  it('says the API requests the run takes against what the target has left today', () => {
    // Only Forge's Review compared them.
    render(
      <SyncWriteCheckCard
        check={{
          ...PAST_EMAILS,
          apiRequests: { verdict: 'near', estimate: 15, remaining: 900, max: 15_000 },
        }}
      />,
    );

    expect(screen.getByTestId('sync-write-check-api').textContent).toBe(
      'API requests: about 15, which would leave the target org less than a tenth of its 15,000 a day (900 left).',
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
