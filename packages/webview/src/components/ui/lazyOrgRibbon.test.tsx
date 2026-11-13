import { Suspense } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

describe('lazyOrgRibbon', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock('./OrgRibbon');
  });

  it('leaves the ribbon unread until a page draws it, then draws it', async () => {
    const evaluated = vi.fn();
    vi.doMock('./OrgRibbon', () => {
      evaluated();
      return { OrgRibbon: () => <div data-testid="the-ribbon" /> };
    });
    const { LazyOrgRibbon } = await import('./lazyOrgRibbon');
    expect(evaluated).not.toHaveBeenCalled();

    render(
      <Suspense fallback={<div data-testid="waiting" />}>
        <LazyOrgRibbon source={undefined} target={undefined} />
      </Suspense>,
    );

    expect(await screen.findByTestId('the-ribbon')).toBeDefined();
    expect(evaluated).toHaveBeenCalledTimes(1);
  });

  it('draws the ribbon fetched ahead the first time it is asked for, without its fallback', async () => {
    // Fetched while discovery was read, the ribbon still suspended as Review
    // was first drawn: it came some 100 milliseconds after Review, and moved
    // it 79 pixels down.
    vi.doMock('./OrgRibbon', () => ({ OrgRibbon: () => <div data-testid="the-ribbon" /> }));
    const { LazyOrgRibbon, loadOrgRibbon } = await import('./lazyOrgRibbon');
    await loadOrgRibbon();

    render(
      <Suspense fallback={<div data-testid="waiting" />}>
        <LazyOrgRibbon source={undefined} target={undefined} />
      </Suspense>,
    );

    expect(screen.queryByTestId('waiting')).toBeNull();
    expect(screen.getByTestId('the-ribbon')).toBeDefined();
  });

  it('draws nothing, and throws nothing, when its chunk cannot be read', async () => {
    const failed = vi.fn();
    vi.doMock('./OrgRibbon', () => {
      failed();
      throw new TypeError('Failed to fetch dynamically imported module');
    });
    const { loadOrgRibbon } = await import('./lazyOrgRibbon');

    const { default: Ribbon } = await loadOrgRibbon();
    const { container } = render(<Ribbon source={undefined} target={undefined} />);

    // The import was tried and refused: an empty ribbon from a loaded chunk would pass too.
    expect(failed).toHaveBeenCalledTimes(1);
    expect(container.innerHTML).toBe('');
  });
});
