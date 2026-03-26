import type { ConfigStore } from '../../core/storage/ConfigStore.js';
import type { SeedTemplate } from '@sandforge/shared';

/** Key prefix for seed template entries in the config store. */
const SEED_TEMPLATE_PREFIX = 'seed:template:';

/** Config store category for seed template data. */
const SEED_TEMPLATE_CATEGORY = 'seedTemplates';

/**
 * Persists seed templates to ConfigStore.
 *
 * Thin facade over ConfigStore with a dedicated key prefix (`seed:template:`)
 * and category (`seedTemplates`). Follows the same pattern as AlertStateStore.
 */
export class SeedTemplateStore {
  /** @param configStore - The configuration store backend. */
  constructor(private readonly configStore: ConfigStore) {}

  /**
   * Persist a seed template.
   *
   * @param template - The seed template to save.
   */
  save(template: SeedTemplate): void {
    this.configStore.set(`${SEED_TEMPLATE_PREFIX}${template.id}`, template, SEED_TEMPLATE_CATEGORY);
  }

  /**
   * Load a seed template by ID.
   *
   * @param id - The template ID.
   * @returns The stored template, or `undefined` if not found.
   */
  load(id: string): SeedTemplate | undefined {
    return this.configStore.get<SeedTemplate>(`${SEED_TEMPLATE_PREFIX}${id}`);
  }

  /**
   * List all persisted seed templates, sorted by `updatedAt` descending.
   *
   * @returns All stored seed templates, newest first.
   */
  list(): SeedTemplate[] {
    const byCategory = this.configStore.getByCategory(SEED_TEMPLATE_CATEGORY);
    const templates = Object.values(byCategory) as SeedTemplate[];
    return templates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /**
   * Delete a seed template by ID.
   *
   * @param id - The template ID to delete.
   * @returns `true` if the entry existed and was removed, `false` otherwise.
   */
  delete(id: string): boolean {
    return this.configStore.delete(`${SEED_TEMPLATE_PREFIX}${id}`);
  }
}
