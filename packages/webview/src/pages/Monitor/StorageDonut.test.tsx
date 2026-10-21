import { cloneElement } from 'react';
import type { ReactElement } from 'react';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render } from '@testing-library/react';
import { StorageDonut } from './StorageDonut';

/*
 * jsdom lays nothing out: the container hands the chart the size it would
 * have measured, and the chart draws its slices.
 */
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

/* The slices drawn where they end, at once, as for a user who asks for less motion. */
beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

describe('StorageDonut', () => {
  it('draws a slice per object, each with the fill class of its index, again from the first past the last', () => {
    const data = ['Account', 'Contact', 'Lead'].map((name, index) => ({
      name,
      value: 300 - index * 100,
    }));
    const { container } = render(<StorageDonut data={data} fills={['fill-a', 'fill-b']} />);

    const slices = [...container.querySelectorAll('path.recharts-sector')];
    expect(slices.map((slice) => slice.getAttribute('class')?.match(/fill-[ab]/)?.[0])).toEqual([
      'fill-a',
      'fill-b',
      'fill-a',
    ]);
  });

  it('is no tab stop, since the table under it says every slice in words', () => {
    const { container } = render(
      <StorageDonut data={[{ name: 'Account', value: 1 }]} fills={['fill-a']} />,
    );
    expect(container.querySelector('[tabindex="0"]')).toBeNull();
  });
});
