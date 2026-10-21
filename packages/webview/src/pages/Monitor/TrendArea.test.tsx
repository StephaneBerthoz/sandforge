import { cloneElement } from 'react';
import type { ReactElement } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import '../../i18n';
import { TrendArea } from './TrendArea';

/* jsdom lays nothing out: the container hands the chart the size it would have measured. */
vi.mock('recharts', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('recharts');
  return {
    ...actual,
    ResponsiveContainer: ({
      children,
    }: {
      children: ReactElement<{ width?: number; height?: number }>;
    }) => <div>{cloneElement(children, { width: 400, height: 200 })}</div>,
  };
});

describe('TrendArea', () => {
  it('draws the points as an area filled with the accent gradient', () => {
    const data = [
      { timestamp: Date.UTC(2026, 0, 1, 10), value: 100 },
      { timestamp: Date.UTC(2026, 0, 1, 11), value: 200 },
      { timestamp: Date.UTC(2026, 0, 1, 12), value: 150 },
    ];
    const { container } = render(<TrendArea data={data} period="24h" />);

    const area = container.querySelector('.recharts-area-area');
    expect(area).not.toBeNull();
    expect(area?.getAttribute('fill')).toBe('url(#trendGradient)');
    expect(container.querySelector('linearGradient#trendGradient')).not.toBeNull();
  });
});
