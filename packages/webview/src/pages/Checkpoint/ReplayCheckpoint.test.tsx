import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import '../../i18n';
import type {
  CheckpointListEntry,
  CheckpointReplaySummary,
  FrozenLoadPlanInfo,
  FrozenLoadReportInfo,
  FrozenReplayInfo,
  OrgCheckpoint,
} from '@sandforge/shared';
import { useOrgStore } from '../../stores/useOrgStore';
import {
  developerOrg,
  fakeHost,
  listEntry,
  polyfillDialog,
  readyCheckpoint,
} from './testing/checkpointFixtures';
import type { FakeHost } from './testing/checkpointFixtures';

const host = vi.hoisted(() => ({ current: null as null | FakeHost }));

vi.mock('../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => host.current?.api,
  getVscodeApi: () => host.current?.api,
}));

import { ReplayCheckpoint } from './ReplayCheckpoint';

const ID = 'ck-20261020-140512-a1b2';
const SOURCE = '00Dxx0000001234AAA';

/** The sandbox the page lists the checkpoint under: refreshed since, it is another org now. */
const DEV = developerOrg({ id: 'org-dev', alias: 'DEV-SB', orgType: 'Sandbox' });
/** A scratch org to replay into. */
const QA = developerOrg({
  id: 'org-qa',
  alias: 'QA',
  orgType: 'Scratch',
  orgId: '00D000000000022EAA',
});

/** A sandbox's checkpoint, with its data storage, or none before 1.81. */
function sandboxCheckpoint(dataStorageMaxMB?: number): OrgCheckpoint {
  const base = readyCheckpoint();
  return readyCheckpoint({
    org: {
      ...base.org,
      isSandbox: true,
      organizationType: 'Enterprise Edition',
      tier: 'sandbox',
      ...(dataStorageMaxMB !== undefined ? { dataStorageMaxMB } : {}),
    },
  });
}

type Entry = CheckpointListEntry & { checkpoint: OrgCheckpoint };

/** The checkpoint of the sandbox before its refresh. */
function refreshedEntry(
  checkpoint = sandboxCheckpoint(200),
  more: Partial<CheckpointListEntry> = {},
): Entry {
  return listEntry(checkpoint, {
    valid: false,
    why: 'refreshed',
    refreshedAt: '2026-10-21T08:00:00.000Z',
    ...more,
  }) as Entry;
}

/** What a simulation answers: Accounts and Contacts to create, the replay's summary beside. */
function planAnswer(): { plan: FrozenLoadPlanInfo; replay: FrozenReplayInfo } {
  const summary: CheckpointReplaySummary = {
    records: { toCreate: 2412, linkedById: 0, linkedByKey: 0, refusedBeforeWrite: 0 },
    owners: {
      kept: 0,
      toRunningUser: 2412,
      reasons: { notInTarget: 2412, inactive: 0, queueMissing: 0 },
    },
    recordTypes: [],
    notReplayed: [{ object: 'ContentDocument', records: 2, reason: 'fileContentNotKept' }],
    lookupsEmptied: [],
    refused: [],
    fieldsNotInTarget: [],
    currencies: { refused: [] },
    masked: { fields: [] },
    contactPoints: 'neutralized',
    degraded: [],
    auditDates: 'new',
  };
  return {
    plan: {
      orgId: 'org-dev',
      mode: { pilot: false, reload: false },
      plannedAt: '2026-10-22T14:06:00.000Z',
      perObject: [
        {
          objectApiName: 'Account',
          fromFiles: 400,
          toInsert: 400,
          reusedByKeys: 0,
          reusedFromCatalog: 0,
          fieldsDropped: 0,
          picklistsRewritten: 0,
          notSent: 0,
          toPurge: 0,
          toDeactivate: 0,
        },
        {
          objectApiName: 'Contact',
          fromFiles: 2012,
          toInsert: 2012,
          reusedByKeys: 0,
          reusedFromCatalog: 0,
          fieldsDropped: 1,
          picklistsRewritten: 0,
          notSent: 0,
          toPurge: 0,
          toDeactivate: 0,
        },
      ],
      excludedObjects: [],
      removals: [],
      placeholders: [],
      requiredDefaults: [],
      recordTypeIssues: 0,
      personContacts: 0,
      earlierLoads: 0,
    },
    replay: {
      checkpoint: {
        checkpointId: ID,
        name: 'Before UAT',
        organizationId: SOURCE,
        takenAt: '2026-10-20T14:06:03.000Z',
        tier: 'sandbox',
        annex: true,
      },
      target: { organizationId: '00D000000000044EAA', name: 'DEV-SB' },
      choices: {
        owners: 'same',
        customSettings: false,
        mask: false,
        contactPoints: 'neutralized',
        objects: [],
        excluded: [],
        link: [],
      },
      summary,
      filesLeft: [{ objectApiName: 'ContentDocument', name: 'Quote.pdf' }],
      requests: 5,
    },
  };
}

/** What a replay's load answers once it wrote everything. */
function reportAnswer(): { report: FrozenLoadReportInfo; replay: FrozenReplayInfo } {
  const { replay } = planAnswer();
  return {
    report: {
      status: 'completed',
      orgId: 'org-dev',
      mode: { pilot: false, reload: false },
      startedAt: '2026-10-22T14:07:00.000Z',
      durationMs: 9000,
      alignment: { excludedObjects: [], removals: [], adjustments: [], recordTypeIssues: [] },
      placeholders: [],
      requiredDefaults: [],
      perObject: [
        {
          objectApiName: 'Account',
          fromFiles: 400,
          inserted: 400,
          reused: 0,
          skippedDuplicates: [],
          failed: [],
        },
        {
          objectApiName: 'Contact',
          fromFiles: 2012,
          inserted: 2012,
          reused: 0,
          skippedDuplicates: [],
          failed: [],
        },
      ],
      pass2: { resolved: 0, unresolved: [] },
      personContact: { restored: 0, unresolved: [] },
      purge: { deleted: {}, deactivated: {}, failures: [] },
      mappingPath: 'mapping',
      contractPath: 'contract',
    },
    replay,
  };
}

function renderReplay(entry: Entry = refreshedEntry(), more: { onRewind?: () => void } = {}) {
  const onClose = vi.fn();
  const onChanged = vi.fn();
  render(
    <ReplayCheckpoint org={DEV} entry={entry} onClose={onClose} onChanged={onChanged} {...more} />,
  );
  return { onClose, onChanged };
}

/** Answer the page's last simulation. */
function answerPlan(answer = planAnswer()): void {
  act(() => host.current?.answer('frozen:load:preview', 'frozen:load:preview:response', answer));
}

describe('ReplayCheckpoint', () => {
  beforeEach(() => {
    host.current = fakeHost();
    polyfillDialog();
    useOrgStore.setState({ orgs: [DEV, QA], selectedOrgId: 'org-dev' });
  });
  afterEach(() => {
    useOrgStore.setState({ orgs: [], selectedOrgId: null });
  });

  it('opens on the sandbox the checkpoint was of, refreshed since, and says what a replay creates and never touches', () => {
    renderReplay();
    expect(
      screen.getByRole('heading', { name: 'Replay “Before UAT” in another org' }),
    ).toHaveFocus();
    expect(screen.getByTestId('checkpoint-replay-refreshed').textContent).toBe(
      'DEV-SB is the sandbox this checkpoint was taken of, refreshed on Oct 21, 2026: its records come back into it with new Ids.',
    );
    expect(screen.getByTestId('checkpoint-replay-intro').textContent).toBe(
      'Replaying creates in DEV-SB a copy of the records of this checkpoint, parents before children, with new Ids. Nothing DEV-SB holds is changed or deleted. A checkpoint keeps no file’s content: files do not follow. A replay can be removed.',
    );
    expect(screen.getByTestId('checkpoint-replay-mask')).not.toBeChecked();
  });

  it('replays only after a simulation of the same choices, and asks for another once one changes', () => {
    renderReplay();
    expect(screen.getByTestId('checkpoint-replay-run')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('checkpoint-replay-hint').textContent).toBe(
      'Simulate first: nothing is written to DEV-SB until a simulation of these choices says what the replay does.',
    );

    fireEvent.click(screen.getByTestId('checkpoint-replay-simulate'));
    expect(host.current?.lastPayload('frozen:load:preview')).toEqual({
      targetOrgId: 'org-dev',
      replay: {
        organizationId: SOURCE,
        checkpointId: ID,
        choices: {
          owners: 'same',
          customSettings: false,
          mask: false,
          contactPoints: 'neutralized',
          objects: [],
          excluded: [],
          link: [],
        },
      },
    });
    answerPlan();
    expect(screen.getByTestId('checkpoint-replay-run')).not.toHaveAttribute('aria-disabled');
    expect(screen.getByTestId('checkpoint-replay-plan-line-records').textContent).toBe(
      'Creates copies of 2,412 of its records in DEV-SB, parents first, with new Ids; nothing DEV-SB holds is changed or deleted.',
    );
    expect(screen.getByTestId('checkpoint-replay-plan-line-files-left').textContent).toContain(
      'Quote.pdf (ContentDocument)',
    );
    expect(screen.getByTestId('checkpoint-replay-plan-object-Contact').textContent).toBe(
      'Contact2,012010',
    );

    fireEvent.click(screen.getByTestId('checkpoint-replay-owners-me'));
    expect(screen.getByTestId('checkpoint-replay-run')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('checkpoint-replay-hint').textContent).toBe(
      'The choices changed since the simulation: simulate again before replaying into DEV-SB.',
    );
    expect(screen.queryByTestId('checkpoint-replay-plan')).toBeNull();
    expect(host.current?.sent('frozen:load')).toEqual([]);
  });

  it('holds the replay to the records its simulation counted, follows it, and says what it did', () => {
    const { onChanged } = renderReplay();
    fireEvent.click(screen.getByTestId('checkpoint-replay-object-Contact'));
    fireEvent.click(screen.getByTestId('checkpoint-replay-mute-toggle'));
    fireEvent.click(screen.getByTestId('checkpoint-replay-simulate'));
    answerPlan();
    fireEvent.click(screen.getByTestId('checkpoint-replay-run'));

    expect(host.current?.lastPayload('frozen:load')).toEqual({
      targetOrgId: 'org-dev',
      replay: {
        organizationId: SOURCE,
        checkpointId: ID,
        choices: expect.objectContaining({ excluded: ['Contact'] }),
      },
      muteAutomation: true,
      maxRecords: 2412,
    });
    act(() =>
      host.current?.push('frozen:load:progress', {
        phase: 'insert',
        objectName: 'Account',
        status: 'started',
        progress: 40,
        message: 'host words',
      }),
    );
    expect(screen.getByTestId('checkpoint-replay-running').textContent).toContain(
      'Replaying into DEV-SB…',
    );
    act(() => host.current?.answer('frozen:load', 'frozen:load:response', reportAnswer()));
    expect(screen.getByTestId('checkpoint-replay-result-status').textContent).toBe(
      'The replay wrote what it was to.',
    );
    expect(screen.getByTestId('checkpoint-replay-result-object-Contact').textContent).toBe(
      'Contact2,01200',
    );
    expect(onChanged).toHaveBeenCalled();
  });

  it('says a refusal for real data in its own words, and the box that lifts it masks the next simulation', () => {
    renderReplay(refreshedEntry(sandboxCheckpoint(5120)));
    // Ticked for the person: unticked, the extension refuses it.
    expect(screen.getByTestId('checkpoint-replay-mask')).toBeChecked();
    expect(screen.getByTestId('checkpoint-replay-mask-why').textContent).toBe(
      'This checkpoint is of a Partial Copy or Full sandbox (5,120 MB of data storage): it may hold real data, and goes into another org masked only.',
    );
    fireEvent.click(screen.getByTestId('checkpoint-replay-mask'));
    fireEvent.click(screen.getByTestId('checkpoint-replay-simulate'));
    act(() =>
      host.current?.answer('frozen:load:preview', 'frozen:load:preview:error', {
        code: 'REPLAY_REAL_DATA',
        message: 'host words',
        retryable: false,
        params: { checkpoint: 'Before UAT', target: 'DEV-SB', why: 'storage', mb: 5120 },
      }),
    );
    expect(screen.getByTestId('checkpoint-replay-refused').textContent).toContain(
      'This checkpoint is of a Partial Copy or Full sandbox (5120 MB of data storage): it may hold real data, goes into another org masked only, and nothing was written. Tick Mask personal data, then simulate again.',
    );
    fireEvent.click(screen.getByTestId('checkpoint-replay-mask'));
    fireEvent.click(screen.getByTestId('checkpoint-replay-simulate'));
    expect(
      (host.current?.lastPayload('frozen:load:preview')?.replay as { choices: { mask: boolean } })
        .choices.mask,
    ).toBe(true);
  });

  it('lets a sandbox’s checkpoint that does not say go unmasked on the person’s word, which it sends', () => {
    renderReplay(refreshedEntry(sandboxCheckpoint()));
    expect(screen.getByTestId('checkpoint-replay-mask')).toBeChecked();
    expect(screen.queryByTestId('checkpoint-replay-no-real-data')).toBeNull();
    fireEvent.click(screen.getByTestId('checkpoint-replay-mask'));
    fireEvent.click(screen.getByTestId('checkpoint-replay-no-real-data'));
    fireEvent.click(screen.getByTestId('checkpoint-replay-simulate'));
    expect(
      (
        host.current?.lastPayload('frozen:load:preview')?.replay as {
          choices: Record<string, unknown>;
        }
      ).choices,
    ).toMatchObject({ mask: false, noRealData: true });
  });

  it('never offers the org a checkpoint still rewinds, and a refusal for its own org leads to Rewind…', () => {
    const onRewind = vi.fn();
    renderReplay(listEntry(sandboxCheckpoint(200)) as Entry, { onRewind });
    expect(screen.getByTestId('checkpoint-replay-own').textContent).toBe(
      'DEV-SB is not offered: this checkpoint is of it, and Rewind brings it back to that moment.',
    );
    expect(screen.getByTestId('checkpoint-replay-simulate')).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    fireEvent.click(screen.getByTestId('checkpoint-replay-target'));
    expect(screen.getByTestId('checkpoint-replay-target-option-org-dev')).toBeDisabled();
    fireEvent.click(screen.getByTestId('checkpoint-replay-target-option-org-qa'));
    fireEvent.click(screen.getByTestId('checkpoint-replay-simulate'));
    expect(host.current?.lastPayload('frozen:load:preview')?.targetOrgId).toBe('org-qa');
    act(() =>
      host.current?.answer('frozen:load:preview', 'frozen:load:preview:error', {
        code: 'REPLAY_SAME_ORG',
        message: 'host words',
        retryable: false,
        params: { checkpoint: 'Before UAT', target: 'QA' },
      }),
    );
    expect(screen.getByTestId('checkpoint-replay-refused').textContent).toContain(
      'QA is the org this checkpoint was taken of',
    );
    fireEvent.click(screen.getByTestId('checkpoint-replay-rewind-instead'));
    expect(onRewind).toHaveBeenCalledTimes(1);
  });

  it('lists the checkpoint’s replays, and takes back the one in the org picked from its own mapping', () => {
    const entry = refreshedEntry(sandboxCheckpoint(200), {
      replays: [
        {
          target: { organizationId: '00D000000000044EAA', name: 'DEV-SB', orgId: 'org-dev' },
          replayedAt: '2026-10-22T10:00:00.000Z',
          inPlace: 2412,
          records: {
            orgId: 'org-dev',
            loadedAt: '2026-10-22T10:00:00.000Z',
            created: [
              { objectApiName: 'Contact', count: 2012 },
              { objectApiName: 'Account', count: 400 },
            ],
            linked: 0,
            recorded: true,
          },
        },
      ],
    });
    renderReplay(entry);
    expect(screen.getByTestId('checkpoint-replay-replays-00D000000000044EAA').textContent).toBe(
      'DEV-SB, replayed on Oct 22, 2026: 2,412 records still there.',
    );
    expect(screen.getByTestId('checkpoint-replay-replace')).not.toBeChecked();
    fireEvent.click(screen.getByTestId('frozen-removal-remove'));
    fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'DEV-SB' } });
    fireEvent.click(screen.getByTestId('danger-confirm-btn'));
    expect(host.current?.lastPayload('frozen:remove')).toEqual({
      targetOrgId: 'org-dev',
      loadedAt: '2026-10-22T10:00:00.000Z',
      replay: { organizationId: SOURCE, checkpointId: ID },
    });
  });

  it('verifies the last replay into the org picked, against its own contract', () => {
    renderReplay(
      refreshedEntry(sandboxCheckpoint(200), {
        replays: [
          {
            target: { organizationId: '00D000000000044EAA', name: 'DEV-SB', orgId: 'org-dev' },
            inPlace: 1,
            records: {
              orgId: 'org-dev',
              loadedAt: '2026-10-22T10:00:00.000Z',
              created: [{ objectApiName: 'Account', count: 1 }],
              linked: 0,
              recorded: true,
            },
          },
        ],
      }),
    );
    fireEvent.click(screen.getByTestId('checkpoint-replay-verify'));
    expect(host.current?.lastPayload('frozen:verify')).toEqual({
      targetOrgId: 'org-dev',
      replay: { organizationId: SOURCE, checkpointId: ID },
    });
    act(() =>
      host.current?.answer('frozen:verify', 'frozen:verify:result', {
        verdict: {
          status: 'passed',
          checks: [],
          attempts: 1,
          measuredAt: '2026-10-22T10:01:00.000Z',
        },
      }),
    );
    expect(screen.getByTestId('checkpoint-replay-verdict').textContent).toBe(
      'Verified: DEV-SB holds every record the replay says it wrote.',
    );
  });
});
