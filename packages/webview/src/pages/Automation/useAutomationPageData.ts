import { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type {
  ConditionOperator,
  OperationCompleted,
  OperationFailed,
  PipelineCondition,
  PipelineDefinition,
  PipelineDeleteResponse,
  PipelineDraftSuggestion,
  PipelineMaskingTemplateInfo,
  PipelineRewindGrantResponse,
  PipelineRewindStepInfo,
  PipelineSeedTemplateInfo,
  PipelineStepType,
  PipelineWritePage,
  PipelineStepUpdate,
  PipelineSyncConfigInfo,
  PipelineTrigger,
  PipelineTriggerStatus,
  TriggerConfig,
  TriggerType,
  PipelineHistoryEntry,
} from '@sandforge/shared';
import {
  guardTierOf,
  isPipelineStepType,
  isRetiredPipelineStepType,
  isTriggeredRun,
  orgDisplayName,
} from '@sandforge/shared';
import { useNotificationStore } from '../../stores/useNotificationStore';
import { useOrgStore } from '../../stores/useOrgStore';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { useMessageListener, useSendMessage } from '../../hooks/useMessageBus';
import { buildMessage } from '../../bridge/messageHelpers';
import { usePipelineGenerator } from '../../hooks/useAIFeatures';
import { useLatestRef } from '../../hooks/useLatestRef';
import { useWebviewPersistedState } from '../../hooks/useWebviewPersistedState';
import type { PipelineExecutionData } from './PipelineExecutionView';
import { blockedSteps, paletteBlocker } from './stepRunnability';
import { newStepName } from './stepTypeLabel';
import type { BlockedStep, StepPlace } from './stepRunnability';
import type { TriggerSandbox } from './TriggerConfigPanel';
import type { PipelineScheduleRow } from './SchedulerCalendar';
import { getLocalTimezone } from '../Sync/CronScheduleBuilder';

/**
 * The `TriggerType` union as data, for narrowing untyped host payloads: a
 * generated draft can name triggers that are not members of it.
 */
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

/**
 * How long after a planned start the page asks again: the extension looks
 * at a schedule when it falls due, and the run it starts, or the start it
 * reports missed, is written a moment later.
 */
const AFTER_START_MS = 5_000;

/** The longest one timer waits: setTimeout fires at once past 2^31 - 1 ms. */
const MAX_REFRESH_WAIT_MS = 6 * 60 * 60_000;

/**
 * The longest the extension goes without looking at its schedules: a start
 * already past when the page asks has been looked at within it.
 */
const HOST_LOOK_MS = 60_000;

/**
 * How long until the saved pipelines, their trigger statuses and the history
 * are worth asking for again: a moment after the soonest planned start, when
 * the run it started, or the start it missed, is in the history and the next
 * start is planned. Undefined when no trigger plans a start.
 */
export function nextTriggerRefreshDelay(
  statuses: readonly PipelineTriggerStatus[],
  now: number,
): number | undefined {
  let soonest = Number.POSITIVE_INFINITY;
  for (const status of statuses) {
    if (!status.armed || !status.nextRunAt) continue;
    const at = Date.parse(status.nextRunAt);
    if (Number.isFinite(at)) soonest = Math.min(soonest, at);
  }
  if (soonest === Number.POSITIVE_INFINITY) return undefined;
  // A start already past has not been looked at yet: asked again at once, the
  // answer would be the same.
  const wait = soonest > now ? soonest - now : HOST_LOOK_MS;
  return Math.min(wait + AFTER_START_MS, MAX_REFRESH_WAIT_MS);
}

/** Narrows an unknown value to a plain object without widening to `any`. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** The pages the host sends work a pipeline cannot run to, as data. */
const WRITE_PAGES: readonly PipelineWritePage[] = ['sync', 'seed', 'dataops'];

/**
 * What a draft leaves out, as the host sent it beside the draft. An entry of
 * another shape — a sentence from a host that sent English — is dropped
 * rather than shown in English on a page in another language.
 */
export function toDraftSuggestions(raw: unknown): PipelineDraftSuggestion[] {
  if (!Array.isArray(raw)) return [];
  const kept: PipelineDraftSuggestion[] = [];
  for (const entry of raw) {
    const { code, page, stepType } = asRecord(entry);
    const writePage = WRITE_PAGES.find((known) => known === page);
    if (code === 'WRITES_TO_ORG' && writePage) kept.push({ code, page: writePage });
    else if (code === 'STEP_NOT_RUNNABLE' && typeof stepType === 'string') {
      kept.push({ code, stepType });
    }
  }
  return kept;
}

/**
 * A suggestion in the reader's language: the page named as the menu names
 * it, a step type as the palette does, or as the model wrote it when the
 * palette has no such type.
 */
export function draftSuggestionText(t: TFunction, suggestion: PipelineDraftSuggestion): string {
  if (suggestion.code === 'WRITES_TO_ORG') {
    return t('automation.draftSuggestions.writesToOrg', { page: t(`nav.${suggestion.page}`) });
  }
  return t('automation.draftSuggestions.stepNotRunnable', {
    type: t(`automation.stepTypes.${suggestion.stepType}`, { defaultValue: suggestion.stepType }),
  });
}

/**
 * A step's condition, as a Marketplace template carries it: its field, its
 * operator and what it compares with. Anything else is no condition, and the
 * step is marked as one that cannot run. Dropping it, as every condition used
 * to be dropped here, left an installed Condition step with nothing to test.
 */
function toCondition(raw: unknown): PipelineCondition | undefined {
  const condition = asRecord(raw);
  const { field, operator, value } = condition;
  if (typeof field !== 'string' || typeof operator !== 'string') return undefined;
  const kept: PipelineCondition = { field, operator: operator as ConditionOperator, value: '' };
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    kept.value = value;
  }
  return kept;
}

/**
 * Turns the AI generator's or the Marketplace's loose pipeline into a
 * `PipelineDefinition`, and says which step types it left out.
 *
 * `ai:generate-pipeline:response` carries `pipeline` as `Record<string, unknown>`:
 * the host's `GeneratedPipeline` (name, description, steps of
 * `{ name, type, config }`, an optional cron `schedule`, optional `triggers`
 * strings). Every field is narrowed rather than cast. A step of a type
 * SandForge no longer has (Script, Loop, Parallel) is kept as it is, marked on
 * the canvas as no longer supported; a step of a type no release ever had is
 * left out and named beside the draft, as the generator names what it leaves
 * out. Such a step used to become a Script step, a type that never ran and is
 * gone. An unknown trigger string is dropped instead of poisoning the trigger
 * panel.
 *
 * @param raw - The `pipeline` payload of the AI response.
 * @param fallbackName - Name to use when the generator returned none.
 */
function toPipelineDefinition(
  raw: Record<string, unknown>,
  fallbackName: string,
): { pipeline: PipelineDefinition; leftOut: string[] } {
  const now = new Date().toISOString();

  const triggers: PipelineDefinition['triggers'] = [];
  if (typeof raw.schedule === 'string' && raw.schedule.length > 0) {
    // Read in the time zone of the person who asked for it, as a schedule
    // added by hand is.
    triggers.push({
      id: crypto.randomUUID(),
      type: 'schedule',
      enabled: true,
      config: { cron: raw.schedule, timezone: getLocalTimezone() },
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
  const leftOut: string[] = [];
  const steps = rawSteps.flatMap((rawStep): PipelineDefinition['steps'] => {
    const step = asRecord(rawStep);
    if (!isPipelineStepType(step.type) && !isRetiredPipelineStepType(step.type)) {
      const named = typeof step.type === 'string' && step.type !== '' ? step.type : '?';
      if (!leftOut.includes(named)) leftOut.push(named);
      return [];
    }
    // A retired type stays as it was written, for the canvas to mark: the
    // union no longer names it, and the extension refuses it by name.
    const type = step.type as PipelineStepType;
    const condition = toCondition(step.condition);
    return [
      {
        id: crypto.randomUUID(),
        name: typeof step.name === 'string' && step.name.length > 0 ? step.name : type,
        type,
        config: asRecord(step.config),
        ...(condition ? { condition } : {}),
        continueOnError: false,
      },
    ];
  });

  return {
    leftOut,
    pipeline: {
      id: crypto.randomUUID(),
      name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : fallbackName,
      description: typeof raw.description === 'string' ? raw.description : '',
      version: 1,
      steps,
      triggers,
      variables: [],
      tags: [],
      createdAt: now,
      updatedAt: now,
    },
  };
}

/**
 * A value as JSON with the keys of every object in order: two pipelines with
 * the same content read the same, whichever order an edit left their keys in.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, held: unknown) =>
    typeof held === 'object' && held !== null && !Array.isArray(held)
      ? Object.fromEntries(Object.entries(held).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : held,
  );
}

/**
 * What a person puts in a pipeline, and nothing the page or the extension
 * stamps on it: not its id, version, dates or the key it is saved under.
 */
function contentOf(pipeline: PipelineDefinition): string {
  return canonicalJson({
    name: pipeline.name,
    description: pipeline.description ?? '',
    steps: pipeline.steps ?? [],
    triggers: pipeline.triggers ?? [],
    variables: pipeline.variables ?? [],
    tags: pipeline.tags ?? [],
  });
}

/**
 * Whether the pipeline on the canvas holds work no save keeps: compared with
 * the pipeline saved under its id, field by field. One never saved holds such
 * work once it has a step, a trigger, a variable or a description; a name
 * alone, on a pipeline with nothing in it, is not worth a question.
 */
export function hasUnsavedChanges(
  pipeline: PipelineDefinition | undefined,
  savedPipelines: readonly PipelineDefinition[],
): boolean {
  if (!pipeline) return false;
  const saved = savedPipelines.find((candidate) => candidate.id === pipeline.id);
  if (!saved) {
    return (
      (pipeline.steps ?? []).length > 0 ||
      (pipeline.triggers ?? []).length > 0 ||
      (pipeline.variables ?? []).length > 0 ||
      (pipeline.description ?? '') !== ''
    );
  }
  return contentOf(pipeline) !== contentOf(saved);
}

/**
 * The name a new pipeline is given: "New pipeline", numbered past the names
 * already saved. Every pipeline built by hand was called the same, and the
 * saved list filled with names that told them apart by nothing.
 */
export function newPipelineName(taken: readonly string[], t: TFunction): string {
  const base = t('automation.newPipeline');
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base} ${n}`)) n += 1;
  return `${base} ${n}`;
}

/**
 * What replaces the pipeline on the canvas: a new one, a saved one opened, a
 * Marketplace template installed, or a draft the AI writes. Each asks first
 * when the pipeline there holds unsaved changes.
 */
export type PipelineSwitch =
  | { kind: 'new' }
  | { kind: 'open'; pipeline: PipelineDefinition }
  | { kind: 'install'; templateId: string }
  | { kind: 'generate' };

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
 * The sentence a failed run is reported with, in the reader's language: the
 * run's own error, or else the error of its first failed step, around which
 * the headline is translated — the host writes both in English, for its log.
 *
 * A run refused for a step of a type SandForge does not have — a pipeline a
 * later release saved, or one written by hand — is said in full in the
 * reader's language, naming the step: the page knows the type from the step's
 * result. The extension used to refuse it as an invalid payload, in the
 * schema's words.
 */
function runFailureMessage(t: TFunction, run: Record<string, unknown>): string | undefined {
  const steps = Array.isArray(run.stepResults) ? run.stepResults.map(asRecord) : [];
  const unknown = steps.find(
    (result) =>
      result.status === 'failed' &&
      typeof result.stepType === 'string' &&
      !isPipelineStepType(result.stepType) &&
      !isRetiredPipelineStepType(result.stepType),
  );
  if (unknown) {
    return t('automation.runRefusedUnknownType', {
      step: typeof unknown.stepName === 'string' ? unknown.stepName : '',
      type: unknown.stepType,
    });
  }
  if (typeof run.error === 'string' && run.error.length > 0) {
    return t('automation.runFailed', { reason: run.error });
  }
  for (const result of steps) {
    if (result.status === 'failed' && typeof result.error === 'string') {
      return t('automation.runFailed', { reason: result.error });
    }
  }
  return undefined;
}

/**
 * The sentence a stopped run is reported with: the step it stopped at, when
 * one was going, and that the steps after it did not run.
 */
function runStoppedMessage(t: TFunction, run: Record<string, unknown>): string {
  const steps = Array.isArray(run.stepResults) ? run.stepResults.map(asRecord) : [];
  const at = steps.find((result) => result.status === 'stopped');
  return typeof at?.stepName === 'string'
    ? t('automation.runStoppedAt', { step: at.stepName })
    : t('automation.runStopped');
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
  /**
   * Whether the pipelines list is loading with nothing yet to show. The list is
   * asked for again after a save and after a run a trigger started: the page
   * keeps showing what it has meanwhile, rather than a skeleton.
   */
  pipelinesLoading: boolean;
  /** Saved pipelines from the bridge query. */
  savedPipelines: PipelineDefinition[];
  /**
   * The saved Sync configurations a Sync step can run, with what Production
   * Guard does with each; undefined until the extension has answered.
   */
  syncConfigs: PipelineSyncConfigInfo[] | undefined;
  /** The Seed templates a Seed step can run, as the extension describes them; undefined until then. */
  seedTemplates: PipelineSeedTemplateInfo[] | undefined;
  /** The masking templates an Anonymize step can run, with their objects; undefined until described. */
  maskingTemplates: PipelineMaskingTemplateInfo[] | undefined;
  /**
   * The Rewind steps of the current pipeline as saved, as the extension sees
   * them on this machine; undefined for a pipeline never saved, or until it
   * has answered.
   */
  rewindSteps: PipelineRewindStepInfo[] | undefined;
  /** The steps of the current pipeline as last saved; undefined for one never saved. */
  savedSteps: PipelineDefinition['steps'] | undefined;
  /**
   * Confirm a Rewind step of the saved pipeline with the org's alias, as
   * typed under its preview: `pipeline:rewind-grant`.
   */
  handleConfirmRewind: (stepId: string, typed: string) => void;
  /** Take back a Rewind step's confirmation: `pipeline:rewind-revoke`. */
  handleRevokeRewind: (stepId: string) => void;
  /** The extension's answer to the last confirmation sent, until another is sent. */
  rewindGrantAnswer: PipelineRewindGrantResponse['payload'] | null;
  /** Whether a confirmation is on its way to the extension. */
  rewindGrantPending: boolean;
  /**
   * What a step of the current pipeline is checked against beside itself:
   * the variables, what the extension describes, the tiers of the orgs.
   */
  stepAround: Omit<StepPlace, 'steps' | 'index'>;
  /** The names of the variables the current pipeline declares, which a Condition may test. */
  declaredVariables: ReadonlySet<string>;
  /**
   * What the extension says each schedule and sandbox refresh trigger of the
   * current pipeline, as saved, will do.
   */
  triggerStatuses: PipelineTriggerStatus[];
  /** The triggers of the current pipeline as it was last saved; absent for one never saved. */
  savedTriggers: PipelineTrigger[] | undefined;
  /** The registered sandboxes a sandbox refresh trigger can name. */
  sandboxes: TriggerSandbox[];
  /** The schedule triggers of every saved pipeline, with what the extension says of each. */
  pipelineSchedules: PipelineScheduleRow[];
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
  /**
   * What the draft on the canvas leaves out, and where its work runs: empty
   * once another pipeline is on the canvas.
   */
  draftSuggestions: PipelineDraftSuggestion[];
  /** Number of steps in the current pipeline. */
  stepCount: number;
  /** How many triggers start the current pipeline: schedules and sandbox refreshes, on. */
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
  /**
   * Create pipeline, and New: an empty pipeline under a name no saved one
   * has, once the unsaved changes of the one on the canvas may be lost.
   */
  handleCreatePipeline: () => void;
  /**
   * Whether the pipeline on the canvas holds work its save does not: see
   * {@link hasUnsavedChanges}.
   */
  unsavedChanges: boolean;
  /**
   * What waits to replace the pipeline on the canvas until the person says
   * its unsaved changes may be lost; null when nothing waits.
   */
  pendingSwitch: PipelineSwitch | null;
  /** Let the unsaved changes go, and replace the pipeline as asked. */
  handleConfirmDiscard: () => void;
  /** Keep the pipeline on the canvas, and drop what was to replace it. */
  handleKeepEditing: () => void;
  /** Rename the pipeline on the canvas; saved with it. */
  handleRenamePipeline: (name: string) => void;
  /**
   * Delete a saved pipeline: `pipeline:delete`. Once the extension has, the
   * saved list is asked for again, and the pipeline leaves the canvas if it
   * was there.
   */
  handleDeletePipeline: (target: PipelineDefinition) => void;
  /** The id of the saved pipeline whose delete is on its way, if one is. */
  deletingPipelineId: string | undefined;
  /** Run the current pipeline, unless one of its steps cannot run. */
  handleRunPipeline: () => void;
  /**
   * Stop the running pipeline: `execution:abort` for the run this page
   * started, which the extension stops through the orchestrator's abort path.
   */
  handleCancelRun: () => void;
  /**
   * Answer an Approval step of the run this page started that waits:
   * `pipeline:approval`, the same choice as the VS Code notification's.
   */
  handleAnswerApproval: (stepId: string, decision: 'approved' | 'rejected') => void;
  /** Save the current pipeline. */
  handleSavePipeline: () => void;
  /**
   * Open a saved pipeline on the canvas tab, once the unsaved changes of the
   * one there may be lost.
   */
  handleLoadPipeline: (p: PipelineDefinition) => void;
  /**
   * Install a marketplace template.
   *
   * Sends `marketplace:install`, once the unsaved changes of the pipeline on
   * the canvas may be lost, and loads the pipeline the host returns onto the
   * canvas. Nothing is claimed before that answer arrives.
   */
  handleInstallTemplate: (tpl: { id: string; name: string; description: string }) => void;
  /**
   * Add a step of the given type to the pipeline, starting one when none is
   * open, unless the type cannot run.
   */
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
  /** Change a trigger's cron expression, time zone or sandbox. */
  handleUpdateTriggerConfig: (triggerId: string, config: Partial<TriggerConfig>) => void;
  /**
   * Open the AI generate pipeline prompt dialog, once the unsaved changes of
   * the pipeline on the canvas may be lost: its draft takes the canvas.
   */
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

  // The pipeline on the canvas, kept by the panel: a shortcut or the command
  // palette takes the panel to another page, and the page coming back opens
  // on it again, unsaved changes and all. They used to go with the page, and
  // with no question.
  const [pipeline, setPipeline] = useWebviewPersistedState<PipelineDefinition | undefined>(
    'automationPipeline',
    undefined,
  );
  const [error, setError] = useState<string | null>(null);
  /** What the last draft adopted leaves out, kept with the id of that draft. */
  const [draft, setDraft] = useState<{
    pipelineId: string;
    suggestions: PipelineDraftSuggestion[];
  }>();

  // Bridge query: load saved pipelines, and what their triggers will do.
  const pipelinesQuery = useBridgeQuery<{
    pipelines: PipelineDefinition[];
    triggers?: PipelineTriggerStatus[];
  }>('pipeline:list');

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

  // Bridge mutation: delete a saved pipeline. A pipeline a run holds is
  // refused on `pipeline:error`, with the code PIPELINE_RUNNING.
  const deleteMutation = useBridgeMutation<PipelineDeleteResponse['payload']>('pipeline:delete');
  /** The saved pipeline whose delete was sent last, named as the list named it. */
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null);

  // Bridge query: load pipeline templates
  const templatesQuery = useBridgeQuery<{ templates: Record<string, unknown>[] }>(
    'pipeline:templates',
    undefined,
    { responseType: 'pipeline:templates:response' },
  );

  // Bridge query: load pipeline history
  const historyQuery = useBridgeQuery<{ history: PipelineHistoryEntry[] }>('pipeline:history');

  // Bridge query: the saved Sync configurations a Sync step can run, each
  // with what Production Guard does with a run of it.
  const syncConfigsQuery = useBridgeQuery<{ configs: PipelineSyncConfigInfo[] }>(
    'pipeline:sync-configs',
  );
  const syncConfigs = syncConfigsQuery.data?.configs;

  // The Seed and masking templates, as the extension describes them: what a
  // Seed or an Anonymize step is checked against before Run.
  const seedTemplatesQuery = useBridgeQuery<{ templates: PipelineSeedTemplateInfo[] }>(
    'pipeline:seed-templates',
  );
  const seedTemplates = seedTemplatesQuery.data?.templates;
  const maskingTemplatesQuery = useBridgeQuery<{ templates: PipelineMaskingTemplateInfo[] }>(
    'pipeline:masking-templates',
  );
  const maskingTemplates = maskingTemplatesQuery.data?.templates;

  // Derive running state from bridge mutation
  const isRunning = executeMutation.loading;

  /**
   * What the host has said of each step of the run in progress, by step id.
   * The execution view used to build every step `pending` and keep it so
   * until the run answered: a five-minute run looked stuck from start to end.
   */
  const [stepUpdates, setStepUpdates] = useState<
    Record<string, PipelineStepUpdate['payload'] & { at: number }>
  >({});
  const [runStartedAt, setRunStartedAt] = useState(0);
  // The run this page started is the one its `pipeline:execute` request
  // started: the host uses the request's id as the run's operationId.
  const runOperationId = executeMutation.requestId;
  useMessageListener<PipelineStepUpdate>(
    'pipeline:step',
    useCallback(
      (message: PipelineStepUpdate) => {
        const update = message.payload;
        if (!update || !runOperationId || update.operationId !== runOperationId) return;
        setStepUpdates((previous) => ({
          ...previous,
          [update.stepId]: { ...update, at: Date.now() },
        }));
      },
      [runOperationId],
    ),
  );

  const sendMessage = useSendMessage();
  const handleCancelRun = useCallback(() => {
    if (!runOperationId) return;
    sendMessage(
      buildMessage<{ operationId: string }>('execution:abort', { operationId: runOperationId }),
    );
  }, [runOperationId, sendMessage]);

  const handleAnswerApproval = useCallback(
    (stepId: string, decision: 'approved' | 'rejected') => {
      if (!runOperationId) return;
      sendMessage(
        buildMessage<{ operationId: string; stepId: string; decision: 'approved' | 'rejected' }>(
          'pipeline:approval',
          { operationId: runOperationId, stepId, decision },
        ),
      );
    },
    [runOperationId, sendMessage],
  );

  // Derive history from bridge query
  const historyEntries = historyQuery.data?.history ?? [];

  // Derive saved pipelines from bridge query
  const savedPipelines = useMemo(() => pipelinesQuery.data?.pipelines ?? [], [pipelinesQuery.data]);
  const allTriggerStatuses = useMemo(
    () => pipelinesQuery.data?.triggers ?? [],
    [pipelinesQuery.data],
  );

  // A run a trigger started answers no request of this page: when one ends,
  // the history and the trigger statuses are asked for again.
  const refetchPipelines = pipelinesQuery.refetch;
  const refetchHistory = historyQuery.refetch;
  const settleTriggeredRun = useCallback(
    (message: OperationCompleted | OperationFailed) => {
      if (!isTriggeredRun(message.payload?.operationId ?? '')) return;
      refetchHistory();
      refetchPipelines();
    },
    [refetchHistory, refetchPipelines],
  );
  useMessageListener<OperationCompleted>('operation:completed', settleTriggeredRun);
  useMessageListener<OperationFailed>('operation:failed', settleTriggeredRun);

  // And once the soonest planned start is past: see nextTriggerRefreshDelay.
  useEffect(() => {
    const delay = nextTriggerRefreshDelay(allTriggerStatuses, Date.now());
    if (delay === undefined) return undefined;
    const timer = setTimeout(() => {
      refetchHistory();
      refetchPipelines();
    }, delay);
    return () => clearTimeout(timer);
  }, [allTriggerStatuses, refetchHistory, refetchPipelines]);

  // What keeps the current pipeline from running. The extension refuses such
  // a pipeline before its first step; the page says so before Run is pressed.
  // An org a step names has to be one connected here.
  const orgs = useOrgStore((s) => s.orgs);
  const orgIds = useMemo(() => new Set(orgs.map((org) => org.id)), [orgs]);
  const sandboxes = useMemo<TriggerSandbox[]>(
    () =>
      orgs
        .filter((org) => org.orgType === 'Sandbox')
        .map((org) => ({ id: org.id, alias: orgDisplayName(org) })),
    [orgs],
  );
  const declaredVariables = useMemo(
    () => new Set((pipeline?.variables ?? []).map((variable) => variable.name)),
    [pipeline],
  );
  // The pipeline as last saved: a Rewind step is confirmed for its saved
  // configuration alone, and asked about only once saved.
  const savedSteps = pipeline
    ? savedPipelines.find((saved) => saved.id === pipeline.id)?.steps
    : undefined;
  const savedId = savedSteps !== undefined ? pipeline?.id : undefined;
  const hasRewind = pipeline?.steps.some((step) => step.type === 'rewind') ?? false;
  const rewindStepsQuery = useBridgeQuery<{
    pipelineId: string;
    steps: PipelineRewindStepInfo[];
  }>('pipeline:rewind-steps', savedId ? { pipelineId: savedId } : undefined, {
    skip: savedId === undefined || !hasRewind,
  });
  const rewindSteps =
    savedId !== undefined && rewindStepsQuery.data?.pipelineId === savedId
      ? rewindStepsQuery.data.steps
      : undefined;
  const refetchRewindSteps = rewindStepsQuery.refetch;

  const grantMutation =
    useBridgeMutation<PipelineRewindGrantResponse['payload']>('pipeline:rewind-grant');
  const revokeMutation = useBridgeMutation<{ revoked: boolean }>('pipeline:rewind-revoke');
  const handleConfirmRewind = useCallback(
    (stepId: string, typed: string) => {
      if (!savedId) return;
      grantMutation.mutate({ pipelineId: savedId, stepId, typed });
    },
    [savedId, grantMutation],
  );
  const handleRevokeRewind = useCallback(
    (stepId: string) => {
      if (!savedId) return;
      revokeMutation.mutate({ pipelineId: savedId, stepId });
    },
    [savedId, revokeMutation],
  );
  // What the extension sees of the Rewind steps changes with each answer.
  useEffect(() => {
    if (grantMutation.data?.granted || revokeMutation.data) refetchRewindSteps();
  }, [grantMutation.data, revokeMutation.data, refetchRewindSteps]);

  const tierOf = useCallback(
    (orgId: string) => {
      const org = orgs.find((candidate) => candidate.id === orgId);
      return org ? guardTierOf(org) : undefined;
    },
    [orgs],
  );
  // What a step of the current pipeline is checked against beside itself. A
  // Rewind step of a pipeline never saved is confirmed for nothing, and one
  // of a saved pipeline counts as unconfirmed until the extension has said.
  const stepAround = useMemo<Omit<StepPlace, 'steps' | 'index'>>(
    () => ({
      declared: declaredVariables,
      ...(syncConfigs ? { syncConfigs } : {}),
      ...(seedTemplates ? { seedTemplates } : {}),
      ...(maskingTemplates ? { maskingTemplates } : {}),
      ...(savedSteps ? { savedSteps } : {}),
      rewindSteps: rewindSteps ?? [],
      tierOf,
    }),
    [
      declaredVariables,
      syncConfigs,
      seedTemplates,
      maskingTemplates,
      savedSteps,
      rewindSteps,
      tierOf,
    ],
  );
  const runBlockers = useMemo(
    () => (pipeline ? blockedSteps(pipeline.steps, orgIds, stepAround) : []),
    [pipeline, orgIds, stepAround],
  );

  // The execution view while running: each step as the host last reported
  // it, pending until it starts.
  const executionData = useMemo<PipelineExecutionData | undefined>(() => {
    if (!isRunning || !pipeline) return undefined;
    const steps = pipeline.steps.map((s) => {
      const update = stepUpdates[s.id];
      return {
        stepId: s.id,
        stepName: s.name,
        stepType: s.type,
        status: update?.status ?? ('pending' as const),
        duration: update?.duration ?? 0,
        ...(update?.summary !== undefined ? { summary: update.summary } : {}),
        ...(update?.error !== undefined ? { error: update.error } : {}),
        // An Approval step that waits, until the host says it has ended.
        ...(update?.status === 'running' && update.approval
          ? { awaitingApproval: update.approval }
          : {}),
      };
    });
    const ended = steps.filter(
      (s) =>
        s.status === 'completed' ||
        s.status === 'failed' ||
        s.status === 'skipped' ||
        s.status === 'stopped',
    ).length;
    const lastHeard = Math.max(runStartedAt, ...Object.values(stepUpdates).map((u) => u.at));
    return {
      runId: runOperationId ?? pipeline.id,
      pipelineName: pipeline.name,
      status: 'running',
      steps,
      startTime: new Date(runStartedAt || Date.now()).toISOString(),
      elapsed: runStartedAt > 0 ? Math.round((lastHeard - runStartedAt) / 1000) : 0,
      progress: steps.length > 0 ? Math.round((ended / steps.length) * 100) : 0,
    };
  }, [isRunning, pipeline, stepUpdates, runStartedAt, runOperationId]);

  // A delete refused for a run that holds the pipeline is said in the
  // reader's language, naming it; any other refusal as the extension wrote it.
  const deleteError =
    deleteMutation.error === null
      ? null
      : deleteMutation.errorCode === 'PIPELINE_RUNNING'
        ? t('automation.lifecycle.deleteRunning', { name: deleting?.name ?? '' })
        : deleteMutation.error;

  // Show error notifications from bridge hooks
  useEffect(() => {
    const bridgeError =
      pipelinesQuery.error ??
      executeMutation.error ??
      saveMutation.error ??
      deleteError ??
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
      });
    }
  }, [
    pipelinesQuery.error,
    executeMutation.error,
    saveMutation.error,
    deleteError,
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
    // The saved list, and what the triggers of the pipeline now do: a
    // schedule is planned by the save. And its Rewind steps, whose
    // confirmations a save that changes them takes back.
    refetchPipelines();
    refetchRewindSteps();
  }, [saveMutation.data, announceSaved, refetchPipelines, refetchRewindSteps]);

  // A delete is said once the extension has done it, as a save is. The
  // pipeline leaves the canvas too when it was the one there: its Delete was
  // asked for by name, and a Save would only write it back.
  const settleDeleted = useLatestRef((answer: PipelineDeleteResponse['payload']) => {
    refetchPipelines();
    if (pipeline?.id === answer.id) {
      setPipeline(undefined);
      setSelectedStepId('');
    }
    addNotification({
      level: 'success',
      title: t('automation.title'),
      message: t('automation.lifecycle.deleted', {
        name: deleting?.id === answer.id ? deleting.name : answer.id,
      }),
      autoDismissMs: 3000,
    });
  });
  useEffect(() => {
    if (!deleteMutation.data) return;
    settleDeleted.current(deleteMutation.data);
  }, [deleteMutation.data, settleDeleted]);

  // The host writes a run to its history when the run ends, but answers
  // `pipeline:history` only on request, and the query fires once on mount:
  // without asking again, the History tab and its count missed every run made
  // since the page opened. A completed or failed run both answer on
  // `pipeline:run:response`; a run that throws is not written, so there is
  // nothing new to fetch.
  //
  // A failed run is also said here. It used to reach only the History tab, as
  // a red badge and an error count, with no word of what went wrong. So is a
  // stopped one, as news and not as an error: the view of the run closed with
  // nothing said, and only the History tab knew how far it got.
  const settleRun = useLatestRef((run: Record<string, unknown>) => {
    historyQuery.refetch();
    if (run.status === 'cancelled') {
      addNotification({
        level: 'info',
        title: t('automation.title'),
        message: runStoppedMessage(t, run),
      });
      return;
    }
    if (run.status !== 'failed') return;
    const message = runFailureMessage(t, run);
    if (message === undefined) return;
    setError(message);
    addNotification({
      level: 'error',
      title: t('automation.title'),
      message,
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
  //
  // What the draft leaves out comes as codes beside it — work that writes to
  // an org, which a pipeline never runs, and the page that runs it — and is
  // said next to the draft in the reader's language. A request that drew no
  // step at all is answered by them alone, in place of the host's English.
  const adoptGenerated = useLatestRef((generated: NonNullable<typeof pipelineGen.data>) => {
    // A draft the user stopped is no failure to tell, and there is no draft.
    if (generated.code === 'CANCELLED') return;
    const suggestions = toDraftSuggestions(generated.suggestions);
    if (!generated.success || !generated.pipeline) {
      const message =
        suggestions.length > 0
          ? suggestions.map((suggestion) => draftSuggestionText(t, suggestion)).join(' ')
          : (generated.error ?? t('ai.error.unknown'));
      setError(message);
      addNotification({
        level: 'error',
        title: t('automation.title'),
        message,
      });
      return;
    }
    const { pipeline: adopted, leftOut } = toPipelineDefinition(
      generated.pipeline,
      t('automation.newPipeline'),
    );
    // A step type no release has, which the host would have left out itself,
    // is named beside the draft as the host names one.
    const named = new Set(
      suggestions.flatMap((suggestion) =>
        suggestion.code === 'STEP_NOT_RUNNABLE' ? [suggestion.stepType] : [],
      ),
    );
    const leftOutSuggestions: PipelineDraftSuggestion[] = leftOut
      .filter((stepType) => !named.has(stepType))
      .map((stepType) => ({ code: 'STEP_NOT_RUNNABLE', stepType }));
    setPipeline(adopted);
    setDraft({ pipelineId: adopted.id, suggestions: [...suggestions, ...leftOutSuggestions] });
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
      });
      return;
    }
    setPipeline(toPipelineDefinition(installed.pipeline, t('automation.newPipeline')).pipeline);
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

  /** A pipeline with nothing in it yet, under a name no saved pipeline has. */
  const emptyPipeline = (): PipelineDefinition => ({
    id: crypto.randomUUID(),
    name: newPipelineName(
      savedPipelines.map((saved) => saved.name),
      t,
    ),
    description: '',
    version: 1,
    steps: [],
    triggers: [],
    variables: [],
    tags: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const unsavedChanges = hasUnsavedChanges(pipeline, savedPipelines);
  const [pendingSwitch, setPendingSwitch] = useState<PipelineSwitch | null>(null);
  const [showGenPrompt, setShowGenPrompt] = useState(false);
  const [genDescription, setGenDescription] = useState('');

  const applySwitch = (next: PipelineSwitch): void => {
    switch (next.kind) {
      case 'new':
        setPipeline(emptyPipeline());
        setSelectedStepId('');
        return;
      case 'open':
        setPipeline(next.pipeline);
        setSelectedStepId('');
        setActiveTab('canvas');
        return;
      case 'install':
        installMutation.mutate({ templateId: next.templateId });
        return;
      case 'generate':
        setShowGenPrompt(true);
        return;
    }
  };

  // Compared by id with the saved pipelines: a pipeline opened, renamed or
  // edited asks before anything takes its place; one as saved does not.
  const requestSwitch = (next: PipelineSwitch): void => {
    if (unsavedChanges) setPendingSwitch(next);
    else applySwitch(next);
  };

  const handleConfirmDiscard = () => {
    const next = pendingSwitch;
    setPendingSwitch(null);
    if (next) applySwitch(next);
  };

  const handleKeepEditing = () => {
    setPendingSwitch(null);
  };

  const handleCreatePipeline = () => {
    requestSwitch({ kind: 'new' });
  };

  const handleRenamePipeline = (name: string) => {
    if (!pipeline) return;
    setPipeline({ ...pipeline, name, updatedAt: new Date().toISOString() });
  };

  const handleDeletePipeline = (target: PipelineDefinition) => {
    setDeleting({ id: target.id, name: target.name });
    deleteMutation.mutate({ id: target.id });
  };

  const handleRunPipeline = () => {
    // The Run button is disabled on the same condition; this keeps any other
    // caller from sending a pipeline the extension would refuse.
    if (!pipeline || runBlockers.length > 0) return;
    setError(null);
    setStepUpdates({});
    setRunStartedAt(Date.now());
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
    requestSwitch({ kind: 'open', pipeline: p });
  };

  const handleInstallTemplate = (tpl: { id: string; name: string; description: string }) => {
    requestSwitch({ kind: 'install', templateId: tpl.id });
  };

  // A step picked under Steps before any pipeline is open starts one with it,
  // as Create Pipeline would: the click was dropped without a word, beside a
  // canvas that told the reader to drag the step.
  const handleAddStep = (type: PipelineStepType) => {
    if (paletteBlocker(type) !== undefined) return;
    const current = pipeline ?? emptyPipeline();
    const newStep = {
      id: crypto.randomUUID(),
      name: newStepName(
        type,
        current.steps.map((step) => step.name),
        t,
      ),
      type,
      config: {},
      continueOnError: false,
    };
    setPipeline({
      ...current,
      steps: [...current.steps, newStep],
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

  // A trigger added before any pipeline is open starts one with it, as a step
  // does: the Triggers tab says to add one above, and the click was dropped.
  const handleAddTrigger = (type: TriggerType) => {
    const current = pipeline ?? emptyPipeline();
    // A schedule is read in the time zone of the person who writes it: the
    // extension host may run elsewhere, on a remote machine.
    const newTrigger: PipelineTrigger = {
      id: crypto.randomUUID(),
      type,
      enabled: true,
      config: type === 'schedule' ? { timezone: getLocalTimezone() } : {},
    };
    setPipeline({
      ...current,
      triggers: [...current.triggers, newTrigger],
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

  const handleUpdateTriggerConfig = (triggerId: string, config: Partial<TriggerConfig>) => {
    if (!pipeline) return;
    setPipeline({
      ...pipeline,
      triggers: pipeline.triggers.map((tr) =>
        tr.id === triggerId ? { ...tr, config: { ...tr.config, ...config } } : tr,
      ),
      updatedAt: new Date().toISOString(),
    });
  };

  const handleGeneratePipeline = () => {
    requestSwitch({ kind: 'generate' });
  };

  const handleGenSubmit = () => {
    if (genDescription.trim()) {
      pipelineGen.mutate({ description: genDescription.trim() });
      setGenDescription('');
    }
    setShowGenPrompt(false);
  };

  const triggerStatuses = useMemo(
    () =>
      pipeline ? allTriggerStatuses.filter((status) => status.pipelineId === pipeline.id) : [],
    [allTriggerStatuses, pipeline],
  );
  const savedTriggers = pipeline
    ? savedPipelines.find((saved) => saved.id === pipeline.id)?.triggers
    : undefined;
  const pipelineSchedules = useMemo<PipelineScheduleRow[]>(
    () =>
      savedPipelines.flatMap((saved) =>
        (Array.isArray(saved.triggers) ? saved.triggers : [])
          .filter((trigger) => trigger.type === 'schedule')
          .map((trigger) => ({
            pipelineId: saved.id,
            pipelineName: saved.name,
            trigger,
            status: allTriggerStatuses.find(
              (status) => status.pipelineId === saved.id && status.triggerId === trigger.id,
            ),
          })),
      ),
    [savedPipelines, allTriggerStatuses],
  );

  const stepCount = pipeline?.steps.length ?? 0;
  // The triggers that start the pipeline: a schedule or a sandbox refresh,
  // switched on. It counted every trigger, the ones switched off and the ones
  // that start nothing too, and read 3 for a pipeline one trigger starts.
  const triggerCount =
    pipeline?.triggers.filter(
      (trigger) =>
        trigger.enabled && (trigger.type === 'schedule' || trigger.type === 'sandbox_refresh'),
    ).length ?? 0;
  const historyCount = historyEntries.length;

  return {
    pipeline,
    error,
    clearError: () => setError(null),
    isRunning,
    pipelinesLoading: pipelinesQuery.loading && pipelinesQuery.data === null,
    savedPipelines,
    syncConfigs,
    seedTemplates,
    maskingTemplates,
    rewindSteps,
    savedSteps,
    handleConfirmRewind,
    handleRevokeRewind,
    rewindGrantAnswer: grantMutation.data,
    rewindGrantPending: grantMutation.loading,
    stepAround,
    declaredVariables,
    triggerStatuses,
    savedTriggers,
    sandboxes,
    pipelineSchedules,
    historyEntries,
    executionData,
    savingPipeline: saveMutation.loading,
    marketplaceLoading: marketplaceList.loading,
    marketplaceError: marketplaceList.error,
    marketplaceTemplates: marketplaceList.data?.templates ?? [],
    pipelineGen,
    draftSuggestions: draft && draft.pipelineId === pipeline?.id ? draft.suggestions : [],
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
    unsavedChanges,
    pendingSwitch,
    handleConfirmDiscard,
    handleKeepEditing,
    handleRenamePipeline,
    handleDeletePipeline,
    deletingPipelineId: deleteMutation.loading ? deleting?.id : undefined,
    handleRunPipeline,
    handleCancelRun,
    handleAnswerApproval,
    handleSavePipeline,
    handleLoadPipeline,
    handleInstallTemplate,
    handleAddStep,
    handleRemoveStep,
    handleUpdateStep,
    handleAddTrigger,
    handleRemoveTrigger,
    handleToggleTrigger,
    handleUpdateTriggerConfig,
    handleGeneratePipeline,
    handleGenSubmit,
  };
}
