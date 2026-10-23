import { beforeAll, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { SyncRestoreObjectResult, SyncUndeleteObjectResult } from '@sandforge/shared';
import i18n from '../../i18n';
import {
  RestoredResult,
  UndeletedResult,
  type RestoredResultWords,
  type UndeletedResultWords,
} from './RestoredResults';

/** The words of Sync's removal card, the first caller. */
const SYNC_RESTORED: RestoredResultWords = {
  title: 'runRemoval.sync.restoredTitle',
  restored: 'runRemoval.sync.restored',
  keptChanged: 'runRemoval.sync.restoredKeptChanged',
  alreadyGone: 'runRemoval.sync.restoredGone',
  refused: 'runRemoval.sync.restoredRefused',
  notKept: 'runRemoval.sync.restoredNotKept',
  notReached: 'runRemoval.sync.restoredNotReached',
  restoredWithout: 'runRemoval.sync.restoredWithout',
};

const SYNC_UNDELETED: UndeletedResultWords = {
  title: 'runRemoval.sync.undeletedTitle',
  undeleted: 'runRemoval.sync.undeleted',
  alreadyBack: 'runRemoval.sync.undeletedAlreadyBack',
  goneForGood: 'runRemoval.sync.undeletedGone',
  refused: 'runRemoval.sync.restoredRefused',
  notReached: 'runRemoval.sync.restoredNotReached',
};

/**
 * Words of another caller, each naming the count it says, so that a count
 * said under another's words shows.
 */
const OTHER_RESTORED: RestoredResultWords = {
  title: 'resultsTest.restoredTitle',
  restored: 'resultsTest.restored',
  keptChanged: 'resultsTest.keptChanged',
  alreadyGone: 'resultsTest.alreadyGone',
  refused: 'resultsTest.refused',
  notKept: 'resultsTest.notKept',
  notReached: 'resultsTest.notReached',
  restoredWithout: 'resultsTest.restoredWithout',
};

const OTHER_UNDELETED: UndeletedResultWords = {
  title: 'resultsTest.undeletedTitle',
  undeleted: 'resultsTest.undeleted',
  alreadyBack: 'resultsTest.alreadyBack',
  goneForGood: 'resultsTest.goneForGood',
  refused: 'resultsTest.refused',
  notReached: 'resultsTest.notReached',
};

const restoredOf = (overrides: Partial<SyncRestoreObjectResult>): SyncRestoreObjectResult => ({
  objectApiName: 'Account',
  planned: 4321,
  restored: 2000,
  keptChanged: 0,
  alreadyGone: 0,
  refused: 0,
  notKept: 0,
  reasons: [],
  ...overrides,
});

const undeletedOf = (overrides: Partial<SyncUndeleteObjectResult>): SyncUndeleteObjectResult => ({
  objectApiName: 'Contact',
  planned: 1234,
  undeleted: 1000,
  alreadyBack: 0,
  goneForGood: 0,
  refused: 0,
  reasons: [],
  ...overrides,
});

beforeAll(() => {
  i18n.addResourceBundle(
    'en',
    'translation',
    {
      resultsTest: {
        restoredTitle: 'Given back in {{org}}',
        restored: '{{object}} {{restored}}/{{planned}}',
        undeletedTitle: 'Brought back in {{org}}',
        undeleted: '{{object}} {{undeleted}}/{{planned}}',
        keptChanged: 'keptChanged {{n}} in {{org}}',
        alreadyGone: 'alreadyGone {{n}} in {{org}}',
        refused: 'refused {{n}} in {{org}}',
        notKept: 'notKept {{n}} in {{org}}',
        notReached: 'notReached {{n}} in {{org}}',
        restoredWithout: 'restoredWithout {{n}} in {{org}}',
        alreadyBack: 'alreadyBack {{n}} in {{org}}',
        goneForGood: 'goneForGood {{n}} in {{org}}',
      },
    },
    true,
    true,
  );
});

describe('RestoredResult', () => {
  it('names its section by its heading and draws one line per object under the test id given', () => {
    render(
      <RestoredResult
        restored={[restoredOf({}), restoredOf({ objectApiName: 'Case', planned: 1, restored: 1 })]}
        org="DEV-SB"
        words={SYNC_RESTORED}
        testId="results-restored"
      />,
    );

    const section = screen.getByRole('region', { name: 'What this run wrote over in DEV-SB' });
    expect(section).toBe(screen.getByTestId('results-restored'));
    expect(within(section).getByRole('heading', { level: 4 }).textContent).toBe(
      'What this run wrote over in DEV-SB',
    );
    expect(screen.getByTestId('results-restored-Account').textContent).toBe(
      'Account: 2,000 of 4,321 given back their values from before the run',
    );
    expect(screen.getByTestId('results-restored-Case').textContent).toBe(
      'Case: 1 of 1 given back their values from before the run',
    );
  });

  it('says each count an object left that is not zero, in its order, and none it lacks', () => {
    render(
      <RestoredResult
        restored={[restoredOf({ alreadyGone: 2, notKept: 1, restoredWithout: 3 })]}
        org="DEV-SB"
        words={SYNC_RESTORED}
        testId="results-restored"
      />,
    );

    expect(screen.getByTestId('results-restored-Account').textContent).toBe(
      'Account: 2,000 of 4,321 given back their values from before the run' +
        ' · no longer in DEV-SB: 2' +
        ' · values from before no longer kept (their backup was deleted from the Restore tab,' +
        ' or reached its retention): 1' +
        " · given back but for fields DEV-SB no longer takes, which keep the run's values: 3",
    );
  });

  it("says each count in the caller's words, with its number and the org", () => {
    render(
      <RestoredResult
        restored={[
          restoredOf({
            planned: 20,
            restored: 10,
            keptChanged: 1,
            alreadyGone: 2,
            refused: 3,
            notKept: 4,
            notReached: 5,
            restoredWithout: 6,
          }),
        ]}
        org="UAT"
        words={OTHER_RESTORED}
        testId="rewind-restored"
      />,
    );

    expect(screen.getByRole('region', { name: 'Given back in UAT' })).toBeTruthy();
    expect(screen.getByTestId('rewind-restored-Account').textContent).toBe(
      'Account 10/20 · keptChanged 1 in UAT · alreadyGone 2 in UAT · refused 3 in UAT' +
        ' · notKept 4 in UAT · notReached 5 in UAT · restoredWithout 6 in UAT',
    );
  });

  it("lists the org's reasons beneath an object's line, and no list where it gave none", () => {
    render(
      <RestoredResult
        restored={[
          restoredOf({
            refused: 2,
            reasons: ['Account.OwnerId: the owner is inactive', 'Account.Type: bad value'],
          }),
          restoredOf({ objectApiName: 'Case' }),
        ]}
        org="DEV-SB"
        words={SYNC_RESTORED}
        testId="results-restored"
      />,
    );

    const reasons = within(screen.getByTestId('results-restored-Account')).getByRole('list');
    expect(
      within(reasons)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Account.OwnerId: the owner is inactive', 'Account.Type: bad value']);
    expect(within(screen.getByTestId('results-restored-Case')).queryByRole('list')).toBeNull();
  });
});

describe('UndeletedResult', () => {
  it('names its section by its heading and draws one line per object under the test id given', () => {
    render(
      <UndeletedResult
        undeleted={[undeletedOf({})]}
        org="DEV-SB"
        words={SYNC_UNDELETED}
        testId="results-undeleted"
      />,
    );

    const section = screen.getByRole('region', { name: 'What this run deleted in DEV-SB' });
    expect(section).toBe(screen.getByTestId('results-undeleted'));
    expect(within(section).getByRole('heading', { level: 4 }).textContent).toBe(
      'What this run deleted in DEV-SB',
    );
    expect(screen.getByTestId('results-undeleted-Contact').textContent).toBe(
      'Contact: 1,000 of 1,234 brought back from the recycle bin',
    );
  });

  it('says each count an object left that is not zero, in its order, and none it lacks', () => {
    render(
      <UndeletedResult
        undeleted={[undeletedOf({ goneForGood: 2, refused: 1 })]}
        org="DEV-SB"
        words={SYNC_UNDELETED}
        testId="results-undeleted"
      />,
    );

    expect(screen.getByTestId('results-undeleted-Contact').textContent).toBe(
      'Contact: 1,000 of 1,234 brought back from the recycle bin' +
        ' · no longer in the recycle bin, gone for good: 2 · refused by DEV-SB: 1',
    );
  });

  it("says each count in the caller's words, with its number and the org", () => {
    render(
      <UndeletedResult
        undeleted={[
          undeletedOf({
            planned: 20,
            undeleted: 10,
            alreadyBack: 1,
            goneForGood: 2,
            refused: 3,
            notReached: 4,
          }),
        ]}
        org="UAT"
        words={OTHER_UNDELETED}
        testId="rewind-undeleted"
      />,
    );

    expect(screen.getByRole('region', { name: 'Brought back in UAT' })).toBeTruthy();
    expect(screen.getByTestId('rewind-undeleted-Contact').textContent).toBe(
      'Contact 10/20 · alreadyBack 1 in UAT · goneForGood 2 in UAT · refused 3 in UAT' +
        ' · notReached 4 in UAT',
    );
  });

  it("lists the org's reasons beneath an object's line, and no list where it gave none", () => {
    render(
      <UndeletedResult
        undeleted={[
          undeletedOf({ refused: 1, reasons: ['DUPLICATE_VALUE: the external id is taken'] }),
          undeletedOf({ objectApiName: 'Case' }),
        ]}
        org="DEV-SB"
        words={SYNC_UNDELETED}
        testId="results-undeleted"
      />,
    );

    const reasons = within(screen.getByTestId('results-undeleted-Contact')).getByRole('list');
    expect(
      within(reasons)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['DUPLICATE_VALUE: the external id is taken']);
    expect(within(screen.getByTestId('results-undeleted-Case')).queryByRole('list')).toBeNull();
  });
});
