import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BaseMessage, ForgeConfig, ForgeGraph, ForgePlanResponse } from '@sandforge/shared';
import { sendBridgeMessage } from '../../bridge/sendBridgeMessage';
import { useMessageListener } from '../../hooks/useMessageBus';
import type { MetadataDiffEntry } from '../../stores/useForgeStore';
import { useForgeStore } from '../../stores/useForgeStore';
import { LiveGraph } from '../../components/graph/LiveGraph';
import { ReviewPlanTab } from './ReviewPlanTab';
import { ReviewAnonymizationTab } from './ReviewAnonymizationTab';
import { ReviewComplianceTab } from './ReviewComplianceTab';
import { ReviewMetadataTab } from './ReviewMetadataTab';
import { ForgePreviewCard } from './ForgePreviewCard';

/** Tabs available in the Review phase right panel. */
type ReviewTab = 'plan' | 'anonymization' | 'compliance' | 'metadata';

/**
 * Objects sent per diff request.
 *
 * The extension-side Zod schema caps the array at 100 (each entry costs a
 * describe on both orgs), and it rejects the whole payload past that — so a
 * wide graph has to be trimmed here or the tab gets an INVALID_PAYLOAD error
 * instead of the diffs for the objects that did fit.
 */
const METADATA_DIFF_MAX_OBJECTS = 100;

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
  const plan = useForgeStore((s) => s.plan);
  const setPhase = useForgeStore((s) => s.setPhase);
  const toggleNodeIncluded = useForgeStore((s) => s.toggleNodeIncluded);
  const metadataDiffs = useForgeStore((s) => s.metadataDiffs);

  const piiFieldCount = graph?.nodes.reduce((sum, n) => sum + n.piiFields.length, 0) ?? 0;
  const anonymizePII = config?.anonymizePII ?? false;
  const setPlan = useForgeStore((s) => s.setPlan);
  const [planError, setPlanError] = useState<string | null>(null);

  // useForgeForm sends forge:plan:request and ForgeHandler answers it, but
  // nothing consumed the reply: `plan` stayed null and the Plan tab showed
  // "Generating execution plan…" for the rest of the session. Its own comment
  // claimed "the wizard's Review tab listens for forge:plan:response" — this is
  // that listener.
  useMessageListener<ForgePlanResponse>(
    'forge:plan:response',
    useCallback(
      (msg) => {
        setPlan(msg.payload.plan);
        setPlanError(null);
      },
      [setPlan],
    ),
  );

  useMessageListener<BaseMessage & { payload: { message: string } }>(
    'forge:plan:error',
    useCallback((msg) => setPlanError(msg.payload.message), []),
  );

  const setMetadataDiffs = useForgeStore((s) => s.setMetadataDiffs);
  const [metadataPending, setMetadataPending] = useState(false);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const metadataRequested = useRef(false);

  /**
   * Ask the extension to diff source and target schemas.
   *
   * `forge:metadata-diff:request` has been routed and implemented since
   * Forge v2, but no webview code ever sent it: `metadataDiffs` had no writer,
   * so the Metadata tab reported "no differences" for orgs that were in fact
   * incompatible. The ref makes it one request per Review mount — the handler
   * emits an `operation:started` per request, and re-firing on every render
   * would flood the activity feed with phantom operations.
   */
  useEffect(() => {
    if (!graph || !config || metadataRequested.current) return;
    metadataRequested.current = true;
    setMetadataPending(true);
    sendBridgeMessage<{ sourceOrgId: string; targetOrgId: string; objectApiNames: string[] }>(
      'forge:metadata-diff:request',
      {
        sourceOrgId: config.sourceOrgId,
        targetOrgId: config.targetOrgId,
        objectApiNames: graph.nodes
          .slice(0, METADATA_DIFF_MAX_OBJECTS)
          .map((node) => node.objectApiName),
      },
    );
  }, [graph, config]);

  useMessageListener<BaseMessage & { payload: { diffs: MetadataDiffEntry[] } }>(
    'forge:metadata-diff:response',
    useCallback(
      (msg) => {
        setMetadataDiffs(msg.payload.diffs);
        setMetadataPending(false);
        setMetadataError(null);
      },
      [setMetadataDiffs],
    ),
  );

  // NOT_INITIALIZED (no diff service configured) is a plausible steady state,
  // so without this the tab would sit on its loading text forever.
  useMessageListener<BaseMessage & { payload: { message: string } }>(
    'forge:metadata-diff:error',
    useCallback((msg) => {
      setMetadataError(msg.payload.message);
      setMetadataPending(false);
    }, []),
  );

  /**
   * Start the forge run.
   *
   * The phase switch alone is not enough: ForgeExecution renders mission
   * control and then waits on `forge:progress`, which the extension only ever
   * emits from inside its `forge:execute` handler. Without this request the
   * run never starts and the view spins indefinitely.
   */
  const handleExecute = useCallback(() => {
    if (!graph || !config) return;
    sendBridgeMessage<{ graph: ForgeGraph; config: ForgeConfig }>('forge:execute', {
      graph,
      config,
    });
    setPhase('execution');
  }, [graph, config, setPhase]);

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
      {graph && (
        <ForgePreviewCard
          graph={graph}
          plan={plan}
          cycleCount={plan?.cycleResolutions.length ?? 0}
          truncated={graph.truncated === true}
        />
      )}
      <div className="flex gap-4 min-h-[500px]">
        {/* Graph panel (60%) */}
        <div className="w-3/5 rounded-lg border border-subtle bg-surface-1 overflow-hidden">
          {graph && <LiveGraph graph={graph} onIncludeToggle={toggleNodeIncluded} />}
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
            {activeTab === 'plan' && <ReviewPlanTab error={planError} />}
            {activeTab === 'anonymization' && <ReviewAnonymizationTab />}
            {activeTab === 'compliance' && <ReviewComplianceTab />}
            {activeTab === 'metadata' && (
              <ReviewMetadataTab pending={metadataPending} error={metadataError} />
            )}
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
          onClick={handleExecute}
          disabled={!graph || !config}
          className="px-6 py-2 text-sm font-semibold bg-forge text-white rounded-lg hover:bg-forge/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {t('forge.executeForge', 'Execute Forge')}
        </button>
      </div>
    </div>
  );
};
