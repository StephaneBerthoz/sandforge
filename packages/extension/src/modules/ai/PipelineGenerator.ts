import {
  PipelineDraftReplySchema,
  parseModelJson,
  type PipelineDraftSuggestion,
  type PipelineStepType,
  type PipelineWritePage,
} from '@sandforge/shared';
import type { AIProvider } from './types.js';

/** Salesforce org metadata. */
export interface OrgInfo {
  orgId: string;
  alias: string;
  type: 'production' | 'sandbox' | 'developer' | 'scratch';
}

/** A single step in a generated pipeline. */
export interface GeneratedPipelineStep {
  name: string;
  type: string;
  config: Record<string, unknown>;
  description: string;
}

/** A complete pipeline generated from natural language. */
export interface GeneratedPipeline {
  name: string;
  description: string;
  steps: GeneratedPipelineStep[];
  schedule?: string;
  triggers?: string[];
  /**
   * What the draft leaves out and where to do it instead: the work it was
   * asked for that writes to an org, or a step type a pipeline cannot run.
   * Codes, which the page words in the reader's language.
   */
  suggestions?: PipelineDraftSuggestion[];
}

/**
 * The step types a pipeline runs: Delay and Condition, and Backup, Compare,
 * Pre-check and Notification through the modules that own their work. The
 * step executor refuses every other type before the run starts, and the
 * Automation page shows such a step blocked.
 */
const RUNNABLE_STEP_TYPES: ReadonlySet<string> = new Set<PipelineStepType>([
  'delay',
  'condition',
  'backup',
  'compare',
  'precheck',
  'notification',
]);

/**
 * Keywords mapped to the step types a pipeline runs. "backup" used to draw a
 * DataOps step and "monitor" a Monitor step, neither of which a pipeline
 * runs: "back up accounts daily" gave a blocked step although Backup runs.
 */
const KEYWORD_STEP_MAP: Record<string, PipelineStepType> = {
  backup: 'backup',
  snapshot: 'backup',
  export: 'backup',
  compare: 'compare',
  diff: 'compare',
  check: 'precheck',
  monitor: 'precheck',
  watch: 'precheck',
  alert: 'notification',
  notify: 'notification',
};

/**
 * Keywords for the work that writes to an org, mapped to the page that runs
 * it. A pipeline runs unattended, with nobody there to answer Production
 * Guard, so it runs no step that writes: such a wish draws no step, and a
 * suggestion to run it from its page.
 */
const WRITE_KEYWORD_PAGE: Record<string, PipelineWritePage> = {
  sync: 'sync',
  synchronize: 'sync',
  copy: 'sync',
  transfer: 'sync',
  migrate: 'sync',
  seed: 'seed',
  generate: 'seed',
  create: 'seed',
  populate: 'seed',
  anonymize: 'dataops',
  mask: 'dataops',
  scramble: 'dataops',
  delete: 'dataops',
  clean: 'dataops',
  purge: 'dataops',
};

/** The page that runs the work a step type that writes to an org stands for. */
const WRITE_STEP_PAGE: Record<string, PipelineWritePage> = {
  sync: 'sync',
  seed: 'seed',
  restore: 'dataops',
  anonymize: 'dataops',
  delete: 'dataops',
  dataops: 'dataops',
};

/** A page's name as the English of the host's log says it. */
const PAGE_NAME: Record<PipelineWritePage, string> = {
  sync: 'Sync',
  seed: 'Seed',
  dataops: 'DataOps',
};

/**
 * A suggestion in English, for the host's log and the `error` of a request
 * that drew no step: the page words the code itself.
 */
export function suggestionText(suggestion: PipelineDraftSuggestion): string {
  if (suggestion.code === 'STEP_NOT_RUNNABLE') {
    return `A pipeline cannot run a ${suggestion.stepType} step, so the draft leaves it out.`;
  }
  const page = PAGE_NAME[suggestion.page];
  return `A pipeline runs no step that writes to an org, so it cannot run ${page}: run it from the ${page} page, where Production Guard can stop or ask first.`;
}

/** Schedule keywords mapped to cron-like expressions. */
const SCHEDULE_KEYWORDS: Record<string, string> = {
  daily: '0 0 * * *',
  weekly: '0 0 * * 1',
  hourly: '0 * * * *',
  nightly: '0 2 * * *',
  'every morning': '0 8 * * *',
  'every evening': '0 18 * * *',
};

/**
 * The trigger types a draft may hold: those that start runs. Manual runs from
 * the Run button, and the extension fires a schedule and a sandbox refresh
 * trigger. An event, webhook or deployment trigger starts nothing: a draft
 * holding one offered a trigger that would never fire.
 */
const DRAFT_TRIGGERS = ['manual', 'schedule', 'sandbox_refresh'] as const;

/** A trigger type a draft may hold (see {@link DRAFT_TRIGGERS}). */
type DraftTrigger = (typeof DRAFT_TRIGGERS)[number];

/** Whether a trigger named by the model is one a draft may hold. */
function isDraftTrigger(trigger: string): trigger is DraftTrigger {
  return (DRAFT_TRIGGERS as readonly string[]).includes(trigger);
}

/**
 * Generates ETL pipelines from natural language descriptions
 * by parsing keywords and resolving org references.
 */
export class PipelineGenerator {
  private readonly provider: AIProvider;

  /**
   * @param provider - AI provider for generating pipeline definitions
   */
  constructor(provider: AIProvider) {
    this.provider = provider;
  }

  /**
   * Generate a pipeline from a natural language description.
   * Parses the description for known keywords and org aliases,
   * then enriches with AI if the description is complex.
   * @param description - Natural language pipeline description
   * @param availableOrgs - List of available Salesforce orgs
   * @returns A generated pipeline with resolved steps
   */
  async generatePipeline(
    description: string,
    availableOrgs: OrgInfo[],
  ): Promise<GeneratedPipeline> {
    // "back up" is read as the one word the keyword map knows.
    const normalizedDesc = description.toLowerCase().replace(/\bback\s+up\b/g, 'backup');
    const steps = this.extractSteps(normalizedDesc, availableOrgs);
    const suggestions = this.writeSuggestions(normalizedDesc);
    const schedule = this.extractSchedule(normalizedDesc);
    const triggers = this.extractTriggers(normalizedDesc);

    // Work that writes to an org is answered with where to run it, not handed
    // to the model, whose draft would hold the same step a pipeline refuses.
    if (steps.length > 0 || suggestions.length > 0) {
      return {
        name: this.generatePipelineName(description),
        description,
        steps,
        schedule: schedule ?? undefined,
        triggers: triggers.length > 0 ? triggers : undefined,
        suggestions: suggestions.length > 0 ? suggestions : undefined,
      };
    }

    return this.generateWithAI(description, availableOrgs);
  }

  private extractSteps(normalizedDesc: string, availableOrgs: OrgInfo[]): GeneratedPipelineStep[] {
    const steps: GeneratedPipelineStep[] = [];
    const detectedTypes = new Set<string>();

    for (const word of this.words(normalizedDesc)) {
      const stepType = KEYWORD_STEP_MAP[word];
      if (stepType && !detectedTypes.has(stepType)) {
        detectedTypes.add(stepType);
        const config = this.buildStepConfig(stepType, normalizedDesc, availableOrgs);
        steps.push({
          name: `${stepType}_step`,
          type: stepType,
          config,
          description: `${stepType.charAt(0).toUpperCase()}${stepType.slice(1)} operation extracted from description.`,
        });
      }
    }

    return steps;
  }

  /** One suggestion per page that runs the writing work the description asks for. */
  private writeSuggestions(normalizedDesc: string): PipelineDraftSuggestion[] {
    const pages = new Set<PipelineWritePage>();
    for (const word of this.words(normalizedDesc)) {
      const page = WRITE_KEYWORD_PAGE[word];
      if (page) pages.add(page);
    }
    return [...pages].map((page) => ({ code: 'WRITES_TO_ORG', page }));
  }

  /** The words of a description, without the punctuation around them. */
  private words(normalizedDesc: string): string[] {
    return normalizedDesc.split(/[^a-z0-9_-]+/).filter((word) => word.length > 0);
  }

  /**
   * The configuration a step reads: org ids under the keys the step's own
   * check reads (`orgId`, or `sourceOrgId` and `targetOrgId` for Compare), and
   * the objects a backup takes. A step left without them shows on the page as
   * needing them.
   */
  private buildStepConfig(
    stepType: PipelineStepType,
    description: string,
    availableOrgs: OrgInfo[],
  ): Record<string, unknown> {
    const config: Record<string, unknown> = {};

    const matchedOrgs = availableOrgs.filter(
      (org) =>
        description.includes(org.alias.toLowerCase()) ||
        description.includes(org.orgId.toLowerCase()),
    );

    if (stepType === 'compare') {
      if (matchedOrgs.length >= 2) {
        config['sourceOrgId'] = matchedOrgs[0].orgId;
        config['targetOrgId'] = matchedOrgs[1].orgId;
      }
      return config;
    }
    if (stepType === 'notification') return config;

    if (matchedOrgs.length >= 1) {
      config['orgId'] = matchedOrgs[0].orgId;
    }
    if (stepType === 'backup') {
      const sfObjects = this.extractSalesforceObjects(description);
      if (sfObjects.length > 0) {
        config['objects'] = sfObjects;
      }
    }

    return config;
  }

  private extractSalesforceObjects(description: string): string[] {
    const commonObjects = [
      'account',
      'contact',
      'lead',
      'opportunity',
      'case',
      'task',
      'event',
      'user',
      'campaign',
      'product',
      'order',
      'contract',
      'asset',
      'solution',
    ];

    return commonObjects
      .filter((obj) => description.includes(obj))
      .map((obj) => `${obj.charAt(0).toUpperCase()}${obj.slice(1)}`);
  }

  private extractSchedule(description: string): string | null {
    for (const [keyword, cron] of Object.entries(SCHEDULE_KEYWORDS)) {
      if (description.includes(keyword)) {
        return cron;
      }
    }
    return null;
  }

  private extractTriggers(description: string): string[] {
    const triggers: string[] = [];
    // A sandbox refresh trigger starts the pipeline once the page names the
    // sandbox. The draft cannot know which one: it arrives naming none, and
    // the page asks for it, and says the trigger starts nothing until then.
    //
    // A deployment, an error or a change starts nothing, so a wish for one
    // draws no trigger. "on deploy" used to draw a Deployment Complete
    // trigger, which nothing fires, and "on error" and "on change" strings
    // that name no trigger type at all, which the page dropped. No trigger
    // that starts runs fits them: a schedule fires on the clock, a refresh
    // trigger on a sandbox refresh, neither on a deployment.
    const triggerKeywords: Record<string, DraftTrigger> = {
      'on refresh': 'sandbox_refresh',
      'after refresh': 'sandbox_refresh',
    };

    for (const [keyword, trigger] of Object.entries(triggerKeywords)) {
      if (description.includes(keyword)) {
        triggers.push(trigger);
      }
    }

    return triggers;
  }

  private generatePipelineName(description: string): string {
    const words = description.split(/\s+/).slice(0, 5);
    const name = words
      .map((w) => `${w.charAt(0).toUpperCase()}${w.slice(1).toLowerCase()}`)
      .join('');
    return `Pipeline_${name}`;
  }

  private async generateWithAI(
    description: string,
    availableOrgs: OrgInfo[],
  ): Promise<GeneratedPipeline> {
    const orgList = availableOrgs.map((o) => `${o.alias} (${o.type}, ID: ${o.orgId})`).join('\n');

    const prompt = `Generate a SandForge pipeline from this description:\n"${description}"\n\nAvailable orgs:\n${orgList}\n\nReturn JSON with: name, description, steps (array of {name, type, config, description}), schedule (optional cron), triggers (optional array).`;

    const response = await this.provider(prompt);

    try {
      const draft = parseModelJson(PipelineDraftReplySchema, response);
      // A step the model names that a pipeline cannot run is left out, with a
      // word of where its work runs instead: kept, it reached the canvas as a
      // step that blocked the whole pipeline.
      const steps = draft.steps.filter((step) => RUNNABLE_STEP_TYPES.has(step.type));
      // One per page, and one per step type that has none.
      const suggestions = new Map<string, PipelineDraftSuggestion>();
      for (const step of draft.steps) {
        if (RUNNABLE_STEP_TYPES.has(step.type)) continue;
        const page = WRITE_STEP_PAGE[step.type];
        const suggestion: PipelineDraftSuggestion = page
          ? { code: 'WRITES_TO_ORG', page }
          : { code: 'STEP_NOT_RUNNABLE', stepType: step.type };
        suggestions.set(JSON.stringify(suggestion), suggestion);
      }
      return {
        name: draft.name ?? `Pipeline_${Date.now()}`,
        description: draft.description ?? description,
        steps,
        schedule: draft.schedule,
        // A sandbox_refresh trigger the model names arrives naming no sandbox,
        // as the keyword path's does, for the page to ask for one. A trigger
        // that starts nothing is left out, whatever the model calls it.
        triggers: draft.triggers?.filter(isDraftTrigger),
        ...(suggestions.size > 0 ? { suggestions: [...suggestions.values()] } : {}),
      };
    } catch {
      // A reply that is not a pipeline object leaves a draft with no step,
      // which the handler refuses to load.
    }

    return {
      name: `Pipeline_${Date.now()}`,
      description,
      steps: [],
    };
  }
}
