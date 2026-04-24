import { z } from 'zod';
import type { ConfigStore } from '../storage/ConfigStore.js';

/**
 * Zod schema for a team configuration bundle.
 */
const TeamConfigBundleSchema = z.object({
  version: z.string(),
  createdAt: z.string(),
  createdBy: z.string().optional(),
  checksum: z.string(),
  categories: z.array(z.string()),
  data: z.record(z.string(), z.unknown()),
});

/** A team configuration bundle. */
export type TeamConfigBundle = z.infer<typeof TeamConfigBundleSchema>;

/** Merge strategy for importing team configs. */
export type MergeStrategy = 'keep-local' | 'keep-remote' | 'merge';

/**
 * Represents a conflict between local and remote config values.
 */
export interface ConfigConflict {
  /** The config key that has a conflict. */
  key: string;
  /** The local value. */
  localValue: unknown;
  /** The remote (incoming) value. */
  remoteValue: unknown;
}

/**
 * Result of importing a team config bundle.
 */
export interface TeamImportResult {
  /** Whether the import succeeded. */
  success: boolean;
  /** Number of keys imported or merged. */
  keysImported: number;
  /** Number of keys skipped. */
  keysSkipped: number;
  /** Conflicts that were detected. */
  conflicts: ConfigConflict[];
  /** Error message if the import failed. */
  error?: string;
}

/**
 * Result of generating a shareable config bundle.
 */
export interface TeamShareResult {
  /** Whether the share operation succeeded. */
  success: boolean;
  /** Base64-encoded config bundle. */
  bundle?: string;
  /** Number of keys included. */
  keysIncluded: number;
  /** Error message if the share failed. */
  error?: string;
}

/** Current bundle format version. */
const BUNDLE_VERSION = '1.0.0';

/**
 * Service for sharing SandForge configurations between team members.
 *
 * Generates shareable base64-encoded config bundles, parses and validates
 * incoming bundles, and supports multiple merge strategies with conflict
 * detection.
 */
export class TeamConfigService {
  /** @param configStore - The configuration store backend. */
  constructor(private readonly configStore: ConfigStore) {}

  /**
   * Generate a shareable config bundle from selected categories.
   *
   * @param categories - Config categories to include in the bundle.
   * @param createdBy - Optional author name.
   * @returns Result with the base64-encoded bundle string.
   */
  share(categories: string[], createdBy?: string): TeamShareResult {
    try {
      const data: Record<string, unknown> = {};
      let keysIncluded = 0;

      for (const category of categories) {
        const entries = this.configStore.getByCategory(category);
        for (const [key, value] of Object.entries(entries)) {
          data[key] = value;
          keysIncluded++;
        }
      }

      const bundle: TeamConfigBundle = {
        version: BUNDLE_VERSION,
        createdAt: new Date().toISOString(),
        createdBy,
        checksum: TeamConfigService.computeChecksum(data),
        categories,
        data,
      };

      const json = JSON.stringify(bundle);
      const encoded = TeamConfigService.toBase64(json);

      return { success: true, bundle: encoded, keysIncluded };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, keysIncluded: 0, error: message };
    }
  }

  /**
   * Parse and validate a base64-encoded config bundle.
   *
   * @param encoded - The base64-encoded bundle string.
   * @returns The parsed and validated bundle.
   * @throws If the bundle is invalid.
   */
  parseBundle(encoded: string): TeamConfigBundle {
    const json = TeamConfigService.fromBase64(encoded);
    const raw: unknown = JSON.parse(json);
    const parsed = TeamConfigBundleSchema.parse(raw);

    const actualChecksum = TeamConfigService.computeChecksum(parsed.data);
    if (actualChecksum !== parsed.checksum) {
      throw new Error('Bundle checksum mismatch — data may be corrupted');
    }

    return parsed;
  }

  /**
   * Import a config bundle with the specified merge strategy.
   *
   * @param encoded - The base64-encoded bundle string.
   * @param strategy - How to handle conflicts between local and remote.
   * @returns Result describing what was imported.
   */
  import(encoded: string, strategy: MergeStrategy): TeamImportResult {
    try {
      const bundle = this.parseBundle(encoded);
      return this.applyBundle(bundle, strategy);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        keysImported: 0,
        keysSkipped: 0,
        conflicts: [],
        error: message,
      };
    }
  }

  /**
   * Detect conflicts between a bundle and the current config.
   *
   * @param encoded - The base64-encoded bundle string.
   * @returns Array of conflicts found.
   */
  detectConflicts(encoded: string): ConfigConflict[] {
    const bundle = this.parseBundle(encoded);
    const conflicts: ConfigConflict[] = [];

    for (const [key, remoteValue] of Object.entries(bundle.data)) {
      if (this.configStore.has(key)) {
        const localValue = this.configStore.get<unknown>(key);
        if (JSON.stringify(localValue) !== JSON.stringify(remoteValue)) {
          conflicts.push({ key, localValue, remoteValue });
        }
      }
    }

    return conflicts;
  }

  /**
   * Preview a bundle without applying it.
   *
   * @param encoded - The base64-encoded bundle string.
   * @returns The parsed bundle for inspection.
   */
  preview(encoded: string): TeamConfigBundle {
    return this.parseBundle(encoded);
  }

  /**
   * Apply a parsed bundle to the config store using the given strategy.
   *
   * @param bundle - The validated config bundle.
   * @param strategy - The merge strategy to use.
   * @returns Import result.
   */
  private applyBundle(
    bundle: TeamConfigBundle,
    strategy: MergeStrategy,
  ): TeamImportResult {
    let keysImported = 0;
    let keysSkipped = 0;
    const conflicts: ConfigConflict[] = [];

    for (const [key, remoteValue] of Object.entries(bundle.data)) {
      const hasLocal = this.configStore.has(key);

      if (!hasLocal) {
        this.configStore.set(key, remoteValue, this.categoryFromKey(key, bundle.categories));
        keysImported++;
        continue;
      }

      const localValue = this.configStore.get<unknown>(key);
      const isConflict = JSON.stringify(localValue) !== JSON.stringify(remoteValue);

      if (!isConflict) {
        keysSkipped++;
        continue;
      }

      conflicts.push({ key, localValue, remoteValue });

      switch (strategy) {
        case 'keep-local':
          keysSkipped++;
          break;
        case 'keep-remote':
          this.configStore.set(key, remoteValue, this.categoryFromKey(key, bundle.categories));
          keysImported++;
          break;
        case 'merge':
          // For merge strategy, remote wins for new keys, local wins for conflicts
          keysSkipped++;
          break;
      }
    }

    return {
      success: true,
      keysImported,
      keysSkipped,
      conflicts,
    };
  }

  /**
   * Determine the category for a key based on the bundle's categories.
   *
   * @param key - The config key.
   * @param categories - Available categories from the bundle.
   * @returns The matching category or 'general'.
   */
  private categoryFromKey(key: string, categories: string[]): string {
    for (const category of categories) {
      if (key.startsWith(`${category}:`)) {
        return category;
      }
    }
    return categories[0] ?? 'general';
  }

  /**
   * Compute a simple checksum for data integrity verification.
   *
   * @param data - The data object to checksum.
   * @returns Hex checksum string.
   */
  static computeChecksum(data: Record<string, unknown>): string {
    const str = JSON.stringify(data);
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash + char) | 0;
    }
    return Math.abs(hash).toString(16).padStart(8, '0');
  }

  /**
   * Encode a string to base64.
   *
   * @param str - The string to encode.
   * @returns Base64-encoded string.
   */
  static toBase64(str: string): string {
    return Buffer.from(str, 'utf-8').toString('base64');
  }

  /**
   * Decode a base64 string.
   *
   * @param encoded - The base64 string to decode.
   * @returns Decoded string.
   */
  static fromBase64(encoded: string): string {
    return Buffer.from(encoded, 'base64').toString('utf-8');
  }
}
