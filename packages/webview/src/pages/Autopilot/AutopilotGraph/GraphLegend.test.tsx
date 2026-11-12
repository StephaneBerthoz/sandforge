import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import '../../../i18n';
import { GraphLegend, LEGEND_HEIGHT } from './GraphLegend';

describe('GraphLegend', () => {
  it('lists Skipped with the statuses, its swatch hollow and dashed as the node is', () => {
    render(<GraphLegend />);

    const entry = within(screen.getByTestId('graph-legend')).getByText('Skipped');
    const swatch = entry.previousElementSibling;
    expect(swatch?.className).toContain('border-dashed');
    expect(swatch?.className).not.toMatch(/\bbg-/);
  });

  it('keeps LEGEND_HEIGHT to the rows it draws: two headings, then two columns of each list', () => {
    render(<GraphLegend />);

    const [statuses, relationships] = [
      ...screen.getByTestId('graph-legend').querySelectorAll('.grid'),
    ];
    const rows = (grid: Element | undefined): number => Math.ceil((grid?.children.length ?? 0) / 2);
    const gaps = (count: number): number => (count - 1) * 4;
    /** Padding 12 and border 1 on each side, heading margins, and the 12 between the lists. */
    const frame = 2 * (12 + 1) + 2 * 8 + 12;

    expect(LEGEND_HEIGHT).toBe(
      frame +
        16 * (2 + rows(statuses) + rows(relationships)) +
        gaps(rows(statuses)) +
        gaps(rows(relationships)),
    );
  });
});
