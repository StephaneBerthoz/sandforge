import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PluginManager, pluginManifestSchema } from './PluginManager';
import type {
  PluginFileSystem,
  ModuleLoader,
  SandForgePlugin,
  PluginContext,
  PluginManifest,
} from './PluginManager';

function createMockPlugin(name: string): SandForgePlugin {
  return {
    name,
    version: '1.0.0',
    activate: vi.fn((context: PluginContext) => {
      context.registerTransformer({
        name,
        transform: (record: Record<string, unknown>) => record,
      });
      context.registerSeedStrategy({
        name,
        generate: vi.fn().mockResolvedValue([]),
      });
    }),
    deactivate: vi.fn(),
  };
}

function createManifest(overrides?: Partial<PluginManifest>): PluginManifest {
  return {
    name: 'test-plugin',
    version: '1.0.0',
    description: 'A test plugin',
    entrypoint: 'index.js',
    extensionPoints: ['transformers', 'seedStrategies'],
    dependencies: {},
    ...overrides,
  };
}

function createMockFs(plugins: Record<string, PluginManifest>): PluginFileSystem {
  const entries = Object.keys(plugins);

  return {
    readFile: vi.fn().mockImplementation(async (filePath: string) => {
      for (const [dir, manifest] of Object.entries(plugins)) {
        if (filePath.includes(`/${dir}/manifest.json`)) {
          return JSON.stringify(manifest);
        }
      }
      throw new Error(`File not found: ${filePath}`);
    }),
    exists: vi.fn().mockImplementation(async (filePath: string) => {
      if (filePath.endsWith('/plugins') || filePath.endsWith('\\plugins')) {
        return true;
      }
      for (const dir of entries) {
        if (filePath.includes(`/${dir}/manifest.json`)) {
          return true;
        }
        if (filePath.includes(`/${dir}/index.js`)) {
          return true;
        }
      }
      return false;
    }),
    readDir: vi.fn().mockResolvedValue(entries),
  };
}

function createMockLoader(plugins: Record<string, SandForgePlugin>): ModuleLoader {
  return {
    load: vi.fn().mockImplementation(async (entrypoint: string) => {
      for (const [name, plugin] of Object.entries(plugins)) {
        if (entrypoint.includes(name)) {
          return plugin;
        }
      }
      throw new Error(`Module not found: ${entrypoint}`);
    }),
  };
}

describe('PluginManager', () => {
  let mockPlugin: SandForgePlugin;
  let mockFs: PluginFileSystem;
  let mockLoader: ModuleLoader;
  let manager: PluginManager;

  beforeEach(() => {
    mockPlugin = createMockPlugin('test-plugin');
    const manifest = createManifest();
    mockFs = createMockFs({ 'test-plugin': manifest });
    mockLoader = createMockLoader({ 'test-plugin': mockPlugin });
    manager = new PluginManager(mockFs, mockLoader, '/workspace/.sandforge/plugins');
  });

  describe('loadPlugins', () => {
    it('should discover and load plugins from the plugins directory', async () => {
      const loaded = await manager.loadPlugins();

      expect(loaded).toEqual(['test-plugin']);
      expect(mockPlugin.activate).toHaveBeenCalledTimes(1);
    });

    it('should return empty array when plugins directory does not exist', async () => {
      const emptyFs: PluginFileSystem = {
        readFile: vi.fn(),
        exists: vi.fn().mockResolvedValue(false),
        readDir: vi.fn().mockResolvedValue([]),
      };

      const mgr = new PluginManager(emptyFs, mockLoader, '/missing/.sandforge/plugins');
      const loaded = await mgr.loadPlugins();

      expect(loaded).toEqual([]);
    });

    it('should skip directories without manifest.json', async () => {
      const fs: PluginFileSystem = {
        readFile: vi.fn(),
        exists: vi.fn().mockImplementation(async (path: string) => {
          if (path.endsWith('/plugins')) {
            return true;
          }
          return false;
        }),
        readDir: vi.fn().mockResolvedValue(['no-manifest-dir']),
      };

      const mgr = new PluginManager(fs, mockLoader, '/workspace/.sandforge/plugins');
      const loaded = await mgr.loadPlugins();

      expect(loaded).toEqual([]);
    });

    it('should skip plugins with invalid manifest', async () => {
      const badFs: PluginFileSystem = {
        readFile: vi.fn().mockResolvedValue(JSON.stringify({ name: '' })),
        exists: vi.fn().mockResolvedValue(true),
        readDir: vi.fn().mockResolvedValue(['bad-plugin']),
      };

      const mgr = new PluginManager(badFs, mockLoader, '/workspace/.sandforge/plugins');
      const loaded = await mgr.loadPlugins();

      expect(loaded).toEqual([]);
    });

    it('should not load the same plugin twice', async () => {
      await manager.loadPlugins();
      const secondLoad = await manager.loadPlugins();

      expect(secondLoad).toEqual([]);
      expect(mockPlugin.activate).toHaveBeenCalledTimes(1);
    });

    it('should load multiple plugins', async () => {
      const plugin1 = createMockPlugin('plugin-one');
      const plugin2 = createMockPlugin('plugin-two');

      const manifests = {
        'plugin-one': createManifest({ name: 'plugin-one' }),
        'plugin-two': createManifest({ name: 'plugin-two' }),
      };

      const fs = createMockFs(manifests);
      const loader = createMockLoader({ 'plugin-one': plugin1, 'plugin-two': plugin2 });
      const mgr = new PluginManager(fs, loader, '/workspace/.sandforge/plugins');

      const loaded = await mgr.loadPlugins();

      expect(loaded).toHaveLength(2);
      expect(loaded).toContain('plugin-one');
      expect(loaded).toContain('plugin-two');
    });
  });

  describe('getPlugin', () => {
    it('should return loaded plugin info', async () => {
      await manager.loadPlugins();

      const info = manager.getPlugin('test-plugin');

      expect(info).toBeDefined();
      expect(info?.manifest.name).toBe('test-plugin');
      expect(info?.active).toBe(true);
      expect(info?.loadedAt).toBeDefined();
    });

    it('should return undefined for unknown plugin', () => {
      const info = manager.getPlugin('unknown-plugin');
      expect(info).toBeUndefined();
    });
  });

  describe('listPlugins', () => {
    it('should list all loaded plugins', async () => {
      await manager.loadPlugins();

      const plugins = manager.listPlugins();

      expect(plugins).toHaveLength(1);
      expect(plugins[0].manifest.name).toBe('test-plugin');
    });

    it('should return empty array when no plugins loaded', () => {
      const plugins = manager.listPlugins();
      expect(plugins).toHaveLength(0);
    });
  });

  describe('unloadPlugin', () => {
    it('should deactivate and remove a plugin', async () => {
      await manager.loadPlugins();

      const result = manager.unloadPlugin('test-plugin');

      expect(result).toBe(true);
      expect(mockPlugin.deactivate).toHaveBeenCalledTimes(1);
      expect(manager.getPlugin('test-plugin')).toBeUndefined();
    });

    it('should return false for unknown plugin', () => {
      const result = manager.unloadPlugin('unknown-plugin');
      expect(result).toBe(false);
    });

    it('should remove extension points when unloading', async () => {
      await manager.loadPlugins();

      expect(manager.getTransformers()).toHaveLength(1);
      expect(manager.getSeedStrategies()).toHaveLength(1);

      manager.unloadPlugin('test-plugin');

      expect(manager.getTransformers()).toHaveLength(0);
      expect(manager.getSeedStrategies()).toHaveLength(0);
    });
  });

  describe('extension points', () => {
    it('should register transformer extension points', async () => {
      await manager.loadPlugins();

      const transformers = manager.getTransformers();
      expect(transformers).toHaveLength(1);
      expect(transformers[0].name).toBe('test-plugin');
    });

    it('should register seed strategy extension points', async () => {
      await manager.loadPlugins();

      const strategies = manager.getSeedStrategies();
      expect(strategies).toHaveLength(1);
    });

    it('should return all extension points', async () => {
      await manager.loadPlugins();

      const extensionPoints = manager.getExtensionPoints();
      expect(extensionPoints.seedStrategies).toHaveLength(1);
      expect(extensionPoints.transformers).toHaveLength(1);
      expect(extensionPoints.preChecks).toHaveLength(0);
      expect(extensionPoints.pipelineSteps).toHaveLength(0);
      expect(extensionPoints.exportFormats).toHaveLength(0);
      expect(extensionPoints.grappeStrategies).toHaveLength(0);
    });

    it('should register pre-check extension via plugin context', async () => {
      const plugin: SandForgePlugin = {
        name: 'precheck-plugin',
        version: '1.0.0',
        activate: (ctx: PluginContext) => {
          ctx.registerPreCheck({
            name: 'precheck-plugin',
            check: vi.fn().mockResolvedValue({ passed: true, message: 'OK' }),
          });
        },
        deactivate: vi.fn(),
      };

      const manifest = createManifest({ name: 'precheck-plugin', extensionPoints: ['preChecks'] });
      const fs = createMockFs({ 'precheck-plugin': manifest });
      const loader = createMockLoader({ 'precheck-plugin': plugin });
      const mgr = new PluginManager(fs, loader, '/workspace/.sandforge/plugins');

      await mgr.loadPlugins();

      expect(mgr.getPreChecks()).toHaveLength(1);
    });

    it('should register pipeline step extension via plugin context', async () => {
      const plugin: SandForgePlugin = {
        name: 'step-plugin',
        version: '1.0.0',
        activate: (ctx: PluginContext) => {
          ctx.registerPipelineStep({
            name: 'step-plugin',
            execute: vi.fn().mockResolvedValue({}),
          });
        },
        deactivate: vi.fn(),
      };

      const manifest = createManifest({ name: 'step-plugin', extensionPoints: ['pipelineSteps'] });
      const fs = createMockFs({ 'step-plugin': manifest });
      const loader = createMockLoader({ 'step-plugin': plugin });
      const mgr = new PluginManager(fs, loader, '/workspace/.sandforge/plugins');

      await mgr.loadPlugins();

      expect(mgr.getPipelineSteps()).toHaveLength(1);
    });

    it('should register export format extension via plugin context', async () => {
      const plugin: SandForgePlugin = {
        name: 'export-plugin',
        version: '1.0.0',
        activate: (ctx: PluginContext) => {
          ctx.registerExportFormat({
            name: 'export-plugin',
            format: 'xml',
            serialize: () => '<records/>',
          });
        },
        deactivate: vi.fn(),
      };

      const manifest = createManifest({
        name: 'export-plugin',
        extensionPoints: ['exportFormats'],
      });
      const fs = createMockFs({ 'export-plugin': manifest });
      const loader = createMockLoader({ 'export-plugin': plugin });
      const mgr = new PluginManager(fs, loader, '/workspace/.sandforge/plugins');

      await mgr.loadPlugins();

      expect(mgr.getExportFormats()).toHaveLength(1);
      expect(mgr.getExportFormats()[0].format).toBe('xml');
    });

    it('should register grappe strategy extension via plugin context', async () => {
      const plugin: SandForgePlugin = {
        name: 'grappe-plugin',
        version: '1.0.0',
        activate: (ctx: PluginContext) => {
          ctx.registerGrappeStrategy({
            name: 'grappe-plugin',
            partition: (records, count) => {
              const result: string[][] = [];
              const size = Math.ceil(records.length / count);
              for (let i = 0; i < count; i++) {
                result.push(records.slice(i * size, (i + 1) * size));
              }
              return result;
            },
          });
        },
        deactivate: vi.fn(),
      };

      const manifest = createManifest({
        name: 'grappe-plugin',
        extensionPoints: ['grappeStrategies'],
      });
      const fs = createMockFs({ 'grappe-plugin': manifest });
      const loader = createMockLoader({ 'grappe-plugin': plugin });
      const mgr = new PluginManager(fs, loader, '/workspace/.sandforge/plugins');

      await mgr.loadPlugins();

      expect(mgr.getGrappeStrategies()).toHaveLength(1);
    });
  });

  describe('pluginManifestSchema', () => {
    it('should validate a correct manifest', () => {
      const manifest = createManifest();
      const result = pluginManifestSchema.safeParse(manifest);
      expect(result.success).toBe(true);
    });

    it('should reject empty name', () => {
      const result = pluginManifestSchema.safeParse(createManifest({ name: '' }));
      expect(result.success).toBe(false);
    });

    it('should reject name with uppercase letters', () => {
      const result = pluginManifestSchema.safeParse(createManifest({ name: 'MyPlugin' }));
      expect(result.success).toBe(false);
    });

    it('should reject invalid semver version', () => {
      const result = pluginManifestSchema.safeParse(createManifest({ version: 'not-a-version' }));
      expect(result.success).toBe(false);
    });

    it('should reject empty extension points', () => {
      const result = pluginManifestSchema.safeParse(createManifest({ extensionPoints: [] }));
      expect(result.success).toBe(false);
    });

    it('should reject missing entrypoint', () => {
      const result = pluginManifestSchema.safeParse({
        name: 'test',
        version: '1.0.0',
        description: 'A plugin',
        extensionPoints: ['transformers'],
      });
      expect(result.success).toBe(false);
    });

    it('should accept optional fields', () => {
      const manifest = {
        name: 'minimal-plugin',
        version: '0.1.0',
        description: 'A minimal plugin',
        entrypoint: 'index.js',
        extensionPoints: ['transformers'],
      };

      const result = pluginManifestSchema.parse(manifest);
      expect(result.dependencies).toEqual({});
      expect(result.author).toBeUndefined();
    });

    it('should accept name with hyphens', () => {
      const result = pluginManifestSchema.safeParse(createManifest({ name: 'my-cool-plugin-v2' }));
      expect(result.success).toBe(true);
    });

    it('should reject invalid extension point name', () => {
      const result = pluginManifestSchema.safeParse(
        createManifest({ extensionPoints: ['invalidPoint' as never] }),
      );
      expect(result.success).toBe(false);
    });
  });
});
