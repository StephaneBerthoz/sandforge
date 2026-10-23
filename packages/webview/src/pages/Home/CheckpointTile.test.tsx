import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import '../../i18n';
import { useAppStore } from '../../stores/useAppStore';
import {
  developerOrg,
  fakeHost,
  listEntry,
  productionOrg,
  readyCheckpoint,
} from '../Checkpoint/testing/checkpointFixtures';
import type { FakeHost } from '../Checkpoint/testing/checkpointFixtures';

const host = vi.hoisted(() => ({ current: null as null | FakeHost }));

vi.mock('../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => host.current?.api,
  getVscodeApi: () => host.current?.api,
}));

import { CheckpointTile } from './CheckpointTile';

/** Answer the tile's `checkpoint:list` with `entries`. */
function answerList(entries = [listEntry()]): void {
  act(() =>
    host.current?.answer('checkpoint:list', 'checkpoint:list:response', { checkpoints: entries }),
  );
}

describe('CheckpointTile', () => {
  beforeEach(() => {
    host.current = fakeHost();
    useAppStore.setState({ currentRoute: 'home', navigationIntent: null });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-22T14:06:03.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('names the org’s latest checkpoint and its age, and opens its preview on Rewind…', () => {
    render(<CheckpointTile org={developerOrg()} />);
    expect(host.current?.lastPayload('checkpoint:list')).toEqual({ orgId: 'org-dev' });
    answerList([
      listEntry(
        readyCheckpoint({
          checkpointId: 'ck-20261021-090000-0001',
          name: 'Broken',
          status: 'failed',
        }),
        {
          valid: false,
          why: 'failed',
        },
      ),
      listEntry(),
    ]);
    expect(screen.getByTestId('checkpoint-tile-latest').textContent).toBe(
      'Last checkpoint: “Before UAT”, 2 days ago',
    );
    fireEvent.click(screen.getByTestId('checkpoint-tile-rewind'));
    expect(useAppStore.getState().currentRoute).toBe('checkpoint');
    // On the preview of the latest it named, the usable one.
    expect(useAppStore.getState().navigationIntent).toEqual({
      route: 'checkpoint',
      previewCheckpointId: 'ck-20261020-140512-a1b2',
    });
  });

  it('offers to take a checkpoint of an org that has none, opening Checkpoints on the take', () => {
    render(<CheckpointTile org={developerOrg()} />);
    answerList([]);
    expect(screen.getByTestId('checkpoint-tile-none').textContent).toBe(
      'Take a checkpoint of DEV-SB before your next test session',
    );
    fireEvent.click(screen.getByTestId('checkpoint-tile-take'));
    expect(useAppStore.getState().navigationIntent).toEqual({
      route: 'checkpoint',
      takeCheckpoint: true,
    });
  });

  it('says a checkpoint expires within three days, and keeps it on Keep', () => {
    render(<CheckpointTile org={developerOrg()} />);
    answerList([
      listEntry(
        readyCheckpoint({ name: 'Clean baseline', expiresAt: '2026-10-24T14:06:03.000Z' }),
        {
          expiresSoon: true,
        },
      ),
    ]);
    expect(screen.getByTestId('checkpoint-tile-expiring').textContent).toContain(
      '“Clean baseline” expires in 2 days',
    );
    fireEvent.click(screen.getByTestId('checkpoint-tile-keep'));
    expect(host.current?.lastPayload('checkpoint:keep')).toEqual({
      checkpointId: 'ck-20261020-140512-a1b2',
      keep: true,
    });
    act(() =>
      host.current?.answer('checkpoint:keep', 'checkpoint:keep:response', {
        checkpoint: readyCheckpoint({ expiresAt: null }),
      }),
    );
    expect(host.current?.sent('checkpoint:list')).toHaveLength(2);
  });

  it('says nothing of a checkpoint that does not expire soon', () => {
    render(<CheckpointTile org={developerOrg()} />);
    answerList();
    expect(screen.queryByTestId('checkpoint-tile-expiring')).toBeNull();
  });

  it('shows nothing for a production org, and asks nothing', () => {
    const { container } = render(<CheckpointTile org={productionOrg()} />);
    expect(container).toBeEmptyDOMElement();
    expect(host.current?.sent('checkpoint:list')).toEqual([]);
  });

  it('shows nothing for an org that is not connected, nor with no org', () => {
    const { container, rerender } = render(
      <CheckpointTile org={developerOrg({ status: 'expired' })} />,
    );
    expect(container).toBeEmptyDOMElement();
    rerender(<CheckpointTile org={undefined} />);
    expect(container).toBeEmptyDOMElement();
    expect(host.current?.sent('checkpoint:list')).toEqual([]);
  });

  it('shows nothing until the list answers, nor when it cannot be read', () => {
    const { container } = render(<CheckpointTile org={developerOrg()} />);
    expect(container).toBeEmptyDOMElement();
    act(() =>
      host.current?.fail('checkpoint:list', {
        message: 'The store cannot be read.',
        code: 'STORE',
      }),
    );
    expect(container).toBeEmptyDOMElement();
  });
});
