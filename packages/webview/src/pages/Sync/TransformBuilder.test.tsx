import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { TransformBuilder } from './TransformBuilder';
import type { TransformRule } from '@sandforge/shared';

const rules: TransformRule[] = [
  { type: 'uppercase', config: {} },
  { type: 'prefix', config: { prefix: 'SF_' } },
];

describe('TransformBuilder', () => {
  it('should render the builder', () => {
    render(
      <TransformBuilder
        rules={rules}
        onAddRule={vi.fn()}
        onRemoveRule={vi.fn()}
        onChangeConfig={vi.fn()}
      />,
    );
    expect(screen.getByTestId('transform-builder')).toBeDefined();
  });

  it('should show existing rules', () => {
    render(
      <TransformBuilder
        rules={rules}
        onAddRule={vi.fn()}
        onRemoveRule={vi.fn()}
        onChangeConfig={vi.fn()}
      />,
    );
    expect(screen.getByTestId('transform-0')).toBeDefined();
    expect(screen.getByTestId('transform-1')).toBeDefined();
  });

  it('should show rule type badges', () => {
    render(
      <TransformBuilder
        rules={rules}
        onAddRule={vi.fn()}
        onRemoveRule={vi.fn()}
        onChangeConfig={vi.fn()}
      />,
    );
    expect(screen.getAllByText('Uppercase').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Prefix').length).toBeGreaterThan(0);
  });

  it('should call onRemoveRule when remove is clicked', () => {
    const onRemove = vi.fn();
    render(
      <TransformBuilder
        rules={rules}
        onAddRule={vi.fn()}
        onRemoveRule={onRemove}
        onChangeConfig={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('remove-transform-0'));
    expect(onRemove).toHaveBeenCalledWith(0);
  });

  it('should call onAddRule when add is clicked', () => {
    const onAdd = vi.fn();
    render(
      <TransformBuilder
        rules={[]}
        onAddRule={onAdd}
        onRemoveRule={vi.fn()}
        onChangeConfig={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('add-transform-btn'));
    expect(onAdd).toHaveBeenCalledWith('uppercase');
  });

  it('should show count', () => {
    render(
      <TransformBuilder
        rules={rules}
        onAddRule={vi.fn()}
        onRemoveRule={vi.fn()}
        onChangeConfig={vi.fn()}
      />,
    );
    expect(screen.getByText('Transforms (2)')).toBeDefined();
  });

  it('should show empty state when no rules', () => {
    render(
      <TransformBuilder
        rules={[]}
        onAddRule={vi.fn()}
        onRemoveRule={vi.fn()}
        onChangeConfig={vi.fn()}
      />,
    );
    expect(screen.getByText('No data available')).toBeDefined();
  });

  it('should show config input for prefix rule', () => {
    render(
      <TransformBuilder
        rules={rules}
        onAddRule={vi.fn()}
        onRemoveRule={vi.fn()}
        onChangeConfig={vi.fn()}
      />,
    );
    const prefixRule = screen.getByTestId('transform-1');
    expect(prefixRule.querySelector('input')).toBeDefined();
  });
});
