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
  productionOrg,
  readyCheckpoint,
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
