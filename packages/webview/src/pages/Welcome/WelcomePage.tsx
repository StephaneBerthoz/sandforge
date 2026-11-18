import React, { useState, useCallback, useImperativeHandle } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Flame, ListChecks, Plug, Snowflake, Sprout } from 'lucide-react';
import { orgDisplayName } from '@sandforge/shared';
import { useAppStore } from '../../stores/useAppStore';
import { useOrgStore } from '../../stores/useOrgStore';
import { orgToFill } from '../../utils/orgToFill';
import { heroFor } from '../../navigation/heroFor';
import type { SupportedLanguage } from '../../i18n';
import { changeLanguageLazy } from '../../i18n';
import { Button } from '../../components/ui/Button';
import { BrandMark } from '../../components/ui/BrandMark';
import { Card, CardBody } from '../../components/ui/Card';
import { ProgressBar } from '../../components/ui/ProgressBar';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { sendBridgeMessage } from '../../bridge/sendBridgeMessage';
import { cn } from '../../theme';

/** Module card definition for the explore step. */
interface UseCasePath {
  id: 'forge' | 'seed' | 'frozen';
  /** The module's icon as the side panel draws it, in its colour. */
  icon: React.ReactNode;
  titleKey: string;
  descKey: string;
  ctaKey: string;
}

/**
 * Seed first, as the side panel, the walkthrough and Help's Getting Started
 * list them: it fills the one empty org a newcomer has, where Forge needs a
 * second org holding real data. The tour led with Forge and ended on Seed.
 *
 * The icons are the side panel's: the tour drew emoji, a flame where Help
 * drew Forge as a hammer, and empty boxes where no colour-emoji font exists.
 */
const USE_CASE_PATHS: UseCasePath[] = [
  {
    id: 'seed',
    icon: <Sprout className="w-8 h-8 text-hue-green" aria-hidden="true" />,
    titleKey: 'onboarding.paths.seedTitle',
    descKey: 'onboarding.paths.seedDesc',
    ctaKey: 'home.openSeed',
  },
  {
    id: 'forge',
    icon: <Flame className="w-8 h-8 text-hue-orange" aria-hidden="true" />,
    titleKey: 'onboarding.paths.forgeTitle',
    descKey: 'onboarding.paths.forgeDesc',
    ctaKey: 'home.openForge',
  },
  {
    id: 'frozen',
    icon: <Snowflake className="w-8 h-8 text-hue-cyan" aria-hidden="true" />,
    titleKey: 'onboarding.paths.frozenTitle',
    descKey: 'onboarding.paths.frozenDesc',
    ctaKey: 'home.openFrozen',
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

/**
 * The tour's steps, each shown by the testid it has always had: the welcome,
 * connecting an org (`1`), the three ways to fill one (`2`), the first steps
 * (`4`). An AI step stood between the last two, and its "Configure AI" said
 * the opposite of the first step's "no AI key": it is gone, and Settings
 * still has its AI tab.
 */
type WelcomeStep = 'bienvenue' | '1' | '2' | '4';

/** Props for the WelcomePage component. */
export interface WelcomePageProps {
  /** Called when the wizard is finished or skipped. */
  onComplete: () => void;
}

/** What the overlay hosting the wizard can ask of it. */
export interface WelcomePageHandle {
  /** Leaves the wizard as its Skip button does. */
  skip: () => void;
}

/**
 * Guided tour, opened from Help → Start Guided Tour: the welcome (logo,
 * language, primary use case), connecting an org while none is, the three
 * ways to fill one (Seed / Forge / Frozen), and the first steps.
 *
 * It used to open by itself on the first panel of every session until it was
 * finished, over the page the walkthrough had sent the user to; the
 * walkthrough is now the one first-run script, and the tour is asked for.
 * Its "Don't show again" box went with that: a tour asked for is shown, and
 * the box, once ticked, made Help's button open nothing at all.
 */
function WelcomePageView(
  { onComplete }: WelcomePageProps,
  ref: React.ForwardedRef<WelcomePageHandle>,
): React.ReactElement | null {
  const { t, i18n } = useTranslation();
  const navigate = useAppStore((s) => s.navigate);
  const orgs = useOrgStore((s) => s.orgs);
  const selectedOrgId = useOrgStore((s) => s.selectedOrgId);
  const fillTarget = orgToFill(orgs, selectedOrgId);
  /**
   * What the last step suggests: the rule the launcher's and Home's heroes
   * follow (`heroFor`). It said "Based on your org type" and "Your sandbox is
   * ready" with no org connected at all; it sent production orgs alone to
   * Monitor, a start that fills nothing, where the launcher offered Forge; and
   * it offered Forge to one org alone, which Forge cannot copy into from
   * itself.
   */
  const hero = heroFor({ orgs, selectedOrgId });
  /**
   * The step that asks for an org is skipped as soon as one is connected: it
   * asked for one with two connected.
   */
  const steps: readonly WelcomeStep[] = orgs.some((org) => org.status === 'connected')
    ? ['bienvenue', '2', '4']
    : ['bienvenue', '1', '2', '4'];
  const [stepIndex, setStepIndex] = useState(0);
  /** An org connected while the tour is open shortens it: the index stays within it. */
  const index = Math.min(stepIndex, steps.length - 1);
  const step = steps[index];
  const lastStep = index === steps.length - 1;
  /** Why the language just picked is not the one on screen, or null. */
  const [languageError, setLanguageError] = useState<string | null>(null);

  const handleNext = useCallback((): void => {
    setStepIndex(Math.min(index + 1, steps.length - 1));
  }, [index, steps.length]);

  const handleBack = useCallback((): void => {
    setStepIndex(Math.max(index - 1, 0));
  }, [index]);

  const handleSkip = useCallback((): void => {
    onComplete();
  }, [onComplete]);

  useImperativeHandle(ref, () => ({ skip: handleSkip }), [handleSkip]);

  const handleOpenSettings = useCallback((): void => {
    onComplete();
    navigate('settings');
  }, [onComplete, navigate]);

  /** Organizations, the tour left for it: it covered connecting. */
  const handleConnectOrg = useCallback((): void => {
    onComplete();
    navigate('orgs');
  }, [onComplete, navigate]);

  /** Organizations on its browser sign-in: the sandbox Forge fills from a production org. */
  const handleAddSandbox = useCallback((): void => {
    onComplete();
    navigate('orgs', { orgAction: 'login-web' });
  }, [onComplete, navigate]);

  /**
   * Seed on its template gallery, the org to fill preselected: the selected
   * org when it is one, else the first connected org that is.
   */
  const openSeed = useCallback((): void => {
    onComplete();
    navigate('seed', {
      seedMode: 'quick-seed',
      targetOrgId: orgToFill(orgs, selectedOrgId)?.id,
    });
  }, [onComplete, navigate, orgs, selectedOrgId]);

  const handleLanguageChange = useCallback(
    (code: SupportedLanguage): void => {
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
      // The failure is said, as Settings says it: otherwise the click simply
      // does nothing.
      setLanguageError(null);
      void changeLanguageLazy(code).then((applied) => {
        if (!applied) {
          const label = LANGUAGES.find((lang) => lang.code === code)?.label ?? code;
          setLanguageError(t('settings.languageLoadFailed', { language: label }));
          return;
        }
        sendBridgeMessage<{ key: string; value: Record<string, unknown> }>('settings:update', {
          key: 'settings',
          value: { language: code },
        });
      });
    },
    [t],
  );

  /** Open a use-case path module, leaving the tour. */
  const handleOpenPath = useCallback(
    (route: 'forge' | 'seed' | 'frozen'): void => {
      if (route === 'seed') {
        openSeed();
        return;
      }
      onComplete();
      navigate(route);
    },
    [onComplete, navigate, openSeed],
  );

  const progressPercent = ((index + 1) / steps.length) * 100;

  return (
    <div
      className="flex flex-col items-center justify-center min-h-full p-6"
      data-testid="welcome-page"
      style={{ background: 'var(--sf-bg-primary)' }}
    >
      {/* Animated Progress Bar */}
      <div className="w-full max-w-2xl mb-6" data-testid="progress-bar">
        <ProgressBar
          value={progressPercent}
          size="sm"
          ariaLabel={t('a11y.stepProgress')}
          barClassName="bg-(--sf-accent)"
        />
      </div>

      {/* Header */}
      <div className="text-center mb-8">
        <h1 className="text-3xl font-bold mb-2" style={{ color: 'var(--sf-text-link)' }}>
          {t('onboarding.welcomeTitle')}
        </h1>
        <p className="text-base" style={{ color: 'var(--sf-text-secondary, #868686)' }}>
          {t('onboarding.welcomeSubtitle')}
        </p>
      </div>

      {/* Step content */}
      <div className="w-full max-w-2xl">
        {/* Step 0: Bienvenue */}
        {step === 'bienvenue' && (
          <div data-testid="welcome-step-bienvenue" className="text-center">
            {/*
              The step leads with the tagline, not with its own title: the
              header above already says "Welcome to SandForge" and the same
              subtitle, and step 0 used to repeat both word for word — the
              first screen a new user sees greeted them twice.
            */}
            <BrandMark className="w-14 h-16 mx-auto mb-4" />
            <p className="mb-6 text-sm" style={{ color: 'var(--sf-text-secondary)' }}>
              {t('onboarding.welcomeTagline')}
            </p>
            {/* Primary use case — what SandForge is for. The box looked like
                a link and answered no click: it opens Seed on its gallery,
                and Forge, which it does not open, is said under it. */}
            <div className="mb-6 mx-auto max-w-md">
              <button
                type="button"
                className={cn(
                  'group w-full flex items-center gap-3 rounded-lg px-4 py-3 text-left',
                  'hover:ring-1 hover:ring-(--sf-accent) transition-shadow',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--sf-accent)',
                )}
                style={{
                  border: '1px solid var(--sf-accent, #E8A838)',
                  background: 'var(--sf-bg-secondary, #252526)',
                }}
                onClick={openSeed}
                data-testid="welcome-hero-usecase"
              >
                <Sprout className="w-5 h-5 shrink-0 text-hue-green" aria-hidden="true" />
                <span
                  className="flex-1 text-sm font-semibold"
                  style={{ color: 'var(--sf-text-link)' }}
                >
                  {t('onboarding.heroTitle')}
                </span>
                <ArrowRight
                  className="w-4 h-4 shrink-0 text-text-secondary transition-transform group-hover:translate-x-0.5"
                  aria-hidden="true"
                />
              </button>
              <p className="mt-2 text-xs" style={{ color: 'var(--sf-text-secondary, #868686)' }}>
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
              {languageError && (
                <div className="mt-3 text-left">
                  <ErrorBanner
                    data-testid="language-error"
                    message={languageError}
                    onDismiss={() => setLanguageError(null)}
                  />
                </div>
              )}
            </div>
          </div>
        )}

        {/* Step 1: Connect Org, while none is connected */}
        {step === '1' && (
          <div data-testid="welcome-step-1" className="text-center">
            <Plug className="w-12 h-12 mx-auto mb-4 text-text-secondary" aria-hidden="true" />
            <h2 className="text-xl font-semibold mb-2" style={{ color: 'var(--sf-text-primary)' }}>
              {t('onboarding.step1Title')}
            </h2>
            <p className="mb-6" style={{ color: 'var(--sf-text-secondary, #868686)' }}>
              {t('onboarding.step1Desc')}
            </p>
            <div className="flex gap-3 justify-center">
              <Button variant="primary" onClick={handleConnectOrg}>
                {t('onboarding.connectOrg')}
              </Button>
            </div>
          </div>
        )}

        {/* Step 2: Pick a use-case path */}
        {step === '2' && (
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
                    {path.icon}
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

        {/* Step 4: First steps, for the orgs registered */}
        {step === '4' && (
          <div data-testid="welcome-step-4" className="text-center">
            <ListChecks className="w-12 h-12 mx-auto mb-4 text-text-secondary" aria-hidden="true" />
            <h2 className="text-xl font-semibold mb-2" style={{ color: 'var(--sf-text-link)' }}>
              {t('onboarding.step4Title')}
            </h2>
            <p
              className="text-sm mb-6"
              style={{ color: 'var(--sf-text-primary)' }}
              data-testid="welcome-suggestion"
            >
              {hero.kind === 'none' || hero.kind === 'firstOrg'
                ? t('onboarding.connectFirst')
                : hero.kind === 'reconnect'
                  ? t('onboarding.reconnectFirst', { alias: hero.alias })
                  : hero.kind === 'addSandbox'
                    ? t('onboarding.addSandboxFirst', { alias: hero.alias })
                    : t('onboarding.suggestSeedFor', {
                        alias: hero.kind === 'seed' ? hero.alias : orgDisplayName(fillTarget),
                      })}
            </p>
            <div className="flex flex-wrap gap-3 justify-center mb-4">
              {(hero.kind === 'none' || hero.kind === 'firstOrg') && (
                <Button
                  variant="primary"
                  onClick={handleConnectOrg}
                  data-testid="welcome-connect-org-btn"
                >
                  {t('onboarding.connectOrg')}
                </Button>
              )}
              {hero.kind === 'reconnect' && (
                <Button
                  variant="primary"
                  onClick={handleConnectOrg}
                  data-testid="welcome-reconnect-btn"
                >
                  {t('home.openOpModule', { module: t('nav.orgs') })}
                </Button>
              )}
              {hero.kind === 'addSandbox' && (
                <Button
                  variant="primary"
                  onClick={handleAddSandbox}
                  data-testid="welcome-add-sandbox-btn"
                >
                  {t('home.loginWeb')}
                </Button>
              )}
              {(hero.kind === 'seed' || hero.kind === 'forge' || hero.kind === 'afterRefresh') && (
                <Button variant="primary" onClick={openSeed} data-testid="welcome-open-seed-btn">
                  {t('home.openSeed')}
                </Button>
              )}
              {/* Forge copies into the org to fill from another: offered from
                  two orgs connected on, never to one alone. */}
              {(hero.kind === 'forge' || hero.kind === 'afterRefresh') && (
                <Button
                  variant="secondary"
                  onClick={() => handleOpenPath('forge')}
                  data-testid="welcome-start-forge-btn"
                >
                  {t('home.openForge')}
                </Button>
              )}
              {hero.kind !== 'none' && hero.kind !== 'firstOrg' && (
                <Button variant="secondary" onClick={handleOpenSettings}>
                  {t('home.openSettings')}
                </Button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Navigation */}
      <div className="flex items-center gap-4 mt-8">
        {index > 0 && (
          <Button variant="ghost" size="sm" onClick={handleBack}>
            {t('common.back')}
          </Button>
        )}
        {!lastStep && (
          <Button variant="primary" size="sm" onClick={handleNext}>
            {t('common.next')}
          </Button>
        )}
        {/* The last step's way out read Skip, as if the tour had been left
            unfinished. */}
        {lastStep ? (
          <Button variant="ghost" size="sm" onClick={handleSkip} data-testid="done-button">
            {t('onboarding.done')}
          </Button>
        ) : (
          <Button variant="ghost" size="sm" onClick={handleSkip} data-testid="skip-button">
            {t('onboarding.skipOnboarding')}
          </Button>
        )}
      </div>

      {/* Step indicators */}
      <div className="flex gap-2 mt-4">
        {steps.map((each, i) => (
          <div
            key={each}
            className="rounded-full transition-all"
            data-testid={`step-indicator-${String(i)}`}
            style={{
              width: index === i ? '24px' : '8px',
              height: '8px',
              background: index === i ? 'var(--sf-accent, #E8A838)' : 'var(--sf-text-secondary)',
            }}
          />
        ))}
      </div>
    </div>
  );
}

/** The wizard, with a handle the hosting overlay uses to skip it on Escape. */
export const WelcomePage = React.forwardRef(WelcomePageView);
