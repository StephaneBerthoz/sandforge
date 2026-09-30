import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { useForgeViewStore } from '../../stores/useForgeViewStore';
import { ForgeViewToggle } from './ForgeViewToggle';

describe('ForgeViewToggle', () => {
  beforeEach(() => {
    useForgeViewStore.setState({ setting: 'auto', choice: null });
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
  });
});
