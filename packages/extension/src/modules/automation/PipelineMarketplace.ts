import { BUILTIN_PIPELINE_TEMPLATES } from '@sandforge/shared';
import type { PipelineTemplate, TemplateCategory, TemplateStep } from '@sandforge/shared';

export type { PipelineTemplate } from '@sandforge/shared';

/**
 * Built-in templates shipped with the marketplace: kept beside the page, which
 * holds each card to the checks a pipeline's steps pass before a run.
 */
const BUILTIN_TEMPLATES: readonly PipelineTemplate[] = BUILTIN_PIPELINE_TEMPLATES;

/**
 * Generates a RFC4122 v4 UUID via the platform crypto primitive.
 * Used internally to assign unique identifiers to imported templates.
 */
function generateId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Provides a marketplace of reusable pipeline templates.
 * Ships with the built-in templates and supports importing, exporting,
 * searching, and filtering templates by category.
 */
export class PipelineMarketplace {
  private readonly templates: Map<string, PipelineTemplate>;

  constructor() {
    this.templates = new Map(BUILTIN_TEMPLATES.map((t) => [t.id, t]));
  }

  /**
   * Return all available templates.
   * @returns Array of all pipeline templates
   */
  getTemplates(): PipelineTemplate[] {
    return [...this.templates.values()];
  }

  /**
   * Return templates filtered by category.
   * @param category - The category to filter by
   * @returns Array of templates matching the category
   */
  getByCategory(category: string): PipelineTemplate[] {
    return [...this.templates.values()].filter((t) => t.category === category);
  }

  /**
   * Retrieve a specific template by its ID.
   * @param id - The template ID to look up
   * @returns The template, or undefined if not found
   */
  getById(id: string): PipelineTemplate | undefined {
    return this.templates.get(id);
  }

  /**
   * Import a template from a JSON string.
   * Validates that the JSON contains the required fields and assigns a new ID.
   * @param json - JSON string representing a pipeline template
   * @returns The imported template with a fresh ID
   * @throws Error if the JSON is invalid or missing required fields
   */
  importTemplate(json: string): PipelineTemplate {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error(
        'Invalid JSON format: the template file could not be parsed as JSON. Check the file for syntax errors.',
      );
    }

    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('Template must be a JSON object');
    }

    const obj = parsed as Record<string, unknown>;

    if (typeof obj['name'] !== 'string' || !obj['name']) {
      throw new Error('Template must have a non-empty "name" string');
    }

    if (typeof obj['description'] !== 'string') {
      throw new Error('Template must have a "description" string');
    }

    const validCategories: TemplateCategory[] = [
      'environment',
      'migration',
      'maintenance',
      'compliance',
      'monitoring',
    ];
    if (!validCategories.includes(obj['category'] as TemplateCategory)) {
      throw new Error(`Template "category" must be one of: ${validCategories.join(', ')}`);
    }

    if (!Array.isArray(obj['steps']) || obj['steps'].length === 0) {
      throw new Error('Template must have at least one step');
    }

    const template: PipelineTemplate = {
      id: generateId(),
      name: obj['name'] as string,
      description: obj['description'] as string,
      category: obj['category'] as TemplateCategory,
      rating: typeof obj['rating'] === 'number' ? obj['rating'] : 0,
      steps: (obj['steps'] as TemplateStep[]).map((step) => ({
        name: String(step.name ?? ''),
        type: String(step.type ?? ''),
        config: (step.config as Record<string, unknown>) ?? {},
        ...(typeof step.condition === 'object' && step.condition !== null
          ? { condition: step.condition }
          : {}),
        description: String(step.description ?? ''),
      })),
      tags: Array.isArray(obj['tags']) ? (obj['tags'] as string[]).map(String) : [],
    };

    this.templates.set(template.id, template);
    return template;
  }

  /**
   * Export a template as a JSON string.
   * @param id - The ID of the template to export
   * @returns JSON string representation of the template
   * @throws Error if the template is not found
   */
  exportTemplate(id: string): string {
    const template = this.templates.get(id);
    if (!template) {
      throw new Error(`Template not found: ${id}`);
    }
    return JSON.stringify(template, null, 2);
  }

  /**
   * Search templates by matching the query against name, description, and tags.
   * The search is case-insensitive.
   * @param query - The search term
   * @returns Array of templates matching the query
   */
  search(query: string): PipelineTemplate[] {
    const lowerQuery = query.toLowerCase();
    return [...this.templates.values()].filter((t) => {
      const nameMatch = t.name.toLowerCase().includes(lowerQuery);
      const descMatch = t.description.toLowerCase().includes(lowerQuery);
      const tagMatch = t.tags.some((tag) => tag.toLowerCase().includes(lowerQuery));
      return nameMatch || descMatch || tagMatch;
    });
  }
}
