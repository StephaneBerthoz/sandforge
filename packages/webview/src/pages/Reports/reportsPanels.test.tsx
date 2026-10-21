import { Suspense } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * Which of the Reports tabs' libraries a panel loads. Each stand-in notes when
 * its module is evaluated: the page imported both up front, so the charts and
 * the graph library were parsed before Executions, the tab it opens on.
 */
const evaluated = vi.hoisted(() => new Set<string>());

function stand(name: string) {
  evaluated.add(name);
  return { [name]: () => <div data-testid={`panel-${name}`}>{name}</div> };
}

vi.mock('./AnalyticsDashboard', () => stand('AnalyticsDashboard'));
vi.mock('./LineageGraph', () => stand('LineageGraph'));

import * as panels from './reportsPanels';

describe('reportsPanels', () => {
  it('loads no panel until its tab shows it, then that panel only', async () => {
    expect([...evaluated]).toEqual([]);

    const { LineageGraph } = panels as unknown as Record<string, React.FC>;
    render(
      <Suspense fallback={<div data-testid="loading" />}>
        <LineageGraph />
      </Suspense>,
    );

    expect(screen.getByTestId('loading')).toBeDefined();
    expect(await screen.findByTestId('panel-LineageGraph')).toBeDefined();
    expect([...evaluated]).toEqual(['LineageGraph']);
  });

  it('loads each panel under its own name', async () => {
    const { AnalyticsDashboard } = panels as unknown as Record<string, React.FC>;
    render(
      <Suspense fallback={null}>
        <AnalyticsDashboard />
      </Suspense>,
    );
    expect(await screen.findByTestId('panel-AnalyticsDashboard')).toBeDefined();
  });
});
