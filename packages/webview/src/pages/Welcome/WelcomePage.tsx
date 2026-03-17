import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../stores/useAppStore';
import { Button } from '../../components/ui/Button';
import { Card, CardBody } from '../../components/ui/Card';

/** localStorage key for "Don't show again" persistence. */
const DONT_SHOW_KEY = 'sandforge-welcome-dont-show';

/** Module card definition for the explore step. */
interface ModuleCard {
  id: string;
  icon: string;
  titleKey: string;
  descKey: string;
}

const MODULES: ModuleCard[] = [
  { id: 'monitor', icon: '\uD83D\uDCCA', titleKey: 'nav.monitor', descKey: 'onboarding.modules.monitor' },
  { id: 'seed', icon: '\uD83C\uDF31', titleKey: 'nav.seed', descKey: 'onboarding.modules.seed' },
  { id: 'sync', icon: '\uD83D\uDD04', titleKey: 'nav.sync', descKey: 'onboarding.modules.sync' },
  { id: 'compare', icon: '\uD83D\uDD0D', titleKey: 'nav.compare', descKey: 'onboarding.modules.compare' },
  { id: 'dataops', icon: '\uD83D\uDEE1', titleKey: 'nav.dataops', descKey: 'onboarding.modules.dataops' },
  { id: 'automation', icon: '\u26A1', titleKey: 'nav.automation', descKey: 'onboarding.modules.automation' },
];

/** Supported language options for the Bienvenue step. */
interface LanguageOption {
  code: string;
  labelKey: string;
}

const LANGUAGES: LanguageOption[] = [
  { code: 'en', labelKey: 'settings.languages.en' },
  { code: 'fr', labelKey: 'settings.languages.fr' },
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
 * Step 0: Bienvenue (logo + language), Step 1: Connect Org,
 * Step 2: Explore modules, Step 3: Configure AI, Step 4: First steps suggestion.
 */
export const WelcomePage: React.FC<WelcomePageProps> = ({ onComplete, orgType = 'sandbox' }) => {
  const { t, i18n } = useTranslation();
  const navigate = useAppStore((s) => s.navigate);
  const [step, setStep] = useState(0);
  const [dontShowAgain, setDontShowAgain] = useState(false);

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
      localStorage.setItem(DONT_SHOW_KEY, 'true');
    }
    onComplete();
    navigate('monitor');
  }, [dontShowAgain, onComplete, navigate]);

  const handleSkip = useCallback((): void => {
    if (dontShowAgain) {
      localStorage.setItem(DONT_SHOW_KEY, 'true');
    }
    onComplete();
  }, [dontShowAgain, onComplete]);

  const handleOpenSettings = useCallback((): void => {
    if (dontShowAgain) {
      localStorage.setItem(DONT_SHOW_KEY, 'true');
    }
    onComplete();
    navigate('settings');
  }, [dontShowAgain, onComplete, navigate]);

  const handleLanguageChange = useCallback((code: string): void => {
    void i18n.changeLanguage(code);
  }, [i18n]);

  const progressPercent = ((step + 1) / TOTAL_STEPS) * 100;

  return (
    <div
      className="flex flex-col items-center justify-center min-h-full p-6"
      data-testid="welcome-page"
      style={{ background: 'var(--vscode-editor-background, #1e1e1e)' }}
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
        <h1
          className="text-3xl font-bold mb-2"
          style={{ color: 'var(--sf-accent, #E8A838)' }}
        >
          {t('onboarding.welcomeTitle')}
        </h1>
        <p
          className="text-base"
          style={{ color: 'var(--sf-text-secondary, #868686)' }}
        >
          {t('onboarding.welcomeSubtitle')}
        </p>
      </div>

      {/* Step content */}
      <div className="w-full max-w-2xl">
        {/* Step 0: Bienvenue */}
        {step === 0 && (
          <div data-testid="welcome-step-bienvenue" className="text-center">
            <div className="text-6xl mb-4">{'\uD83D\uDD25'}</div>
            <h2
              className="text-xl font-semibold mb-2"
              style={{ color: 'var(--vscode-editor-foreground, #d4d4d4)' }}
            >
              {t('onboarding.bienvenueTitle')}
            </h2>
            <p
              className="mb-2"
              style={{ color: 'var(--sf-text-secondary, #868686)' }}
            >
              {t('onboarding.bienvenueDesc')}
            </p>
            <p
              className="text-xs mb-6"
              style={{ color: 'var(--sf-text-muted, #6a6a6a)' }}
            >
              {t('onboarding.bienvenueTagline')}
            </p>
            <div className="mb-4">
              <p
                className="text-sm font-medium mb-3"
                style={{ color: 'var(--vscode-editor-foreground, #d4d4d4)' }}
              >
                {t('onboarding.chooseLanguage')}
              </p>
              <div className="flex gap-3 justify-center">
                {LANGUAGES.map((lang) => (
                  <Button
                    key={lang.code}
                    variant={i18n.language === lang.code ? 'primary' : 'secondary'}
                    size="sm"
                    onClick={() => handleLanguageChange(lang.code)}
                    data-testid={`lang-${lang.code}`}
                  >
                    {t(lang.labelKey)}
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
            <h2
              className="text-xl font-semibold mb-2"
              style={{ color: 'var(--vscode-editor-foreground, #d4d4d4)' }}
            >
              {t('onboarding.step1Title')}
            </h2>
            <p
              className="mb-6"
              style={{ color: 'var(--sf-text-secondary, #868686)' }}
            >
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

        {/* Step 2: Explore Modules */}
        {step === 2 && (
          <div data-testid="welcome-step-2">
            <h2
              className="text-xl font-semibold mb-4 text-center"
              style={{ color: 'var(--vscode-editor-foreground, #d4d4d4)' }}
            >
              {t('onboarding.step2Title')}
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {MODULES.map((mod) => (
                <Card key={mod.id} data-testid={`module-card-${mod.id}`}>
                  <CardBody className="text-center p-4 cursor-pointer hover:opacity-80 transition-opacity">
                    <div className="text-3xl mb-2">{mod.icon}</div>
                    <h3
                      className="text-sm font-semibold mb-1"
                      style={{ color: 'var(--vscode-editor-foreground, #d4d4d4)' }}
                    >
                      {t(mod.titleKey)}
                    </h3>
                    <p
                      className="text-xs"
                      style={{ color: 'var(--sf-text-secondary, #868686)' }}
                    >
                      {t(mod.descKey)}
                    </p>
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
            <h2
              className="text-xl font-semibold mb-2"
              style={{ color: 'var(--vscode-editor-foreground, #d4d4d4)' }}
            >
              {t('onboarding.step3Title')}
            </h2>
            <p
              className="mb-6"
              style={{ color: 'var(--sf-text-secondary, #868686)' }}
            >
              {t('onboarding.step3Desc')}
            </p>
            <p
              className="text-xs mb-6"
              style={{ color: 'var(--sf-text-muted, #6a6a6a)' }}
            >
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
            <p
              className="mb-4"
              style={{ color: 'var(--sf-text-secondary, #868686)' }}
            >
              {t('onboarding.step4Desc')}
            </p>
            <p
              className="text-sm mb-6"
              style={{ color: 'var(--vscode-editor-foreground, #d4d4d4)' }}
            >
              {orgType === 'production'
                ? t('onboarding.suggestMonitor')
                : t('onboarding.suggestSeed')}
            </p>
            <div className="flex gap-3 justify-center mb-4">
              {orgType === 'production' ? (
                <Button variant="primary" onClick={handleFinish}>
                  {t('onboarding.openMonitor')}
                </Button>
              ) : (
                <Button
                  variant="primary"
                  onClick={() => {
                    if (dontShowAgain) {
                      localStorage.setItem(DONT_SHOW_KEY, 'true');
                    }
                    onComplete();
                    navigate('forge');
                  }}
                >
                  {t('onboarding.openForge')}
                </Button>
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
                step === i
                  ? 'var(--sf-accent, #E8A838)'
                  : 'var(--sf-text-muted, #6a6a6a)',
            }}
          />
        ))}
      </div>
    </div>
  );
};
