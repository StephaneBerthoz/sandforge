import { Suspense } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * When the Forge steps past the input load. Each stand-in notes when its
 * module is evaluated: the page imported all five up front, so every panel
 * showing Forge parsed review, execution and the results before its input.
 */
const evaluated = vi.hoisted(() => new Set<string>());

function stand(name: string) {
  evaluated.add(name);
  return { [name]: () => <div data-testid={`step-${name}`}>{name}</div> };
}

vi.mock('./ForgeDiscovery', () => stand('ForgeDiscovery'));
vi.mock('./ForgeReview', () => stand('ForgeReview'));
vi.mock('./ForgeExecution', () => stand('ForgeExecution'));
vi.mock('./ForgeResults', () => stand('ForgeResults'));

import * as steps from './forgeSteps';

describe('forgeSteps', () => {
  it('loads no step until the run reaches it, then that step only', async () => {
    expect([...evaluated]).toEqual([]);

    const { ForgeExecution } = steps as unknown as Record<string, React.FC>;
    render(
      <Suspense fallback={<div data-testid="loading" />}>
        <ForgeExecution />
      </Suspense>,
    );

    expect(screen.getByTestId('loading')).toBeDefined();
    expect(await screen.findByTestId('step-ForgeExecution')).toBeDefined();
    expect([...evaluated]).toEqual(['ForgeExecution']);
  });

  it('loads each step under its own name', async () => {
    for (const name of ['ForgeDiscovery', 'ForgeReview', 'ForgeResults']) {
      const Step = (steps as unknown as Record<string, React.FC>)[name];
      const { unmount } = render(
        <Suspense fallback={null}>
          <Step />
        </Suspense>,
      );
      expect(await screen.findByTestId(`step-${name}`)).toBeDefined();
      unmount();
    }
  });
});
