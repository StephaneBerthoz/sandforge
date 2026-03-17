import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Card, CardHeader, CardBody } from './Card';

/* Mock framer-motion to render plain elements in tests */
const MOTION_KEYS = new Set(['variants', 'initial', 'animate', 'whileHover', 'whileTap', 'transition', 'exit']);

vi.mock('framer-motion', async () => {
  const React = await import('react');
  const mockDiv = React.forwardRef<HTMLDivElement, Record<string, unknown>>(
    (props, ref) => {
      const filtered: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        if (!MOTION_KEYS.has(k)) filtered[k] = v;
      }
      return React.createElement('div', { ...filtered, ref });
    },
  );
  return {
    motion: { div: mockDiv },
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  };
});

describe('Card', () => {
  it('should render children', () => {
    render(<Card>Card content</Card>);
    expect(screen.getByText('Card content')).toBeDefined();
  });

  it('should apply hoverable class when hoverable', () => {
    const { container } = render(<Card hoverable>Hoverable</Card>);
    const card = container.firstChild as HTMLElement;
    expect(card.className).toContain('cursor-pointer');
  });

  it('should call onClick when clicked', () => {
    const handler = vi.fn();
    render(<Card onClick={handler}>Clickable</Card>);
    fireEvent.click(screen.getByRole('button'));
    expect(handler).toHaveBeenCalledOnce();
  });

  it('should set role=button when onClick is provided', () => {
    render(<Card onClick={vi.fn()}>Clickable</Card>);
    expect(screen.getByRole('button')).toBeDefined();
  });

  it('should handle Enter key when onClick is provided', () => {
    const handler = vi.fn();
    render(<Card onClick={handler}>Clickable</Card>);
    fireEvent.keyDown(screen.getByRole('button'), { key: 'Enter' });
    expect(handler).toHaveBeenCalledOnce();
  });
});

describe('CardHeader', () => {
  it('should render title', () => {
    render(<CardHeader title="My Card" />);
    expect(screen.getByText('My Card')).toBeDefined();
  });

  it('should render subtitle when provided', () => {
    render(<CardHeader title="Card" subtitle="Description" />);
    expect(screen.getByText('Description')).toBeDefined();
  });

  it('should render action slot', () => {
    render(<CardHeader title="Card" action={<button>Edit</button>} />);
    expect(screen.getByText('Edit')).toBeDefined();
  });
});

describe('CardBody', () => {
  it('should render children', () => {
    render(<CardBody>Body content</CardBody>);
    expect(screen.getByText('Body content')).toBeDefined();
  });
});
