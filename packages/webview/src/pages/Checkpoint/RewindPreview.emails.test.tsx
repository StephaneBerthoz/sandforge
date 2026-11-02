import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import '../../i18n';
import type {
  CheckpointPreviewResponse,
  ForgeTargetAutomation,
  RunDeliverability,
} from '@sandforge/shared';
import { useOrgStore } from '../../stores/useOrgStore';
import {
  developerOrg,
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

import { RewindPreview, type MuteBoxOf } from './RewindPreview';
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

/**
 * What fires as the default preview's rewind gives the contacts their values
 * back: a flow that sends an email and tests a bypass a permission set of the
 * org holds — the trap org's welcome email — and nothing else.
 */
const WELCOME_ONLY: ForgeTargetAutomation = {
  objectsRead: ['Contact', 'Account'],
  objects: [
    {
      objectApiName: 'Contact',
      flows: [
        {
          apiName: 'Contact_Welcome_Email',
          label: 'Contact Welcome Email',
          timing: 'afterSave',
          startsOn: 'update',
          condition: 'read',
          permissions: [{ name: 'Bypass_Flow', bypass: true, held: false }],
          messages: [{ kind: 'email', name: 'Welcome', limit: 'SingleEmail' }],
        },
      ],
      triggers: [],
    },
  ],
  bypassGrants: [
    {
      permission: 'Bypass_Flow',
      permissionSets: [{ name: 'Flow_Bypass', label: 'Flow bypass', grants: 1 }],
    },
  ],
  unread: [],
  conditionsNotRead: 0,
  conditionsBound: 25,
  requests: 4,
};

/** The same, and an alert on the account's delete that tests no bypass: muted, it still sends. */
const WITH_ALERT: ForgeTargetAutomation = {
  ...WELCOME_ONLY,
  objects: [
    ...WELCOME_ONLY.objects,
    {
      objectApiName: 'Account',
      flows: [
        {
          apiName: 'Account_Gone_Alert',
          label: 'Account Gone Alert',
          timing: 'beforeDelete',
          startsOn: 'delete',
          condition: 'read',
          permissions: [],
          messages: [{ kind: 'email', name: 'Owner alert', limit: 'DailyWorkflowEmails' }],
        },
      ],
      triggers: [],
    },
  ],
};

/** What the extension says of the emails, as it said it for the automation of {@link WITH_ALERT}. */
function delivered(reading: RunDeliverability['reading']): RunDeliverability {
  return {
    reading,
    senders: [
      { objectApiName: 'Contact', kind: 'flow', name: 'Contact Welcome Email', why: 'email' },
      { objectApiName: 'Account', kind: 'flow', name: 'Account Gone Alert', why: 'email' },
    ],
  };
}

/** The preview of the Developer Edition's checkpoint, with a spy for the rewind it confirms. */
function renderPreview(options: { startMuted?: boolean; withRewind?: boolean } = {}) {
  const onRewind = vi.fn();
  render(
    <RewindPreview
      org={developerOrg()}
      checkpoint={readyCheckpoint()}
      onClose={vi.fn()}
      {...(options.withRewind === false ? {} : { onRewind, muteBox: MUTE_BOX })}
      {...(options.startMuted !== undefined ? { startMuted: options.startMuted } : {})}
    />,
  );
  return { onRewind };
}

/** Answer the last `checkpoint:preview`. */
function answerPreview(overrides: Partial<CheckpointPreviewResponse['payload']>): void {
  act(() =>
    host.current?.answer(
      'checkpoint:preview',
      'checkpoint:preview:response',
      previewAnswer(overrides),
    ),
  );
}

/** Press Rewind, type the org's name and confirm: what the page asks the rewind to accept. */
function rewind(onRewind: ReturnType<typeof vi.fn>): unknown {
  fireEvent.click(screen.getByTestId('checkpoint-preview-rewind'));
  fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'DEV-SB' } });
  fireEvent.click(screen.getByTestId('danger-confirm-btn'));
  return onRewind.mock.calls[onRewind.mock.calls.length - 1]?.[0];
}

describe('RewindPreview, the emails the org delivers', () => {
  beforeEach(() => {
    host.current = fakeHost();
    useOrgStore.setState({ orgs: [developerOrg()], selectedOrgId: 'org-dev' });
  });
  afterEach(() => {
    cleanup();
    useOrgStore.setState({ orgs: [], selectedOrgId: null });
  });

  it('holds Rewind on All email until their own box is ticked, the automation’s never standing for it', () => {
    const { onRewind } = renderPreview();
    answerPreview({ automation: WITH_ALERT, deliverability: delivered({ level: 'all' }) });

    expect(screen.getByTestId('checkpoint-preview-deliverability-reading').textContent).toBe(
      'DEV-SB delivers every email its automation sends (Setup > Deliverability: All email), ' +
        'and what still runs as the rewind writes may send some: Flow “Contact Welcome Email” ' +
        'on Contact and Flow “Account Gone Alert” on Account.',
    );
    expect(screen.getByTestId('checkpoint-preview-accept-emails')).not.toBeChecked();
    fireEvent.click(screen.getByTestId('checkpoint-preview-accept-automation'));
    expect(screen.getByTestId('checkpoint-preview-rewind')).toBeDisabled();
    expect(screen.getByTestId('checkpoint-preview-needs-box-emails').textContent).toBe(
      'Let DEV-SB send these emails',
    );

    fireEvent.click(screen.getByTestId('checkpoint-preview-accept-emails'));
    expect(screen.getByTestId('checkpoint-preview-rewind')).toBeEnabled();
    expect(rewind(onRewind)).toEqual({
      previewId: 'pv-1',
      acceptAutomation: true,
      acceptEmails: true,
      acceptNoUndo: false,
      acceptRecreate: false,
      acceptOutside: false,
      acceptUnseen: false,
    });
  });

  it('asks the same of an org that would not say, its reason given', () => {
    renderPreview();
    answerPreview({
      automation: WITH_ALERT,
      deliverability: delivered({ unread: 'the user SandForge connects as cannot send email' }),
    });
    expect(screen.getByTestId('checkpoint-preview-deliverability-reading').textContent).toContain(
      '(the user SandForge connects as cannot send email)',
    );
    fireEvent.click(screen.getByTestId('checkpoint-preview-accept-automation'));
    expect(screen.getByTestId('checkpoint-preview-rewind')).toBeDisabled();
    fireEvent.click(screen.getByTestId('checkpoint-preview-accept-emails'));
    expect(screen.getByTestId('checkpoint-preview-rewind')).toBeEnabled();
  });

  it('says on System email only or No access that none goes out, and offers no box', () => {
    const { onRewind } = renderPreview();
    answerPreview({ automation: WITH_ALERT, deliverability: delivered({ level: 'withheld' }) });
    expect(screen.getByTestId('checkpoint-preview-deliverability-withheld')).toBeInTheDocument();
    expect(screen.queryByTestId('checkpoint-preview-accept-emails')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('checkpoint-preview-accept-automation'));
    expect(rewind(onRewind)).not.toHaveProperty('acceptEmails');
  });

  it('lifts a refusal of the emails with their box alone', () => {
    renderPreview();
    answerPreview({
      automation: WITH_ALERT,
      deliverability: delivered({ level: 'all' }),
      refusal: {
        code: 'EMAILS_DELIVERED',
        message: 'DEV-SB delivers every email its automation sends. No record was written.',
      },
    });
    fireEvent.click(screen.getByTestId('checkpoint-preview-accept-automation'));
    expect(screen.getByTestId('checkpoint-preview-rewind')).toBeDisabled();
    fireEvent.click(screen.getByTestId('checkpoint-preview-accept-emails'));
    expect(screen.getByTestId('checkpoint-preview-rewind')).toBeEnabled();
  });

  it('never lifts the day’s emails with it: past what is left today, the rewind stays refused', () => {
    renderPreview();
    answerPreview({
      automation: WITH_ALERT,
      deliverability: delivered({ level: 'all' }),
      refusal: {
        code: 'EMAILS',
        message: 'The rewind makes DEV-SB send 20 single emails, more than the 15 left today.',
      },
    });
    fireEvent.click(screen.getByTestId('checkpoint-preview-accept-automation'));
    fireEvent.click(screen.getByTestId('checkpoint-preview-accept-emails'));
    expect(screen.getByTestId('checkpoint-preview-rewind')).toBeDisabled();
    expect(screen.getByTestId('checkpoint-preview-rewind-needs').textContent).toBe(
      'The rewind makes DEV-SB send 20 single emails, more than the 15 left today.',
    );
  });

  it('asks nothing of a muted rewind whose every sender tests a bypass the mute holds', () => {
    const { onRewind } = renderPreview();
    answerPreview({
      automation: WELCOME_ONLY,
      deliverability: {
        reading: { level: 'all' },
        senders: [
          { objectApiName: 'Contact', kind: 'flow', name: 'Contact Welcome Email', why: 'email' },
        ],
      },
    });
    expect(screen.getByTestId('checkpoint-preview-accept-emails')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('checkpoint-preview-automation-mute-toggle'));
    expect(screen.queryByTestId('checkpoint-preview-accept-emails')).not.toBeInTheDocument();
    expect(screen.getByTestId('checkpoint-preview-deliverability-quiet')).toBeInTheDocument();
    expect(rewind(onRewind)).toEqual(
      expect.not.objectContaining({ acceptEmails: expect.anything() }),
    );
    expect(onRewind.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ muteAutomation: true }));
  });

  it('muted, still asks for what tests no bypass, and names only that', () => {
    renderPreview();
    answerPreview({ automation: WITH_ALERT, deliverability: delivered({ level: 'all' }) });
    fireEvent.click(screen.getByTestId('checkpoint-preview-automation-mute-toggle'));
    expect(screen.getByTestId('checkpoint-preview-accept-emails')).toBeInTheDocument();
    const reading = screen.getByTestId('checkpoint-preview-deliverability-reading').textContent;
    expect(reading).toContain('Flow “Account Gone Alert” on Account');
    expect(reading).not.toContain('Contact Welcome Email');
  });

  it('opens muted when asked, as from a run that muted, and a read again keeps the mute and unticks the emails', () => {
    renderPreview({ startMuted: true });
    answerPreview({ automation: WITH_ALERT, deliverability: delivered({ level: 'all' }) });
    expect(screen.getByTestId('checkpoint-preview-automation-mute-toggle')).toBeChecked();
    fireEvent.click(screen.getByTestId('checkpoint-preview-accept-emails'));

    fireEvent.click(screen.getByTestId('bypass-assistant-read-again'));
    answerPreview({
      automation: WITH_ALERT,
      deliverability: delivered({ level: 'all' }),
      diff: previewDiff({ previewId: 'pv-2' }),
    });
    expect(screen.getByTestId('checkpoint-preview-automation-mute-toggle')).toBeChecked();
    expect(screen.getByTestId('checkpoint-preview-accept-emails')).not.toBeChecked();
  });

  it('opens unmuted otherwise', () => {
    renderPreview();
    answerPreview({ automation: WITH_ALERT, deliverability: delivered({ level: 'all' }) });
    expect(screen.getByTestId('checkpoint-preview-automation-mute-toggle')).not.toBeChecked();
  });

  it('shows the same words and box on the Automation page’s Rewind step, which starts no rewind', () => {
    renderPreview({ withRewind: false });
    answerPreview({ automation: WITH_ALERT, deliverability: delivered({ level: 'all' }) });
    expect(screen.getByTestId('checkpoint-preview-deliverability-reading')).toBeInTheDocument();
    expect(screen.getByTestId('checkpoint-preview-accept-emails')).toBeInTheDocument();
  });
});
