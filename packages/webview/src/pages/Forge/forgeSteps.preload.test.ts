import { createElement, Suspense } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * Which Forge steps are fetched ahead of the run, in a file of its own: each
 * stand-in notes when its module is evaluated, which happens once a file.
 */
const evaluated = vi.hoisted(() => new Set<string>());

function stand(name: string) {
  evaluated.add(name);
  return { [name]: () => createElement('div', { 'data-testid': `step-${name}` }) };
}

vi.mock('./ForgeDiscovery', () => stand('ForgeDiscovery'));
vi.mock('./ForgeReview', () => stand('ForgeReview'));
vi.mock('./ForgeExecution', () => stand('ForgeExecution'));
vi.mock('./ForgeResults', () => stand('ForgeResults'));

import { ForgeExecution, ForgeResults, preloadStepsAfter } from './forgeSteps';

describe('preloadStepsAfter', () => {
  it('fetches the steps a run can reach from the review while it is read, and none from the input', async () => {
    // The execution step's chunk was asked for only once the run had started:
    // a round trip more at every start, and a run writing behind a screen
    // that never loaded when that fetch failed.
    preloadStepsAfter('input');
    preloadStepsAfter('execution');
    preloadStepsAfter('results');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect([...evaluated]).toEqual([]);

    preloadStepsAfter('review');
    await vi.waitFor(() =>
      expect([...evaluated].sort()).toEqual(['ForgeExecution', 'ForgeResults']),
    );

    preloadStepsAfter('discovery');
    await vi.waitFor(() => expect(evaluated.has('ForgeReview')).toBe(true));
    expect(evaluated.has('ForgeDiscovery')).toBe(false);
  });

  it('draws a step fetched ahead the first time it is asked for, without its fallback', async () => {
    // Fetched ahead, the step still suspended as it was first drawn: its
    // empty fallback took the page's height, and the panel went back to its
    // top at the first Execute.
    preloadStepsAfter('review');
    await vi.waitFor(() => expect(evaluated.has('ForgeExecution')).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 20));

    for (const Step of [ForgeExecution, ForgeResults]) {
      const { unmount } = render(
        createElement(
          Suspense,
          { fallback: createElement('div', { 'data-testid': 'step-loading' }) },
          createElement(Step),
        ),
      );
      expect(screen.queryByTestId('step-loading')).toBeNull();
      expect(screen.getByTestId(/^step-Forge/)).toBeDefined();
      unmount();
    }
  });
});
