import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import i18n from '../../i18n';
import fr from '../../i18n/locales/fr.json';
import { SyncWrittenLines } from './SyncWrittenLines';

describe('SyncWrittenLines', () => {
  afterEach(async () => {
    await act(async () => {
      await i18n.changeLanguage('en');
    });
  });

  it('says the records linked to one the target holds, with its words, and those written without a lookup, in no colour of a refusal', () => {
    render(
      <SyncWrittenLines
        result={{
          linkedToExisting: {
            records: 3,
            refusal: 'DUPLICATE_VALUE: duplicate value found: Code__c',
          },
          lookupsLeftOut: [
            { records: 1, fields: ['Key_Contact__c'], reason: 'notInTarget' },
            { records: 12, fields: ['OwnerId'], reason: 'ownerRefusedEarlier' },
          ],
        }}
        testId="lines"
      />,
    );

    expect(screen.getByTestId('lines-linked').textContent).toBe(
      '3 records linked to records the target org already holds, not written: the target ' +
        'refused them as duplicates of those records, and what the run writes under them ' +
        "points there. The target's words: DUPLICATE_VALUE: duplicate value found: Code__c",
    );
    expect(screen.getByTestId('lines-notInTarget').textContent).toBe(
      '1 record written without Key_Contact__c: it named a record the target org does not have.',
    );
    expect(screen.getByTestId('lines-ownerRefusedEarlier').textContent).toBe(
      '12 records written without OwnerId from the start: the target org refused the same ' +
        'owner earlier in this run, a user it does not have.',
    );
    // Listed among the refusals, they read "1 × LINKED_TO_EXISTING" in red.
    const list = screen.getByTestId('lines');
    expect(list.className).toContain('text-text-secondary');
    expect(list.className).not.toContain('status-error');
  });

  it('says nothing of a write that linked no record and left no lookup out', () => {
    render(<SyncWrittenLines result={{}} testId="lines" />);

    expect(screen.queryByTestId('lines')).toBeNull();
  });

  it('says it in the language of the panel', async () => {
    i18n.addResourceBundle('fr', 'translation', fr, true, true);
    await act(async () => {
      await i18n.changeLanguage('fr');
    });

    render(
      <SyncWrittenLines
        result={{ lookupsLeftOut: [{ records: 2, fields: ['OwnerId'], reason: 'notInTarget' }] }}
        testId="lines"
      />,
    );

    expect(screen.getByTestId('lines-notInTarget').textContent).toBe(
      fr.sync.written.notInTarget_other.replace('{{count}}', '2').replace('{{fields}}', 'OwnerId'),
    );
  });
});
