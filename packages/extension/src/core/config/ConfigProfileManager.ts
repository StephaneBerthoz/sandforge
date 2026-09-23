/**
 * Manages export and import of SandForge configuration profiles.
 *
 * A configuration profile is a JSON bundle containing sync mappings,
 * forge plans, pipeline definitions and anonymization templates. Profiles
 * can be shared between team members.
 */

import { z } from 'zod';
import type { ConfigStore } from '../storage/ConfigStore.js';

/** Categories of configuration that can be exported/imported. */
export type ConfigCategory = 'syncMappings' | 'forgePlans' | 'pipelines' | 'anonymizationTemplates';

/**
 * A category profiles listed up to 1.36, which none carries any more.
 *
 * `settings` exported the ConfigStore keys under a `settings:` prefix, and
 * nothing writes any: SandForge's settings are VS Code settings
 * (`sandforge.*`), so every profile carried the category empty. Those are not
 * exported instead. VS Code shares them already, through Settings Sync or a
 * workspace's `.vscode/settings.json`, and some are the user's own consent or
 * safety switches (`sandforge.telemetry`, `sandforge.ai.enabled`,
 * `sandforge.safety.requireProdConfirmation`), which a file received from
 * someone else must not flip. A profile that still lists the category is
 * read, and the category passed over.
 */
const RETIRED_CATEGORY = 'settings';

/** Zod schema for validating imported config profiles. */
export const ConfigProfileSchema = z.object({
  version: z.string(),
  exportedAt: z.string(),
  exportedBy: z.string().optional(),
  categories: z.array(
    z.enum(['syncMappings', 'forgePlans', 'pipelines', 'anonymizationTemplates', RETIRED_CATEGORY]),
  ),
  data: z.record(z.string(), z.unknown()),
});

/** Whether a category a profile lists is one this version exports and imports. */
function isCurrentCategory(category: string): category is ConfigCategory {
  return category !== RETIRED_CATEGORY;
}

/** A validated configuration profile. */
export type ConfigProfile = z.infer<typeof ConfigProfileSchema>;

/** Result of an import operation. */
export interface ImportResult {
  /** Whether the import succeeded. */
  success: boolean;
  /** Number of categories imported. */
  categoriesImported: number;
  /** Number of individual entries imported. */
  entriesImported: number;
  /** Warning messages (e.g. skipped entries). */
  warnings: string[];
  /** Error message if the import failed. */
  error?: string;
}

/** Result of an export operation. */
export interface ExportResult {
  /** Whether the export succeeded. */
  success: boolean;
  /** The exported profile JSON string. */
  json?: string;
  /** Number of categories exported. */
  categoriesExported: number;
  /** Number of individual entries exported. */
  entriesExported: number;
  /** Error message if the export failed. */
  error?: string;
}

/**
 * Internal key prefix to category mapping.
 *
 * A saved pipeline is kept under `pipeline:saved:<id>`, and each of its runs
 * under `pipeline:history:<runId>` (see `AutomationHandler`). The pipelines
 * category used to take every `pipeline:` key, so a profile carried the run
 * history too, and an import wrote each run back into the category the
 * saved pipelines are listed from. Sync mappings and Forge plans did the
 * same: `sync:` took the sync run history (`sync:history:all`) with the
 * saved mappings (`sync:config:<id>`), and `forge:` the Forge run history
 * (`forge:history`) with the saved plans (`forge:templates`).
 */
const CATEGORY_PREFIXES: Record<ConfigCategory, string> = {
  syncMappings: 'sync:config:',
  forgePlans: 'forge:templates',
  pipelines: 'pipeline:saved:',
  anonymizationTemplates: 'anonymization:',
};

/**
 * The ConfigStore category each kind of entry is kept under, which is where
 * the module that owns it lists it from. An import wrote every entry under
 * the profile's name for it: a sync mapping filed under `syncMappings` was
 * there, and missing from Sync's list, which reads `syncConfigs`.
 */
const STORE_CATEGORIES: Record<ConfigCategory, string> = {
  syncMappings: 'syncConfigs',
  forgePlans: 'forge',
  pipelines: 'pipelines',
  anonymizationTemplates: 'anonymizationTemplates',
};

/** The ConfigStore key of the Forge plans, which the forgePlans category exports. */
const FORGE_TEMPLATES_KEY = 'forge:templates';

/**
 * Where a set of Forge plans a profile brought waits for a workspace file.
 *
 * With a folder open, Forge keeps its plans in the workspace's
 * `.sandforge/forge-templates.json`, and read the ConfigStore's
 * `forge:templates` only while that file was empty: an imported set was not
 * listed beside the file's plans. That key cannot simply be merged in either.
 * Every window writes its own list there, so it holds another project's plans
 * as often as imported ones, and a plan deleted from the file would come back
 * from it. The set is left here as well, and the next window that lists its
 * plans merges it into its file once (see `ForgeHandler`).
 */
export const IMPORTED_FORGE_TEMPLATES_KEY = 'forge:imported-templates';

/**
 * Service for exporting and importing SandForge configuration profiles.
 *
 * Reads from and writes to the ConfigStore, grouping entries by category
 * prefix. Validates imports using Zod before applying.
 */
export class ConfigProfileManager {
  /** @param configStore - The configuration store to read/write. */
  constructor(private readonly configStore: ConfigStore) {}

  /**
   * Export selected configuration categories to a JSON profile.
   * @param categories - Which categories to include in the export.
   * @param exportedBy - Optional identifier of the exporter.
   * @returns Export result with JSON string.
   */
  exportProfile(categories: ConfigCategory[], exportedBy?: string): ExportResult {
    try {
      const data: Record<string, unknown> = {};
      let entriesExported = 0;

      for (const category of categories) {
        const prefix = CATEGORY_PREFIXES[category];
        const keys = this.configStore.getKeysByPrefix(prefix);
        const categoryData: Record<string, unknown> = {};

        for (const key of keys) {
          const value = this.configStore.get<unknown>(key);
          if (value !== undefined) {
            categoryData[key] = value;
            entriesExported++;
          }
        }

        data[category] = categoryData;
      }

      const profile: ConfigProfile = {
        version: '1.0.0',
        exportedAt: new Date().toISOString(),
        exportedBy,
        categories,
        data,
      };

      return {
        success: true,
        json: JSON.stringify(profile, null, 2),
        categoriesExported: categories.length,
        entriesExported,
      };
    } catch (err: unknown) {
      return {
        success: false,
        categoriesExported: 0,
        entriesExported: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Import a configuration profile from a JSON string.
   * Validates the profile structure before applying.
   * @param json - The JSON string to import.
   * @param overwrite - Whether to overwrite existing entries (default: true).
   * @returns Import result with statistics and warnings.
   */
  importProfile(json: string, overwrite: boolean = true): ImportResult {
    const warnings: string[] = [];

    try {
      const parsed: unknown = JSON.parse(json);
      const validation = ConfigProfileSchema.safeParse(parsed);

      if (!validation.success) {
        return {
          success: false,
          categoriesImported: 0,
          entriesImported: 0,
          warnings: [],
          error: `Invalid profile format: ${validation.error.issues.map((i) => i.message).join(', ')}`,
        };
      }

      const profile = validation.data;
      const categories = profile.categories.filter(isCurrentCategory);
      let entriesImported = 0;

      for (const category of categories) {
        const categoryData = profile.data[category] as Record<string, unknown> | undefined;
        if (!categoryData || typeof categoryData !== 'object') {
          warnings.push(`Category "${category}" has no data, skipped.`);
          continue;
        }

        const expectedPrefix = CATEGORY_PREFIXES[category];
        for (const [key, value] of Object.entries(categoryData)) {
          if (!key.startsWith(expectedPrefix)) {
            warnings.push(
              `Key "${key}" does not match expected prefix "${expectedPrefix}" for category "${category}", skipped.`,
            );
            continue;
          }
          if (!overwrite && this.configStore.has(key)) {
            warnings.push(`Key "${key}" already exists, skipped.`);
            continue;
          }
          this.configStore.set(key, value, STORE_CATEGORIES[category]);
          if (key === FORGE_TEMPLATES_KEY) {
            this.configStore.set(IMPORTED_FORGE_TEMPLATES_KEY, value, STORE_CATEGORIES[category]);
          }
          entriesImported++;
        }
      }

      return {
        success: true,
        categoriesImported: categories.length,
        entriesImported,
        warnings,
      };
    } catch (err: unknown) {
      return {
        success: false,
        categoriesImported: 0,
        entriesImported: 0,
        warnings,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Validate a JSON string as a config profile without importing.
   * @param json - The JSON to validate.
   * @returns Validation result with parsed categories.
   */
  validateProfile(json: string): { valid: boolean; categories?: ConfigCategory[]; error?: string } {
    try {
      const parsed: unknown = JSON.parse(json);
      const validation = ConfigProfileSchema.safeParse(parsed);

      if (!validation.success) {
        return {
          valid: false,
          error: validation.error.issues.map((i) => i.message).join(', '),
        };
      }

      return {
        valid: true,
        categories: validation.data.categories.filter(isCurrentCategory),
      };
    } catch (err: unknown) {
      return {
        valid: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * List all available configuration categories and their entry count.
   * @returns Map of category name to entry count.
   */
  listCategories(): Array<{ category: ConfigCategory; entryCount: number }> {
    const result: Array<{ category: ConfigCategory; entryCount: number }> = [];

    for (const [category, prefix] of Object.entries(CATEGORY_PREFIXES)) {
      const keys = this.configStore.getKeysByPrefix(prefix);
      result.push({ category: category as ConfigCategory, entryCount: keys.length });
    }

    return result;
  }
}
