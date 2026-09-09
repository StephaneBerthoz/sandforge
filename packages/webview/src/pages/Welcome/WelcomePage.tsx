import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../stores/useAppStore';
import type { SupportedLanguage } from '../../i18n';
import { changeLanguageLazy } from '../../i18n';
import { Button } from '../../components/ui/Button';
import { Card, CardBody } from '../../components/ui/Card';
import { getPersistedItem, setPersistedItem } from '../../utils/webviewStorage';
import { sendBridgeMessage } from '../../bridge/sendBridgeMessage';

/** Webview state key for "Don't show again" persistence. */
const DONT_SHOW_KEY = 'sandforge-welcome-dont-show';

/** Module card definition for the explore step. */
interface UseCasePath {
  id: 'forge' | 'seed' | 'frozen';
  icon: string;
  titleKey: string;
  descKey: string;
  ctaKey: string;
}

const USE_CASE_PATHS: UseCasePath[] = [
  {
    id: 'forge',
    icon: '\uD83D\uDD25',
    titleKey: 'onboarding.paths.forgeTitle',
    descKey: 'onboarding.paths.forgeDesc',
    ctaKey: 'onboarding.openForge',
  },
  {
    id: 'seed',
    icon: '\uD83C\uDF31',
    titleKey: 'onboarding.paths.seedTitle',
    descKey: 'onboarding.paths.seedDesc',
    ctaKey: 'onboarding.openSeed',
  },
  {
    id: 'frozen',
    icon: '\u2744\uFE0F',
    titleKey: 'onboarding.paths.frozenTitle',
    descKey: 'onboarding.paths.frozenDesc',
    ctaKey: 'onboarding.openFrozen',
  },
];

/**
 * Language options with NATIVE labels, mirroring the Settings selector: a
 * language picker must stay readable even when the UI is currently rendered
 * in a language the user cannot read, so labels are intentionally NOT
 * translated.
 */
const LANGUAGES: ReadonlyArray<{ code: SupportedLanguage; label: string }> = [
  { code: 'en', label: 'English' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'es', label: 'Español' },
  { code: 'ja', label: '日本語' },
  { code: 'pt-BR', label: 'Português (Brasil)' },
];

/** Total number of wizard steps. */
const TOTAL_STEPS = 5;

/** Props for the WelcomePage component. */
export interface WelcomePageProps {
  /** Called when the wizard is finished or skipped. */
  onComplete: () => void;
  /** Override org type for testing (default: 'sandbox'). */
  orgType?: 'sandbox' | 'production';
}

/**
 * 5-step onboarding wizard shown on first launch.
 * Step 0: Bienvenue (logo + language + primary use case), Step 1: Connect Org,
 * Step 2: Pick a use-case path (Forge / Seed / Frozen), Step 3: Configure AI,
 * Step 4: First steps suggestion.
 */
export const WelcomePage: React.FC<WelcomePageProps> = ({ onComplete, orgType = 'sandbox' }) => {
  const { t, i18n } = useTranslation();
  const navigate = useAppStore((s) => s.navigate);
  const [step, setStep] = useState(0);
  const [dontShowAgain, setDontShowAgain] = useState(false);
  /**
   * Honor the "Don't show again" flag: it is written on completion but was
   * never read back, so the wizard kept reappearing whenever the extension
   * re-sent `onboarding:show` (e.g. webview reloaded before finishing).
   * When the flag is set we complete immediately — `onComplete` also sends
   * `onboarding:complete` to the extension, which persists the
   * `sandforge.onboardingCompleted` globalState and stops re-sending
   * `onboarding:show` at startup.
   */
  const [dismissed] = useState(() => getPersistedItem(DONT_SHOW_KEY) === 'true');

  useEffect(() => {
    if (dismissed) {
      onComplete();
    }
  }, [dismissed, onComplete]);

  const handleNext = useCallback((): void => {
    if (step < TOTAL_STEPS - 1) {
      setStep(step + 1);
    }
  }, [step]);

  const handleBack = useCallback((): void => {
    if (step > 0) {
      setStep(step - 1);
    }
  }, [step]);

  const handleFinish = useCallback((): void => {
    if (dontShowAgain) {
      setPersistedItem(DONT_SHOW_KEY, 'true');
    }
    onComplete();
    navigate('monitor');
  }, [dontShowAgain, onComplete, navigate]);

  const handleSkip = useCallback((): void => {
    if (dontShowAgain) {
      setPersistedItem(DONT_SHOW_KEY, 'true');
    }
    onComplete();
  }, [dontShowAgain, onComplete]);

  const handleOpenSettings = useCallback((): void => {
    if (dontShowAgain) {
      setPersistedItem(DONT_SHOW_KEY, 'true');
    }
    onComplete();
    navigate('settings');
  }, [dontShowAgain, onComplete, navigate]);

  const handleLanguageChange = useCallback((code: SupportedLanguage): void => {
    // Loads the locale bundle over the bridge first when it is not loaded
    // yet; the i18n module mirrors every applied change into the VS Code
    // webview state. That state is per-document and dies with the panel, so
    // the wizard's choice must ALSO reach the extension-side settings blob
    // (globalState) — the exact `settings:update` write the Settings page
    // performs on save. Without it the language picked here is gone the
    // moment the onboarding panel closes.
    // Only a change that actually applied is persisted: when the bundle
    // fails to load the UI keeps its current language, and writing the
    // requested one would leave the blob describing a language nobody sees.
    void changeLanguageLazy(code).then((applied) => {
      if (!applied) {
        return;
      }
      sendBridgeMessage<{ key: string; value: Record<string, unknown> }>('settings:update', {
        key: 'settings',
        value: { language: code },
      });
    });
  }, []);

  /** Open a use-case path module and close the wizard. */
  const handleOpenPath = useCallback(
    (route: 'forge' | 'seed' | 'frozen'): void => {
      if (dontShowAgain) {
        setPersistedItem(DONT_SHOW_KEY, 'true');
      }
      onComplete();
      navigate(route);
    },
    [dontShowAgain, onComplete, navigate],
  );

  const progressPercent = ((step + 1) / TOTAL_STEPS) * 100;

  // "Don't show again" was set on a previous run: render nothing while the
  // mount effect above closes the wizard through onComplete.
  if (dismissed) {
    return null;
  }

  return (
    <div
      className="flex flex-col items-center justify-center min-h-full p-6"
      data-testid="welcome-page"
      style={{ background: 'var(--sf-bg-primary)' }}
    >
      {/* Animated Progress Bar */}
      <div
        className="w-full max-w-2xl mb-6 rounded-full overflow-hidden"
        style={{ height: '4px', background: 'var(--sf-text-muted, #6a6a6a)' }}
        data-testid="progress-bar"
        role="progressbar"
        aria-valuenow={progressPercent}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="h-full rounded-full"
          style={{
            width: `${String(progressPercent)}%`,
            background: 'var(--sf-accent, #E8A838)',
            transition: 'width 0.4s ease-in-out',
          }}
        />
      </div>

      {/* Header */}
      <div className="text-center mb-8">
        <h1 className="text-3xl font-bold mb-2" style={{ color: 'var(--sf-accent, #E8A838)' }}>
          {t('onboarding.welcomeTitle')}
        </h1>
        <p className="text-base" style={{ color: 'var(--sf-text-secondary, #868686)' }}>
          {t('onboarding.welcomeSubtitle')}
        </p>
      </div>

      {/* Step content */}
      <div className="w-full max-w-2xl">
        {/* Step 0: Bienvenue */}
        {step === 0 && (
          <div data-testid="welcome-step-bienvenue" className="text-center">
            <div className="text-6xl mb-4">{'\uD83D\uDD25'}</div>
            <h2 className="text-xl font-semibold mb-2" style={{ color: 'var(--sf-text-primary)' }}>
              {t('onboarding.bienvenueTitle')}
            </h2>
            <p className="mb-2" style={{ color: 'var(--sf-text-secondary, #868686)' }}>
              {t('onboarding.bienvenueDesc')}
            </p>
            <p className="text-xs mb-6" style={{ color: 'var(--sf-text-muted, #6a6a6a)' }}>
              {t('onboarding.bienvenueTagline')}
            </p>
            {/* Primary use case — what SandForge is for */}
            <div
              className="mb-6 mx-auto max-w-md rounded-lg px-4 py-3"
              style={{
                border: '1px solid var(--sf-accent, #E8A838)',
                background: 'var(--sf-bg-secondary, #252526)',
              }}
              data-testid="welcome-hero-usecase"
            >
              <p
                className="text-sm font-semibold mb-1"
                style={{ color: 'var(--sf-accent, #E8A838)' }}
              >
                {t('onboarding.heroTitle')}
              </p>
              <p className="text-xs" style={{ color: 'var(--sf-text-secondary, #868686)' }}>
                {t('onboarding.heroDesc')}
              </p>
            </div>
            <div className="mb-4">
              <p className="text-sm font-medium mb-3" style={{ color: 'var(--sf-text-primary)' }}>
                {t('onboarding.chooseLanguage')}
              </p>
              <div className="flex flex-wrap gap-3 justify-center">
                {LANGUAGES.map((lang) => (
                  <Button
                    key={lang.code}
                    variant={i18n.language === lang.code ? 'primary' : 'secondary'}
                    size="sm"
                    onClick={() => handleLanguageChange(lang.code)}
                    data-testid={`lang-${lang.code}`}
                  >
                    {lang.label}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Step 1: Connect Org */}
        {step === 1 && (
          <div data-testid="welcome-step-1" className="text-center">
            <div className="text-5xl mb-4">{'\u26A1'}</div>
            <h2 className="text-xl font-semibold mb-2" style={{ color: 'var(--sf-text-primary)' }}>
              {t('onboarding.step1Title')}
            </h2>
            <p className="mb-6" style={{ color: 'var(--sf-text-secondary, #868686)' }}>
              {t('onboarding.step1Desc')}
            </p>
            <div className="flex gap-3 justify-center">
              <Button
                variant="primary"
                onClick={() => {
                  navigate('orgs');
                  onComplete();
                }}
              >
                {t('onboarding.connectOrg')}
              </Button>
            </div>
          </div>
        )}

        {/* Step 2: Pick a use-case path */}
        {step === 2 && (
          <div data-testid="welcome-step-2">
            <h2
              className="text-xl font-semibold mb-2 text-center"
              style={{ color: 'var(--sf-text-primary)' }}
            >
              {t('onboarding.step2Title')}
            </h2>
            <p
              className="text-sm mb-4 text-center"
              style={{ color: 'var(--sf-text-secondary, #868686)' }}
            >
              {t('onboarding.step2Desc')}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {USE_CASE_PATHS.map((path) => (
                <Card key={path.id} data-testid={`path-card-${path.id}`}>
                  <CardBody className="text-center p-4 flex flex-col items-center gap-2">
                    <div className="text-3xl">{path.icon}</div>
                    <h3
                      className="text-sm font-semibold"
                      style={{ color: 'var(--sf-text-primary)' }}
                    >
                      {t(path.titleKey)}
                    </h3>
                    <p
                      className="text-xs flex-1"
                      style={{ color: 'var(--sf-text-secondary, #868686)' }}
                    >
                      {t(path.descKey)}
                    </p>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => handleOpenPath(path.id)}
                      data-testid={`welcome-open-${path.id}-btn`}
                    >
                      {t(path.ctaKey)}
                    </Button>
                  </CardBody>
                </Card>
              ))}
            </div>
          </div>
        )}

        {/* Step 3: Configure AI (Optional) */}
        {step === 3 && (
          <div data-testid="welcome-step-3" className="text-center">
            <div className="text-5xl mb-4">{'\uD83E\uDD16'}</div>
            <h2 className="text-xl font-semibold mb-2" style={{ color: 'var(--sf-text-primary)' }}>
              {t('onboarding.step3Title')}
            </h2>
            <p className="mb-6" style={{ color: 'var(--sf-text-secondary, #868686)' }}>
              {t('onboarding.step3Desc')}
            </p>
            <p className="text-xs mb-6" style={{ color: 'var(--sf-text-muted, #6a6a6a)' }}>
              {t('onboarding.aiOptional')}
            </p>
          </div>
        )}

        {/* Step 4: First Steps (suggestion based on org type) */}
        {step === 4 && (
          <div data-testid="welcome-step-4" className="text-center">
            <div className="text-5xl mb-4">{'\uD83D\uDE80'}</div>
            <h2
              className="text-xl font-semibold mb-2"
              style={{ color: 'var(--sf-accent, #E8A838)' }}
            >
              {t('onboarding.step4Title')}
            </h2>
            <p className="mb-4" style={{ color: 'var(--sf-text-secondary, #868686)' }}>
              {t('onboarding.step4Desc')}
            </p>
            <p className="text-sm mb-6" style={{ color: 'var(--sf-text-primary)' }}>
              {orgType === 'production'
                ? t('onboarding.suggestMonitor')
                : t('onboarding.suggestSeedAndSync')}
            </p>
            <div className="flex gap-3 justify-center mb-4">
              {orgType === 'production' ? (
                <Button variant="primary" onClick={handleFinish}>
                  {t('onboarding.openMonitor')}
                </Button>
              ) : (
                <>
                  <Button
                    variant="primary"
                    onClick={() => {
                      if (dontShowAgain) {
                        setPersistedItem(DONT_SHOW_KEY, 'true');
                      }
                      onComplete();
                      navigate('seed');
                    }}
                    data-testid="welcome-open-seed-btn"
                  >
                    {t('onboarding.openSeed')}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      if (dontShowAgain) {
                        setPersistedItem(DONT_SHOW_KEY, 'true');
                      }
                      onComplete();
                      navigate('sync');
                    }}
                    data-testid="welcome-open-sync-btn"
                  >
                    {t('onboarding.openSync')}
                  </Button>
                </>
              )}
              <Button variant="secondary" onClick={handleOpenSettings}>
                {t('onboarding.openSettings')}
              </Button>
            </div>
            <label
              className="flex items-center gap-2 justify-center text-xs cursor-pointer"
              style={{ color: 'var(--sf-text-muted, #6a6a6a)' }}
            >
              <input
                type="checkbox"
                checked={dontShowAgain}
                onChange={(e) => setDontShowAgain(e.target.checked)}
                data-testid="dont-show-again"
              />
              {t('onboarding.dontShowAgain')}
            </label>
          </div>
        )}
      </div>

      {/* Navigation */}
      <div className="flex items-center gap-4 mt-8">
        {step > 0 && step < TOTAL_STEPS && (
          <Button variant="ghost" size="sm" onClick={handleBack}>
            {t('common.back')}
          </Button>
        )}
        {step < TOTAL_STEPS - 1 && (
          <Button variant="primary" size="sm" onClick={handleNext}>
            {t('common.next')}
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={handleSkip} data-testid="skip-button">
          {t('onboarding.skipOnboarding')}
        </Button>
      </div>

      {/* Step indicators */}
      <div className="flex gap-2 mt-4">
        {Array.from({ length: TOTAL_STEPS }, (_, i) => (
          <div
            key={i}
            className="rounded-full transition-all"
            data-testid={`step-indicator-${String(i)}`}
            style={{
              width: step === i ? '24px' : '8px',
              height: '8px',
              background:
                step === i ? 'var(--sf-accent, #E8A838)' : 'var(--sf-text-muted, #6a6a6a)',
            }}
          />
        ))}
      </div>
    </div>
  );
};
