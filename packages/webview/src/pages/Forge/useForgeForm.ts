import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import type { KeyboardEvent, MutableRefObject } from 'react';
import {
  BUILTIN_FORGE_TEMPLATES,
  buildSyntheticForgeGraph,
  getBuiltinTemplateObjects,
} from '@sandforge/shared';
import type { SalesforceOrg } from '@sandforge/shared';
import { useForgeStore } from '../../stores/useForgeStore';
import type { ForgeConfig, ForgeDepth, ForgeInputMode, ForgeTemplate } from '../../stores/useForgeStore';
import { useOrgStore } from '../../stores/useOrgStore';
import { useSendMessage } from '../../hooks/useMessageBus';
import { buildMessage } from '../../bridge/messageHelpers';
import { useRecordPreview } from './useRecordPreview';
import type { RecordPreviewState } from './useRecordPreview';
import { extractRecordId, extractSalesforceDomain, smartLimitForCount } from './forgeUtils';

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
  aiPrompt: string;
  setAiPrompt: (p: string) => void;

  /* Depth */
  depth: ForgeDepth;
  setDepth: (d: ForgeDepth) => void;
  customDepth: number;
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
  handleDiscover: () => void;
  canQuickStartTemplate: boolean;
  builtinTplCandidate: (typeof BUILTIN_FORGE_TEMPLATES)[number] | null;
  handleQuickStartTemplate: () => void;
  canReuseLastGraph: boolean;
  handleReuseLastGraph: () => void;
  /** Build a ForgeTemplate config snapshot from the current form state. */
  buildTemplateConfig: () => ForgeTemplate['config'];
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
  const orgs = useOrgStore((s) => s.orgs);
  const selectedOrgId = useOrgStore((s) => s.selectedOrgId);
  const sendMessage = useSendMessage();

  /* ---- Local form state ---- */
  const [inputMode, setInputMode] = useState<ForgeInputMode>('record');
  const [recordId, setRecordId] = useState('');
  const [soqlQuery, setSoqlQuery] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [aiPrompt, setAiPrompt] = useState('');
  const [depth, setDepth] = useState<ForgeDepth>('direct');
  const [customDepth, setCustomDepth] = useState(3);
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

  /* ---- UX-01: Auto-select source org from global selectedOrgId on mount ---- */
  useEffect(() => {
    if (!sourceOrgId && selectedOrgId) {
      setSourceOrgId(selectedOrgId);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- Record preview (composed hook) ---- */
  const {
    preview,
    previewLoading,
    previewError,
    handlePreview,
    resetPreview,
    closePreview,
  } = useRecordPreview(recordId, sourceOrgId);

  /* ---- Derived state ---- */
  const sourceOrg = useMemo(() => orgs.find((o) => o.id === sourceOrgId), [orgs, sourceOrgId]);
  const targetOrg = useMemo(() => orgs.find((o) => o.id === targetOrgId), [orgs, targetOrgId]);

  /**
   * Numeric limit applied to executor (undefined = no cap). When the
   * dropdown is on `smart`, scales with `preview.estimatedRecordCount`;
   * before the preview lands, defaults to 100 as a safe-large-org fallback.
   */
  const recordLimitValue = useMemo<number | undefined>(() => {
    if (recordLimit === 'smart') {
      const count = preview?.estimatedRecordCount;
      if (count == null) return 100;
      const auto = smartLimitForCount(count);
      return auto === 0 ? undefined : auto;
    }
    if (recordLimit === 'all') return undefined;
    const n = Number(recordLimit);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }, [recordLimit, preview]);

  /** Whether the current input has enough data to proceed. */
  const hasInput = useCallback((): boolean => {
    switch (inputMode) {
      case 'record':
        return recordId.trim().length > 0;
      case 'soql':
        return soqlQuery.trim().length > 0;
      case 'template':
        return selectedTemplate.length > 0;
      case 'ai':
        return aiPrompt.trim().length > 0;
    }
  }, [inputMode, recordId, soqlQuery, selectedTemplate, aiPrompt]);

  const sameOrgSelected = sourceOrgId.length > 0 && sourceOrgId === targetOrgId;
  const canDiscover =
    hasInput() && sourceOrgId.length > 0 && targetOrgId.length > 0 && !sameOrgSelected;

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

  /** Record input change: reset preview and auto-detect org from URL domain (UX-02). */
  const handleRecordIdChange = useCallback(
    (value: string) => {
      setRecordId(value);
      resetPreview();
      // UX-02: Auto-detect org from pasted URL domain
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
      inputMode,
      depth,
      recordId: inputMode === 'record' ? (extractRecordId(recordId) ?? undefined) : undefined,
      soqlQuery: inputMode === 'soql' ? soqlQuery.trim() : undefined,
      templateId: inputMode === 'template' ? selectedTemplate : undefined,
      aiPrompt: inputMode === 'ai' ? aiPrompt.trim() : undefined,
      customDepth: depth === 'custom' ? customDepth : undefined,
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
    inputMode,
    depth,
    recordId,
    soqlQuery,
    selectedTemplate,
    aiPrompt,
    customDepth,
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
  const canQuickStartTemplate = !!builtinTplCandidate && !!sourceOrgId && !!targetOrgId;
  const handleQuickStartTemplate = useCallback(() => {
    if (!canQuickStartTemplate || !builtinTplCandidate) return;
    const objects = getBuiltinTemplateObjects(builtinTplCandidate.id);
    if (objects.length === 0) return;
    // The user's UI choices override the builtin defaults — they may want
    // to widen the builtin's record cap, toggle anonymize, etc.
    const tplCap = builtinTplCandidate.config.maxRecordsPerObject;
    const effectiveCap = recordLimit === '100' && tplCap != null ? tplCap : recordLimitValue;
    const config: ForgeConfig = {
      ...builtinTplCandidate.config,
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

  /** Reuse the most recent execution's graph to skip discovery. */
  const lastGraph = history[0]?.graph;
  const canReuseLastGraph = !!lastGraph && !!sourceOrgId && !!targetOrgId;
  const handleReuseLastGraph = useCallback(() => {
    if (!canReuseLastGraph || !lastGraph) return;
    const config: ForgeConfig = {
      inputMode,
      depth,
      recordId: inputMode === 'record' ? (extractRecordId(recordId) ?? undefined) : undefined,
      soqlQuery: inputMode === 'soql' ? soqlQuery.trim() : undefined,
      templateId: inputMode === 'template' ? selectedTemplate : undefined,
      aiPrompt: inputMode === 'ai' ? aiPrompt.trim() : undefined,
      customDepth: depth === 'custom' ? customDepth : undefined,
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
    inputMode,
    depth,
    recordId,
    soqlQuery,
    selectedTemplate,
    aiPrompt,
    customDepth,
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

  /** Snapshot the current form state as a ForgeTemplate config. */
  const buildTemplateConfig = useCallback((): ForgeTemplate['config'] => {
    return {
      inputMode,
      depth,
      customDepth: depth === 'custom' ? customDepth : undefined,
      anonymizePII: anonymize,
      skipEmpty,
      expandOrphanParents,
      batchSize: 'auto',
      maxRecordsPerObject: recordLimitValue,
      ...(inputMode === 'record' && recordId
        ? { recordId: extractRecordId(recordId) ?? undefined }
        : {}),
      ...(inputMode === 'soql' && soqlQuery ? { soqlQuery } : {}),
      ...(inputMode === 'ai' && aiPrompt ? { aiPrompt } : {}),
    };
  }, [
    inputMode,
    depth,
    customDepth,
    anonymize,
    skipEmpty,
    expandOrphanParents,
    recordLimitValue,
    recordId,
    soqlQuery,
    aiPrompt,
  ]);

  return {
    inputMode,
    setInputMode,
    recordId,
    soqlQuery,
    setSoqlQuery,
    selectedTemplate,
    setSelectedTemplate,
    aiPrompt,
    setAiPrompt,
    depth,
    setDepth,
    customDepth,
    setCustomDepth,
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
    handleDiscover,
    canQuickStartTemplate,
    builtinTplCandidate,
    handleQuickStartTemplate,
    canReuseLastGraph,
    handleReuseLastGraph,
    buildTemplateConfig,
  };
}
