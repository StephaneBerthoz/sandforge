import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { RunCheckpointTaken } from '@sandforge/shared';
import '../../i18n';
import { useOrgStore } from '../../stores/useOrgStore';
import { useAppStore } from '../../stores/useAppStore';
import {
  developerOrg,
  fakeHost,
  productionOrg,
} from '../../pages/Checkpoint/testing/checkpointFixtures';
import type { FakeHost } from '../../pages/Checkpoint/testing/checkpointFixtures';

const host = vi.hoisted(() => ({ current: null as null | FakeHost }));

vi.mock('../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => host.current?.api,
  getVscodeApi: () => host.current?.api,
}));

import { RewindBeforeRun, namedObjects } from './RewindBeforeRun';

const TAKEN: RunCheckpointTaken = {
  state: 'taken',
  checkpointId: 'ck-20261101-101540-a1b2',
  name: 'Before Forge run 2026-11-01 10:15 UTC',
  takenAt: '2026-11-01T10:15:40.000Z',
  expiresAt: '2026-11-08T10:15:40.000Z',
  objects: ['Account', 'Contact'],
  records: 38,
  bytes: 2_100_000,
  requests: 66,
  added: [],
  notHeld: [{ objectApiName: 'FeedItem', reason: 'Chatter posts.' }],
};

describe('RewindBeforeRun', () => {
  beforeEach(() => {
    host.current = fakeHost();
    useOrgStore.setState({
      orgs: [developerOrg({ id: 'org-other', alias: 'OTHER-SB' }), developerOrg(), productionOrg()],
      selectedOrgId: 'org-other',
    });
    useAppStore.setState({ currentRoute: 'forge', navigationIntent: null });
  });
  afterEach(() => {
    useOrgStore.setState({ orgs: [], selectedOrgId: null });
  });

  it('names the checkpoint, what it holds and until when', () => {
    render(<RewindBeforeRun checkpoint={TAKEN} orgId="org-dev" beside="run" testId="back" />);
    const taken = screen.getByTestId('back-taken');
    expect(taken).toHaveTextContent(
      'Checkpoint taken first: “Before Forge run 2026-11-01 10:15 UTC”, 38 records of Account and Contact.',
    );
    expect(taken).toHaveTextContent(/Kept on this machine until 2026-11-08 \d\d:\d\d\./);
  });

  it('says one record, and a checkpoint kept until it is deleted', () => {
    render(
      <RewindBeforeRun
        checkpoint={{ ...TAKEN, records: 1, expiresAt: null }}
        orgId="org-dev"
        beside="run"
        testId="back"
      />,
    );
    expect(screen.getByTestId('back-taken')).toHaveTextContent('1 record of Account and Contact.');
    expect(screen.getByTestId('back-taken')).toHaveTextContent(
      'Kept on this machine until it is deleted.',
    );
  });

  it('opens the preview of a rewind to it, on the org the run wrote to, selected everywhere first', () => {
    render(<RewindBeforeRun checkpoint={TAKEN} orgId="org-dev" beside="run" testId="back" />);
    fireEvent.click(screen.getByRole('button', { name: 'Rewind to before this run…' }));
    expect(useAppStore.getState().currentRoute).toBe('checkpoint');
    expect(useAppStore.getState().navigationIntent).toEqual({
      route: 'checkpoint',
      previewCheckpointId: 'ck-20261101-101540-a1b2',
      targetOrgId: 'org-dev',
    });
    expect(useOrgStore.getState().selectedOrgId).toBe('org-dev');
    expect(host.current?.lastPayload('org:select')).toEqual({ orgId: 'org-dev' });
  });

  it('says what the rewind does beside the removal, the checkpoint’s objects named', () => {
    render(<RewindBeforeRun checkpoint={TAKEN} orgId="org-dev" beside="run" testId="back" />);
    expect(screen.getByTestId('back-beside')).toHaveTextContent(
      'Removing this run takes back what the run wrote, and nothing else. Rewinding to before this run returns Account and Contact of DEV-SB to how they were at',
    );
    expect(screen.getByTestId('back-beside')).toHaveTextContent(
      "what anyone, and the target's automation, did there since goes too.",
    );
  });

  it('says of a run with no removal that this is the way back, and what stays', () => {
    render(<RewindBeforeRun checkpoint={TAKEN} orgId="org-dev" beside="none" testId="back" />);
    expect(screen.getByTestId('back-beside')).toHaveTextContent(
      'An Autopilot run has no removal: rewinding to this checkpoint is the way back.',
    );
    expect(screen.getByTestId('back-beside')).toHaveTextContent(
      'what the checkpoint does not hold of the run stays',
    );
  });

  it('speaks of a load, on the load’s result', () => {
    render(<RewindBeforeRun checkpoint={TAKEN} orgId="org-dev" beside="load" testId="back" />);
    expect(screen.getByRole('button', { name: 'Rewind to before this load…' })).toBeVisible();
    expect(screen.getByTestId('back-beside')).toHaveTextContent('Removing this load takes back');
  });

  it('names what it does not hold', () => {
    render(<RewindBeforeRun checkpoint={TAKEN} orgId="org-dev" beside="run" testId="back" />);
    expect(screen.getByTestId('back-not-held')).toHaveTextContent(
      'Not in the checkpoint, left as they are by a rewind: FeedItem.',
    );
  });

  it('keeps to the checkpoint and the way to it on a history line', () => {
    render(
      <RewindBeforeRun checkpoint={TAKEN} orgId="org-dev" beside="run" compact testId="back" />,
    );
    expect(screen.getByTestId('back-taken')).toBeVisible();
    expect(screen.queryByTestId('back-beside')).toBeNull();
    expect(screen.getByTestId('back-action')).toBeVisible();
  });

  it('says what a rewind takes that a removal left', () => {
    render(
      <RewindBeforeRun
        checkpoint={TAKEN}
        orgId="org-dev"
        beside="run"
        compact
        leftByRemoval
        testId="back"
      />,
    );
    expect(screen.getByTestId('back-after-removal')).toHaveTextContent(
      'What the removal kept, a rewind to this checkpoint takes back.',
    );
  });

  it('says a run that wrote nothing deleted its checkpoint, with no way to a rewind', () => {
    render(
      <RewindBeforeRun
        checkpoint={{ state: 'deleted', deleted: 'nothingWritten' }}
        orgId="org-dev"
        beside="run"
        testId="back"
      />,
    );
    expect(screen.getByTestId('back-deleted')).toHaveTextContent(
      'The checkpoint taken before the run was deleted: the run wrote nothing.',
    );
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('says so of a load too', () => {
    render(
      <RewindBeforeRun
        checkpoint={{ state: 'deleted', deleted: 'nothingWritten' }}
        orgId="org-dev"
        beside="load"
        testId="back"
      />,
    );
    expect(screen.getByTestId('back-deleted')).toHaveTextContent(
      'The checkpoint taken before the load was deleted: the load wrote nothing.',
    );
  });

  it('says nothing of a run that took none', () => {
    const { container } = render(
      <RewindBeforeRun checkpoint={undefined} orgId="org-dev" beside="run" testId="back" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('names the checkpoint and offers no rewind of an org it would be refused on, gone, or expired', () => {
    useOrgStore.setState({
      orgs: [developerOrg({ status: 'error' }), productionOrg()],
      selectedOrgId: 'org-dev',
    });
    const { rerender } = render(
      <RewindBeforeRun checkpoint={TAKEN} orgId="org-dev" beside="run" testId="back" />,
    );
    expect(screen.getByTestId('back-taken')).toBeVisible();
    expect(screen.queryByTestId('back-action')).toBeNull();
    rerender(<RewindBeforeRun checkpoint={TAKEN} orgId="org-prod" beside="run" testId="back" />);
    expect(screen.queryByTestId('back-action')).toBeNull();
    rerender(<RewindBeforeRun checkpoint={TAKEN} orgId="org-gone" beside="run" testId="back" />);
    expect(screen.queryByTestId('back-action')).toBeNull();
  });

  it('reads the button with what it opens', () => {
    render(<RewindBeforeRun checkpoint={TAKEN} orgId="org-dev" beside="run" testId="back" />);
    expect(screen.getByTestId('back-action')).toHaveAccessibleDescription(
      expect.stringContaining('Removing this run takes back what the run wrote'),
    );
  });
});

describe('namedObjects', () => {
  const t = (key: string, options?: Record<string, unknown>): string =>
    ({
      'common.list.separator': ', ',
      'common.list.and': ' and ',
      'runResults.checkpoint.moreObjects': `${String(options?.formatted)} other objects`,
    })[key] ?? key;

  it('names five objects and how many more', () => {
    expect(namedObjects(['A', 'B', 'C', 'D', 'E'], t)).toBe('A, B, C, D and E');
    expect(namedObjects(['A', 'B', 'C', 'D', 'E', 'F', 'G'], t)).toBe(
      'A, B, C, D, E and 2 other objects',
    );
  });
});
