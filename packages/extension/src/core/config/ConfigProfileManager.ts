/**
 * Manages export and import of SandForge configuration profiles.
 *
 * A configuration profile is a JSON bundle containing sync mappings,
 * forge plans, pipeline definitions and anonymization templates. Profiles
 * can be shared between team members.
 */

import { z } from 'zod';
import type { ForgeTemplate } from '@sandforge/shared';
import type { ConfigStore } from '../storage/ConfigStore.js';
import {
  importedTemplatesFor,
  isTemplateEntry,
  mergeTemplates,
  recordImportedTemplates,
} from './importedForgeTemplates.js';

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

/**
 * The key the forgePlans category carries its templates under: the one entry
 * of the category, holding every template, as the ConfigStore's copy does.
 */
const FORGE_TEMPLATES_KEY = 'forge:templates';

/**
 * The workspace a window keeps its Forge templates in.
 *
 * Forge keeps them in `.sandforge/forge-templates.json` under the window's
 * first folder, and the ConfigStore's `forge:templates` holds those of the
 * windows with no folder open. Every window used to write its list there: a
 * profile exported from it carried whichever window had saved last, another
 * project's templates as often as this one's.
 */
export interface ForgeTemplateWorkspace {
  /** The folder, as VS Code gives its path: an import leaves its templates for it. */
  readonly folder: string;
  /** The templates the folder's file holds. */
  readTemplates(): Promise<readonly ForgeTemplate[]>;
}

/** How a warning names a template: by its name when it has one. */
function templateLabel(template: ForgeTemplate): string {
  return typeof template.name === 'string' && template.name.length > 0
    ? template.name
    : template.id;
}

/**
 * Service for exporting and importing SandForge configuration profiles.
 *
 * Reads from and writes to the ConfigStore, grouping entries by category
 * prefix. Validates imports using Zod before applying. Forge templates are
 * the exception: they are the window's workspace's (see
 * {@link ForgeTemplateWorkspace}), the ConfigStore's only with no folder
 * open, and each template is one entry.
 */
export class ConfigProfileManager {
  /**
   * @param configStore - The configuration store to read/write.
   * @param workspace - Where this window keeps its Forge templates; absent in
   *   a window with no folder open, which keeps them in the ConfigStore.
   */
  constructor(
    private readonly configStore: ConfigStore,
    private readonly workspace?: ForgeTemplateWorkspace,
  ) {}

  /**
   * Export selected configuration categories to a JSON profile.
   * @param categories - Which categories to include in the export.
   * @param exportedBy - Optional identifier of the exporter.
   * @returns Export result with JSON string.
   */
  async exportProfile(categories: ConfigCategory[], exportedBy?: string): Promise<ExportResult> {
    try {
      const data: Record<string, unknown> = {};
      let entriesExported = 0;

      for (const category of categories) {
        if (category === 'forgePlans') {
          const templates = await this.heldTemplates();
          data[category] = templates.length > 0 ? { [FORGE_TEMPLATES_KEY]: templates } : {};
          entriesExported += templates.length;
          continue;
        }
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
  async importProfile(json: string, overwrite: boolean = true): Promise<ImportResult> {
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

        if (category === 'forgePlans') {
          entriesImported += await this.importTemplates(categoryData, overwrite, warnings);
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
   * List all available configuration categories and their entry count: the
   * entries an export of the category would carry.
   * @returns Map of category name to entry count.
   */
  async listCategories(): Promise<Array<{ category: ConfigCategory; entryCount: number }>> {
    const result: Array<{ category: ConfigCategory; entryCount: number }> = [];

    for (const [category, prefix] of Object.entries(CATEGORY_PREFIXES)) {
      const entryCount =
        category === 'forgePlans'
          ? (await this.heldTemplates()).length
          : this.configStore.getKeysByPrefix(prefix).length;
      result.push({ category: category as ConfigCategory, entryCount });
    }

    return result;
  }

  /**
   * The Forge templates this window holds: its workspace file's, with those
   * an import left for the workspace merged in as Forge will merge them; or,
   * with no folder open, the ConfigStore's.
   */
  private async heldTemplates(): Promise<ForgeTemplate[]> {
    if (!this.workspace) {
      const stored = this.configStore.get<unknown>(FORGE_TEMPLATES_KEY);
      return Array.isArray(stored) ? stored.filter(isTemplateEntry) : [];
    }
    const inFile = await this.workspace.readTemplates();
    const waiting = importedTemplatesFor(this.configStore, this.workspace.folder);
    return waiting
      ? mergeTemplates(inFile, waiting.templates, new Set(waiting.replacing))
      : [...inFile];
  }

  /**
   * Bring a profile's Forge templates into this window's, as the other
   * categories bring their entries in: a template whose id the window does
   * not hold is added, and one whose id it holds replaces the window's with
   * overwrite, and is skipped with a warning without.
   *
   * The category carries every template under one key, and was imported as
   * that one entry. Without overwrite, the key the ConfigStore holds as soon
   * as any window saved a template was skipped whole, and no template came
   * in. With it, the list replaced the ConfigStore's, the templates a window
   * with no folder open lists, and every one the profile did not carry was
   * gone from it.
   *
   * With a folder open, the templates are left for the workspace's Forge to
   * merge into its file (see `importedForgeTemplates`); with none, they join
   * the ConfigStore's list.
   *
   * @returns How many templates were brought in.
   */
  private async importTemplates(
    categoryData: Record<string, unknown>,
    overwrite: boolean,
    warnings: string[],
  ): Promise<number> {
    const held = await this.heldTemplates();
    const heldIds = new Set(held.map((template) => template.id));
    const seen = new Set<string>();
    const brought: ForgeTemplate[] = [];
    const replacing: string[] = [];

    for (const [key, value] of Object.entries(categoryData)) {
      if (key !== FORGE_TEMPLATES_KEY) {
        warnings.push(
          `Key "${key}" does not match expected prefix "${FORGE_TEMPLATES_KEY}" for category "forgePlans", skipped.`,
        );
        continue;
      }
      if (!Array.isArray(value)) {
        warnings.push(`Key "${key}" holds no list of templates, skipped.`);
        continue;
      }
      for (const entry of value) {
        if (!isTemplateEntry(entry)) {
          warnings.push(`An entry of "${key}" has no id, skipped.`);
          continue;
        }
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        if (heldIds.has(entry.id)) {
          if (!overwrite) {
            warnings.push(`Forge template "${templateLabel(entry)}" already exists, skipped.`);
            continue;
          }
          replacing.push(entry.id);
        }
        brought.push(entry);
      }
    }

    if (this.workspace) {
      recordImportedTemplates(this.configStore, this.workspace.folder, brought, replacing);
    } else if (brought.length > 0) {
      this.configStore.set(
        FORGE_TEMPLATES_KEY,
        mergeTemplates(held, brought, new Set(replacing)),
        STORE_CATEGORIES.forgePlans,
      );
    }
    return brought.length;
  }
}
