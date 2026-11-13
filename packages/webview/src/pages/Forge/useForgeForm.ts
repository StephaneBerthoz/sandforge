import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import type { KeyboardEvent, MutableRefObject } from 'react';
import {
  BUILTIN_FORGE_TEMPLATES,
  buildSyntheticForgeGraph,
  getBuiltinTemplateObjects,
} from '@sandforge/shared';
import type { ForgeRemovalPlan, SalesforceOrg } from '@sandforge/shared';
import { useForgeStore } from '../../stores/useForgeStore';
import { useLatestRef } from '../../hooks/useLatestRef';
import type {
  ForgeConfig,
  ForgeDepth,
  ForgeExecutionResult,
  ForgeInputMode,
  ForgeTemplate,
  ForgeWholeOrgAgain,
} from '../../stores/useForgeStore';
import { useOrgStore } from '../../stores/useOrgStore';
import { useSendMessage } from '../../hooks/useMessageBus';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { buildMessage } from '../../bridge/messageHelpers';
import { sendDiscovery } from './directRun';
import {
  carriedChoices,
  carriedNarrowing,
  clonesWholeOrg,
  withCarried,
  withoutNarrowing,
} from './forgeRunConfig';
import type { CarriedNarrowing, CarriedRunChoices } from './forgeRunConfig';
import { useRecordPreview } from './useRecordPreview';
import type { RecordPreviewState } from './useRecordPreview';
import { useForgeAIPlan } from './useForgeAIPlan';
import type { ForgeAIPlanState } from './useForgeAIPlan';
import { extractRecordId } from '../../utils/recordId';
import {
  extractSalesforceDomain,
  SMART_SOQL_CAP,
  soqlFilterRefused,
  soqlObjectNameRefused,
  soqlObjectFilters,
  SOQL_UNSCOPED_RECORD_CAP,
} from './forgeUtils';

/**
 * Depth option values for the chip selector. ALL comes last: it walks no
 * relationship at all but takes the whole source org.
 */
export const DEPTH_OPTIONS: ForgeDepth[] = ['direct', 'full', 'custom', 'all'];

/** Map depth value to its i18n key. */
export const DEPTH_KEYS: Record<ForgeDepth, string> = {
  direct: 'forge.depthDirect',
  full: 'forge.depthFull',
  custom: 'forge.depthCustom',
  all: 'forge.depthAll',
};

/** Map depth value to its tooltip i18n key. */
export const DEPTH_TOOLTIP_KEYS: Record<ForgeDepth, string> = {
  direct: 'forge.depthDirectTooltip',
  full: 'forge.depthFullTooltip',
  custom: 'forge.depthCustomTooltip',
  all: 'forge.depthAllTooltip',
};

/** The label of the depth a past run or a template walked, ALL for a clone of the whole org. */
export function depthKeyOf(depth: ForgeDepth): string {
  return DEPTH_KEYS[depth];
}

/**
 * The input modes the form has a tab for. A clone of the whole org (`org`)
 * has none: it starts from no input, and is asked for by the ALL depth chip,
 * whatever tab is showing.
 */
export type ForgeTabMode = Exclude<ForgeInputMode, 'org'>;

/**
 * Whether an org holds real people's data, as the page knows it: a production
 * org, or a sandbox marked Staging (a full copy, UAT). A clone of the whole of
 * such an org anonymizes its personal fields unless the user unticks it.
 */
export function holdsRealData(
  org: Pick<SalesforceOrg, 'orgType' | 'staging'> | undefined,
): boolean {
  return org?.orgType === 'Production' || org?.staging === true;
}

/**
 * Whether a run the history lists cloned the whole org: by its config, or,
 * for a run of this session whose result came back without one, by its
 * graph, which lists the objects it left out only for such a run, and is
 * kept without its relations only for such a run.
 */
function clonedWholeOrg(run: ForgeExecutionResult | undefined): boolean {
  return (
    run?.config?.inputMode === 'org' ||
    run?.config?.depth === 'all' ||
    run?.graph?.leftOut !== undefined ||
    run?.graph?.withoutEdges === true
  );
}

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
export const RECORD_LIMIT_PRESETS = [10, 50, 100, 500, 1000] as const;

/**
 * Translate a stored `maxRecordsPerObject` back into a dropdown value.
 *
 * `undefined` means "no cap" — the `all` option. Every cap the form can
 * produce is one of {@link RECORD_LIMIT_PRESETS}, Smart's cap of a SOQL run
 * (100) or a builtin template cap (50/100), so the exact value survives the
 * round trip. The one outlier is the SOQL cap of 200,
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
  inputMode: ForgeTabMode;
  setInputMode: (mode: ForgeTabMode) => void;
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
  /**
   * The ALL chip is picked: the run clones the whole source org, from no
   * input, with no cap on objects or records, whatever tab is showing.
   */
  wholeOrg: boolean;
  /**
   * The source holds real people's data (`holdsRealData`): picked with ALL,
   * Anonymize PII is turned on, and the preview says why.
   */
  sourceHoldsRealData: boolean;

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
  /** Write email addresses and phone numbers as the source holds them; off neutralizes them. */
  keepContactPoints: boolean;
  setKeepContactPoints: (v: boolean) => void;
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
  /**
   * Discover, then start the run on the graph discovery answers with, sent
   * as Review sends it by default: no stop on the discovery and Review
   * screens, and no metadata diff. Gated as Discover is.
   */
  handleCloneDirectly: () => void;
  /**
   * Whether Clone directly may start: never for a clone of the whole org,
   * which is run from Review, where what it leaves out and the personal
   * fields it copies as they are are listed.
   */
  canCloneDirectly: boolean;
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
   * and target org in the form, and keep for the run it discovers what the
   * form does not show. Returns what became of the target org.
   */
  applyTemplate: (template: ForgeTemplate) => TemplateTargetOutcome;

  /* Run history (persisted by the extension, newest first) */
  /** Past runs the extension kept, newest first. Empty until the reply lands. */
  runHistory: ForgeExecutionResult[];
  /**
   * The runs the history no longer lists whose records can still be removed,
   * by the plans the extension kept of them, newest first.
   */
  olderRuns: ForgeRemovalPlan[];
  /** Message shown when the history request failed; null while it is fine. */
  historyError: string | null;
  /** Refill every form field from a past run's stored configuration. */
  applyHistoryConfig: (config: ForgeRunConfig) => void;
  /** Ask for the history again: a removal marks the entry of the run it removed. */
  refreshHistory: () => void;
  /**
   * The carried choices that leave part of the source org behind (filters,
   * objects left out, rows held back, fields left out), by object, or null
   * when none is carried: what a clone of the whole org still keeps from a
   * past run, which its note lists.
   */
  carriedNarrowing: CarriedNarrowing | null;
  /** Drop the choices `carriedNarrowing` lists; the other carried choices stay. */
  clearCarried: () => void;
}

/**
 * The clone of the whole org the store's run is, for the form to come back
 * to: its orgs, and the run whose options it puts back. None for any other
 * run, nor when the store holds none.
 */
function wholeOrgOfTheRun(): (ForgeWholeOrgAgain & { run: ForgeConfig }) | null {
  const run = useForgeStore.getState().config;
  if (!run || !clonesWholeOrg(run)) return null;
  return {
    sourceOrgId: run.sourceOrgId || undefined,
    targetOrgId: run.targetOrgId || undefined,
    run,
  };
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
  const setAnonymizeFieldChoices = useForgeStore((s) => s.setAnonymizeFieldChoices);
  const setFileCopy = useForgeStore((s) => s.setFileCopy);
  const orgs = useOrgStore((s) => s.orgs);
  const selectedOrgId = useOrgStore((s) => s.selectedOrgId);
  const sendMessage = useSendMessage();

  /* ---- Local form state ---- */
  const [inputMode, setInputMode] = useState<ForgeTabMode>('record');
  const [recordId, setRecordId] = useState('');
  const [soqlQuery, setSoqlQuery] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [depth, setDepthState] = useState<ForgeDepth>('direct');
  const [customDepth, setCustomDepth] = useState(3);
  /**
   * How many objects discovery may reach, when the default is not enough.
   *
   * `undefined` leaves the service's own cap of fifty in place, which is what
   * every run did before: the preview announced a truncated graph and there
   * was nothing here to answer it with.
   */
  const [maxNodes, setMaxNodes] = useState<number | undefined>(undefined);
  const [sourceOrgId, setSourceOrgIdState] = useState('');
  const [targetOrgId, setTargetOrgId] = useState('');
  const [anonymize, setAnonymize] = useState(false);
  const [skipEmpty, setSkipEmpty] = useState(false);
  const [expandOrphanParents, setExpandOrphanParents] = useState(false);
  /**
   * Off, the default: every email address and phone number the run writes is
   * neutralized, so what the target's automation sends to them reaches no
   * one. On, they go as the source holds them.
   */
  const [keepContactPoints, setKeepContactPoints] = useState(false);
  /**
   * Per-object record cap, expressed as a string in the dropdown:
   * 'smart' (set by the run's input, see `recordLimitValue`) | 'all' |
   * '10'..'1000'. Translated into a number (or undefined) before being sent
   * to the executor as `maxRecordsPerObject`.
   */
  const [recordLimit, setRecordLimit] = useState<string>('smart');
  /**
   * What the run carries that the form has no control for — the decisions
   * taken on the Gaps tab, the objects left out, field exclusions and
   * mappings — sent with every config the form builds. Brought by a template
   * or a past run put back in the form, and taken from the run the store
   * holds as the form comes back, as its record id is: going back to change
   * the depth used to send a Discover that dropped every decision.
   */
  const [carried, setCarried] = useState<CarriedRunChoices>(() =>
    carriedChoices(useForgeStore.getState().config),
  );
  /**
   * The file copy a template was saved with, put back once its Discover has
   * started the run's config, which starts with no file copied. Never the
   * acceptance: each run asks for it again.
   */
  const [carriedFiles, setCarriedFiles] = useState<{ maxFileSizeMB: number } | null>(null);

  /*
   * A clone of the whole of an org that holds real people's data anonymizes
   * their personal fields unless the user unticks it: set as ALL is picked
   * with such a source, or such a source is picked under ALL. The user's own
   * choice stands after that, ticked or not.
   */
  const anonymizeFor = useCallback(
    (nextDepth: ForgeDepth, nextSourceId: string): void => {
      if (nextDepth === 'all' && holdsRealData(orgs.find((o) => o.id === nextSourceId))) {
        setAnonymize(true);
      }
    },
    [orgs],
  );
  const setDepth = useCallback(
    (next: ForgeDepth): void => {
      if (next === 'all' && depth !== 'all') anonymizeFor('all', sourceOrgId);
      setDepthState(next);
    },
    [depth, sourceOrgId, anonymizeFor],
  );
  const setSourceOrgId = useCallback(
    (id: string): void => {
      if (id !== sourceOrgId) anonymizeFor(depth, id);
      setSourceOrgIdState(id);
    },
    [depth, sourceOrgId, anonymizeFor],
  );

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

  /**
   * Open on a clone of the whole org asked for again from its results: the
   * ALL chip, and the orgs it ran between when this machine still holds them.
   * Its defaults are a new run's — no file, Anonymize PII on for a source
   * that holds real people's data — and its org is discovered again, the
   * graph the history keeps of it having no relations to run by. Taken from
   * the store once, and kept for the form's life: the source the panel has
   * selected is taken just before, on every pass of the effects, and the
   * second pass React makes in development gave the run's source back to it.
   *
   * Or come back to the clone of the whole org the store's run is — back from
   * its discovery or its Review, or Forge again from its results: the ALL
   * chip and its orgs, and its options as they were left, Anonymize PII
   * unticked included, which stays as it was left once ALL came. The chip was
   * the form's own state, gone with the input screen: Back from the discovery
   * of the whole org showed the record tab under Direct, as the record id of
   * a run from a record comes back from the store (see
   * `adoptHandedOverRecord`).
   */
  const wholeOrgAgain = useRef<(ForgeWholeOrgAgain & { run?: ForgeConfig }) | null>(null);
  const adoptWholeOrgAgain = useLatestRef(() => {
    wholeOrgAgain.current ??= useForgeStore.getState().takeWholeOrgAgain() ?? wholeOrgOfTheRun();
    const again = wholeOrgAgain.current;
    if (!again) return;
    const held = (id: string | undefined): id is string =>
      id !== undefined && orgs.some((o) => o.id === id);
    // An org no longer held leaves the source the form takes on any mount.
    const source = held(again.sourceOrgId)
      ? again.sourceOrgId
      : sourceOrgId || (selectedOrgId ?? '');
    if (held(again.sourceOrgId)) setSourceOrgIdState(again.sourceOrgId);
    if (held(again.targetOrgId)) setTargetOrgId(again.targetOrgId);
    if (again.run) {
      applyRunOptions(again.run);
      return;
    }
    setDepthState('all');
    anonymizeFor('all', source);
  });
  useEffect(() => {
    adoptWholeOrgAgain.current();
  }, [adoptWholeOrgAgain]);

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
  const historyQuery = useBridgeQuery<{
    history: ForgeExecutionResult[];
    olderRuns?: ForgeRemovalPlan[];
  }>('forge:history:list');
  const runHistory = useMemo(() => historyQuery.data?.history ?? [], [historyQuery.data]);
  const olderRuns = useMemo(() => historyQuery.data?.olderRuns ?? [], [historyQuery.data]);

  /*
   * Read again whenever a run ends, this panel's or another's: the extension
   * keeps each in its history before it answers. Read once as the form came,
   * the list missed a run that ended while it was open — the one a cancel had
   * just stopped, kept a moment after the form had asked.
   */
  const runsEnded = useForgeStore((s) => s.runsEnded);
  const refetchHistory = historyQuery.refetch;
  const runsEndedSeen = useRef(runsEnded);
  useEffect(() => {
    if (runsEndedSeen.current === runsEnded) return;
    runsEndedSeen.current = runsEnded;
    refetchHistory();
  }, [runsEnded, refetchHistory]);

  /* ---- Derived state ---- */
  const sourceOrg = useMemo(() => orgs.find((o) => o.id === sourceOrgId), [orgs, sourceOrgId]);
  const targetOrg = useMemo(() => orgs.find((o) => o.id === targetOrgId), [orgs, targetOrgId]);

  /** The ALL chip: a clone of the whole source org, which starts from no input. */
  const wholeOrg = depth === 'all';

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
   * Numeric limit applied to executor (undefined = no cap). On `smart`, a
   * clone of one record's graph has none: it reads only what the record
   * reaches, each object up to the read ceiling, and the gate asks before a
   * large write. Smart used to size a cap from the preview's count of the
   * root object's whole table — 100 above 5 000 rows, 50 above 50 000 — and a
   * clone of an account with 250 cases took 100 of them, in no order, and
   * said "Success". A run from a query reads its other objects from their
   * whole tables, and keeps a cap of 100 (`SMART_SOQL_CAP`).
   *
   * A clone of the whole org has none, whatever the select says: it copies
   * every record of each object. That comes first, because the tab showing
   * when ALL was picked may be the SOQL one, whose cap of 200 would
   * otherwise have bounded the copy of the whole org.
   */
  const recordLimitValue = useMemo<number | undefined>(() => {
    if (depth === 'all') return undefined;
    let base: number | undefined;
    if (recordLimit === 'smart') {
      base = runsSoql ? SMART_SOQL_CAP : undefined;
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
  }, [depth, recordLimit, runsSoql]);

  /**
   * Whether the current input has enough data to proceed. A clone of the
   * whole org needs none: what it copies is the source org itself.
   */
  const hasInput = useCallback((): boolean => {
    if (depth === 'all') return true;
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
  }, [depth, inputMode, recordId, soqlQuery, selectedTemplate, templateInput, ai.checked]);

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
   *
   * A clone of the whole org sends its mode alone: no record id, query, filter
   * of a query's root nor template, whatever the tab showing holds, since the
   * extension refuses a whole-org config that names one.
   */
  const runInput = useMemo((): Pick<
    ForgeConfig,
    'inputMode' | 'recordId' | 'soqlQuery' | 'objectSoqlFilters' | 'templateId'
  > => {
    if (depth === 'all') return { inputMode: 'org' };
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
  }, [depth, inputMode, recordId, soqlQuery, ai.draft, selectedTemplate, templateInput]);

  const sameOrgSelected = sourceOrgId.length > 0 && sourceOrgId === targetOrgId;
  // A query refused on a tab ALL greys out is not sent, and holds nothing back.
  const canDiscover =
    hasInput() &&
    sourceOrgId.length > 0 &&
    targetOrgId.length > 0 &&
    !sameOrgSelected &&
    (wholeOrg || (!whereClauseRefused && !objectNameRefused));

  /** Refs to the depth chips so arrow-key nav can move DOM focus. */
  const depthRefs = useRef<Partial<Record<ForgeDepth, HTMLButtonElement | null>>>({});

  /** Arrow-key navigation handler for depth radio chips. */
  const handleDepthKeyDown = useCallback(
    (e: KeyboardEvent, currentDepth: ForgeDepth) => {
      const idx = DEPTH_OPTIONS.findIndex((option) => option === currentDepth);
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
    [orgs, sourceOrgId, resetPreview, setSourceOrgId],
  );

  /** Swap source and target org selections. */
  const handleSwapOrgs = useCallback(() => {
    const tmp = sourceOrgId;
    setSourceOrgId(targetOrgId);
    setTargetOrgId(tmp);
  }, [sourceOrgId, targetOrgId, setSourceOrgId]);

  /** Put the template's file copy on the run whose config was just set. */
  const takeCarriedFiles = useCallback(() => {
    if (carriedFiles) setFileCopy({ enabled: true, maxFileSizeMB: carriedFiles.maxFileSizeMB });
  }, [carriedFiles, setFileCopy]);

  /**
   * Build the config and start its discovery. With `direct`, the discovery is
   * a Clone directly's: its answer starts the run, with no stop on the
   * discovery and Review screens. Both send the same config, from the same
   * gate: the orgs set and apart, and an input the extension takes.
   *
   * A clone of the whole org sends no object cap, no record cap and no custom
   * depth, and fetches no orphan parent: it reads every table whole, so every
   * parent is already in the run. It copies no file unless Review's option is
   * ticked, as every run, and is never a Clone directly's.
   */
  const startDiscovery = useCallback(
    (direct: boolean) => {
      if (!canDiscover || (direct && wholeOrg)) return;

      const config: ForgeConfig = withCarried(
        {
          ...runInput,
          depth,
          customDepth: depth === 'custom' ? customDepth : undefined,
          maxNodes: wholeOrg ? undefined : maxNodes,
          anonymizePII: anonymize,
          skipEmpty,
          expandOrphanParents: wholeOrg ? false : expandOrphanParents,
          keepContactPoints,
          maxRecordsPerObject: recordLimitValue,
          sourceOrgId,
          targetOrgId,
          batchSize: 'auto',
        },
        carried,
      );

      setConfig(config);
      // Copying the files is a choice of the Review screen, which a Clone
      // directly skips: its run copies none, as it always did, and never waits
      // on an acceptance no screen is there to give. A clone of the whole org
      // copies none either until Review's option is ticked for it: a template
      // applied before ALL was picked does not tick it for the whole org.
      if (!direct && !wholeOrg) takeCarriedFiles();
      // By its request: only the answer to this discovery is taken, page or
      // no page, and only a Clone directly's starts the run.
      sendDiscovery(sendMessage, config, direct);
      setPhase('discovery');
    },
    [
      canDiscover,
      wholeOrg,
      runInput,
      depth,
      customDepth,
      maxNodes,
      anonymize,
      skipEmpty,
      expandOrphanParents,
      keepContactPoints,
      recordLimitValue,
      sourceOrgId,
      targetOrgId,
      carried,
      takeCarriedFiles,
      setConfig,
      setPhase,
      sendMessage,
    ],
  );

  /** Build config and transition to discovery phase. */
  const handleDiscover = useCallback(() => startDiscovery(false), [startDiscovery]);

  /** Discover, then run what discovery answers with, as Review would send it. */
  const handleCloneDirectly = useCallback(() => startDiscovery(true), [startDiscovery]);

  /** Quick-start path: starter template selected → synthetic graph, no BFS. */
  const builtinTplCandidate = useMemo(() => {
    if (inputMode !== 'template') return null;
    return BUILTIN_FORGE_TEMPLATES.find((p) => p.id === selectedTemplate) ?? null;
  }, [inputMode, selectedTemplate]);
  // A starter template clones one record's graph, which a clone of the whole org is not.
  const canQuickStartTemplate =
    !wholeOrg &&
    !!builtinTplCandidate &&
    !!sourceOrgId &&
    !!targetOrgId &&
    extractRecordId(recordId) !== null;
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
    const config: ForgeConfig = withCarried(
      {
        ...builtinTplCandidate.config,
        // The template's config says `inputMode: 'record'`; without the record
        // itself the executor cannot scope the run to its graph.
        recordId: rootRecordId,
        sourceOrgId,
        targetOrgId,
        anonymizePII: anonymize,
        skipEmpty,
        expandOrphanParents,
        keepContactPoints,
        maxRecordsPerObject: effectiveCap,
        batchSize: 'auto',
      },
      carried,
    );
    setConfig(config);
    takeCarriedFiles();
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
    keepContactPoints,
    recordLimit,
    recordLimitValue,
    carried,
    takeCarriedFiles,
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
   *
   * Never for a clone of the whole org, either way round. Its graph is the
   * org as discovery found it a run ago, and the one the history keeps has
   * lost its relations; reused for a clone of one record, it would copy whole
   * tables. And a graph walked from one record is not the whole org.
   */
  const lastGraph = history[0]?.graph;
  const canReuseLastGraph =
    !!lastGraph &&
    !wholeOrg &&
    !clonedWholeOrg(history[0]) &&
    !!sourceOrgId &&
    !!targetOrgId &&
    !whereClauseRefused &&
    (inputMode !== 'ai' || ai.checked);
  const handleReuseLastGraph = useCallback(() => {
    if (!canReuseLastGraph || !lastGraph) return;
    const config: ForgeConfig = withCarried(
      {
        ...runInput,
        depth,
        customDepth: depth === 'custom' ? customDepth : undefined,
        maxNodes,
        anonymizePII: anonymize,
        skipEmpty,
        expandOrphanParents,
        keepContactPoints,
        maxRecordsPerObject: recordLimitValue,
        sourceOrgId,
        targetOrgId,
        batchSize: 'auto',
      },
      carried,
    );
    setConfig(config);
    takeCarriedFiles();
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
    keepContactPoints,
    recordLimitValue,
    sourceOrgId,
    targetOrgId,
    carried,
    takeCarriedFiles,
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
   *
   * A clone of the whole org puts the ALL chip back and leaves the two caps
   * as they were: it had neither, and the form keeps what the user set for
   * the next run that has them.
   */
  const applyRunOptions = useCallback((config: ForgeRunConfig): void => {
    const all = config.inputMode === 'org' || config.depth === 'all';
    setDepthState(all ? 'all' : config.depth);
    if (config.depth === 'custom' && config.customDepth != null) {
      setCustomDepth(config.customDepth);
    }
    if (!all) setMaxNodes(config.maxNodes);
    setAnonymize(config.anonymizePII);
    setSkipEmpty(config.skipEmpty);
    setExpandOrphanParents(config.expandOrphanParents ?? false);
    // A run or a template that predates the choice neutralized nothing, but
    // its replay is a new run, and goes as every new run does.
    setKeepContactPoints(config.keepContactPoints ?? false);
    if (!all) setRecordLimit(recordLimitOptionFor(config.maxRecordsPerObject));
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
   * The decisions taken on its gaps, the objects it left out, its field
   * exclusions, filters and mappings have no control in the form: they are
   * kept and sent with the replay's Discover. The filter a SOQL run's query
   * gave its root is not: it is rebuilt from the query when the replay is
   * discovered.
   * A past run keeps no file choice and no field-by-field anonymization: a
   * template's are dropped.
   */
  const applyHistoryConfig = useCallback(
    (config: ForgeRunConfig): void => {
      // A clone of the whole org has no tab to go back to: the Record tab is
      // shown, empty, as it is for an AI draft, under the ALL chip.
      const mode: ForgeTabMode =
        config.inputMode === 'ai' || config.inputMode === 'org' ? 'record' : config.inputMode;
      setInputMode(mode);
      setRecordId(mode === 'record' ? (config.recordId ?? '') : '');
      setSoqlQuery(mode === 'soql' ? (config.soqlQuery ?? '') : '');
      setSelectedTemplate(mode === 'template' ? (config.templateId ?? '') : '');
      applyRunOptions(config);
      setCarried(carriedChoices(config));
      setCarriedFiles(null);
      setAnonymizeFieldChoices(null);
      // The preview describes the record id that was in the field a moment
      // ago; keeping it would caption the new one with the old one's counts.
      resetPreview();
    },
    [applyRunOptions, resetPreview, setAnonymizeFieldChoices],
  );

  /**
   * Select a saved template and put what it holds in the form.
   *
   * The template stays the run's input — its record id or query is expanded
   * when discovery starts, as for any saved template — while its depth, caps,
   * toggles and anonymization are set where the user can see and change them
   * before Discover. Its target org is set only when it is connected here: an
   * id from another machine's registry names nothing in this one.
   *
   * What the form does not show goes with the run it discovers: its decisions,
   * the objects it leaves out, its field exclusions and mappings in the config;
   * its anonymized fields on the graph discovery answers with; its file copy
   * on the run, to be accepted again.
   */
  const applyTemplate = useCallback(
    (template: ForgeTemplate): TemplateTargetOutcome => {
      setInputMode('template');
      setSelectedTemplate(template.id);
      applyRunOptions(template.config);
      setCarried(carriedChoices(template.config));
      setCarriedFiles(template.files ?? null);
      setAnonymizeFieldChoices(template.anonymization?.fields ?? null);
      if (template.anonymization) {
        setAnonymizationRules(template.anonymization.rules);
        setAnonymizationPresetId(template.anonymization.presetId ?? '');
      }
      if (!template.targetOrgId) return 'none';
      if (!orgs.some((o) => o.id === template.targetOrgId)) return 'missing';
      setTargetOrgId(template.targetOrgId);
      return 'set';
    },
    [
      applyRunOptions,
      setAnonymizationRules,
      setAnonymizationPresetId,
      setAnonymizeFieldChoices,
      orgs,
    ],
  );

  /** The carried choices a clone of the whole org still keeps, which its note lists. */
  const narrowing = useMemo(() => carriedNarrowing(carried), [carried]);
  const clearCarried = useCallback(() => setCarried((kept) => withoutNarrowing(kept)), []);

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
    wholeOrg,
    sourceHoldsRealData: holdsRealData(sourceOrg),
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
    keepContactPoints,
    setKeepContactPoints,
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
    handleCloneDirectly,
    canCloneDirectly: canDiscover && !wholeOrg,
    canQuickStartTemplate,
    builtinTplCandidate,
    handleQuickStartTemplate,
    canReuseLastGraph,
    handleReuseLastGraph,
    ai,
    applyTemplate,
    runHistory,
    olderRuns,
    historyError: historyQuery.error,
    applyHistoryConfig,
    refreshHistory: historyQuery.refetch,
    carriedNarrowing: narrowing,
    clearCarried,
  };
}
