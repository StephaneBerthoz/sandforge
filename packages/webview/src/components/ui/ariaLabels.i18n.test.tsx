import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

import en from '../../i18n/locales/en.json';
import { Logo } from './Logo';
import { PageHeader } from './PageHeader';
import { Sparkline } from './Sparkline';
import { Timeline } from './Timeline';
import { Tooltip } from './Tooltip';
import { Wizard } from './Wizard';

/*
 * `t` echoes its key, so any accessible name still hardcoded in a component
 * renders as English prose instead of a dotted key. An aria-label is invisible
 * to a sighted reviewer, which is exactly why it needs a mechanical guard.
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
}));

/** Resolve a dotted key against the reference catalogue. */
function lookup(dotted: string): unknown {
  return dotted
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
      en,
    );
}

describe('accessible names go through i18n', () => {
  it('labels the logo with a key', () => {
    render(<Logo />);
    expect(screen.getByTestId('logo-svg').getAttribute('aria-label')).toBe('a11y.logo');
  });

  it('labels the page-header breadcrumb with a key', () => {
    render(<PageHeader title="Monitor" breadcrumb={['Home', 'Monitor']} />);
    expect(screen.getByTestId('page-header-breadcrumb').getAttribute('aria-label')).toBe(
      'common.breadcrumb',
    );
  });

  it('labels the sparkline with a key, single point and curve alike', () => {
    const { unmount } = render(<Sparkline data={[42]} />);
    expect(screen.getByTestId('sparkline').getAttribute('aria-label')).toBe('a11y.sparklineChart');
    unmount();

    render(<Sparkline data={[10, 20, 30]} />);
    expect(screen.getByTestId('sparkline').getAttribute('aria-label')).toBe('a11y.sparklineChart');
  });

  it('labels the timeline list with a key', () => {
    render(<Timeline items={[{ title: 'Started', timestamp: '10:00' }]} />);
    expect(screen.getByRole('list').getAttribute('aria-label')).toBe('a11y.timeline');
  });

  it('labels the tooltip dismiss button with a key', () => {
    vi.useFakeTimers();
    try {
      render(
        <Tooltip content="Hint" dismissible onDismiss={vi.fn()}>
          <button type="button">trigger</button>
        </Tooltip>,
      );
      // The bubble mounts 300 ms after the trigger takes focus.
      fireEvent.focus(screen.getByText('trigger'));
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(screen.getByTestId('tooltip-dismiss').getAttribute('aria-label')).toBe(
        'common.dismiss',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('labels the wizard step navigator with a key', () => {
    render(
      <Wizard
        steps={[{ id: 'one', labelKey: 'common.next' }]}
        currentStep={0}
        onStepChange={vi.fn()}
      >
        <div />
      </Wizard>,
    );
    expect(screen.getByTestId('wizard-step-indicator').getAttribute('aria-label')).toBe(
      'a11y.stepProgress',
    );
  });

  it('backs every accessible-name key with an entry in the reference locale', () => {
    for (const key of [
      'a11y.logo',
      'a11y.sparklineChart',
      'a11y.timeline',
      'a11y.stepProgress',
      'a11y.welcomeWizard',
      'a11y.whatsNew',
      'a11y.easterEgg',
      'a11y.trendChart',
      'a11y.csvImportSteps',
      'a11y.mapped',
      'common.breadcrumb',
      'common.dismiss',
    ]) {
      expect(typeof lookup(key), `${key} missing from en.json`).toBe('string');
    }
  });
});
