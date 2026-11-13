import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { useForgeViewStore } from '../../stores/useForgeViewStore';
import { ForgeViewToggle } from './ForgeViewToggle';

describe('ForgeViewToggle', () => {
  beforeEach(() => {
    useForgeViewStore.setState({ setting: 'auto', choice: null, choiceOnLarge: false });
  });

  it('shows which view the screen is on', () => {
    render(<ForgeViewToggle view="table" />);

    expect(screen.getByTestId('forge-view-table').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('forge-view-graph').getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByTestId('forge-view-graph').textContent).toBe('Graph View');
    expect(screen.getByTestId('forge-view-table').textContent).toBe('Table View');
  });

  it('keeps the view picked for the panel, over the setting', () => {
    useForgeViewStore.getState().adoptSetting('table');
    render(<ForgeViewToggle view="table" />);

    fireEvent.click(screen.getByTestId('forge-view-graph'));

    expect(useForgeViewStore.getState().choice).toBe('graph');
    expect(useForgeViewStore.getState().setting).toBe('table');
    expect(useForgeViewStore.getState().choiceOnLarge).toBe(false);
  });

  it('warns of how slow a large graph is to draw, before the click, and keeps a pick as made on one', () => {
    render(<ForgeViewToggle view="table" large objectCount={1_200} />);

    const warning = screen.getByTestId('forge-view-graph-slow');
    expect(warning.textContent).toBe(
      'A clone of the whole org or a graph past 150 objects can hold the panel still for a while once drawn, and a run redraws it at each step: the table lists its 1,200 objects at once.',
    );
    expect(screen.getByTestId('forge-view-graph').getAttribute('aria-describedby')).toBe(
      warning.id,
    );
    expect(screen.getByTestId('forge-view-table').getAttribute('aria-describedby')).toBeNull();

    fireEvent.click(screen.getByTestId('forge-view-graph'));
    expect(useForgeViewStore.getState().choice).toBe('graph');
    expect(useForgeViewStore.getState().choiceOnLarge).toBe(true);
  });

  it('warns of nothing on a graph it may draw', () => {
    render(<ForgeViewToggle view="graph" objectCount={12} />);
    expect(screen.queryByTestId('forge-view-graph-slow')).toBeNull();
  });
});
