import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { developerOrg, previewDiff, readyCheckpoint } from './testing/checkpointFixtures';

/**
 * When the take, the preview, the run and the choice of fields load. Each
 * stand-in notes when its module is evaluated: a page that imported one up
 * front would parse what a take asks, a preview shows or a rewind says it did
 * before its list painted.
 */
const evaluated = vi.hoisted(() => new Set<string>());

/** The take's chunk could not be fetched, as on a remote window that dropped. */
const takeUnreadable = vi.hoisted(() => ({ value: false }));

vi.mock('./TakeCheckpoint', () => {
  evaluated.add('TakeCheckpoint');
  return {
    TakeCheckpoint: ({ org }: { org: { alias: string } }) => {
      if (takeUnreadable.value) {
        throw new TypeError(
          'Failed to fetch dynamically imported module: https://file+.vscode-resource.vscode-cdn.net/x/assets/chunks/TakeCheckpoint-a1.js',
        );
      }
      return <div data-testid="take-stand-in">{org.alias}</div>;
    },
  };
});

vi.mock('./RewindPreview', () => {
  evaluated.add('RewindPreview');
  return {
    RewindPreview: ({ checkpoint }: { checkpoint: { name: string } }) => (
      <div data-testid="preview-stand-in">{checkpoint.name}</div>
    ),
  };
});

vi.mock('./RewindRun', () => {
  evaluated.add('RewindRun');
  return {
    RewindRun: ({ orgName }: { orgName: string }) => (
      <div data-testid="run-stand-in">{orgName}</div>
    ),
  };
});

vi.mock('./StopComparingFields', () => {
  evaluated.add('StopComparingFields');
  return {
    StopComparingFields: ({ checkpoint }: { checkpoint: { name: string } }) => (
      <div data-testid="stop-comparing-stand-in">{checkpoint.name}</div>
    ),
  };
});

import { RewindPreview, RewindRun, StopComparingFields, TakeCheckpoint } from './checkpointParts';

describe('the parts of the Checkpoints page loaded on demand', () => {
  it('loads the take the first time it is shown, with the props it was given', async () => {
    expect([...evaluated]).toEqual([]);
    render(<TakeCheckpoint org={developerOrg()} onClose={vi.fn()} onTaken={vi.fn()} />);
    expect((await screen.findByTestId('take-stand-in')).textContent).toBe('DEV-SB');
    expect([...evaluated]).toEqual(['TakeCheckpoint']);
  });

  it('loads the preview the first time it is shown, apart from the take, with the props it was given', async () => {
    expect([...evaluated]).not.toContain('RewindPreview');
    render(<RewindPreview org={developerOrg()} checkpoint={readyCheckpoint()} onClose={vi.fn()} />);
    expect((await screen.findByTestId('preview-stand-in')).textContent).toBe('Before UAT');
    expect([...evaluated]).toContain('RewindPreview');
  });

  it('loads the run of a rewind the first time one is confirmed, with the props it was given', async () => {
    expect([...evaluated]).not.toContain('RewindRun');
    render(
      <RewindRun
        orgName="DEV-SB"
        checkpoint={readyCheckpoint()}
        run={{ kind: 'rewind', diff: previewDiff() }}
        state={{ loading: true, requestId: 'req-1', result: null, error: null, errorCode: null }}
        onUndo={vi.fn()}
        onRewindAgain={vi.fn()}
        onIgnored={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    expect((await screen.findByTestId('run-stand-in')).textContent).toBe('DEV-SB');
    expect([...evaluated]).toContain('RewindRun');
    expect([...evaluated]).not.toContain('StopComparingFields');
  });

  it('loads the fields a checkpoint compares the first time they are to change', async () => {
    render(
      <StopComparingFields checkpoint={readyCheckpoint()} onClose={vi.fn()} onSaved={vi.fn()} />,
    );
    expect((await screen.findByTestId('stop-comparing-stand-in')).textContent).toBe('Before UAT');
    expect([...evaluated]).toContain('StopComparingFields');
  });

  it('says a take that could not load in its place, and leaves the page around it up', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    takeUnreadable.value = true;
    try {
      render(
        <div data-testid="page">
          <TakeCheckpoint org={developerOrg()} onClose={vi.fn()} onTaken={vi.fn()} />
        </div>,
      );
      const failed = await screen.findByTestId('part-failed');
      expect(failed.textContent).toContain('This part did not load');
      expect(screen.getByTestId('page').contains(failed)).toBe(true);
    } finally {
      takeUnreadable.value = false;
    }
  });
});
