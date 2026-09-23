import { z } from 'zod';
import {
  SAVED_TEMPLATE_METHODS,
  TEMPLATE_FIELD_PATTERN,
  TEMPLATE_MAX_RULES,
  TEMPLATE_NAME_MAX_LENGTH,
} from '@sandforge/shared';
import type { ConfigStore } from '../../core/storage/ConfigStore.js';

/** Key prefix for saved masking templates in the config store. */
const TEMPLATE_PREFIX = 'anonymization:template:';

/** Config store category for saved masking templates. */
const TEMPLATE_CATEGORY = 'anonymizationTemplates';

/**
 * A template as it is stored: read back through this schema, so an entry
 * edited by hand or written by another version is left out of the list rather
 * than handed to the masking run.
 */
const savedTemplateSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(TEMPLATE_NAME_MAX_LENGTH),
  description: z.string().max(500),
  complianceFramework: z.literal('custom'),
  rules: z
    .array(
      z.object({
        fieldPattern: z.string().max(170).regex(TEMPLATE_FIELD_PATTERN),
        ruleType: z.enum(SAVED_TEMPLATE_METHODS),
        description: z.string().max(500),
      }),
    )
    .min(1)
    .max(TEMPLATE_MAX_RULES),
  saved: z.literal(true),
  createdAt: z.string(),
});

/** A masking template the user saved, as it is stored and listed. */
export type SavedAnonymizationTemplate = z.infer<typeof savedTemplateSchema>;

/**
 * Persists the masking templates the user saves to ConfigStore.
 *
 * Thin facade over ConfigStore with a dedicated key prefix
 * (`anonymization:template:`) and category (`anonymizationTemplates`), the
 * pattern SyncConfigStore and SyncScheduleStore follow. The templates that ship
 * are not here: they are code, and cannot be deleted.
 */
export class AnonymizationTemplateStore {
  /** @param configStore - The configuration store backend. */
  constructor(private readonly configStore: ConfigStore) {}

  /**
   * Persist a saved template.
   *
   * @param template - The template to save.
   */
  save(template: SavedAnonymizationTemplate): void {
    this.configStore.set(`${TEMPLATE_PREFIX}${template.id}`, template, TEMPLATE_CATEGORY);
  }

  /**
   * Load a saved template by ID.
   *
   * @param id - The template ID.
   * @returns The stored template, or `undefined` if there is none or it does not read as one.
   */
  load(id: string): SavedAnonymizationTemplate | undefined {
    const parsed = savedTemplateSchema.safeParse(this.configStore.get(`${TEMPLATE_PREFIX}${id}`));
    return parsed.success ? parsed.data : undefined;
  }

  /**
   * List the saved templates, oldest first: the order they were saved in.
   *
   * @returns Every stored template that reads as one.
   */
  list(): SavedAnonymizationTemplate[] {
    const templates: SavedAnonymizationTemplate[] = [];
    for (const value of Object.values(this.configStore.getByCategory(TEMPLATE_CATEGORY))) {
      const parsed = savedTemplateSchema.safeParse(value);
      if (parsed.success) templates.push(parsed.data);
    }
    return templates.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * Delete a saved template by ID.
   *
   * @param id - The template ID to delete.
   * @returns `true` if the entry existed and was removed, `false` otherwise.
   */
  delete(id: string): boolean {
    return this.configStore.delete(`${TEMPLATE_PREFIX}${id}`);
  }
}
