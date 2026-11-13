import { Suspense } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { lazyOnce, loadOnce } from './loadOnce';

/** A part as its chunk answers it. */
const PART = { default: () => <div data-testid="the-part" /> };

describe('loadOnce', () => {
  it('runs its loader once, however many times the part is asked for', async () => {
    const load = vi.fn(() => Promise.resolve(PART));
    const once = loadOnce(load);

    await Promise.all([once(), once()]);
    await once();

    expect(load).toHaveBeenCalledTimes(1);
  });

  it('answers before it returns once the module is in', async () => {
    const once = loadOnce(() => Promise.resolve(PART));
    await once();

    let answered: unknown;
    once().then(
      (module) => {
        answered = module;
      },
      () => undefined,
    );

    // Called back within `then`, not a microtask later.
    expect(answered).toBe(PART);
  });

  it('runs a loader that failed again the next time the part is asked for', async () => {
    const load = vi
      .fn<() => Promise<typeof PART>>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch dynamically imported module'))
      .mockResolvedValueOnce(PART);
    const once = loadOnce(load);

    await expect(once()).rejects.toThrow('Failed to fetch');
    await expect(once()).resolves.toBe(PART);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('lazyOnce', () => {
  it('draws a part fetched ahead the first time it is asked for, without its fallback', async () => {
    const once = loadOnce(() => Promise.resolve(PART));
    const Part = lazyOnce(once);
    await once();

    render(
      <Suspense fallback={<div data-testid="waiting" />}>
        <Part />
      </Suspense>,
    );

    expect(screen.queryByTestId('waiting')).toBeNull();
    expect(screen.getByTestId('the-part')).toBeDefined();
  });

  it('draws its fallback while the part has not come, then the part', async () => {
    const Part = lazyOnce(loadOnce(() => Promise.resolve(PART)));

    render(
      <Suspense fallback={<div data-testid="waiting" />}>
        <Part />
      </Suspense>,
    );

    expect(screen.getByTestId('waiting')).toBeDefined();
    expect(await screen.findByTestId('the-part')).toBeDefined();
  });
});
