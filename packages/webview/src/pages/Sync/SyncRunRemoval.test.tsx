import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import type {
  BaseMessage,
  ForgeTargetAutomation,
  SalesforceOrg,
  SyncRemovalResult,
  SyncRunRemovalInfo,
} from '@sandforge/shared';
import '../../i18n';

const mockPostMessage = vi.fn();

/** Stable identity so useSendMessage's useCallback does not re-fire. */
const stableApi = {
  postMessage: (...args: unknown[]) => mockPostMessage(...args),
  getState: () => undefined,
  setState: () => undefined,
};

vi.mock('../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => stableApi,
  getVscodeApi: () => stableApi,
}));

import { SyncRunRemoval } from './SyncRunRemoval';
import { useOrgStore } from '../../stores/useOrgStore';

const DEV = {
  id: 'org-dev',
  alias: 'DEV-SANDBOX',
  status: 'connected',
} as unknown as SalesforceOrg;

/** A run that created a file and two accounts in the sandbox. */
const KEPT: SyncRunRemovalInfo = {
  runId: 'run-1',
  configId: 'cfg-1',
  configName: 'Accounts',
  sourceOrgId: 'org-source',
  targetOrgId: 'org-dev',
  startedAt: '2026-10-14T08:00:00.000Z',
  endedAt: '2026-10-14T08:01:00.000Z',
  created: 3,
  left: [
    { objectApiName: 'ContentDocument', count: 1 },
    { objectApiName: 'Account', count: 2 },
  ],
};

const DONE: SyncRemovalResult = {
  runId: 'run-1',
  status: 'success',
  includeChanged: false,
  finishedAt: '2026-10-14T09:00:00.000Z',
  readWhole: ['Account'],
  filesForgotten: 1,
  objects: [
    {
      objectApiName: 'ContentDocument',
      planned: 1,
      deleted: 1,
      alreadyGone: 0,
      keptChanged: 0,
      keptDependents: 0,
      refused: 0,
      heldBy: [],
      unchecked: [],
      reasons: [],
    },
    {
      objectApiName: 'Account',
      planned: 2,
      deleted: 2,
      alreadyGone: 0,
      keptChanged: 0,
      keptDependents: 0,
      refused: 0,
      heldBy: [],
      unchecked: [],
      reasons: [],
    },
  ],
};

/** Every message of `type` the card sent through the bridge. */
function sentAll(type: string): Array<BaseMessage & { payload: Record<string, unknown> }> {
  return mockPostMessage.mock.calls
    .map(
      (call) =>
        (call[0] as { payload: BaseMessage & { payload: Record<string, unknown> } }).payload,
    )
    .filter((message) => message.type === type);
}

/** Answer the last `requestType` the card sent, correlated to it as the extension does. */
function answer(requestType: string, type: string, payload: unknown): void {
  const request = sentAll(requestType).pop();
  if (!request) throw new Error(`no '${requestType}' was sent`);
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          id: `resp-${type}`,
          type,
          timestamp: Date.now(),
          correlationId: request.id,
          payload,
        },
      }),
    );
  });
}

function confirmRemoval(options: { includeChanged?: boolean } = {}): void {
  fireEvent.click(screen.getByTestId('sync-removal-remove'));
  if (options.includeChanged) fireEvent.click(screen.getByTestId('sync-removal-include-changed'));
  fireEvent.change(screen.getByTestId('danger-input'), { target: { value: DEV.alias } });
  fireEvent.click(screen.getByTestId('danger-confirm-btn'));
}

describe('SyncRunRemoval', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
    useOrgStore.setState({ orgs: [DEV] });
  });

  it('asks what the run kept, by its id, and says what it created and where', () => {
    render(<SyncRunRemoval runId="run-1" />);
    expect(sentAll('sync:removal:info').pop()?.payload).toEqual({ runId: 'run-1' });

    answer('sync:removal:info', 'sync:removal:info:response', { info: KEPT });

    expect(screen.getByTestId('sync-removal-created').textContent).toBe(
      '3 records and files created in DEV-SANDBOX',
    );
    expect(screen.getByTestId('sync-removal-remove').textContent).toBe(
      'Remove what this run created',
    );
  });

  it('names the org and what goes per object, files first, before anything leaves', () => {
    render(<SyncRunRemoval runId="run-1" />);
    answer('sync:removal:info', 'sync:removal:info:response', { info: KEPT });

    fireEvent.click(screen.getByTestId('sync-removal-remove'));

    expect(screen.getByTestId('danger-title').textContent).toBe(
      'Remove what this run created from DEV-SANDBOX',
    );
    expect(screen.getByRole('dialog').textContent).toContain(
      'The records it updated were in DEV-SANDBOX before and keep their new values.',
    );
    expect(
      within(screen.getByTestId('forge-removal-plan'))
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['ContentDocument: 1 file', 'Account: 2 records']);
    expect(sentAll('sync:remove')).toEqual([]);
  });

  it('sends the run, never its records, once the org name is typed, with the changed ones when ticked', () => {
    render(<SyncRunRemoval runId="run-1" />);
    answer('sync:removal:info', 'sync:removal:info:response', { info: KEPT });

    confirmRemoval({ includeChanged: true });

    expect(sentAll('sync:remove').pop()?.payload).toEqual({ runId: 'run-1', includeChanged: true });
  });

  it('lists what a sweep would take once asked, sends the removal with it, and says what it swept', () => {
    render(<SyncRunRemoval runId="run-1" />);
    answer('sync:removal:info', 'sync:removal:info:response', { info: KEPT });

    fireEvent.click(screen.getByTestId('sync-removal-remove'));
    // Nothing is read of the org until the sweep is ticked.
    expect(sentAll('sync:remove:sweep')).toEqual([]);
    fireEvent.click(screen.getByTestId('sync-removal-sweep-toggle'));
    expect(sentAll('sync:remove:sweep').pop()?.payload).toEqual({ runId: 'run-1' });
    expect(screen.getByTestId('sync-sweep-loading')).toBeTruthy();
    answer('sync:remove:sweep', 'sync:remove:sweep:response', {
      runId: 'run-1',
      listing: {
        looked: ['Account', 'Task'],
        found: [{ objectApiName: 'Task', count: 2, names: ['Follow up'] }],
        unread: [],
        handWork: [],
        window: { from: '2026-10-14T07:59:59Z', to: '2026-10-14T08:02:00Z' },
      },
    });
    expect(screen.getByTestId('sync-removal-sweep').textContent).toContain('Follow up');

    fireEvent.change(screen.getByTestId('danger-input'), { target: { value: DEV.alias } });
    fireEvent.click(screen.getByTestId('danger-confirm-btn'));
    expect(sentAll('sync:remove').pop()?.payload).toEqual({ runId: 'run-1', sweep: true });

    answer('sync:remove', 'sync:remove:response', {
      result: {
        ...DONE,
        sweep: {
          status: 'success',
          objects: [
            {
              objectApiName: 'Task',
              found: 2,
              deleted: 2,
              alreadyGone: 0,
              keptChanged: 0,
              refused: 0,
              reasons: [],
            },
          ],
          unread: [],
          handWork: [],
        },
      },
      operationId: 'req-1',
    });
    expect(screen.getByTestId('forge-sweep-result')).toBeTruthy();
  });

  it('sends no sweep unless it is ticked, and reads nothing of the org for one', () => {
    render(<SyncRunRemoval runId="run-1" />);
    answer('sync:removal:info', 'sync:removal:info:response', { info: KEPT });

    confirmRemoval();

    expect(sentAll('sync:remove:sweep')).toEqual([]);
    expect(sentAll('sync:remove').pop()?.payload).toEqual({ runId: 'run-1' });
  });

  it('shows what the removal did, what the configuration forgets, and reads the run again', () => {
    render(<SyncRunRemoval runId="run-1" />);
    answer('sync:removal:info', 'sync:removal:info:response', { info: KEPT });
    confirmRemoval();
    const asked = sentAll('sync:removal:info').length;

    answer('sync:remove', 'sync:remove:response', { result: DONE, operationId: 'req-1' });

    expect(
      within(screen.getByTestId('forge-removal-result')).getByRole('heading').textContent,
    ).toBe('No record this run created is left in DEV-SANDBOX.');
    expect(screen.getByTestId('sync-removal-read-whole').textContent).toBe(
      'The next run of Accounts reads Account whole: the copies its watermark counted on are gone.',
    );
    expect(screen.getByTestId('sync-removal-files-forgotten').textContent).toBe(
      'Accounts no longer counts 1 file as copied: its next full read copies it again.',
    );
    expect(sentAll('sync:removal:info').length).toBe(asked + 1);
  });

  it('offers a Cancel while the removal runs, sent to the registry under the request id', () => {
    render(<SyncRunRemoval runId="run-1" />);
    answer('sync:removal:info', 'sync:removal:info:response', { info: KEPT });
    confirmRemoval();

    fireEvent.click(screen.getByTestId('sync-removal-cancel'));

    expect(sentAll('execution:abort').pop()?.payload).toEqual({
      operationId: sentAll('sync:remove').pop()?.id,
    });
    expect(screen.getByTestId('sync-removal-removing').textContent).toContain('Stopping');
  });

  it('offers nothing where Production Guard allows no delete, and says why with its reason', () => {
    render(<SyncRunRemoval runId="run-1" />);

    answer('sync:removal:info', 'sync:removal:info:response', {
      info: {
        ...KEPT,
        refusal: {
          code: 'GUARD_BLOCKED',
          message: 'delete is not allowed on production org org-dev',
        },
      },
    });

    expect(screen.queryByTestId('sync-removal-remove')).toBeNull();
    expect(screen.getByTestId('sync-removal-refused').textContent).toContain(
      'Production Guard allows no delete in DEV-SANDBOX, a production org: what this run created stays there.',
    );
    expect(screen.getByTestId('sync-removal-refused').textContent).toContain(
      'delete is not allowed on production org org-dev',
    );
  });

  it('offers what is left after a removal that left some, with its mark', () => {
    render(<SyncRunRemoval runId="run-1" />);

    answer('sync:removal:info', 'sync:removal:info:response', {
      info: {
        ...KEPT,
        left: [{ objectApiName: 'Account', count: 1 }],
        removed: {
          removedAt: '2026-10-14T09:00:00.000Z',
          deleted: 2,
          alreadyGone: 0,
          kept: 1,
          refused: 0,
        },
      },
    });

    expect(screen.getByTestId('forge-removal-mark').textContent).toContain('2 deleted');
    expect(screen.getByTestId('sync-removal-remove').textContent).toBe(
      'Remove what is left of what this run created',
    );
  });

  it('says so when nothing the run created is kept any more', () => {
    render(<SyncRunRemoval runId="run-1" />);

    answer('sync:removal:info', 'sync:removal:info:response', { info: null });

    expect(screen.getByTestId('sync-removal-not-kept').textContent).toContain('is no longer kept');
  });

  describe('a run that wrote over records of the target', () => {
    /** An upsert that matched three accounts and created nothing. */
    const OVER: SyncRunRemovalInfo = {
      ...KEPT,
      created: 0,
      left: [],
      overwritten: 3,
      putBack: [{ objectApiName: 'Account', count: 3 }],
    };

    it('says what it wrote over, offers to give it back, and names what goes back before anything is written', () => {
      render(<SyncRunRemoval runId="run-1" />);
      answer('sync:removal:info', 'sync:removal:info:response', { info: OVER });

      expect(screen.queryByTestId('sync-removal-created')).toBeNull();
      expect(screen.getByTestId('sync-removal-overwritten').textContent).toBe(
        '3 records of DEV-SANDBOX written over, their values from before kept on this machine',
      );
      // A run that created nothing: what it wrote over is what it gives back.
      expect(screen.getByRole('heading', { level: 5 }).textContent).toBe(
        'What this run wrote over',
      );
      expect(screen.getByTestId('sync-removal-remove').textContent).toBe(
        'Give back what this run wrote over',
      );
      fireEvent.click(screen.getByTestId('sync-removal-remove'));

      expect(screen.getByTestId('danger-title').textContent).toBe(
        'Give back what this run wrote over in DEV-SANDBOX',
      );
      expect(screen.getByRole('dialog').textContent).toContain(
        'Gives the records this run wrote over in DEV-SANDBOX',
      );
      expect(screen.getByRole('dialog').textContent).toContain(
        'It created nothing, and nothing is deleted.',
      );
      expect(screen.getByRole('dialog').textContent).not.toContain('keep their new values');
      expect(screen.getByTestId('sync-removal-put-back-Account').textContent).toBe(
        'Account: 3 records to be given back their values from before the run',
      );
      expect(screen.queryByTestId('forge-removal-plan')).toBeNull();
    });

    it('shows what the removal gave back, and what it left with why', () => {
      render(<SyncRunRemoval runId="run-1" />);
      answer('sync:removal:info', 'sync:removal:info:response', { info: OVER });
      confirmRemoval();

      answer('sync:remove', 'sync:remove:response', {
        result: {
          runId: 'run-1',
          status: 'partial',
          includeChanged: false,
          finishedAt: '2026-10-14T09:00:00.000Z',
          objects: [],
          restored: [
            {
              objectApiName: 'Account',
              planned: 3,
              restored: 2,
              keptChanged: 1,
              alreadyGone: 0,
              refused: 0,
              notKept: 0,
              reasons: [],
            },
          ],
        },
        operationId: 'req-1',
      });

      // Nothing deleted, nothing said of deletes.
      expect(screen.queryByTestId('forge-removal-result')).toBeNull();
      expect(screen.getByTestId('sync-removal-restored-Account').textContent).toBe(
        'Account: 2 of 3 given back their values from before the run · changed since the run, ' +
          'left as they are: 1',
      );
    });

    it('says what it gave back but for the fields the org no longer takes, and names them', () => {
      render(<SyncRunRemoval runId="run-1" />);
      answer('sync:removal:info', 'sync:removal:info:response', { info: OVER });
      confirmRemoval();

      answer('sync:remove', 'sync:remove:response', {
        result: {
          runId: 'run-1',
          status: 'partial',
          includeChanged: false,
          finishedAt: '2026-10-14T09:00:00.000Z',
          objects: [],
          restored: [
            {
              objectApiName: 'Account',
              planned: 3,
              restored: 2,
              restoredWithout: 1,
              keptChanged: 0,
              alreadyGone: 0,
              refused: 0,
              notKept: 0,
              reasons: ['Account.Industry: the value from before is no longer taken'],
            },
          ],
        },
        operationId: 'req-1',
      });

      expect(screen.getByTestId('sync-removal-restored-Account').textContent).toContain(
        "given back but for fields DEV-SANDBOX no longer takes, which keep the run's values: 1",
      );
      expect(screen.getByTestId('sync-removal-restored-Account').textContent).toContain(
        'Account.Industry: the value from before is no longer taken',
      );
    });

    it('says until when the values are kept, and that a backup gone gives back none of its records', () => {
      render(<SyncRunRemoval runId="run-1" />);
      answer('sync:removal:info', 'sync:removal:info:response', {
        info: {
          ...OVER,
          putBack: [{ objectApiName: 'Account', count: 2 }],
          putBackNotKept: 1,
          putBackKeptUntil: '2026-11-13T08:00:00.000Z',
        },
      });

      expect(screen.getByTestId('sync-removal-overwritten').textContent).toMatch(
        /kept on this machine · kept until 2026-11-13 \d\d:\d\d \(sandforge\.backup\.maxAgeDays\)$/,
      );
      expect(screen.getByTestId('sync-removal-put-back-not-kept').textContent).toBe(
        'Values from before no longer kept (past sandforge.backup.maxAgeDays, or deleted from ' +
          "the Restore tab): 1. Those records keep the run's values.",
      );
      fireEvent.click(screen.getByTestId('sync-removal-remove'));
      expect(screen.getByTestId('sync-removal-confirm-not-kept')).toBeTruthy();
    });

    it('offers nothing to give back once every backup of it is gone, and says the values are no longer kept', () => {
      render(<SyncRunRemoval runId="run-1" />);
      answer('sync:removal:info', 'sync:removal:info:response', {
        info: { ...OVER, putBack: undefined, putBackNotKept: 3 },
      });

      expect(screen.getByTestId('sync-removal-overwritten').textContent).toBe(
        '3 records of DEV-SANDBOX written over, their values from before no longer kept on this machine',
      );
      expect(screen.queryByTestId('sync-removal-remove')).toBeNull();
    });
  });

  describe('a run whose records a later run wrote again', () => {
    it('names the later run on the card and in the confirmation: remove it first', () => {
      render(<SyncRunRemoval runId="run-1" />);
      answer('sync:removal:info', 'sync:removal:info:response', {
        info: {
          ...KEPT,
          writtenAgain: [
            {
              runId: 'run-2',
              configName: 'Accounts nightly',
              startedAt: '2026-10-15T08:00:00.000Z',
              records: 2,
            },
          ],
        },
      });

      expect(screen.getByTestId('sync-removal-written-again').textContent).toMatch(
        /^2 records of this run were written again by Accounts nightly on 2026-10-15 \d\d:\d\d: remove that run first, or they read as changed since this one$/,
      );
      fireEvent.click(screen.getByTestId('sync-removal-remove'));
      expect(screen.getByTestId('sync-removal-confirm-written-again').textContent).toContain(
        'remove that run first',
      );
    });

    it('names a later Real-Time session as a session, which no configuration names', () => {
      render(<SyncRunRemoval runId="run-1" />);
      answer('sync:removal:info', 'sync:removal:info:response', {
        info: {
          ...KEPT,
          writtenAgain: [
            {
              runId: 'session-1',
              configName: '',
              startedAt: '2026-10-15T08:00:00.000Z',
              records: 1,
              realtime: true,
            },
          ],
        },
      });

      expect(screen.getByTestId('sync-removal-written-again').textContent).toMatch(
        /^1 record of this run was written again by a Real-Time session on 2026-10-15 \d\d:\d\d: remove that run first/,
      );
    });
  });

  describe('a delta run that deleted in the target what the source deleted', () => {
    const DELETED: SyncRunRemovalInfo = {
      ...KEPT,
      created: 0,
      left: [],
      deleted: 2,
      bringBack: [{ objectApiName: 'Contact', count: 2 }],
    };

    it('says what it deleted, and offers to bring it back from the recycle bin', () => {
      render(<SyncRunRemoval runId="run-1" />);
      answer('sync:removal:info', 'sync:removal:info:response', { info: DELETED });

      expect(screen.queryByTestId('sync-removal-created')).toBeNull();
      expect(screen.getByTestId('sync-removal-deleted').textContent).toBe(
        '2 records of DEV-SANDBOX deleted by the run, as the source had deleted them: its ' +
          'removal brings them back from the recycle bin while they are there',
      );
      expect(screen.getByTestId('sync-removal-remove').textContent).toBe(
        'Bring back what this run deleted',
      );
      fireEvent.click(screen.getByTestId('sync-removal-remove'));
      expect(screen.getByRole('dialog').textContent).toContain(
        'Brings back from the recycle bin of DEV-SANDBOX the records this run deleted',
      );
      expect(screen.getByTestId('sync-removal-bring-back-Contact').textContent).toBe(
        'Contact: 2 records to be brought back from the recycle bin',
      );
    });

    it('shows what the removal brought back, and what stays deleted with why', () => {
      render(<SyncRunRemoval runId="run-1" />);
      answer('sync:removal:info', 'sync:removal:info:response', { info: DELETED });
      confirmRemoval();

      answer('sync:remove', 'sync:remove:response', {
        result: {
          runId: 'run-1',
          status: 'partial',
          includeChanged: false,
          finishedAt: '2026-10-14T09:00:00.000Z',
          objects: [],
          undeleted: [
            {
              objectApiName: 'Contact',
              planned: 2,
              undeleted: 1,
              alreadyBack: 0,
              goneForGood: 1,
              refused: 0,
              reasons: [],
            },
          ],
        },
        operationId: 'req-1',
      });

      expect(screen.queryByTestId('forge-removal-result')).toBeNull();
      expect(screen.getByTestId('sync-removal-undeleted-Contact').textContent).toBe(
        'Contact: 1 of 2 brought back from the recycle bin · no longer in the recycle bin, ' +
          'gone for good: 1',
      );
    });
  });

  it('says every count a removal left of what it brought back and gave back, brought back first, each part under its heading', () => {
    render(<SyncRunRemoval runId="run-1" />);
    answer('sync:removal:info', 'sync:removal:info:response', {
      info: {
        ...KEPT,
        created: 0,
        left: [],
        overwritten: 2,
        deleted: 2,
        putBack: [{ objectApiName: 'Account', count: 2 }],
        bringBack: [{ objectApiName: 'Contact', count: 2 }],
      },
    });
    confirmRemoval();

    answer('sync:remove', 'sync:remove:response', {
      result: {
        runId: 'run-1',
        status: 'partial',
        includeChanged: false,
        finishedAt: '2026-10-14T09:00:00.000Z',
        objects: [],
        undeleted: [
          {
            objectApiName: 'Contact',
            planned: 1234,
            undeleted: 1000,
            alreadyBack: 1,
            goneForGood: 2,
            refused: 3,
            notReached: 4,
            reasons: ['DUPLICATE_VALUE: a contact holds this external id'],
          },
          {
            objectApiName: 'Case',
            planned: 1,
            undeleted: 1,
            alreadyBack: 0,
            goneForGood: 0,
            refused: 0,
            reasons: [],
          },
        ],
        restored: [
          {
            objectApiName: 'Account',
            planned: 4321,
            restored: 2000,
            keptChanged: 1,
            alreadyGone: 2,
            refused: 3,
            notKept: 4,
            notReached: 5,
            restoredWithout: 6,
            reasons: ['Account.OwnerId: the owner is inactive'],
          },
        ],
      },
      operationId: 'req-1',
    });

    const undeleted = screen.getByRole('region', { name: 'What this run deleted in DEV-SANDBOX' });
    const restored = screen.getByRole('region', {
      name: 'What this run wrote over in DEV-SANDBOX',
    });
    expect(undeleted).toBe(screen.getByTestId('sync-removal-undeleted'));
    expect(restored).toBe(screen.getByTestId('sync-removal-restored'));
    expect(within(undeleted).getByRole('heading', { level: 4 }).textContent).toBe(
      'What this run deleted in DEV-SANDBOX',
    );
    expect(
      undeleted.compareDocumentPosition(restored) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByTestId('sync-removal-undeleted-Contact').textContent).toBe(
      'Contact: 1,000 of 1,234 brought back from the recycle bin · back in DEV-SANDBOX already: 1' +
        ' · no longer in the recycle bin, gone for good: 2 · refused by DEV-SANDBOX: 3' +
        ' · not reached before the stop: 4' +
        'DUPLICATE_VALUE: a contact holds this external id',
    );
    // An object that left nothing says its count alone, with no list of reasons.
    expect(screen.getByTestId('sync-removal-undeleted-Case').textContent).toBe(
      'Case: 1 of 1 brought back from the recycle bin',
    );
    expect(
      within(screen.getByTestId('sync-removal-undeleted-Case')).queryByRole('list'),
    ).toBeNull();
    expect(screen.getByTestId('sync-removal-restored-Account').textContent).toBe(
      'Account: 2,000 of 4,321 given back their values from before the run' +
        ' · changed since the run, left as they are: 1 · no longer in DEV-SANDBOX: 2' +
        ' · refused by DEV-SANDBOX: 3 · values from before no longer kept (their backup was' +
        ' deleted from the Restore tab, or reached its retention): 4' +
        ' · not reached before the stop: 5' +
        " · given back but for fields DEV-SANDBOX no longer takes, which keep the run's values: 6" +
        'Account.OwnerId: the owner is inactive',
    );
  });

  it('keeps "keep their new values" off a run whose values an earlier removal gave back', () => {
    render(<SyncRunRemoval runId="run-1" />);
    answer('sync:removal:info', 'sync:removal:info:response', {
      info: { ...KEPT, overwritten: 2 },
    });

    fireEvent.click(screen.getByTestId('sync-removal-remove'));

    expect(screen.getByRole('dialog').textContent).not.toContain('keep their new values');
    expect(screen.getByRole('dialog').textContent).toContain(
      'Nothing it wrote over is given back now',
    );
  });

  describe('what the target runs as the run is taken back', () => {
    /**
     * A run that created accounts, wrote over contacts and deleted cases: a
     * trigger after a case's undelete, a flow on a contact's update, a
     * trigger before an account's delete, and a flow on an account's update
     * that no step of the removal makes.
     */
    const AUTOMATION: ForgeTargetAutomation = {
      objectsRead: ['Case', 'Contact', 'Account'],
      objects: [
        {
          objectApiName: 'Case',
          flows: [],
          triggers: [{ name: 'CaseRestore', events: ['afterUndelete'] }],
        },
        {
          objectApiName: 'Contact',
          flows: [
            {
              apiName: 'Contact_Audit',
              label: 'Contact audit',
              timing: 'afterSave',
              startsOn: 'update',
              condition: 'read',
              permissions: [],
            },
          ],
          triggers: [],
        },
        {
          objectApiName: 'Account',
          flows: [
            {
              apiName: 'Account_Update',
              label: 'Account update',
              timing: 'afterSave',
              startsOn: 'update',
              condition: 'read',
              permissions: [],
            },
          ],
          triggers: [{ name: 'AccountGuard', events: ['beforeDelete'] }],
        },
      ],
      unread: [],
      conditionsNotRead: 0,
      conditionsBound: 25,
      requests: 6,
    };
    const STEPS = {
      bringBack: ['Case'],
      giveBack: ['Contact'],
      setToDraft: [],
      delete: ['ContentDocument', 'Account'],
    };

    it('asks for it by the run alone as the confirmation opens, and lists it step by step before the org name is typed', () => {
      render(<SyncRunRemoval runId="run-1" />);
      answer('sync:removal:info', 'sync:removal:info:response', { info: KEPT });
      expect(sentAll('sync:remove:automation')).toEqual([]);

      fireEvent.click(screen.getByTestId('sync-removal-remove'));

      expect(sentAll('sync:remove:automation').pop()?.payload).toEqual({ runId: 'run-1' });
      expect(screen.getByTestId('sync-removal-automation-loading').textContent).toBe(
        'Reading what DEV-SANDBOX runs as this run is taken back…',
      );
      answer('sync:remove:automation', 'sync:remove:automation:response', {
        runId: 'run-1',
        automation: AUTOMATION,
        steps: STEPS,
      });

      const section = screen.getByTestId('sync-removal-automation');
      expect(within(section).getByRole('heading').textContent).toBe(
        'What DEV-SANDBOX runs as this run is taken back',
      );
      expect(
        within(section)
          .getAllByRole('listitem')
          .map((item) => item.textContent),
      ).toEqual([
        'Case: Apex trigger: CaseRestore · after undelete, as the removal brings it back from the recycle bin',
        'Contact: Flow: Contact audit · as the removal gives it back its values from before the run',
        'Account: Apex trigger: AccountGuard · before delete',
      ]);
      expect(screen.getByTestId('sync-removal-automation-bringBack-Case')).toBeTruthy();
      expect(sentAll('sync:remove')).toEqual([]);
    });

    it('says nothing fires when nothing does', () => {
      render(<SyncRunRemoval runId="run-1" />);
      answer('sync:removal:info', 'sync:removal:info:response', { info: KEPT });
      fireEvent.click(screen.getByTestId('sync-removal-remove'));

      answer('sync:remove:automation', 'sync:remove:automation:response', {
        runId: 'run-1',
        automation: { ...AUTOMATION, objects: [] },
        steps: STEPS,
      });

      expect(screen.getByTestId('sync-removal-automation-none').textContent).toBe(
        'Nothing DEV-SANDBOX automates runs as this run is taken back.',
      );
    });

    it('says the read failed, and reads again when asked', () => {
      render(<SyncRunRemoval runId="run-1" />);
      answer('sync:removal:info', 'sync:removal:info:response', { info: KEPT });
      fireEvent.click(screen.getByTestId('sync-removal-remove'));

      answer('sync:remove:automation', 'sync:remove:automation:error', {
        message: 'INVALID_SESSION_ID',
        code: 'AUTOMATION_ERROR',
        retryable: true,
      });

      expect(screen.getByTestId('sync-removal-automation-error').textContent).toBe(
        'What DEV-SANDBOX runs as this run is taken back could not be read: INVALID_SESSION_ID',
      );
      const asked = sentAll('sync:remove:automation').length;
      fireEvent.click(screen.getByTestId('sync-removal-automation-read-again'));
      expect(sentAll('sync:remove:automation')).toHaveLength(asked + 1);
    });
  });

  it('says which encrypted fields it could not keep, read masked', () => {
    render(<SyncRunRemoval runId="run-1" />);
    answer('sync:removal:info', 'sync:removal:info:response', {
      info: { ...KEPT, notKeptEncrypted: ['Contact.Tax__c'] },
    });

    expect(screen.getByTestId('sync-removal-not-kept-encrypted').textContent).toBe(
      "Not kept, encrypted: Contact.Tax__c. The run's user cannot view encrypted data, and read " +
        'their values from before masked: a removal leaves them as the run wrote them.',
    );
  });
});
