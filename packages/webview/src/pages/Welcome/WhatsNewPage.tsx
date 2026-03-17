import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/Button';
import { useAppStore } from '../../stores/useAppStore';
import type { ModuleRoute } from '../../stores/useAppStore';

/** Feature category determines the icon displayed. */
type FeatureCategory = 'feature' | 'fix' | 'improvement';

/** A single feature entry for the What's New list. */
interface Feature {
  category: FeatureCategory;
  titleKey: string;
  descKey: string;
  /** Optional route to navigate to when "Try it now" is clicked. */
  navigateTo?: ModuleRoute;
}

/** SVG icon components per category. */
const CATEGORY_ICONS: Record<FeatureCategory, React.ReactNode> = {
  feature: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" data-testid="icon-feature">
      <path
        d="M10 2l2.5 5.5L18 8.5l-4 4 1 5.5L10 15.5 4.5 18l1-5.5-4-4 5.5-1L10 2z"
        fill="var(--sf-accent, #E8A838)"
      />
    </svg>
  ),
  fix: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" data-testid="icon-fix">
      <path
        d="M14.5 2.5l3 3-2 2-1.5-1.5-4 4 1.5 1.5-2 2-3-3 2-2 1.5 1.5 4-4-1.5-1.5 2-2z"
        fill="var(--sf-text-secondary, #868686)"
      />
    </svg>
  ),
  improvement: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" data-testid="icon-improvement">
      <path
        d="M10 16V4m0 0l-4 4m4-4l4 4"
        stroke="#4ec9b0"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
};

const FEATURES: Feature[] = [
  {
    category: 'feature',
    titleKey: 'onboarding.whatsNew.i18n',
    descKey: 'onboarding.whatsNew.i18nDesc',
    navigateTo: 'settings',
  },
  {
    category: 'feature',
    titleKey: 'onboarding.whatsNew.help',
    descKey: 'onboarding.whatsNew.helpDesc',
    navigateTo: 'help',
  },
  {
    category: 'feature',
    titleKey: 'onboarding.whatsNew.onboarding',
    descKey: 'onboarding.whatsNew.onboardingDesc',
    navigateTo: 'welcome',
  },
  {
    category: 'improvement',
    titleKey: 'onboarding.whatsNew.a11y',
    descKey: 'onboarding.whatsNew.a11yDesc',
  },
  {
    category: 'improvement',
    titleKey: 'onboarding.whatsNew.branding',
    descKey: 'onboarding.whatsNew.brandingDesc',
  },
];

/** Props for WhatsNewPage component. */
export interface WhatsNewPageProps {
  /** Current extension version. */
  version: string;
  /** Called when the user dismisses the panel. */
  onDismiss: () => void;
}

/**
 * What's New page shown after an extension update.
 * Displays a list of new features with category icons,
 * "Try it now" buttons, and a link to the full changelog.
 */
export const WhatsNewPage: React.FC<WhatsNewPageProps> = ({ version, onDismiss }) => {
  const { t } = useTranslation();
  const navigate = useAppStore((s) => s.navigate);

  const handleTryItNow = (route: ModuleRoute): void => {
    onDismiss();
    navigate(route);
  };

  return (
    <div
      className="flex flex-col items-center justify-center min-h-full p-6"
      data-testid="whats-new-page"
      style={{ background: 'var(--vscode-editor-background, #1e1e1e)' }}
    >
      <h1
        className="text-2xl font-bold mb-2"
        style={{ color: 'var(--sf-accent, #E8A838)' }}
      >
        {t('onboarding.whatsNewTitle')}
      </h1>
      <p
        className="text-sm mb-6"
        style={{ color: 'var(--sf-text-secondary, #868686)' }}
      >
        SandForge v{version}
      </p>

      <div className="w-full max-w-md space-y-3">
        {FEATURES.map((feature) => (
          <div
            key={feature.titleKey}
            className="flex items-start gap-3 p-3 rounded-lg"
            data-testid={`feature-${feature.titleKey}`}
            style={{
              background: 'var(--vscode-editorWidget-background, #252526)',
              border: '1px solid var(--vscode-panel-border, #3c3c3c)',
            }}
          >
            <span className="shrink-0 mt-0.5">{CATEGORY_ICONS[feature.category]}</span>
            <div className="flex-1">
              <h3
                className="text-sm font-semibold"
                style={{ color: 'var(--vscode-editor-foreground, #d4d4d4)' }}
              >
                {t(feature.titleKey)}
              </h3>
              <p
                className="text-xs mt-0.5"
                style={{ color: 'var(--sf-text-secondary, #868686)' }}
              >
                {t(feature.descKey)}
              </p>
              {feature.navigateTo && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-2 text-xs"
                  onClick={() => handleTryItNow(feature.navigateTo as ModuleRoute)}
                  data-testid={`try-it-${feature.titleKey}`}
                >
                  {t('onboarding.tryItNow')}
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="flex gap-3 mt-6 items-center">
        <Button
          variant="primary"
          onClick={onDismiss}
          data-testid="whats-new-dismiss"
        >
          {t('onboarding.gotIt')}
        </Button>
        <button
          className="text-xs underline bg-transparent border-none cursor-pointer"
          data-testid="changelog-link"
          style={{ color: 'var(--vscode-textLink-foreground, #3794ff)' }}
          type="button"
        >
          {t('onboarding.viewChangelog')}
        </button>
      </div>
    </div>
  );
};
