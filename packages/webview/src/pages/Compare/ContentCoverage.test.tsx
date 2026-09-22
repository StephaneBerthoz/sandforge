import { describe, it, expect, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import i18n from '../../i18n';
import fr from '../../i18n/locales/fr.json';
import type { CompareContentCoverage } from '@sandforge/shared';
import { ContentCoverage } from './ContentCoverage';

const budget = { components: 500, seconds: 90 };

function coverage(notCompared: Partial<CompareContentCoverage['notCompared']>, compared = 522) {
  return {
    compared,
    notCompared: { unreadable: 0, read_failed: 0, over_budget: 0, ...notCompared },
    budget,
  };
}

describe('ContentCoverage', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('says how many of the components both orgs hold were compared by content', () => {
    render(<ContentCoverage coverage={coverage({ over_budget: 24900, unreadable: 8 })} />);

    expect(screen.getByTestId('compare-coverage-compared').textContent).toBe(
      'Content compared for 522 of the 25430 components both orgs hold.',
    );
  });

  it('says why the rest were not, with the bound one run reads within', () => {
    render(
      <ContentCoverage
        coverage={coverage({ over_budget: 24900, unreadable: 8, read_failed: 2 })}
      />,
    );

    expect(screen.getByTestId('compare-coverage-over-budget').textContent).toBe(
      'Beyond what one run reads (500 per org, 90 s): 24900',
    );
    expect(screen.getByTestId('compare-coverage-unreadable').textContent).toBe(
      'Content that cannot be read, such as Apex from a managed package: 8',
    );
    expect(screen.getByTestId('compare-coverage-read-failed').textContent).toBe('Read failed: 2');
    expect(screen.getByTestId('compare-coverage-left-out').textContent).toContain(
      'the risk score leaves it out',
    );
  });

  it('names only the reasons that apply', () => {
    render(<ContentCoverage coverage={coverage({ read_failed: 1 })} />);

    expect(screen.getByTestId('compare-coverage-read-failed')).toBeDefined();
    expect(screen.queryByTestId('compare-coverage-over-budget')).toBeNull();
    expect(screen.queryByTestId('compare-coverage-unreadable')).toBeNull();
  });

  it('says nothing of what was not compared when everything was', () => {
    render(<ContentCoverage coverage={coverage({}, 40)} />);

    expect(screen.getByTestId('compare-coverage-compared').textContent).toBe(
      'Content compared for 40 of the 40 components both orgs hold.',
    );
    expect(screen.queryByTestId('compare-coverage-left-out')).toBeNull();
  });

  it('shows nothing for a result that does not say what it read', () => {
    const { container } = render(<ContentCoverage coverage={undefined} />);

    expect(container.innerHTML).toBe('');
  });

  it('speaks the language the panel is set to', async () => {
    // The panel receives a language's strings from the extension; here, the file itself.
    i18n.addResourceBundle('fr', 'translation', fr, true, true);
    await i18n.changeLanguage('fr');

    render(<ContentCoverage coverage={coverage({ unreadable: 3 })} />);

    expect(screen.getByTestId('compare-coverage-unreadable').textContent).toBe(
      "Contenu illisible, comme l'Apex d'un package géré : 3",
    );
  });
});
