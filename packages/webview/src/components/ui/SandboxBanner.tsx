import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSandboxDetection } from '../../hooks/useSandboxDetection';
import { Button } from './Button';
import { Icon } from './Icon';
import { getPersistedItem, setPersistedItem } from '../../utils/webviewStorage';

/** Webview state key for persisting banner dismissal. */
const DISMISS_KEY = 'sandforge-sandbox-banner-dismissed';

/** Props for the SandboxBanner component. */
export interface SandboxBannerProps {
  /** Called when user clicks a navigation button. */
  onNavigate: (page: 'seed' | 'sync') => void;
}

/**
 * Contextual banner shown when any connected org is a Sandbox.
 * Suggests populating the sandbox via Seed or Sync.
 * Dismissible with persistence to the VS Code webview state.
 */
export const SandboxBanner: React.FC<SandboxBannerProps> = ({ onNavigate }) => {
  const { t } = useTranslation();
  const { hasSandbox } = useSandboxDetection();
  const [dismissed, setDismissed] = useState(() => getPersistedItem(DISMISS_KEY) === 'true');

  const handleDismiss = useCallback(() => {
    setDismissed(true);
    setPersistedItem(DISMISS_KEY, 'true');
  }, []);

  if (!hasSandbox || dismissed) {
    return null;
  }

  return (
    <div
      className="flex items-center gap-3 p-3 rounded-lg border border-amber-600/40 bg-amber-950/20"
      data-testid="sandbox-banner"
      role="status"
    >
      <Icon name="database" className="text-amber-400 shrink-0" />
      <span className="flex-1 text-sm text-amber-200">{t('onboarding.sandboxBanner')}</span>
      <div className="flex items-center gap-2 shrink-0">
        <Button
          variant="primary"
          size="sm"
          onClick={() => onNavigate('seed')}
          data-testid="sandbox-banner-seed-btn"
        >
          {t('onboarding.openSeed')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onNavigate('sync')}
          data-testid="sandbox-banner-sync-btn"
        >
          {t('onboarding.openSync')}
        </Button>
        <button
          className="text-amber-400/60 hover:text-amber-400 transition-colors p-1"
          onClick={handleDismiss}
          aria-label={t('common.dismiss')}
          data-testid="sandbox-banner-dismiss"
        >
          <Icon name="close" />
        </button>
      </div>
    </div>
  );
};
