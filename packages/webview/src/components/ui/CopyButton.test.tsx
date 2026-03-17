import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { CopyButton } from './CopyButton';

beforeEach(() => {
  Object.assign(navigator, {
    clipboard: {
      writeText: vi.fn().mockResolvedValue(undefined),
    },
  });
  vi.useFakeTimers();
});

describe('CopyButton', () => {
  it('should render with default label', () => {
    render(<CopyButton text="hello" />);
    expect(screen.getByText('Copy')).toBeDefined();
  });

  it('should render with custom label', () => {
    render(<CopyButton text="hello" label="Copy ID" />);
    expect(screen.getByText('Copy ID')).toBeDefined();
  });

  it('should copy text to clipboard on click', async () => {
    render(<CopyButton text="some-value" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('some-value');
  });

  it('should show "Copied!" after clicking', async () => {
    render(<CopyButton text="value" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });
    expect(screen.getByText('Copied!')).toBeDefined();
  });

  it('should revert to original label after 2 seconds', async () => {
    render(<CopyButton text="value" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });
    expect(screen.getByText('Copied!')).toBeDefined();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByText('Copy')).toBeDefined();
  });

  it('should update aria-label when copied', async () => {
    render(<CopyButton text="value" />);
    const button = screen.getByRole('button');
    expect(button.getAttribute('aria-label')).toBe('Copy');
    await act(async () => {
      fireEvent.click(button);
    });
    expect(button.getAttribute('aria-label')).toBe('Copied');
  });

  it('should apply custom className', () => {
    render(<CopyButton text="x" className="ml-2" />);
    expect(screen.getByRole('button').className).toContain('ml-2');
  });
});
