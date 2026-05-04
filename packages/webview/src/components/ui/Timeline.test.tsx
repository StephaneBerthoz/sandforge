import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Timeline } from './Timeline';
import type { TimelineItem } from './Timeline';

const items: TimelineItem[] = [
  { title: 'Deployment started', timestamp: '10:00 AM', status: 'info' },
  {
    title: 'Records inserted',
    description: '500 Account records',
    timestamp: '10:05 AM',
    status: 'success',
  },
  {
    title: 'Error on Contact',
    description: 'Duplicate rule violation',
    timestamp: '10:06 AM',
    status: 'error',
  },
];

describe('Timeline', () => {
  it('should render all item titles', () => {
    render(<Timeline items={items} />);
    for (const item of items) {
      expect(screen.getByText(item.title)).toBeDefined();
    }
  });

  it('should render timestamps', () => {
    render(<Timeline items={items} />);
    expect(screen.getByText('10:00 AM')).toBeDefined();
    expect(screen.getByText('10:05 AM')).toBeDefined();
  });

  it('should render descriptions when provided', () => {
    render(<Timeline items={items} />);
    expect(screen.getByText('500 Account records')).toBeDefined();
    expect(screen.getByText('Duplicate rule violation')).toBeDefined();
  });

  it('should apply status color classes to dots', () => {
    const { container } = render(<Timeline items={items} />);
    const dots = container.querySelectorAll('[aria-hidden="true"]');
    const firstDot = dots[0];
    expect(firstDot?.className).toContain('bg-blue-500');
  });

  it('should render connector lines between items', () => {
    const { container } = render(<Timeline items={items} />);
    const connectors = container.querySelectorAll('.w-px');
    // All items except last should have a connector
    expect(connectors.length).toBe(items.length - 1);
  });

  it('should apply custom className', () => {
    const { container } = render(<Timeline items={items} className="mt-4" />);
    expect(container.firstElementChild?.className).toContain('mt-4');
  });
});
