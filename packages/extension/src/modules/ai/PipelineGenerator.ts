import type { AIProvider } from './SmartSuggestions';

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
}

/** Keywords mapped to pipeline step types. */
const KEYWORD_STEP_MAP: Record<string, string> = {
  sync: 'sync',
  synchronize: 'sync',
  copy: 'sync',
  transfer: 'sync',
  migrate: 'sync',
  seed: 'seed',
  generate: 'seed',
  create: 'seed',
  populate: 'seed',
  compare: 'compare',
  diff: 'compare',
  check: 'compare',
  anonymize: 'dataops',
  mask: 'dataops',
  scramble: 'dataops',
  delete: 'dataops',
  clean: 'dataops',
  purge: 'dataops',
  monitor: 'monitor',
  watch: 'monitor',
  alert: 'monitor',
  backup: 'dataops',
  export: 'dataops',
};

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
    const normalizedDesc = description.toLowerCase();
    const steps = this.extractSteps(normalizedDesc, availableOrgs);
    const schedule = this.extractSchedule(normalizedDesc);
    const triggers = this.extractTriggers(normalizedDesc);

    if (steps.length > 0) {
      return {
        name: this.generatePipelineName(description),
        description,
        steps,
        schedule: schedule ?? undefined,
        triggers: triggers.length > 0 ? triggers : undefined,
      };
    }

    return this.generateWithAI(description, availableOrgs);
  }

  /**
   * Suggest improvements for an existing pipeline.
   * @param pipeline - The pipeline to analyze
   * @returns Array of improvement suggestions
   */
  async suggestImprovements(pipeline: GeneratedPipeline): Promise<string[]> {
    const suggestions: string[] = [];

    if (pipeline.steps.length === 0) {
      suggestions.push('Pipeline has no steps. Add at least one step to make it functional.');
    }

    const hasSync = pipeline.steps.some((s) => s.type === 'sync');
    const hasCompare = pipeline.steps.some((s) => s.type === 'compare');
    if (hasSync && !hasCompare) {
      suggestions.push('Add a compare step before sync to preview changes and reduce risk.');
    }

    const hasDataops = pipeline.steps.some((s) => s.type === 'dataops');
    if (hasSync && !hasDataops) {
      suggestions.push('Consider adding anonymization for sensitive data in sync operations.');
    }

    if (pipeline.steps.length > 1 && !pipeline.steps.some((s) => s.type === 'monitor')) {
      suggestions.push('Add a monitor step to track pipeline execution and alert on failures.');
    }

    if (!pipeline.schedule) {
      suggestions.push('Consider adding a schedule for automated recurring execution.');
    }

    const prompt = `Analyze this pipeline and suggest improvements:\n${JSON.stringify(pipeline, null, 2)}\nReturn a JSON array of suggestion strings.`;

    try {
      const response = await this.provider(prompt);
      const aiSuggestions: unknown = JSON.parse(response);
      if (Array.isArray(aiSuggestions)) {
        for (const s of aiSuggestions) {
          if (typeof s === 'string') {
            suggestions.push(s);
          }
        }
      }
    } catch {
      // AI suggestions are best-effort; rule-based suggestions are always returned.
    }

    return suggestions;
  }

  private extractSteps(normalizedDesc: string, availableOrgs: OrgInfo[]): GeneratedPipelineStep[] {
    const steps: GeneratedPipelineStep[] = [];
    const words = normalizedDesc.split(/\s+/);
    const detectedTypes = new Set<string>();

    for (const word of words) {
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

  private buildStepConfig(
    stepType: string,
    description: string,
    availableOrgs: OrgInfo[],
  ): Record<string, unknown> {
    const config: Record<string, unknown> = {};

    const matchedOrgs = availableOrgs.filter(
      (org) =>
        description.includes(org.alias.toLowerCase()) ||
        description.includes(org.orgId.toLowerCase()),
    );

    if (stepType === 'sync' && matchedOrgs.length >= 2) {
      config['sourceOrg'] = matchedOrgs[0].alias;
      config['targetOrg'] = matchedOrgs[1].alias;
    } else if (matchedOrgs.length >= 1) {
      config['org'] = matchedOrgs[0].alias;
    }

    const sfObjects = this.extractSalesforceObjects(description);
    if (sfObjects.length > 0) {
      config['objects'] = sfObjects;
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
    const triggerKeywords: Record<string, string> = {
      'on deploy': 'deployment_complete',
      'after deploy': 'deployment_complete',
      'on refresh': 'sandbox_refresh',
      'after refresh': 'sandbox_refresh',
      'on error': 'error_detected',
      'on change': 'metadata_change',
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
      const parsed: unknown = JSON.parse(response);
      if (typeof parsed === 'object' && parsed !== null) {
        const obj = parsed as Record<string, unknown>;
        return {
          name: typeof obj['name'] === 'string' ? obj['name'] : `Pipeline_${Date.now()}`,
          description: typeof obj['description'] === 'string' ? obj['description'] : description,
          steps: Array.isArray(obj['steps']) ? this.validateSteps(obj['steps'] as unknown[]) : [],
          schedule: typeof obj['schedule'] === 'string' ? obj['schedule'] : undefined,
          triggers: Array.isArray(obj['triggers'])
            ? (obj['triggers'] as unknown[]).filter((t): t is string => typeof t === 'string')
            : undefined,
        };
      }
    } catch {
      // Fall through to default pipeline.
    }

    return {
      name: `Pipeline_${Date.now()}`,
      description,
      steps: [],
    };
  }

  private validateSteps(raw: unknown[]): GeneratedPipelineStep[] {
    return raw
      .filter(
        (item): item is Record<string, unknown> =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as Record<string, unknown>)['name'] === 'string' &&
          typeof (item as Record<string, unknown>)['type'] === 'string',
      )
      .map((item) => ({
        name: item['name'] as string,
        type: item['type'] as string,
        config:
          typeof item['config'] === 'object' && item['config'] !== null
            ? (item['config'] as Record<string, unknown>)
            : {},
        description: typeof item['description'] === 'string' ? (item['description'] as string) : '',
      }));
  }
}
