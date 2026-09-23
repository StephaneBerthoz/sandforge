import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { createInstance, type i18n as I18n } from 'i18next';
import '../../i18n';
import en from '../../i18n/locales/en.json';
import fr from '../../i18n/locales/fr.json';
import ja from '../../i18n/locales/ja.json';
import { CronScheduleBuilder, cronToHuman } from './CronScheduleBuilder';
import type { CronScheduleBuilderProps } from './CronScheduleBuilder';

const defaultProps: CronScheduleBuilderProps = {
  onSubmit: vi.fn(),
  onCancel: vi.fn(),
  configs: [
    { id: 'cfg-1', name: 'My Sync Config' },
    { id: 'cfg-2', name: 'Weekly Backup' },
  ],
};

describe('CronScheduleBuilder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render the form with name input, config selector, and frequency toggle', () => {
    render(<CronScheduleBuilder {...defaultProps} />);
    expect(screen.getByTestId('cron-schedule-builder')).toBeDefined();
    expect(screen.getByTestId('schedule-name-input')).toBeDefined();
    expect(screen.getByTestId('config-selector')).toBeDefined();
    expect(screen.getByTestId('mode-simple-btn')).toBeDefined();
    expect(screen.getByTestId('mode-advanced-btn')).toBeDefined();
  });

  it('should show simple mode panel by default with preset selector', () => {
    render(<CronScheduleBuilder {...defaultProps} />);
    expect(screen.getByTestId('simple-mode-panel')).toBeDefined();
    expect(screen.getByTestId('preset-selector')).toBeDefined();
  });

  it('should show advanced mode with raw text input when toggled', () => {
    render(<CronScheduleBuilder {...defaultProps} />);
    fireEvent.click(screen.getByTestId('mode-advanced-btn'));
    expect(screen.getByTestId('advanced-mode-panel')).toBeDefined();
    expect(screen.getByTestId('raw-cron-input')).toBeDefined();
  });

  it('should call onSubmit with correct data when form is submitted', () => {
    const onSubmit = vi.fn();
    render(<CronScheduleBuilder {...defaultProps} onSubmit={onSubmit} />);

    // Fill in name
    fireEvent.change(screen.getByTestId('schedule-name-input'), {
      target: { value: 'Daily Sync' },
    });

    // Submit
    fireEvent.click(screen.getByTestId('submit-btn'));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const callArg = onSubmit.mock.calls[0][0];
    expect(callArg.name).toBe('Daily Sync');
    expect(callArg.configId).toBe('cfg-1');
    expect(callArg.cron).toBeDefined();
    expect(callArg.timezone).toBeDefined();
  });

  it('should default timezone to local timezone', () => {
    render(<CronScheduleBuilder {...defaultProps} />);
    const selector = screen.getByTestId('timezone-selector') as HTMLSelectElement;
    // The selected timezone should be the local timezone
    expect(selector.value).toBeDefined();
    expect(selector.value.length).toBeGreaterThan(0);
  });

  it('should call onCancel when cancel button is clicked', () => {
    const onCancel = vi.fn();
    render(<CronScheduleBuilder {...defaultProps} onCancel={onCancel} />);
    fireEvent.click(screen.getByTestId('cancel-btn'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('should render with initial values when editing', () => {
    render(
      <CronScheduleBuilder
        {...defaultProps}
        initialName="Existing Schedule"
        initialCron="0 9 * * 1"
        initialTimezone="America/New_York"
        initialConfigId="cfg-2"
      />,
    );
    const nameInput = screen.getByTestId('schedule-name-input') as HTMLInputElement;
    expect(nameInput.value).toBe('Existing Schedule');
  });

  it('should show cron preview', () => {
    render(<CronScheduleBuilder {...defaultProps} />);
    expect(screen.getByTestId('cron-preview')).toBeDefined();
  });
});

/** Accessible name of a form control: its own aria-label, else its labels. */
function accessibleName(el: HTMLElement): string {
  const aria = el.getAttribute('aria-label');
  if (aria) return aria.trim();
  const labels = (el as HTMLInputElement | HTMLSelectElement).labels;
  return Array.from(labels ?? [])
    .map((l) => l.textContent ?? '')
    .join(' ')
    .trim();
}

/** Labels that name nothing — the accessible name is lost for their control. */
function orphanLabels(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll('label'))
    .filter((l) => l.control === null)
    .map((l) => (l.textContent ?? '').trim());
}

describe('CronScheduleBuilder accessible names', () => {
  it('should name every control of the simple-mode form', () => {
    render(<CronScheduleBuilder {...defaultProps} />);
    for (const testId of [
      'schedule-name-input',
      'config-selector',
      'preset-selector',
      'hour-selector',
      'minute-selector',
      'timezone-search',
      'timezone-selector',
      'max-retries-input',
      'notify-complete-checkbox',
      'notify-failure-checkbox',
    ]) {
      expect(accessibleName(screen.getByTestId(testId)), testId).not.toBe('');
    }
  });

  it('should name the raw cron input in advanced mode', () => {
    render(<CronScheduleBuilder {...defaultProps} />);
    fireEvent.click(screen.getByTestId('mode-advanced-btn'));
    expect(accessibleName(screen.getByTestId('raw-cron-input'))).not.toBe('');
  });

  it('should name the monthly day selector', () => {
    render(<CronScheduleBuilder {...defaultProps} />);
    fireEvent.change(screen.getByTestId('preset-selector'), { target: { value: 'monthly' } });
    expect(accessibleName(screen.getByTestId('day-of-month-selector'))).not.toBe('');
  });

  it('should expose the day-of-week toggles as a named group', () => {
    render(<CronScheduleBuilder {...defaultProps} />);
    fireEvent.change(screen.getByTestId('preset-selector'), { target: { value: 'weekly' } });
    const group = screen.getByTestId('day-btn-MON').parentElement as HTMLElement;
    expect(group.getAttribute('role')).toBe('group');
    expect(group.getAttribute('aria-label')).toBeTruthy();
  });

  it('names the day toggles in the language of the page, and says which are picked', () => {
    // They read MON to SUN in every language, and only their fill said which
    // days were on.
    render(<CronScheduleBuilder {...defaultProps} />);
    fireEvent.change(screen.getByTestId('preset-selector'), { target: { value: 'weekly' } });

    expect(screen.getByRole('button', { name: 'Mon', pressed: true })).toBe(
      screen.getByTestId('day-btn-MON'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Wed', pressed: false }));
    expect(screen.getByTestId('day-btn-WED').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('cron-preview').textContent).toContain(
      'Every Monday, Wednesday at 09:00',
    );
  });

  it('should leave no orphan label in any mode', () => {
    render(<CronScheduleBuilder {...defaultProps} />);
    const form = screen.getByTestId('cron-schedule-builder');
    expect(orphanLabels(form)).toEqual([]);

    fireEvent.change(screen.getByTestId('preset-selector'), { target: { value: 'weekly' } });
    expect(orphanLabels(form)).toEqual([]);

    fireEvent.change(screen.getByTestId('preset-selector'), { target: { value: 'monthly' } });
    expect(orphanLabels(form)).toEqual([]);

    fireEvent.click(screen.getByTestId('mode-advanced-btn'));
    expect(orphanLabels(form)).toEqual([]);
  });
});

describe('cronToHuman', () => {
  /** An i18next of its own, with the languages the cases read in. */
  let languages: I18n;
  beforeAll(async () => {
    languages = createInstance();
    await languages.init({
      resources: {
        en: { translation: en },
        fr: { translation: fr },
        ja: { translation: ja },
      },
      lng: 'en',
      fallbackLng: 'en',
      interpolation: { escapeValue: false },
    });
  });
  const inEnglish = (cron: string): string => cronToHuman(cron, languages.getFixedT('en'), 'en');

  it('should convert daily cron to human-readable', () => {
    expect(inEnglish('0 9 * * *')).toBe('Every day at 09:00');
  });

  it('should convert hourly cron to human-readable', () => {
    expect(inEnglish('0 * * * *')).toBe('Every hour');
  });

  it('should convert monthly cron to human-readable', () => {
    expect(inEnglish('30 14 15 * *')).toBe('Monthly on day 15 at 14:30');
  });

  it('names the days of a weekly schedule', () => {
    expect(inEnglish('0 9 * * 1,3')).toBe('Every Monday, Wednesday at 09:00');
    expect(inEnglish('15 7 * * 0')).toBe('Every Sunday at 07:15');
  });

  it('should return raw cron for complex expressions', () => {
    expect(inEnglish('*/5 * * * *')).toBe('*/5 * * * *');
    // Every other hour is not a time of day.
    expect(inEnglish('0 */2 * * *')).toBe('0 */2 * * *');
  });

  it('describes a schedule in the language of the page', () => {
    // It was English in every language, day names included ("Every MON").
    const french = languages.getFixedT('fr');
    expect(cronToHuman('0 9 * * *', french, 'fr')).toBe('Tous les jours à 09:00');
    expect(cronToHuman('0 9 * * 1,3', french, 'fr')).toBe('Chaque lundi, mercredi à 09:00');
    expect(cronToHuman('30 14 15 * *', french, 'fr')).toBe('Tous les mois le 15 à 14:30');
    expect(cronToHuman('0 9 * * 1,3', languages.getFixedT('ja'), 'ja')).toBe(
      '毎週月曜日、水曜日 09:00',
    );
  });
});
