import { describe, it, expect, vi } from 'vitest';

/**
 * Which Forge steps are fetched ahead of the run, in a file of its own: each
 * stand-in notes when its module is evaluated, which happens once a file.
 */
const evaluated = vi.hoisted(() => new Set<string>());

function stand(name: string) {
  evaluated.add(name);
  return { [name]: () => null };
}

vi.mock('./ForgeDiscovery', () => stand('ForgeDiscovery'));
vi.mock('./ForgeReview', () => stand('ForgeReview'));
vi.mock('./ForgeExecution', () => stand('ForgeExecution'));
vi.mock('./ForgeResults', () => stand('ForgeResults'));

import { preloadStepsAfter } from './forgeSteps';

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
});
