import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import type { KeyboardEvent, MutableRefObject } from 'react';
import {
  BUILTIN_FORGE_TEMPLATES,
  buildSyntheticForgeGraph,
  getBuiltinTemplateObjects,
} from '@sandforge/shared';
import type { SalesforceOrg } from '@sandforge/shared';
import { useForgeStore } from '../../stores/useForgeStore';
import { useLatestRef } from '../../hooks/useLatestRef';
import type {
  ForgeConfig,
  ForgeDepth,
  ForgeExecutionResult,
  ForgeInputMode,
  ForgeTemplate,
} from '../../stores/useForgeStore';
import { useOrgStore } from '../../stores/useOrgStore';
import { useSendMessage } from '../../hooks/useMessageBus';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { buildMessage } from '../../bridge/messageHelpers';
import { useRecordPreview } from './useRecordPreview';
import type { RecordPreviewState } from './useRecordPreview';
import { useForgeAIPlan } from './useForgeAIPlan';
import type { ForgeAIPlanState } from './useForgeAIPlan';
import {
  extractRecordId,
  extractSalesforceDomain,
  smartLimitForCount,
  soqlFilterRefused,
  soqlObjectNameRefused,
  soqlObjectFilters,
  SOQL_UNSCOPED_RECORD_CAP,
} from './forgeUtils';

/** Depth option values for the chip selector. */
export const DEPTH_OPTIONS: ForgeDepth[] = ['direct', 'full', 'custom'];

/** Map depth value to its i18n key. */
export const DEPTH_KEYS: Record<ForgeDepth, string> = {
  direct: 'forge.depthDirect',
  full: 'forge.depthFull',
  custom: 'forge.depthCustom',
};

/** Map depth value to its tooltip i18n key. */
export const DEPTH_TOOLTIP_KEYS: Record<ForgeDepth, string> = {
  direct: 'forge.depthDirectTooltip',
  full: 'forge.depthFullTooltip',
  custom: 'forge.depthCustomTooltip',
};

/**
 * The stored half of a past run: the config the extension persists alongside
 * every history entry, minus the org pair it deliberately strips.
 */
export type ForgeRunConfig = NonNullable<ForgeExecutionResult['config']>;

/**
 * What applying a template did about its target org: set it, found it not
 * connected here, or had none to set.
 */
export type TemplateTargetOutcome = 'set' | 'missing' | 'none';

/**
 * Numeric caps offered by the records-per-object dropdown, ascending.
 * Mirrors the `<option>` values in ForgeInput — a value outside this set
 * leaves the select with nothing to show.
 */
const RECORD_LIMIT_PRESETS = [10, 50, 100, 500, 1000] as const;

/**
 * Translate a stored `maxRecordsPerObject` back into a dropdown value.
 *
 * `undefined` means "no cap" — the `all` option. Every cap the form can
 * produce is one of {@link RECORD_LIMIT_PRESETS}, a `smartLimitForCount`
 * result (50/100/500/1000) or a builtin template cap (50/100), so the exact
 * value survives the round trip. The one outlier is the SOQL cap of 200,
 * which has no option: it rounds up to the next preset rather than down, so
 * the replay never quietly clones fewer records than the run it repeats —
 * and in SOQL mode `recordLimitValue` clamps it back to 200 anyway.
 */
export function recordLimitOptionFor(max: number | undefined): string {
  if (max == null) return 'all';
  const preset = RECORD_LIMIT_PRESETS.find((n) => n >= max);
  return preset === undefined ? 'all' : String(preset);
}

/** Return type for the useForgeForm hook. */
export interface ForgeFormState {
  /* Input modes */
  inputMode: ForgeInputMode;
  setInputMode: (mode: ForgeInputMode) => void;
  recordId: string;
  soqlQuery: string;
  setSoqlQuery: (q: string) => void;
  selectedTemplate: string;
  setSelectedTemplate: (id: string) => void;

  /* Depth */
  depth: ForgeDepth;
  setDepth: (d: ForgeDepth) => void;
  customDepth: number;
  /** Objects discovery may reach; undefined keeps the default cap. */
  maxNodes: number | undefined;
  /** Raise or clear the object cap. */
  setMaxNodes: (value: number | undefined) => void;
  setCustomDepth: (n: number) => void;
  depthRefs: MutableRefObject<Partial<Record<ForgeDepth, HTMLButtonElement | null>>>;
  handleDepthKeyDown: (e: KeyboardEvent, currentDepth: ForgeDepth) => void;

  /* Orgs */
  orgs: SalesforceOrg[];
  sourceOrgId: string;
  setSourceOrgId: (id: string) => void;
  targetOrgId: string;
  setTargetOrgId: (id: string) => void;
  sourceOrg: SalesforceOrg | undefined;
  targetOrg: SalesforceOrg | undefined;
  sameOrgSelected: boolean;
  handleSwapOrgs: () => void;
  handleRecordIdChange: (value: string) => void;

  /* Options */
  anonymize: boolean;
  setAnonymize: (v: boolean) => void;
  skipEmpty: boolean;
  setSkipEmpty: (v: boolean) => void;
  expandOrphanParents: boolean;
  setExpandOrphanParents: (v: boolean) => void;
  recordLimit: string;
  setRecordLimit: (v: string) => void;
  recordLimitValue: number | undefined;

  /* Preview (composed hook) */
  preview: RecordPreviewState['preview'];
  previewLoading: boolean;
  previewError: string | null;
  handlePreview: () => void;
  resetPreview: () => void;
  closePreview: () => void;

  /* Derived / actions */
  canDiscover: boolean;
  /** The query this run would send has a WHERE clause the extension refuses. */
  whereClauseRefused: boolean;
  /** The object after FROM is not an API name the extension accepts. */
  objectNameRefused: boolean;
  /** The SOQL query of the selected template, when it saved one. */
  templateSoqlQuery: string | null;
  handleDiscover: () => void;
  canQuickStartTemplate: boolean;
  builtinTplCandidate: (typeof BUILTIN_FORGE_TEMPLATES)[number] | null;
  handleQuickStartTemplate: () => void;
  canReuseLastGraph: boolean;
  handleReuseLastGraph: () => void;

  /* AI tab (composed hook) */
  ai: ForgeAIPlanState;

  /* Saved templates */
  /**
   * Select a saved template and put its depth, caps, toggles, anonymization
   * and target org in the form. Returns what became of the target org.
   */
  applyTemplate: (template: ForgeTemplate) => TemplateTargetOutcome;

  /* Run history (persisted by the extension, newest first) */
  /** Past runs the extension kept, newest first. Empty until the reply lands. */
  runHistory: ForgeExecutionResult[];
  /** Message shown when the history request failed; null while it is fine. */
  historyError: string | null;
  /** Refill every form field from a past run's stored configuration. */
  applyHistoryConfig: (config: ForgeRunConfig) => void;
  /** Ask for the history again: a removal marks the entry of the run it removed. */
  refreshHistory: () => void;
}

/**
 * Hook holding all local form state for the Forge input form, along with
 * the derived flags and the discover/quick-start/reuse actions. Composes
 * `useRecordPreview` for the record preview lifecycle.
 */
export function useForgeForm(): ForgeFormState {
  const setConfig = useForgeStore((s) => s.setConfig);
  const setPhase = useForgeStore((s) => s.setPhase);
  const setGraph = useForgeStore((s) => s.setGraph);
  const history = useForgeStore((s) => s.history);
  const templates = useForgeStore((s) => s.templates);
  const setAnonymizationRules = useForgeStore((s) => s.setAnonymizationRules);
  const setAnonymizationPresetId = useForgeStore((s) => s.setAnonymizationPresetId);
  const orgs = useOrgStore((s) => s.orgs);
  const selectedOrgId = useOrgStore((s) => s.selectedOrgId);
  const sendMessage = useSendMessage();

  /* ---- Local form state ---- */
  const [inputMode, setInputMode] = useState<ForgeInputMode>('record');
  const [recordId, setRecordId] = useState('');
  const [soqlQuery, setSoqlQuery] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [depth, setDepth] = useState<ForgeDepth>('direct');
  const [customDepth, setCustomDepth] = useState(3);
  /**
   * How many objects discovery may reach, when the default is not enough.
   *
   * `undefined` leaves the service's own cap of fifty in place, which is what
   * every run did before: the preview announced a truncated graph and there
   * was nothing here to answer it with.
   */
  const [maxNodes, setMaxNodes] = useState<number | undefined>(undefined);
  const [sourceOrgId, setSourceOrgId] = useState('');
  const [targetOrgId, setTargetOrgId] = useState('');
  const [anonymize, setAnonymize] = useState(false);
  const [skipEmpty, setSkipEmpty] = useState(false);
  const [expandOrphanParents, setExpandOrphanParents] = useState(false);
  /**
   * Per-object record cap, expressed as a string in the dropdown:
   * 'smart' (auto from preview metrics) | 'all' | '10'..'1000'.
   * Translated into a number (or undefined) before being sent to the
   * executor as `maxRecordsPerObject`.
   */
  const [recordLimit, setRecordLimit] = useState<string>('smart');

  /* ---- Auto-select source org from global selectedOrgId on mount ---- */
  const adoptGlobalOrg = useLatestRef(() => {
    if (!sourceOrgId && selectedOrgId) {
      setSourceOrgId(selectedOrgId);
    }
  });
  useEffect(() => {
    adoptGlobalOrg.current();
  }, [adoptGlobalOrg]);

  /**
   * Adopt a record id handed over by another page.
   *
   * The Home hero writes the id the user typed into the store and navigates
   * here. This form keeps its fields in local state, so without this the id
   * was written and never read: the user landed on a blank Record ID and
   * retyped all 18 characters.
   *
   * Mount-only, and only when the field is still empty — the store config is a
   * handoff, not a second source of truth for a field the user is editing.
   */
  const adoptHandedOverRecord = useLatestRef(() => {
    const handedOver = useForgeStore.getState().config?.recordId;
    if (handedOver && !recordId) {
      setInputMode('record');
      setRecordId(handedOver);
    }
  });
  useEffect(() => {
    adoptHandedOverRecord.current();
  }, [adoptHandedOverRecord]);

  /* ---- Record preview (composed hook) ---- */
  const { preview, previewLoading, previewError, handlePreview, resetPreview, closePreview } =
    useRecordPreview(recordId, sourceOrgId);

  /* ---- AI tab (composed hook): a checked draft is checked against the source org ---- */
  const ai = useForgeAIPlan(sourceOrgId);

  /**
   * Past runs, from the extension's own store rather than this session's.
   *
   * The webview store only holds what `forge:execute:response` returned, and
   * that payload carries the result without its config — so the in-session
   * history can be displayed and never replayed. The persisted entries the
   * extension writes do carry the config, and `forge:history:list` is how
   * they are asked for.
   */
  const historyQuery = useBridgeQuery<{ history: ForgeExecutionResult[] }>('forge:history:list');
  const runHistory = useMemo(() => historyQuery.data?.history ?? [], [historyQuery.data]);

  /* ---- Derived state ---- */
  const sourceOrg = useMemo(() => orgs.find((o) => o.id === sourceOrgId), [orgs, sourceOrgId]);
  const targetOrg = useMemo(() => orgs.find((o) => o.id === targetOrgId), [orgs, targetOrgId]);

  /**
   * The root input a saved user template holds, when it holds one the
   * extension can resolve (a record id or a SOQL query). Templates live in
   * this webview's store, so a bare templateId reaches the extension
   * unresolvable; the run sends this input instead.
   */
  const templateInput = useMemo(() => {
    if (inputMode !== 'template') return undefined;
    const tplConfig = templates.find((t2) => t2.id === selectedTemplate)?.config;
    return tplConfig && (tplConfig.inputMode === 'record' || tplConfig.inputMode === 'soql')
      ? tplConfig
      : undefined;
  }, [inputMode, templates, selectedTemplate]);

  /** Whether the run reads its root from a SOQL query: typed, drafted, or saved in a template. */
  const runsSoql =
    inputMode === 'soql' || inputMode === 'ai' || templateInput?.inputMode === 'soql';

  /**
   * Numeric limit applied to executor (undefined = no cap). When the
   * dropdown is on `smart`, scales with `preview.estimatedRecordCount`;
   * before the preview lands, defaults to 100 as a safe-large-org fallback.
   */
  const recordLimitValue = useMemo<number | undefined>(() => {
    let base: number | undefined;
    if (recordLimit === 'smart') {
      const count = preview?.estimatedRecordCount;
      const auto = count == null ? 100 : smartLimitForCount(count);
      base = auto === 0 ? undefined : auto;
    } else if (recordLimit === 'all') {
      base = undefined;
    } else {
      const n = Number(recordLimit);
      base = Number.isFinite(n) && n > 0 ? n : undefined;
    }

    // SOQL mode filters only the object after FROM and never enters the
    // record-scoped path: every related object is read from its whole table,
    // so "all" would clone whole tables across the graph. Bound it.
    if (runsSoql) {
      return Math.min(base ?? SOQL_UNSCOPED_RECORD_CAP, SOQL_UNSCOPED_RECORD_CAP);
    }
    return base;
  }, [recordLimit, preview, runsSoql]);

  /** Whether the current input has enough data to proceed. */
  const hasInput = useCallback((): boolean => {
    switch (inputMode) {
      case 'record':
        return recordId.trim().length > 0;
      case 'soql':
        return soqlQuery.trim().length > 0;
      case 'template':
        /*
         * A built-in template clones ONE record's graph — "Clone an Account
         * with its Contacts, Opportunities and Cases" — so it needs the root
         * record, exactly as the Record tab does. It used to need only a
         * selection, and the run then went out with no `recordId`: the
         * executor's scoped path is gated on one, so it fell back to cloning
         * whole tables, capped by maxRecordsPerObject, into the target org.
         * A saved template carries its own input and asks for nothing.
         */
        if (selectedTemplate.length === 0) return false;
        if (templateInput) return true;
        return extractRecordId(recordId) !== null;
      case 'ai':
        // A draft is only run once it passed the check against the source org,
        // and only as it reads now: an edit waits for the next check.
        return ai.checked;
    }
  }, [inputMode, recordId, soqlQuery, selectedTemplate, templateInput, ai.checked]);

  /*
   * The WHERE clause travels as an object filter, which the extension checks
   * before running anything. A clause it refuses would fail the whole
   * discovery, so Discover stays off until the query is fixed. A saved
   * template's query counts too: a run sends it the same way.
   */
  const whereClauseRefused = useMemo((): boolean => {
    if (inputMode === 'soql') return soqlFilterRefused(soqlQuery);
    if (inputMode === 'ai') return soqlFilterRefused(ai.draft);
    return templateInput?.inputMode === 'soql' && soqlFilterRefused(templateInput.soqlQuery ?? '');
  }, [inputMode, soqlQuery, ai.draft, templateInput]);

  /*
   * The clause travels under the name of the object after FROM, and that name
   * has a rule of its own. `SELECT Id FROM 1Account WHERE …` passed every
   * check the form made and was refused by the extension when Discover was
   * clicked, with no explanation attached to the field that caused it.
   */
  const objectNameRefused = useMemo((): boolean => {
    if (inputMode === 'soql') return soqlObjectNameRefused(soqlQuery);
    if (inputMode === 'ai') return soqlObjectNameRefused(ai.draft);
    return (
      templateInput?.inputMode === 'soql' && soqlObjectNameRefused(templateInput.soqlQuery ?? '')
    );
  }, [inputMode, soqlQuery, ai.draft, templateInput]);

  /** The template's own query, which the SOQL warnings below the picker read. */
  const templateSoqlQuery =
    templateInput?.inputMode === 'soql' ? (templateInput.soqlQuery ?? null) : null;

  /**
   * The root input fields of an outgoing config, shared by Discover and by
   * Reuse last graph so both send the same run. A saved template's root input
   * is expanded in place of its id; the form's depth, toggles and orgs still
   * win. Builtin templates take the quick-start path (synthetic graph) and
   * never reach here with a resolvable root input.
   */
  const runInput = useMemo((): Pick<
    ForgeConfig,
    'inputMode' | 'recordId' | 'soqlQuery' | 'objectSoqlFilters' | 'templateId'
  > => {
    const runSoql =
      inputMode === 'soql'
        ? soqlQuery.trim()
        : inputMode === 'ai'
          ? ai.draft.trim() || undefined
          : templateInput?.inputMode === 'soql'
            ? templateInput.soqlQuery
            : undefined;
    // A built-in template IS the record mode — that is what its config
    // declares and what its description promises — so discovery runs it as
    // one. Sent as `template`, nothing downstream resolved it: the extension
    // reads `templateId` only as part of a cache key.
    const builtinTemplateRoot =
      inputMode === 'template' && !templateInput ? extractRecordId(recordId) : null;
    // An AI draft is a SOQL query the user confirmed, and discovery reads it
    // as one: it resolves its root from a record id or a query, nothing else.
    return {
      inputMode: templateInput
        ? templateInput.inputMode
        : builtinTemplateRoot
          ? 'record'
          : inputMode === 'ai'
            ? 'soql'
            : inputMode,
      recordId:
        inputMode === 'record'
          ? (extractRecordId(recordId) ?? undefined)
          : (builtinTemplateRoot ?? undefined) ||
            (templateInput?.inputMode === 'record' ? templateInput.recordId : undefined),
      soqlQuery: runSoql,
      // The query's WHERE clause reaches the executor as the root object's
      // filter; without it the root was cloned from its whole table.
      objectSoqlFilters: runSoql ? soqlObjectFilters(runSoql) : undefined,
      templateId: inputMode === 'template' && !templateInput ? selectedTemplate : undefined,
    };
  }, [inputMode, recordId, soqlQuery, ai.draft, selectedTemplate, templateInput]);

  const sameOrgSelected = sourceOrgId.length > 0 && sourceOrgId === targetOrgId;
  const canDiscover =
    hasInput() &&
    sourceOrgId.length > 0 &&
    targetOrgId.length > 0 &&
    !sameOrgSelected &&
    !whereClauseRefused &&
    !objectNameRefused;

  /** Refs to the depth chips so arrow-key nav can move DOM focus. */
  const depthRefs = useRef<Partial<Record<ForgeDepth, HTMLButtonElement | null>>>({});

  /** Arrow-key navigation handler for depth radio chips. */
  const handleDepthKeyDown = useCallback(
    (e: KeyboardEvent, currentDepth: ForgeDepth) => {
      const idx = DEPTH_OPTIONS.indexOf(currentDepth);
      let nextIdx = idx;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        nextIdx = (idx + 1) % DEPTH_OPTIONS.length;
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        nextIdx = (idx - 1 + DEPTH_OPTIONS.length) % DEPTH_OPTIONS.length;
      }
      if (nextIdx !== idx) {
        setDepth(DEPTH_OPTIONS[nextIdx]);
        depthRefs.current[DEPTH_OPTIONS[nextIdx]]?.focus();
      }
    },
    [setDepth],
  );

  /** Record input change: reset preview and auto-detect org from URL domain. */
  const handleRecordIdChange = useCallback(
    (value: string) => {
      setRecordId(value);
      resetPreview();
      // Auto-detect org from pasted URL domain
      const domain = extractSalesforceDomain(value);
      if (domain) {
        const matchedOrg = orgs.find((o) => {
          const orgDomain = extractSalesforceDomain(o.instanceUrl);
          return orgDomain && orgDomain === domain;
        });
        if (matchedOrg && !sourceOrgId) {
          setSourceOrgId(matchedOrg.id);
        }
      }
    },
    [orgs, sourceOrgId, resetPreview],
  );

  /** Swap source and target org selections. */
  const handleSwapOrgs = useCallback(() => {
    const tmp = sourceOrgId;
    setSourceOrgId(targetOrgId);
    setTargetOrgId(tmp);
  }, [sourceOrgId, targetOrgId]);

  /** Build config and transition to discovery phase. */
  const handleDiscover = useCallback(() => {
    if (!canDiscover) return;

    const config: ForgeConfig = {
      ...runInput,
      depth,
      customDepth: depth === 'custom' ? customDepth : undefined,
      maxNodes,
      anonymizePII: anonymize,
      skipEmpty,
      expandOrphanParents,
      maxRecordsPerObject: recordLimitValue,
      sourceOrgId,
      targetOrgId,
      batchSize: 'auto',
    };

    setConfig(config);
    sendMessage(buildMessage<{ config: ForgeConfig }>('forge:discover', { config }));
    setPhase('discovery');
  }, [
    canDiscover,
    runInput,
    depth,
    customDepth,
    maxNodes,
    anonymize,
    skipEmpty,
    expandOrphanParents,
    recordLimitValue,
    sourceOrgId,
    targetOrgId,
    setConfig,
    setPhase,
    sendMessage,
  ]);

  /** Quick-start path: starter template selected → synthetic graph, no BFS. */
  const builtinTplCandidate = useMemo(() => {
    if (inputMode !== 'template') return null;
    return BUILTIN_FORGE_TEMPLATES.find((p) => p.id === selectedTemplate) ?? null;
  }, [inputMode, selectedTemplate]);
  const canQuickStartTemplate =
    !!builtinTplCandidate && !!sourceOrgId && !!targetOrgId && extractRecordId(recordId) !== null;
  const handleQuickStartTemplate = useCallback(() => {
    if (!canQuickStartTemplate || !builtinTplCandidate) return;
    const objects = getBuiltinTemplateObjects(builtinTplCandidate.id);
    if (objects.length === 0) return;
    // The user's UI choices override the builtin defaults — they may want
    // to widen the builtin's record cap, toggle anonymize, etc.
    const tplCap = builtinTplCandidate.config.maxRecordsPerObject;
    const effectiveCap = recordLimit === '100' && tplCap != null ? tplCap : recordLimitValue;
    const rootRecordId = extractRecordId(recordId);
    if (rootRecordId === null) return;
    const config: ForgeConfig = {
      ...builtinTplCandidate.config,
      // The template's config says `inputMode: 'record'`; without the record
      // itself the executor cannot scope the run to its graph.
      recordId: rootRecordId,
      sourceOrgId,
      targetOrgId,
      anonymizePII: anonymize,
      skipEmpty,
      expandOrphanParents,
      maxRecordsPerObject: effectiveCap,
      batchSize: 'auto',
    };
    setConfig(config);
    setGraph(buildSyntheticForgeGraph(objects));
    sendMessage(
      buildMessage<{ graph: ReturnType<typeof buildSyntheticForgeGraph>; config: ForgeConfig }>(
        'forge:plan:request',
        { graph: buildSyntheticForgeGraph(objects), config },
      ),
    );
    setPhase('review');
  }, [
    canQuickStartTemplate,
    builtinTplCandidate,
    recordId,
    sourceOrgId,
    targetOrgId,
    anonymize,
    skipEmpty,
    expandOrphanParents,
    recordLimit,
    recordLimitValue,
    setConfig,
    setGraph,
    setPhase,
    sendMessage,
  ]);

  /**
   * Reuse the most recent execution's graph to skip discovery.
   *
   * On the AI tab the run's filter is the draft's WHERE clause, so the draft
   * has to have passed its check here too: this path skips discovery, not
   * the check.
   */
  const lastGraph = history[0]?.graph;
  const canReuseLastGraph =
    !!lastGraph &&
    !!sourceOrgId &&
    !!targetOrgId &&
    !whereClauseRefused &&
    (inputMode !== 'ai' || ai.checked);
  const handleReuseLastGraph = useCallback(() => {
    if (!canReuseLastGraph || !lastGraph) return;
    const config: ForgeConfig = {
      ...runInput,
      depth,
      customDepth: depth === 'custom' ? customDepth : undefined,
      maxNodes,
      anonymizePII: anonymize,
      skipEmpty,
      expandOrphanParents,
      maxRecordsPerObject: recordLimitValue,
      sourceOrgId,
      targetOrgId,
      batchSize: 'auto',
    };
    setConfig(config);
    setGraph(lastGraph);
    // Re-generate the plan from the cached graph; the wizard's Review tab
    // listens for forge:plan:response and updates the store. Skips the
    // 30s+ BFS rediscovery entirely.
    sendMessage(
      buildMessage<{ graph: typeof lastGraph; config: ForgeConfig }>('forge:plan:request', {
        graph: lastGraph,
        config,
      }),
    );
    setPhase('review');
  }, [
    canReuseLastGraph,
    lastGraph,
    runInput,
    depth,
    customDepth,
    maxNodes,
    anonymize,
    skipEmpty,
    expandOrphanParents,
    recordLimitValue,
    sourceOrgId,
    targetOrgId,
    setConfig,
    setGraph,
    setPhase,
    sendMessage,
  ]);

  /**
   * Put a stored run's depth, caps and toggles back in the form.
   *
   * The object cap is restored too: it was added after History's re-run, and
   * a re-run of a run discovered with room for 350 objects went out on the
   * default cap of fifty, free to stop where the original run had not.
   */
  const applyRunOptions = useCallback((config: ForgeRunConfig): void => {
    setDepth(config.depth);
    if (config.depth === 'custom' && config.customDepth != null) {
      setCustomDepth(config.customDepth);
    }
    setMaxNodes(config.maxNodes);
    setAnonymize(config.anonymizePII);
    setSkipEmpty(config.skipEmpty);
    setExpandOrphanParents(config.expandOrphanParents ?? false);
    setRecordLimit(recordLimitOptionFor(config.maxRecordsPerObject));
  }, []);

  /**
   * Refill the form from a past run's stored configuration.
   *
   * Forge runs in three steps (discover -> plan -> execute), so a re-run puts
   * the settings back in front of the user instead of firing the clone: the
   * graph is rediscovered against whatever the orgs hold today, and the user
   * confirms before anything is written.
   *
   * Source and target org are *not* restored — the extension strips them from
   * the stored config on purpose, so a replay re-picks its orgs explicitly
   * rather than silently repeating against yesterday's pair.
   *
   * Fields belonging to the other input modes are cleared, so the form shows
   * the run it claims to show rather than a mix of it and what was typed.
   *
   * A stored AI run opens on the record tab: runs from the AI tab are stored
   * as the SOQL runs they are, so one stored as `ai` predates it, and carries
   * a prompt the form would have to send to the model again.
   *
   * `fieldExclusions`, `ownerMappings`, `objectSoqlFilters` and `fieldMappings`
   * are not restored: the form has no control for them. A SOQL run's filter is
   * rebuilt from its query when the replay is discovered.
   */
  const applyHistoryConfig = useCallback(
    (config: ForgeRunConfig): void => {
      const mode: ForgeInputMode = config.inputMode === 'ai' ? 'record' : config.inputMode;
      setInputMode(mode);
      setRecordId(mode === 'record' ? (config.recordId ?? '') : '');
      setSoqlQuery(mode === 'soql' ? (config.soqlQuery ?? '') : '');
      setSelectedTemplate(mode === 'template' ? (config.templateId ?? '') : '');
      applyRunOptions(config);
      // The preview describes the record id that was in the field a moment
      // ago; keeping it would caption the new one with the old one's counts.
      resetPreview();
    },
    [applyRunOptions, resetPreview],
  );

  /**
   * Select a saved template and put what it holds in the form.
   *
   * The template stays the run's input — its record id or query is expanded
   * when discovery starts, as for any saved template — while its depth, caps,
   * toggles and anonymization are set where the user can see and change them
   * before Discover. Its target org is set only when it is connected here: an
   * id from another machine's registry names nothing in this one.
   */
  const applyTemplate = useCallback(
    (template: ForgeTemplate): TemplateTargetOutcome => {
      setInputMode('template');
      setSelectedTemplate(template.id);
      applyRunOptions(template.config);
      if (template.anonymization) {
        setAnonymizationRules(template.anonymization.rules);
        setAnonymizationPresetId(template.anonymization.presetId ?? '');
      }
      if (!template.targetOrgId) return 'none';
      if (!orgs.some((o) => o.id === template.targetOrgId)) return 'missing';
      setTargetOrgId(template.targetOrgId);
      return 'set';
    },
    [applyRunOptions, setAnonymizationRules, setAnonymizationPresetId, orgs],
  );

  return {
    inputMode,
    setInputMode,
    recordId,
    soqlQuery,
    setSoqlQuery,
    selectedTemplate,
    setSelectedTemplate,
    depth,
    setDepth,
    customDepth,
    setCustomDepth,
    maxNodes,
    setMaxNodes,
    depthRefs,
    handleDepthKeyDown,
    orgs,
    sourceOrgId,
    setSourceOrgId,
    targetOrgId,
    setTargetOrgId,
    sourceOrg,
    targetOrg,
    sameOrgSelected,
    handleSwapOrgs,
    handleRecordIdChange,
    anonymize,
    setAnonymize,
    skipEmpty,
    setSkipEmpty,
    expandOrphanParents,
    setExpandOrphanParents,
    recordLimit,
    setRecordLimit,
    recordLimitValue,
    preview,
    previewLoading,
    previewError,
    handlePreview,
    resetPreview,
    closePreview,
    canDiscover,
    whereClauseRefused,
    objectNameRefused,
    templateSoqlQuery,
    handleDiscover,
    canQuickStartTemplate,
    builtinTplCandidate,
    handleQuickStartTemplate,
    canReuseLastGraph,
    handleReuseLastGraph,
    ai,
    applyTemplate,
    runHistory,
    historyError: historyQuery.error,
    applyHistoryConfig,
    refreshHistory: historyQuery.refetch,
  };
}
