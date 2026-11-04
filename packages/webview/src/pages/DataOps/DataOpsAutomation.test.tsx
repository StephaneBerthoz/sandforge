import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import type { DataOpsAutomationAnswer } from '@sandforge/shared';
import {
  accordPayloadOf,
  DataOpsAutomation,
  NO_ACCORD,
  type DataOpsAutomationAccord,
} from './DataOpsAutomation';

/** The read's hook, as each test sets it. */
const read = vi.hoisted(() => ({
  mutate: vi.fn(),
  data: null as unknown,
  loading: false,
  error: null as string | null,
  reset: vi.fn(),
  requestId: null,
  errorCode: null,
}));

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: () => read,
}));

/** A masking of 40 contacts on an org whose update flow emails each one's owner, on All email. */
const FIRES: DataOpsAutomationAnswer = {
  act: 'masking',
  objects: [{ objectApiName: 'Contact', records: 40 }],
  steps: { giveBack: ['Contact'] },
  automation: {
    objectsRead: ['Contact'],
    objects: [
      {
        objectApiName: 'Contact',
        flows: [
          {
            apiName: 'Notify_Owner',
            label: 'Notify Owner',
            timing: 'afterSave',
            startsOn: 'update',
            condition: 'read',
            permissions: [],
            messages: [{ kind: 'email', name: 'Send', limit: 'SingleEmail' }],
          },
        ],
        triggers: [],
      },
    ],
    unread: [],
    conditionsNotRead: 0,
    conditionsBound: 0,
    requests: 1,
  },
  lines: [],
  emails: [
    {
      limit: 'SingleEmail',
      emails: 40,
      objects: [
        {
          objectApiName: 'Contact',
          write: 'update',
          records: 40,
          perRecord: 1,
          sentBy: ['Notify Owner'],
        },
      ],
      verdict: 'fits',
      remaining: 5000,
      max: 5000,
    },
  ],
  deliverability: {
    reading: { level: 'all' },
    senders: [{ objectApiName: 'Contact', kind: 'flow', name: 'Notify Owner', why: 'email' }],
  },
  emailsAsk: true,
  refusals: [],
};

function renderSection(accord: DataOpsAutomationAccord = NO_ACCORD) {
  const onAccordChange = vi.fn();
  const onHeld = vi.fn();
  const view = render(
    <DataOpsAutomation
      orgId="org-1"
      org="dev1"
      act="masking"
      objects={[{ objectApiName: 'Contact', records: 40 }]}
      accord={accord}
      onAccordChange={onAccordChange}
      onHeld={onHeld}
    />,
  );
  return { ...view, onAccordChange, onHeld };
}

beforeEach(() => {
  read.mutate.mockReset();
  read.data = null;
  read.loading = false;
  read.error = null;
});

describe('DataOpsAutomation', () => {
  it('reads what the org runs as the masking writes, and holds the confirmation until it answers', () => {
    const { onHeld } = renderSection();

    expect(read.mutate).toHaveBeenCalledWith({
      orgId: 'org-1',
      act: 'masking',
      objects: [{ objectApiName: 'Contact', records: 40 }],
    });
    expect(onHeld).toHaveBeenLastCalledWith(
      'Waiting for what dev1 runs as these records are written.',
    );
  });

  it('lists the flow its updates fire and the emails it sends, and holds until they are let through', () => {
    read.data = FIRES;
    const { onHeld, onAccordChange } = renderSection();

    const section = screen.getByTestId('dataops-automation-masking');
    expect(section.textContent).toContain('Notify Owner');
    expect(section.textContent).toContain('as the masking writes over it');
    expect(screen.getByTestId('dataops-automation-masking-emails-SingleEmail').textContent).toBe(
      'About 40 of its single emails go out as these records are written, 5,000 of 5,000 left today.',
    );
    expect(onHeld).toHaveBeenLastCalledWith(
      'Tick the box to let dev1 send these emails, or turn off what sends them.',
    );

    fireEvent.click(screen.getByTestId('dataops-automation-masking-accept-emails'));
    expect(onAccordChange).toHaveBeenCalledWith({ acceptEmails: true, muteAutomation: false });
  });

  it('lets the confirmation go once the emails are let through', () => {
    read.data = FIRES;
    const { onHeld } = renderSection({ acceptEmails: true, muteAutomation: false });

    expect(onHeld).toHaveBeenLastCalledWith(undefined);
  });

  it('reads again with the mute asked for once its box is ticked', () => {
    read.data = FIRES;
    const { rerender, onAccordChange, onHeld } = renderSection();
    read.mutate.mockReset();

    rerender(
      <DataOpsAutomation
        orgId="org-1"
        org="dev1"
        act="masking"
        objects={[{ objectApiName: 'Contact', records: 40 }]}
        accord={{ acceptEmails: false, muteAutomation: true }}
        onAccordChange={onAccordChange}
        onHeld={onHeld}
      />,
    );

    expect(read.mutate).toHaveBeenCalledWith(expect.objectContaining({ muteAutomation: true }));
  });

  it('holds a masking past the emails the org has left today, whatever is ticked, and says why', () => {
    read.data = {
      ...FIRES,
      refusals: [
        {
          code: 'EMAILS_EXCEEDED',
          message: 'This masking would make dev1 send about 40 single emails.',
        },
      ],
    };
    const { onHeld } = renderSection({ acceptEmails: true, muteAutomation: false });

    expect(
      screen.getByTestId('dataops-automation-masking-refused-EMAILS_EXCEEDED').textContent,
    ).toBe('This would be refused: This masking would make dev1 send about 40 single emails.');
    expect(onHeld).toHaveBeenLastCalledWith('This is refused as it stands: see why above.');
  });

  it('carries what fires accepted once its question was answered, and nothing without one', () => {
    expect(accordPayloadOf({ acceptEmails: true, muteAutomation: false })).toEqual({
      acceptAutomation: true,
      acceptEmails: true,
    });
    expect(accordPayloadOf(NO_ACCORD)).toEqual({ acceptAutomation: true });
    expect(accordPayloadOf(undefined)).toEqual({});
  });
});
