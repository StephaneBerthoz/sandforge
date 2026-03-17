import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SplitView } from './SplitView';

describe('SplitView', () => {
  it('should render left and right content', () => {
    render(
      <SplitView
        left={<div>Left content</div>}
        right={<div>Right content</div>}
      />,
    );
    expect(screen.getByText('Left content')).toBeDefined();
    expect(screen.getByText('Right content')).toBeDefined();
  });

  it('should apply custom className', () => {
    render(
      <SplitView
        left={<div>Left</div>}
        right={<div>Right</div>}
        className="my-custom-class"
      />,
    );
    const root = screen.getByTestId('splitview');
    expect(root.className).toContain('my-custom-class');
  });

  it('should default to 60/40 ratio (left has basis-3/5)', () => {
    render(
      <SplitView
        left={<div>Left</div>}
        right={<div>Right</div>}
      />,
    );
    const leftPanel = screen.getByTestId('splitview-left');
    expect(leftPanel.className).toContain('basis-3/5');
  });

  it('should apply 50/50 ratio classes', () => {
    render(
      <SplitView
        left={<div>Left</div>}
        right={<div>Right</div>}
        ratio="50/50"
      />,
    );
    const leftPanel = screen.getByTestId('splitview-left');
    const rightPanel = screen.getByTestId('splitview-right');
    expect(leftPanel.className).toContain('basis-1/2');
    expect(rightPanel.className).toContain('basis-1/2');
  });

  it('should apply 70/30 ratio classes', () => {
    render(
      <SplitView
        left={<div>Left</div>}
        right={<div>Right</div>}
        ratio="70/30"
      />,
    );
    const leftPanel = screen.getByTestId('splitview-left');
    const rightPanel = screen.getByTestId('splitview-right');
    expect(leftPanel.className).toContain('basis-7/12');
    expect(rightPanel.className).toContain('basis-5/12');
  });

  it('should call onToggleRight when toggle button is clicked', () => {
    const onToggleRight = vi.fn();
    render(
      <SplitView
        left={<div>Left</div>}
        right={<div>Right</div>}
        onToggleRight={onToggleRight}
      />,
    );
    fireEvent.click(screen.getByTestId('splitview-toggle'));
    expect(onToggleRight).toHaveBeenCalledOnce();
  });

  it('should show PanelRightClose icon when expanded', () => {
    render(
      <SplitView
        left={<div>Left</div>}
        right={<div>Right</div>}
        rightCollapsed={false}
      />,
    );
    const toggle = screen.getByTestId('splitview-toggle');
    expect(toggle.getAttribute('aria-label')).toBe('Collapse right panel');
  });

  it('should show PanelRightOpen icon when collapsed', () => {
    render(
      <SplitView
        left={<div>Left</div>}
        right={<div>Right</div>}
        rightCollapsed
      />,
    );
    const toggle = screen.getByTestId('splitview-toggle');
    expect(toggle.getAttribute('aria-label')).toBe('Expand right panel');
  });

  it('should hide right panel when rightCollapsed is true', () => {
    render(
      <SplitView
        left={<div>Left</div>}
        right={<div>Right</div>}
        rightCollapsed
      />,
    );
    expect(screen.queryByTestId('splitview-right')).toBeNull();
  });
});
