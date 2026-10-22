import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import en from '../../i18n/locales/en.json';
import { LogStream } from './LogStream';

/* `t` echoes its key, so any label still hardcoded in the component shows up
   as English prose instead of a key. */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
}));

describe('LogStream — translated chrome', () => {
  it('resolves the filter tab labels through i18n', () => {
    render(<LogStream entries={[]} />);
    expect(screen.getByTestId('logstream-filter-all').textContent).toBe('forgeRun.logFilterAll');
    expect(screen.getByTestId('logstream-filter-error').textContent).toBe(
      'forgeRun.logFilterErrors',
    );
    expect(screen.getByTestId('logstream-filter-warn').textContent).toBe(
      'forgeRun.logFilterWarnings',
    );
  });

  it('resolves the empty-state line through i18n', () => {
    render(<LogStream entries={[]} />);
    expect(screen.getByTestId('logstream-empty').textContent).toBe('common.noLogEntries');
  });

  it('backs every rendered key with an entry in the reference locale', () => {
    expect(en.forgeRun.logFilterAll).toBe('All');
    expect(en.forgeRun.logFilterErrors).toBe('Errors');
    expect(en.forgeRun.logFilterWarnings).toBe('Warnings');
    expect(en.common.noLogEntries).toBe('No log entries');
  });
});
