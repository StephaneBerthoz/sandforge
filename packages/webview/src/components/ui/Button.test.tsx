import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Button } from './Button';

/* Mock framer-motion to render plain elements in tests */
const MOTION_KEYS = new Set([
  'variants',
  'initial',
  'animate',
  'whileHover',
  'whileTap',
  'transition',
  'exit',
]);

vi.mock('framer-motion', async () => {
  const React = await import('react');
  const mockButton = React.forwardRef<HTMLButtonElement, Record<string, unknown>>((props, ref) => {
    const filtered: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) {
      if (!MOTION_KEYS.has(k)) filtered[k] = v;
    }
    return React.createElement('button', { ...filtered, ref });
  });
  const mockDiv = React.forwardRef<HTMLDivElement, Record<string, unknown>>((props, ref) => {
    const filtered: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) {
      if (!MOTION_KEYS.has(k)) filtered[k] = v;
    }
    return React.createElement('div', { ...filtered, ref });
  });
  return {
    m: { button: mockButton, div: mockDiv },
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  };
});

describe('Button', () => {
  it('should render children text', () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole('button', { name: 'Click me' })).toBeDefined();
  });

  it('should apply primary variant classes by default', () => {
    render(<Button>Primary</Button>);
    const btn = screen.getByRole('button');
    expect(btn.className).toContain('bg-[var(--vscode-button-background');
  });

  it('should apply secondary variant classes', () => {
    render(<Button variant="secondary">Sec</Button>);
    const btn = screen.getByRole('button');
    expect(btn.className).toContain('bg-[var(--vscode-button-secondaryBackground');
  });

  it('should apply danger variant classes', () => {
    render(<Button variant="danger">Delete</Button>);
    const btn = screen.getByRole('button');
    expect(btn.className).toContain('bg-[var(--vscode-errorForeground');
  });

  it('should apply size classes', () => {
    render(<Button size="lg">Large</Button>);
    const btn = screen.getByRole('button');
    expect(btn.className).toContain('px-4');
  });

  it('should be disabled when disabled prop is set', () => {
    render(<Button disabled>Disabled</Button>);
    const btn = screen.getByRole('button') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('should be disabled when loading', () => {
    render(<Button loading>Loading</Button>);
    const btn = screen.getByRole('button') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.querySelector('[role="status"]')).toBeDefined();
  });

  it('should call onClick handler', () => {
    const handler = vi.fn();
    render(<Button onClick={handler}>Click</Button>);
    fireEvent.click(screen.getByRole('button'));
    expect(handler).toHaveBeenCalledOnce();
  });

  it('should render icon when provided', () => {
    render(<Button icon={<span data-testid="icon">★</span>}>With Icon</Button>);
    expect(screen.getByTestId('icon')).toBeDefined();
  });

  it('should merge custom className', () => {
    render(<Button className="my-custom">Custom</Button>);
    const btn = screen.getByRole('button');
    expect(btn.className).toContain('my-custom');
  });
});
