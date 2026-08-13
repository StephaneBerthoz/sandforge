import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';

import { Logo } from './Logo';

/**
 * The mark lives in three files and has to be the same object in all of them.
 *
 * It was not. The activity-bar and Marketplace marks were redrawn together
 * while this component kept rendering the anvil they replaced, so the product
 * shipped one identity in its listing and another inside its own UI. Nothing
 * failed, because nothing compared them.
 *
 * Only the two shapes that constitute the mark are compared. The Logo adds
 * embers and the Marketplace mark adds a ground and gradients — those are each
 * file's own business.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..');

/** Every `d` attribute in an SVG source, whitespace-normalised. */
function pathData(svg: string): string[] {
  return Array.from(svg.matchAll(/\sd="([^"]+)"/g)).map((m) => m[1].replace(/\s+/g, ' ').trim());
}

function readMark(relativePath: string): string[] {
  return pathData(readFileSync(join(REPO_ROOT, relativePath), 'utf-8'));
}

describe('mark parity', () => {
  const activityBar = readMark('resources/icons/toolkit.svg');
  const marketplace = readMark('resources/icon.svg');

  it('the activity-bar mark is the two shapes of the mark and nothing else', () => {
    expect(activityBar).toHaveLength(2);
  });

  it('the Marketplace mark carries the same two shapes', () => {
    for (const shape of activityBar) {
      expect(marketplace).toContain(shape);
    }
  });

  it('the in-app Logo carries the same two shapes', () => {
    const { container } = render(<Logo />);
    const rendered = Array.from(container.querySelectorAll('path')).map((p) =>
      (p.getAttribute('d') ?? '').replace(/\s+/g, ' ').trim(),
    );

    for (const shape of activityBar) {
      expect(rendered).toContain(shape);
    }
  });
});
