import { z } from 'zod';

// ── Extension Point Types ─────────────────────────────────

/** Available extension point categories */
export type ExtensionPointName =
  | 'seedStrategies'
  | 'transformers'
  | 'preChecks'
  | 'pipelineSteps'
  | 'exportFormats'
  | 'grappeStrategies';

/** A seed strategy extension point */
export interface SeedStrategyExtension {
  name: string;
  generate(config: Record<string, unknown>): Promise<Record<string, unknown>[]>;
}

/** A transformer extension point */
export interface TransformerExtension {
  name: string;
  transform(
    record: Record<string, unknown>,
    config: Record<string, unknown>
  ): Record<string, unknown>;
}

/** A pre-check extension point */
export interface PreCheckExtension {
  name: string;
  check(context: Record<string, unknown>): Promise<PreCheckResult>;
}

/** Result of a pre-check */
export interface PreCheckResult {
  passed: boolean;
  message: string;
  details?: Record<string, unknown>;
}

/** A pipeline step extension point */
export interface PipelineStepExtension {
  name: string;
  execute(input: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/** An export format extension point */
export interface ExportFormatExtension {
  name: string;
  format: string;
  serialize(records: Record<string, unknown>[]): string;
}

/** A grappe strategy extension point */
export interface GrappeStrategyExtension {
  name: string;
  partition(
    records: string[],
    partitionCount: number
  ): string[][];
}

/** All extension point types */
export interface ExtensionPoints {
  seedStrategies: SeedStrategyExtension[];
  transformers: TransformerExtension[];
  preChecks: PreCheckExtension[];
  pipelineSteps: PipelineStepExtension[];
  exportFormats: ExportFormatExtension[];
  grappeStrategies: GrappeStrategyExtension[];
}

// ── Plugin Interface ──────────────────────────────────────

/**
 * Interface that all SandForge plugins must implement.
 * Plugins register their contributions via extension points.
 */
export interface SandForgePlugin {
  /** Unique plugin name */
  name: string;
  /** Plugin version (semver) */
  version: string;
  /** Initialize the plugin and register extension points */
  activate(context: PluginContext): void;
  /** Clean up plugin resources */
  deactivate(): void;
}

/** Context provided to plugins during activation */
export interface PluginContext {
  registerSeedStrategy(strategy: SeedStrategyExtension): void;
  registerTransformer(transformer: TransformerExtension): void;
  registerPreCheck(preCheck: PreCheckExtension): void;
  registerPipelineStep(step: PipelineStepExtension): void;
  registerExportFormat(format: ExportFormatExtension): void;
  registerGrappeStrategy(strategy: GrappeStrategyExtension): void;
}

// ── Plugin Manifest Zod Schema ────────────────────────────

/** Schema for plugin manifest validation */
export const pluginManifestSchema = z.object({
  name: z.string().min(1).regex(/^[a-z0-9-]+$/, 'Plugin name must be lowercase alphanumeric with hyphens'),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'Version must follow semver (x.y.z)'),
  description: z.string().min(1),
  author: z.string().optional(),
  entrypoint: z.string().min(1),
  extensionPoints: z.array(
    z.enum([
      'seedStrategies',
      'transformers',
      'preChecks',
      'pipelineSteps',
      'exportFormats',
      'grappeStrategies',
    ])
  ).min(1),
  dependencies: z.record(z.string(), z.string()).optional().default({}),
  sandforgeMinVersion: z.string().optional(),
});

/** Inferred type for plugin manifest */
export type PluginManifest = z.infer<typeof pluginManifestSchema>;

// ── Loaded plugin info ────────────────────────────────────

/** Information about a loaded plugin */
export interface LoadedPluginInfo {
  manifest: PluginManifest;
  plugin: SandForgePlugin;
  active: boolean;
  loadedAt: string;
}

// ── File system interface ─────────────────────────────────

/** Interface for file system operations — allows easy mocking */
export interface PluginFileSystem {
  readFile(filePath: string): Promise<string>;
  exists(filePath: string): Promise<boolean>;
  readDir(dirPath: string): Promise<string[]>;
}

/** Interface for dynamic module loading */
export interface ModuleLoader {
  load(entrypoint: string): Promise<SandForgePlugin>;
}

// ── PluginManager ─────────────────────────────────────────

/**
 * Manages the lifecycle of SandForge plugins.
 *
 * Plugins are loaded from the `.sandforge/plugins/` directory.
 * Each plugin must have a `manifest.json` file validated with Zod
 * and an entrypoint module that exports a SandForgePlugin.
 *
 * The PluginManager handles:
 * - Discovery and loading of plugins
 * - Manifest validation
 * - Plugin activation and deactivation
 * - Extension point registration and querying
 */
export class PluginManager {
  private readonly plugins: Map<string, LoadedPluginInfo> = new Map();
  private readonly extensionPoints: ExtensionPoints = {
    seedStrategies: [],
    transformers: [],
    preChecks: [],
    pipelineSteps: [],
    exportFormats: [],
    grappeStrategies: [],
  };
  private readonly fs: PluginFileSystem;
  private readonly moduleLoader: ModuleLoader;
  private readonly pluginsDir: string;

  constructor(fs: PluginFileSystem, moduleLoader: ModuleLoader, pluginsDir: string) {
    this.fs = fs;
    this.moduleLoader = moduleLoader;
    this.pluginsDir = pluginsDir;
  }

  /**
   * Discover and load all plugins from the plugins directory.
   * Each subdirectory is expected to contain a manifest.json.
   * @returns Array of loaded plugin names
   */
  async loadPlugins(): Promise<string[]> {
    const dirExists = await this.fs.exists(this.pluginsDir);
    if (!dirExists) {
      return [];
    }

    const entries = await this.fs.readDir(this.pluginsDir);
    const loaded: string[] = [];

    for (const entry of entries) {
      const manifestPath = `${this.pluginsDir}/${entry}/manifest.json`;
      const manifestExists = await this.fs.exists(manifestPath);
      if (!manifestExists) {
        continue;
      }

      const manifestContent = await this.fs.readFile(manifestPath);
      const parsed: unknown = JSON.parse(manifestContent);
      const manifestResult = pluginManifestSchema.safeParse(parsed);

      if (!manifestResult.success) {
        continue;
      }

      const manifest = manifestResult.data;

      if (this.plugins.has(manifest.name)) {
        continue;
      }

      const entrypointPath = `${this.pluginsDir}/${entry}/${manifest.entrypoint}`;
      const plugin = await this.moduleLoader.load(entrypointPath);
      const context = this.createContext();

      plugin.activate(context);

      this.plugins.set(manifest.name, {
        manifest,
        plugin,
        active: true,
        loadedAt: new Date().toISOString(),
      });

      loaded.push(manifest.name);
    }

    return loaded;
  }

  /**
   * Get a loaded plugin by name.
   * @param name - Plugin name
   * @returns Plugin info or undefined if not found
   */
  getPlugin(name: string): LoadedPluginInfo | undefined {
    return this.plugins.get(name);
  }

  /**
   * List all loaded plugins.
   * @returns Array of plugin info objects
   */
  listPlugins(): LoadedPluginInfo[] {
    return Array.from(this.plugins.values());
  }

  /**
   * Unload and deactivate a plugin by name.
   * @param name - Plugin name to unload
   * @returns True if the plugin was found and unloaded
   */
  unloadPlugin(name: string): boolean {
    const info = this.plugins.get(name);
    if (!info) {
      return false;
    }

    info.plugin.deactivate();
    info.active = false;

    this.removeExtensionsFor(info.manifest.name);
    this.plugins.delete(name);

    return true;
  }

  /**
   * Get all registered extension points.
   * @returns Current state of all extension points
   */
  getExtensionPoints(): ExtensionPoints {
    return { ...this.extensionPoints };
  }

  /**
   * Get all registered seed strategies.
   * @returns Array of seed strategy extensions
   */
  getSeedStrategies(): SeedStrategyExtension[] {
    return [...this.extensionPoints.seedStrategies];
  }

  /**
   * Get all registered transformers.
   * @returns Array of transformer extensions
   */
  getTransformers(): TransformerExtension[] {
    return [...this.extensionPoints.transformers];
  }

  /**
   * Get all registered pre-checks.
   * @returns Array of pre-check extensions
   */
  getPreChecks(): PreCheckExtension[] {
    return [...this.extensionPoints.preChecks];
  }

  /**
   * Get all registered pipeline steps.
   * @returns Array of pipeline step extensions
   */
  getPipelineSteps(): PipelineStepExtension[] {
    return [...this.extensionPoints.pipelineSteps];
  }

  /**
   * Get all registered export formats.
   * @returns Array of export format extensions
   */
  getExportFormats(): ExportFormatExtension[] {
    return [...this.extensionPoints.exportFormats];
  }

  /**
   * Get all registered grappe strategies.
   * @returns Array of grappe strategy extensions
   */
  getGrappeStrategies(): GrappeStrategyExtension[] {
    return [...this.extensionPoints.grappeStrategies];
  }

  /**
   * Create a plugin context for extension point registration.
   * @returns PluginContext instance
   */
  private createContext(): PluginContext {
    return {
      registerSeedStrategy: (strategy: SeedStrategyExtension) => {
        this.extensionPoints.seedStrategies.push(strategy);
      },
      registerTransformer: (transformer: TransformerExtension) => {
        this.extensionPoints.transformers.push(transformer);
      },
      registerPreCheck: (preCheck: PreCheckExtension) => {
        this.extensionPoints.preChecks.push(preCheck);
      },
      registerPipelineStep: (step: PipelineStepExtension) => {
        this.extensionPoints.pipelineSteps.push(step);
      },
      registerExportFormat: (format: ExportFormatExtension) => {
        this.extensionPoints.exportFormats.push(format);
      },
      registerGrappeStrategy: (strategy: GrappeStrategyExtension) => {
        this.extensionPoints.grappeStrategies.push(strategy);
      },
    };
  }

  /**
   * Remove all extension contributions from a specific plugin.
   * @param pluginName - Name of the plugin whose extensions to remove
   */
  private removeExtensionsFor(pluginName: string): void {
    this.extensionPoints.seedStrategies = this.extensionPoints.seedStrategies.filter(
      (s) => s.name !== pluginName
    );
    this.extensionPoints.transformers = this.extensionPoints.transformers.filter(
      (t) => t.name !== pluginName
    );
    this.extensionPoints.preChecks = this.extensionPoints.preChecks.filter(
      (p) => p.name !== pluginName
    );
    this.extensionPoints.pipelineSteps = this.extensionPoints.pipelineSteps.filter(
      (s) => s.name !== pluginName
    );
    this.extensionPoints.exportFormats = this.extensionPoints.exportFormats.filter(
      (f) => f.name !== pluginName
    );
    this.extensionPoints.grappeStrategies = this.extensionPoints.grappeStrategies.filter(
      (g) => g.name !== pluginName
    );
  }
}
