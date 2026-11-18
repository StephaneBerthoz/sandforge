import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import i18n from '../../i18n';
import en from '../../i18n/locales/en.json';
import fr from '../../i18n/locales/fr.json';
import de from '../../i18n/locales/de.json';
import es from '../../i18n/locales/es.json';
import ja from '../../i18n/locales/ja.json';
import ptBR from '../../i18n/locales/pt-BR.json';
import { FORGE_PHASES, ForgePhaseSteps } from './ForgePhaseSteps';

/** Each step's name and where it stands, in order. */
function steps(): Array<[string, string | null]> {
  return screen
    .getAllByRole('listitem')
    .map((item) => [item.textContent ?? '', item.getAttribute('data-status')]);
}

describe('ForgePhaseSteps', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('names the five phases of a run in order, by the names the page gives them', () => {
    render(<ForgePhaseSteps phase="input" reviewSkipped={false} />);
    const list = screen.getByRole('list', { name: 'Step progress' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['1What to clone', '2Graph discovery', '3Review', '4Run', '5Results']);
    expect(FORGE_PHASES).toEqual(['input', 'discovery', 'review', 'execution', 'results']);
  });

  it('marks the phase on screen as the current step, those before it done and those after it to come', () => {
    render(<ForgePhaseSteps phase="review" reviewSkipped={false} />);
    expect(steps().map(([, status]) => status)).toEqual([
      'done',
      'done',
      'current',
      'next',
      'next',
    ]);
    const current = screen.getByTestId('forge-phase-step-review');
    expect(current.getAttribute('aria-current')).toBe('step');
    expect(
      screen.getAllByRole('listitem').filter((item) => item.hasAttribute('aria-current')),
    ).toHaveLength(1);
  });

  it('says Review skipped, never done, for a run Clone directly sent past it', () => {
    render(<ForgePhaseSteps phase="execution" reviewSkipped />);
    const review = screen.getByTestId('forge-phase-step-review');
    expect(review.getAttribute('data-status')).toBe('skipped');
    expect(review.textContent).toBe('3Review(skipped)');
    expect(screen.getByTestId('forge-phase-step-discovery').getAttribute('data-status')).toBe(
      'done',
    );
  });

  it('says nothing skipped while the run has not gone past Review', () => {
    render(<ForgePhaseSteps phase="discovery" reviewSkipped />);
    expect(screen.queryByTestId('forge-phase-step-skipped')).toBeNull();
  });

  it.each([
    ['fr', fr],
    ['de', de],
    ['es', es],
    ['ja', ja],
    ['pt-BR', ptBR],
  ] as const)('names the phases and a skipped Review in %s', async (lng, catalogue) => {
    i18n.addResourceBundle(lng, 'translation', catalogue, true, true);
    await i18n.changeLanguage(lng);
    render(<ForgePhaseSteps phase="results" reviewSkipped />);
    for (const phase of FORGE_PHASES) {
      expect(screen.getByTestId(`forge-phase-step-${phase}`).textContent).toContain(
        catalogue.forge.phaseName[phase],
      );
    }
    expect(screen.getByTestId('forge-phase-step-skipped').textContent).toBe(
      `(${catalogue.forge.phaseSkipped})`,
    );
    expect(catalogue.forge.phaseSkipped).not.toBe(en.forge.phaseSkipped);
  });
});
