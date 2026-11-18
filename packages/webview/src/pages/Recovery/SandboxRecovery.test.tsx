import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import i18n from '../../i18n';
import fr from '../../i18n/locales/fr.json';
import { useAppStore } from '../../stores/useAppStore';
import {
  auditOf,
  fakeHost,
  refreshedStatus,
  uatOrg,
  usersList,
  type FakeHost,
} from './testing/recoveryFixtures';
import type { RecoveryStatus } from '@sandforge/shared';

const host = vi.hoisted(() => ({ current: null as null | FakeHost }));

vi.mock('../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => host.current?.api,
  getVscodeApi: () => host.current?.api,
}));

import { SandboxRecovery } from './SandboxRecovery';

/** Draw the page on the sandbox, its status answered. */
function open(status: RecoveryStatus = refreshedStatus()): void {
  render(<SandboxRecovery org={uatOrg()} />);
  act(() => host.current?.answer('recovery:status', 'recovery:status:response', { status }));
}

/** The row of a step. */
function step(id: string): HTMLElement {
  return screen.getByTestId(`recovery-step-${id}`);
}

beforeEach(() => {
  host.current = fakeHost();
  useAppStore.setState({ currentRoute: 'recovery', navigationIntent: null });
});

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('SandboxRecovery', () => {
  it('says how the refresh was noticed, and the org it was before and is now', () => {
    open();
    const facts = within(step('refresh')).getByTestId('recovery-refresh-facts');
    expect(facts).toHaveTextContent(/Noticed on .* when SandForge connected to it/);
    expect(facts).toHaveTextContent('Was org 00Dxx0000001XyZ, now org 00Dxx0000002AbC');
    expect(facts).toHaveTextContent('SandForge forgot what it had cached of the org before');
    expect(within(step('refresh')).queryByRole('button')).toBeNull();
  });

  it('says what each step will do, with the facts it names', () => {
    open();
    expect(screen.getByTestId('recovery-step-replay-line')).toHaveTextContent(
      /^Opens the replay of Before refresh, taken on .* before the refresh: simulate it, then replay its records into UAT\.$/,
    );
    expect(screen.getByTestId('recovery-step-frozen-line')).toHaveTextContent(
      /\(objects: 4, records: 1,250\)\.$/,
    );
  });

  it('says why a step does not apply, and offers nothing to run there', () => {
    open(
      refreshedStatus(
        { frozenManifest: undefined },
        { frozen: { reason: 'noManifest' }, masking: { reason: 'nothingCopied' } },
      ),
    );
    expect(screen.getByTestId('recovery-step-frozen-status')).toHaveTextContent('Does not apply');
    expect(screen.getByTestId('recovery-step-frozen-line')).toHaveTextContent(
      'No frozen dataset is kept on this machine',
    );
    expect(screen.queryByTestId('recovery-open-load')).toBeNull();
    expect(screen.queryByTestId('recovery-open-masking')).toBeNull();
    expect(within(step('frozen')).queryByRole('button')).toBeNull();
  });

  it('skips a step, takes the status the extension answers, and undoes the skip', () => {
    open();
    fireEvent.click(screen.getByTestId('recovery-step-masking-skip'));
    expect(host.current?.lastPayload('recovery:ack')).toEqual({
      orgId: 'org-uat',
      what: 'step',
      step: 'masking',
      mark: 'skipped',
    });
    act(() =>
      host.current?.answer('recovery:ack', 'recovery:ack:response', {
        status: refreshedStatus({}, { masking: { reason: 'skipped' } }),
      }),
    );
    expect(screen.getByTestId('recovery-step-masking-status')).toHaveTextContent('Skipped');
    expect(screen.getByTestId('recovery-count')).toHaveTextContent('2/10 steps');

    fireEvent.click(screen.getByTestId('recovery-step-masking-undo'));
    expect(host.current?.lastPayload('recovery:ack')).toMatchObject({ mark: 'cleared' });
  });

  it('marks done by hand only the two steps a person checks in Setup', () => {
    open();
    expect(screen.getByTestId('recovery-step-deliverability-mark-done')).toBeInTheDocument();
    expect(screen.getByTestId('recovery-step-endpoints-mark-done')).toBeInTheDocument();
    expect(screen.queryByTestId('recovery-step-masking-mark-done')).toBeNull();
    expect(screen.queryByTestId('recovery-step-refresh-skip')).toBeNull();
    fireEvent.click(screen.getByTestId('recovery-step-endpoints-mark-done'));
    expect(host.current?.lastPayload('recovery:ack')).toMatchObject({
      step: 'endpoints',
      mark: 'done',
    });
  });

  it('opens Masking in DataOps on the sandbox, never DataOps itself here', () => {
    open();
    fireEvent.click(screen.getByTestId('recovery-open-masking'));
    expect(useAppStore.getState().currentRoute).toBe('dataops');
    expect(useAppStore.getState().navigationIntent).toEqual({
      route: 'dataops',
      dataopsTab: 'anonymize',
      targetOrgId: 'org-uat',
    });
  });

  it('opens Masking with the objects of the last masking of the sandbox picked, and names them', () => {
    open(refreshedStatus({ maskObjects: { objects: ['Contact', 'Lead'], from: 'org' } }));
    expect(screen.getByTestId('recovery-mask-objects')).toHaveTextContent(
      'Opens with Contact, Lead picked: the objects of the last masking of UAT.',
    );
    fireEvent.click(screen.getByTestId('recovery-open-masking'));
    expect(useAppStore.getState().navigationIntent).toEqual({
      route: 'dataops',
      dataopsTab: 'anonymize',
      targetOrgId: 'org-uat',
      maskObjects: ['Contact', 'Lead'],
    });
  });

  it('says the objects come from the last masking on this machine when the sandbox had none', () => {
    open(refreshedStatus({ maskObjects: { objects: ['Case'], from: 'machine' } }));
    expect(screen.getByTestId('recovery-mask-objects')).toHaveTextContent(
      'Opens with Case picked: the objects of the last masking on this machine.',
    );
  });

  it('opens the replay of the checkpoint taken before the refresh', () => {
    open();
    fireEvent.click(screen.getByTestId('recovery-open-replay'));
    expect(useAppStore.getState().navigationIntent).toEqual({
      route: 'checkpoint',
      replayCheckpointId: 'ck-20261110-090000-a1b2',
      targetOrgId: 'org-uat',
    });
  });

  it('on a sandbox marked Staging, says the replay will ask for its name typed', () => {
    open(refreshedStatus({ tier: 'staging' }));
    expect(screen.getByTestId('recovery-replay-staging')).toHaveTextContent(
      'UAT is marked Staging: the replay asks you to type its name before it writes.',
    );
    expect(screen.getByTestId('recovery-open-replay')).toBeInTheDocument();
  });

  it('says why a refused step is refused, by its code', () => {
    open(refreshedStatus({ tier: 'staging' }, { frozen: { reason: 'stagingSandbox' } }));
    expect(screen.getByTestId('recovery-step-frozen-status')).toHaveTextContent('Refused');
    expect(screen.getByTestId('recovery-step-frozen-line')).toHaveTextContent(
      'UAT is marked Staging, where a frozen dataset is never loaded: replay a checkpoint instead.',
    );
    expect(screen.queryByTestId('recovery-open-load')).toBeNull();
  });

  it('opens the load of the frozen dataset with the sandbox as its target', () => {
    open();
    fireEvent.click(screen.getByTestId('recovery-open-load'));
    expect(useAppStore.getState().navigationIntent).toEqual({
      route: 'frozen',
      frozenTab: 'load',
      frozenTargetOrgId: 'org-uat',
    });
  });

  it('opens the take of Testers’ start, kept until deleted, named in the panel’s language', async () => {
    i18n.addResourceBundle('fr', 'translation', fr, true, true);
    await i18n.changeLanguage('fr');
    open();
    fireEvent.click(screen.getByTestId('recovery-take-testers'));
    expect(useAppStore.getState().navigationIntent).toEqual({
      route: 'checkpoint',
      takeCheckpoint: true,
      targetOrgId: 'org-uat',
      checkpointName: 'Départ des testeurs',
      checkpointKeepDays: 0,
    });
  });

  it('reads the deliverability alone, nothing kept, and links it to its Setup page', () => {
    open();
    fireEvent.click(screen.getByTestId('recovery-read-deliverability'));
    expect(host.current?.lastPayload('recovery:audit')).toEqual({
      orgId: 'org-uat',
      asked: { deliverability: true, schedules: false, endpoints: false },
      save: false,
    });
    act(() =>
      host.current?.answer('recovery:audit', 'recovery:audit:response', {
        orgId: 'org-uat',
        audit: auditOf(),
      }),
    );
    expect(
      within(step('deliverability')).getByTestId('recovery-audit-deliverability'),
    ).toHaveTextContent('UAT delivers every email');
    expect(screen.getByTestId('recovery-setup-deliverability')).toHaveAttribute(
      'href',
      'https://example--uat.sandbox.my.salesforce.com/lightning/setup/OrgEmailSettings/home',
    );
    expect(screen.getByTestId('recovery-read-deliverability')).toHaveTextContent('Read again');
  });

  it('keeps the inventory of the jobs it reads, which ends the step, and reads the status again', () => {
    open();
    expect(screen.getByTestId('recovery-step-scheduledJobs-line')).toHaveTextContent(
      /and keeps the one read now for the next refresh\.$/,
    );
    fireEvent.click(screen.getByTestId('recovery-read-scheduledJobs'));
    expect(host.current?.lastPayload('recovery:audit')).toEqual({
      orgId: 'org-uat',
      asked: { deliverability: false, schedules: true, endpoints: false },
      save: true,
    });
    act(() =>
      host.current?.answer('recovery:audit', 'recovery:audit:response', {
        orgId: 'org-uat',
        audit: auditOf(),
      }),
    );
    expect(within(step('scheduledJobs')).getByTestId('recovery-audit-job')).toHaveTextContent(
      'Nightly rollup',
    );
    expect(host.current?.sent('recovery:status')).toHaveLength(2);
  });

  it('reads the endpoints against production’s hosts it deduces', () => {
    open();
    fireEvent.click(screen.getByTestId('recovery-read-endpoints'));
    expect(host.current?.lastPayload('recovery:audit')).toEqual({
      orgId: 'org-uat',
      asked: {
        deliverability: false,
        schedules: false,
        endpoints: { productionHosts: [], fields: [] },
      },
      save: false,
    });
    act(() =>
      host.current?.answer('recovery:audit', 'recovery:audit:response', {
        orgId: 'org-uat',
        audit: auditOf(),
      }),
    );
    const found = within(step('endpoints')).getByTestId('recovery-audit-endpoint');
    expect(found).toHaveTextContent('Named Credential ERP: example.my.salesforce.com');
    expect(within(found).getByRole('link', { name: 'Open Setup: ERP' })).toHaveAttribute(
      'href',
      'https://example--uat.sandbox.my.salesforce.com/lightning/setup/NamedCredential/home',
    );
  });

  it('with no inventory of before, offers to keep one for the next refresh, and reads the status again', () => {
    open(
      refreshedStatus(
        { inventoryBefore: undefined },
        { scheduledJobs: { reason: 'noInventoryBefore' } },
      ),
    );
    expect(screen.queryByTestId('recovery-read-scheduledJobs')).toBeNull();
    fireEvent.click(screen.getByTestId('recovery-keep-inventory'));
    expect(host.current?.lastPayload('recovery:audit')).toEqual({
      orgId: 'org-uat',
      asked: { deliverability: false, schedules: true, endpoints: false },
      save: true,
    });
    act(() =>
      host.current?.answer('recovery:audit', 'recovery:audit:response', {
        orgId: 'org-uat',
        audit: auditOf(),
      }),
    );
    expect(host.current?.sent('recovery:status')).toHaveLength(2);
  });

  it('writes the handoff note, says where, reads the status again, and offers to write it anew', () => {
    open();
    fireEvent.click(screen.getByTestId('recovery-write-note'));
    expect(host.current?.lastPayload('recovery:handoff')).toEqual({ orgId: 'org-uat' });
    act(() =>
      host.current?.answer('recovery:handoff', 'recovery:handoff:response', {
        orgId: 'org-uat',
        path: '/home/someone/.sandforge/handoff/uat/note.md',
      }),
    );
    expect(screen.getByTestId('recovery-note-written')).toHaveTextContent(
      'Written to /home/someone/.sandforge/handoff/uat/note.md and opened in the editor.',
    );
    expect(screen.getByTestId('recovery-write-note')).toHaveTextContent(
      'Write it again and open it',
    );
    expect(host.current?.sent('recovery:status')).toHaveLength(2);
  });

  it('opens the note kept again as it was left, and offers to write it anew', () => {
    open(
      refreshedStatus(
        { handoffNote: { writtenAt: '2026-11-18T16:00:00.000Z' } },
        { handoff: { reason: 'ranAfterRefresh', at: '2026-11-18T16:00:00.000Z' } },
      ),
    );
    expect(screen.getByTestId('recovery-write-note')).toHaveTextContent(
      'Write it again and open it',
    );
    fireEvent.click(screen.getByTestId('recovery-open-note'));
    expect(host.current?.lastPayload('recovery:handoff:open')).toEqual({ orgId: 'org-uat' });
    expect(host.current?.sent('recovery:handoff')).toEqual([]);
    act(() =>
      host.current?.answer('recovery:handoff:open', 'recovery:handoff:open:response', {
        orgId: 'org-uat',
        path: '/home/someone/.sandforge/handoff/_recovery/note.md',
      }),
    );
    expect(screen.getByTestId('recovery-note-opened')).toHaveTextContent(
      'Opened /home/someone/.sandforge/handoff/_recovery/note.md in the editor.',
    );
  });

  it('says a note no longer kept, by its code, and that it can be written again', () => {
    open(refreshedStatus({ handoffNote: { writtenAt: '2026-11-18T16:00:00.000Z' } }));
    fireEvent.click(screen.getByTestId('recovery-open-note'));
    act(() =>
      host.current?.fail('recovery:handoff:open', {
        code: 'NOTE_NOT_FOUND',
        message: 'No handoff note of UAT is kept on this machine',
      }),
    );
    expect(screen.getByTestId('recovery-note-error')).toHaveTextContent(
      'The handoff note of UAT is no longer on this machine: write it again.',
    );
  });

  it('offers no Open while no note is kept', () => {
    open();
    expect(screen.queryByTestId('recovery-open-note')).toBeNull();
    expect(screen.getByTestId('recovery-write-note')).toHaveTextContent('Write the note');
  });

  it('keeps what the next refresh needs: a checkpoint Before refresh, kept until deleted, and the pipeline', () => {
    open();
    fireEvent.click(screen.getByTestId('recovery-before-beforeRefreshCheckpoint-action'));
    expect(useAppStore.getState().navigationIntent).toEqual({
      route: 'checkpoint',
      takeCheckpoint: true,
      targetOrgId: 'org-uat',
      checkpointName: 'Before refresh',
      checkpointKeepDays: 0,
    });
    fireEvent.click(screen.getByTestId('recovery-before-automation-action'));
    expect(useAppStore.getState().navigationIntent).toEqual({
      route: 'automation',
      automationTemplateId: 'tpl-sandbox-refresh',
    });
  });

  it('opens the users, which it reads then, for the list of the testers', () => {
    open();
    expect(host.current?.sent('recovery:users:list')).toEqual([]);
    fireEvent.click(screen.getByTestId('recovery-before-testersList-action'));
    expect(screen.getByTestId('recovery-users-toggle')).toHaveAttribute('aria-expanded', 'true');
    expect(host.current?.lastPayload('recovery:users:list')).toEqual({ orgId: 'org-uat' });
    act(() =>
      host.current?.answer('recovery:users:list', 'recovery:users:list:response', usersList()),
    );
    expect(screen.getByTestId('recovery-users')).toBeInTheDocument();
  });

  it('finishes the recovery, and says the launcher no longer leads with it', () => {
    open();
    expect(screen.queryByTestId('recovery-finished')).toBeNull();
    fireEvent.click(screen.getByTestId('recovery-finish'));
    expect(host.current?.lastPayload('recovery:ack')).toEqual({ orgId: 'org-uat', what: 'finish' });
    act(() =>
      host.current?.answer('recovery:ack', 'recovery:ack:response', {
        status: refreshedStatus({ finishedAt: '2026-11-18T17:00:00.000Z' }),
      }),
    );
    expect(screen.getByTestId('recovery-finished')).toHaveTextContent(
      'Finished: the launcher and Home no longer lead with UAT.',
    );
    expect(screen.queryByTestId('recovery-finish')).toBeNull();
  });

  it('opened again on a recovery finished, says when, and resumes it', () => {
    open(refreshedStatus({ finishedAt: '2026-11-18T17:00:00.000Z' }));
    expect(screen.getByTestId('recovery-finished-on')).toHaveTextContent(/^Finished on .*2026/);
    expect(screen.getByTestId('recovery-finished')).toBeInTheDocument();
    expect(screen.queryByTestId('recovery-finish')).toBeNull();
    fireEvent.click(screen.getByTestId('recovery-resume'));
    expect(host.current?.lastPayload('recovery:ack')).toEqual({ orgId: 'org-uat', what: 'resume' });
    act(() =>
      host.current?.answer('recovery:ack', 'recovery:ack:response', { status: refreshedStatus() }),
    );
    expect(screen.queryByTestId('recovery-finished-on')).toBeNull();
    expect(screen.getByTestId('recovery-finish')).toBeInTheDocument();
  });

  it('words a refused mark by its code', () => {
    open();
    fireEvent.click(screen.getByTestId('recovery-step-handoff-skip'));
    act(() =>
      host.current?.fail('recovery:ack', { code: 'ORG_NOT_FOUND', message: 'No such org' }),
    );
    expect(screen.getByTestId('recovery-ack-error')).toHaveTextContent(
      'UAT is no longer registered in SandForge: add it again on the Organizations page.',
    );
  });
});
