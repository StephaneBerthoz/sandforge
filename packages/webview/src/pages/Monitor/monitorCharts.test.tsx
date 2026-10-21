import { Suspense } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * When Monitor's Recharts charts load. Each stand-in notes when its module is
 * evaluated: the dashboard imported both up front, so every panel showing
 * Monitor parsed Recharts before its counts and tables.
 */
const evaluated = vi.hoisted(() => new Set<string>());

function stand(name: string) {
  evaluated.add(name);
  return { [name]: () => <div data-testid={`chart-${name}`}>{name}</div> };
}

vi.mock('./TrendArea', () => stand('TrendArea'));
vi.mock('./StorageDonut', () => stand('StorageDonut'));

import * as charts from './monitorCharts';

describe('monitorCharts', () => {
  it('loads no chart until one is drawn, then that chart only', async () => {
    expect([...evaluated]).toEqual([]);

    const { StorageDonut } = charts as unknown as Record<string, React.FC>;
    render(
      <Suspense fallback={<div data-testid="loading" />}>
        <StorageDonut />
      </Suspense>,
    );

    expect(screen.getByTestId('loading')).toBeDefined();
    expect(await screen.findByTestId('chart-StorageDonut')).toBeDefined();
    expect([...evaluated]).toEqual(['StorageDonut']);
  });

  it('loads each chart under its own name', async () => {
    const { TrendArea } = charts as unknown as Record<string, React.FC>;
    render(
      <Suspense fallback={null}>
        <TrendArea />
      </Suspense>,
    );
    expect(await screen.findByTestId('chart-TrendArea')).toBeDefined();
  });
});
