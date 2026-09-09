import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  PipelineDefinition,
  PipelineStepType,
  TriggerType,
  PipelineHistoryEntry,
} from '@sandforge/shared';
import { useNotificationStore } from '../../stores/useNotificationStore';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { usePipelineGenerator } from '../../hooks/useAIFeatures';
import type { PipelineExecutionData } from './PipelineExecutionView';
import type { ScheduledPipeline } from './SchedulerCalendar';

/**
 * The `PipelineStepType` union as data, for narrowing untyped host payloads.
 *
 * The AI generator derives step types from keywords and emits values that are
 * not members of the union ('dataops', 'monitor'), so a generated step cannot
 * be cast — it has to be checked.
 */
const PIPELINE_STEP_TYPES: readonly string[] = [
  'seed',
  'sync',
  'backup',
  'restore',
  'anonymize',
  'delete',
  'compare',
  'precheck',
  'script',
  'notification',
  'approval',
  'delay',
  'condition',
  'loop',
  'parallel',
];

/** The `TriggerType` union as data. Same reason as {@link PIPELINE_STEP_TYPES}. */
const TRIGGER_TYPES: readonly string[] = [
  'manual',
  'schedule',
  'event',
  'webhook',
  'sandbox_refresh',
  'deployment_complete',
];

/** Narrows an unknown value to a plain object without widening to `any`. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Turns the AI generator's loose pipeline into a `PipelineDefinition`.
 *
 * `ai:generate-pipeline:response` carries `pipeline` as `Record<string, unknown>`:
 * the host's `GeneratedPipeline` (name, description, steps of
 * `{ name, type, config }`, an optional cron `schedule`, optional `triggers`
 * strings). Every field is narrowed rather than cast — an unknown step type
 * becomes a `script` step so the user still sees the step and can retype it,
 * and an unknown trigger string ('error_detected' is one the generator emits)
 * is dropped instead of poisoning the trigger panel.
 *
 * @param raw - The `pipeline` payload of the AI response.
 * @param fallbackName - Name to use when the generator returned none.
 */
function toPipelineDefinition(
  raw: Record<string, unknown>,
  fallbackName: string,
): PipelineDefinition {
  const now = new Date().toISOString();

  const triggers: PipelineDefinition['triggers'] = [];
  if (typeof raw.schedule === 'string' && raw.schedule.length > 0) {
    triggers.push({
      id: crypto.randomUUID(),
      type: 'schedule',
      enabled: true,
      config: { cron: raw.schedule },
    });
  }
  if (Array.isArray(raw.triggers)) {
    for (const entry of raw.triggers) {
      if (typeof entry === 'string' && TRIGGER_TYPES.includes(entry)) {
        triggers.push({
          id: crypto.randomUUID(),
          type: entry as TriggerType,
          enabled: true,
          config: {},
        });
      }
    }
  }

  const rawSteps = Array.isArray(raw.steps) ? raw.steps : [];

  return {
    id: crypto.randomUUID(),
    name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : fallbackName,
    description: typeof raw.description === 'string' ? raw.description : '',
    version: 1,
    steps: rawSteps.map((rawStep) => {
      const step = asRecord(rawStep);
      const type =
        typeof step.type === 'string' && PIPELINE_STEP_TYPES.includes(step.type)
          ? (step.type as PipelineStepType)
          : 'script';
      return {
        id: crypto.randomUUID(),
        name: typeof step.name === 'string' && step.name.length > 0 ? step.name : type,
        type,
        config: asRecord(step.config),
        continueOnError: false,
      };
    }),
    triggers,
    variables: [],
    tags: [],
    createdAt: now,
    updatedAt: now,
  };
}

/** Marketplace template entry. */
export interface MarketplaceTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  author: string;
}

/** Return type for the useAutomationPageData hook. */
export interface AutomationPageData {
  /** Currently active pipeline definition. */
  pipeline: PipelineDefinition | undefined;
  /** Error message from any bridge hook. */
  error: string | null;
  /** Clear the error message. */
  clearError: () => void;
  /** Whether a pipeline is currently executing. */
  isRunning: boolean;
  /** Whether the pipelines list query is loading. */
  pipelinesLoading: boolean;
  /** Saved pipelines from the bridge query. */
  savedPipelines: PipelineDefinition[];
  /** Pipeline execution history entries. */
  historyEntries: PipelineHistoryEntry[];
  /** Execution data for the running pipeline view. */
  executionData: PipelineExecutionData | undefined;
  /** Whether the save mutation is in progress. */
  savingPipeline: boolean;
  /** Marketplace template list query loading state. */
  marketplaceLoading: boolean;
  /** Marketplace template list query error. */
  marketplaceError: string | null;
  /** Marketplace templates array. */
  marketplaceTemplates: MarketplaceTemplate[];
  /** Scheduled pipelines for the calendar view. */
  scheduledPipelines: ScheduledPipeline[];
  /** Pipeline generator mutation (AI feature). */
  pipelineGen: ReturnType<typeof usePipelineGenerator>;
  /** Number of steps in the current pipeline. */
  stepCount: number;
  /** Number of triggers in the current pipeline. */
  triggerCount: number;
  /** Number of history entries. */
  historyCount: number;
  /** Currently active tab ID. */
  activeTab: string;
  /** Set the active tab. */
  setActiveTab: (tab: string) => void;
  /** Currently selected step ID for the config panel. */
  selectedStepId: string;
  /** Set the selected step ID. */
  setSelectedStepId: (id: string) => void;
  /** Whether the AI generate pipeline prompt dialog is shown. */
  showGenPrompt: boolean;
  /** Set whether the generate prompt dialog is shown. */
  setShowGenPrompt: (show: boolean) => void;
  /** AI generation description input value. */
  genDescription: string;
  /** Set the AI generation description. */
  setGenDescription: (desc: string) => void;
  /** Create a new empty pipeline. */
  handleCreatePipeline: () => void;
  /** Run the current pipeline. */
  handleRunPipeline: () => void;
  /** Save the current pipeline. */
  handleSavePipeline: () => void;
  /** Load a saved pipeline and switch to canvas tab. */
  handleLoadPipeline: (p: PipelineDefinition) => void;
  /**
   * Install a marketplace template.
   *
   * Sends `marketplace:install` and loads the pipeline the host returns onto
   * the canvas. Nothing is claimed before that answer arrives.
   */
  handleInstallTemplate: (tpl: { id: string; name: string; description: string }) => void;
  /** Add a step of the given type to the pipeline. */
  handleAddStep: (type: PipelineStepType) => void;
  /** Remove a step by ID from the pipeline. */
  handleRemoveStep: (stepId: string) => void;
  /** Update a step's properties by ID. */
  handleUpdateStep: (stepId: string, updates: Partial<PipelineDefinition['steps'][0]>) => void;
  /** Add a trigger of the given type to the pipeline. */
  handleAddTrigger: (type: TriggerType) => void;
  /** Remove a trigger by ID from the pipeline. */
  handleRemoveTrigger: (triggerId: string) => void;
  /** Toggle a trigger's enabled state. */
  handleToggleTrigger: (triggerId: string, enabled: boolean) => void;
  /** Update the cron expression for a trigger. */
  handleUpdateCron: (triggerId: string, cron: string) => void;
  /** Open the AI generate pipeline prompt dialog. */
  handleGeneratePipeline: () => void;
  /** Submit the AI generation description. */
  handleGenSubmit: () => void;
}

/**
 * Extracts all data-fetching logic, bridge queries, mutations, and derived state
 * from AutomationPage into a single composable hook.
 *
 * This hook manages:
 * - Bridge queries for pipeline list, templates, history, and marketplace
 * - Bridge mutations for pipeline execution and save
 * - Pipeline CRUD operations (create, load, add/remove steps and triggers)
 * - AI pipeline generator integration
 * - Error notification effects
 * - Execution data derivation
 */
export function useAutomationPageData(): AutomationPageData {
  const { t } = useTranslation();
  const addNotification = useNotificationStore((s) => s.addNotification);

  const [activeTab, setActiveTab] = useState('canvas');
  const [selectedStepId, setSelectedStepId] = useState<string>('');

  const pipelineGen = usePipelineGenerator();
  /**
   * Marketplace install.
   *
   * The host has handled `marketplace:install` since it shipped
   * (AutomationHandler.handleMarketplaceInstall exports the template and
   * answers `marketplace:install:response`). What kept the button saying
   * "coming soon" was an entry in the KNOWN_UNSENT allowlist asserting the
   * marketplace "cannot install" — a note about the UI, read for years as a
   * statement about the product.
   */
  const installMutation = useBridgeMutation<{
    success: boolean;
    pipeline?: Record<string, unknown>;
    error?: string;
  }>('marketplace:install');
  const marketplaceList = useBridgeQuery<{ success: boolean; templates?: MarketplaceTemplate[] }>(
    'marketplace:list',
  );

  // Pipeline state
  const [pipeline, setPipeline] = useState<PipelineDefinition | undefined>();
  const [error, setError] = useState<string | null>(null);

  // Scheduled pipelines (local state for now)
  const [scheduledPipelines] = useState<ScheduledPipeline[]>([]);

  // Bridge query: load saved pipelines
  const pipelinesQuery = useBridgeQuery<{ pipelines: PipelineDefinition[] }>('pipeline:list');

  // Bridge mutation: execute a pipeline.
  // The UI deadline must not undercut the host budget: AutomationHandler wraps
  // the run in `sandforge.pipeline.timeout`, whose manifest default is
  // 300 000 ms (packages/extension/package.json → contributes.configuration →
  // `sandforge.pipeline.timeout`.default). On the 30 s useBridgeMutation
  // default a 45 s pipeline was reported as failed while it was still running
  // and about to succeed. useAutomationPageData.test.ts reads that manifest
  // default and asserts it against this value, so the two cannot re-diverge
  // silently.
  const executeMutation = useBridgeMutation<Record<string, unknown>>('pipeline:execute', {
    responseType: 'pipeline:run:response',
    timeoutMs: 300_000,
  });

  // Bridge mutation: save a pipeline.
  // Typed on the PipelineSaveResponse payload so the acknowledgement can be
  // read: the success toast is raised from `data.success`, not from the click.
  const saveMutation = useBridgeMutation<{ success: boolean; id: string }>('pipeline:save');

  // Bridge query: load pipeline templates
  const templatesQuery = useBridgeQuery<{ templates: Record<string, unknown>[] }>(
    'pipeline:templates',
    undefined,
    { responseType: 'pipeline:templates:response' },
  );

  // Bridge query: load pipeline history
  const historyQuery = useBridgeQuery<{ history: PipelineHistoryEntry[] }>('pipeline:history');

  // Derive running state from bridge mutation
  const isRunning = executeMutation.loading;

  // Derive history from bridge query
  const historyEntries = historyQuery.data?.history ?? [];

  // Derive saved pipelines from bridge query
  const savedPipelines = pipelinesQuery.data?.pipelines ?? [];

  // Derive execution data for the execution view while running
  const executionData = useMemo<PipelineExecutionData | undefined>(() => {
    if (!isRunning || !pipeline) return undefined;
    return {
      runId: pipeline.id,
      pipelineName: pipeline.name,
      status: 'running',
      steps: pipeline.steps.map((s) => ({
        stepId: s.id,
        stepName: s.name,
        stepType: s.type,
        status: 'pending' as const,
        duration: 0,
      })),
      startTime: new Date().toISOString(),
      elapsed: 0,
      progress: 0,
    };
  }, [isRunning, pipeline]);

  // Show error notifications from bridge hooks
  useEffect(() => {
    const bridgeError =
      pipelinesQuery.error ??
      executeMutation.error ??
      saveMutation.error ??
      templatesQuery.error ??
      historyQuery.error ??
      // `ai:error` and the generator timeout had no reader: a failed generation
      // left the prompt closed and the page silent.
      pipelineGen.error;
    if (bridgeError) {
      setError(bridgeError);
      addNotification({
        level: 'error',
        title: t('automation.title'),
        message: bridgeError,
        autoDismissMs: 5000,
      });
    }
  }, [
    pipelinesQuery.error,
    executeMutation.error,
    saveMutation.error,
    templatesQuery.error,
    historyQuery.error,
    pipelineGen.error,
    addNotification,
    t,
  ]);

  // Announce the save only once the host has acknowledged it.
  //
  // The toast used to fire synchronously inside handleSavePipeline, one line
  // after `mutate()` — before any reply existed. The user saw green, then red
  // when `pipeline:error` arrived seconds later, or nothing but green when the
  // write had silently failed. Failures still surface through the bridge-error
  // effect above: handlePipelineSave replies on `pipeline:error`, which is the
  // default error channel of this mutation, and a lost reply becomes a timeout.
  useEffect(() => {
    if (!saveMutation.data?.success) return;
    addNotification({
      level: 'success',
      title: t('automation.title'),
      message: t('automation.pipelineSaved'),
      autoDismissMs: 3000,
    });
  }, [saveMutation.data]); // eslint-disable-line react-hooks/exhaustive-deps

  // Consume the AI-generated pipeline.
  //
  // The response was dropped on the floor: the user described a pipeline,
  // waited out the round trip and got nothing — no canvas, no explanation.
  // `success: false` carries the reason (an unset API key is the common one),
  // which is the only thing that tells the user what to do next.
  useEffect(() => {
    const generated = pipelineGen.data;
    if (!generated) return;
    if (!generated.success || !generated.pipeline) {
      const message = generated.error ?? t('ai.error.unknown');
      setError(message);
      addNotification({
        level: 'error',
        title: t('automation.title'),
        message,
        autoDismissMs: 5000,
      });
      return;
    }
    setPipeline(toPipelineDefinition(generated.pipeline, t('automation.newPipeline')));
    setActiveTab('canvas');
  }, [pipelineGen.data]); // eslint-disable-line react-hooks/exhaustive-deps

  // Same shape as the generator effect above: the answer decides, not the click.
  useEffect(() => {
    const installed = installMutation.data;
    if (!installed) return;
    if (!installed.success || !installed.pipeline) {
      const message = installed.error ?? t('automation.installFailed');
      setError(message);
      addNotification({
        level: 'error',
        title: t('automation.marketplace'),
        message,
        autoDismissMs: 5000,
      });
      return;
    }
    setPipeline(toPipelineDefinition(installed.pipeline, t('automation.newPipeline')));
    setActiveTab('canvas');
    addNotification({
      level: 'success',
      title: t('automation.marketplace'),
      message: t('automation.templateInstalled'),
      autoDismissMs: 3000,
    });
  }, [installMutation.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCreatePipeline = () => {
    const newPipeline: PipelineDefinition = {
      id: crypto.randomUUID(),
      name: t('automation.newPipeline'),
      description: '',
      version: 1,
      steps: [],
      triggers: [],
      variables: [],
      tags: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    setPipeline(newPipeline);
  };

  const handleRunPipeline = () => {
    if (!pipeline) return;
    setError(null);
    executeMutation.mutate({
      pipeline: pipeline as unknown as Record<string, unknown>,
      variables: {},
    });
  };

  const handleSavePipeline = () => {
    if (!pipeline) return;
    // PipelineSaveRequest contract: { id, config } — the AutomationHandler
    // persists `config` under `pipeline:saved:{id}` in the 'pipelines' category.
    saveMutation.mutate({
      id: pipeline.id,
      config: pipeline as unknown as Record<string, unknown>,
    });
  };

  const handleLoadPipeline = (p: PipelineDefinition) => {
    setPipeline(p);
    setActiveTab('canvas');
  };

  /*
   * Install is not wired, and now says so.
   *
   * It used to build an EMPTY pipeline carrying only the template's name and
   * description, drop the user on the canvas and toast "Template installed as
   * new pipeline". The template's steps live in the host's PipelineMarketplace
   * and never crossed the bridge — `marketplace:list:response` carries only
   * id/name/description/category/author — so what the user got was a blank
   * pipeline wearing the template's name.
   *
   * The host half exists: AutomationHandler routes `marketplace:install` and
   * answers `marketplace:install:response` with the exported pipeline. Sending
   * it is a one-line change here, but `marketplace:install` is listed in
   * KNOWN_UNSENT (packages/shared/src/types/messages/consumedChannels.test.ts),
   * whose "keeps the known-unsent allowlist honest" case fails the moment a
   * sender appears — and that file is part of the shared contract. Until that
   * entry is removed, saying "coming soon" is the honest reading of the button.
   */
  const handleInstallTemplate = (tpl: { id: string; name: string; description: string }) => {
    installMutation.mutate({ templateId: tpl.id });
  };

  const handleAddStep = (type: PipelineStepType) => {
    if (!pipeline) return;
    const newStep = {
      id: crypto.randomUUID(),
      name: type,
      type,
      config: {},
      continueOnError: false,
    };
    setPipeline({
      ...pipeline,
      steps: [...pipeline.steps, newStep],
      updatedAt: new Date().toISOString(),
    });
  };

  const handleRemoveStep = (stepId: string) => {
    if (!pipeline) return;
    setPipeline({
      ...pipeline,
      steps: pipeline.steps.filter((s) => s.id !== stepId),
      updatedAt: new Date().toISOString(),
    });
  };

  const handleAddTrigger = (type: TriggerType) => {
    if (!pipeline) return;
    const newTrigger = {
      id: crypto.randomUUID(),
      type,
      enabled: true,
      config: {},
    };
    setPipeline({
      ...pipeline,
      triggers: [...pipeline.triggers, newTrigger],
      updatedAt: new Date().toISOString(),
    });
  };

  const handleUpdateStep = (stepId: string, updates: Partial<PipelineDefinition['steps'][0]>) => {
    if (!pipeline) return;
    setPipeline({
      ...pipeline,
      steps: pipeline.steps.map((s) => (s.id === stepId ? { ...s, ...updates } : s)),
      updatedAt: new Date().toISOString(),
    });
  };

  const handleRemoveTrigger = (triggerId: string) => {
    if (!pipeline) return;
    setPipeline({
      ...pipeline,
      triggers: pipeline.triggers.filter((tr) => tr.id !== triggerId),
      updatedAt: new Date().toISOString(),
    });
  };

  const handleToggleTrigger = (triggerId: string, enabled: boolean) => {
    if (!pipeline) return;
    setPipeline({
      ...pipeline,
      triggers: pipeline.triggers.map((tr) => (tr.id === triggerId ? { ...tr, enabled } : tr)),
      updatedAt: new Date().toISOString(),
    });
  };

  const handleUpdateCron = (triggerId: string, cron: string) => {
    if (!pipeline) return;
    setPipeline({
      ...pipeline,
      triggers: pipeline.triggers.map((tr) =>
        tr.id === triggerId ? { ...tr, config: { ...tr.config, cron } } : tr,
      ),
      updatedAt: new Date().toISOString(),
    });
  };

  const [showGenPrompt, setShowGenPrompt] = useState(false);
  const [genDescription, setGenDescription] = useState('');

  const handleGeneratePipeline = () => {
    setShowGenPrompt(true);
  };

  const handleGenSubmit = () => {
    if (genDescription.trim()) {
      pipelineGen.mutate({ description: genDescription.trim() });
      setGenDescription('');
    }
    setShowGenPrompt(false);
  };

  const stepCount = pipeline?.steps.length ?? 0;
  const triggerCount = pipeline?.triggers.length ?? 0;
  const historyCount = historyEntries.length;

  return {
    pipeline,
    error,
    clearError: () => setError(null),
    isRunning,
    pipelinesLoading: pipelinesQuery.loading,
    savedPipelines,
    historyEntries,
    executionData,
    savingPipeline: saveMutation.loading,
    marketplaceLoading: marketplaceList.loading,
    marketplaceError: marketplaceList.error,
    marketplaceTemplates: marketplaceList.data?.templates ?? [],
    scheduledPipelines,
    pipelineGen,
    stepCount,
    triggerCount,
    historyCount,
    activeTab,
    setActiveTab,
    selectedStepId,
    setSelectedStepId,
    showGenPrompt,
    setShowGenPrompt,
    genDescription,
    setGenDescription,
    handleCreatePipeline,
    handleRunPipeline,
    handleSavePipeline,
    handleLoadPipeline,
    handleInstallTemplate,
    handleAddStep,
    handleRemoveStep,
    handleUpdateStep,
    handleAddTrigger,
    handleRemoveTrigger,
    handleToggleTrigger,
    handleUpdateCron,
    handleGeneratePipeline,
    handleGenSubmit,
  };
}
