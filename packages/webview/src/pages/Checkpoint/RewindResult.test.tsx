import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import '../../i18n';
import type { OrgCheckpoint, RewindResult as RewindOutcome } from '@sandforge/shared';
import {
  USERS,
  deletedObject,
  fakeHost,
  polyfillDialog,
  readyCheckpoint,
  restoredObject,
  rewindResult,
  undeletedObject,
  withoutUndo,
} from './testing/checkpointFixtures';
import type { FakeHost } from './testing/checkpointFixtures';
import type { RunKind } from './RewindResult';

const host = vi.hoisted(() => ({ current: null as null | FakeHost }));

vi.mock('../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => host.current?.api,
  getVscodeApi: () => host.current?.api,
}));

import { RewindResult } from './RewindResult';

/** A checkpoint that holds Cases, whose `Last_Touched__c` a flow sets on every save. */
function caseCheckpoint(overrides: Partial<OrgCheckpoint> = {}): OrgCheckpoint {
  const base = readyCheckpoint();
  return readyCheckpoint({
    objects: [
      ...base.objects,
      {
        objectApiName: 'Case',
        records: 30,
        inBin: 0,
        readOrder: 3,
        readMode: 'query',
        undeletable: true,
        cascadeParents: [],
        fingerprint: 'd'.repeat(64),
        fields: ['Id', 'SystemModstamp', 'Subject', 'Last_Touched__c'],
        leftOutFields: [],
      },
    ],
    ...overrides,
  });
}

/** What a rewind did, rendered with spies for what it asks its page. */
function renderResult(
  result: RewindOutcome = rewindResult(),
  kind: RunKind = 'rewind',
  checkpoint: OrgCheckpoint = caseCheckpoint(),
) {
  const spies = {
    onUndo: vi.fn(),
    onRewindAgain: vi.fn(),
    onIgnored: vi.fn(),
    onDone: vi.fn(),
  };
  render(
    <RewindResult
      kind={kind}
      orgName="DEV-SB"
      checkpoint={checkpoint}
      result={result}
      userNames={{ [USERS.alice]: 'Alice Martin' }}
      {...spies}
    />,
  );
  return spies;
}

/** The first line of the result. */
function headline(): string {
  return screen.getByTestId('checkpoint-result-headline').textContent ?? '';
}

describe('RewindResult', () => {
  beforeEach(() => {
    host.current = fakeHost();
    polyfillDialog();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-22T14:02:30.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('says the org is back at the checkpoint, read again with nothing that differs, with Undo and Done', () => {
    const { onUndo, onDone, onRewindAgain } = renderResult();
    expect(headline()).toBe(
      'DEV-SB is back at “Before UAT”. Read again: nothing differs among the objects and fields it holds.',
    );
    expect(screen.getByTestId('checkpoint-result-undo').textContent).toBe(
      'This rewind can be undone until Nov 6, 2026, sooner if the recycle bin fills.',
    );
    expect(screen.queryByTestId('checkpoint-result-rewind-again')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Undo this rewind' }));
    expect(onUndo).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onRewindAgain).not.toHaveBeenCalled();
  });

  it('says object by object what it brought back, gave back and deleted, in the rewind’s words', () => {
    renderResult();
    const undeleted = screen.getByTestId('checkpoint-result-undeleted');
    expect(within(undeleted).getByRole('heading').textContent).toBe(
      'Brought back from the recycle bin of DEV-SB',
    );
    expect(screen.getByTestId('checkpoint-result-undeleted-Account').textContent).toBe(
      'Account: 1 of 1 brought back, with their Ids',
    );
    const restored = screen.getByTestId('checkpoint-result-restored');
    expect(within(restored).getByRole('heading').textContent).toBe(
      'Given their checkpoint values back in DEV-SB',
    );
    expect(screen.getByTestId('checkpoint-result-restored-Account').textContent).toBe(
      'Account: 4 of 4 given their checkpoint values back',
    );
    const deleted = screen.getByTestId('forge-removal-result');
    expect(within(deleted).getByRole('heading').textContent).toBe(
      'No record added since the checkpoint is left in DEV-SB.',
    );
    expect(screen.getByTestId('forge-removal-result-Contact').textContent).toBe(
      'Contact: 5 deleted',
    );
    expect(screen.getByTestId('checkpoint-result-requests').textContent).toBe(
      '96 API requests used · 14,804 left today',
    );
  });

  it('says what it made again with new Ids, object by object, and what the org refused to make, in its words', () => {
    renderResult(
      rewindResult({
        recreated: [
          { objectApiName: 'Account', planned: 1, created: 1, refused: 0, reasons: [] },
          {
            objectApiName: 'Contact',
            planned: 3,
            created: 2,
            refused: 1,
            reasons: ['FIELD_CUSTOM_VALIDATION_EXCEPTION: A phone is required'],
          },
        ],
      }),
    );
    const recreated = screen.getByTestId('checkpoint-result-recreated');
    expect(within(recreated).getByRole('heading').textContent).toBe(
      'Made again in DEV-SB, with new Ids',
    );
    expect(screen.getByTestId('checkpoint-result-recreated-Account').textContent).toBe(
      'Account: 1 of 1 made again',
    );
    expect(screen.getByTestId('checkpoint-result-recreated-Contact').textContent).toBe(
      'Contact: 2 of 3 made again · refused by DEV-SB: 1 (FIELD_CUSTOM_VALIDATION_EXCEPTION: A phone is required)',
    );
  });

  it('says what each left, and names records changed by someone else during the rewind as theirs', () => {
    renderResult(
      rewindResult({
        status: 'unstable',
        restored: [restoredObject('Account', { planned: 4, restored: 3, keptChanged: 1 })],
        deleted: [deletedObject('Contact', { planned: 5, deleted: 4, keptChanged: 1 })],
        undeleted: [undeletedObject('Account', { planned: 2, undeleted: 1, goneForGood: 1 })],
        residual: [
          {
            objectApiName: 'Account',
            reason: 'changedDuringRewind',
            by: USERS.alice,
            count: 1,
            ids: [],
          },
        ],
      }),
    );
    expect(screen.getByTestId('checkpoint-result-restored-Account').textContent).toBe(
      'Account: 3 of 4 given their checkpoint values back · changed by someone else during the rewind, left as they made them: 1',
    );
    expect(screen.getByTestId('checkpoint-result-undeleted-Account').textContent).toBe(
      'Account: 1 of 2 brought back, with their Ids · no longer in the recycle bin, gone for good: 1',
    );
    expect(
      within(screen.getByTestId('forge-removal-result')).getByRole('heading').textContent,
    ).toBe(
      'Records added since the checkpoint were deleted from DEV-SB; the others stay, as listed.',
    );
    expect(screen.getByTestId('forge-removal-result-Contact').textContent).toBe(
      'Contact: 4 deleted · 1 kept, changed by someone else during the rewind',
    );
  });

  it('says what still differs, grouped by why, with Rewind again', () => {
    const { onRewindAgain } = renderResult(
      rewindResult({
        status: 'partial',
        residual: [
          {
            objectApiName: 'Lead',
            reason: 'refused',
            count: 2,
            ids: [],
            message: 'FIELD_CUSTOM_VALIDATION_EXCEPTION: Close date must be in the future',
          },
          { objectApiName: 'Case', reason: 'goneForGood', count: 1, ids: [] },
          { objectApiName: 'Account', reason: 'changedSincePreview', count: 3, ids: [] },
        ],
      }),
    );
    expect(headline()).toBe('DEV-SB is back at “Before UAT”, except 6 records:');
    const groups = screen.getByTestId('checkpoint-result-residual');
    expect(
      within(groups)
        .getAllByRole('heading')
        .map((heading) => heading.textContent),
    ).toEqual(['Changed since the preview', 'Refused by DEV-SB', 'Gone for good']);
    expect(
      screen.getByTestId('checkpoint-result-residual-changedSincePreview-Account').textContent,
    ).toBe('Account: 3 records changed since the preview: rewind again to take them');
    expect(screen.getByTestId('checkpoint-result-residual-refused-Lead').textContent).toBe(
      'Lead: 2 records' + 'FIELD_CUSTOM_VALIDATION_EXCEPTION: Close date must be in the future',
    );
    expect(screen.getByTestId('checkpoint-result-residual-goneForGood-Case').textContent).toBe(
      'Case: 1 record deleted since cannot come back: the recycle bin no longer holds it, and it could not be made again — a file, or a record deleted while the checkpoint was taken',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Rewind again' }));
    expect(onRewindAgain).toHaveBeenCalledTimes(1);
  });

  it('says of the records the org answered are no longer in the recycle bin, left, that Salesforce still lists them as deleted and what makes them again, before what it refused (live: five emptied records)', () => {
    renderResult(
      rewindResult({
        status: 'failure',
        residual: [
          { objectApiName: 'Lead', reason: 'refused', count: 1, ids: [], message: 'Locked' },
          { objectApiName: 'Account', reason: 'notInBin', count: 2, ids: [] },
          { objectApiName: 'Contact', reason: 'notInBin', count: 1, ids: [] },
        ],
      }),
    );
    const groups = screen.getByTestId('checkpoint-result-residual');
    expect(
      within(groups)
        .getAllByRole('heading')
        .map((heading) => heading.textContent),
    ).toEqual(['No longer in the recycle bin', 'Refused by DEV-SB']);
    expect(screen.getByTestId('checkpoint-result-residual-notInBin-Account').textContent).toBe(
      'Account: 2 records Salesforce still lists as deleted but will not bring back — emptied from the recycle bin, or kept there for good: rewind again with Make them again, with new Ids ticked to make them again, with new Ids',
    );
    expect(screen.getByTestId('checkpoint-result-residual-notInBin-Contact').textContent).toBe(
      'Contact: 1 record Salesforce still lists as deleted but will not bring back — emptied from the recycle bin, or kept there for good: rewind again with Make them again, with new Ids ticked to make it again, with a new Id',
    );
  });

  it('says an undo deleted again what the rewind made again, with what went with it, never that it was brought back (live: two accounts and a contact, two contacts gone with their account)', () => {
    renderResult(
      withoutUndo(
        rewindResult({
          deleted: [
            deletedObject('Account', { planned: 2, deleted: 2 }),
            deletedObject('Contact', { planned: 3, deleted: 1, alreadyGone: 2 }),
          ],
          remade: [
            { objectApiName: 'Account', count: 2 },
            { objectApiName: 'Contact', count: 3 },
          ],
          restored: [],
          undeleted: [],
        }),
      ),
      'undo',
    );
    expect(screen.getByTestId('checkpoint-result-remade').textContent).toBe(
      'Deleted again in DEV-SB: 3 records the rewind made again, with what went with them',
    );
  });

  it('says what it brought back for a moment, object by object, deleted again with what came back with it, beside what it brought back and deleted (P-B1: an account made since that took a contact of the checkpoint along)', () => {
    renderResult(
      rewindResult({
        deleted: [deletedObject('Account', { planned: 1, deleted: 1 })],
        restored: [restoredObject('Contact', { planned: 1, restored: 1 })],
        undeleted: [undeletedObject('Account', { planned: 1, undeleted: 1 })],
        carriers: [{ objectApiName: 'Account', count: 1 }],
        passes: 2,
      }),
    );
    const carriers = screen.getByTestId('checkpoint-result-carriers');
    expect(within(carriers).getByRole('heading').textContent).toBe(
      'Brought back for a moment from the recycle bin of DEV-SB, to bring back the records of the checkpoint they had taken along',
    );
    expect(screen.getByTestId('checkpoint-result-carriers-Account').textContent).toBe(
      'Account: 1 record the checkpoint does not hold',
    );
    expect(screen.getByTestId('checkpoint-result-carriers-deleted-again').textContent).toBe(
      'Deleted again once those records were back, with what came back with them: in the recycle bin, as before the rewind.',
    );
    expect(screen.queryByTestId('checkpoint-result-carriers-stopped')).toBeNull();
  });

  it('says a rewind stopped before it was through may have left in the org what it brought back for a moment, which Rewind again deletes', () => {
    renderResult(
      rewindResult({
        status: 'cancelled',
        deleted: [],
        undeleted: [undeletedObject('Account', { planned: 2, undeleted: 2 })],
        carriers: [{ objectApiName: 'Account', count: 2 }],
      }),
    );
    expect(screen.getByTestId('checkpoint-result-carriers-Account').textContent).toBe(
      'Account: 2 records the checkpoint does not hold',
    );
    expect(screen.getByTestId('checkpoint-result-carriers-stopped').textContent).toBe(
      'Stopped before the rewind was through: what of them it had not deleted again yet is still in DEV-SB. Rewind again deletes it, with what came back with it.',
    );
    expect(screen.queryByTestId('checkpoint-result-carriers-deleted-again')).toBeNull();
    expect(screen.getByRole('button', { name: 'Rewind again' })).toBeInTheDocument();
  });

  it('says nothing was brought back for a moment by a rewind that wrote nothing', () => {
    renderResult(
      rewindResult({ status: 'failure', carriers: [{ objectApiName: 'Account', count: 1 }] }),
    );
    expect(screen.queryByTestId('checkpoint-result-carriers')).toBeNull();
  });

  it('says an undo sent back to the recycle bin on its own what had gone there with a record the rewind brought back for a moment, which stays there (P-B1: the org refuses a lookup to a record in the bin)', () => {
    renderResult(
      withoutUndo(
        rewindResult({
          deleted: [deletedObject('Contact', { planned: 1, deleted: 1 })],
          carriedAlone: [{ objectApiName: 'Contact', count: 1 }],
          restored: [],
          undeleted: [],
        }),
      ),
      'undo',
    );
    expect(screen.getByTestId('checkpoint-result-carried-alone-Contact').textContent).toBe(
      'Back in the recycle bin of DEV-SB on its own: 1 Contact record that had gone there with a record the rewind brought back for a moment, which stays there. It comes back alone, under the parent the checkpoint gave it.',
    );
    expect(screen.queryByTestId('checkpoint-result-carriers')).toBeNull();
  });

  it('says what a rewind did to the links between files and records, only the parts that apply, and the links the org refused', () => {
    renderResult(
      rewindResult({
        status: 'partial',
        files: { unlinked: 2, relinked: 1, linksUpdated: 0, linksRefused: 1 },
        residual: [
          {
            objectApiName: 'ContentDocumentLink',
            reason: 'refused',
            count: 1,
            ids: [],
            message: 'INSUFFICIENT_ACCESS_OR_READONLY: insufficient access rights on object id',
          },
        ],
      }),
    );
    const section = screen.getByTestId('checkpoint-result-files');
    expect(within(section).getByRole('heading').textContent).toBe(
      'Links between files and records in DEV-SB',
    );
    expect(
      within(section)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      '2 links added since removed: their files stay',
      '1 link removed since put back, under a new Id',
      '1 link DEV-SB refused to write',
    ]);
  });

  it('says what an undo did to the links in the undo’s words: those the rewind put back removed again, those it removed put back', () => {
    renderResult(
      withoutUndo(
        rewindResult({ files: { unlinked: 1, relinked: 2, linksUpdated: 1, linksRefused: 0 } }),
      ),
      'undo',
    );
    expect(
      within(screen.getByTestId('checkpoint-result-files'))
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      '1 link the rewind put back, removed again',
      '2 links the rewind removed, put back under new Ids',
      '1 link given back the sharing it had before the rewind',
    ]);
  });

  it('says nothing of links for a rewind that wrote none', () => {
    renderResult(rewindResult());
    expect(screen.queryByTestId('checkpoint-result-files')).toBeNull();
  });

  it('says a file left attached to what a rewind of a checkpoint that holds files deleted stays as the checkpoint holds it, never that it does not cover files', () => {
    const deleted = [
      deletedObject('Account', {
        planned: 1,
        deleted: 1,
        filesLeft: { count: 1, names: ['Signed contract.pdf'] },
      }),
    ];
    renderResult(
      rewindResult({ deleted }),
      'rewind',
      caseCheckpoint({ files: { documents: 3, links: 4, anchored: 3 } }),
    );
    expect(screen.getByTestId('forge-removal-files-Account').textContent).toBe(
      '1 file attached to them stays in DEV-SB: the checkpoint holds it, or it is attached to a record outside the checkpoint too: Signed contract.pdf',
    );
  });

  it('says a file left attached to what a rewind of a checkpoint taken before files were held deleted stays as the checkpoint does not cover files', () => {
    const deleted = [
      deletedObject('Account', {
        planned: 1,
        deleted: 1,
        filesLeft: { count: 1, names: ['Signed contract.pdf'] },
      }),
    ];
    renderResult(rewindResult({ deleted }));
    expect(screen.getByTestId('forge-removal-files-Account').textContent).toBe(
      '1 file attached to them stays in DEV-SB, as the checkpoint does not cover files: Signed contract.pdf',
    );
  });

  it('says a partial rewind whose records still differ only as its parts list them', () => {
    renderResult(rewindResult({ status: 'partial' }));
    expect(headline()).toBe('DEV-SB is back at “Before UAT”, except what is listed below.');
  });

  it('offers to stop comparing the fields the org’s automation set again, among that object’s fields only', () => {
    const { onIgnored } = renderResult(
      rewindResult({
        status: 'partial',
        residual: [{ objectApiName: 'Case', reason: 'automation', count: 12, ids: [] }],
      }),
    );
    expect(headline()).toBe('DEV-SB is back at “Before UAT”, except 12 records:');
    expect(screen.getByTestId('checkpoint-result-residual-automation-Case').textContent).toBe(
      'Case: 12 records your automation set again on save',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Stop comparing these fields…' }));
    const fields = screen.getByTestId('checkpoint-stop-comparing-fields');
    expect(
      within(fields)
        .getAllByRole('checkbox')
        .map((box) => box.parentElement?.textContent),
    ).toEqual(['Case.Subject', 'Case.Last_Touched__c']);
    fireEvent.click(screen.getByTestId('checkpoint-stop-comparing-Case.Last_Touched__c'));
    fireEvent.click(screen.getByTestId('checkpoint-stop-comparing-save'));
    expect(host.current?.lastPayload('checkpoint:ignore-fields')).toEqual({
      checkpointId: 'ck-20261020-140512-a1b2',
      fields: ['Case.Last_Touched__c'],
    });
    const saved = caseCheckpoint({ ignoredFields: ['Case.Last_Touched__c'] });
    act(() =>
      host.current?.answer('checkpoint:ignore-fields', 'checkpoint:ignore-fields:response', {
        checkpoint: saved,
      }),
    );
    expect(onIgnored).toHaveBeenCalledWith(saved);
    expect(screen.getByTestId('checkpoint-result-stopped-comparing').textContent).toBe(
      'Not compared from now on: Case.Last_Touched__c. Rewind again to read DEV-SB without them.',
    );
    expect(screen.queryByTestId('checkpoint-stop-comparing-fields')).toBeNull();
  });

  it('says someone kept writing during the rewind, by name, the most first, and asks to rewind once they stopped', () => {
    renderResult(
      rewindResult({
        status: 'unstable',
        residual: [
          {
            objectApiName: 'Case',
            reason: 'changedDuringRewind',
            by: USERS.unnamed,
            count: 2,
            ids: [],
          },
          {
            objectApiName: 'Case',
            reason: 'changedDuringRewind',
            by: USERS.alice,
            count: 14,
            ids: [],
          },
        ],
      }),
    );
    expect(headline()).toBe(
      `Someone kept writing to DEV-SB during the rewind: Alice Martin changed 14 records and ${USERS.unnamed} changed 2 records, left as they made them. Rewind again once they have stopped.`,
    );
    const lines = within(screen.getByTestId('checkpoint-result-residual-changedDuringRewind'))
      .getAllByRole('listitem')
      .map((item) => item.textContent);
    expect(lines).toEqual([
      `Case: 2 records changed by ${USERS.unnamed}, left as they made them`,
      'Case: 14 records changed by Alice Martin, left as they made them',
    ]);
    expect(screen.getByRole('button', { name: 'Rewind again' })).toBeInTheDocument();
  });

  it('says someone kept writing during the rewind even when it does not say who', () => {
    renderResult(
      rewindResult({
        status: 'unstable',
        residual: [{ objectApiName: 'Case', reason: 'changedDuringRewind', count: 3, ids: [] }],
      }),
    );
    expect(headline()).toBe(
      'Someone kept writing to DEV-SB during the rewind: what they changed is left as they made it. Rewind again once they have stopped.',
    );
  });

  it('says a rewind stopped part way, where the org stands, and that Undo still reaches the state before it', () => {
    renderResult(rewindResult({ status: 'cancelled' }));
    expect(headline()).toBe(
      'Stopped part way: DEV-SB is between “Before UAT” and now. Rewind again to finish: it takes up from what still differs. Undo still returns DEV-SB to how it was before the rewind.',
    );
    expect(screen.getByRole('button', { name: 'Rewind again' })).toBeInTheDocument();
  });

  it('says a rewind stopped before it wrote, without an Undo to offer', () => {
    renderResult(withoutUndo(rewindResult({ status: 'cancelled' })));
    expect(headline()).toBe(
      'Stopped part way: DEV-SB is between “Before UAT” and now. Rewind again to finish: it takes up from what still differs.',
    );
    expect(screen.queryByRole('button', { name: 'Undo this rewind' })).toBeNull();
  });

  it('says a rewind that ended before it was through', () => {
    renderResult(rewindResult({ status: 'failure' }));
    expect(headline()).toBe(
      'The rewind of DEV-SB to “Before UAT” ended before it was through: what it did is listed below. Rewind again to take up from what still differs.',
    );
  });

  it('names what Undo could not bring back of what the rewind deleted', () => {
    renderResult(
      rewindResult({
        undo: {
          until: '2026-11-06T14:02:00.000Z',
          cannot: [{ objectApiName: 'OpportunityLineItem', count: 3 }],
        },
      }),
    );
    expect(screen.getByTestId('checkpoint-result-undo-cannot').textContent).toBe(
      'Undo could not bring back 3 OpportunityLineItem records this rewind deleted: Salesforce undeletes them only with their parent record.',
    );
  });

  it('says in a sentence of its own what Undo could not bring back as deleted before a record it points at, which the rewind deleted next (F41)', () => {
    renderResult(
      rewindResult({
        undo: {
          until: '2026-11-06T14:02:00.000Z',
          cannot: [
            { objectApiName: 'OpportunityLineItem', count: 3 },
            { objectApiName: 'Case', count: 1, reason: 'deletedBeforeParent' },
          ],
        },
      }),
    );
    expect(
      within(screen.getByTestId('checkpoint-result-undo-cannot'))
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Undo could not bring back 3 OpportunityLineItem records this rewind deleted: Salesforce undeletes them only with their parent record.',
      'Undo could not bring back 1 Case record this rewind deleted before a record it points at, which the rewind deleted next: Salesforce cannot bring it back after that.',
    ]);
  });

  it('says an undo put the org back as it was before its last rewind, in the undo’s words, with nothing more to offer', () => {
    const undone = rewindResult({
      deleted: [deletedObject('Account', { planned: 1, deleted: 1 })],
      restored: [restoredObject('Account', { planned: 4, restored: 4 })],
      undeleted: [undeletedObject('Contact', { planned: 5, undeleted: 5 })],
    });
    renderResult(withoutUndo(undone), 'undo');
    expect(headline()).toBe('DEV-SB is back as it was before its last rewind.');
    expect(
      within(screen.getByTestId('checkpoint-result-undeleted')).getByRole('heading').textContent,
    ).toBe('What the rewind deleted, brought back from the recycle bin of DEV-SB');
    expect(screen.getByTestId('checkpoint-result-restored-Account').textContent).toBe(
      'Account: 4 of 4 given back their values from before the rewind',
    );
    expect(
      within(screen.getByTestId('forge-removal-result')).getByRole('heading').textContent,
    ).toBe(
      'Every record the rewind brought back or made again is in the recycle bin of DEV-SB now.',
    );
    // It made nothing again: nothing is said deleted again.
    expect(screen.queryByTestId('checkpoint-result-remade')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Undo this rewind' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rewind again' })).toBeNull();
  });

  it('says what an undo left as changed since the rewind', () => {
    renderResult(
      rewindResult({
        status: 'partial',
        deleted: [deletedObject('Account', { planned: 2, deleted: 1, keptChanged: 1 })],
        restored: [restoredObject('Contact', { planned: 5, restored: 2, keptChanged: 3 })],
        undeleted: [],
      }),
      'undo',
    );
    expect(headline()).toBe(
      'DEV-SB is back as it was before its last rewind, except 4 records changed since the rewind, left as they are now.',
    );
    expect(screen.getByTestId('checkpoint-result-restored-Contact').textContent).toBe(
      'Contact: 2 of 5 given back their values from before the rewind · changed since the rewind, left as they are now: 3',
    );
    expect(screen.getByTestId('forge-removal-result-Account').textContent).toBe(
      'Account: 1 deleted · 1 kept, changed since the rewind',
    );
  });

  it('says an undo stopped part way, and where it is taken up again', () => {
    renderResult(rewindResult({ status: 'cancelled' }), 'undo');
    expect(headline()).toBe(
      'Stopped part way: undo the rewind again from the list of checkpoints to finish; it takes up from where it stopped.',
    );
  });
});
