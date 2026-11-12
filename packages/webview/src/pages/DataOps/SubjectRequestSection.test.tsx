import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import type { MutedAutomation, SubjectSearchResult } from '@sandforge/shared';
import { SubjectRequestSection, selectedRecords } from './SubjectRequestSection';

/* ------------------------------------------------------------------ */
/* Bridge hooks                                                        */
/* ------------------------------------------------------------------ */

interface MutationState {
  mutate: ReturnType<typeof vi.fn>;
  data: unknown;
  loading: boolean;
  error: string | null;
  reset: ReturnType<typeof vi.fn>;
  requestId: string | null;
}

const idle = (): MutationState => ({
  mutate: vi.fn(),
  data: null,
  loading: false,
  error: null,
  reset: vi.fn(),
  requestId: null,
});

/**
 * The review and the erasure are two hooks on one channel: the review waits
 * five minutes on the host, the erasure ten — that is what tells them apart here.
 */
let states: Record<string, MutationState>;

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (type: string, options?: { timeoutMs?: number }) => {
    if (type === 'dataops:dsr:erase') {
      return options?.timeoutMs === 300_000 ? states.review : states.erase;
    }
    return states[type];
  },
}));

/** What the org runs as the erasure writes over the records, as the extension answers a read of it: nothing. */
const NOTHING_FIRES = {
  act: 'masking',
  objects: [{ objectApiName: 'Contact', records: 2 }],
  steps: { giveBack: ['Contact'] },
  automation: {
    objectsRead: ['Contact'],
    objects: [],
    unread: [],
    conditionsNotRead: 0,
    conditionsBound: 0,
    requests: 1,
  },
  lines: [],
  emails: [],
  emailsAsk: false,
  refusals: [],
};

/** What `backup:list` answers for the org, once the erasure asks. */
let backupsListed: { backups: Array<{ operationId: string }> } | null = null;

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: () => ({ data: backupsListed, loading: false, error: null, refetch: vi.fn() }),
}));

const REQUEST = '5b0a9b8c-1111-4000-8000-000000000000';

const found: SubjectSearchResult = {
  requestId: REQUEST,
  orgId: 'org-1',
  searchedAt: '2026-09-23T10:00:00.000Z',
  limit: 200,
  objects: [
    {
      status: 'searched',
      objectApiName: 'Contact',
      label: 'Contact',
      counted: 2,
      records: [
        { id: '003000000000001AAA', name: 'Jane Doe', matchedBy: ['Email'] },
        { id: '003000000000002AAA', name: 'Jane Doe', matchedBy: ['Email', 'Phone'] },
      ],
      truncated: false,
      searched: [
        { fieldApiName: 'Email', label: 'Email', kind: 'email' },
        { fieldApiName: 'Phone', label: 'Business Phone', kind: 'phone' },
      ],
    },
    { status: 'skipped', objectApiName: 'Account', label: 'Account' },
  ],
};

beforeEach(() => {
  states = {
    'dataops:dsr:search': idle(),
    'dataops:dsr:export': idle(),
    review: idle(),
    erase: idle(),
    'backup:delete': idle(),
    'dataops:automation': { ...idle(), data: NOTHING_FIRES },
  };
  backupsListed = null;
});

function section(objects = ['Contact', 'Account'], onLogged = vi.fn()) {
  const view = render(
    <SubjectRequestSection orgId="org-1" orgName="dev1" objects={objects} onLogged={onLogged} />,
  );
  return { ...view, onLogged };
}

describe('SubjectRequestSection', () => {
  it('asks for an inventory first when there is nothing to search in', () => {
    section([]);

    expect(screen.getByTestId('dsr-needs-inventory')).toBeDefined();
    fireEvent.change(screen.getByLabelText('Email address'), {
      target: { value: 'jane@example.com' },
    });
    expect((screen.getByTestId('dsr-search-btn') as HTMLButtonElement).disabled).toBe(true);
  });

  it('refuses to search with an identifier that is not one, and says why', () => {
    section();

    fireEvent.change(screen.getByLabelText('Email address'), {
      target: { value: 'not-an-address' },
    });

    expect(screen.getByText('Enter an email address, such as name@example.com.')).toBeDefined();
    expect((screen.getByTestId('dsr-search-btn') as HTMLButtonElement).disabled).toBe(true);
  });

  it('searches the inventory’s objects for what was typed, trimmed', () => {
    section();

    fireEvent.change(screen.getByLabelText('Email address'), {
      target: { value: '  jane@example.com ' },
    });
    fireEvent.change(screen.getByLabelText('Phone number'), {
      target: { value: '+33 1 23 45 67 89' },
    });
    fireEvent.click(screen.getByTestId('dsr-search-btn'));

    expect(states['dataops:dsr:search'].mutate).toHaveBeenCalledWith({
      orgId: 'org-1',
      objects: ['Contact', 'Account'],
      email: 'jane@example.com',
      phone: '+33 1 23 45 67 89',
    });
  });

  it('lists what was found, every record ticked for erasure, and says why each matched', () => {
    states['dataops:dsr:search'].data = found;
    const { onLogged } = section();

    expect(screen.getByTestId('dsr-request').textContent).toBe(
      'Request 5b0a9b8c: 2 records found.',
    );
    const contact = screen.getByTestId('dsr-object-Contact');
    expect(contact.textContent).toContain('Email, Phone');
    // Both are Jane Doe: each box is named with its record's Id as well.
    const boxes = [
      screen.getByRole('checkbox', { name: 'Erase Jane Doe (003000000000001AAA)' }),
      screen.getByRole('checkbox', { name: 'Erase Jane Doe (003000000000002AAA)' }),
    ] as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([true, true]);
    expect(screen.getByTestId('dsr-object-Account').textContent).toBe(
      'Account: no field to look in for what was given.',
    );
    // A search opens the request in the log.
    expect(onLogged).toHaveBeenCalled();
  });

  it('adds a second search to the request the first one opened', () => {
    states['dataops:dsr:search'].data = found;
    section();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Jane Doe' } });
    fireEvent.click(screen.getByTestId('dsr-search-btn'));

    expect(states['dataops:dsr:search'].mutate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Jane Doe', requestId: REQUEST }),
    );
  });

  it('exports the request’s records and says where the file went', () => {
    states['dataops:dsr:search'].data = found;
    states['dataops:dsr:export'].data = {
      requestId: REQUEST,
      records: 2,
      saved: { status: 'saved', path: '/home/me/request.json' },
    };
    section();

    fireEvent.click(screen.getByTestId('dsr-export-btn'));

    expect(states['dataops:dsr:export'].mutate).toHaveBeenCalledWith({
      orgId: 'org-1',
      requestId: REQUEST,
    });
    expect(screen.getByTestId('dsr-export-status').textContent).toBe(
      'Saved 2 records to /home/me/request.json.',
    );
  });

  it('reviews the erasure of the records still ticked, in the way picked', () => {
    states['dataops:dsr:search'].data = found;
    section();

    fireEvent.click(screen.getByTestId('dsr-select-003000000000001AAA'));
    fireEvent.click(screen.getByTestId('dsr-mode-delete'));
    fireEvent.click(screen.getByTestId('dsr-review-btn'));

    expect(states.review.mutate).toHaveBeenCalledWith({
      orgId: 'org-1',
      requestId: REQUEST,
      mode: 'delete',
      records: [{ objectApiName: 'Contact', ids: ['003000000000002AAA'] }],
      dryRun: true,
    });
  });

  it('erases only once the plan is shown and the confirmation typed', () => {
    states['dataops:dsr:search'].data = found;
    states.review.data = {
      requestId: REQUEST,
      mode: 'anonymize',
      dryRun: true,
      plan: [
        {
          objectApiName: 'Contact',
          label: 'Contact',
          records: 2,
          fields: [{ fieldApiName: 'Email', label: 'Email', method: 'fake' }],
          kept: [],
        },
      ],
    };
    section();

    expect(screen.getByTestId('removal-plan-fields').textContent).toBe(
      'Overwrites: Email (made up)',
    );
    fireEvent.click(screen.getByTestId('dsr-erase-btn'));
    expect(states.erase.mutate).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'dev1' } });
    fireEvent.click(screen.getByTestId('danger-confirm-btn'));

    expect(states['dataops:automation'].mutate).toHaveBeenCalledWith({
      orgId: 'org-1',
      act: 'masking',
      objects: [{ objectApiName: 'Contact', records: 2 }],
      erasure: true,
    });
    // Confirmed once what the org runs as the records are written was listed.
    expect(states.erase.mutate).toHaveBeenCalledWith({
      orgId: 'org-1',
      requestId: REQUEST,
      mode: 'anonymize',
      records: [{ objectApiName: 'Contact', ids: ['003000000000001AAA', '003000000000002AAA'] }],
      dryRun: false,
      acceptAutomation: true,
    });
  });

  it('holds a delete until what the org runs as the records go is read, and names it the erasure', () => {
    states['dataops:dsr:search'].data = found;
    states.review.data = {
      requestId: REQUEST,
      mode: 'delete',
      dryRun: true,
      plan: [{ objectApiName: 'Contact', label: 'Contact', records: 2 }],
    };
    states['dataops:automation'].data = null;
    const { rerender } = section();
    fireEvent.click(screen.getByTestId('dsr-mode-delete'));
    fireEvent.click(screen.getByTestId('dsr-erase-btn'));
    fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'dev1' } });

    expect(states['dataops:automation'].mutate).toHaveBeenCalledWith({
      orgId: 'org-1',
      act: 'cleanup',
      objects: [{ objectApiName: 'Contact', records: 2 }],
      erasure: true,
    });
    expect((screen.getByTestId('danger-confirm-btn') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('danger-held').textContent).toContain('Waiting for what dev1 runs');

    // The read lands: a flow before the delete.
    states['dataops:automation'].data = {
      ...NOTHING_FIRES,
      act: 'cleanup',
      steps: { delete: ['Contact'] },
      automation: {
        ...NOTHING_FIRES.automation,
        objects: [
          {
            objectApiName: 'Contact',
            flows: [
              {
                apiName: 'Guard_Delete',
                label: 'Guard Delete',
                timing: 'beforeSave',
                startsOn: 'delete',
                condition: 'read',
                permissions: [],
              },
            ],
            triggers: [],
          },
        ],
      },
    };
    rerender(
      <SubjectRequestSection
        orgId="org-1"
        orgName="dev1"
        objects={['Contact']}
        onLogged={vi.fn()}
      />,
    );

    const listed = screen.getByTestId('dataops-automation-cleanup').textContent ?? '';
    expect(listed).toContain('As the erasure deletes these records, dev1 runs:');
    expect(listed).toContain('Guard Delete');
    expect((screen.getByTestId('danger-confirm-btn') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('danger-confirm-btn'));
    expect(states.erase.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'delete', dryRun: false, acceptAutomation: true }),
    );
  });

  describe('the confirmation of an erasure', () => {
    beforeEach(() => {
      states['dataops:dsr:search'].data = found;
      states.review.data = {
        requestId: REQUEST,
        mode: 'anonymize',
        dryRun: true,
        plan: [
          {
            objectApiName: 'Contact',
            label: 'Contact',
            records: 2,
            fields: [{ fieldApiName: 'Email', label: 'Email', method: 'fake' }],
            kept: [],
          },
        ],
      };
    });

    it('asks for the org’s name, not the word erase', () => {
      // The word was erase, 消去 in Japanese, typed only through an input method.
      section();
      fireEvent.click(screen.getByTestId('dsr-erase-btn'));

      fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'erase' } });
      expect((screen.getByTestId('danger-confirm-btn') as HTMLButtonElement).disabled).toBe(true);
      fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'dev1' } });
      expect((screen.getByTestId('danger-confirm-btn') as HTMLButtonElement).disabled).toBe(false);
    });

    it('says to delete the backups that still hold the values, never to take one first', () => {
      // It advised "Take a backup first if you may need them", and once the
      // erasure was done the same panel warned that such a backup brings the
      // person back, and offered to delete it.
      section();
      fireEvent.click(screen.getByTestId('dsr-erase-btn'));

      const said = screen.getByRole('dialog').textContent ?? '';
      expect(said).toContain(
        'Any backup of this org on this machine still holds these values: delete it once the erasure is done.',
      );
      expect(said).not.toContain('Take a backup');
    });
  });

  it('reads what fires on the records the dry run says the erasure deletes itself, while its review counts what goes along', () => {
    // A contact's tasks go with it, and the platform runs none of what fires
    // before a task's delete as they go: the dry run counts them in its plan,
    // and names the contacts alone as what the confirmation reads it on.
    states['dataops:dsr:search'].data = found;
    states.review.data = {
      requestId: REQUEST,
      mode: 'delete',
      dryRun: true,
      plan: [
        {
          objectApiName: 'Contact',
          label: 'Contact',
          records: 2,
          related: [{ objectApiName: 'Task', label: 'Task', records: 3 }],
        },
      ],
      written: [{ objectApiName: 'Contact', records: 2 }],
    };
    section();
    fireEvent.click(screen.getByTestId('dsr-mode-delete'));
    fireEvent.click(screen.getByTestId('dsr-erase-btn'));

    expect(screen.getByTestId('removal-plan-related').textContent).toContain('Task: 3 records');
    expect(states['dataops:automation'].mutate).toHaveBeenCalledWith({
      orgId: 'org-1',
      act: 'cleanup',
      objects: [{ objectApiName: 'Contact', records: 2 }],
      erasure: true,
    });
  });

  it('shows what the erasure did', () => {
    states['dataops:dsr:search'].data = found;
    states.erase.data = {
      requestId: REQUEST,
      mode: 'delete',
      dryRun: false,
      plan: [],
      outcome: {
        status: 'success',
        done: 2,
        failed: 0,
        objects: [{ objectApiName: 'Contact', done: 2, failed: 0 }],
        errors: [],
      },
    };
    section();

    expect(screen.getByTestId('removal-outcome').textContent).toBe('2 records deleted.');
  });

  /** What an erasure that muted says it did of the org's automation, as its lease answers it. */
  const MUTED: MutedAutomation = {
    state: 'muted',
    assigned: ['Flow_Bypass'],
    held: [],
    permissions: ['Skip_Flows'],
    silenced: [
      { objectApiName: 'Contact', kind: 'flow', name: 'Notify Owner', permission: 'Skip_Flows' },
    ],
    stillRan: [],
    released: true,
    takenBack: ['Flow_Bypass'],
  };

  it('shows what the erasure muted: what it assigned, kept quiet and took back', () => {
    // The page said how many records were erased, and nothing of the set the
    // erasure had assigned to the user it wrote as.
    states['dataops:dsr:search'].data = found;
    states.erase.data = {
      requestId: REQUEST,
      mode: 'anonymize',
      dryRun: false,
      plan: [],
      outcome: {
        status: 'success',
        done: 2,
        failed: 0,
        objects: [{ objectApiName: 'Contact', done: 2, failed: 0 }],
        errors: [],
      },
      mutedAutomation: MUTED,
    };
    section();

    expect(screen.getByTestId('dsr-erase-muted-said').textContent).toBe(
      'Flow_Bypass was assigned to the user the run wrote as in dev1, for the run alone.',
    );
    expect(screen.getByTestId('dsr-erase-muted-released').textContent).toBe(
      'Taken back as the run ended: Flow_Bypass.',
    );
    expect(screen.getByTestId('dsr-erase-muted-silenced-Contact').textContent).toContain(
      'Notify Owner',
    );
  });

  it('shows, beside the failure of an erasure cancelled half way, what its mute did', () => {
    states['dataops:dsr:search'].data = found;
    states.erase.requestId = 'req-erase';
    states.erase.error = 'Cancelled: 1 record(s) overwritten before the cancel.';
    section();
    expect(screen.queryByTestId('dsr-erase-muted')).toBeNull();

    // Another request's failure says nothing of this erasure.
    const failure = (correlationId: string): void =>
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: {
              id: `err-${correlationId}`,
              type: 'dataops:error',
              timestamp: Date.now(),
              correlationId,
              payload: { message: 'Cancelled', code: 'RUN_CANCELLED', mutedAutomation: MUTED },
            },
          }),
        );
      });
    failure('req-other');
    expect(screen.queryByTestId('dsr-erase-muted')).toBeNull();

    failure('req-erase');
    expect(screen.getByTestId('dsr-erase-error').textContent).toContain('Cancelled: 1 record');
    expect(screen.getByTestId('dsr-erase-muted-released').textContent).toBe(
      'Taken back as the run ended: Flow_Bypass.',
    );
  });

  it('offers, once the erasure is done, to delete the backups that would bring the person back', () => {
    // A backup taken before the erasure still held the person's records, and
    // restoring it brought them back: the page said nothing of it.
    states['dataops:dsr:search'].data = found;
    states.erase.data = {
      requestId: REQUEST,
      mode: 'anonymize',
      dryRun: false,
      plan: [],
      outcome: {
        status: 'success',
        done: 2,
        failed: 0,
        objects: [{ objectApiName: 'Contact', done: 2, failed: 0 }],
        errors: [],
      },
    };
    backupsListed = { backups: [{ operationId: 'bk-1' }] };
    section();

    fireEvent.click(screen.getByTestId('dsr-backups-delete'));
    fireEvent.click(screen.getByTestId('dsr-backups-delete-confirm'));
    expect(states['backup:delete'].mutate).toHaveBeenCalledWith({
      orgId: 'org-1',
      operationIds: ['bk-1'],
    });
  });

  it('offers nothing of the backups before anything was erased', () => {
    states['dataops:dsr:search'].data = found;
    backupsListed = { backups: [{ operationId: 'bk-1' }] };
    section();

    expect(screen.queryByTestId('dsr-backups-before')).toBeNull();
  });

  it('says when more records matched than the ones it can act on', () => {
    states['dataops:dsr:search'].data = {
      ...found,
      objects: [
        {
          ...found.objects[0],
          counted: 350,
          truncated: true,
        } as SubjectSearchResult['objects'][number],
      ],
    };
    section();

    expect(screen.getByTestId('dsr-object-truncated').textContent).toContain('350');
  });

  it('names the records to erase per object, from what is ticked', () => {
    expect(
      selectedRecords(
        found.objects,
        new Set(['Contact:003000000000002AAA', 'Lead:00Q000000000001AAA']),
      ),
    ).toEqual([{ objectApiName: 'Contact', ids: ['003000000000002AAA'] }]);
  });
});
