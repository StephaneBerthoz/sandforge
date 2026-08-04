import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';

import { AIProviderStatusBanner } from './AIProviderStatusBanner';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string; countdown?: string }) => {
      const map: Record<string, string> = {
        'ai.error.overloaded': 'AI provider temporarily overloaded. Retrying in {countdown}.',
        'ai.error.rateLimit': 'AI rate limit reached. Retry in {countdown}.',
        'ai.error.auth': 'AI key invalid or missing.',
        'ai.error.transient': 'Temporary AI error.',
        'ai.error.unknown': 'Unexpected AI error.',
      };
      const tpl = map[key] ?? opts?.defaultValue ?? key;
      return tpl.replace('{countdown}', opts?.countdown ?? '');
    },
  }),
}));

describe('AIProviderStatusBanner', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders nothing when state is closed', () => {
    const { container } = render(<AIProviderStatusBanner provider="anthropic" state="closed" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders yellow half-open banner without countdown', () => {
    render(
      <AIProviderStatusBanner
        provider="anthropic"
        state="half-open"
        userMessageKey="ai.error.transient"
      />,
    );
    const banner = screen.getByTestId('ai-provider-status-banner');
    expect(banner).toBeTruthy();
    expect(banner.getAttribute('data-state')).toBe('half-open');
    expect(screen.queryByTestId('ai-provider-status-banner-countdown')).toBeNull();
  });

  it('renders red open banner WITH countdown when cooldownEndsAt is provided', () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    render(
      <AIProviderStatusBanner
        provider="anthropic"
        state="open"
        cooldownEndsAt={new Date('2026-01-01T00:05:00Z').toISOString()}
        userMessageKey="ai.error.overloaded"
      />,
    );
    const banner = screen.getByTestId('ai-provider-status-banner');
    expect(banner.getAttribute('data-state')).toBe('open');
    const countdown = screen.getByTestId('ai-provider-status-banner-countdown');
    expect(countdown.textContent).toContain('5:00');
  });

  it('countdown decrements when timers advance', () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    render(
      <AIProviderStatusBanner
        provider="anthropic"
        state="open"
        cooldownEndsAt={new Date('2026-01-01T00:05:00Z').toISOString()}
        userMessageKey="ai.error.overloaded"
      />,
    );
    expect(screen.getByTestId('ai-provider-status-banner-countdown').textContent).toContain('5:00');
    act(() => {
      // advanceTimersByTime also bumps Date.now() under fake timers — no need
      // to setSystemTime separately.
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getByTestId('ai-provider-status-banner-countdown').textContent).toContain('4:30');
  });

  it('NEVER contains literal "sk-ant-" or "Bearer " substrings (defense in depth)', () => {
    render(
      <AIProviderStatusBanner
        provider="anthropic"
        state="open"
        cooldownEndsAt={new Date(Date.now() + 60_000).toISOString()}
        userMessageKey="ai.error.overloaded"
      />,
    );
    const banner = screen.getByTestId('ai-provider-status-banner');
    expect(banner.textContent).not.toMatch(/sk-ant-/);
    expect(banner.textContent).not.toMatch(/Bearer /);
  });
});
