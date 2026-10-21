import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import i18n from '../../i18n';
import fr from '../../i18n/locales/fr.json';
import { SyncWrittenLines, hasWrittenLines } from './SyncWrittenLines';

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
    expect(hasWrittenLines({})).toBe(false);
  });

  it('says the records written again without the fields the target refused, each with what refused it and its words', () => {
    const result = {
      writtenWithoutFields: {
        rows: 2,
        fields: [
          {
            field: 'Phone',
            refusedBy: 'validation-rule' as const,
            reason: 'FIELD_CUSTOM_VALIDATION_EXCEPTION: Phone must be written +33 X XX XX XX XX.',
            rows: 2,
          },
        ],
      },
    };
    render(<SyncWrittenLines result={result} testId="lines" />);

    expect(hasWrittenLines(result)).toBe(true);
    expect(screen.getByTestId('lines-withoutFields').firstChild?.textContent).toBe(
      '2 records written again without the fields the target org refused them on:',
    );
    expect(screen.getByTestId('lines-withoutFields-Phone').textContent).toBe(
      "Phone, left out of 2 records: a validation rule refused it. The target's words: " +
        'FIELD_CUSTOM_VALIDATION_EXCEPTION: Phone must be written +33 X XX XX XX XX.',
    );
  });

  it('says the lookups set once the object they name was written, and those a cycle left without, with why', () => {
    render(
      <SyncWrittenLines
        result={{
          lookupsSetAfter: { records: 3, fields: ['Primary_Contact__c'], after: ['Contact'] },
          lookupsLeftOut: [
            { records: 1, fields: ['Primary_Contact__c'], reason: 'parentRefused' },
            {
              records: 2,
              fields: ['ParentId'],
              reason: 'notSet',
              refusal: 'FIELD_INTEGRITY_EXCEPTION: parent loop',
            },
            { records: 1, fields: ['ParentId'], reason: 'notReached' },
          ],
        }}
        testId="lines"
      />,
    );

    expect(screen.getByTestId('lines-setAfter').textContent).toBe(
      '3 records given Primary_Contact__c once the Contact records were written: they name ' +
        'each other, so they went in first without it.',
    );
    expect(screen.getByTestId('lines-parentRefused').textContent).toBe(
      '1 record written without Primary_Contact__c: the record it names, written after it, ' +
        'was refused in this run.',
    );
    expect(screen.getByTestId('lines-notSet').textContent).toBe(
      '2 records written without ParentId: the target org refused setting it once the records ' +
        "they name were written. The target's words: FIELD_INTEGRITY_EXCEPTION: parent loop",
    );
    expect(screen.getByTestId('lines-notReached').textContent).toBe(
      '1 record written without ParentId: the run was stopped before setting it.',
    );
    expect(screen.getByTestId('lines').className).not.toContain('status-error');
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
