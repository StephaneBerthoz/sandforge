import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeSelectionToSas } from '../../modules/frozendataset/index.js';
import { FrozenDatasetHandler } from './FrozenDatasetHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import type { BaseMessage, FrozenProjectConfig } from '@sandforge/shared';
import { inboundRequest } from '../../test/mockFactories.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';

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
function buildMsg(type: string, payload?: unknown): InboundRequest {
  return inboundRequest({
    id: `test-${type}-${Date.now()}`,
    type,
    timestamp: Date.now(),
    ...(payload !== undefined ? { payload } : {}),
  } as BaseMessage);
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
  const mock = deps.broker.postToWebview as unknown as {
    mock: { calls: unknown[][] };
  };
  return mock.mock.calls
    .map((c) => c[0] as BaseMessage & { payload: Record<string, unknown> })
    .filter((m) => m.type === type);
}

/**
 * A small org that answers what discovery, the extractor and the selector
 * ask: two opportunities of one stage, one of them with a line item.
 *
 * Discovery here behaves as the real one does — the record id only picks the
 * root object, counts are org-wide — which is the property the first health
 * check was built without.
 */
function fakeOrg(): { conn: unknown; soqls: string[] } {
  const created = '2026-01-01T00:00:00.000Z';
  const rows: Record<string, Array<Record<string, unknown>>> = {
    Opportunity: [
      { Id: '006000000000001AAA', Name: 'Bare', StageName: 'Won', CreatedDate: created },
      { Id: '006000000000002AAA', Name: 'Full', StageName: 'Won', CreatedDate: created },
    ],
    OpportunityLineItem: [
      {
        Id: '00k000000000001AAA',
        OpportunityId: '006000000000002AAA',
        Quantity: 2,
        CreatedDate: created,
      },
    ],
  };
  const describes: Record<string, unknown> = {
    Opportunity: {
      name: 'Opportunity',
      fields: [
        { name: 'Id', type: 'id', nillable: false },
        { name: 'Name', type: 'string', nillable: false },
        { name: 'StageName', type: 'picklist', nillable: false },
        { name: 'CreatedDate', type: 'datetime', nillable: false },
      ],
      childRelationships: [
        {
          childSObject: 'OpportunityLineItem',
          field: 'OpportunityId',
          relationshipName: 'OpportunityLineItems',
          cascadeDelete: true,
        },
      ],
    },
    OpportunityLineItem: {
      name: 'OpportunityLineItem',
      fields: [
        { name: 'Id', type: 'id', nillable: false },
        {
          name: 'OpportunityId',
          type: 'reference',
          referenceTo: ['Opportunity'],
          relationshipName: 'Opportunity',
          nillable: false,
          cascadeDelete: true,
        },
        { name: 'Quantity', type: 'double', nillable: false },
        { name: 'CreatedDate', type: 'datetime', nillable: false },
      ],
      childRelationships: [],
    },
  };
  const soqls: string[] = [];
  const answer = (records: Array<Record<string, unknown>>, totalSize = records.length) => ({
    records,
    done: true,
    totalSize,
  });
  const conn = {
    describeGlobal: async () => ({
      sobjects: [
        { name: 'Opportunity', keyPrefix: '006' },
        { name: 'OpportunityLineItem', keyPrefix: '00k' },
      ],
    }),
    describe: async (name: string) => describes[name],
    queryMore: async () => answer([]),
    query: async (soql: string) => {
      soqls.push(soql);
      const count = /^SELECT COUNT\(\) FROM (\w+)/.exec(soql);
      if (count) return answer([], (rows[count[1]] ?? []).length);
      if (soql.includes('axisValue')) return answer([{ axisValue: 'Won' }]);
      if (soql.includes('Id = NULL') || soql.includes('FROM RecordType')) return answer([]);
      const table = rows[/FROM (\w+)/.exec(soql)?.[1] ?? ''] ?? [];
      const inClauses = [...soql.matchAll(/(\w+) IN \(([^)]*)\)/g)].map((m) => ({
        field: m[1],
        values: m[2].split(',').map((v) => v.trim().replace(/^'|'$/g, '')),
      }));
      const equals = [...soql.matchAll(/(\w+) = '([^']*)'/g)].map((m) => ({
        field: m[1],
        value: m[2],
      }));
      const matched = table
        .filter((r) => inClauses.every((c) => c.values.includes(String(r[c.field]))))
        .filter((r) => equals.every((e) => String(r[e.field]) === e.value))
        .sort((a, b) => String(a.Id).localeCompare(String(b.Id)));
      return answer(matched);
    },
  };
  return { conn, soqls };
}

describe('FrozenDatasetHandler', () => {
  let deps: HandlerDeps;
  let handler: FrozenDatasetHandler;
  const tmpDirs: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    deps = createMockDeps();
    handler = new FrozenDatasetHandler(deps);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

    it('reports the selection lying in the sas', async () => {
      const sasDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandforge-frozen-status-'));
      tmpDirs.push(sasDir);
      await writeSelectionToSas(sasDir, {
        roots: [
          {
            rootRecordId: '500SOURCEID000001',
            combinationKey: 'type=Problem',
            axisValues: { type: 'Problem' },
          },
        ],
        uncovered: [],
        volumetry: { measured: { Case: 1 }, total: 1, budgetMax: 2500 },
        selectedAt: '2026-09-01T08:00:00.000Z',
      });
      deps = createMockDeps({ ...createMockConfig(), sasDir });
      handler = new FrozenDatasetHandler(deps);

      await handler.handle(buildMsg('frozen:status'));

      const responses = posted(deps, 'frozen:status:response');
      expect(responses).toHaveLength(1);
      const status = responses[0].payload.status as Record<string, unknown>;
      expect(status.selection).toEqual({
        selectedAt: '2026-09-01T08:00:00.000Z',
        rootCount: 1,
        total: 1,
        budgetMax: 2500,
      });
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

  describe('against an org shaped like a real one', () => {
    /** A config over the fake org, in a sas of its own. */
    function realConfig(extra: Partial<FrozenProjectConfig> = {}): FrozenProjectConfig {
      const sasDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandforge-frozen-real-'));
      tmpDirs.push(sasDir);
      return {
        rootObject: 'Opportunity',
        axes: [
          {
            name: 'stage',
            label: 'Stage',
            filterField: 'StageName',
            valuesSoql: 'SELECT StageName axisValue FROM Opportunity GROUP BY StageName',
          },
        ],
        edgeCases: [],
        expectedObjects: ['OpportunityLineItem'],
        sasDir,
        ...extra,
      };
    }

    it('keeps the candidate whose own records hold the expected object', async () => {
      // Both candidates share one schema graph. The first check judged that
      // graph, so it could not tell them apart; judged on their records, the
      // one without a line item is turned away and the other kept.
      const { conn } = fakeOrg();
      vi.mocked(getJsforceConnection).mockResolvedValue(conn as never);
      deps = createMockDeps(realConfig());
      handler = new FrozenDatasetHandler(deps);

      await handler.handle(buildMsg('frozen:select', { sourceOrgId: 'org-1' }));

      expect(posted(deps, 'frozen:select:error')).toEqual([]);
      const selection = posted(deps, 'frozen:select:response')[0].payload.selection as {
        combinations: Array<{ combinationKey: string }>;
        uncovered: unknown[];
        volumetry: { measured: Record<string, number>; total: number };
        graph: unknown;
      };
      expect(selection.combinations.map((c) => c.combinationKey)).toEqual(['stage=Won']);
      expect(selection.uncovered).toEqual([]);
      expect(selection.volumetry.measured).toEqual({ Opportunity: 1, OpportunityLineItem: 1 });
      expect(selection.graph).toEqual({ objects: 2, truncated: false, maxNodes: 50 });
    });

    it('says why every combination went uncovered instead of failing', async () => {
      const { conn } = fakeOrg();
      vi.mocked(getJsforceConnection).mockResolvedValue(conn as never);
      deps = createMockDeps(realConfig({ expectedObjects: ['Quote'] }));
      handler = new FrozenDatasetHandler(deps);

      await handler.handle(buildMsg('frozen:select', { sourceOrgId: 'org-1' }));

      // Before: the empty list reached the extraction, which had no root to
      // start from, and the selection died with a discovery error.
      expect(posted(deps, 'frozen:select:error')).toEqual([]);
      const selection = posted(deps, 'frozen:select:response')[0].payload.selection as {
        combinations: unknown[];
        uncovered: Array<{ reason: string }>;
      };
      expect(selection.combinations).toEqual([]);
      expect(selection.uncovered[0].reason).toContain('no Quote record in this dossier');
    });

    it('discovers the graph once for the whole run', async () => {
      const { conn, soqls } = fakeOrg();
      vi.mocked(getJsforceConnection).mockResolvedValue(conn as never);
      deps = createMockDeps(realConfig());
      handler = new FrozenDatasetHandler(deps);

      await handler.handle(buildMsg('frozen:select', { sourceOrgId: 'org-1' }));

      // One count per object of the graph: two candidates and the volumetry
      // measurement all read the same one.
      expect(soqls.filter((q) => q.startsWith('SELECT COUNT()'))).toHaveLength(2);
    });

    it('holds a line to the dossier through its required opportunity', async () => {
      // The dossier's edge: a required lookup to anything but the catalog
      // keeps only rows whose parent was read. It needs each field's
      // `nillable`, which this adapter once dropped while Forge's passed it.
      const { conn, soqls } = fakeOrg();
      vi.mocked(getJsforceConnection).mockResolvedValue(conn as never);
      deps = createMockDeps(realConfig());
      handler = new FrozenDatasetHandler(deps);

      await handler.handle(buildMsg('frozen:select', { sourceOrgId: 'org-1' }));

      const lineReads = soqls.filter((q) => /FROM OpportunityLineItem WHERE/.test(q));
      expect(lineReads.length).toBeGreaterThan(0);
      for (const q of lineReads) expect(q).toContain('AND (OpportunityId IN (');
    });
    it('leaves out the objects the configuration names', async () => {
      const { conn, soqls } = fakeOrg();
      vi.mocked(getJsforceConnection).mockResolvedValue(conn as never);
      deps = createMockDeps(
        realConfig({ expectedObjects: [], excludedObjects: ['OpportunityLineItem'] }),
      );
      handler = new FrozenDatasetHandler(deps);

      await handler.handle(buildMsg('frozen:select', { sourceOrgId: 'org-1' }));

      expect(soqls.some((q) => /FROM OpportunityLineItem WHERE/.test(q))).toBe(false);
      const selection = posted(deps, 'frozen:select:response')[0].payload.selection as {
        volumetry: { measured: Record<string, number> };
      };
      expect(selection.volumetry.measured).toEqual({ Opportunity: 1 });
    });

    it('refuses to extract from a selection that kept no root', async () => {
      vi.stubEnv('SANDFORGE_FROZEN_SALT', 'test-salt');
      const config = realConfig();
      await writeSelectionToSas(config.sasDir as string, {
        roots: [],
        uncovered: [{ combinationKey: 'stage=Won', reason: 'no candidate record' }],
        volumetry: { measured: {}, total: 0, budgetMax: 2500 },
        selectedAt: '2026-09-01T08:00:00.000Z',
      });
      deps = createMockDeps(config);
      handler = new FrozenDatasetHandler(deps);

      await handler.handle(buildMsg('frozen:extract', { sourceOrgId: 'org-1' }));

      const errors = posted(deps, 'frozen:extract:error');
      expect(errors).toHaveLength(1);
      expect(errors[0].payload.code).toBe('SELECTION_EMPTY');
    });

    it('records in the manifest how far the extraction reached', async () => {
      vi.stubEnv('SANDFORGE_FROZEN_SALT', 'test-salt');
      const { conn } = fakeOrg();
      vi.mocked(getJsforceConnection).mockResolvedValue(conn as never);
      const config = realConfig({ maxNodes: 10 });
      const sasDir = config.sasDir as string;
      await writeSelectionToSas(sasDir, {
        roots: [
          {
            rootRecordId: '006000000000002AAA',
            combinationKey: 'stage=Won',
            axisValues: { stage: 'Won' },
          },
        ],
        uncovered: [],
        volumetry: {
          measured: { Opportunity: 1, OpportunityLineItem: 1 },
          total: 2,
          budgetMax: 2500,
        },
        selectedAt: '2026-09-01T08:00:00.000Z',
      });
      fs.writeFileSync(
        path.join(sasDir, 'rules.json'),
        JSON.stringify({
          rulesVersion: '1.0.0',
          rules: { 'Opportunity.Name': { generator: 'companyName' } },
        }),
      );
      deps = createMockDeps(config);
      handler = new FrozenDatasetHandler(deps);

      await handler.handle(buildMsg('frozen:extract', { sourceOrgId: 'org-1' }));

      expect(posted(deps, 'frozen:extract:error')).toEqual([]);
      const manifest = posted(deps, 'frozen:extract:response')[0].payload.manifest as {
        coverage: unknown;
      };
      expect(manifest.coverage).toEqual({
        objects: 2,
        truncated: false,
        maxNodes: 10,
        unboundedObjects: [],
        filesLeftOut: [],
      });
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
