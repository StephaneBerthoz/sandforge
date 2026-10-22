import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import '../../i18n';
import { SyncReviewObjects } from './SyncReviewObjects';
import type { ObjectSetEntry } from './ObjectSetEditor';

const entry = (
  objectApiName: string,
  operation: ObjectSetEntry['operation'],
  externalIdField = '',
): ObjectSetEntry => ({ objectApiName, operation, externalIdField, batchSize: 200, where: '' });

/** Added in the list's alphabetical order: Account, Case, Contact. */
const ENTRIES = [
  entry('Account', 'upsert', 'Ext_Id__c'),
  entry('Case', 'insert'),
  entry('Contact', 'insert'),
];

describe('SyncReviewObjects', () => {
  it('lists the objects in the order the run writes them, with why one moved', () => {
    render(
      <SyncReviewObjects
        entries={ENTRIES}
        order={{
          objects: ['Account', 'Contact', 'Case'],
          moved: [{ objectApiName: 'Case', after: 'Contact', field: 'ContactId' }],
          cycles: [],
        }}
        orderLoading={false}
        orderUnread={false}
        saved={false}
      />,
    );

    const items = within(screen.getByTestId('sync-review-objects')).getAllByRole('listitem');
    expect(items.map((li) => li.getAttribute('data-testid'))).toEqual([
      'sync-review-object-Account',
      'sync-review-object-Contact',
      'sync-review-object-Case',
    ]);
    expect(items[0].textContent).toBe(
      'Account — Upsert on Ext_Id__c: a record found by it is updated, any other is created.',
    );
    expect(items[2].textContent).toBe(
      'Case — Insert: each record read is created in the target.Written after Contact, which its ContactId names.',
    );
  });

  it('says what an update and a delete do to the records that hold the source ids', () => {
    render(
      <SyncReviewObjects
        entries={[entry('Account', 'update'), entry('Lead', 'delete')]}
        order={null}
        orderLoading={false}
        orderUnread={false}
        saved={false}
      />,
    );

    expect(screen.getByTestId('sync-review-object-Account').textContent).toContain(
      "Update by Id: the target record holding the source record's Id is overwritten.",
    );
    expect(screen.getByTestId('sync-review-object-Lead').textContent).toContain(
      "Delete by Id: the target record holding the source record's Id is deleted.",
    );
    // What the update overwrites is kept first, and a removal of the run puts it back.
    expect(screen.getByTestId('sync-review-overwrites').textContent).toBe(
      'What an update or an upsert writes over is read from the target org first and kept on ' +
        'this machine: removing the run puts back the values the records held.',
    );
  });

  it('says nothing of what is written over for a run that only inserts', () => {
    render(
      <SyncReviewObjects
        entries={[entry('Case', 'insert')]}
        order={null}
        orderLoading={false}
        orderUnread={false}
        saved={false}
      />,
    );

    expect(screen.queryByTestId('sync-review-overwrites')).toBeNull();
  });

  it('says that an unsaved configuration inserts every record again on each run, and a saved one does not', () => {
    const { rerender } = render(
      <SyncReviewObjects
        entries={ENTRIES}
        order={null}
        orderLoading={false}
        orderUnread={false}
        saved={false}
      />,
    );
    expect(screen.getByTestId('sync-review-inserts').textContent).toBe(
      'Not saved: each run inserts every record it reads again. Save the configuration, and its runs leave what an earlier run copied as it is.',
    );

    rerender(
      <SyncReviewObjects
        entries={ENTRIES}
        order={null}
        orderLoading={false}
        orderUnread={false}
        saved
      />,
    );
    expect(screen.getByTestId('sync-review-inserts').textContent).toBe(
      'Saved: each run of this configuration leaves as they are the records an earlier run copied, and inserts the others.',
    );
  });

  it('names the objects whose lookups name each other, and says when the order is being read or could not be', () => {
    const { rerender } = render(
      <SyncReviewObjects
        entries={ENTRIES}
        order={{
          objects: ['Contact', 'Account', 'Case'],
          moved: [],
          cycles: [['Contact', 'Account']],
        }}
        orderLoading={false}
        orderUnread={false}
        saved
      />,
    );
    expect(screen.getByTestId('sync-review-cycle').textContent).toBe(
      'Contact and Account name each other: they are written in this order, first without the ' +
        'lookups at the one written later, which are set once it is written.',
    );

    rerender(
      <SyncReviewObjects entries={ENTRIES} order={null} orderLoading orderUnread={false} saved />,
    );
    expect(screen.getByRole('status').textContent).toBe(
      'Reading the lookups of each object in the target org…',
    );

    rerender(
      <SyncReviewObjects entries={ENTRIES} order={null} orderLoading={false} orderUnread saved />,
    );
    expect(screen.getByTestId('sync-review-order-unread')).toBeDefined();
  });
});
