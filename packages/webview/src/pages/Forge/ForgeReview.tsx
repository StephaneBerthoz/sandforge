import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useForgeStore } from '../../stores/useForgeStore';
import { LiveGraph } from '../../components/graph/LiveGraph';
import { ReviewPlanTab } from './ReviewPlanTab';
import { ReviewAnonymizationTab } from './ReviewAnonymizationTab';
import { ReviewComplianceTab } from './ReviewComplianceTab';
import { ReviewMetadataTab } from './ReviewMetadataTab';

/** Tabs available in the Review phase right panel. */
type ReviewTab = 'plan' | 'anonymization' | 'compliance' | 'metadata';

/**
 * Main review phase component for the Forge wizard.
 *
 * Split layout with the dependency graph on the left (60%) and a
 * tabbed panel on the right (40%) covering Plan, Anonymization,
 * Compliance, and Metadata tabs. Action bar with Back and Execute buttons.
 */
export const ForgeReview: React.FC = () => {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<ReviewTab>('plan');
  const graph = useForgeStore((s) => s.graph);
  const config = useForgeStore((s) => s.config);
  const setPhase = useForgeStore((s) => s.setPhase);
  const toggleNodeIncluded = useForgeStore((s) => s.toggleNodeIncluded);
  const metadataDiffs = useForgeStore((s) => s.metadataDiffs);

  const piiFieldCount =
    graph?.nodes.reduce((sum, n) => sum + n.piiFields.length, 0) ?? 0;
  const anonymizePII = config?.anonymizePII ?? false;

  const tabs: Array<{
    id: ReviewTab;
    label: string;
    badge?: number;
    disabled?: boolean;
  }> = [
    { id: 'plan', label: t('forge.review.planTab', 'Plan') },
    {
      id: 'anonymization',
      label: t('forge.review.anonymizationTab', 'Anonymization'),
      badge: piiFieldCount,
      disabled: !anonymizePII,
    },
    { id: 'compliance', label: t('forge.review.complianceTab', 'Compliance') },
    {
      id: 'metadata',
      label: t('forge.review.metadataTab', 'Metadata'),
      badge: metadataDiffs.length > 0 ? metadataDiffs.length : undefined,
    },
  ];

  return (
    <div data-testid="forge-review" className="flex flex-col gap-4">
      <div className="flex gap-4 min-h-[500px]">
        {/* Graph panel (60%) */}
        <div className="w-3/5 rounded-lg border border-subtle bg-surface-1 overflow-hidden">
          {graph && (
            <LiveGraph graph={graph} onIncludeToggle={toggleNodeIncluded} />
          )}
        </div>

        {/* Tabbed panel (40%) */}
        <div className="w-2/5 rounded-lg border border-subtle bg-surface-1 flex flex-col">
          {/* Tab bar */}
          <div
            data-testid="review-tabs"
            role="tablist"
            aria-label={t('forge.review.tabs', 'Review tabs')}
            className="flex border-b border-subtle"
          >
            {tabs.map((tab) => (
              <button
                key={tab.id}
                id={`tab-${tab.id}`}
                data-testid={`tab-${tab.id}`}
                role="tab"
                aria-selected={activeTab === tab.id}
                aria-controls={`tabpanel-${tab.id}`}
                onClick={() => !tab.disabled && setActiveTab(tab.id)}
                disabled={tab.disabled}
                className={`px-3 py-2 text-xs font-medium transition-colors flex items-center gap-1 ${
                  activeTab === tab.id
                    ? 'text-forge border-b-2 border-forge'
                    : tab.disabled
                      ? 'text-text-muted/50 cursor-not-allowed'
                      : 'text-text-muted hover:text-text-primary'
                }`}
              >
                {tab.label}
                {tab.badge !== undefined && tab.badge > 0 && (
                  <span className="bg-forge/20 text-forge text-[9px] px-1 rounded-full">
                    {tab.badge}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div
            role="tabpanel"
            id={`tabpanel-${activeTab}`}
            aria-labelledby={`tab-${activeTab}`}
            className="flex-1 overflow-y-auto p-3"
          >
            {activeTab === 'plan' && <ReviewPlanTab />}
            {activeTab === 'anonymization' && <ReviewAnonymizationTab />}
            {activeTab === 'compliance' && <ReviewComplianceTab />}
            {activeTab === 'metadata' && <ReviewMetadataTab />}
          </div>
        </div>
      </div>

      {/* Action bar */}
      <div className="flex items-center justify-between">
        <button
          data-testid="back-button"
          onClick={() => setPhase('discovery')}
          className="px-4 py-2 text-sm text-text-muted hover:text-text-primary transition-colors"
        >
          {t('forge.review.back', '\u2190 Back to Discovery')}
        </button>
        <button
          data-testid="execute-button"
          onClick={() => setPhase('execution')}
          className="px-6 py-2 text-sm font-semibold bg-forge text-white rounded-lg hover:bg-forge/90 transition-colors"
        >
          {t('forge.executeForge', 'Execute Forge')}
        </button>
      </div>
    </div>
  );
};
