import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { PipelineDefinition, PipelineStepType, TriggerType, PipelineHistoryEntry } from '@sandforge/shared';
import { useNotificationStore } from '../../stores/useNotificationStore';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { usePipelineGenerator } from '../../hooks/useAIFeatures';
import type { PipelineExecutionData } from './PipelineExecutionView';
import type { ScheduledPipeline } from './SchedulerCalendar';

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
  /** Install a marketplace template as a new pipeline. */
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
  const marketplaceList = useBridgeQuery<{ success: boolean; templates?: MarketplaceTemplate[] }>('marketplace:list');

  // Pipeline state
  const [pipeline, setPipeline] = useState<PipelineDefinition | undefined>();
  const [error, setError] = useState<string | null>(null);

  // Scheduled pipelines (local state for now)
  const [scheduledPipelines] = useState<ScheduledPipeline[]>([]);

  // Bridge query: load saved pipelines
  const pipelinesQuery = useBridgeQuery<{ pipelines: PipelineDefinition[] }>(
    'pipeline:list',
    undefined,
    { responseType: 'pipeline:list:result' },
  );

  // Bridge mutation: execute a pipeline
  const executeMutation = useBridgeMutation<Record<string, unknown>>(
    'pipeline:execute',
    { responseType: 'pipeline:run:response' },
  );

  // Bridge mutation: save a pipeline
  const saveMutation = useBridgeMutation<Record<string, unknown>>(
    'pipeline:save',
    { responseType: 'pipeline:saved' },
  );

  // Bridge query: load pipeline templates
  const templatesQuery = useBridgeQuery<{ templates: Record<string, unknown>[] }>(
    'pipeline:templates',
    undefined,
    { responseType: 'pipeline:templates:response' },
  );

  // Bridge query: load pipeline history
  const historyQuery = useBridgeQuery<{ entries: PipelineHistoryEntry[] }>(
    'pipeline:history',
    undefined,
    { responseType: 'pipeline:history:result' },
  );

  // Derive running state from bridge mutation
  const isRunning = executeMutation.loading;

  // Derive history from bridge query
  const historyEntries = historyQuery.data?.entries ?? [];

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
    const bridgeError = pipelinesQuery.error ?? executeMutation.error ?? saveMutation.error ?? templatesQuery.error ?? historyQuery.error;
    if (bridgeError) {
      setError(bridgeError);
      addNotification({ level: 'error', title: t('automation.title'), message: bridgeError, autoDismissMs: 5000 });
    }
  }, [pipelinesQuery.error, executeMutation.error, saveMutation.error, templatesQuery.error, historyQuery.error, addNotification, t]);

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
    saveMutation.mutate({ pipeline: pipeline as unknown as Record<string, unknown> });
    addNotification({ level: 'success', title: t('automation.title'), message: t('automation.pipelineSaved'), autoDismissMs: 3000 });
  };

  const handleLoadPipeline = (p: PipelineDefinition) => {
    setPipeline(p);
    setActiveTab('canvas');
  };

  const handleInstallTemplate = (tpl: { id: string; name: string; description: string }) => {
    const newPipeline: PipelineDefinition = {
      id: crypto.randomUUID(),
      name: tpl.name,
      description: tpl.description,
      version: 1,
      steps: [],
      triggers: [],
      variables: [],
      tags: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    setPipeline(newPipeline);
    setActiveTab('canvas');
    addNotification({ level: 'success', title: t('automation.marketplace'), message: t('automation.templateInstalled'), autoDismissMs: 3000 });
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
      steps: pipeline.steps.map((s) =>
        s.id === stepId ? { ...s, ...updates } : s,
      ),
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
      triggers: pipeline.triggers.map((tr) =>
        tr.id === triggerId ? { ...tr, enabled } : tr,
      ),
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
