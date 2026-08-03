import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

export type AIProviderState = 'closed' | 'open' | 'half-open';

export interface AIProviderStatusBannerProps {
  provider: 'anthropic' | 'openai' | 'custom';
  state: AIProviderState;
  cooldownEndsAt?: string;
  userMessageKey?: string;
}

/**
 * Banner that surfaces the AI provider's circuit-breaker state.
 *
 * Renders nothing when state === 'closed' (the happy default — no noise).
 * Renders a yellow inline strip on 'half-open' ("reconnexion en cours...").
 * Renders a red inline strip on 'open' with a localised message + a live
 * mm:ss countdown to `cooldownEndsAt`.
 *
 * The text NEVER includes any secret material; the userMessageKey resolves
 * to one of `ai.error.overloaded` / `ai.error.rateLimit` / `ai.error.auth`
 * / `ai.error.transient` / `ai.error.unknown` — all hard-coded copy.
 */
export const AIProviderStatusBanner: React.FC<AIProviderStatusBannerProps> = ({
  provider,
  state,
  cooldownEndsAt,
  userMessageKey,
}) => {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (state !== 'open' || !cooldownEndsAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [state, cooldownEndsAt]);

  if (state === 'closed') return null;

  const countdown = (() => {
    if (!cooldownEndsAt) return '';
    const ends = new Date(cooldownEndsAt).getTime();
    const diff = Math.max(0, ends - now);
    const m = Math.floor(diff / 60_000);
    const s = Math.floor((diff % 60_000) / 1000);
    return `${m}:${s.toString().padStart(2, '0')}`;
  })();

  const key = userMessageKey ?? 'ai.error.unknown';
  const fallback =
    key === 'ai.error.overloaded' ? 'AI provider temporarily overloaded.' : 'AI provider error.';
  const message = t(key, { defaultValue: fallback, countdown });

  const colour =
    state === 'open'
      ? 'bg-[var(--sf-color-bg-error,#fef2f2)] text-[var(--sf-color-text-error,#991b1b)] border-[var(--sf-color-border-error,#fca5a5)]'
      : 'bg-[var(--sf-color-bg-warning,#fefce8)] text-[var(--sf-color-text-warning,#854d0e)] border-[var(--sf-color-border-warning,#fde047)]';

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="ai-provider-status-banner"
      data-state={state}
      data-provider={provider}
      className={`px-3 py-2 text-sm border-l-4 ${colour}`}
    >
      <span data-testid="ai-provider-status-banner-message">{message}</span>
      {state === 'open' && cooldownEndsAt && (
        <span
          data-testid="ai-provider-status-banner-countdown"
          className="ml-2 font-mono"
        >{` (${countdown})`}</span>
      )}
    </div>
  );
};
