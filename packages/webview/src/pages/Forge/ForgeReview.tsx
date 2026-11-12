import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  BaseMessage,
  ForgeAutomationResponse,
  ForgeGraph,
  ForgeTargetAutomation,
} from '@sandforge/shared';
import { blindedBy, emailSendersOf, firedOnInsert, stillRunningOf } from '@sandforge/shared';
import { sendBridgeMessage } from '../../bridge/sendBridgeMessage';
import { useMessageListener } from '../../hooks/useMessageBus';
import type { MetadataDiffEntry } from '../../stores/useForgeStore';
import { useForgeStore } from '../../stores/useForgeStore';
import { forgeGraphIsLarge, useForgeObjectsView } from '../../stores/useForgeViewStore';
import { useOrgStore } from '../../stores/useOrgStore';
import { LiveGraph } from '../../components/graph/lazyGraph';
import { ForgeTableView } from './ForgeTableView';
import { ForgeViewToggle } from './ForgeViewToggle';
import { ReviewPlanTab } from './ReviewPlanTab';
import { ReviewAnonymizationTab } from './ReviewAnonymizationTab';
import { ReviewComplianceTab } from './ReviewComplianceTab';
import { ReviewMetadataTab } from './ReviewMetadataTab';
import { ReviewAutomationTab, forgeRunMuteOffer } from './ReviewAutomationTab';
import { muteOffered } from '../../utils/muteOffer';
import { ReviewGapsTab, useUndecidedBlockingGaps } from './ReviewGapsTab';
import { ReviewPlanLine } from './ReviewPlanLine';
import { ReviewLeftOutCost } from './ReviewLeftOutCost';
import { ReviewFilesOption, filesBlockExecute } from './ReviewFilesOption';
import { ForgeRunGateNotice } from './ForgeRunGateNotice';
import { ForgeRehearseAction } from './ForgeRehearseAction';
import { startForgeRun } from './startForgeRun';
import { clonesOneRecord, clonesWholeOrg } from './forgeRunConfig';
import { useForgeGaps } from './useForgeGaps';
import { ReviewGapsRead } from './ReviewGapsRead';
import { ReviewCheckpointFirst, ReviewControlsTab } from './ReviewControlsTab';
import { useReviewRoom } from './useReviewRoom';
import { ReviewGraphSearch, graphMatches } from './ReviewGraphSearch';
import { ReviewRow } from './ReviewRow';
import {
  anonymizationRowSaid,
  automationRowSaid,
  complianceRowSaid,
  controlsSet,
  forgeRunBuckets,
  gapsRowSaid,
  leftToDecide,
  metadataRowSaid,
  runSentence,
  type ComplianceRowStatus,
} from './reviewSummaries';
import { gapsToShow, objectsLeftOut } from '../../utils/forgeGapDecisions';
import { AutomationMuteBox } from '../../components/ui/AutomationMuteBox';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { cn } from '../../theme';

/** The parts of Review that open and close. */
type ReviewRowId = 'gaps' | 'plan' | 'anonymization' | 'compliance' | 'metadata' | 'automation';

/**
 * The panel width under which the run's column goes under the rows. Tailwind
 * reads a class name whole, so the classes spell the width each time.
 *
 * The column sticks to the top of the panel, no taller than it, its options
 * scrolling within what its actions leave them. It starts under the page's
 * header, though, so its foot starts below the fold: the actions stick to the
 * foot of the panel as well, inside it, or Execute could not be seen until the
 * page was scrolled, the very thing the column is there to end.
 *
 * Under that width the two boxes go, and what they hold takes its place in the
 * page's flow: Execute then sticks to the panel, not to a box under the rows.
 */
const RUN_COLUMN = cn(
  'max-[859px]:contents',
  'min-[860px]:sticky min-[860px]:top-3 min-[860px]:flex min-[860px]:w-[20rem]',
  // As tall as the window holds below where it stands (`useReviewRoom`): held
  // to the window's height less its top, it ran past the window where the page
  // puts it, by as much as the page holds above it, and Controls went under
  // the foot.
  'min-[860px]:max-h-[var(--review-column-room,calc(100vh-1.5rem))]',
  'min-[860px]:shrink-0 min-[860px]:flex-col',
  // A box ticked is scrolled into the column's own view, not 224 pixels above
  // its foot: ticking the mute scrolled Checkpoint first out of the column.
  'min-[860px]:[&&_*]:scroll-my-2',
);
const RUN_FOOT = cn(
  'max-[859px]:contents',
  'min-[860px]:sticky min-[860px]:bottom-0 min-[860px]:z-10 min-[860px]:flex',
  'min-[860px]:shrink-0 min-[860px]:flex-col min-[860px]:gap-2',
  'min-[860px]:bg-(--sf-bg-primary) min-[860px]:py-2',
);

/**
 * The graph the target's automation is read for: the objects the user left
 * out count as written, so one taken back in on Review has its automation
 * read already. The tab leaves out what the user leaves out when it shows it.
 *
 * Of a clone of the whole org, the nodes go without their relations, and
 * never with the objects the org leaves out: up to 1,950 objects and 20,000
 * relations, in a message the panel sends as Review opens and at each read
 * again. Every relation of such a graph is between two of its nodes, and
 * what is read turns only on those that reach past the graph — a lookup to a
 * catalog object discovery stopped before — so the read is the one the run
 * finds kept for its own graph, relations and all. A graph walked from a
 * root keeps them: they say which catalog objects past it the run adds.
 */
function graphForAutomation(graph: ForgeGraph, wholeOrg: boolean): ForgeGraph {
  const sent: ForgeGraph = {
    ...graph,
    nodes: graph.nodes.map((node) => {
      if (node.leftOutByUser !== true) return node;
      const taken = { ...node, included: true };
      delete taken.leftOutByUser;
      return taken;
    }),
    edges: wholeOrg ? [] : graph.edges,
  };
  delete sent.leftOut;
  return sent;
}

/**
 * Ask what the target runs on the objects a run of the graph writes: as
 * Review opens, and again when the user asks.
 */
function requestTargetAutomation(targetOrgId: string, graph: ForgeGraph, wholeOrg: boolean): void {
  sendBridgeMessage<{ targetOrgId: string; graph: ForgeGraph }>('forge:automation:request', {
    targetOrgId,
    graph: graphForAutomation(graph, wholeOrg),
  });
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
 * The run in one sentence and what is left to decide, then its parts as rows
 * that open in place: Gaps, then Plan — with the graph or its table —,
 * Anonymization, Compliance, Metadata and Automation, each saying what it
 * comes to and where it stands. Beside them, and held in view, the column of
 * the run: Checkpoint first, the mute, the files, Controls, Rehearse, Simulate
 * and Execute. Seven tabs beside a graph hid everything but the one open: gaps
 * that would refuse rows were a badge on the sixth.
 */
export const ForgeReview: React.FC = () => {
  const { t } = useTranslation();
  const graph = useForgeStore((s) => s.graph);
  const config = useForgeStore((s) => s.config);
  /** The target org as the bypass assistant names it, and the user the run writes as. */
  const targetOrg = useOrgStore((s) => s.orgs.find((o) => o.id === config?.targetOrgId));
  const sourceOrg = useOrgStore((s) => s.orgs.find((o) => o.id === config?.sourceOrgId));
  const plan = useForgeStore((s) => s.plan);
  const setPhase = useForgeStore((s) => s.setPhase);
  const toggleNodeIncluded = useForgeStore((s) => s.toggleNodeIncluded);
  /** A clone of the whole source org: never simulated nor rehearsed yet, its graph large. */
  const wholeOrg = clonesWholeOrg(config);
  const objectCount = graph?.nodes.length ?? 0;
  /**
   * The graph or its table, as on the discovery and execution screens around
   * it: a large one, a clone of the whole org's among them, listed unless
   * the graph is picked on it, with a word of how slow it is to draw.
   */
  const view = useForgeObjectsView(objectCount, wholeOrg);
  const largeGraph = forgeGraphIsLarge(objectCount, wholeOrg);
  /** What the search of the graph holds, the objects it matches, and the one asked to be shown. */
  const [graphQuery, setGraphQuery] = useState('');
  const highlighted = useMemo(
    () => new Set(graph ? graphMatches(graph, graphQuery) : []),
    [graph, graphQuery],
  );
  const [focus, setFocus] = useState<string | null>(null);
  const metadataDiffs = useForgeStore((s) => s.metadataDiffs);

  const piiFieldCount = graph?.nodes.reduce((sum, n) => sum + n.piiFields.length, 0) ?? 0;
  // A run that anonymizes waits for the files to be accepted as they are.
  const filesBlocked = useForgeStore(filesBlockExecute);
  // The plan, and why it could not be made, are the store's: the input step
  // asks for it as it moves the page here, before this screen's chunk has
  // loaded (useForgeStore's plan listener).
  const planError = useForgeStore((s) => s.planError);

  const setMetadataDiffs = useForgeStore((s) => s.setMetadataDiffs);
  const [metadataPending, setMetadataPending] = useState(false);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const metadataRequested = useRef(false);
  const [automation, setAutomation] = useState<ForgeTargetAutomation | null>(null);
  const [automationError, setAutomationError] = useState<string | null>(null);
  /** A read of the target's automation the user asked for is on its way. */
  const [automationReading, setAutomationReading] = useState(false);
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
    requestTargetAutomation(config.targetOrgId, graph, clonesWholeOrg(config));
    // And what the target's metadata holds against the rows: its validation
    // and duplicate rules, the fields only it requires, its lookup filters,
    // its API budget. The extension reads an object the user left out too.
    requestGaps(config, graph);
  }, [graph, config, requestGaps]);

  /**
   * Read the target's automation again: the extension reads the org for each
   * request, and keeps the newer read for the run Execute starts. A question
   * about what fires, declined, sent the page back here, which read the
   * target before the user had run the command the question copied; the tab
   * then said the bypass was not held until Review was opened again. The
   * read shown stays until the answer lands.
   */
  const readAutomationAgain = useCallback(() => {
    if (!graph || !config) return;
    setAutomationReading(true);
    requestTargetAutomation(config.targetOrgId, graph, clonesWholeOrg(config));
  }, [graph, config]);

  /**
   * Read the target's gaps again: a validation rule's bypass, assigned with
   * the command the Gaps tab copied, showed as not held until Review was
   * opened again. The gaps read stay shown until the answer lands.
   */
  const readGapsAgain = useCallback(() => {
    if (!graph || !config) return;
    requestGaps(config, graph);
  }, [graph, config, requestGaps]);

  useMessageListener<ForgeAutomationResponse>(
    'forge:automation:response',
    useCallback((msg) => {
      setAutomation(msg.payload.automation);
      setAutomationError(null);
      setAutomationReading(false);
    }, []),
  );

  useMessageListener<BaseMessage & { payload: { message: string } }>(
    'forge:automation:error',
    useCallback((msg) => {
      setAutomationError(msg.payload.message);
      setAutomationReading(false);
    }, []),
  );

  /**
   * What the run would mute of the target's automation, from the read: the
   * box beside it is offered only when a bypass silences something, and is
   * unticked once a read again, or an object left out, leaves nothing to
   * silence.
   */
  const muteAutomation = useForgeStore((s) => s.muteAutomation);
  const setMuteAutomation = useForgeStore((s) => s.setMuteAutomation);
  const muteOffer = useMemo(() => forgeRunMuteOffer(automation, leftOut), [automation, leftOut]);
  /** The target org, as the mute's box and the line of its emails name it. */
  const muteOrg = targetOrg?.alias ?? config?.targetOrgId ?? '';
  useEffect(() => {
    if (automation && muteAutomation && !muteOffered(muteOffer)) setMuteAutomation(false);
  }, [automation, muteAutomation, muteOffer, setMuteAutomation]);
  /**
   * What the mute ticked lifts beside what it silences, which the Gaps tab
   * says of the validation rules it names, as the clone's lines do: nothing
   * while it is not ticked.
   */
  const liftedByMute =
    muteAutomation && muteOffer && muteOffer !== 'atStart' ? muteOffer.alsoLifts : undefined;

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

  /** The gaps that will refuse rows with no decision taken yet, counted on their row. */
  const undecidedBlocking = useUndecidedBlockingGaps();
  /**
   * The rows open, any number of them. The one that asks for a decision opens
   * by itself, as Review opens and as a read finds one; closed by the user, it
   * stays closed until a read finds another reason to ask.
   */
  const [openRows, setOpenRows] = useState<ReadonlySet<ReviewRowId>>(
    () => new Set<ReviewRowId>(undecidedBlocking > 0 ? ['gaps'] : []),
  );
  const toggleRow = useCallback((id: ReviewRowId) => {
    setOpenRows((rows) => {
      const next = new Set(rows);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);
  const askedForDecision = useRef(undecidedBlocking > 0);
  useEffect(() => {
    const asks = undecidedBlocking > 0;
    if (asks && !askedForDecision.current) setOpenRows((rows) => new Set(rows).add('gaps'));
    askedForDecision.current = asks;
  }, [undecidedBlocking]);
  const [controlsOpen, setControlsOpen] = useState(false);
  const reviewRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const gapsBodyRef = useRef<HTMLDivElement>(null);
  /**
   * What the column and the Gaps row may take for every row, Controls and
   * Execute to stay in sight: the Gaps row is bounded while it is the one row
   * open, and scrolls within.
   */
  const room = useReviewRoom(
    { review: reviewRef, rows: rowsRef, gaps: gapsBodyRef },
    openRows.size === 1 && openRows.has('gaps'),
  );
  /** Where the Compliance tab stands: it tells its row, which says so once it is closed. */
  const [compliance, setCompliance] = useState<ComplianceRowStatus>({ step: 'none' });
  /** Execute asked about them, and is waiting for the answer. */
  const [askingAboutGaps, setAskingAboutGaps] = useState(false);
  /** Execute anyway was chosen once: the question is not put again. */
  const [gapsAccepted, setGapsAccepted] = useState(false);

  /**
   * Start the forge run, as Clone directly starts one (see `startForgeRun`),
   * once asked about the gaps that will refuse rows still undecided. Said
   * only by a badge on the sixth of seven tabs, they let a run go out from
   * the Plan tab and the target refuse rows one decision would have saved.
   */
  const handleExecute = useCallback(() => {
    if (undecidedBlocking > 0 && !gapsAccepted) {
      setAskingAboutGaps(true);
      return;
    }
    startForgeRun();
  }, [undecidedBlocking, gapsAccepted]);

  /**
   * Open Gaps, where each gap is decided, and take the keyboard there: Execute
   * may be a panel's height away from the row, under it on a narrow panel. Once
   * the page is drawn, as the question that asked gives it back to Execute.
   */
  const goToGaps = useRef(false);
  const decideOnGaps = useCallback(() => {
    setAskingAboutGaps(false);
    setOpenRows((rows) => new Set(rows).add('gaps'));
    goToGaps.current = true;
  }, []);
  useEffect(() => {
    if (!goToGaps.current) return;
    goToGaps.current = false;
    const row = document.getElementById('tab-gaps');
    row?.focus();
    row?.scrollIntoView?.({ block: 'start' });
  });

  /**
   * Run with the gaps as they are: the rows they refuse are refused, but for
   * those of a validation rule the mute ticked lifts, which go in whole.
   */
  const executeAnyway = useCallback(() => {
    setAskingAboutGaps(false);
    setGapsAccepted(true);
    startForgeRun();
  }, []);

  /** Simulate the run: the same path, every record checked, nothing written. */
  const handleSimulate = useCallback(() => {
    startForgeRun({ dryRun: true });
  }, []);

  const buckets = useMemo(() => (graph ? forgeRunBuckets(graph) : null), [graph]);
  const oneRecord = clonesOneRecord(config);
  const sourceName = sourceOrg?.alias || sourceOrg?.username || config?.sourceOrgId || '';
  const targetName = targetOrg?.alias || targetOrg?.username || config?.targetOrgId || '';

  const gaps = useForgeStore((s) => s.gaps);
  const gapReads = useForgeStore((s) => s.gapReads);
  const gapsShown = useMemo(
    () => gapsToShow(gaps, objectsLeftOut(config, graph)).length,
    [gaps, config, graph],
  );
  const gapsUnread = Object.values(gapReads).reduce((sum, parts) => sum + parts.length, 0);
  // A read that has not answered, or was never asked, is not a read that found nothing.
  const gapsReading = gapsRead.pending || (gapsRead.read === null && gapsRead.error === null);
  const gapsReadFailed = gapsRead.error !== null;

  /** What still runs may send emails, the mute's plan taken as held once it is ticked. */
  const sendsEmails = useMemo(() => {
    if (!automation) return false;
    const writes = (objectApiName: string, write: string): boolean =>
      !leftOut.has(objectApiName) && (write === 'insert' || write === 'update');
    const held = muteAutomation && muteOffer && muteOffer !== 'atStart' ? muteOffer : undefined;
    return (
      emailSendersOf(stillRunningOf(automation, held, writes), {
        writes,
        applyAssignmentRules: config?.applyAssignmentRules === true,
      }).length > 0
    );
  }, [automation, leftOut, muteAutomation, muteOffer, config?.applyAssignmentRules]);

  const gapsSaid = gapsRowSaid(t, {
    undecided: undecidedBlocking,
    reading: gapsReading,
    readFailed: gapsReadFailed,
    shown: gapsShown,
    unread: gapsUnread,
  });
  const anonymizationSaid = anonymizationRowSaid(t, {
    personalFields: piiFieldCount,
    anonymizes: config?.anonymizePII === true,
  });
  const complianceSaid = complianceRowSaid(t, compliance);
  const metadataSaid = metadataRowSaid(t, {
    pending: metadataPending,
    failed: metadataError !== null,
    differences: metadataDiffs.length,
  });
  const automationSaid = automationRowSaid(t, {
    failed: automationError !== null,
    read: automation !== null,
    blind: automation !== null && blindedBy(automation.unread),
    firedAtInsert,
    objectsWithAutomation: (automation?.objects ?? []).filter(
      (object) => !leftOut.has(object.objectApiName),
    ).length,
    sendsEmails,
  });
  const controlsCount = controlsSet(config);

  return (
    <div
      ref={reviewRef}
      data-testid="forge-review"
      // What Tab reaches stops short of what sticks at the foot of the panel,
      // which would otherwise cover it: the browser scrolls it just into view.
      className="flex flex-col gap-6 [&_*]:scroll-mb-28 min-[860px]:flex-row min-[860px]:items-start min-[860px]:[&_*]:scroll-mb-56"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        {/* Why the last run stopped before it wrote anything, when it did:
            refused, or cancelled at one of its questions, it came back here. */}
        <ForgeRunGateNotice />
        {/* One line where it fits: held to 21em, the sentence of a run
            between two short aliases took two lines of a 1280 pixel panel. */}
        {graph && buckets && (
          <h2
            data-testid="review-sentence"
            className={cn(
              'max-w-[30em] text-2xl leading-tight font-semibold text-text-primary',
              'min-[860px]:text-3xl [overflow-wrap:anywhere]',
            )}
          >
            {runSentence(t, {
              graph,
              buckets,
              config,
              oneRecord,
              source: sourceName,
              target: targetName,
            })}
          </h2>
        )}
        <p data-testid="review-left" role="status" className="text-sm text-text-secondary">
          {leftToDecide(t, {
            undecided: undecidedBlocking,
            filesBlocked,
            reading: gapsReading,
            readFailed: gapsReadFailed,
          })}{' '}
          {t('forgeRun.review.nothingWritten', { action: t('forgeRun.executeForge') })}
        </p>
        {graph && <ReviewLeftOutCost graph={graph} />}

        <div
          ref={rowsRef}
          data-testid="review-tabs"
          role="group"
          aria-label={t('forgeRun.review.rows')}
          className="border-b border-subtle"
        >
          <ReviewRow
            id="gaps"
            name={t('forgeRun.review.gapsTab')}
            summary={gapsSaid.summary}
            state={gapsSaid.state}
            open={openRows.has('gaps')}
            onToggle={() => toggleRow('gaps')}
          >
            {/* The gaps first, what the read cost and could not see under them.
                Open alone, the row takes what the window holds once the rows
                under it are in sight, and scrolls within: on the eleven gaps
                of the trap org it held Metadata and Automation under the fold
                of a 1280 by 800 panel. What Tab reaches in it is scrolled into
                its own view, not 224 pixels above its foot. */}
            <div
              ref={gapsBodyRef}
              data-testid="review-gaps-scroll"
              style={
                room.gaps !== undefined
                  ? ({ '--review-gaps-room': `${String(room.gaps)}px` } as React.CSSProperties)
                  : undefined
              }
              className={cn(
                'flex flex-col gap-1',
                'min-[860px]:max-h-[var(--review-gaps-room,none)] min-[860px]:overflow-y-auto',
                'min-[860px]:-mx-1 min-[860px]:px-1 min-[860px]:[&&_*]:scroll-my-2',
              )}
            >
              <ReviewGapsTab
                onReadAgain={readGapsAgain}
                readingAgain={gapsRead.pending}
                {...(liftedByMute ? { lifted: liftedByMute } : {})}
                {...(targetOrg?.alias && targetOrg.username
                  ? { target: { alias: targetOrg.alias, username: targetOrg.username } }
                  : {})}
              />
              <ReviewGapsRead gaps={gapsRead} />
            </div>
          </ReviewRow>
          <ReviewRow
            id="plan"
            name={t('forgeRun.review.planTab')}
            summary={
              graph ? (
                <ReviewPlanLine
                  graph={graph}
                  plan={plan}
                  cycleCount={plan?.cycleResolutions.length ?? 0}
                  truncated={graph.truncated === true}
                  oneRecord={oneRecord}
                />
              ) : (
                t('forgeRun.review.planLoading')
              )
            }
            state={planError !== null ? 'failed' : plan === null ? 'working' : 'ready'}
            open={openRows.has('plan')}
            onToggle={() => toggleRow('plan')}
          >
            <div className="flex flex-col gap-3">
              {/* The view follows the sandforge.forge.graphView setting and the
                  switch of the discovery before it: Review drew the graph
                  whatever its size, hundreds of objects included. */}
              {graph && (
                <div className="flex flex-wrap items-start gap-4">
                  <ForgeViewToggle view={view} large={largeGraph} objectCount={objectCount} />
                  <ReviewGraphSearch
                    graph={graph}
                    query={graphQuery}
                    onQueryChange={setGraphQuery}
                    onShow={view === 'graph' ? setFocus : undefined}
                  />
                </div>
              )}
              {/* The table is laid over the box rather than in its flow: in the
                  flow, hundreds of rows would push the waves below out of reach;
                  laid over, it scrolls within the box. Tall enough for fifty
                  objects, and drawn only while the row is open: the graph's
                  chunk is fetched the first time someone asks to see it. */}
              <div
                data-testid="review-graph-box"
                className="relative h-[600px] max-h-[80vh] min-h-[420px] overflow-hidden rounded-lg border border-subtle bg-surface-1"
              >
                {graph &&
                  openRows.has('plan') &&
                  (view === 'graph' ? (
                    <LiveGraph
                      graph={graph}
                      onIncludeToggle={toggleNodeIncluded}
                      highlighted={highlighted}
                      focus={focus}
                    />
                  ) : (
                    <ForgeTableView
                      graph={graph}
                      onToggleIncluded={toggleNodeIncluded}
                      className="absolute inset-0"
                    />
                  ))}
              </div>
              <ReviewPlanTab error={planError} />
            </div>
          </ReviewRow>
          <ReviewRow
            id="anonymization"
            name={t('forgeRun.review.anonymizationTab')}
            summary={anonymizationSaid.summary}
            state={anonymizationSaid.state}
            open={openRows.has('anonymization')}
            onToggle={() => toggleRow('anonymization')}
          >
            <ReviewAnonymizationTab />
          </ReviewRow>
          <ReviewRow
            id="compliance"
            name={t('forgeRun.review.complianceTab')}
            summary={complianceSaid.summary}
            state={complianceSaid.state}
            open={openRows.has('compliance')}
            onToggle={() => toggleRow('compliance')}
          >
            <ReviewComplianceTab onStatus={setCompliance} />
          </ReviewRow>
          <ReviewRow
            id="metadata"
            name={t('forgeRun.review.metadataTab')}
            summary={metadataSaid.summary}
            state={metadataSaid.state}
            open={openRows.has('metadata')}
            onToggle={() => toggleRow('metadata')}
          >
            <ReviewMetadataTab pending={metadataPending} error={metadataError} />
          </ReviewRow>
          <ReviewRow
            id="automation"
            name={t('forgeRun.review.automationTab')}
            summary={automationSaid.summary}
            state={automationSaid.state}
            open={openRows.has('automation')}
            onToggle={() => toggleRow('automation')}
          >
            <ReviewAutomationTab
              automation={automation}
              error={automationError}
              leftOut={leftOut}
              onReadAgain={readAutomationAgain}
              readingAgain={automationReading}
              mute={{ offer: muteOffer, checked: muteAutomation, org: muteOrg }}
              {...(targetOrg?.alias && targetOrg.username
                ? { target: { alias: targetOrg.alias, username: targetOrg.username } }
                : {})}
            />
          </ReviewRow>
        </div>

        <button
          data-testid="back-button"
          onClick={() => setPhase('discovery')}
          className="self-start py-2 text-sm text-text-secondary transition-colors hover:text-text-primary"
        >
          {t('forgeRun.review.back', '← Back to Discovery')}
        </button>
      </div>

      <aside
        aria-label={t('forgeRun.review.runColumn')}
        data-testid="review-run-column"
        className={RUN_COLUMN}
        style={
          room.column !== undefined
            ? ({ '--review-column-room': `${String(room.column)}px` } as React.CSSProperties)
            : undefined
        }
      >
        {/* The boxes scroll within what the column holds above Controls and
            the foot: among them, Controls went under the foot as soon as
            their words took a line more, in French, German, Spanish and
            Portuguese. Opened, Controls scrolls too, sharing the room. */}
        <div
          data-testid="review-run-options"
          className={cn(
            'flex flex-col gap-2',
            'min-[860px]:min-h-0 min-[860px]:overflow-y-auto min-[860px]:pr-1',
          )}
        >
          {config && <ReviewCheckpointFirst targetOrgId={config.targetOrgId} />}
          {/* Drawn once the read is in, as it was beside it: the box unticks a
              run it has nothing to offer, and before the read it has nothing. */}
          {automation && automationError === null && (
            <AutomationMuteBox
              offer={muteOffer}
              checked={muteAutomation}
              onChange={setMuteAutomation}
              org={muteOrg}
              testId="automation-mute"
              foldDetails
            />
          )}
          <ReviewFilesOption />
        </div>
        {/* Closed until asked for: its owners read the target's users as
            they are drawn, which a run that leaves them alone should not cost. */}
        <div
          data-testid="review-run-controls"
          className={cn(
            'border-b border-subtle max-[859px]:-mt-4 min-[860px]:mt-2',
            controlsOpen
              ? 'min-[860px]:min-h-0 min-[860px]:overflow-y-auto min-[860px]:pr-1'
              : 'shrink-0',
          )}
        >
          <ReviewRow
            id="controls"
            name={t('forgeRun.review.controlsTab')}
            summary={
              controlsCount > 0
                ? t('forgeRun.review.row.controls.set', { count: controlsCount })
                : t('forgeRun.review.row.controls.none')
            }
            open={controlsOpen}
            onToggle={() => setControlsOpen((open) => !open)}
            compact
          >
            <ReviewControlsTab />
          </ReviewRow>
        </div>

        <div data-testid="review-run-foot" className={RUN_FOOT}>
          <div data-testid="review-actions" className="grid grid-cols-2 gap-x-2 gap-y-1">
            {/* The platform's own verdict on a sample of the rows, every write
                rolled back: beside Simulate, which checks them here. Neither
                is offered for a clone of the whole org yet: a simulation
                keeps no journal, which such a run needs, and a rehearsal holds
                its rows in memory. The confirmation the run always asks before
                it writes stands in for both, said under them. */}
            <ForgeRehearseAction
              {...(wholeOrg ? { unavailableHintId: 'forge-all-no-simulation' } : {})}
            />
            {/* A simulation reads and checks every record as Execute's run
                would, through the write stage, and writes nothing: said under
                it, beside Rehearse's caption, which sends rows to the target. */}
            <div className="flex min-w-0 flex-col items-stretch gap-1">
              <button
                type="button"
                data-testid="simulate-button"
                onClick={handleSimulate}
                disabled={!graph || !config || filesBlocked || wholeOrg}
                aria-describedby={[
                  'forge-simulate-caption',
                  filesBlocked ? 'forge-files-execute-hint' : '',
                  wholeOrg ? 'forge-all-no-simulation' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                className="px-4 py-2 text-sm font-semibold rounded-lg border border-forge text-hue-forge transition-colors hover:bg-forge/10 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {t('forgeRun.simulation.action')}
              </button>
              <p
                id="forge-simulate-caption"
                data-testid="forge-simulate-caption"
                className="text-center text-[10px] text-text-secondary"
              >
                {t('forgeRun.simulation.caption')}
              </p>
            </div>
            {wholeOrg && (
              <p
                id="forge-all-no-simulation"
                data-testid="forge-all-no-simulation"
                className="col-span-2 text-xs text-text-secondary"
              >
                {t('forgeRun.allNoSimulation')}
              </p>
            )}
          </div>
          {/* Held at the foot of the panel while the column is under the rows:
              however long they run, Execute stays one press away. */}
          <div
            data-testid="review-execute"
            className={cn(
              'flex shrink-0 flex-col gap-2',
              'max-[859px]:sticky max-[859px]:bottom-0 max-[859px]:z-10',
              'max-[859px]:border-t max-[859px]:border-subtle',
              'max-[859px]:bg-(--sf-bg-primary) max-[859px]:py-2',
            )}
          >
            <button
              data-testid="execute-button"
              onClick={handleExecute}
              disabled={!graph || !config || filesBlocked}
              aria-describedby={
                [
                  filesBlocked ? 'forge-files-execute-hint' : '',
                  undecidedBlocking > 0 ? 'forge-gaps-execute-hint' : '',
                  muteAutomation ? 'forge-mute-execute-hint' : '',
                ]
                  .filter(Boolean)
                  .join(' ') || undefined
              }
              className="w-full px-6 py-2.5 text-sm font-semibold bg-hue-forge text-(--sf-bg-primary) rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {t('forgeRun.executeForge', 'Execute Forge')}
            </button>
            {filesBlocked && (
              <p
                id="forge-files-execute-hint"
                data-testid="forge-files-execute-hint"
                className="text-xs text-text-secondary"
              >
                {t('forgeRun.files.asIsNeeded')}
              </p>
            )}
            {/* Ticked above, the mute goes with Execute: said under it while
                the column is under the rows and the box may be a panel's
                height away. Beside the rows, the box ticked stands just above
                and the line is Execute's description alone: its two lines
                held Controls under the foot of the column at 1280 by 800. */}
            {muteAutomation && (
              <p
                id="forge-mute-execute-hint"
                data-testid="forge-mute-execute-hint"
                className="text-xs text-text-secondary min-[860px]:sr-only"
              >
                {t('forgeRun.review.muting')}
              </p>
            )}
            {undecidedBlocking > 0 && (
              <div className="flex flex-wrap items-center gap-2" data-testid="forge-gaps-undecided">
                <p id="forge-gaps-execute-hint" className="text-xs text-text-primary">
                  {t('forgeRun.review.undecidedGaps', { count: undecidedBlocking })}
                </p>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={decideOnGaps}
                  data-testid="forge-gaps-decide"
                >
                  {t('forgeRun.review.decideOnGaps')}
                </Button>
              </div>
            )}
          </div>
        </div>
      </aside>

      <Dialog
        open={askingAboutGaps}
        onClose={() => setAskingAboutGaps(false)}
        title={t('forgeRun.review.undecidedGaps', { count: undecidedBlocking })}
        description={t('forgeRun.review.undecidedGapsQuestion')}
        footer={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={decideOnGaps}
              data-testid="forge-gaps-ask-decide"
            >
              {t('forgeRun.review.decideOnGaps')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={executeAnyway}
              data-testid="forge-gaps-ask-execute"
            >
              {t('forgeRun.review.executeAnyway')}
            </Button>
          </>
        }
      >
        {null}
      </Dialog>
    </div>
  );
};
