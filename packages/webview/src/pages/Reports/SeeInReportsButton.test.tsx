import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import i18n from '../../i18n';
import fr from '../../i18n/locales/fr.json';
import { useAppStore } from '../../stores/useAppStore';
import { SeeInReportsButton } from './SeeInReportsButton';

describe('SeeInReportsButton', () => {
  const navigate = vi.fn();

  beforeEach(() => {
    navigate.mockReset();
    useAppStore.setState({ navigate });
  });

  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('opens Reports on the tab that lists the runs of the history it sits in', () => {
    // No page led to Reports: it was reached from the command palette alone.
    render(<SeeInReportsButton tab="executions" testId="sync-history-reports" />);

    const button = screen.getByTestId('sync-history-reports');
    expect(button.textContent).toBe('See in Reports');
    fireEvent.click(button);
    expect(navigate).toHaveBeenCalledWith('reports', { reportsTab: 'executions' });
  });

  it('says it in French as the launcher names the page', async () => {
    i18n.addResourceBundle('fr', 'translation', fr, true, true);
    await i18n.changeLanguage('fr');
    render(<SeeInReportsButton tab="audit" testId="pipeline-history-reports" />);

    expect(screen.getByTestId('pipeline-history-reports').textContent).toBe(
      `Voir dans ${fr.nav.reports}`,
    );
  });
});
