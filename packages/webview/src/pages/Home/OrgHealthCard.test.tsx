import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import '../../i18n';
import { useAppStore } from '../../stores/useAppStore';
import { OrgHealthCard } from './OrgHealthCard';
import type { OrgHealthSummary } from './useOrgHealthSummary';

const MEASURED: OrgHealthSummary = {
  loading: false,
  healthScore: 72,
  limitWarnings: 2,
  apiUsedPercent: 75,
};

/** The figure a card shows under `testId`: its label, then its value. */
function figure(testId: string): { label: string; value: string } {
  const cell = screen.getByTestId(testId);
  return {
    label: cell.firstElementChild?.textContent ?? '',
    value: within(cell).getByTestId('kpi-value').textContent ?? '',
  };
}

describe('OrgHealthCard', () => {
  beforeEach(() => {
    useAppStore.setState({ currentRoute: 'home', navigationIntent: null });
  });

  it('says the score, the limits past their threshold and the API usage under Org health', () => {
    render(<OrgHealthCard health={MEASURED} />);
    const card = screen.getByTestId('home-org-health');
    expect(card.textContent).toContain('Org health');
    expect(figure('home-health-score')).toEqual({ label: 'Health score', value: '72%' });
    expect(figure('home-limit-warnings')).toEqual({ label: 'Limit warnings', value: '2' });
    expect(figure('home-api-usage')).toEqual({ label: 'API usage', value: '75%' });
  });

  it('opens the Monitor, where each figure is explained, and says so', () => {
    render(<OrgHealthCard health={MEASURED} />);
    const card = screen.getByRole('button', { name: /Org health/ });
    expect(card.getAttribute('title')).toBe('Open Monitor');
    fireEvent.click(card);
    expect(useAppStore.getState().currentRoute).toBe('monitor');
  });

  it('writes a dash for what was not measured, never a zero', () => {
    render(
      <OrgHealthCard
        health={{ loading: false, healthScore: null, limitWarnings: null, apiUsedPercent: null }}
      />,
    );
    for (const testId of ['home-health-score', 'home-limit-warnings', 'home-api-usage']) {
      expect(figure(testId).value).toBe('—');
    }
  });

  it('counts no warning as a zero once measured', () => {
    render(<OrgHealthCard health={{ ...MEASURED, limitWarnings: 0 }} />);
    expect(figure('home-limit-warnings').value).toBe('0');
  });

  it('holds each figure’s place with a skeleton while they are read, and opens the Monitor meanwhile', () => {
    // The Monitor reads the org for them: the card waited as long, a block
    // with neither its name nor a way to the Monitor.
    render(<OrgHealthCard health={{ ...MEASURED, loading: true }} />);
    const card = screen.getByTestId('home-org-health');
    expect(within(card).getAllByTestId('skeleton')).toHaveLength(3);
    expect(within(card).queryByTestId('kpi-value')).toBeNull();
    expect(card.textContent).toContain('Health score');
    fireEvent.click(card);
    expect(useAppStore.getState().currentRoute).toBe('monitor');
  });
});
