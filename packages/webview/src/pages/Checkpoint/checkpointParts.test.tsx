import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { developerOrg, readyCheckpoint } from './testing/checkpointFixtures';

/**
 * When the take and the preview load. Each stand-in notes when its module is
 * evaluated: a page that imported one up front would parse what a take asks
 * or a preview shows before its list painted.
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

import { RewindPreview, TakeCheckpoint } from './checkpointParts';

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
