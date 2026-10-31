import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, within } from '@testing-library/react';
import '../../i18n';
import type { FrozenLoadPlanInfo, FrozenLoadReportInfo, FrozenStatusInfo } from '@sandforge/shared';
import { FrozenLoadTab } from './FrozenLoadTab';
import { useFrozenStore } from '../../stores/useFrozenStore';
import { useNotificationStore } from '../../stores/useNotificationStore';
import { WRITE_RUN_TIMEOUT_MS } from '../../hooks/writeRunTimeout';

const ORGS = [
  { id: 'org-dev', alias: 'DEV-SANDBOX', status: 'connected' },
  { id: 'org-qa', alias: 'QA-SANDBOX', status: 'connected' },
];

vi.mock('../../stores/useOrgStore', () => ({
  useOrgStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ orgs: ORGS, selectedOrgId: 'org-dev' }),
}));

/** What each bridge request answers, by its type, as the tab reads it. */
interface Answer {
  data?: unknown;
  loading?: boolean;
  error?: string | null;
  requestId?: string | null;
}
const answers: Record<string, Answer> = {};
const mutate = vi.fn();
/** The options each request was asked with, by its type. */
const askedWith: Record<string, unknown> = {};

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (requestType: string, options?: unknown) => ({
    ...((askedWith[requestType] = options), {}),
    mutate: (payload?: Record<string, unknown>) => mutate(requestType, payload),
    data: answers[requestType]?.data ?? null,
    loading: answers[requestType]?.loading ?? false,
    error: answers[requestType]?.error ?? null,
    requestId: answers[requestType]?.requestId ?? null,
    reset: vi.fn(),
  }),
}));

/** A load recorded in `orgId`, as `frozen:status` counts it. */
function loadInto(orgId: string, loadedAt: string, accounts: number) {
  return {
    orgId,
    loadedAt,
    created: [{ objectApiName: 'Account', count: accounts }],
    linked: 0,
    recorded: true,
  };
}

const STATUS: FrozenStatusInfo = {
  configured: true,
  sasDir: '/sas',
  datasetDir: '/sas/dataset',
  salt: { present: true, fingerprint: 'abc123def456' },
  mockDetectionConfigured: true,
  selection: null,
  manifest: {
    version: '1.0.0',
    status: 'frozen',
    frozenAt: '2026-09-24T09:00:00.000Z',
    source: { orgId: 'org-src', decisionDate: '2026-09-24' },
    saltFingerprint: 'abc123def456',
    rulesVersion: '1.0.0',
    volumetry: { budgetMax: 100, measured: { Account: 3 }, measuredAt: '2026-09-24' },
    controls: {
      nonReidentification: { passed: true, checks: [], author: 'qa', checkedAt: '2026-09-24' },
      dryRunLoad: null,
      author: 'qa',
      date: '2026-09-24',
    },
  },
  lastLoad: null,
  lastLoads: [],
  lastVerifies: [],
  loadRecords: [
    loadInto('org-dev', '2026-09-24T10:05:00.000Z', 1),
    loadInto('org-qa', '2026-09-24T11:05:00.000Z', 4),
  ],
};

const PLAN: FrozenLoadPlanInfo = {
  orgId: 'org-dev',
  mode: { pilot: false, reload: true },
  plannedAt: '2026-10-09T10:00:00.000Z',
  perObject: [
    {
      objectApiName: 'Account',
      fromFiles: 3,
      toInsert: 1,
      reusedByKeys: 2,
      reusedFromCatalog: 0,
      fieldsDropped: 1,
      picklistsRewritten: 0,
      notSent: 0,
      toPurge: 5,
      toDeactivate: 0,
    },
    {
      objectApiName: 'Pricebook2',
      fromFiles: 1,
      toInsert: 0,
      reusedByKeys: 0,
      reusedFromCatalog: 1,
      fieldsDropped: 0,
      picklistsRewritten: 3,
      notSent: 0,
      toPurge: 0,
      toDeactivate: 0,
    },
  ],
  excludedObjects: [],
  removals: [],
  placeholders: [
    {
      objectApiName: 'Contact',
      field: 'Owner__c',
      placeholderObjectApiName: 'Owner__c',
      placeholderName: 'PLACEHOLDER',
      affectedRecords: 2,
    },
  ],
  requiredDefaults: [],
  recordTypeIssues: 0,
  personContacts: 0,
  earlierLoads: 2,
};

const tab = () => <FrozenLoadTab onRefetchStatus={vi.fn()} />;

/** The cells of each row of the preview table, the header row first. */
function previewRows(): string[][] {
  return within(screen.getByTestId('frozen-preview'))
    .getAllByRole('row')
    .map((row) =>
      Array.from(row.querySelectorAll('th, td')).map((cell) => cell.textContent?.trim() ?? ''),
    );
}

describe('FrozenLoadTab', () => {
  beforeEach(() => {
    for (const key of Object.keys(answers)) delete answers[key];
    mutate.mockReset();
    useNotificationStore.setState({ notifications: [] });
    // A target picked: the tab offers none until one is (see "the target").
    useFrozenStore.setState({
      status: STATUS,
      targetOrgId: 'org-dev',
      progress: [],
      loadReport: null,
      verdict: null,
      lastError: null,
    });
  });

  it('lists the guards a load meets in plain words, without the salt, which only an extraction needs', () => {
    render(tab());

    const guards = screen.getByTestId('frozen-guards').textContent ?? '';
    expect(guards).toContain('Never a production org');
    expect(guards).toContain('Checks the target mocks its callouts');
    expect(guards).not.toMatch(/salt/i);
    expect(guards).not.toContain('Sandbox only');
  });

  describe('the last load, and taking it back', () => {
    // One mapping per sas, a load into a second org replaced the first org's,
    // and the card offered only the load the sas held last.
    it('shows the load into the selected target', () => {
      render(tab());

      expect(screen.getByTestId('frozen-removal-loaded').textContent).toContain('DEV-SANDBOX');
    });

    it('shows the load into another target once it is selected, and removes that one', () => {
      render(tab());

      fireEvent.click(screen.getByTestId('frozen-load-target'));
      fireEvent.click(screen.getByTestId('frozen-load-target-option-org-qa'));

      expect(screen.getByTestId('frozen-removal-loaded').textContent).toContain('QA-SANDBOX');
      fireEvent.click(screen.getByTestId('frozen-removal-remove'));
      fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'QA-SANDBOX' } });
      fireEvent.click(screen.getByTestId('danger-confirm-btn'));
      expect(mutate).toHaveBeenCalledWith('frozen:remove', {
        targetOrgId: 'org-qa',
        loadedAt: '2026-09-24T11:05:00.000Z',
      });
    });

    it('shows no load for a target none went into', () => {
      useFrozenStore.setState({
        status: { ...STATUS, loadRecords: [loadInto('org-qa', '2026-09-24T11:05:00.000Z', 4)] },
      });

      render(tab());

      expect(screen.queryByTestId('frozen-removal')).toBeNull();
    });
  });

  describe('cancelling the load it started', () => {
    it('waits on a load as long as any write run, and never offers to try it again', () => {
      render(tab());

      expect(askedWith['frozen:load']).toMatchObject({
        timeoutMs: WRITE_RUN_TIMEOUT_MS,
        runOutlivesWait: true,
      });
    });

    it('offers no cancel while no load runs', () => {
      render(tab());

      expect(screen.queryByTestId('frozen-load-cancel')).toBeNull();
    });

    it('sends execution:abort with the id of the load, and is not offered twice', () => {
      answers['frozen:load'] = { loading: true, requestId: 'req-load-7' };
      render(tab());

      fireEvent.click(screen.getByTestId('frozen-load-cancel'));

      expect(mutate).toHaveBeenCalledWith('execution:abort', { operationId: 'req-load-7' });
      expect(screen.getByTestId('frozen-load-cancel').getAttribute('aria-disabled')).toBe('true');
      expect(screen.getByTestId('frozen-load-stopping').textContent).toContain('next write');
      fireEvent.click(screen.getByTestId('frozen-load-cancel'));
      expect(mutate.mock.calls.filter(([type]) => type === 'execution:abort')).toHaveLength(1);
    });

    it('says so when the extension refuses the cancel, and offers it again', () => {
      answers['frozen:load'] = { loading: true, requestId: 'req-load-7' };
      const { rerender } = render(tab());
      fireEvent.click(screen.getByTestId('frozen-load-cancel'));

      answers['execution:abort'] = { data: { success: false, error: 'Operation not found' } };
      rerender(tab());

      expect(useNotificationStore.getState().notifications).toEqual([
        expect.objectContaining({ level: 'warning', title: 'Could not cancel the load' }),
      ]);
      expect(screen.getByTestId('frozen-load-cancel').getAttribute('aria-disabled')).toBeNull();
    });
  });

  describe('a dataset that does not say it left out the encrypted fields it read masked', () => {
    const WITH_COVERAGE = (encryptedNotKept?: string[]): FrozenStatusInfo => ({
      ...STATUS,
      manifest: STATUS.manifest && {
        ...STATUS.manifest,
        coverage: {
          objects: 2,
          truncated: false,
          maxNodes: 50,
          unboundedObjects: [],
          filesLeftOut: [],
          ...(encryptedNotKept ? { encryptedNotKept } : {}),
        },
      },
    });

    it('offers to write the fields the target encrypts as the dataset holds them, and asks the load and its preview to once ticked', () => {
      useFrozenStore.setState({ status: WITH_COVERAGE() });
      render(tab());

      fireEvent.click(screen.getByTestId('frozen-load-preview'));
      fireEvent.click(screen.getByTestId('frozen-load-write-encrypted'));
      fireEvent.click(screen.getByTestId('frozen-load-preview'));
      fireEvent.click(screen.getByTestId('frozen-load-run'));

      expect(mutate.mock.calls).toEqual([
        ['frozen:load:preview', { targetOrgId: 'org-dev' }],
        ['frozen:load:preview', { targetOrgId: 'org-dev', writeEncrypted: true }],
        ['frozen:load', { targetOrgId: 'org-dev', writeEncrypted: true }],
      ]);
      expect(screen.getByText(/may hold masks such as \*\*\*\*1234/)).toBeDefined();
    });

    it('offers beside Load the box that mutes the target’s automation, and asks the load alone to once ticked', () => {
      useFrozenStore.setState({ status: WITH_COVERAGE([]) });
      render(tab());
      expect((screen.getByTestId('frozen-load-mute-toggle') as HTMLInputElement).checked).toBe(
        false,
      );
      fireEvent.click(screen.getByTestId('frozen-load-run'));

      fireEvent.click(screen.getByTestId('frozen-load-mute-toggle'));
      fireEvent.click(screen.getByTestId('frozen-load-preview'));
      fireEvent.click(screen.getByTestId('frozen-load-run'));

      expect(mutate.mock.calls).toEqual([
        ['frozen:load', { targetOrgId: 'org-dev' }],
        // Its preview writes nothing, and mutes nothing.
        ['frozen:load:preview', { targetOrgId: 'org-dev' }],
        ['frozen:load', { targetOrgId: 'org-dev', muteAutomation: true }],
      ]);
    });

    it('offers nothing of it for a dataset that says which encrypted fields it left out, none or some', () => {
      for (const encryptedNotKept of [[], ['Contact.SSN__c']]) {
        useFrozenStore.setState({ status: WITH_COVERAGE(encryptedNotKept) });
        const { unmount } = render(tab());

        expect(screen.queryByTestId('frozen-load-write-encrypted')).toBeNull();
        unmount();
      }
    });

    it('names, in the preview and in the report, the fields it leaves out as they may hold masks', () => {
      const masked = {
        objectApiName: 'Contact',
        field: 'SSN__c',
        reason: 'may-hold-masks' as const,
        affectedRecords: 2,
      };
      answers['frozen:load:preview'] = { data: { plan: { ...PLAN, removals: [masked] } } };
      const report: FrozenLoadReportInfo = {
        status: 'completed',
        orgId: 'org-dev',
        mode: { pilot: false, reload: false },
        startedAt: '2026-10-09T10:00:00.000Z',
        durationMs: 10,
        alignment: {
          excludedObjects: [],
          removals: [masked],
          adjustments: [],
          recordTypeIssues: [],
        },
        placeholders: [],
        requiredDefaults: [],
        perObject: [],
        pass2: { resolved: 0, unresolved: [] },
        personContact: { restored: 0, unresolved: [] },
        purge: { deleted: {}, deactivated: {}, failures: [] },
        mappingPath: '',
        contractPath: '',
      };
      useFrozenStore.setState({ loadReport: report });

      render(tab());

      for (const testId of ['frozen-preview-may-hold-masks', 'frozen-report-may-hold-masks']) {
        expect(screen.getByTestId(testId).textContent).toContain(
          'Left out, encrypted in this org: Contact.SSN__c (2).',
        );
      }
      // Not asked to mute, the report says nothing of it.
      expect(screen.queryByTestId('frozen-load-report-muted')).toBeNull();
    });

    it('says in the report what the load muted of the target’s automation', () => {
      useFrozenStore.setState({
        loadReport: {
          status: 'completed',
          orgId: 'org-dev',
          mode: { pilot: false, reload: false },
          startedAt: '2026-10-09T10:00:00.000Z',
          durationMs: 10,
          alignment: { excludedObjects: [], removals: [], adjustments: [], recordTypeIssues: [] },
          placeholders: [],
          requiredDefaults: [],
          perObject: [],
          pass2: { resolved: 0, unresolved: [] },
          personContact: { restored: 0, unresolved: [] },
          purge: { deleted: {}, deactivated: {}, failures: [] },
          mappingPath: '',
          contractPath: '',
          mutedAutomation: {
            state: 'muted',
            assigned: ['Data_Load'],
            held: [],
            permissions: ['Load_Data'],
            silenced: [],
            stillRan: [],
            released: false,
          },
        },
      });
      render(tab());

      expect(screen.getByTestId('frozen-load-report-muted-said').textContent).toMatch(
        /^Data_Load was assigned to the user the run wrote as in /,
      );
      expect(screen.getByTestId('frozen-load-report-muted-not-released')).toBeDefined();
    });
  });

  describe('previewing the load', () => {
    it('asks what a load with the options chosen would do', () => {
      render(tab());

      fireEvent.click(screen.getByTestId('frozen-load-reload'));
      fireEvent.click(screen.getByTestId('frozen-load-preview'));

      expect(mutate).toHaveBeenCalledWith('frozen:load:preview', {
        targetOrgId: 'org-dev',
        reload: true,
      });
      expect(mutate.mock.calls.map(([type]) => type)).not.toContain('frozen:load');
    });

    it('shows, per object, what the load would insert, link, drop, rewrite and purge', () => {
      answers['frozen:load:preview'] = { data: { plan: PLAN } };

      render(tab());

      expect(screen.getByTestId('frozen-preview').textContent).toContain(
        'What a load into DEV-SANDBOX would do',
      );
      expect(previewRows()).toEqual([
        [
          'Object',
          'In the dataset',
          'To insert',
          'Found by identity keys',
          'Found in the catalog',
          'Fields dropped',
          'Picklist values rewritten',
          'To purge',
          'To deactivate',
        ],
        ['Account', '3', '1', '2', '0', '1', '0', '5', '0'],
        ['Pricebook2', '1', '0', '0', '1', '0', '3', '0', '0'],
      ]);
      expect(screen.getByTestId('frozen-preview-reload').textContent).toContain('2 earlier loads');
      expect(screen.getByTestId('frozen-preview-placeholders').textContent).toContain(
        'Contact.Owner__c (2)',
      );
    });

    it('says which records the load would leave out for a parent excludedObjects leaves out', () => {
      answers['frozen:load:preview'] = {
        data: {
          plan: {
            ...PLAN,
            heldForExcludedParents: [
              { objectApiName: 'FeedComment', count: 4, note: '4 left out' },
            ],
          },
        },
      };

      render(tab());

      expect(screen.getByTestId('frozen-preview-held-for-excluded').textContent).toContain(
        'no placeholder is asked for it: FeedComment (4)',
      );
    });

    it("lists the target's validation rules on each object it would insert, with the field each names", () => {
      // Run on a client sandbox, three loads in a row were each refused by
      // the next rule of the accounts: listed in the preview, all show at once.
      answers['frozen:load:preview'] = {
        data: {
          plan: {
            ...PLAN,
            perObject: PLAN.perObject.map((o) =>
              o.objectApiName === 'Account'
                ? {
                    ...o,
                    validationRules: [
                      {
                        name: 'Trap_Country_Required',
                        message: 'A country is required.',
                        field: 'BillingCountry',
                      },
                      { name: 'Trap_Industry_Required', message: 'Pick an industry.' },
                    ],
                  }
                : o,
            ),
          },
        },
      };

      render(tab());

      const rules = screen.getByTestId('frozen-preview-rules-Account');
      expect(rules.textContent).toContain(
        'Account: 2 active validation rules of the target, which a preview cannot evaluate',
      );
      expect(
        within(rules)
          .getAllByRole('listitem')
          .map((item) => item.textContent),
      ).toEqual([
        'Trap_Country_Required (BillingCountry) — A country is required.',
        'Trap_Industry_Required — Pick an industry.',
      ]);
      expect(screen.queryByTestId('frozen-preview-rules-Pricebook2')).toBeNull();
      expect(screen.queryByTestId('frozen-preview-rules-unread')).toBeNull();
    });

    it('names the rules it leaves out of an insert, and lists those of an object that receives only a placeholder', () => {
      answers['frozen:load:preview'] = {
        data: {
          plan: {
            ...PLAN,
            perObject: PLAN.perObject.map((o) =>
              o.objectApiName === 'Account'
                ? { ...o, validationRulesOnChange: ['NoChangeFromStatusApproved', 'Locked'] }
                : o,
            ),
            placeholders: PLAN.placeholders.map((p) => ({
              ...p,
              validationRules: [
                { name: 'Code_Required', message: 'A code is required.', field: 'Code__c' },
              ],
            })),
          },
        },
      };

      render(tab());

      expect(screen.queryByTestId('frozen-preview-rules-Account')).toBeNull();
      expect(screen.getByTestId('frozen-preview-rules-on-change-Account').textContent).toBe(
        'Account: 2 rules left out — their formula holds only on a change of a record (ISCHANGED, PRIORVALUE, NOT(ISNEW())), which an insert never is: NoChangeFromStatusApproved, Locked',
      );
      const placeholder = PLAN.placeholders[0].placeholderObjectApiName;
      const rules = screen.getByTestId(`frozen-preview-placeholder-rules-${placeholder}`);
      expect(rules.textContent).toContain(
        `Placeholder of ${placeholder}: 1 active validation rule of the target, which a preview cannot evaluate — a placeholder it refuses stops the load.`,
      );
      expect(
        within(rules)
          .getAllByRole('listitem')
          .map((item) => item.textContent),
      ).toEqual(['Code_Required (Code__c) — A code is required.']);
    });

    it("says when the target's validation rules could not be listed", () => {
      answers['frozen:load:preview'] = {
        data: { plan: { ...PLAN, validationRulesUnread: 'INSUFFICIENT_ACCESS' } },
      };

      render(tab());

      expect(screen.getByTestId('frozen-preview-rules-unread').textContent).toBe(
        "The target's validation rules could not be listed (INSUFFICIENT_ACCESS): any of them may refuse a record counted to insert.",
      );
    });

    it('says which defaults give each record a value of its own, and what the purge keeps', () => {
      answers['frozen:load:preview'] = {
        data: {
          plan: {
            ...PLAN,
            requiredDefaults: [
              {
                objectApiName: 'ServiceTerritory',
                field: 'Name',
                affectedRecords: 2,
                perRecord: 'unique',
                example: 'Frozen territory 1',
              },
              { objectApiName: 'Account', field: 'Rating__c', affectedRecords: 1 },
            ],
            keptByThePlatform: { BusinessHours: 1 },
          },
        },
      };

      render(tab());

      const perRecord = screen.getByTestId('frozen-preview-defaults-per-record').textContent;
      expect(perRecord).toContain('ServiceTerritory.Name (“Frozen territory 1”…)');
      expect(perRecord).not.toContain('Rating__c');
      expect(screen.getByTestId('frozen-preview-kept-by-platform').textContent).toContain(
        'the platform does not delete these records',
      );
      expect(screen.getByTestId('frozen-preview-kept-by-platform').textContent).toContain(
        'BusinessHours (1)',
      );
    });

    it('leaves out the purge of a load that is not a reload', () => {
      answers['frozen:load:preview'] = {
        data: { plan: { ...PLAN, mode: { pilot: false, reload: false } } },
      };

      render(tab());

      expect(previewRows()[0]).not.toContain('To purge');
      expect(screen.queryByTestId('frozen-preview-reload')).toBeNull();
    });
  });

  describe('a reload refused for the records it would leave', () => {
    /** What the extension refuses the reload with, in its words. */
    const REFUSAL =
      'A removal of the loads this reload replaces would leave 1 of their records in the org — ' +
      'Account (1: 1 changed since the load): loaded again, the dataset would stand beside ' +
      'them, and the reload would delete what was changed since. Nothing was written. Take the ' +
      'load back first with a removal — records changed since go too when it is told to ' +
      'include them — then load the dataset again.';

    /** The extension's answer to the request `requestType` sent under `id`, on its error channel. */
    function refuse(requestType: string, id: string, code = 'REPLACE_LEAVES_RECORDS'): void {
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: {
              id: `err-${id}`,
              type: `${requestType}:error`,
              timestamp: Date.now(),
              correlationId: id,
              payload: { message: REFUSAL, code, retryable: false },
            },
          }),
        );
      });
    }

    it('says on the last load’s card what the reload would leave and why, in the extension’s words, and takes the load back first, the records changed since included, once the org’s name is typed', () => {
      answers['frozen:load'] = { requestId: 'req-load-1' };
      answers['frozen:load:preview'] = { data: { plan: PLAN }, requestId: 'req-preview-0' };
      render(tab());

      fireEvent.click(screen.getByTestId('frozen-load-reload'));
      fireEvent.click(screen.getByTestId('frozen-load-run'));
      // Asked first, with what the preview's plan purges; then sent.
      fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'DEV-SANDBOX' } });
      fireEvent.click(screen.getByTestId('danger-confirm-btn'));
      expect(mutate).toHaveBeenCalledWith('frozen:load', { targetOrgId: 'org-dev', reload: true });
      refuse('frozen:load', 'req-load-1');

      const card = screen.getByTestId('frozen-removal');
      const refused = within(card).getByTestId('frozen-reload-refused');
      expect(within(refused).getByRole('heading').textContent).toBe(
        'Reload refused: nothing was written to DEV-SANDBOX',
      );
      expect(within(refused).getByTestId('frozen-reload-refused-why').textContent).toBe(REFUSAL);
      expect(within(refused).getByTestId('frozen-reload-refused-way-out').textContent).toContain(
        'the ones changed since included',
      );
      // Said once, on the card: not in the banner above as well.
      expect(screen.queryByTestId('frozen-error')).toBeNull();

      fireEvent.click(screen.getByTestId('frozen-reload-take-back'));
      const dialog = screen.getByRole('dialog');
      expect(
        (within(dialog).getByTestId('frozen-removal-include-changed') as HTMLInputElement).checked,
      ).toBe(true);
      fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'DEV-SANDBOX' } });
      fireEvent.click(screen.getByTestId('danger-confirm-btn'));

      expect(mutate).toHaveBeenCalledWith('frozen:remove', {
        targetOrgId: 'org-dev',
        loadedAt: '2026-09-24T10:05:00.000Z',
        includeChanged: true,
      });
      expect(screen.queryByTestId('frozen-reload-refused')).toBeNull();
      // Taken back, nothing is loaded again until asked.
      expect(mutate.mock.calls.filter(([type]) => type === 'frozen:load')).toHaveLength(1);
    });

    it('is said the same way when a preview of the reload is refused, and cancelled leaves the org as it is', () => {
      answers['frozen:load:preview'] = { requestId: 'req-preview-1' };
      render(tab());

      fireEvent.click(screen.getByTestId('frozen-load-reload'));
      fireEvent.click(screen.getByTestId('frozen-load-preview'));
      refuse('frozen:load:preview', 'req-preview-1');
      expect(screen.getByTestId('frozen-reload-refused-why').textContent).toBe(REFUSAL);

      fireEvent.click(screen.getByTestId('frozen-reload-cancel'));

      expect(screen.queryByTestId('frozen-reload-refused')).toBeNull();
      expect(screen.queryByTestId('frozen-error')).toBeNull();
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(mutate.mock.calls.map(([type]) => type)).toEqual(['frozen:load:preview']);
    });

    it('offers only to cancel when the card cannot take the load back, and says why', () => {
      useFrozenStore.setState({
        status: {
          ...STATUS,
          loadRecords: [{ ...loadInto('org-dev', '2026-09-24T10:05:00.000Z', 1), recorded: false }],
        },
        lastError: {
          source: 'frozen:load',
          message: REFUSAL,
          code: 'REPLACE_LEAVES_RECORDS',
          retryable: false,
        },
      });
      render(tab());

      expect(screen.getByTestId('frozen-reload-refused-way-out').textContent).toContain(
        'cannot be taken back from here',
      );
      expect(screen.queryByTestId('frozen-reload-take-back')).toBeNull();
      expect(screen.getByTestId('frozen-removal-not-recorded')).toBeTruthy();
      expect(screen.getByTestId('frozen-reload-cancel')).toBeTruthy();
    });

    it('leaves the refusal behind once another org is picked, and says any other refusal of a load in the banner', () => {
      useFrozenStore.setState({
        lastError: {
          source: 'frozen:load',
          message: REFUSAL,
          code: 'REPLACE_LEAVES_RECORDS',
          retryable: false,
        },
      });
      const { unmount } = render(tab());
      expect(screen.getByTestId('frozen-reload-refused')).toBeTruthy();

      fireEvent.click(screen.getByTestId('frozen-load-target'));
      fireEvent.click(screen.getByTestId('frozen-load-target-option-org-qa'));

      expect(screen.queryByTestId('frozen-reload-refused')).toBeNull();
      expect(useFrozenStore.getState().lastError).toBeNull();
      unmount();

      useFrozenStore.setState({
        lastError: {
          source: 'frozen:load',
          message: 'No frozen dataset found',
          code: 'LOAD_ERROR',
          retryable: true,
        },
      });
      render(tab());
      expect(screen.getByTestId('frozen-error').textContent).toContain('No frozen dataset found');
      expect(screen.queryByTestId('frozen-reload-refused')).toBeNull();
    });
  });

  describe('the target', () => {
    /** The text of the element an `aria-describedby` names. */
    function describedBy(element: HTMLElement): string {
      return (element.getAttribute('aria-describedby') ?? '')
        .split(' ')
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ');
    }

    // It took the side panel's org: the org the Extract tab had just read,
    // so the first click of the tab was a load into the dataset's source.
    it('is none until one is picked, and Preview and Run load say so instead of running', () => {
      useFrozenStore.setState({ targetOrgId: '' });
      render(tab());

      expect(screen.getByTestId('frozen-load-target').textContent).toContain('Select an org');
      for (const id of ['frozen-load-preview', 'frozen-load-run']) {
        const button = screen.getByTestId(id);
        expect(button.getAttribute('aria-disabled')).toBe('true');
        expect(describedBy(button)).toBe('Pick the sandbox to fill.');
        fireEvent.click(button);
      }
      expect(mutate).not.toHaveBeenCalled();
      // The box names the org it would read: none yet.
      expect(screen.queryByTestId('frozen-load-mute')).toBeNull();
    });

    it("lists the dataset's source org without offering it, and says why beside it", () => {
      useFrozenStore.setState({
        targetOrgId: '',
        status: {
          ...STATUS,
          manifest: STATUS.manifest && {
            ...STATUS.manifest,
            source: { orgId: 'org-dev', decisionDate: '2026-09-24' },
          },
        },
      });
      render(tab());

      fireEvent.click(screen.getByTestId('frozen-load-target'));
      const source = screen.getByTestId('frozen-load-target-option-org-dev') as HTMLButtonElement;
      expect(source.disabled).toBe(true);
      expect(screen.getByTestId('frozen-load-target-option-org-dev-note').textContent).toBe(
        '(source of this dataset)',
      );
      fireEvent.click(source);
      expect(useFrozenStore.getState().targetOrgId).toBe('');

      fireEvent.click(screen.getByTestId('frozen-load-target-option-org-qa'));
      expect(useFrozenStore.getState().targetOrgId).toBe('org-qa');
      expect(screen.getByTestId('frozen-load-run').getAttribute('aria-disabled')).toBeNull();
    });

    it('says the target is the source when one picked before is, and runs nothing into it', () => {
      useFrozenStore.setState({
        targetOrgId: 'org-dev',
        status: {
          ...STATUS,
          manifest: STATUS.manifest && {
            ...STATUS.manifest,
            source: { orgId: 'org-dev', decisionDate: '2026-09-24' },
          },
        },
      });
      render(tab());

      expect(screen.getByTestId('frozen-load-pick-target').textContent).toBe(
        'DEV-SANDBOX is the org this dataset was extracted from: pick another sandbox.',
      );
      fireEvent.click(screen.getByTestId('frozen-load-run'));
      fireEvent.click(screen.getByTestId('frozen-load-preview'));
      expect(mutate).not.toHaveBeenCalled();
    });
  });

  describe('the options and the buttons', () => {
    it('says under Pilot and Reload what each does, read with its box', () => {
      render(tab());

      const pilot = screen.getByTestId('frozen-load-pilot');
      const reload = screen.getByTestId('frozen-load-reload');
      expect(pilot.parentElement?.textContent).toBe('Pilot (one root record first)');
      expect(
        document.getElementById(pilot.getAttribute('aria-describedby') ?? '')?.textContent,
      ).toBe(
        'Loads one root record and what hangs under it, to try the load before the whole dataset.',
      );
      expect(
        document.getElementById(reload.getAttribute('aria-describedby') ?? '')?.textContent,
      ).toBe(
        'Deletes from the target what earlier loads of this dataset created and this one does not find again, then loads.',
      );
    });

    it('puts Preview, which writes nothing, before the run, and names the run by what it does', () => {
      render(tab());
      const preview = screen.getByTestId('frozen-load-preview');
      const run = screen.getByTestId('frozen-load-run');
      expect(preview.compareDocumentPosition(run) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(run.textContent).toBe('Run load');

      fireEvent.click(screen.getByTestId('frozen-load-reload'));
      expect(run.textContent).toBe('Reload');
      // A pilot's reload purges nothing: it stays a pilot.
      fireEvent.click(screen.getByTestId('frozen-load-pilot'));
      expect(run.textContent).toBe('Run pilot');
    });

    it('stops a running load with "Stop the run", as its confirmation and Forge say it', () => {
      answers['frozen:load'] = { loading: true, requestId: 'req-load-7' };
      render(tab());
      expect(screen.getByTestId('frozen-load-cancel').textContent).toBe('Stop the run');
    });
  });

  describe('a reload', () => {
    it('reads the plan first, then asks with what it would delete and deactivate, and loads once the org is typed', () => {
      // As the bridge does, a request sent is in flight under its id.
      mutate.mockImplementation((requestType: string) => {
        if (requestType === 'frozen:load:preview') {
          answers[requestType] = { loading: true, requestId: 'req-preview-1' };
        }
      });
      const { rerender } = render(tab());

      fireEvent.click(screen.getByTestId('frozen-load-reload'));
      fireEvent.click(screen.getByTestId('frozen-load-run'));
      expect(mutate.mock.calls).toEqual([
        ['frozen:load:preview', { targetOrgId: 'org-dev', reload: true }],
      ]);
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.getByTestId('frozen-load-run').getAttribute('aria-busy')).toBe('true');

      const withDeactivated: FrozenLoadPlanInfo = {
        ...PLAN,
        perObject: [
          ...PLAN.perObject,
          { ...PLAN.perObject[1], objectApiName: 'Asset', toDeactivate: 2 },
        ],
      };
      answers['frozen:load:preview'] = {
        data: { plan: withDeactivated },
        requestId: 'req-preview-1',
      };
      rerender(tab());

      const dialog = screen.getByRole('dialog');
      expect(within(dialog).getByRole('heading').textContent).toBe('Reload into DEV-SANDBOX');
      expect(dialog.textContent).toContain(
        'This reload deletes from DEV-SANDBOX 5 records that earlier loads of this dataset created and this one does not find again, then loads the dataset.',
      );
      expect(screen.getByTestId('frozen-reload-confirm-deactivate').textContent).toBe(
        'It deactivates 2 more, of objects the platform does not delete.',
      );
      expect(screen.getByTestId('danger-confirm-btn')).toHaveProperty('disabled', true);
      expect(mutate.mock.calls.filter(([type]) => type === 'frozen:load')).toEqual([]);

      fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'DEV-SANDBOX' } });
      fireEvent.click(screen.getByTestId('danger-confirm-btn'));
      expect(mutate.mock.calls.filter(([type]) => type === 'frozen:load')).toEqual([
        ['frozen:load', { targetOrgId: 'org-dev', reload: true }],
      ]);
    });

    it('loads at once when the plan it reads purges nothing', () => {
      const nothing: FrozenLoadPlanInfo = {
        ...PLAN,
        perObject: PLAN.perObject.map((o) => ({ ...o, toPurge: 0, toDeactivate: 0 })),
      };
      answers['frozen:load:preview'] = { data: { plan: nothing }, requestId: 'req-preview-1' };
      render(tab());

      fireEvent.click(screen.getByTestId('frozen-load-reload'));
      fireEvent.click(screen.getByTestId('frozen-load-run'));

      expect(screen.queryByRole('dialog')).toBeNull();
      expect(mutate.mock.calls).toEqual([
        ['frozen:load', { targetOrgId: 'org-dev', reload: true }],
      ]);
    });

    it('asks nothing of a load or a pilot, which purge nothing', () => {
      render(tab());
      fireEvent.click(screen.getByTestId('frozen-load-run'));
      fireEvent.click(screen.getByTestId('frozen-load-reload'));
      fireEvent.click(screen.getByTestId('frozen-load-pilot'));
      fireEvent.click(screen.getByTestId('frozen-load-run'));

      expect(screen.queryByRole('dialog')).toBeNull();
      expect(mutate.mock.calls).toEqual([
        ['frozen:load', { targetOrgId: 'org-dev' }],
        ['frozen:load', { targetOrgId: 'org-dev', pilot: true, reload: true }],
      ]);
    });
  });
});
