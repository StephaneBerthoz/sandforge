import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { developerOrg } from './testing/checkpointFixtures';

/**
 * When the take loads. The stand-in notes when its module is evaluated: a
 * page that imported it up front would parse what a take asks and shows
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

import { TakeCheckpoint } from './checkpointParts';

describe('the parts of the Checkpoints page loaded on demand', () => {
  it('loads the take the first time it is shown, with the props it was given', async () => {
    expect([...evaluated]).toEqual([]);
    render(<TakeCheckpoint org={developerOrg()} onClose={vi.fn()} onTaken={vi.fn()} />);
    expect((await screen.findByTestId('take-stand-in')).textContent).toBe('DEV-SB');
    expect([...evaluated]).toEqual(['TakeCheckpoint']);
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
