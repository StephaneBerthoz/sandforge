import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import type { SubjectSearchResult } from '@sandforge/shared';
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
  };
});

function section(objects = ['Contact', 'Account'], onLogged = vi.fn()) {
  const view = render(
    <SubjectRequestSection orgId="org-1" objects={objects} onLogged={onLogged} />,
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

    fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'erase' } });
    fireEvent.click(screen.getByTestId('danger-confirm-btn'));

    expect(states.erase.mutate).toHaveBeenCalledWith({
      orgId: 'org-1',
      requestId: REQUEST,
      mode: 'anonymize',
      records: [{ objectApiName: 'Contact', ids: ['003000000000001AAA', '003000000000002AAA'] }],
      dryRun: false,
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
