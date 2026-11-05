import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { OrgSafetyTier } from '@sandforge/shared';
import type { DataOpsAutomationAnswer, SalesforceOrg } from '@sandforge/shared';
import { useOrgStore } from '../../stores/useOrgStore';
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
  useOrgStore.setState({ orgs: [] });
});

/** The org the section writes to, as the registry holds it, of the type given. */
function orgTyped(orgType: SalesforceOrg['orgType'], edition: string): SalesforceOrg {
  return {
    id: 'org-1',
    alias: 'dev1',
    username: 'user@dev1.example.com',
    instanceUrl: 'https://dev1.example.com',
    orgId: '00D000000000001',
    orgType,
    authMethod: 'oauth_web',
    safetyTier: OrgSafetyTier.LOW,
    appearance: { color: '#0070d2', icon: 'cloud', position: 0 },
    metadata: { apiVersion: '59.0', edition, features: [] },
    status: 'connected',
    lastConnected: '2024-01-01T00:00:00Z',
    tags: [],
  };
}

/** {@link FIRES}, its flow quiet under Skip_Flows, which a permission set of the org holds. */
const MUTABLE: DataOpsAutomationAnswer = {
  ...FIRES,
  automation: {
    ...FIRES.automation!,
    objects: [
      {
        ...FIRES.automation!.objects[0]!,
        flows: [
          {
            ...FIRES.automation!.objects[0]!.flows[0]!,
            permissions: [{ name: 'Skip_Flows', bypass: true }],
          },
        ],
      },
    ],
    bypassGrants: [
      {
        permission: 'Skip_Flows',
        permissionSets: [{ name: 'Flow_Bypass', label: 'Flow Bypass', grants: 1 }],
      },
    ],
  },
};

describe('DataOpsAutomation', () => {
  it('reads what the org runs as the masking writes, and holds the confirmation until it answers', () => {
    const { onHeld } = renderSection();

    // Marked as the page's: what it would be refused for names its confirmation, not flags.
    expect(read.mutate).toHaveBeenCalledWith({
      orgId: 'org-1',
      act: 'masking',
      objects: [{ objectApiName: 'Contact', records: 40 }],
      fromPage: true,
    });
    expect(onHeld).toHaveBeenLastCalledWith(
      'Waiting for what dev1 runs as these records are written.',
    );
  });

  it('names the duplicate rules of what the masking writes over, and what a rule that reports leaves', () => {
    const contact = FIRES.automation!.objects[0]!;
    read.data = {
      ...FIRES,
      automation: {
        ...FIRES.automation!,
        objects: [
          {
            ...contact,
            duplicateRules: [
              {
                name: 'Standard Contact Duplicate Rule',
                developerName: 'Standard_Rule_for_Contacts',
              },
            ],
          },
        ],
      },
    } satisfies DataOpsAutomationAnswer;
    renderSection();

    expect(screen.getByTestId('dataops-automation-masking-duplicates-Contact').textContent).toBe(
      'Duplicate rules active on Contact: Standard Contact Duplicate Rule. A record a rule only ' +
        'alerts on is written, one a rule blocks is refused, and what a rule that reports ' +
        'writes, a duplicate record set and its items, stays in dev1.',
    );
  });

  it('names no duplicate rule where none is active', () => {
    read.data = FIRES;
    renderSection();

    expect(screen.queryByTestId('dataops-automation-masking-duplicates-Contact')).toBeNull();
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

  it('offers the mute where a bypass silences what fires, and not on a production org, where it is refused', () => {
    read.data = MUTABLE;
    useOrgStore.setState({ orgs: [orgTyped('Sandbox', 'Developer Edition')] });
    const { unmount } = renderSection();
    expect(screen.getByTestId('dataops-automation-masking-mute-toggle')).toBeTruthy();
    unmount();

    // Ticked, it was refused before anything was written (MUTE_PRODUCTION).
    useOrgStore.setState({ orgs: [orgTyped('Production', 'Enterprise Edition')] });
    renderSection();
    expect(screen.queryByTestId('dataops-automation-masking-mute')).toBeNull();
    expect(screen.getByTestId('dataops-automation-masking').textContent).toContain('Notify Owner');
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
