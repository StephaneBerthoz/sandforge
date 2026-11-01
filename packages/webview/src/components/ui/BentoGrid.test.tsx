import type { ReactElement } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MotionProvider } from '../../motion/MotionProvider';
import { BentoGrid, BentoTile } from './BentoGrid';

/** The tile, once the pointer has entered it, under the panel's motion features. */
function hovered(tile: ReactElement): HTMLElement {
  render(<MotionProvider>{tile}</MotionProvider>);
  const element = screen.getByTestId('bento-tile');
  fireEvent.pointerEnter(element, { pointerType: 'mouse', isPrimary: true });
  return element;
}

describe('BentoGrid', () => {
  it('should render children', () => {
    render(
      <BentoGrid>
        <div>Child A</div>
        <div>Child B</div>
      </BentoGrid>,
    );
    expect(screen.getByText('Child A')).toBeDefined();
    expect(screen.getByText('Child B')).toBeDefined();
  });

  it('should apply grid class', () => {
    render(
      <BentoGrid>
        <div>Content</div>
      </BentoGrid>,
    );
    const grid = screen.getByTestId('bento-grid');
    expect(grid.className).toContain('grid');
  });

  it('should apply custom className', () => {
    render(
      <BentoGrid className="my-custom">
        <div>Content</div>
      </BentoGrid>,
    );
    const grid = screen.getByTestId('bento-grid');
    expect(grid.className).toContain('my-custom');
  });

  it('should default to 3 columns', () => {
    render(
      <BentoGrid>
        <div>Content</div>
      </BentoGrid>,
    );
    const grid = screen.getByTestId('bento-grid');
    expect(grid.className).toContain('lg:grid-cols-3');
  });

  it('should apply columns=4', () => {
    render(
      <BentoGrid columns={4}>
        <div>Content</div>
      </BentoGrid>,
    );
    const grid = screen.getByTestId('bento-grid');
    expect(grid.className).toContain('lg:grid-cols-4');
  });

  it('should apply gap sm', () => {
    render(
      <BentoGrid gap="sm">
        <div>Content</div>
      </BentoGrid>,
    );
    const grid = screen.getByTestId('bento-grid');
    expect(grid.className).toContain('gap-2');
  });

  it('should apply gap md by default', () => {
    render(
      <BentoGrid>
        <div>Content</div>
      </BentoGrid>,
    );
    const grid = screen.getByTestId('bento-grid');
    expect(grid.className).toContain('gap-4');
  });

  it('should apply gap lg', () => {
    render(
      <BentoGrid gap="lg">
        <div>Content</div>
      </BentoGrid>,
    );
    const grid = screen.getByTestId('bento-grid');
    expect(grid.className).toContain('gap-6');
  });
});

describe('BentoTile', () => {
  it('should render children', () => {
    render(<BentoTile>Tile content</BentoTile>);
    expect(screen.getByText('Tile content')).toBeDefined();
  });

  it('should have surface-1 bg and rounded-xl', () => {
    render(<BentoTile>Content</BentoTile>);
    const tile = screen.getByTestId('bento-tile');
    expect(tile.className).toContain('bg-surface-1');
    expect(tile.className).toContain('rounded-xl');
  });

  it('should apply colSpan=2', () => {
    render(<BentoTile colSpan={2}>Content</BentoTile>);
    const tile = screen.getByTestId('bento-tile');
    expect(tile.className).toContain('col-span-2');
  });

  it('should apply custom className', () => {
    render(<BentoTile className="tile-extra">Content</BentoTile>);
    const tile = screen.getByTestId('bento-tile');
    expect(tile.className).toContain('tile-extra');
  });

  it('lifts under the pointer, as Home and its checkpoint tile draw it', async () => {
    const tile = hovered(<BentoTile>Content</BentoTile>);

    await waitFor(() => expect(tile.style.transform).toContain('scale'));
  });

  it('holds still under the pointer when it holds a working area', async () => {
    // DataOps, Automation and Reports put their forms and tables in one: the
    // panel grew some 6 px on each side and jumped each time the pointer
    // crossed its edge.
    const tile = hovered(<BentoTile hover={false}>Content</BentoTile>);

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(tile.style.transform).toBe('');
  });
});
