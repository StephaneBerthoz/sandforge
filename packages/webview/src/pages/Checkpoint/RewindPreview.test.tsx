import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import '../../i18n';
import type { ForgeTargetAutomation, OrgCheckpoint } from '@sandforge/shared';
import { useOrgStore } from '../../stores/useOrgStore';
import { dateTimeFormat } from '../../utils/formatters';
import {
  USERS,
  developerOrg,
  diffObject,
  fakeHost,
  previewAnswer,
  previewDiff,
  readyCheckpoint,
} from './testing/checkpointFixtures';
import type { FakeHost } from './testing/checkpointFixtures';

const host = vi.hoisted(() => ({ current: null as null | FakeHost }));

vi.mock('../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => host.current?.api,
  getVscodeApi: () => host.current?.api,
}));

import { RewindPreview } from './RewindPreview';

const ID = 'ck-20261020-140512-a1b2';

/** The preview of the Developer Edition's checkpoint, with spies for what it tells its page. */
function renderPreview(checkpoint: OrgCheckpoint = readyCheckpoint(), withRewind = true) {
  const onClose = vi.fn();
  const onRewind = vi.fn();
  render(
    <RewindPreview
      org={developerOrg()}
      checkpoint={checkpoint}
      onClose={onClose}
      {...(withRewind ? { onRewind } : {})}
    />,
  );
  return { onClose, onRewind };
}

/** Answer the last `checkpoint:preview`. */
function answerPreview(overrides: Parameters<typeof previewAnswer>[0] = {}): void {
  act(() =>
    host.current?.answer(
      'checkpoint:preview',
      'checkpoint:preview:response',
      previewAnswer(overrides),
    ),
  );
}

/** Type the org's name in the rewind's confirmation, and confirm it. */
function confirmRewind(): void {
  fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'DEV-SB' } });
  fireEvent.click(screen.getByTestId('danger-confirm-btn'));
}

/** The text of each cell of an object's row of the table, its name first. */
function rowCells(objectApiName: string): string[] {
  const row = screen.getByTestId(`checkpoint-preview-row-${objectApiName}`);
  return [
    within(row).getByRole('rowheader').textContent ?? '',
    ...within(row)
      .getAllByRole('cell')
      .map((cell) => cell.textContent ?? ''),
  ];
}

/** What the org runs on the objects the default preview's rewind writes. */
const AUTOMATION: ForgeTargetAutomation = {
  objectsRead: ['Contact', 'Account'],
  objects: [
    {
      objectApiName: 'Account',
      flows: [
        {
          apiName: 'Account_Touch',
          label: 'Account touch',
          timing: 'afterSave',
          startsOn: 'update',
          condition: 'read',
          permissions: [],
        },
      ],
      triggers: [{ name: 'AccountRestore', events: ['afterUndelete'] }],
    },
    {
      objectApiName: 'Contact',
      flows: [],
      triggers: [{ name: 'ContactGone', events: ['beforeDelete'] }],
    },
  ],
  unread: [],
  conditionsNotRead: 0,
  conditionsBound: 25,
  requests: 4,
};

describe('RewindPreview', () => {
  beforeEach(() => {
    host.current = fakeHost();
    useOrgStore.setState({ orgs: [developerOrg()], selectedOrgId: 'org-dev' });
    vi.useFakeTimers({ toFake: ['Date'] });
    // Noon on this machine's clock, whatever its zone: the Undo date is written in it.
    vi.setSystemTime(new Date(2026, 9, 22, 12, 0, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
    useOrgStore.setState({ orgs: [], selectedOrgId: null });
  });

  it('reads the preview of the checkpoint from the org, saying so, and writes nothing', () => {
    renderPreview();
    expect(host.current?.lastPayload('checkpoint:preview')).toEqual({ checkpointId: ID });
    expect(screen.getByTestId('checkpoint-preview-reading').textContent).toBe(
      'Reading what changed in DEV-SB since “Before UAT”: nothing is written.',
    );
    expect(host.current?.sent('checkpoint:rewind')).toEqual([]);
  });

  it('names the org and the checkpoint it would return to, from when its take began, and takes the keyboard', () => {
    renderPreview();
    const from = dateTimeFormat({ dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date('2026-10-20T14:05:12.000Z'),
    );
    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading.textContent).toBe(`Rewind DEV-SB to “Before UAT” (${from})`);
    expect(heading).toHaveFocus();
  });

  it('says the three numbers of the diff: to delete, to give back, to bring back', () => {
    renderPreview();
    answerPreview();
    expect(screen.getByTestId('checkpoint-preview-number-delete').textContent).toBe('8 to delete');
    expect(screen.getByTestId('checkpoint-preview-number-give-back').textContent).toBe(
      '6 to give back',
    );
    expect(screen.getByTestId('checkpoint-preview-number-bring-back').textContent).toBe(
      '1 to bring back',
    );
    expect(screen.getByTestId('checkpoint-preview-numbers').textContent).toContain(
      'created since, with what comes back with a parent and goes again',
    );
  });

  it('names who last changed the records, the most first, and an unnamed user by Id', () => {
    renderPreview();
    answerPreview();
    expect(screen.getByTestId('checkpoint-preview-last-changed').textContent).toBe(
      `Last changed by: Alice Martin 8 · Integration User 4 · ${USERS.unnamed} 2`,
    );
    expect(screen.queryByTestId('checkpoint-preview-active')).toBeNull();
  });

  it('names who worked in the org in the last hour, and warns when one signs in as the rewind’s user', () => {
    renderPreview(
      readyCheckpoint({ takenBy: { userId: USERS.alice, viewAllData: true, modifyAllData: true } }),
    );
    answerPreview({
      diff: previewDiff({ activeLastHour: [USERS.alice, USERS.unnamed] }),
    });
    expect(screen.getByTestId('checkpoint-preview-active').textContent).toBe(
      `People working in DEV-SB in the last hour: Alice Martin and ${USERS.unnamed}.`,
    );
    expect(screen.getByTestId('checkpoint-preview-shared-user').textContent).toBe(
      'Testers who sign in as admin@example.com cannot be told apart from the rewind: ask them to stop first.',
    );
  });

  it('says object by object what the rewind deletes, gives back, brings back and cannot undo', () => {
    renderPreview();
    answerPreview({
      diff: previewDiff({
        objects: [
          ...previewDiff().objects,
          diffObject('Case', { cannotUndo: [{ reason: 'goneForGood', count: 2 }] }),
        ],
      }),
    });
    const table = screen.getByTestId('checkpoint-preview-table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual(['Object', 'Delete', 'Give back', 'Bring back', 'Cannot undo']);
    expect(rowCells('Contact')).toEqual(['Contact', '5', '2', '0', '0']);
    expect(rowCells('Account')).toEqual(['Account', '3', '4', '1', '0']);
    expect(rowCells('Case')).toEqual(['Case', '0', '0', '0', '2']);
  });

  it('says what the numbers hold, only the lines that apply', () => {
    renderPreview();
    answerPreview({
      diff: previewDiff({
        objects: [
          diffObject('Contact', {
            toDelete: { createdSince: 0, broughtBackSince: 2, comesBackWithParent: 1 },
            toGiveBack: { records: 3, fields: 1, clearedLookups: 3 },
            toBringBack: { inBin: 0, withParent: 4, deletedWhileTaken: 1 },
            touched: 6,
            unexplained: 1,
          }),
        ],
      }),
    });
    expect(
      within(screen.getByTestId('checkpoint-preview-details'))
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Contact: 1 record deleted while the checkpoint was taken comes back with the values it had then.',
      'Contact: 4 records come back with their parent record.',
      'Contact: 1 field value to give back.',
      'Contact: 3 records get back a lookup a deletion since cleared.',
      'Contact: 2 records brought back from the recycle bin since, which were in it at the checkpoint, go back to it.',
      'Contact: 1 record created since and deleted with a parent the rewind brings back comes back with it, then is deleted.',
      'Contact: 6 records touched since hold their checkpoint values: nothing to give back.',
      'Contact: 1 record the checkpoint does not hold, although dated before it, is left as it is (a load with back-dated creation dates?).',
    ]);
  });

  it('says what a rewind cannot undo: what applies, then what any rewind leaves', () => {
    renderPreview();
    answerPreview({
      diff: previewDiff({
        objects: [
          ...previewDiff().objects,
          diffObject('Case', {
            cannotUndo: [{ reason: 'goneForGood', count: 2 }],
            schemaDrift: { removed: ['Region__c'], added: ['Score__c'], changed: [] },
          }),
          diffObject('Lead', { cannotUndo: [{ reason: 'convertedLead', count: 1 }] }),
        ],
      }),
    });
    const lines = within(screen.getByTestId('checkpoint-preview-cannot'))
      .getAllByRole('listitem')
      .map((item) => item.textContent);
    expect(lines).toEqual([
      '2 records deleted since cannot come back: the recycle bin no longer holds them, and the rewind cannot make them again — files, whose bodies the checkpoint does not hold, or records deleted while the checkpoint was taken (Case).',
      '1 lead was converted since: Salesforce cannot unconvert a lead. What the conversion made is deleted, and the lead stays converted.',
      'Case.Region__c was deleted since the checkpoint: restore it from Deleted Fields (within 15 days), then rewind again.',
      'Case.Score__c was added since: its values stay.',
      "Formulas, roll-ups, auto-numbers and the created and modified dates are the org's own: Rewind does not write them, and the last modified dates will show the rewind.",
      'Rewind changes data in DEV-SB only. What already left it (emails, callouts, outbound messages, platform events, data other systems pulled) stays sent.',
      'Metadata is not rewound: fields, flows, validation rules, layouts and permissions stay as they are. Compare Org covers metadata.',
    ]);
  });

  it('names the objects it could not read, which a rewind leaves as they are', () => {
    renderPreview();
    answerPreview({
      diff: previewDiff({
        unread: [{ objectApiName: 'Case', reason: 'The org refused the query.' }],
      }),
    });
    const unread = screen.getByTestId('checkpoint-preview-unread');
    expect(within(unread).getByRole('heading').textContent).toBe(
      '1 object could not be read: a rewind leaves it as it is',
    );
    expect(unread.textContent).toContain('Case — The org refused the query.');
  });

  it('rewinds with what the preview read, nothing more to accept, once the org’s name is typed', () => {
    const { onRewind } = renderPreview();
    answerPreview();
    expect(screen.getByTestId('checkpoint-preview-automation-none').textContent).toBe(
      'Nothing DEV-SB automates runs as the rewind writes.',
    );
    const rewind = screen.getByTestId('checkpoint-preview-rewind');
    expect(rewind.textContent).toBe('Rewind DEV-SB…');
    fireEvent.click(rewind);
    // Nothing goes until the org's name is typed: a rewind deletes.
    expect(onRewind).not.toHaveBeenCalled();
    expect(screen.getByTestId('danger-title').textContent).toBe('Rewind DEV-SB to “Before UAT”?');
    expect(screen.getByTestId('danger-confirm-btn')).toBeDisabled();
    confirmRewind();
    expect(onRewind).toHaveBeenCalledWith(
      {
        previewId: 'pv-1',
        acceptAutomation: false,
        acceptNoUndo: false,
        acceptRecreate: false,
        acceptOutside: false,
      },
      previewAnswer().diff,
    );
    // The preview writes nothing itself: the rewind is its page's to start.
    expect(host.current?.sent('checkpoint:rewind')).toEqual([]);
  });

  it('says in its confirmation to what moment the rewind returns the org and what it does, whoever made the changes', () => {
    renderPreview();
    answerPreview();
    fireEvent.click(screen.getByTestId('checkpoint-preview-rewind'));
    const date = dateTimeFormat({ dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date('2026-10-20T14:05:12.000Z'),
    );
    expect(
      screen.getByText(
        `This rewind returns DEV-SB to ${date}: it deletes the 8 records added since, gives 6 records their values from then back and brings back 1 record from the recycle bin, whoever made these changes.`,
      ),
    ).toBeInTheDocument();
  });

  it('says in its confirmation only what the rewind does', () => {
    renderPreview();
    answerPreview({
      diff: previewDiff({
        objects: [
          diffObject('Account', { toGiveBack: { records: 1, fields: 1, clearedLookups: 0 } }),
        ],
      }),
    });
    fireEvent.click(screen.getByTestId('checkpoint-preview-rewind'));
    expect(
      screen.getByText(
        /: it gives 1 record its values from then back, whoever made these changes\.$/,
      ),
    ).toBeInTheDocument();
  });

  it('leaves the org as it is when its confirmation is dismissed', () => {
    const { onRewind } = renderPreview();
    answerPreview();
    fireEvent.click(screen.getByTestId('checkpoint-preview-rewind'));
    fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'DEV-SB' } });
    fireEvent.click(screen.getByTestId('danger-dismiss-btn'));
    expect(onRewind).not.toHaveBeenCalled();
    expect(screen.queryByTestId('danger-title')).toBeNull();
  });

  it('holds Rewind until what Undo could not bring back is accepted, and says it', () => {
    const { onRewind } = renderPreview();
    answerPreview({
      diff: previewDiff({ undoCannot: [{ objectApiName: 'OpportunityLineItem', count: 3 }] }),
    });
    expect(
      screen.getByTestId('checkpoint-preview-undo-cannot-OpportunityLineItem').textContent,
    ).toBe(
      '3 OpportunityLineItem records this rewind deletes: Salesforce undeletes them only with their parent record, which stays.',
    );
    const rewind = screen.getByTestId('checkpoint-preview-rewind');
    expect(rewind).toBeDisabled();
    const box = screen.getByRole('checkbox', {
      name: 'Rewind even though Undo could not bring these back',
    });
    fireEvent.click(box);
    expect(rewind).toBeEnabled();
    fireEvent.click(rewind);
    confirmRewind();
    expect(onRewind).toHaveBeenCalledWith(
      expect.objectContaining({ acceptNoUndo: true }),
      expect.anything(),
    );
  });

  it('counts the records the recycle bin no longer gives back, says they are made again with new Ids and what that breaks, and holds Rewind until it is accepted', () => {
    const { onRewind } = renderPreview();
    answerPreview({
      diff: previewDiff({
        objects: [...previewDiff().objects, diffObject('Case', { toRecreate: 2 })],
      }),
    });
    expect(screen.getByTestId('checkpoint-preview-number-recreate').textContent).toBe(
      '2 to make again',
    );
    expect(screen.getByTestId('checkpoint-preview-row-Case').textContent).toContain('2');
    expect(screen.getByRole('columnheader', { name: 'Make again' })).toBeInTheDocument();
    const section = screen.getByTestId('checkpoint-preview-recreate');
    expect(within(section).getByRole('heading').textContent).toBe('Made again, with new Ids');
    expect(screen.getByTestId('checkpoint-preview-recreate-Case').textContent).toBe(
      '2 Case records deleted since that the recycle bin no longer gives back.',
    );
    expect(section.textContent).toContain(
      'Anything outside Salesforce that names their old Ids — an integration, a link, a report filter — no longer finds them.',
    );
    const rewind = screen.getByTestId('checkpoint-preview-rewind');
    expect(rewind).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Make them again, with new Ids' }));
    expect(rewind).toBeEnabled();
    fireEvent.click(rewind);
    expect(screen.getByRole('dialog').textContent).toContain(
      'makes 2 records the recycle bin no longer holds again, with new Ids',
    );
    confirmRewind();
    expect(onRewind).toHaveBeenCalledWith(
      expect.objectContaining({ acceptRecreate: true, acceptNoUndo: false }),
      expect.anything(),
    );
  });

  it('shows no number nor column for records to make again when there is none', () => {
    renderPreview();
    answerPreview();
    expect(screen.queryByTestId('checkpoint-preview-number-recreate')).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Make again' })).toBeNull();
  });

  it('offers no box to make records again when nothing comes back from the bin and none is to make again', () => {
    renderPreview();
    answerPreview({
      diff: previewDiff({
        objects: [
          diffObject('Account', { toGiveBack: { records: 1, fields: 1, clearedLookups: 0 } }),
        ],
      }),
    });
    expect(screen.queryByTestId('checkpoint-preview-recreate')).toBeNull();
  });

  it('offers to make again what Salesforce answers is no longer in the recycle bin whenever the rewind brings records back, saying it still lists one emptied from it, without holding Rewind for it (live: five emptied records read in the bin)', () => {
    const { onRewind } = renderPreview();
    answerPreview();
    const section = screen.getByTestId('checkpoint-preview-recreate');
    expect(within(section).getByRole('heading').textContent).toBe(
      'If the recycle bin no longer holds them',
    );
    expect(screen.getByTestId('checkpoint-preview-recreate-if-emptied').textContent).toBe(
      'Salesforce still lists a record emptied from the recycle bin as deleted, for minutes to hours, and says the bin no longer holds it only once the rewind asks for it back. Ticked, the rewind then makes it again from the checkpoint, with a new Id, and the records that were to come back with it too, running what the org runs as a record is created; unticked, it leaves them, and names them.',
    );
    expect(within(section).queryByRole('listitem')).toBeNull();
    const rewind = screen.getByTestId('checkpoint-preview-rewind');
    expect(rewind).toBeEnabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Make them again, with new Ids' }));
    fireEvent.click(rewind);
    confirmRewind();
    expect(onRewind).toHaveBeenCalledWith(
      expect.objectContaining({ acceptRecreate: true }),
      expect.anything(),
    );
  });

  it('says in a sentence of its own the records the rewind deletes before a record they point at, which it deletes next, and holds Rewind until that is accepted too (F41)', () => {
    const { onRewind } = renderPreview();
    answerPreview({
      diff: previewDiff({
        undoCannot: [
          { objectApiName: 'OpportunityLineItem', count: 3 },
          { objectApiName: 'Case', count: 1, reason: 'deletedBeforeParent' },
          { objectApiName: 'OpportunityLineItem', count: 2, reason: 'deletedBeforeParent' },
        ],
      }),
    });
    const box = screen.getByTestId('checkpoint-preview-undo-cannot');
    expect(
      within(box)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      '3 OpportunityLineItem records this rewind deletes: Salesforce undeletes them only with their parent record, which stays.',
      '1 Case record this rewind deletes before a record it points at, which the rewind deletes next: Salesforce cannot bring it back after that.',
      '2 OpportunityLineItem records this rewind deletes before a record they point at, which the rewind deletes next: Salesforce cannot bring them back after that.',
    ]);
    expect(
      screen.getByTestId('checkpoint-preview-undo-cannot-Case-deletedBeforeParent'),
    ).toBeInTheDocument();
    const rewind = screen.getByTestId('checkpoint-preview-rewind');
    expect(rewind).toBeDisabled();
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Rewind even though Undo could not bring these back' }),
    );
    fireEvent.click(rewind);
    confirmRewind();
    expect(onRewind).toHaveBeenCalledWith(
      expect.objectContaining({ acceptNoUndo: true }),
      expect.anything(),
    );
  });

  it('lists what the org runs as each step of the rewind writes, and holds Rewind until it is accepted', () => {
    const { onRewind } = renderPreview();
    answerPreview({ automation: AUTOMATION });
    const section = screen.getByTestId('checkpoint-preview-automation');
    expect(within(section).getByRole('heading').textContent).toBe(
      'What DEV-SB runs as the rewind writes',
    );
    expect(screen.getByTestId('checkpoint-preview-automation-bringBack-Account').textContent).toBe(
      'Account: Apex trigger: AccountRestore · after undelete, as the rewind brings it back from the recycle bin',
    );
    expect(screen.getByTestId('checkpoint-preview-automation-giveBack-Account').textContent).toBe(
      'Account: Flow: Account touch · as the rewind gives it back its checkpoint values',
    );
    expect(screen.getByTestId('checkpoint-preview-automation-delete-Contact').textContent).toBe(
      'Contact: Apex trigger: ContactGone · before delete',
    );
    const rewind = screen.getByTestId('checkpoint-preview-rewind');
    expect(rewind).toBeDisabled();
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Rewind even though DEV-SB runs automation' }),
    );
    fireEvent.click(rewind);
    confirmRewind();
    expect(onRewind).toHaveBeenCalledWith(
      expect.objectContaining({ acceptAutomation: true }),
      expect.anything(),
    );
  });

  it('takes automation the org would not let be read for automation found', () => {
    renderPreview();
    answerPreview({
      automation: {
        ...AUTOMATION,
        objects: [],
        unread: [{ part: 'flows', reason: 'INSUFFICIENT_ACCESS' }],
      },
    });
    expect(screen.getByTestId('checkpoint-preview-rewind')).toBeDisabled();
    expect(screen.getByTestId('checkpoint-preview-accept-automation')).toBeInTheDocument();
  });

  it('in a checkpoint of picked objects, deletes what goes along outside it only once accepted', () => {
    const { onRewind } = renderPreview(readyCheckpoint({ scope: { mode: 'picked', leftOut: [] } }));
    answerPreview({
      diff: previewDiff({
        objects: [
          diffObject('Account', {
            toDelete: { createdSince: 3, broughtBackSince: 0, comesBackWithParent: 0 },
            outside: [{ objectApiName: 'Opportunity', count: 50, parents: 3 }],
          }),
        ],
      }),
    });
    expect(screen.getByTestId('checkpoint-preview-outside-Account-Opportunity').textContent).toBe(
      '50 Opportunity records created under 3 Account records the rewind deletes',
    );
    expect(screen.getByTestId('checkpoint-preview-outside-otherwise').textContent).toBe(
      'Unless the box is ticked, the records they hang from stay, and are named.',
    );
    // Unticked, the rewind goes ahead and keeps those parents.
    fireEvent.click(screen.getByTestId('checkpoint-preview-rewind'));
    confirmRewind();
    expect(onRewind).toHaveBeenLastCalledWith(
      expect.objectContaining({ acceptOutside: false }),
      expect.anything(),
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'Delete these too' }));
    expect(screen.queryByTestId('checkpoint-preview-outside-otherwise')).toBeNull();
    fireEvent.click(screen.getByTestId('checkpoint-preview-rewind'));
    confirmRewind();
    expect(onRewind).toHaveBeenLastCalledWith(
      expect.objectContaining({ acceptOutside: true }),
      expect.anything(),
    );
  });

  it('in a checkpoint of everything, says what goes along outside it, with no box', () => {
    const { onRewind } = renderPreview();
    answerPreview({
      diff: previewDiff({
        objects: [
          diffObject('Account', {
            toDelete: { createdSince: 1, broughtBackSince: 0, comesBackWithParent: 0 },
            outside: [{ objectApiName: 'Opportunity', count: 1, parents: 1 }],
          }),
        ],
      }),
    });
    expect(screen.getByTestId('checkpoint-preview-outside-Account-Opportunity').textContent).toBe(
      '1 Opportunity record created under 1 Account record the rewind deletes',
    );
    expect(screen.getByTestId('checkpoint-preview-outside').textContent).toContain(
      'They go with the records they hang from.',
    );
    expect(screen.queryByTestId('checkpoint-preview-accept-outside')).toBeNull();
    fireEvent.click(screen.getByTestId('checkpoint-preview-rewind'));
    confirmRewind();
    expect(onRewind).toHaveBeenCalledWith(
      expect.objectContaining({ acceptOutside: true }),
      expect.anything(),
    );
  });

  it('says a refusal the rewind would meet, and holds Rewind whatever is ticked', () => {
    renderPreview();
    answerPreview({
      refusal: {
        code: 'API_BUDGET',
        message: 'This rewind takes about 500 API requests; DEV-SB has 420 left today.',
      },
    });
    expect(screen.getByRole('alert').textContent).toBe(
      'This rewind takes about 500 API requests; DEV-SB has 420 left today.',
    );
    expect(screen.getByTestId('checkpoint-preview-rewind')).toBeDisabled();
  });

  it('says the emails the rewind’s writes make the org send, against what it has left, and holds Rewind past them whatever is ticked (B11, H1)', () => {
    renderPreview();
    answerPreview({
      automation: AUTOMATION,
      emails: [
        {
          limit: 'SingleEmail',
          emails: 40,
          objects: [
            {
              objectApiName: 'Account',
              write: 'update',
              records: 20,
              perRecord: 2,
              sentBy: ['Account touch', 'Owner alert'],
            },
          ],
          alertsCounted: true,
          verdict: 'exceeds',
          remaining: 12,
          max: 15,
        },
        {
          limit: 'DailyWorkflowEmails',
          emails: 20,
          objects: [
            {
              objectApiName: 'Account',
              write: 'update',
              records: 20,
              perRecord: 1,
              sentBy: ['Owner alert'],
            },
          ],
          verdict: 'fits',
          remaining: 8000,
          max: 8040,
        },
      ],
      refusal: {
        code: 'EMAILS',
        message: 'This rewind would make DEV-SB send about 40 single emails, 12 of 15 left today.',
      },
    });

    expect(screen.getByTestId('checkpoint-preview-emails-SingleEmail').textContent).toBe(
      "Single emails: about 40 sent by DEV-SB's automation as the rewind writes (Account touch and Owner alert), more than the 12 of 15 left today: the rewind is refused, whatever is ticked. " +
        'DEV-SB counts its email alerts against its single emails, as a Developer Edition does: they are among them.',
    );
    expect(screen.getByTestId('checkpoint-preview-emails-DailyWorkflowEmails').textContent).toBe(
      "Workflow emails: about 20 sent by DEV-SB's automation as the rewind writes (Owner alert), 8,000 of 8,040 left today.",
    );
    fireEvent.click(screen.getByTestId('checkpoint-preview-accept-automation'));
    expect(screen.getByTestId('checkpoint-preview-rewind')).toBeDisabled();
  });

  it('lifts a refusal of the automation once its box is ticked', () => {
    renderPreview();
    answerPreview({
      automation: AUTOMATION,
      refusal: { code: 'AUTOMATION', message: 'DEV-SB runs automation as the rewind writes.' },
    });
    expect(screen.getByTestId('checkpoint-preview-rewind')).toBeDisabled();
    fireEvent.click(screen.getByTestId('checkpoint-preview-accept-automation'));
    expect(screen.getByTestId('checkpoint-preview-rewind')).toBeEnabled();
  });

  it('names the fields its owner chose not to compare', () => {
    renderPreview(readyCheckpoint({ ignoredFields: ['Case.Last_Touched__c', 'Account.Score__c'] }));
    answerPreview();
    expect(screen.getByTestId('checkpoint-preview-not-compared').textContent).toBe(
      'Not compared (you chose): Case.Last_Touched__c and Account.Score__c',
    );
  });

  it('says what the rewind costs, and until when it can be undone', () => {
    renderPreview();
    answerPreview();
    expect(screen.getByTestId('checkpoint-preview-cost').textContent).toBe(
      'About 40s · about 120 API requests of the 14,900 left today',
    );
    expect(screen.getByTestId('checkpoint-preview-journal').textContent).toBe(
      'Before it writes, Rewind keeps what it changes, so you can undo it until Nov 6, 2026, sooner if the recycle bin fills.',
    );
  });

  it('says the org is as it was when there is nothing to rewind, and offers no Rewind', () => {
    renderPreview();
    answerPreview({ diff: previewDiff({ objects: [] }), automation: undefined });
    expect(screen.getByTestId('checkpoint-preview-nothing').textContent).toBe(
      'DEV-SB is as it was at “Before UAT” among the objects and fields it holds: nothing to rewind.',
    );
    for (const part of ['numbers', 'table', 'cannot', 'automation', 'cost', 'rewind']) {
      expect(screen.queryByTestId(`checkpoint-preview-${part}`)).toBeNull();
    }
  });

  it('says what still differs when a rewind could write nothing to put it back', () => {
    renderPreview();
    answerPreview({
      diff: previewDiff({
        objects: [diffObject('Case', { cannotUndo: [{ reason: 'goneForGood', count: 1 }] })],
      }),
      automation: undefined,
    });
    expect(screen.getByTestId('checkpoint-preview-nothing').textContent).toBe(
      'Nothing to rewind: what still differs is named below, and a rewind cannot put it back.',
    );
    expect(
      within(screen.getByTestId('checkpoint-preview-cannot'))
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      '1 record deleted since cannot come back: the recycle bin no longer holds it, and the rewind cannot make it again — a file, whose body the checkpoint does not hold, or a record deleted while the checkpoint was taken (Case).',
    ]);
    expect(screen.queryByTestId('checkpoint-preview-rewind')).toBeNull();
  });

  it('offers no Rewind until its page gives one', () => {
    renderPreview(readyCheckpoint(), false);
    answerPreview();
    expect(screen.getByTestId('checkpoint-preview-numbers')).toBeInTheDocument();
    expect(screen.queryByTestId('checkpoint-preview-rewind')).toBeNull();
  });

  it('says a preview the org would not give, and asks again on Retry', () => {
    renderPreview();
    act(() =>
      host.current?.fail('checkpoint:preview', {
        message: 'A SandForge run is writing to DEV-SB: rewind once it has ended.',
        code: 'RUN_WRITING',
      }),
    );
    expect(screen.getByTestId('checkpoint-preview-error')).toHaveTextContent(
      'A SandForge run is writing to DEV-SB: rewind once it has ended.',
    );
    fireEvent.click(screen.getByTestId('checkpoint-preview-retry'));
    expect(host.current?.sent('checkpoint:preview')).toHaveLength(2);
  });

  it('reads the org again for a bypass just assigned, unticking what the last preview accepted', () => {
    renderPreview();
    const automation: ForgeTargetAutomation = {
      ...AUTOMATION,
      objects: [
        {
          objectApiName: 'Contact',
          flows: [
            {
              apiName: 'Contact_Gone',
              label: 'Contact gone',
              timing: 'beforeSave',
              startsOn: 'delete',
              condition: 'read',
              permissions: [{ name: 'Skip_Delete', bypass: true, held: false }],
            },
          ],
          triggers: [],
        },
      ],
      bypassGrants: [
        {
          permission: 'Skip_Delete',
          permissionSets: [{ name: 'Bypass_Delete', label: 'Bypass delete', grants: 1 }],
        },
      ],
    };
    answerPreview({ automation });
    fireEvent.click(screen.getByTestId('checkpoint-preview-accept-automation'));
    expect(screen.getByTestId('checkpoint-preview-rewind')).toBeEnabled();
    fireEvent.click(screen.getByTestId('bypass-assistant-read-again'));
    expect(host.current?.sent('checkpoint:preview')).toHaveLength(2);
    // The last answer stays while the org is read again, and Rewind waits for the new one.
    expect(screen.getByTestId('checkpoint-preview-reading-again').textContent).toBe(
      'Reading DEV-SB again…',
    );
    expect(screen.getByTestId('checkpoint-preview-rewind')).toBeDisabled();
    answerPreview({ automation, diff: previewDiff({ previewId: 'pv-2' }) });
    expect(screen.getByTestId('checkpoint-preview-accept-automation')).not.toBeChecked();
    expect(screen.getByTestId('checkpoint-preview-rewind')).toBeDisabled();
  });

  it('says a read again that failed, leaving the last answer up', () => {
    renderPreview();
    answerPreview({
      automation: {
        ...AUTOMATION,
        objects: [
          {
            objectApiName: 'Contact',
            flows: [
              {
                apiName: 'Contact_Gone',
                label: 'Contact gone',
                timing: 'beforeSave',
                startsOn: 'delete',
                condition: 'read',
                permissions: [{ name: 'Skip_Delete', bypass: true, held: false }],
              },
            ],
            triggers: [],
          },
        ],
        bypassGrants: [
          {
            permission: 'Skip_Delete',
            permissionSets: [{ name: 'Bypass_Delete', label: 'Bypass delete', grants: 1 }],
          },
        ],
      },
    });
    fireEvent.click(screen.getByTestId('bypass-assistant-read-again'));
    act(() =>
      host.current?.fail('checkpoint:preview', {
        message: 'The org did not answer.',
        code: 'PREVIEW_ERROR',
      }),
    );
    expect(screen.getByTestId('checkpoint-preview-error')).toHaveTextContent(
      'The org did not answer.',
    );
    expect(screen.getByTestId('checkpoint-preview-number-delete').textContent).toBe('8 to delete');
  });

  it('goes back to the checkpoints on Back', () => {
    const { onClose } = renderPreview();
    fireEvent.click(screen.getByTestId('checkpoint-preview-back'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
