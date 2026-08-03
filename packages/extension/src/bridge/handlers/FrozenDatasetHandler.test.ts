import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { FrozenDatasetHandler } from './FrozenDatasetHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import type { BaseMessage, FrozenProjectConfig } from '@sandforge/shared';

vi.mock('../../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

/** Build a BaseMessage with optional payload. */
function buildMsg(type: string, payload?: unknown): BaseMessage {
  return {
    id: `test-${type}-${Date.now()}`,
    type,
    timestamp: Date.now(),
    ...(payload !== undefined ? { payload } : {}),
  } as BaseMessage;
}

/** Minimal valid project config (sas redirected to a temp dir — outside any repo). */
function createMockConfig(): FrozenProjectConfig {
  return {
    rootObject: 'Case',
    axes: [
      {
        name: 'type',
        label: 'Type',
        filterField: 'Type',
        valuesSoql: 'SELECT Type axisValue FROM Case GROUP BY Type',
      },
    ],
    edgeCases: [],
    budgetMaxRecords: 2500,
    sasDir: path.join(os.tmpdir(), `sandforge-frozen-test-${process.pid}`),
  };
}

/** Creates standard mock deps following the HandlerDeps pattern. */
function createMockDeps(config?: FrozenProjectConfig): HandlerDeps {
  let idCounter = 0;
  const store = new Map<string, unknown>();
  if (config) store.set('frozen:config', config);
  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
    stateSync: {} as HandlerDeps['stateSync'],
    orgManager: { getOrg: vi.fn() } as unknown as HandlerDeps['orgManager'],
    orgRegistry: {} as unknown as HandlerDeps['orgRegistry'],
    configStore: {
      get: vi.fn((key: string) => store.get(key)),
      set: vi.fn((key: string, value: unknown) => {
        store.set(key, value);
      }),
    } as unknown as HandlerDeps['configStore'],
    secretVault: {} as unknown as HandlerDeps['secretVault'],
    authProvider: {} as unknown as HandlerDeps['authProvider'],
    sfdxBridge: {} as unknown as HandlerDeps['sfdxBridge'],
    nextId: () => String(++idCounter),
  };
}

/** Extract all posted messages of a given type. */
function posted(
  deps: HandlerDeps,
  type: string,
): Array<BaseMessage & { payload: Record<string, unknown> }> {
  const mock = deps.broker.postToWebview as unknown as { mock: { calls: unknown[][] } };
  return mock.mock.calls
    .map((c) => c[0] as BaseMessage & { payload: Record<string, unknown> })
    .filter((m) => m.type === type);
}

describe('FrozenDatasetHandler', () => {
  let deps: HandlerDeps;
  let handler: FrozenDatasetHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    deps = createMockDeps();
    handler = new FrozenDatasetHandler(deps);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('message routing', () => {
    it('returns false for unhandled message types', async () => {
      expect(await handler.handle(buildMsg('forge:discover'))).toBe(false);
      expect(await handler.handle(buildMsg('unknown:type'))).toBe(false);
    });

    it('handles every frozen:* request type', async () => {
      // No config saved → data-bearing flows fail with CONFIG_MISSING/NO_LOAD,
      // but every type is claimed by the handler.
      expect(await handler.handle(buildMsg('frozen:config:get'))).toBe(true);
      expect(await handler.handle(buildMsg('frozen:manifest:get'))).toBe(true);
      expect(await handler.handle(buildMsg('frozen:status'))).toBe(true);
      expect(await handler.handle(buildMsg('frozen:select', { sourceOrgId: 'org-1' }))).toBe(true);
      expect(await handler.handle(buildMsg('frozen:extract', { sourceOrgId: 'org-1' }))).toBe(true);
      expect(await handler.handle(buildMsg('frozen:load', { targetOrgId: 'org-2' }))).toBe(true);
      expect(await handler.handle(buildMsg('frozen:verify', { targetOrgId: 'org-2' }))).toBe(true);
    });
  });

  describe('frozen:config:get', () => {
    it('responds with null config when nothing is saved', async () => {
      await handler.handle(buildMsg('frozen:config:get'));
      const responses = posted(deps, 'frozen:config:get:response');
      expect(responses).toHaveLength(1);
      expect(responses[0].payload.config).toBeNull();
      expect(typeof responses[0].payload.sasDir).toBe('string');
    });

    it('returns the saved config with resolved paths', async () => {
      deps = createMockDeps(createMockConfig());
      handler = new FrozenDatasetHandler(deps);
      await handler.handle(buildMsg('frozen:config:get'));
      const responses = posted(deps, 'frozen:config:get:response');
      expect(responses[0].payload.config).toMatchObject({ rootObject: 'Case' });
      expect(String(responses[0].payload.datasetDir)).toContain('dataset');
    });
  });

  describe('frozen:config:save', () => {
    it('persists a valid config to ConfigStore under the frozen category', async () => {
      const config = createMockConfig();
      await handler.handle(buildMsg('frozen:config:save', { config }));
      expect(deps.configStore.set).toHaveBeenCalledWith('frozen:config', config, 'frozen');
      const responses = posted(deps, 'frozen:config:save:response');
      expect(responses).toHaveLength(1);
      expect(responses[0].payload.success).toBe(true);
    });

    it('rejects an invalid payload with INVALID_PAYLOAD', async () => {
      await handler.handle(buildMsg('frozen:config:save', { config: { rootObject: '1nvalid!' } }));
      const errors = posted(deps, 'frozen:config:save:error');
      expect(errors).toHaveLength(1);
      expect(errors[0].payload.code).toBe('INVALID_PAYLOAD');
      expect(deps.configStore.set).not.toHaveBeenCalled();
    });
  });

  describe('frozen:select', () => {
    it('fails with CONFIG_MISSING when no config is saved', async () => {
      await handler.handle(buildMsg('frozen:select', { sourceOrgId: 'org-1' }));
      const errors = posted(deps, 'frozen:select:error');
      expect(errors).toHaveLength(1);
      expect(errors[0].payload.code).toBe('CONFIG_MISSING');
    });

    it('rejects an invalid payload with INVALID_PAYLOAD', async () => {
      await handler.handle(buildMsg('frozen:select', { sourceOrgId: '' }));
      const errors = posted(deps, 'frozen:select:error');
      expect(errors).toHaveLength(1);
      expect(errors[0].payload.code).toBe('INVALID_PAYLOAD');
    });
  });

  describe('frozen:extract', () => {
    it('fails with CONFIG_MISSING when no config is saved', async () => {
      await handler.handle(buildMsg('frozen:extract', { sourceOrgId: 'org-1' }));
      const errors = posted(deps, 'frozen:extract:error');
      expect(errors[0].payload.code).toBe('CONFIG_MISSING');
    });

    it('fails with SALT_MISSING when SANDFORGE_FROZEN_SALT is not set', async () => {
      deps = createMockDeps(createMockConfig());
      handler = new FrozenDatasetHandler(deps);
      await handler.handle(buildMsg('frozen:extract', { sourceOrgId: 'org-1' }));
      const errors = posted(deps, 'frozen:extract:error');
      expect(errors).toHaveLength(1);
      expect(errors[0].payload.code).toBe('SALT_MISSING');
      expect(String(errors[0].payload.message)).toContain('SANDFORGE_FROZEN_SALT');
    });

    it('fails with SELECTION_MISSING when the salt is set but no selection exists', async () => {
      vi.stubEnv('SANDFORGE_FROZEN_SALT', 'test-salt');
      deps = createMockDeps(createMockConfig());
      handler = new FrozenDatasetHandler(deps);
      await handler.handle(buildMsg('frozen:extract', { sourceOrgId: 'org-1' }));
      const errors = posted(deps, 'frozen:extract:error');
      expect(errors).toHaveLength(1);
      expect(errors[0].payload.code).toBe('SELECTION_MISSING');
    });
  });

  describe('frozen:load', () => {
    it('fails with CONFIG_MISSING when no config is saved', async () => {
      await handler.handle(buildMsg('frozen:load', { targetOrgId: 'org-2' }));
      const errors = posted(deps, 'frozen:load:error');
      expect(errors[0].payload.code).toBe('CONFIG_MISSING');
    });

    it('fails with NOT_INITIALIZED when the Production Guard is missing', async () => {
      deps = createMockDeps(createMockConfig());
      handler = new FrozenDatasetHandler(deps);
      await handler.handle(buildMsg('frozen:load', { targetOrgId: 'org-2' }));
      const errors = posted(deps, 'frozen:load:error');
      expect(errors).toHaveLength(1);
      expect(errors[0].payload.code).toBe('NOT_INITIALIZED');
    });
  });

  describe('frozen:verify', () => {
    it('fails with NO_LOAD when no load run was recorded', async () => {
      deps = createMockDeps(createMockConfig());
      handler = new FrozenDatasetHandler(deps);
      await handler.handle(buildMsg('frozen:verify', { targetOrgId: 'org-2' }));
      const errors = posted(deps, 'frozen:verify:error');
      expect(errors).toHaveLength(1);
      expect(errors[0].payload.code).toBe('NO_LOAD');
    });
  });

  describe('frozen:status', () => {
    it('reports an unconfigured module without salt', async () => {
      await handler.handle(buildMsg('frozen:status'));
      const responses = posted(deps, 'frozen:status:response');
      expect(responses).toHaveLength(1);
      const status = responses[0].payload.status as Record<string, unknown>;
      expect(status.configured).toBe(false);
      expect(status.salt).toEqual({ present: false });
      expect(status.selection).toBeNull();
      expect(status.manifest).toBeNull();
      expect(status.lastLoad).toBeNull();
    });

    it('reports the salt fingerprint (12 hex) when the env var is set', async () => {
      vi.stubEnv('SANDFORGE_FROZEN_SALT', 'test-salt');
      deps = createMockDeps(createMockConfig());
      handler = new FrozenDatasetHandler(deps);
      await handler.handle(buildMsg('frozen:status'));
      const responses = posted(deps, 'frozen:status:response');
      const status = responses[0].payload.status as {
        configured: boolean;
        salt: { present: boolean; fingerprint?: string };
      };
      expect(status.configured).toBe(true);
      expect(status.salt.present).toBe(true);
      expect(status.salt.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    });
  });

  describe('frozen:manifest:get', () => {
    it('responds with null manifest when no dataset was written', async () => {
      deps = createMockDeps(createMockConfig());
      handler = new FrozenDatasetHandler(deps);
      await handler.handle(buildMsg('frozen:manifest:get'));
      const responses = posted(deps, 'frozen:manifest:get:response');
      expect(responses).toHaveLength(1);
      expect(responses[0].payload.manifest).toBeNull();
    });
  });
});
