import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import '../../i18n';
import type {
  ForgeTargetAutomation,
  OrgCheckpoint,
  RewindDiff,
  RewindSelectionPlan,
} from '@sandforge/shared';
import { useOrgStore } from '../../stores/useOrgStore';
import { dateTimeFormat } from '../../utils/formatters';
import {
  USERS,
  carriedDiff,
  developerOrg,
  diffObject,
  fakeHost,
  filesDiff,
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

import { RewindPreview, type MuteBoxOf, type RewindAcceptances } from './RewindPreview';
import { AutomationMuteBox } from '../../components/ui/AutomationMuteBox';

/** The box that mutes what the rewind fires, as the Checkpoints page draws it. */
const MUTE_BOX: MuteBoxOf = (offer, checked, onChange) => (
  <AutomationMuteBox
    offer={offer}
    checked={checked}
    onChange={onChange}
    org="DEV-SB"
    testId="checkpoint-preview-automation-mute"
  />
);
import { rewindTotals } from './rewindPreviewFacts';

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
      {...(withRewind ? { onRewind, muteBox: MUTE_BOX } : {})}
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

/** The text of each cell of an object's row of the table, its name first, its Rewind box left out. */
function rowCells(objectApiName: string): string[] {
  const row = screen.getByTestId(`checkpoint-preview-row-${objectApiName}`);
  return [
    within(row).getByRole('rowheader').textContent ?? '',
    ...within(row)
      .getAllByRole('cell')
      .filter((cell) => within(cell).queryByRole('checkbox') === null)
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
    ).toEqual(['Object', 'Delete', 'Give back', 'Bring back', 'Cannot undo', 'Rewind']);
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

  it('says in how many objects nothing changed in it did not check the fields, after the lines of the objects', () => {
    renderPreview();
    answerPreview({
      diff: previewDiff({
        objects: [diffObject('Contact', { touched: 2 })],
        fieldsNotChecked: 187,
      }),
    });
    expect(
      within(screen.getByTestId('checkpoint-preview-details'))
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Contact: 2 records touched since hold their checkpoint values: nothing to give back.',
      'Fields not checked for changes in 187 objects nothing changed in: a rewind writes nothing there.',
    ]);
  });

  it('says so of one object, with nothing else to say', () => {
    renderPreview();
    answerPreview({ diff: previewDiff({ objects: [], fieldsNotChecked: 1 }) });
    expect(screen.getByTestId('checkpoint-preview-details').textContent).toBe(
      'Fields not checked for changes in 1 object nothing changed in: a rewind writes nothing there.',
    );
  });

  it('says a record the checkpoint does not hold that took records of it along comes back for a moment, then goes back to the recycle bin, in none of the numbers', () => {
    renderPreview();
    answerPreview({ diff: carriedDiff() });
    expect(screen.getByTestId('checkpoint-preview-number-delete').textContent).toBe('1 to delete');
    expect(screen.getByTestId('checkpoint-preview-number-bring-back').textContent).toBe(
      '2 to bring back',
    );
    expect(rowCells('Account')).toEqual(['Account', '0', '0', '0', '0']);
    expect(
      within(screen.getByTestId('checkpoint-preview-details'))
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Contact: 2 records come back with their parent record.',
      'Contact: 4 field values to give back.',
      'Contact: 1 record created since and deleted with a parent the rewind brings back comes back with it, then is deleted.',
      'Account: 1 record the checkpoint does not hold, deleted since, took records of the checkpoint along: Salesforce gives those back with it only, so it comes back for a moment, then goes back to the recycle bin with what came back with it.',
    ]);
  });

  it('lists what the org runs on a record brought back for a moment, as it comes back and as it goes again, and holds Rewind until it is accepted', () => {
    renderPreview();
    answerPreview({
      diff: carriedDiff(),
      automation: {
        ...AUTOMATION,
        objects: [
          {
            objectApiName: 'Account',
            flows: [],
            triggers: [
              { name: 'AccountRestore', events: ['afterUndelete'] },
              { name: 'AccountGone', events: ['beforeDelete'] },
            ],
          },
        ],
      },
    });
    expect(screen.getByTestId('checkpoint-preview-automation-bringBack-Account').textContent).toBe(
      'Account: Apex trigger: AccountRestore · after undelete, as the rewind brings it back from the recycle bin',
    );
    expect(screen.getByTestId('checkpoint-preview-automation-delete-Account').textContent).toBe(
      'Account: Apex trigger: AccountGone · before delete',
    );
    expect(screen.getByTestId('checkpoint-preview-rewind')).toBeDisabled();
    expect(screen.getByTestId('checkpoint-preview-accept-automation')).toBeInTheDocument();
  });

  it('says in its confirmation the records it brings back for a moment and deletes again', () => {
    renderPreview();
    answerPreview({ diff: carriedDiff() });
    fireEvent.click(screen.getByTestId('checkpoint-preview-rewind'));
    expect(
      screen.getByText(
        /: it deletes the 1 record added since, gives 2 records their values from then back, brings back 2 records from the recycle bin and brings back for a moment 1 record that had taken records of the checkpoint along, then deletes it again, whoever made these changes\.$/,
      ),
    ).toBeInTheDocument();
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
          diffObject('Contact', { cannotUndo: [{ reason: 'deletedWithParentOutside', count: 3 }] }),
          diffObject('Note__c', { cannotUndo: [{ reason: 'deletedWithCreatedParent', count: 1 }] }),
        ],
      }),
    });
    const lines = within(screen.getByTestId('checkpoint-preview-cannot'))
      .getAllByRole('listitem')
      .map((item) => item.textContent);
    expect(lines).toEqual([
      '2 records deleted since cannot come back: the recycle bin no longer holds them, and the rewind cannot make them again — files, whose bodies the checkpoint does not hold, or records deleted while the checkpoint was taken (Case).',
      '1 record deleted with a parent created since cannot come back: Salesforce gives it back with that parent only, and does not undelete that parent on its own (Note__c).',
      "3 records deleted since with their parent, a record of an object the checkpoint does not hold, stay in the recycle bin: Salesforce gives them back with that parent only. A checkpoint that holds the parent's object brings them back (Contact).",
      '1 lead was converted since: Salesforce cannot unconvert a lead. What the conversion made is deleted, and the lead stays converted.',
      'Case.Region__c was deleted since the checkpoint: restore it from Deleted Fields (within 15 days), then rewind again.',
      'Case.Score__c was added since: its values stay.',
      "Formulas, roll-ups, auto-numbers and the created and modified dates are the org's own: Rewind does not write them, and the last modified dates will show the rewind.",
      'Rewind changes data in DEV-SB only. What already left it (emails, callouts, outbound messages, platform events, data other systems pulled) stays sent.',
      'Metadata is not rewound: fields, flows, validation rules, layouts and permissions stay as they are. Compare Org covers metadata.',
      // The diff holds no files: a checkpoint taken before they were held.
      'This checkpoint holds no files — taken before SandForge 1.70, or of objects without them: files attached since stay, and the result names those attached to the records it deletes.',
    ]);
  });

  it('names, read object by object, the records another user deleted and those out of reach, each never made again', () => {
    renderPreview();
    answerPreview({
      diff: previewDiff({
        objects: [
          diffObject('Account', { cannotUndo: [{ reason: 'deletedByOther', count: 2 }] }),
          diffObject('OpportunityLineItem', { cannotUndo: [{ reason: 'outOfReach', count: 1 }] }),
        ],
      }),
    });
    const lines = within(screen.getByTestId('checkpoint-preview-cannot'))
      .getAllByRole('listitem')
      .map((item) => item.textContent);
    expect(lines.slice(0, 2)).toEqual([
      '2 records deleted since by another user stay in the recycle bin: only a user with View All Data and Modify All Data restores what someone else deleted, and the rewind does not make them again (Account).',
      '1 record deleted since is out of reach: without View All Data and Modify All Data, nothing shows what others deleted of an object held through the records it hangs from. It may be in the recycle bin out of sight, so the rewind does not make it again (OpportunityLineItem).',
    ]);
  });

  it('says a field hidden by field-level security apart from one deleted since, with what lifts it, and one it could not tell, with both', () => {
    renderPreview();
    answerPreview({
      diff: previewDiff({
        objects: [
          diffObject('Case', {
            touched: 1,
            schemaDrift: {
              removed: ['Region__c'],
              added: [],
              changed: [],
              hidden: ['Priority'],
              uncertain: { fields: ['Tier__c'], reason: 'INSUFFICIENT_ACCESS' },
            },
          }),
        ],
      }),
    });
    const lines = within(screen.getByTestId('checkpoint-preview-cannot'))
      .getAllByRole('listitem')
      .map((item) => item.textContent);
    expect(lines).toEqual([
      'Case.Region__c was deleted since the checkpoint: restore it from Deleted Fields (within 15 days), then rewind again.',
      'Case.Priority is hidden from admin@example.com by field-level security since the checkpoint: Rewind does not put it back. Give admin@example.com read and edit access to it, then rewind again.',
      'Case.Tier__c is gone from what DEV-SB shows admin@example.com: it was deleted since the checkpoint (restore it from Deleted Fields within 15 days), or field-level security hides it (give admin@example.com read and edit access). Rewind does not put it back.',
    ]);
    // A field hidden is not compared: the org is not said to be as it was.
    expect(screen.getByTestId('checkpoint-preview-nothing').textContent).toBe(
      'Nothing to rewind: what still differs is named below, and a rewind cannot put it back.',
    );
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

  it('says a preview read object by object so, and names an object the user no longer holds whole among those it could not read, with the user', () => {
    renderPreview();
    answerPreview({
      diff: previewDiff({
        access: { kind: 'perObject', requests: 4 },
        unread: [
          {
            objectApiName: 'Opportunity',
            reason: 'admin@example.com no longer has View All and Modify All on Opportunity',
          },
        ],
      }),
    });
    expect(screen.getByTestId('checkpoint-preview-per-object').textContent).toBe(
      "admin@example.com doesn't have View All Data and Modify All Data: this preview read each object of the checkpoint with View All and Modify All on it. A rewind leaves what another user deleted since in the recycle bin, and leaves as it is an object admin@example.com no longer holds whole, among those it could not read.",
    );
    const unread = screen.getByTestId('checkpoint-preview-unread');
    expect(within(unread).getByRole('heading').textContent).toBe(
      '1 object could not be read: a rewind leaves it as it is',
    );
    expect(within(unread).getByRole('listitem').textContent).toBe(
      'Opportunity — admin@example.com no longer has View All and Modify All on Opportunity',
    );
  });

  it('says nothing of a read object by object when the user has View All Data and Modify All Data', () => {
    renderPreview();
    answerPreview();
    expect(screen.queryByTestId('checkpoint-preview-per-object')).toBeNull();
    expect(screen.queryByTestId('checkpoint-preview-unseen')).toBeNull();
    expect(screen.queryByTestId('checkpoint-preview-accept-unseen')).toBeNull();
  });

  it('says, read object by object, what the deletions take along that the user can’t see, in the refusal’s words, and holds Rewind until it is accepted', () => {
    const { onRewind } = renderPreview();
    answerPreview({
      diff: previewDiff({
        access: { kind: 'perObject', requests: 4 },
        unseen: [
          { objectApiName: 'Contact', children: ['Event', 'Task'], records: 5 },
          { objectApiName: 'Account', children: ['Task'], records: 1 },
        ],
      }),
    });
    const section = screen.getByTestId('checkpoint-preview-unseen');
    expect(within(section).getByRole('heading', { level: 3 }).textContent).toBe(
      'Also deleted with them, out of sight',
    );
    expect(screen.getByTestId('checkpoint-preview-unseen-Contact').textContent).toBe(
      "Deleting 5 Contact records added since also deletes what admin@example.com can't see under them in Event and Task: Rewind can't count those.",
    );
    expect(screen.getByTestId('checkpoint-preview-unseen-Account').textContent).toBe(
      "Deleting 1 Account record added since also deletes what admin@example.com can't see under it in Task: Rewind can't count those.",
    );
    expect(section.textContent).toContain(
      'Without View All Data and Modify All Data, nothing proves admin@example.com sees every record of those objects — tasks and events have no View All.',
    );
    // Named by its section, as the page's other boxes are.
    expect(section).toHaveAccessibleName('Also deleted with them, out of sight');

    const rewind = screen.getByTestId('checkpoint-preview-rewind');
    expect(rewind).toBeDisabled();
    const box = screen.getByRole('checkbox', {
      name: "Delete them all the same, with what admin@example.com can't see under them",
    });
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    expect(rewind).toBeEnabled();
    fireEvent.click(rewind);
    // The typed confirmation says it too: no number counts them.
    expect(screen.getByRole('dialog').textContent).toContain(
      "It also deletes, uncounted, what admin@example.com can't see under the records it deletes, in Event and Task.",
    );
    confirmRewind();
    expect(onRewind).toHaveBeenCalledWith(
      expect.objectContaining({ acceptUnseen: true, acceptNoUndo: false }),
      expect.anything(),
    );
  });

  it('holds Rewind again once its box of what goes out of sight is unticked', () => {
    renderPreview();
    answerPreview({
      diff: previewDiff({
        access: { kind: 'perObject', requests: 4 },
        unseen: [{ objectApiName: 'Account', children: ['Task'], records: 3 }],
      }),
    });
    const box = screen.getByTestId('checkpoint-preview-accept-unseen');
    fireEvent.click(box);
    fireEvent.click(box);
    expect(screen.getByTestId('checkpoint-preview-rewind')).toBeDisabled();
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
        acceptUnseen: false,
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

  it('names a custom setting the checkpoint keeps as one, configuration, in its row, and says in its confirmation how many of its rows the rewind sets back', () => {
    const base = readyCheckpoint();
    const setting = {
      ...base.objects[0],
      objectApiName: 'Hier__c',
      records: 2,
      inBin: 0,
      readOrder: 2,
      customSetting: 'hierarchy' as const,
    };
    renderPreview(readyCheckpoint({ objects: [...base.objects, setting] }));
    answerPreview({
      diff: previewDiff({
        objects: [
          diffObject('Account', { toGiveBack: { records: 1, fields: 1, clearedLookups: 0 } }),
          diffObject('Hier__c', {
            toDelete: { createdSince: 3, broughtBackSince: 0, comesBackWithParent: 0 },
            toBringBack: { inBin: 2, withParent: 0, deletedWhileTaken: 0 },
          }),
        ],
      }),
    });

    expect(rowCells('Hier__c')[0]).toBe('Hier__cCustom setting (configuration)');
    expect(screen.getByTestId('checkpoint-preview-setting-Hier__c')).toHaveTextContent(
      'Custom setting (configuration)',
    );
    expect(screen.queryByTestId('checkpoint-preview-setting-Account')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('checkpoint-preview-rewind'));
    expect(
      screen.getByText(
        /, whoever made these changes\. Of them, 5 are rows of custom settings: configuration, set back as the checkpoint holds them\.$/,
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

  it('lists a trigger on the links between files and records as a link the rewind removes fires it, and holds Rewind until it is accepted', () => {
    renderPreview();
    answerPreview({
      diff: previewDiff({
        objects: [diffObject('ContentDocument')],
        files: {
          unlink: 1,
          relink: 0,
          updateLinks: 0,
          outsideAdded: 0,
          outsideDeleted: 0,
          storage: { bringBack: 0, undo: 0 },
        },
      }),
      automation: {
        ...AUTOMATION,
        objectsRead: ['ContentDocumentLink'],
        objects: [
          {
            objectApiName: 'ContentDocumentLink',
            flows: [],
            triggers: [{ name: 'FileAttachedToCase', events: ['afterDelete'] }],
          },
        ],
      },
    });
    expect(
      screen.getByTestId('checkpoint-preview-automation-delete-ContentDocumentLink').textContent,
    ).toContain('FileAttachedToCase');
    expect(screen.getByTestId('checkpoint-preview-rewind')).toBeDisabled();
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Rewind even though DEV-SB runs automation' }),
    );
    expect(screen.getByTestId('checkpoint-preview-rewind')).toBeEnabled();
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

  it('says the files a rewind deletes that are attached outside the checkpoint too as files, and asks for them in a checkpoint of picked objects', () => {
    const { onRewind } = renderPreview(readyCheckpoint({ scope: { mode: 'picked', leftOut: [] } }));
    answerPreview({
      diff: previewDiff({
        objects: [
          diffObject('ContentDocument', {
            toDelete: { createdSince: 2, broughtBackSince: 0, comesBackWithParent: 0 },
            outside: [{ objectApiName: 'ContentDocumentLink', count: 3, parents: 2 }],
          }),
        ],
      }),
    });
    expect(
      screen.getByTestId('checkpoint-preview-outside-ContentDocument-ContentDocumentLink')
        .textContent,
    ).toBe(
      '2 files the rewind deletes are attached outside the checkpoint too — to a library, a group or a record of another object — by 3 links: deleting them removes them from there as well.',
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'Delete these too' }));
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

  it('says the emails of what it could not read were not counted, though nothing it read sends one, and asks for the automation to be accepted', () => {
    const { onRewind } = renderPreview();
    answerPreview({
      emailsUncounted:
        'the definition of Account feedback (package survey_kit, whose flows the org lets no one ' +
        'read) on Account',
    });

    expect(screen.queryByTestId('checkpoint-preview-emails')).not.toBeInTheDocument();
    expect(screen.getByTestId('checkpoint-preview-emails-uncounted').textContent).toBe(
      'What DEV-SB runs as the rewind writes could not all be read (the definition of Account ' +
        'feedback (package survey_kit, whose flows the org lets no one read) on Account), so the ' +
        'emails it sends were not counted against its daily limits.',
    );
    expect(screen.getByTestId('checkpoint-preview-rewind')).toBeDisabled();
    fireEvent.click(screen.getByTestId('checkpoint-preview-accept-automation'));
    fireEvent.click(screen.getByTestId('checkpoint-preview-rewind'));
    confirmRewind();
    expect(onRewind).toHaveBeenCalledWith(
      expect.objectContaining({ acceptAutomation: true }),
      expect.anything(),
    );
  });

  it('says nothing of emails not counted when every one was', () => {
    renderPreview();
    answerPreview();
    expect(screen.queryByTestId('checkpoint-preview-emails-uncounted')).not.toBeInTheDocument();
    expect(screen.queryByTestId('checkpoint-preview-accept-automation')).not.toBeInTheDocument();
  });

  describe('the box that mutes what the rewind fires', () => {
    /** A flow on the account's update a set of the org silences: all the rewind fires on it. */
    const MUTABLE: ForgeTargetAutomation = {
      ...AUTOMATION,
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
              permissions: [{ name: 'Skip_Touch', bypass: true, held: false }],
            },
          ],
          triggers: [],
        },
      ],
      bypassGrants: [
        {
          permission: 'Skip_Touch',
          permissionSets: [{ name: 'Touch_Bypass', label: 'Touch bypass', grants: 1 }],
        },
      ],
    };

    it('is offered, off, beside what fires, only when a set of the org silences some of it', () => {
      renderPreview();
      answerPreview({ automation: AUTOMATION });
      expect(screen.queryByTestId('checkpoint-preview-automation-mute')).not.toBeInTheDocument();
      cleanup();

      renderPreview();
      answerPreview({ automation: MUTABLE });
      expect(screen.getByTestId('checkpoint-preview-automation-mute-toggle')).not.toBeChecked();
      expect(
        screen.getByTestId('checkpoint-preview-automation-mute-silenced-Account').textContent,
      ).toBe('Account: Flow: Account touch · bypass Skip_Touch');
    });

    it('is not offered on a preview that starts no rewind, as the Automation page’s Rewind step shows it', () => {
      renderPreview(readyCheckpoint(), false);
      answerPreview({ automation: MUTABLE });
      expect(screen.getByTestId('checkpoint-preview-automation')).toBeInTheDocument();
      expect(screen.queryByTestId('checkpoint-preview-automation-mute')).not.toBeInTheDocument();
      // What fires is accepted as ever there.
      expect(screen.getByTestId('checkpoint-preview-accept-automation')).toBeInTheDocument();
    });

    it('rewinds unmuted unless ticked, and asks then no acceptance for what it silences', () => {
      const { onRewind } = renderPreview();
      answerPreview({ automation: MUTABLE });
      // What fires is to be accepted, as ever, unless it is muted.
      expect(screen.getByTestId('checkpoint-preview-rewind')).toBeDisabled();
      expect(screen.getByTestId('checkpoint-preview-accept-automation')).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('checkpoint-preview-automation-mute-toggle'));
      expect(screen.queryByTestId('checkpoint-preview-accept-automation')).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId('checkpoint-preview-rewind'));
      confirmRewind();
      expect(onRewind).toHaveBeenCalledWith(
        {
          previewId: 'pv-1',
          acceptAutomation: false,
          acceptNoUndo: false,
          acceptRecreate: false,
          acceptOutside: false,
          acceptUnseen: false,
          muteAutomation: true,
        },
        expect.anything(),
      );
    });

    it('still asks acceptance for what still runs once muted', () => {
      const { onRewind } = renderPreview();
      answerPreview({
        automation: {
          ...MUTABLE,
          objects: [
            ...MUTABLE.objects,
            {
              objectApiName: 'Contact',
              flows: [],
              triggers: [{ name: 'ContactGone', events: ['beforeDelete'] }],
            },
          ],
        },
      });
      fireEvent.click(screen.getByTestId('checkpoint-preview-automation-mute-toggle'));

      expect(screen.getByTestId('checkpoint-preview-rewind')).toBeDisabled();
      fireEvent.click(screen.getByTestId('checkpoint-preview-accept-automation'));
      fireEvent.click(screen.getByTestId('checkpoint-preview-rewind'));
      confirmRewind();
      expect(onRewind).toHaveBeenCalledWith(
        expect.objectContaining({ acceptAutomation: true, muteAutomation: true }),
        expect.anything(),
      );
    });
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

  it('says what a rewind of a checkpoint that holds files does to their links and leaves of the org’s files, each in its words', () => {
    renderPreview();
    answerPreview({ diff: filesDiff() });
    const section = screen.getByTestId('checkpoint-preview-files');
    expect(within(section).getByRole('heading').textContent).toBe('Files and their links');
    expect(
      within(section)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      '1 link added since between a file and a record that both stay: removed. The file stays, no longer attached to that record.',
      '2 links removed since between files and records that stay: put back, under new Ids — Salesforce keeps no removed link in the recycle bin.',
      "1 link whose sharing changed since gets it back: who sees the file from the record, and with what access. A link to an account keeps its access, which Salesforce doesn't let change: only who sees the file is given back.",
      "Kept: 2 files added since, as no record of this checkpoint links to them — a user's own, a library's.",
      'Left in the recycle bin: 1 file deleted since, as no record of this checkpoint linked to it.',
      'Bringing back 1 file from the recycle bin takes 12 MB of file storage again; DEV-SB has 40 MB left.',
      'Undo would bring back the files this rewind deletes, taking 3 MB of file storage again.',
    ]);
    // The files themselves are the table's: deleted, brought back, given back.
    expect(rowCells('ContentDocument')).toEqual(['ContentDocument', '1', '1', '1', '1']);
  });

  it('names a file given a new version among what a rewind cannot undo, and no line of a checkpoint without files', () => {
    renderPreview();
    answerPreview({ diff: filesDiff() });
    const lines = within(screen.getByTestId('checkpoint-preview-cannot'))
      .getAllByRole('listitem')
      .map((item) => item.textContent);
    expect(lines[0]).toBe(
      "1 file got a new version since: Salesforce deletes no version and won't make an older one the latest again, so the file keeps its new content. The content it had is still in its version history; its title is given back.",
    );
    expect(screen.queryByTestId('checkpoint-preview-cannot-filesNotHeld')).toBeNull();
  });

  it('says the file storage a rewind brings back takes without what is left when the org did not say, and what a user without Query All Files does not see', () => {
    renderPreview();
    answerPreview({
      diff: filesDiff({
        unlink: 0,
        relink: 0,
        updateLinks: 0,
        outsideAdded: 0,
        outsideDeleted: 0,
        storage: { bringBack: 512_000, undo: 0 },
        blindSpot: true,
      }),
    });
    expect(
      within(screen.getByTestId('checkpoint-preview-files'))
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Bringing back 1 file from the recycle bin takes 500 KB of file storage again; DEV-SB did not say how much it has left.',
      "admin@example.com doesn't have Query All Files: the files of other users that no record of this checkpoint is attached to aren't seen, nor counted here.",
    ]);
  });

  it('rewinds a checkpoint whose only difference is a link between a file and a record, saying so in its confirmation', () => {
    const { onRewind } = renderPreview();
    const diff = previewDiff({
      objects: [diffObject('Account'), diffObject('ContentDocument')],
      files: {
        unlink: 1,
        relink: 0,
        updateLinks: 0,
        outsideAdded: 0,
        outsideDeleted: 0,
        storage: { bringBack: 0, undo: 0 },
      },
    });
    answerPreview({ diff });
    expect(screen.queryByTestId('checkpoint-preview-nothing')).toBeNull();
    const rewind = screen.getByTestId('checkpoint-preview-rewind');
    expect(rewind).toBeEnabled();
    fireEvent.click(rewind);
    expect(
      screen.getByText(
        /: it puts 1 link between a file and a record back as it was, whoever made these changes\.$/,
      ),
    ).toBeInTheDocument();
    confirmRewind();
    expect(onRewind).toHaveBeenCalledWith(expect.objectContaining({ previewId: 'pv-1' }), diff);
  });

  it('says what still differs, never that the org is as it was, when files no record of the checkpoint links to were added since', () => {
    renderPreview();
    answerPreview({
      diff: previewDiff({
        objects: [diffObject('ContentDocument')],
        files: {
          unlink: 0,
          relink: 0,
          updateLinks: 0,
          outsideAdded: 2,
          outsideDeleted: 0,
          storage: { bringBack: 0, undo: 0 },
        },
      }),
      automation: undefined,
    });
    expect(screen.getByTestId('checkpoint-preview-nothing').textContent).toBe(
      'Nothing to rewind: what still differs is named below, and a rewind cannot put it back.',
    );
    expect(screen.getByTestId('checkpoint-preview-files-outside-added').textContent).toBe(
      "Kept: 2 files added since, as no record of this checkpoint links to them — a user's own, a library's.",
    );
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

/**
 * A preview of three objects, as a scratch org read one: an account deleted
 * since with its contact, which comes back only with it, a contact and an
 * account created since, an account whose parent account lookup the deletion
 * emptied, and cases changed since.
 */
function threeObjects(): Parameters<typeof previewAnswer>[0] {
  return {
    diff: previewDiff({
      objects: [
        diffObject('Contact', {
          toDelete: { createdSince: 1, broughtBackSince: 0, comesBackWithParent: 0 },
          toBringBack: { inBin: 0, withParent: 1, deletedWhileTaken: 0 },
          lastChangedBy: { [USERS.alice]: 1 },
        }),
        diffObject('Account', {
          toDelete: { createdSince: 1, broughtBackSince: 0, comesBackWithParent: 0 },
          toGiveBack: { records: 1, fields: 1, clearedLookups: 1 },
          toBringBack: { inBin: 2, withParent: 0, deletedWhileTaken: 0 },
          lastChangedBy: { [USERS.alice]: 2 },
        }),
        diffObject('Case', {
          toGiveBack: { records: 3, fields: 3, clearedLookups: 0 },
          lastChangedBy: { [USERS.integration]: 3 },
        }),
      ],
    }),
  };
}

/**
 * The plan of a rewind of the contacts alone, as the extension answered it on
 * that org: the contact created since deleted, the one deleted with its
 * account left, which needs the account.
 */
function contactPlan(overrides: Partial<RewindSelectionPlan> = {}): RewindSelectionPlan {
  return {
    objects: ['Contact'],
    acts: [
      {
        objectApiName: 'Contact',
        picked: true,
        toDelete: 1,
        toGiveBack: 0,
        toBringBack: 0,
        toRecreate: 0,
      },
    ],
    left: [{ objectApiName: 'Contact', reason: 'needsUnpickedParent', count: 1 }],
    needs: [{ objectApiName: 'Account', records: 1 }],
    undoCannot: [],
    ...overrides,
  };
}

describe('RewindPreview, limited to some objects', () => {
  beforeEach(() => {
    host.current = fakeHost();
    useOrgStore.setState({ orgs: [developerOrg()], selectedOrgId: 'org-dev' });
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date(2026, 9, 22, 12, 0, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
    useOrgStore.setState({ orgs: [], selectedOrgId: null });
  });

  /** Tick or untick an object in the Rewind column. */
  function pick(objectApiName: string): void {
    fireEvent.click(screen.getByTestId(`checkpoint-preview-pick-${objectApiName}`));
  }

  /** Let the ticks settle, as the page waits before it asks for their plan. */
  function settle(ms = 400): void {
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  }

  /** Answer the last `checkpoint:plan-selection` with `plan`. */
  function answerPlan(plan: RewindSelectionPlan): void {
    act(() =>
      host.current?.answer('checkpoint:plan-selection', 'checkpoint:plan-selection:response', {
        checkpointId: ID,
        previewId: 'pv-1',
        plan,
      }),
    );
  }

  it('offers a Rewind column, every object ticked, and asks for no plan of a rewind of every object', () => {
    renderPreview();
    answerPreview(threeObjects());
    for (const name of ['Contact', 'Account', 'Case']) {
      const box = screen.getByRole('checkbox', { name: `Rewind ${name}` });
      expect(box).toBeChecked();
    }
    settle(1_000);
    expect(host.current?.sent('checkpoint:plan-selection')).toEqual([]);
    expect(screen.queryByTestId('checkpoint-preview-selection')).toBeNull();
  });

  it('offers no Rewind column for a preview of one object, nor without a Rewind', () => {
    renderPreview();
    answerPreview({ diff: previewDiff({ objects: [previewDiff().objects[0]] }) });
    expect(screen.queryByTestId('checkpoint-preview-pick-Contact')).toBeNull();
    cleanup();
    renderPreview(readyCheckpoint(), false);
    answerPreview(threeObjects());
    expect(screen.queryByTestId('checkpoint-preview-pick-Contact')).toBeNull();
  });

  it('asks once, as the ticks settle, for the plan of the objects still ticked, and says its numbers, what it leaves by why and what that needs', () => {
    renderPreview();
    answerPreview(threeObjects());
    pick('Case');
    settle(200);
    pick('Account');
    settle(399);
    // Planning, the org not read: nothing asked while the ticks move.
    expect(host.current?.sent('checkpoint:plan-selection')).toEqual([]);
    settle(1);
    expect(host.current?.sent('checkpoint:plan-selection')).toHaveLength(1);
    expect(host.current?.lastPayload('checkpoint:plan-selection')).toEqual({
      checkpointId: ID,
      previewId: 'pv-1',
      objects: ['Contact'],
      acceptOutside: false,
    });
    expect(screen.getByTestId('checkpoint-preview-selection-planning').textContent).toBe(
      'Planning the rewind of Contact from this preview: the org is not read.',
    );
    expect(screen.getByTestId('checkpoint-preview-rewind')).toBeDisabled();

    answerPlan(contactPlan());
    expect(screen.queryByTestId('checkpoint-preview-selection-planning')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Limited to Contact' })).toBeInTheDocument();
    // The plan's numbers, not the diff's: the contact deleted with its account stays.
    expect(screen.getByTestId('checkpoint-preview-number-delete').textContent).toBe('1 to delete');
    expect(screen.getByTestId('checkpoint-preview-number-give-back').textContent).toBe(
      '0 to give back',
    );
    expect(screen.getByTestId('checkpoint-preview-number-bring-back').textContent).toBe(
      '0 to bring back',
    );
    expect(rowCells('Contact')).toEqual(['Contact', '1', '0', '0', '0']);
    expect(rowCells('Account')).toEqual(['AccountNot rewound', '0', '0', '0', '0']);
    expect(rowCells('Case')).toEqual(['CaseNot rewound', '0', '0', '0', '0']);
    expect(screen.getByTestId('checkpoint-preview-last-changed').textContent).toBe(
      'Last changed by: Alice Martin 1',
    );
    expect(
      screen.getByTestId('checkpoint-preview-selection-left-Contact-needsUnpickedParent')
        .textContent,
    ).toBe(
      'Contact: 1 record left — it comes back only with a parent this rewind leaves deleted, or looks up a record it leaves deleted, which Salesforce refuses: that lookup is left, the rest written.',
    );
    expect(screen.getByTestId('checkpoint-preview-needs-Account')).toHaveTextContent(
      'To rewind it too, add Account: 1 record needs it.',
    );
    expect(screen.getByTestId('checkpoint-preview-selection-lookups').textContent).toBe(
      'A record of an object not ticked that looks up a record this rewind deletes has that lookup emptied by Salesforce, and is dated that second.',
    );
    expect(screen.getByTestId('checkpoint-preview-rewind')).toBeEnabled();
    // Still one ask: the answer asked nothing more.
    settle(1_000);
    expect(host.current?.sent('checkpoint:plan-selection')).toHaveLength(1);
  });

  it('ticks an object a record needs on Add, and asks for the plan again', () => {
    renderPreview();
    answerPreview(threeObjects());
    pick('Account');
    pick('Case');
    settle();
    answerPlan(contactPlan());
    fireEvent.click(screen.getByRole('button', { name: 'Add Account' }));
    expect(screen.getByRole('checkbox', { name: 'Rewind Account' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Rewind Case' })).not.toBeChecked();
    // The plan of Contact alone no longer counts: Rewind waits for the next.
    expect(screen.getByTestId('checkpoint-preview-rewind')).toBeDisabled();
    settle();
    expect(host.current?.sent('checkpoint:plan-selection')).toHaveLength(2);
    expect(host.current?.lastPayload('checkpoint:plan-selection')).toEqual(
      expect.objectContaining({ objects: ['Contact', 'Account'] }),
    );
  });

  it('names the objects ticked in its typed question, and rewinds them alone with the plan’s numbers', () => {
    const { onRewind } = renderPreview();
    answerPreview(threeObjects());
    pick('Case');
    settle();
    const plan = contactPlan({
      objects: ['Contact', 'Account'],
      acts: [
        {
          objectApiName: 'Contact',
          picked: true,
          toDelete: 1,
          toGiveBack: 0,
          toBringBack: 1,
          toRecreate: 0,
        },
        {
          objectApiName: 'Account',
          picked: true,
          toDelete: 1,
          toGiveBack: 1,
          toBringBack: 2,
          toRecreate: 0,
        },
      ],
      left: [],
      needs: [],
    });
    answerPlan(plan);
    fireEvent.click(screen.getByTestId('checkpoint-preview-rewind'));
    expect(screen.getByTestId('danger-title').textContent).toBe(
      'Rewind Contact and Account of DEV-SB to “Before UAT”?',
    );
    const date = dateTimeFormat({ dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date('2026-10-20T14:05:12.000Z'),
    );
    expect(
      screen.getByText(
        `This rewind returns Contact and Account of DEV-SB to ${date}: it deletes the 2 records added since, gives 1 record its values from then back and brings back 3 records from the recycle bin, whoever made these changes. The other objects are left as they are.`,
      ),
    ).toBeInTheDocument();
    confirmRewind();
    expect(onRewind).toHaveBeenCalledTimes(1);
    const [acceptances, counted] = onRewind.mock.calls[0] as [RewindAcceptances, RewindDiff];
    expect(acceptances).toEqual({
      previewId: 'pv-1',
      acceptAutomation: false,
      acceptNoUndo: false,
      acceptRecreate: false,
      acceptOutside: false,
      acceptUnseen: false,
      objects: ['Contact', 'Account'],
    });
    // The run says the phases of what it rewinds: the plan's, never the diff's cases.
    expect(counted.objects.map((object) => object.objectApiName)).toEqual(['Contact', 'Account']);
    expect(rewindTotals(counted)).toEqual({
      toDelete: 2,
      toGiveBack: 1,
      toBringBack: 3,
      toRecreate: 0,
    });
  });

  it('rewinds every object again, naming none, once every object is ticked again', () => {
    const { onRewind } = renderPreview();
    answerPreview(threeObjects());
    pick('Case');
    settle();
    pick('Case');
    expect(screen.queryByTestId('checkpoint-preview-selection')).toBeNull();
    expect(screen.getByTestId('checkpoint-preview-number-delete').textContent).toBe('2 to delete');
    fireEvent.click(screen.getByTestId('checkpoint-preview-rewind'));
    expect(screen.getByTestId('danger-title').textContent).toBe('Rewind DEV-SB to “Before UAT”?');
    confirmRewind();
    expect(onRewind.mock.calls[0]?.[0]).not.toHaveProperty('objects');
  });

  it('says so when no object is ticked, asks for no plan and holds Rewind', () => {
    renderPreview();
    answerPreview(threeObjects());
    pick('Contact');
    pick('Account');
    pick('Case');
    settle();
    expect(host.current?.sent('checkpoint:plan-selection')).toEqual([]);
    expect(screen.getByTestId('checkpoint-preview-selection-none').textContent).toBe(
      'Tick in the Rewind column the objects to rewind.',
    );
    expect(screen.getByTestId('checkpoint-preview-rewind')).toBeDisabled();
  });

  it('says what it deletes again of an object not ticked: made since, they come back with a record it brings back', () => {
    renderPreview();
    answerPreview(threeObjects());
    pick('Contact');
    pick('Case');
    settle();
    answerPlan({
      objects: ['Account'],
      acts: [
        {
          objectApiName: 'Contact',
          picked: false,
          toDelete: 2,
          toGiveBack: 0,
          toBringBack: 0,
          toRecreate: 0,
        },
        {
          objectApiName: 'Account',
          picked: true,
          toDelete: 1,
          toGiveBack: 1,
          toBringBack: 2,
          toRecreate: 0,
        },
      ],
      left: [],
      needs: [],
      undoCannot: [],
    });
    expect(screen.getByTestId('checkpoint-preview-selection-again-Contact').textContent).toBe(
      'Contact, not ticked: 2 records made since come back with a record this rewind brings back, and are deleted again — leaving them would make a state that never existed.',
    );
    expect(rowCells('Contact')).toEqual(['ContactNot rewound', '2', '0', '0', '0']);
    expect(screen.getByTestId('checkpoint-preview-number-delete').textContent).toBe('3 to delete');
    fireEvent.click(screen.getByTestId('checkpoint-preview-rewind'));
    expect(
      screen.getByText(/Of the other objects, it deletes only the records made since/),
    ).toBeInTheDocument();
  });

  it('holds Rewind until what Undo could not bring back of the plan is accepted, as the rewind refuses it', () => {
    const { onRewind } = renderPreview();
    answerPreview(threeObjects());
    pick('Account');
    pick('Case');
    settle();
    // The diff had nothing Undo could not bring back: the plan deletes a
    // contact on its own, its account not picked.
    answerPlan(contactPlan({ undoCannot: [{ objectApiName: 'Contact', count: 1 }] }));
    expect(screen.getByTestId('checkpoint-preview-undo-cannot-Contact').textContent).toBe(
      '1 Contact record this rewind deletes: Salesforce undeletes it only with its parent record, which stays.',
    );
    expect(screen.getByTestId('checkpoint-preview-rewind')).toBeDisabled();
    fireEvent.click(screen.getByTestId('checkpoint-preview-accept-no-undo'));
    fireEvent.click(screen.getByTestId('checkpoint-preview-rewind'));
    confirmRewind();
    expect(onRewind).toHaveBeenCalledWith(
      expect.objectContaining({ acceptNoUndo: true, objects: ['Contact'] }),
      expect.anything(),
    );
  });

  it('asks again with deleting accepted what an object not ticked hangs from a record it deletes, and rewinds with it accepted', () => {
    const { onRewind } = renderPreview();
    answerPreview(threeObjects());
    pick('Contact');
    pick('Case');
    settle();
    answerPlan({
      objects: ['Account'],
      acts: [
        {
          objectApiName: 'Account',
          picked: true,
          toDelete: 0,
          toGiveBack: 1,
          toBringBack: 2,
          toRecreate: 0,
        },
      ],
      left: [{ objectApiName: 'Account', reason: 'outsideNotAccepted', count: 1 }],
      needs: [{ objectApiName: 'Contact', records: 1 }],
      undoCannot: [],
    });
    expect(
      screen.getByTestId('checkpoint-preview-selection-left-Account-outsideNotAccepted')
        .textContent,
    ).toBe(
      'Account: 1 record kept — records of an object not ticked, made since, hang from it, which its deletion would take along.',
    );
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: 'Delete these records too, with the records of objects not ticked made since that hang from them',
      }),
    );
    settle();
    expect(host.current?.sent('checkpoint:plan-selection')).toHaveLength(2);
    expect(host.current?.lastPayload('checkpoint:plan-selection')).toEqual(
      expect.objectContaining({ objects: ['Account'], acceptOutside: true }),
    );
    answerPlan({
      objects: ['Account'],
      acts: [
        {
          objectApiName: 'Account',
          picked: true,
          toDelete: 1,
          toGiveBack: 1,
          toBringBack: 2,
          toRecreate: 0,
        },
      ],
      left: [],
      needs: [],
      undoCannot: [],
    });
    // Ticked, it stays offered to untick, the plan no longer leaving the record.
    expect(screen.getByTestId('checkpoint-preview-accept-outside-unpicked')).toBeChecked();
    fireEvent.click(screen.getByTestId('checkpoint-preview-rewind'));
    confirmRewind();
    expect(onRewind).toHaveBeenCalledWith(
      expect.objectContaining({ acceptOutside: true, objects: ['Account'] }),
      expect.anything(),
    );
  });

  it('says nothing of the links between files and records of a rewind that leaves the files out, never that the checkpoint holds none', () => {
    renderPreview(readyCheckpoint({ files: { documents: 3, links: 4, anchored: 3 } }));
    answerPreview({ diff: filesDiff() });
    expect(screen.getByTestId('checkpoint-preview-files')).toBeInTheDocument();
    pick('ContentDocument');
    settle();
    answerPlan({
      objects: ['Account'],
      acts: [
        {
          objectApiName: 'Account',
          picked: true,
          toDelete: 1,
          toGiveBack: 0,
          toBringBack: 0,
          toRecreate: 0,
        },
      ],
      left: [],
      needs: [],
      undoCannot: [],
    });
    expect(screen.queryByTestId('checkpoint-preview-files')).toBeNull();
    expect(screen.getByTestId('checkpoint-preview-cannot')).toBeInTheDocument();
    expect(screen.queryByTestId('checkpoint-preview-cannot-filesNotHeld')).toBeNull();
    expect(screen.queryByTestId('checkpoint-preview-cannot-newFileVersion')).toBeNull();
  });

  it('says a plan it could not make, holding Rewind, and asks again on Retry', () => {
    renderPreview();
    answerPreview(threeObjects());
    pick('Case');
    settle();
    act(() =>
      host.current?.fail('checkpoint:plan-selection', {
        message:
          "The preview to plan this selection from is no longer kept on this machine: preview the rewind to 'Before UAT' again. No record was read or written.",
        code: 'PREVIEW_GONE',
      }),
    );
    expect(screen.getByTestId('checkpoint-preview-selection-error')).toHaveTextContent(
      'The preview to plan this selection from is no longer kept on this machine',
    );
    expect(screen.getByTestId('checkpoint-preview-rewind')).toBeDisabled();
    fireEvent.click(screen.getByTestId('checkpoint-preview-selection-retry'));
    expect(host.current?.sent('checkpoint:plan-selection')).toHaveLength(2);
    expect(host.current?.lastPayload('checkpoint:plan-selection')).toEqual(
      expect.objectContaining({ objects: ['Contact', 'Account'] }),
    );
  });
});
