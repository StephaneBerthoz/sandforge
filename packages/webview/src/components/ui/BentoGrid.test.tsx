import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BentoGrid, BentoTile } from './BentoGrid';

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
});
