import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import '../../i18n';
import { useOrgStore } from '../../stores/useOrgStore';
import { useAppStore } from '../../stores/useAppStore';
import {
  developerOrg,
  fakeHost,
  listEntry,
  polyfillDialog,
  previewAnswer,
  productionOrg,
  readyCheckpoint,
  rewindResult,
  withoutUndo,
} from './testing/checkpointFixtures';
import type { FakeHost } from './testing/checkpointFixtures';

const host = vi.hoisted(() => ({ current: null as null | FakeHost }));

vi.mock('../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => host.current?.api,
  getVscodeApi: () => host.current?.api,
}));

import { CheckpointPage } from './CheckpointPage';

/** Answer the last `checkpoint:list` with `entries`. */
function answerList(entries = [listEntry()]): void {
  act(() =>
    host.current?.answer('checkpoint:list', 'checkpoint:list:response', { checkpoints: entries }),
  );
}

const ID = 'ck-20261020-140512-a1b2';

describe('CheckpointPage', () => {
  beforeEach(() => {
    host.current = fakeHost();
    polyfillDialog();
    useOrgStore.setState({ orgs: [developerOrg()], selectedOrgId: 'org-dev' });
    useAppStore.setState({ currentRoute: 'checkpoint', navigationIntent: null });
  });
  afterEach(() => {
    useOrgStore.setState({ orgs: [], selectedOrgId: null });
  });

  it('is named Checkpoints, with the sentence every surface says it in', () => {
    render(<CheckpointPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Checkpoints' })).toBeInTheDocument();
    expect(screen.getByTestId('page-header-subtitle').textContent).toBe(
      "Save the state of an org's data, and return the org to it later",
    );
  });

  it('lists the checkpoints of the org picked, asking only this machine', () => {
    render(<CheckpointPage />);
    expect(screen.getByTestId('checkpoint-list-loading')).toBeInTheDocument();
    expect(host.current?.lastPayload('checkpoint:list')).toEqual({ orgId: 'org-dev' });
    answerList();
    expect(screen.getByRole('heading', { name: 'Checkpoints of DEV-SB' })).toBeInTheDocument();
    expect(screen.getByTestId(`checkpoint-row-${ID}`)).toBeInTheDocument();
    // The list reads the store, never the org.
    expect(host.current?.sent('checkpoint:scope')).toEqual([]);
  });

  it('says there is no checkpoint of the org yet, and what one is for, with Take a checkpoint', async () => {
    render(<CheckpointPage />);
    answerList([]);
    expect(screen.getByText('No checkpoint of DEV-SB yet')).toBeInTheDocument();
    expect(
      screen.getByText(
        "Take one before a test session, a demo or a training. Rewind then returns DEV-SB's data to that moment, whoever changed it: it deletes the records created since, gives the records changed since their values back, and brings back the records deleted since.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('empty-action-button'));
    expect(await screen.findByTestId('checkpoint-take')).toBeInTheDocument();
    expect(host.current?.lastPayload('checkpoint:scope')).toEqual({
      orgId: 'org-dev',
      mode: 'everything',
    });
  });

  it('offers nothing on a production org, and says why', () => {
    useOrgStore.setState({ orgs: [productionOrg()], selectedOrgId: 'org-prod' });
    render(<CheckpointPage />);
    expect(screen.getByTestId('checkpoint-production').textContent).toBe(
      'Checkpoints are for sandboxes, scratch orgs and Developer Edition orgs: SandForge never takes a checkpoint of, or rewinds, a production org.',
    );
    expect(screen.queryByRole('button', { name: 'Take a checkpoint' })).toBeNull();
    expect(host.current?.sent('checkpoint:list')).toEqual([]);
  });

  it('reads a Developer Edition registered as Production as the development org it is', () => {
    useOrgStore.setState({
      orgs: [developerOrg({ orgType: 'Production' })],
      selectedOrgId: 'org-dev',
    });
    render(<CheckpointPage />);
    expect(screen.queryByTestId('checkpoint-production')).toBeNull();
    expect(host.current?.sent('checkpoint:list')).toHaveLength(1);
  });

  it('asks to connect an org when none is', () => {
    useOrgStore.setState({ orgs: [], selectedOrgId: null });
    render(<CheckpointPage />);
    expect(screen.getByText('Connect an org to take a checkpoint of it')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('empty-action-button'));
    expect(useAppStore.getState().currentRoute).toBe('orgs');
  });

  it('asks for an org when none is picked', () => {
    useOrgStore.setState({ orgs: [developerOrg()], selectedOrgId: null });
    render(<CheckpointPage />);
    expect(
      screen.getByText('Pick an org to see its checkpoints, or to take one.'),
    ).toBeInTheDocument();
    expect(host.current?.sent('checkpoint:list')).toEqual([]);
  });

  it('lists another org’s checkpoints once it is picked, never the first org’s under its name', () => {
    useOrgStore.setState({
      orgs: [
        developerOrg(),
        developerOrg({ id: 'org-scratch', alias: 'QA-SCRATCH', orgType: 'Scratch' }),
      ],
      selectedOrgId: 'org-dev',
    });
    render(<CheckpointPage />);
    answerList();
    fireEvent.click(screen.getByTestId('checkpoint-org'));
    fireEvent.click(screen.getByRole('button', { name: /QA-SCRATCH/ }));
    expect(useOrgStore.getState().selectedOrgId).toBe('org-scratch');
    expect(host.current?.lastPayload('org:select')).toEqual({ orgId: 'org-scratch' });
    expect(host.current?.lastPayload('checkpoint:list')).toEqual({ orgId: 'org-scratch' });
    expect(screen.queryByTestId(`checkpoint-row-${ID}`)).toBeNull();
    expect(screen.getByTestId('checkpoint-list-loading')).toBeInTheDocument();
  });

  it('deletes a checkpoint confirmed, lists the org again and keeps the keyboard in the list', () => {
    render(<CheckpointPage />);
    answerList();
    fireEvent.click(screen.getByTestId(`checkpoint-delete-${ID}`));
    fireEvent.click(screen.getByTestId('danger-confirm-btn'));
    expect(host.current?.lastPayload('checkpoint:delete')).toEqual({ checkpointIds: [ID] });
    expect(host.current?.sent('checkpoint:list')).toHaveLength(1);
    act(() =>
      host.current?.answer('checkpoint:delete', 'checkpoint:delete:response', { deleted: [ID] }),
    );
    expect(host.current?.sent('checkpoint:list')).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'Checkpoints of DEV-SB' })).toHaveFocus();
  });

  it('keeps a checkpoint until it is deleted, and lists the org again', () => {
    render(<CheckpointPage />);
    answerList();
    fireEvent.click(screen.getByTestId(`checkpoint-keep-${ID}`));
    expect(host.current?.lastPayload('checkpoint:keep')).toEqual({ checkpointId: ID, keep: true });
    act(() =>
      host.current?.answer('checkpoint:keep', 'checkpoint:keep:response', {
        checkpoint: readyCheckpoint({ expiresAt: null }),
      }),
    );
    expect(host.current?.sent('checkpoint:list')).toHaveLength(2);
  });

  it('renames a checkpoint, and lists the org again', () => {
    render(<CheckpointPage />);
    answerList();
    fireEvent.click(screen.getByTestId(`checkpoint-rename-${ID}`));
    fireEvent.change(screen.getByTestId('checkpoint-rename-input'), {
      target: { value: 'Before demo' },
    });
    fireEvent.click(screen.getByTestId('checkpoint-rename-save'));
    expect(host.current?.lastPayload('checkpoint:rename')).toEqual({
      checkpointId: ID,
      name: 'Before demo',
    });
    act(() =>
      host.current?.answer('checkpoint:rename', 'checkpoint:rename:response', {
        checkpoint: readyCheckpoint({ name: 'Before demo' }),
      }),
    );
    expect(host.current?.sent('checkpoint:list')).toHaveLength(2);
  });

  it('says a change the store refused, in its words', () => {
    render(<CheckpointPage />);
    answerList();
    fireEvent.click(screen.getByTestId(`checkpoint-keep-${ID}`));
    act(() =>
      host.current?.fail('checkpoint:keep', {
        message: 'This checkpoint is no longer on this machine.',
        code: 'NOT_FOUND',
      }),
    );
    expect(screen.getByTestId('checkpoint-change-error')).toHaveTextContent(
      'This checkpoint is no longer on this machine.',
    );
  });

  it('says a list that could not be read, and reads it again on Retry', () => {
    render(<CheckpointPage />);
    act(() =>
      host.current?.fail('checkpoint:list', {
        message: 'The store cannot be read.',
        code: 'STORE',
      }),
    );
    expect(screen.getByTestId('checkpoint-list-error')).toHaveTextContent(
      'The store cannot be read.',
    );
    fireEvent.click(screen.getByTestId('checkpoint-list-retry'));
    expect(host.current?.sent('checkpoint:list')).toHaveLength(2);
  });

  it('opens a take from the list, and comes back to the list read again once one is kept', async () => {
    render(<CheckpointPage />);
    answerList();
    fireEvent.click(screen.getByTestId('checkpoint-take-open'));
    const take = await screen.findByTestId('checkpoint-take');
    expect(
      within(take).getByRole('heading', { name: 'Take a checkpoint of DEV-SB' }),
    ).toHaveFocus();
    fireEvent.click(screen.getByTestId('checkpoint-take-cancel'));
    expect(screen.getByTestId(`checkpoint-row-${ID}`)).toBeInTheDocument();
  });

  it('opens what a rewind to a checkpoint would do from its row, and gives the keyboard back to it on Back', async () => {
    render(<CheckpointPage />);
    answerList();
    fireEvent.click(screen.getByTestId(`checkpoint-rewind-${ID}`));
    const preview = await screen.findByTestId('checkpoint-preview');
    expect(host.current?.lastPayload('checkpoint:preview')).toEqual({ checkpointId: ID });
    expect(within(preview).getByRole('heading', { level: 2 })).toHaveFocus();
    fireEvent.click(screen.getByTestId('checkpoint-preview-back'));
    expect(screen.getByTestId(`checkpoint-rewind-${ID}`)).toHaveFocus();
  });

  it('opens on the preview of the checkpoint Home’s Rewind… named, once the list says it is there', async () => {
    useAppStore.setState({
      currentRoute: 'checkpoint',
      navigationIntent: { route: 'checkpoint', previewCheckpointId: ID },
    });
    render(<CheckpointPage />);
    expect(useAppStore.getState().navigationIntent).toBeNull();
    expect(host.current?.sent('checkpoint:preview')).toEqual([]);
    answerList();
    expect(await screen.findByTestId('checkpoint-preview')).toBeInTheDocument();
    expect(host.current?.lastPayload('checkpoint:preview')).toEqual({ checkpointId: ID });
  });

  it('opens on the list when the checkpoint Home named is no longer there', () => {
    useAppStore.setState({
      currentRoute: 'checkpoint',
      navigationIntent: { route: 'checkpoint', previewCheckpointId: 'ck-20261019-090000-gone' },
    });
    render(<CheckpointPage />);
    answerList();
    expect(screen.getByTestId(`checkpoint-row-${ID}`)).toBeInTheDocument();
    expect(host.current?.sent('checkpoint:preview')).toEqual([]);
  });

  describe('a rewind, and its undo', () => {
    /** Open the preview of the checkpoint from its row, and answer it. */
    async function openPreview(): Promise<void> {
      fireEvent.click(screen.getByTestId(`checkpoint-rewind-${ID}`));
      await screen.findByTestId('checkpoint-preview');
      act(() =>
        host.current?.answer('checkpoint:preview', 'checkpoint:preview:response', previewAnswer()),
      );
    }

    /** Type the org's name in the confirmation open, and confirm it. */
    function confirmTyped(): void {
      fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'DEV-SB' } });
      fireEvent.click(screen.getByTestId('danger-confirm-btn'));
    }

    /** Rewind from the preview, confirmed, and wait for the run to show. */
    async function rewind(): Promise<void> {
      await openPreview();
      fireEvent.click(screen.getByTestId('checkpoint-preview-rewind'));
      confirmTyped();
      await screen.findByTestId('checkpoint-run');
    }

    it('rewinds once the org’s name is typed, with what the preview accepted, and shows the run', async () => {
      render(<CheckpointPage />);
      answerList();
      await openPreview();
      fireEvent.click(screen.getByTestId('checkpoint-preview-rewind'));
      expect(host.current?.sent('checkpoint:rewind')).toEqual([]);
      confirmTyped();
      expect(host.current?.lastPayload('checkpoint:rewind')).toEqual({
        checkpointId: ID,
        previewId: 'pv-1',
        acceptAutomation: false,
        acceptNoUndo: false,
        acceptOutside: false,
      });
      const run = await screen.findByTestId('checkpoint-run');
      expect(within(run).getByRole('heading', { level: 2 }).textContent).toBe(
        'Rewind of DEV-SB to “Before UAT”',
      );
      expect(screen.getByTestId('checkpoint-run-phase-delete').textContent).toBe(
        'Delete 8 records added since, children first',
      );
      expect(screen.queryByTestId('checkpoint-preview')).toBeNull();
    });

    it('says what the rewind did, reads the list again, and comes back to its Rewind… on Done', async () => {
      render(<CheckpointPage />);
      answerList();
      await rewind();
      const listed = host.current?.sent('checkpoint:list').length ?? 0;
      act(() =>
        host.current?.answer('checkpoint:rewind', 'checkpoint:rewind:response', {
          result: rewindResult(),
          operationId: 'op-rewind',
        }),
      );
      expect(await screen.findByTestId('checkpoint-result-headline')).toHaveTextContent(
        'DEV-SB is back at “Before UAT”.',
      );
      expect(host.current?.sent('checkpoint:list')).toHaveLength(listed + 1);
      fireEvent.click(screen.getByTestId('checkpoint-result-done'));
      answerList();
      expect(screen.getByTestId(`checkpoint-rewind-${ID}`)).toHaveFocus();
    });

    it('reads the org afresh on Rewind again, a rewind acting on a preview', async () => {
      render(<CheckpointPage />);
      answerList();
      await rewind();
      act(() =>
        host.current?.answer('checkpoint:rewind', 'checkpoint:rewind:response', {
          result: rewindResult({
            status: 'partial',
            residual: [
              { objectApiName: 'Account', reason: 'changedSincePreview', count: 3, ids: [] },
            ],
          }),
          operationId: 'op-rewind',
        }),
      );
      fireEvent.click(await screen.findByTestId('checkpoint-result-rewind-again'));
      expect(await screen.findByTestId('checkpoint-preview')).toBeInTheDocument();
      expect(host.current?.sent('checkpoint:preview')).toHaveLength(2);
    });

    it('undoes the rewind just made, typed, its automation accepted only when ticked', async () => {
      render(<CheckpointPage />);
      answerList();
      await rewind();
      act(() =>
        host.current?.answer('checkpoint:rewind', 'checkpoint:rewind:response', {
          result: rewindResult({
            undo: {
              until: '2026-11-06T14:02:00.000Z',
              cannot: [{ objectApiName: 'OpportunityLineItem', count: 3 }],
            },
          }),
          operationId: 'op-rewind',
        }),
      );
      fireEvent.click(await screen.findByTestId('checkpoint-result-undo-open'));
      expect(screen.getByTestId('danger-title').textContent).toBe(
        'Undo the last rewind of DEV-SB?',
      );
      expect(screen.getByTestId('checkpoint-undo-cannot').textContent).toBe(
        'Undo could not bring back 3 OpportunityLineItem records this rewind deleted: Salesforce undeletes them only with their parent record.',
      );
      const box = screen.getByRole('checkbox', {
        name: 'Undo even though DEV-SB runs automation as records are updated, deleted or brought back',
      });
      expect(box).not.toBeChecked();
      fireEvent.click(box);
      confirmTyped();
      expect(host.current?.lastPayload('checkpoint:undo')).toEqual({
        checkpointId: ID,
        rewindId: 'rw-20261022-140100-c3d4',
        acceptAutomation: true,
      });
      expect(await screen.findByRole('button', { name: 'Stop the undo' })).toBeInTheDocument();
      // An undo's own result carries no Undo.
      act(() =>
        host.current?.answer('checkpoint:undo', 'checkpoint:undo:response', {
          result: withoutUndo(rewindResult()),
          operationId: 'op-undo',
        }),
      );
      expect(await screen.findByTestId('checkpoint-result-headline')).toHaveTextContent(
        'DEV-SB is back as it was before its last rewind.',
      );
    });

    it('undoes the org’s last rewind from its line in the list, unticked', () => {
      render(<CheckpointPage />);
      answerList([
        listEntry(
          readyCheckpoint({
            lastRewind: {
              rewindId: 'rw-20261022-100000-beef',
              endedAt: '2026-10-22T12:05:00.000Z',
              undoUntil: '2026-11-06T10:05:00.000Z',
            },
          }),
          { undo: { rewindId: 'rw-20261022-100000-beef', until: '2026-11-06T10:05:00.000Z' } },
        ),
      ]);
      fireEvent.click(screen.getByTestId(`checkpoint-undo-${ID}`));
      expect(screen.queryByTestId('checkpoint-undo-cannot')).toBeNull();
      confirmTyped();
      expect(host.current?.lastPayload('checkpoint:undo')).toEqual({
        checkpointId: ID,
        rewindId: 'rw-20261022-100000-beef',
        acceptAutomation: false,
      });
    });

    it('stops comparing fields chosen from the list, and lists the org again', async () => {
      render(<CheckpointPage />);
      answerList();
      fireEvent.click(screen.getByTestId(`checkpoint-stop-comparing-${ID}`));
      fireEvent.click(await screen.findByTestId('checkpoint-stop-comparing-Contact.LastName'));
      fireEvent.click(screen.getByTestId('checkpoint-stop-comparing-save'));
      expect(host.current?.lastPayload('checkpoint:ignore-fields')).toEqual({
        checkpointId: ID,
        fields: ['Contact.LastName'],
      });
      act(() =>
        host.current?.answer('checkpoint:ignore-fields', 'checkpoint:ignore-fields:response', {
          checkpoint: readyCheckpoint({ ignoredFields: ['Contact.LastName'] }),
        }),
      );
      expect(host.current?.sent('checkpoint:list')).toHaveLength(2);
      expect(screen.queryByTestId('checkpoint-stop-comparing-fields')).toBeNull();
    });
  });

  it('opens on a take when Home asked for one, and clears the ask', async () => {
    useAppStore.setState({
      currentRoute: 'checkpoint',
      navigationIntent: { route: 'checkpoint', takeCheckpoint: true },
    });
    render(<CheckpointPage />);
    expect(await screen.findByTestId('checkpoint-take')).toBeInTheDocument();
    expect(useAppStore.getState().navigationIntent).toBeNull();
  });
});
