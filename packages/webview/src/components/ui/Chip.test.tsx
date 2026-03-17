import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Chip } from './Chip';

describe('Chip', () => {
  it('should render the label text', () => {
    render(<Chip label="Account" />);
    expect(screen.getByText('Account')).toBeDefined();
  });

  it('should apply default variant classes', () => {
    render(<Chip label="Tag" />);
    expect(screen.getByText('Tag').className).toContain('bg-[var(--vscode-badge-background');
  });

  it('should apply success variant', () => {
    render(<Chip label="Done" variant="success" />);
    expect(screen.getByText('Done').closest('span')?.className).toContain('bg-emerald-700');
  });

  it('should show remove button when onRemove is provided', () => {
    render(<Chip label="Filter" onRemove={vi.fn()} />);
    expect(screen.getByLabelText('Remove Filter')).toBeDefined();
  });

  it('should not show remove button when onRemove is absent', () => {
    render(<Chip label="Static" />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('should call onRemove when remove button is clicked', () => {
    const onRemove = vi.fn();
    render(<Chip label="Filter" onRemove={onRemove} />);
    fireEvent.click(screen.getByLabelText('Remove Filter'));
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it('should apply size classes', () => {
    const { container } = render(<Chip label="Small" size="sm" />);
    expect(container.firstElementChild?.className).toContain('text-[10px]');
  });

  it('should apply custom className', () => {
    const { container } = render(<Chip label="X" className="ml-1" />);
    expect(container.firstElementChild?.className).toContain('ml-1');
  });
});
