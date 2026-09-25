import React, { useLayoutEffect } from 'react';
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
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      data-testid="icon-feature"
    >
      <path
        d="M10 2l2.5 5.5L18 8.5l-4 4 1 5.5L10 15.5 4.5 18l1-5.5-4-4 5.5-1L10 2z"
        fill="var(--sf-accent, #E8A838)"
      />
    </svg>
  ),
  fix: (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      data-testid="icon-fix"
    >
      <path
        d="M14.5 2.5l3 3-2 2-1.5-1.5-4 4 1.5 1.5-2 2-3-3 2-2 1.5 1.5 4-4-1.5-1.5 2-2z"
        fill="var(--sf-text-secondary, #868686)"
      />
    </svg>
  ),
  improvement: (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      data-testid="icon-improvement"
      className="text-status-success"
    >
      <path
        d="M10 16V4m0 0l-4 4m4-4l4 4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
};

/**
 * Highlights per release, keyed by the exact extension version they describe.
 *
 * The extension sends `whats-new:show` on every version change. A single
 * unkeyed list was therefore shown to every upgrader, under the new version
 * number, long after it stopped describing anything recent. A release that
 * adds no entry here shows no panel at all.
 */
export const WHATS_NEW: Readonly<Record<string, readonly Feature[]>> = {
  '1.39.5': [
    {
      category: 'fix',
      titleKey: 'onboarding.whatsNew.fixRound1395',
      descKey: 'onboarding.whatsNew.fixRound1395Desc',
      navigateTo: 'sync',
    },
  ],
  '1.39.4': [
    {
      category: 'fix',
      titleKey: 'onboarding.whatsNew.fixRound1394',
      descKey: 'onboarding.whatsNew.fixRound1394Desc',
      navigateTo: 'forge',
    },
  ],
  '1.39.3': [
    {
      category: 'improvement',
      titleKey: 'onboarding.whatsNew.react1393',
      descKey: 'onboarding.whatsNew.react1393Desc',
    },
  ],
  '1.39.2': [
    {
      category: 'improvement',
      titleKey: 'onboarding.whatsNew.toolchain1392',
      descKey: 'onboarding.whatsNew.toolchain1392Desc',
    },
  ],
  '1.39.1': [
    {
      category: 'fix',
      titleKey: 'onboarding.whatsNew.fixRound1391',
      descKey: 'onboarding.whatsNew.fixRound1391Desc',
      navigateTo: 'seed',
    },
  ],
  '1.39.0': [
    {
      category: 'feature',
      titleKey: 'onboarding.whatsNew.frozenTakeBack',
      descKey: 'onboarding.whatsNew.frozenTakeBackDesc',
      navigateTo: 'frozen',
    },
    {
      category: 'feature',
      titleKey: 'onboarding.whatsNew.forgeWriteTheRest',
      descKey: 'onboarding.whatsNew.forgeWriteTheRestDesc',
      navigateTo: 'forge',
    },
    {
      category: 'fix',
      titleKey: 'onboarding.whatsNew.fixRound139',
      descKey: 'onboarding.whatsNew.fixRound139Desc',
      navigateTo: 'forge',
    },
  ],
  '1.38.2': [
    {
      category: 'fix',
      titleKey: 'onboarding.whatsNew.fixRound1382',
      descKey: 'onboarding.whatsNew.fixRound1382Desc',
      navigateTo: 'forge',
    },
  ],
  '1.38.1': [
    {
      category: 'fix',
      titleKey: 'onboarding.whatsNew.fixRound1381',
      descKey: 'onboarding.whatsNew.fixRound1381Desc',
      navigateTo: 'forge',
    },
  ],
  '1.38.0': [
    {
      category: 'feature',
      titleKey: 'onboarding.whatsNew.forgeFiles',
      descKey: 'onboarding.whatsNew.forgeFilesDesc',
      navigateTo: 'forge',
    },
    {
      category: 'fix',
      titleKey: 'onboarding.whatsNew.forgeCatalog',
      descKey: 'onboarding.whatsNew.forgeCatalogDesc',
      navigateTo: 'forge',
    },
  ],
  '1.37.0': [
    {
      category: 'feature',
      titleKey: 'onboarding.whatsNew.forgeRemoveRun',
      descKey: 'onboarding.whatsNew.forgeRemoveRunDesc',
      navigateTo: 'forge',
    },
    {
      category: 'fix',
      titleKey: 'onboarding.whatsNew.cancelStops',
      descKey: 'onboarding.whatsNew.cancelStopsDesc',
      navigateTo: 'monitor',
    },
    {
      category: 'fix',
      titleKey: 'onboarding.whatsNew.fixRound137',
      descKey: 'onboarding.whatsNew.fixRound137Desc',
      navigateTo: 'forge',
    },
  ],
  '1.36.0': [
    {
      category: 'fix',
      titleKey: 'onboarding.whatsNew.forgeAnonymizes',
      descKey: 'onboarding.whatsNew.forgeAnonymizesDesc',
      navigateTo: 'forge',
    },
    {
      category: 'fix',
      titleKey: 'onboarding.whatsNew.fixRound136',
      descKey: 'onboarding.whatsNew.fixRound136Desc',
      navigateTo: 'sync',
    },
  ],
  '1.35.0': [
    {
      category: 'feature',
      titleKey: 'onboarding.whatsNew.compareDeploy',
      descKey: 'onboarding.whatsNew.compareDeployDesc',
      navigateTo: 'compare',
    },
    {
      category: 'feature',
      titleKey: 'onboarding.whatsNew.realtimeSync',
      descKey: 'onboarding.whatsNew.realtimeSyncDesc',
      navigateTo: 'sync',
    },
    {
      category: 'feature',
      titleKey: 'onboarding.whatsNew.triggers',
      descKey: 'onboarding.whatsNew.triggersDesc',
      navigateTo: 'automation',
    },
    {
      category: 'feature',
      titleKey: 'onboarding.whatsNew.compliance',
      descKey: 'onboarding.whatsNew.complianceDesc',
      navigateTo: 'dataops',
    },
  ],
  '1.34.0': [
    {
      category: 'feature',
      titleKey: 'onboarding.whatsNew.auditTrail',
      descKey: 'onboarding.whatsNew.auditTrailDesc',
      navigateTo: 'reports',
    },
    {
      category: 'feature',
      titleKey: 'onboarding.whatsNew.dataopsQuality',
      descKey: 'onboarding.whatsNew.dataopsQualityDesc',
      navigateTo: 'dataops',
    },
    {
      category: 'fix',
      titleKey: 'onboarding.whatsNew.seedRuns',
      descKey: 'onboarding.whatsNew.seedRunsDesc',
      navigateTo: 'seed',
    },
    {
      category: 'feature',
      titleKey: 'onboarding.whatsNew.pipelineSteps',
      descKey: 'onboarding.whatsNew.pipelineStepsDesc',
      navigateTo: 'automation',
    },
  ],
  '1.33.0': [
    {
      category: 'improvement',
      titleKey: 'onboarding.whatsNew.compareContent',
      descKey: 'onboarding.whatsNew.compareContentDesc',
      navigateTo: 'compare',
    },
    {
      category: 'feature',
      titleKey: 'onboarding.whatsNew.refreshNoticed',
      descKey: 'onboarding.whatsNew.refreshNoticedDesc',
      navigateTo: 'monitor',
    },
    {
      category: 'fix',
      titleKey: 'onboarding.whatsNew.monitorBounds',
      descKey: 'onboarding.whatsNew.monitorBoundsDesc',
      navigateTo: 'monitor',
    },
  ],
  '1.32.0': [
    {
      category: 'fix',
      titleKey: 'onboarding.whatsNew.frozenLoads',
      descKey: 'onboarding.whatsNew.frozenLoadsDesc',
      navigateTo: 'frozen',
    },
    {
      category: 'fix',
      titleKey: 'onboarding.whatsNew.automationHonest',
      descKey: 'onboarding.whatsNew.automationHonestDesc',
      navigateTo: 'automation',
    },
    {
      category: 'fix',
      titleKey: 'onboarding.whatsNew.monitorReads',
      descKey: 'onboarding.whatsNew.monitorReadsDesc',
      navigateTo: 'monitor',
    },
  ],
  '1.31.0': [
    {
      category: 'fix',
      titleKey: 'onboarding.whatsNew.backupPartial',
      descKey: 'onboarding.whatsNew.backupPartialDesc',
      navigateTo: 'dataops',
    },
  ],
  '1.30.0': [
    {
      category: 'fix',
      titleKey: 'onboarding.whatsNew.autopilotCopies',
      descKey: 'onboarding.whatsNew.autopilotCopiesDesc',
      navigateTo: 'autopilot',
    },
  ],
  '1.29.0': [
    {
      category: 'fix',
      titleKey: 'onboarding.whatsNew.seedFills',
      descKey: 'onboarding.whatsNew.seedFillsDesc',
      navigateTo: 'seed',
    },
  ],
  '1.28.0': [
    {
      category: 'fix',
      titleKey: 'onboarding.whatsNew.syncFinishes',
      descKey: 'onboarding.whatsNew.syncFinishesDesc',
      navigateTo: 'sync',
    },
  ],
  '1.27.1': [
    {
      category: 'fix',
      titleKey: 'onboarding.whatsNew.keyboardEverywhere',
      descKey: 'onboarding.whatsNew.keyboardEverywhereDesc',
      navigateTo: 'home',
    },
  ],
  '1.27.0': [
    {
      category: 'fix',
      titleKey: 'onboarding.whatsNew.fullProductClone',
      descKey: 'onboarding.whatsNew.fullProductCloneDesc',
      navigateTo: 'forge',
    },
  ],
  '1.26.1': [
    {
      category: 'fix',
      titleKey: 'onboarding.whatsNew.scopedRead',
      descKey: 'onboarding.whatsNew.scopedReadDesc',
      navigateTo: 'forge',
    },
  ],
  '1.26.0': [
    {
      category: 'fix',
      titleKey: 'onboarding.whatsNew.sidePanelPlace',
      descKey: 'onboarding.whatsNew.sidePanelPlaceDesc',
      navigateTo: 'home',
    },
  ],
  '1.25.5': [
    {
      category: 'fix',
      titleKey: 'onboarding.whatsNew.deferredScope',
      descKey: 'onboarding.whatsNew.deferredScopeDesc',
      navigateTo: 'forge',
    },
  ],
  '1.25.4': [
    {
      category: 'fix',
      titleKey: 'onboarding.whatsNew.ownerMap',
      descKey: 'onboarding.whatsNew.ownerMapDesc',
      navigateTo: 'forge',
    },
  ],
  '1.25.3': [
    {
      category: 'fix',
      titleKey: 'onboarding.whatsNew.cloneDuplicates',
      descKey: 'onboarding.whatsNew.cloneDuplicatesDesc',
      navigateTo: 'forge',
    },
  ],
  '1.25.2': [
    {
      category: 'fix',
      titleKey: 'onboarding.whatsNew.liveStats',
      descKey: 'onboarding.whatsNew.liveStatsDesc',
      navigateTo: 'autopilot',
    },
  ],
  '1.25.1': [
    {
      category: 'fix',
      titleKey: 'onboarding.whatsNew.uncopyable',
      descKey: 'onboarding.whatsNew.uncopyableDesc',
      navigateTo: 'autopilot',
    },
  ],
  '1.25.0': [
    {
      category: 'fix',
      titleKey: 'onboarding.whatsNew.orgsCrash',
      descKey: 'onboarding.whatsNew.orgsCrashDesc',
      navigateTo: 'orgs',
    },
    {
      category: 'fix',
      titleKey: 'onboarding.whatsNew.forgeCounts',
      descKey: 'onboarding.whatsNew.forgeCountsDesc',
      navigateTo: 'forge',
    },
  ],
  '1.24.2': [
    {
      category: 'fix',
      titleKey: 'onboarding.whatsNew.perObjectMapping',
      descKey: 'onboarding.whatsNew.perObjectMappingDesc',
      navigateTo: 'sync',
    },
    {
      category: 'improvement',
      titleKey: 'onboarding.whatsNew.describeOnce',
      descKey: 'onboarding.whatsNew.describeOnceDesc',
    },
  ],
  '1.24.1': [
    {
      category: 'fix',
      titleKey: 'onboarding.whatsNew.templateRoot',
      descKey: 'onboarding.whatsNew.templateRootDesc',
      navigateTo: 'forge',
    },
  ],
  '1.24.0': [
    {
      category: 'fix',
      titleKey: 'onboarding.whatsNew.stylesheet',
      descKey: 'onboarding.whatsNew.stylesheetDesc',
    },
    {
      category: 'fix',
      titleKey: 'onboarding.whatsNew.syncWrites',
      descKey: 'onboarding.whatsNew.syncWritesDesc',
      navigateTo: 'sync',
    },
    {
      category: 'fix',
      titleKey: 'onboarding.whatsNew.failureReason',
      descKey: 'onboarding.whatsNew.failureReasonDesc',
      navigateTo: 'sync',
    },
    {
      category: 'fix',
      titleKey: 'onboarding.whatsNew.forgeProgress',
      descKey: 'onboarding.whatsNew.forgeProgressDesc',
      navigateTo: 'forge',
    },
    {
      category: 'fix',
      titleKey: 'onboarding.whatsNew.deadKeys',
      descKey: 'onboarding.whatsNew.deadKeysDesc',
    },
  ],
  '1.23.0': [
    {
      category: 'fix',
      titleKey: 'onboarding.whatsNew.syncFidelity',
      descKey: 'onboarding.whatsNew.syncFidelityDesc',
      navigateTo: 'sync',
    },
    {
      category: 'improvement',
      titleKey: 'onboarding.whatsNew.themes',
      descKey: 'onboarding.whatsNew.themesDesc',
    },
    {
      category: 'fix',
      titleKey: 'onboarding.whatsNew.accents',
      descKey: 'onboarding.whatsNew.accentsDesc',
      navigateTo: 'settings',
    },
    {
      category: 'improvement',
      titleKey: 'onboarding.whatsNew.speed',
      descKey: 'onboarding.whatsNew.speedDesc',
      navigateTo: 'monitor',
    },
    {
      category: 'improvement',
      titleKey: 'onboarding.whatsNew.honesty',
      descKey: 'onboarding.whatsNew.honestyDesc',
    },
  ],
  '1.0.0': [
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
  ],
};

/** Props for WhatsNewPage component. */
export interface WhatsNewPageProps {
  /** Current extension version. */
  version: string;
  /** Called when the user dismisses the panel. */
  onDismiss: () => void;
}

/**
 * What's New page shown after an extension update.
 * Displays the highlights listed for `version` with category icons,
 * "Try it now" buttons, and a link to the full changelog.
 */
export const WhatsNewPage: React.FC<WhatsNewPageProps> = ({ version, onDismiss }) => {
  const { t } = useTranslation();
  const navigate = useAppStore((s) => s.navigate);
  const features = WHATS_NEW[version];

  // No highlights for this release: close before the first paint, so the
  // overlay's backdrop never flashes over the panel.
  useLayoutEffect(() => {
    if (!features) {
      onDismiss();
    }
  }, [features, onDismiss]);

  if (!features) {
    return null;
  }

  const handleTryItNow = (route: ModuleRoute): void => {
    onDismiss();
    navigate(route);
  };

  return (
    <div
      className="flex flex-col items-center justify-center min-h-full p-6"
      data-testid="whats-new-page"
      style={{ background: 'var(--sf-bg-primary)' }}
    >
      <h1 className="text-2xl font-bold mb-2" style={{ color: 'var(--sf-text-link)' }}>
        {t('onboarding.whatsNewTitle')}
      </h1>
      <p className="text-sm mb-6" style={{ color: 'var(--sf-text-secondary, #868686)' }}>
        SandForge v{version}
      </p>

      <div className="w-full max-w-md space-y-3">
        {features.map((feature) => (
          <div
            key={feature.titleKey}
            className="flex items-start gap-3 p-3 rounded-lg"
            data-testid={`feature-${feature.titleKey}`}
            style={{
              background: 'var(--sf-bg-card)',
              border: '1px solid var(--sf-border)',
            }}
          >
            <span className="shrink-0 mt-0.5">{CATEGORY_ICONS[feature.category]}</span>
            <div className="flex-1">
              <h3 className="text-sm font-semibold" style={{ color: 'var(--sf-text-primary)' }}>
                {t(feature.titleKey)}
              </h3>
              <p className="text-xs mt-0.5" style={{ color: 'var(--sf-text-secondary, #868686)' }}>
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
        <Button variant="primary" onClick={onDismiss} data-testid="whats-new-dismiss">
          {t('onboarding.gotIt')}
        </Button>
        <button
          className="text-xs underline bg-transparent border-none cursor-pointer"
          data-testid="changelog-link"
          style={{ color: 'var(--sf-text-link)' }}
          type="button"
        >
          {t('onboarding.viewChangelog')}
        </button>
      </div>
    </div>
  );
};
