import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForgeHandler } from './ForgeHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import type { BaseMessage, ForgeTemplate } from '@sandforge/shared';
import { ForgeTemplateStore } from '../../modules/forge/ForgeTemplateStore.js';
import { inboundRequest } from '../../test/mockFactories.js';

/** Where the store keeps its file, built as it builds it: a Windows path on Windows. */
const TEMPLATES_FILE = path.join('/ws', '.sandforge', 'forge-templates.json');

/**
 * Forge recipes must be portable.
 *
 * ForgeTemplateStore writes `.sandforge/forge-templates.json` inside the
 * workspace — a file a team can commit and share. Composition built it and
 * passed it to setForgeOrchestrator, which assigned planGenerator,
 * complianceService and metadataDiff and silently dropped templateStore: the
 * class had no field for it. Every saved recipe went to VSCode globalState
 * instead, so it lived on one machine and could not be reviewed or shared.
 */

/** In-memory stand-in for the workspace file, keyed by path. */
function createFakeFs(): {
  files: Map<string, string>;
  store: ForgeTemplateStore;
} {
  const files = new Map<string, string>();
  const store = new ForgeTemplateStore({
    workspacePath: '/ws',
    readFile: async (p) => {
      const content = files.get(p);
      if (content === undefined) throw new Error('ENOENT');
      return content;
    },
    writeFile: async (p, content) => {
      files.set(p, content);
    },
    mkdir: async () => undefined,
  });
  return { files, store };
}

function createDeps(): HandlerDeps {
  const values = new Map<string, unknown>();
  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
    stateSync: {} as HandlerDeps['stateSync'],
    orgManager: { getOrg: vi.fn() } as unknown as HandlerDeps['orgManager'],
    orgRegistry: {} as unknown as HandlerDeps['orgRegistry'],
    configStore: {
      get: <T>(key: string) => values.get(key) as T | undefined,
      set: (key: string, value: unknown) => values.set(key, value),
    } as unknown as HandlerDeps['configStore'],
    secretVault: {} as HandlerDeps['secretVault'],
    authProvider: {} as HandlerDeps['authProvider'],
    sfdxBridge: {} as HandlerDeps['sfdxBridge'],
    nextId: () => 'gen',
  };
}

function template(id: string): ForgeTemplate {
  // Must satisfy forgeTemplateSchema — the save handler validates the payload
  // before it ever reaches the store.
  return {
    id,
    name: `recipe-${id}`,
    description: '',
    config: {
      inputMode: 'record',
      depth: 'direct',
      anonymizePII: false,
      skipEmpty: false,
      batchSize: 'auto',
    },
    objectCount: 1,
    recordCount: 10,
    createdAt: '2026-01-01T00:00:00Z',
    lastUsedAt: '2026-01-01T00:00:00Z',
  } as unknown as ForgeTemplate;
}

function msg(type: string, payload: Record<string, unknown>): InboundRequest {
  return inboundRequest({
    id: 'req-1',
    type,
    timestamp: Date.now(),
    payload,
  } as BaseMessage);
}

/** Attach a template store the way composition does. */
function withStore(handler: ForgeHandler, store: ForgeTemplateStore): void {
  handler.setForgeOrchestrator({ on: vi.fn() } as never, {
    templateStore: store,
  });
}

describe('forge template portability', () => {
  let deps: HandlerDeps;

  beforeEach(() => {
    deps = createDeps();
  });

  it('writes a saved recipe into the workspace file', async () => {
    const { files, store } = createFakeFs();
    const handler = new ForgeHandler(deps);
    withStore(handler, store);

    await handler.handle(msg('forge:templates:save', { template: template('t1') }));

    const written = Array.from(files.keys());
    expect(written).toHaveLength(1);
    expect(written[0]).toContain('.sandforge');
    expect(JSON.parse(files.get(written[0]) as string)).toHaveLength(1);
  });

  it('migrates recipes saved before the file store existed', async () => {
    // Nobody may lose a recipe to the storage change.
    deps.configStore.set('forge:templates', [template('legacy')], 'forge');
    const { files, store } = createFakeFs();
    const handler = new ForgeHandler(deps);
    withStore(handler, store);

    await handler.handle(msg('forge:templates:list', {}));

    const written = Array.from(files.values());
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0])[0].id).toBe('legacy');
  });

  it('writes the target org and the anonymization a template carries', async () => {
    const { files, store } = createFakeFs();
    const handler = new ForgeHandler(deps);
    withStore(handler, store);
    const saved = {
      ...template('t3'),
      targetOrgId: 'org-target',
      anonymization: { presetId: 'preset:gdpr-default', rules: { email: 'hash' } },
    };

    await handler.handle(msg('forge:templates:save', { template: saved }));

    const [written] = JSON.parse(Array.from(files.values())[0]) as ForgeTemplate[];
    expect(written.targetOrgId).toBe('org-target');
    expect(written.anonymization).toEqual({
      presetId: 'preset:gdpr-default',
      rules: { email: 'hash' },
    });
  });

  it('lists only the entries that read as templates, and keeps the others in the file', async () => {
    // The file is committed and edited by hand; an entry another version wrote
    // must not reach a form that would run it, nor be lost on the next save.
    const { files, store } = createFakeFs();
    const handEdited = { id: 'broken', name: 'no config at all' };
    files.set(TEMPLATES_FILE, JSON.stringify([template('ok'), handEdited]));
    const handler = new ForgeHandler(deps);
    withStore(handler, store);

    await handler.handle(msg('forge:templates:list', {}));
    const listed = vi.mocked(deps.broker.postToWebview).mock.calls[0][0] as BaseMessage & {
      payload: { templates: ForgeTemplate[] };
    };
    expect(listed.payload.templates.map((t) => t.id)).toEqual(['ok']);

    await handler.handle(msg('forge:templates:save', { template: template('new') }));
    const ids = (
      JSON.parse(files.get(TEMPLATES_FILE) as string) as Array<{
        id: string;
      }>
    ).map((t) => t.id);
    expect(ids).toContain('broken');
    expect(ids).toContain('new');
  });

  it('answers a save the workspace refuses on the save error channel', async () => {
    const handler = new ForgeHandler(deps);
    handler.setForgeOrchestrator({ on: vi.fn() } as never, {
      templateStore: new ForgeTemplateStore({
        workspacePath: '/ws',
        readFile: async () => '[]',
        writeFile: async () => {
          throw new Error('EROFS: read-only file system');
        },
        mkdir: async () => undefined,
      }),
    });

    await handler.handle(msg('forge:templates:save', { template: template('t4') }));

    const posted = vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map((c) => c[0] as BaseMessage & { payload: { message: string } });
    expect(posted).toHaveLength(1);
    expect(posted[0].type).toBe('forge:templates:save:error');
    expect(posted[0].correlationId).toBe('req-1');
    expect(posted[0].payload.message).toContain('read-only');
  });

  it('answers a delete the workspace refuses on the delete error channel', async () => {
    const handler = new ForgeHandler(deps);
    handler.setForgeOrchestrator({ on: vi.fn() } as never, {
      templateStore: new ForgeTemplateStore({
        workspacePath: '/ws',
        readFile: async () => JSON.stringify([template('t5')]),
        writeFile: async () => {
          throw new Error('EACCES: permission denied');
        },
        mkdir: async () => undefined,
      }),
    });

    await handler.handle(msg('forge:templates:delete', { templateId: 't5' }));

    const posted = vi.mocked(deps.broker.postToWebview).mock.calls.map((c) => c[0] as BaseMessage);
    expect(posted.map((p) => [p.type, p.correlationId])).toEqual([
      ['forge:templates:delete:error', 'req-1'],
    ]);
  });

  it('falls back to ConfigStore when no folder is open', async () => {
    // A folderless window has no `.sandforge/` to write into; composition does
    // not build the store at all, and saving must still work.
    const handler = new ForgeHandler(deps);
    handler.setForgeOrchestrator({ on: vi.fn() } as never, {});

    await handler.handle(msg('forge:templates:save', { template: template('t2') }));

    expect(deps.configStore.get<unknown[]>('forge:templates')).toHaveLength(1);
  });
});
