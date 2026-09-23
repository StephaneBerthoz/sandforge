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
import { useLatestRef } from '../../hooks/useLatestRef';
import type { PipelineExecutionData } from './PipelineExecutionView';
import { blockedSteps, typeBlocker } from './stepRunnability';
import type { BlockedStep } from './stepRunnability';

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

/**
 * The longest run `sandforge.pipeline.timeout` allows: its `maximum` in the
 * extension manifest, one hour.
 */
const PIPELINE_BUDGET_MAX_MS = 3_600_000;

/** How long past that budget the page waits for the host's answer to cross the bridge. */
const ANSWER_MARGIN_MS = 60_000;

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
 * becomes a `script` step so the user still sees the step, marked as one that
 * cannot run (and so is the pipeline holding it), and an unknown trigger
 * string ('error_detected' is one the generator emits) is dropped instead of
 * poisoning the trigger panel.
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
  /**
   * The type of each step of the template, so the card can say before Install
   * which of them cannot run. Absent from a host that predates it.
   */
  stepTypes?: string[];
}

/**
 * The sentence a failed run is reported with: the run's own error, or else the
 * error of its first failed step. The host writes both in English, for its log;
 * the headline around it is translated.
 */
function runFailureReason(run: Record<string, unknown>): string | undefined {
  if (typeof run.error === 'string' && run.error.length > 0) return run.error;
  const steps = Array.isArray(run.stepResults) ? run.stepResults : [];
  for (const step of steps) {
    const result = asRecord(step);
    if (result.status === 'failed' && typeof result.error === 'string') return result.error;
  }
  return undefined;
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
  /** Pipeline generator mutation (AI feature). */
  pipelineGen: ReturnType<typeof usePipelineGenerator>;
  /** Number of steps in the current pipeline. */
  stepCount: number;
  /** Number of triggers in the current pipeline. */
  triggerCount: number;
  /** Number of history entries. */
  historyCount: number;
  /**
   * The steps of the current pipeline that keep it from running, with the
   * reason for each. Run is refused while this is not empty.
   */
  runBlockers: BlockedStep[];
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
  /** Run the current pipeline, unless one of its steps cannot run. */
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
  /** Add a step of the given type to the pipeline, unless the type cannot run. */
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

  // Bridge query: load saved pipelines
  const pipelinesQuery = useBridgeQuery<{ pipelines: PipelineDefinition[] }>('pipeline:list');

  // Bridge mutation: execute a pipeline.
  // The UI deadline must not undercut the host budget. AutomationHandler bounds
  // a run with `sandforge.pipeline.timeout` and answers however the run ends,
  // a run that budget stopped included. The page cannot read the setting, so
  // it waits out the longest budget the setting accepts and a margin for the
  // answer to arrive: this deadline only fires for a host that never answers.
  // On the 30 s useBridgeMutation default a 45 s pipeline was reported as
  // failed while it was still running and about to succeed. A deadline equal
  // to the default budget is no better: it starts when the request leaves,
  // before the host's, so it ends first and drops the host's answer to a run
  // that budget stopped. useAutomationPageData.test.ts reads the manifest's
  // `maximum` and asserts this value against it, so the two cannot re-diverge
  // silently.
  const executeMutation = useBridgeMutation<Record<string, unknown>>('pipeline:execute', {
    responseType: 'pipeline:run:response',
    timeoutMs: PIPELINE_BUDGET_MAX_MS + ANSWER_MARGIN_MS,
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

  // What keeps the current pipeline from running. The extension refuses such
  // a pipeline before its first step; the page says so before Run is pressed.
  const runBlockers = useMemo(() => (pipeline ? blockedSteps(pipeline.steps) : []), [pipeline]);

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
  const announceSaved = useLatestRef(() => {
    addNotification({
      level: 'success',
      title: t('automation.title'),
      message: t('automation.pipelineSaved'),
      autoDismissMs: 3000,
    });
  });
  useEffect(() => {
    if (!saveMutation.data?.success) return;
    announceSaved.current();
  }, [saveMutation.data, announceSaved]);

  // The host writes a run to its history when the run ends, but answers
  // `pipeline:history` only on request, and the query fires once on mount:
  // without asking again, the History tab and its count missed every run made
  // since the page opened. A completed or failed run both answer on
  // `pipeline:run:response`; a run that throws is not written, so there is
  // nothing new to fetch.
  //
  // A failed run is also said here. It used to reach only the History tab, as
  // a red badge and an error count, with no word of what went wrong.
  const settleRun = useLatestRef((run: Record<string, unknown>) => {
    historyQuery.refetch();
    if (run.status !== 'failed') return;
    const reason = runFailureReason(run);
    if (reason === undefined) return;
    const message = t('automation.runFailed', { reason });
    setError(message);
    addNotification({
      level: 'error',
      title: t('automation.title'),
      message,
      autoDismissMs: 5000,
    });
  });
  useEffect(() => {
    if (!executeMutation.data) return;
    settleRun.current(executeMutation.data);
  }, [executeMutation.data, settleRun]);

  // Consume the AI-generated pipeline.
  //
  // The response was dropped on the floor: the user described a pipeline,
  // waited out the round trip and got nothing — no canvas, no explanation.
  // `success: false` carries the reason (an unset API key is the common one),
  // which is the only thing that tells the user what to do next.
  const adoptGenerated = useLatestRef((generated: NonNullable<typeof pipelineGen.data>) => {
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
  });
  useEffect(() => {
    const generated = pipelineGen.data;
    if (!generated) return;
    adoptGenerated.current(generated);
  }, [pipelineGen.data, adoptGenerated]);

  // Same shape as the generator effect above: the answer decides, not the click.
  const adoptInstalled = useLatestRef((installed: NonNullable<typeof installMutation.data>) => {
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
  });
  useEffect(() => {
    const installed = installMutation.data;
    if (!installed) return;
    adoptInstalled.current(installed);
  }, [installMutation.data, adoptInstalled]);

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
    // The Run button is disabled on the same condition; this keeps any other
    // caller from sending a pipeline the extension would refuse.
    if (!pipeline || runBlockers.length > 0) return;
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

  const handleInstallTemplate = (tpl: { id: string; name: string; description: string }) => {
    installMutation.mutate({ templateId: tpl.id });
  };

  const handleAddStep = (type: PipelineStepType) => {
    if (!pipeline || typeBlocker(type) !== undefined) return;
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
    pipelineGen,
    stepCount,
    triggerCount,
    historyCount,
    runBlockers,
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
