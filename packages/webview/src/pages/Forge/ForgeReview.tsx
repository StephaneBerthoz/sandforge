import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  BaseMessage,
  ForgeAutomationResponse,
  ForgeGraph,
  ForgePlanResponse,
  ForgeTargetAutomation,
} from '@sandforge/shared';
import { firedOnInsert } from '@sandforge/shared';
import { sendBridgeMessage } from '../../bridge/sendBridgeMessage';
import { useMessageListener } from '../../hooks/useMessageBus';
import type { MetadataDiffEntry } from '../../stores/useForgeStore';
import { useForgeStore } from '../../stores/useForgeStore';
import { useForgeObjectsView } from '../../stores/useForgeViewStore';
import { LiveGraph } from '../../components/graph/LiveGraph';
import { ForgeTableView } from './ForgeTableView';
import { ForgeViewToggle } from './ForgeViewToggle';
import { ReviewPlanTab } from './ReviewPlanTab';
import { ReviewAnonymizationTab } from './ReviewAnonymizationTab';
import { ReviewComplianceTab } from './ReviewComplianceTab';
import { ReviewMetadataTab } from './ReviewMetadataTab';
import { ReviewAutomationTab } from './ReviewAutomationTab';
import { ReviewGapsTab, useUndecidedBlockingGaps } from './ReviewGapsTab';
import { ForgePreviewCard } from './ForgePreviewCard';
import { ReviewLeftOutCost } from './ReviewLeftOutCost';
import { ReviewFilesOption, filesBlockExecute } from './ReviewFilesOption';
import { ForgeRunGateNotice } from './ForgeRunGateNotice';
import { startForgeRun } from './startForgeRun';
import { useForgeGaps } from './useForgeGaps';
import { ReviewGapsRead } from './ReviewGapsRead';

/** Tabs available in the Review phase right panel. */
type ReviewTab = 'plan' | 'anonymization' | 'compliance' | 'metadata' | 'automation' | 'gaps';

/**
 * The graph the target's automation is read for: the objects the user left
 * out count as written, so one taken back in on Review has its automation
 * read already. The tab leaves out what the user leaves out when it shows it.
 */
function graphForAutomation(graph: ForgeGraph): ForgeGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      if (node.leftOutByUser !== true) return node;
      const taken = { ...node, included: true };
      delete taken.leftOutByUser;
      return taken;
    }),
  };
}

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
 * Split layout with the dependency graph, or its table, on the left (60%)
 * and a tabbed panel on the right (40%) covering Plan, Anonymization,
 * Compliance, Metadata, Automation and Gaps tabs. Action bar with Back and
 * Execute buttons.
 */
export const ForgeReview: React.FC = () => {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<ReviewTab>('plan');
  const graph = useForgeStore((s) => s.graph);
  const config = useForgeStore((s) => s.config);
  const plan = useForgeStore((s) => s.plan);
  const setPhase = useForgeStore((s) => s.setPhase);
  const toggleNodeIncluded = useForgeStore((s) => s.toggleNodeIncluded);
  /** The graph or its table, as on the discovery and execution screens around it. */
  const view = useForgeObjectsView(graph?.nodes.length ?? 0);
  const metadataDiffs = useForgeStore((s) => s.metadataDiffs);

  const piiFieldCount = graph?.nodes.reduce((sum, n) => sum + n.piiFields.length, 0) ?? 0;
  const anonymizePII = config?.anonymizePII ?? false;
  // A run that anonymizes waits for the files to be accepted as they are.
  const filesBlocked = useForgeStore(filesBlockExecute);
  const setPlan = useForgeStore((s) => s.setPlan);
  const fillPersonalFields = useForgeStore((s) => s.fillPersonalFields);
  const [planError, setPlanError] = useState<string | null>(null);

  // useForgeForm sends forge:plan:request and ForgeHandler answers it, but
  // nothing consumed the reply: `plan` stayed null and the Plan tab showed
  // "Generating execution plan…" for the rest of the session. Its own comment
  // claimed "the wizard's Review tab listens for forge:plan:response" — this is
  // that listener. A starter template's graph comes back with the personal
  // fields its objects hold: built without discovery, it named none, and the
  // Anonymization tab counted zero with the toggle on.
  useMessageListener<ForgePlanResponse>(
    'forge:plan:response',
    useCallback(
      (msg) => {
        setPlan(msg.payload.plan);
        if (msg.payload.graph) fillPersonalFields(msg.payload.graph);
        setPlanError(null);
      },
      [setPlan, fillPersonalFields],
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
  const [automation, setAutomation] = useState<ForgeTargetAutomation | null>(null);
  const [automationError, setAutomationError] = useState<string | null>(null);
  const gapsRead = useForgeGaps();
  const requestGaps = gapsRead.request;
  /** The objects of the graph the user has left out: their automation fires no more. */
  const leftOut = useMemo(
    () =>
      new Set(
        (graph?.nodes ?? []).filter((node) => !node.included).map((node) => node.objectApiName),
      ),
    [graph],
  );

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
    // What the target runs on the records the run writes, read with the diff
    // and once as well: a clone fired the target's flows on every record it
    // created, emails among them, and nothing said so before the run.
    sendBridgeMessage<{ targetOrgId: string; graph: ForgeGraph }>('forge:automation:request', {
      targetOrgId: config.targetOrgId,
      graph: graphForAutomation(graph),
    });
    // And what the target's metadata holds against the rows: its validation
    // and duplicate rules, the fields only it requires, its lookup filters,
    // its API budget. The extension reads an object the user left out too.
    requestGaps(config, graph);
  }, [graph, config, requestGaps]);

  useMessageListener<ForgeAutomationResponse>(
    'forge:automation:response',
    useCallback((msg) => {
      setAutomation(msg.payload.automation);
      setAutomationError(null);
    }, []),
  );

  useMessageListener<BaseMessage & { payload: { message: string } }>(
    'forge:automation:error',
    useCallback((msg) => setAutomationError(msg.payload.message), []),
  );

  /** What fires as the run inserts its records, on the objects it still writes. */
  const firedAtInsert = useMemo(
    () =>
      automation
        ? firedOnInsert({
            objects: automation.objects.filter((object) => !leftOut.has(object.objectApiName)),
          })
        : 0,
    [automation, leftOut],
  );

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

  /** The gaps that will refuse rows with no decision taken yet, counted on their tab. */
  const undecidedBlocking = useUndecidedBlockingGaps();

  /** Start the forge run, as Clone directly starts one (see `startForgeRun`). */
  const handleExecute = useCallback(() => {
    startForgeRun();
  }, []);

  /** Simulate the run: the same path, every record checked, nothing written. */
  const handleSimulate = useCallback(() => {
    startForgeRun({ dryRun: true });
  }, []);

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
    {
      id: 'automation',
      label: t('forge.review.automationTab'),
      badge: firedAtInsert > 0 ? firedAtInsert : undefined,
    },
    {
      id: 'gaps',
      label: t('forge.review.gapsTab'),
      badge: undecidedBlocking > 0 ? undecidedBlocking : undefined,
    },
  ];

  return (
    <div data-testid="forge-review" className="flex flex-col gap-4">
      {/* Why the last run stopped before it wrote anything, when it did:
          refused, or cancelled at one of its questions, it came back here. */}
      <ForgeRunGateNotice />
      {graph && (
        <ForgePreviewCard
          graph={graph}
          plan={plan}
          cycleCount={plan?.cycleResolutions.length ?? 0}
          truncated={graph.truncated === true}
        />
      )}
      {graph && <ReviewLeftOutCost graph={graph} />}
      <ReviewGapsRead gaps={gapsRead} />
      {/* The view follows the sandforge.forge.graphView setting and the switch
          of the discovery before it: Review drew the graph whatever its size,
          hundreds of objects included. */}
      {graph && (
        <div className="flex items-center gap-2">
          <ForgeViewToggle view={view} />
        </div>
      )}
      <div className="flex gap-4 min-h-[500px]">
        {/* Graph or table panel (60%). The table is laid over the panel
            rather than in its flow: in the flow, hundreds of rows would make
            the panel, and the tabs beside it, as tall as the list; laid over,
            it scrolls within the height the row already has. */}
        <div className="relative w-3/5 rounded-lg border border-subtle bg-surface-1 overflow-hidden">
          {graph &&
            (view === 'graph' ? (
              <LiveGraph graph={graph} onIncludeToggle={toggleNodeIncluded} />
            ) : (
              <ForgeTableView
                graph={graph}
                onToggleIncluded={toggleNodeIncluded}
                className="absolute inset-0"
              />
            ))}
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
                    ? 'text-hue-forge border-b-2 border-forge'
                    : tab.disabled
                      ? 'text-text-muted cursor-not-allowed'
                      : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                {tab.label}
                {tab.badge !== undefined && tab.badge > 0 && (
                  <span className="bg-forge/20 text-hue-forge text-[9px] px-1 rounded-full">
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
            {activeTab === 'automation' && (
              <ReviewAutomationTab
                automation={automation}
                error={automationError}
                leftOut={leftOut}
                applyAssignmentRules={config?.applyAssignmentRules === true}
              />
            )}
            {activeTab === 'gaps' && <ReviewGapsTab />}
          </div>
        </div>
      </div>

      <ReviewFilesOption />

      {/* Action bar */}
      <div className="flex items-center justify-between gap-3">
        <button
          data-testid="back-button"
          onClick={() => setPhase('discovery')}
          className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary transition-colors"
        >
          {t('forge.review.back', '\u2190 Back to Discovery')}
        </button>
        <div className="flex items-center gap-3">
          {filesBlocked && (
            <p
              id="forge-files-execute-hint"
              data-testid="forge-files-execute-hint"
              className="text-xs text-text-secondary"
            >
              {t('forge.files.asIsNeeded')}
            </p>
          )}
          {/* A simulation reads and checks every record as Execute's run
              would, through the write stage, and writes nothing. */}
          <button
            type="button"
            data-testid="simulate-button"
            onClick={handleSimulate}
            disabled={!graph || !config || filesBlocked}
            aria-describedby={filesBlocked ? 'forge-files-execute-hint' : undefined}
            className="px-4 py-2 text-sm font-semibold rounded-lg border border-forge text-hue-forge transition-colors hover:bg-forge/10 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {t('forge.simulation.action')}
          </button>
          <button
            data-testid="execute-button"
            onClick={handleExecute}
            disabled={!graph || !config || filesBlocked}
            aria-describedby={filesBlocked ? 'forge-files-execute-hint' : undefined}
            className="px-6 py-2 text-sm font-semibold bg-hue-forge text-(--sf-bg-primary) rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {t('forge.executeForge', 'Execute Forge')}
          </button>
        </div>
      </div>
    </div>
  );
};
