import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForgeHandler } from './ForgeHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import type { BaseMessage, ForgeTemplate } from '@sandforge/shared';
import { ForgeTemplateStore } from '../../modules/forge/ForgeTemplateStore.js';
import { ConfigProfileManager } from '../../core/config/ConfigProfileManager.js';
import { importedTemplatesFor } from '../../core/config/importedForgeTemplates.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
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

/**
 * In-memory stand-in for the workspace file, keyed by path; while `writable`
 * answers false, a write fails as it does on a read-only workspace.
 */
function createFakeFs(
  folder = '/ws',
  writable: () => boolean = () => true,
): {
  files: Map<string, string>;
  store: ForgeTemplateStore;
} {
  const files = new Map<string, string>();
  const store = new ForgeTemplateStore({
    workspacePath: folder,
    readFile: async (p) => {
      const content = files.get(p);
      if (content === undefined) throw new Error('ENOENT');
      return content;
    },
    writeFile: async (p, content) => {
      if (!writable()) throw new Error(`EROFS: read-only file system, open '${p}'`);
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

  it('leaves out of a workspace whose file is empty the templates the ConfigStore keeps', async () => {
    // A workspace read empty took the ConfigStore's list, for templates kept
    // there before the file existed. No release saved any there before then:
    // what it took was another window's templates, which this project was
    // never saved to.
    deps.configStore.set('forge:templates', [template('elsewhere')], 'forge');
    const { files, store } = createFakeFs();
    const handler = new ForgeHandler(deps);
    withStore(handler, store);

    await handler.handle(msg('forge:templates:list', {}));

    const [listed] = vi.mocked(deps.broker.postToWebview).mock.calls[0] as [
      BaseMessage & { payload: { templates: ForgeTemplate[] } },
    ];
    expect(listed.payload.templates).toEqual([]);
    expect(files.size).toBe(0);
    expect(deps.configStore.get('forge:templates')).toEqual([template('elsewhere')]);
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

  it('answers the template list from a workspace file that holds no list', async () => {
    // A file holding a string reached the list as one: the handler threw on
    // it, and the page got no answer.
    const { files, store } = createFakeFs();
    files.set(TEMPLATES_FILE, JSON.stringify('forge templates'));
    const handler = new ForgeHandler(deps);
    withStore(handler, store);

    await handler.handle(msg('forge:templates:list', {}));

    const listed = vi.mocked(deps.broker.postToWebview).mock.calls[0]?.[0] as BaseMessage & {
      payload: { templates: ForgeTemplate[] };
    };
    expect(listed.type).toBe('forge:templates:list:response');
    expect(listed.payload.templates).toEqual([]);
  });

  it('saves a template over a workspace file that holds an object', async () => {
    const { files, store } = createFakeFs();
    files.set(TEMPLATES_FILE, JSON.stringify({ id: 'not-a-list' }));
    const handler = new ForgeHandler(deps);
    withStore(handler, store);

    await handler.handle(msg('forge:templates:save', { template: template('t6') }));

    const posted = vi.mocked(deps.broker.postToWebview).mock.calls.map((c) => c[0] as BaseMessage);
    expect(posted.map((p) => p.type)).toEqual(['forge:templates:save:response']);
    const saved = JSON.parse(files.get(TEMPLATES_FILE) as string) as Array<{
      id: string;
    }>;
    expect(saved.map((t) => t.id)).toEqual(['t6']);
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

  it('answers the template list of a window with no folder open whose ConfigStore holds no list', async () => {
    // A profile import wrote whatever the profile carried under the key: a
    // value that is no list threw on the list the page asked for, past the
    // router, and the page got no answer.
    deps.configStore.set('forge:templates', { id: 'not-a-list' }, 'forge');
    const handler = new ForgeHandler(deps);
    handler.setForgeOrchestrator({ on: vi.fn() } as never, {});

    await handler.handle(msg('forge:templates:list', {}));

    const [listed] = vi.mocked(deps.broker.postToWebview).mock.calls[0] as [
      BaseMessage & { payload: { templates: ForgeTemplate[] } },
    ];
    expect(listed.type).toBe('forge:templates:list:response');
    expect(listed.payload.templates).toEqual([]);
  });
});

describe('forge templates a profile imported', () => {
  /** One window: its Forge handler, and what its Settings page exports and imports. */
  /** What the window's Forge answers the page's template list with. */
  interface ListAnswer {
    templates: ForgeTemplate[];
    importNotMerged?: string;
  }

  interface Window {
    handler: ForgeHandler;
    configStore: ConfigStore;
    /** The profiles of this window, as its Settings page builds them. */
    profiles: ConfigProfileManager;
    /** The answer to the page's template list; the list must be answered. */
    answer: () => Promise<ListAnswer>;
    /** The templates the window's Forge lists, as `id:name`. */
    listed: () => Promise<string[]>;
    /** The ids its workspace file holds. */
    inFile: () => string[];
  }

  /**
   * A window whose workspace file, at `folder`, holds `inFile`, over the
   * ConfigStore every window shares; with no folder, a window whose Forge
   * keeps its templates in the ConfigStore. While `writable` answers false,
   * the workspace refuses every write.
   */
  function workspaceWith(
    inFile: ForgeTemplate[],
    options: {
      folder?: string | null;
      configStore?: ConfigStore;
      writable?: () => boolean;
    } = {},
  ): Window {
    const folder = options.folder === undefined ? '/ws' : options.folder;
    const configStore = options.configStore ?? new ConfigStore(new InMemoryConfigStoreBackend());
    const handlerDeps = { ...createDeps(), configStore } as HandlerDeps;
    const handler = new ForgeHandler(handlerDeps);
    const { files, store } = createFakeFs(folder ?? '/ws', options.writable);
    const file = path.join(folder ?? '/ws', '.sandforge', 'forge-templates.json');
    let profiles: ConfigProfileManager;
    if (folder === null) {
      handler.setForgeOrchestrator({ on: vi.fn() } as never, {});
      profiles = new ConfigProfileManager(configStore);
    } else {
      files.set(file, JSON.stringify(inFile));
      withStore(handler, store);
      profiles = new ConfigProfileManager(configStore, {
        folder,
        readTemplates: () => store.list(),
      });
    }
    const answer = async (): Promise<ListAnswer> => {
      vi.mocked(handlerDeps.broker.postToWebview).mockClear();
      await handler.handle(msg('forge:templates:list', {}));
      const [response] = vi.mocked(handlerDeps.broker.postToWebview).mock.calls[0] as [
        BaseMessage & { payload: ListAnswer },
      ];
      expect(response.type).toBe('forge:templates:list:response');
      return response.payload;
    };
    const listed = async (): Promise<string[]> =>
      (await answer()).templates.map((t) => `${t.id}:${t.name}`);
    const inFileIds = (): string[] =>
      (JSON.parse(files.get(file) ?? '[]') as ForgeTemplate[]).map((t) => t.id);
    return { handler, configStore, profiles, answer, listed, inFile: inFileIds };
  }

  /** A profile carrying `templates` as its Forge plans, as an export writes it. */
  function profileOf(templates: ForgeTemplate[]): string {
    return JSON.stringify({
      version: '1.0.0',
      exportedAt: '2026-09-01T00:00:00.000Z',
      categories: ['forgePlans'],
      data: { forgePlans: { 'forge:templates': templates } },
    });
  }

  it('without overwrite, lists them beside the workspace file’s own, the file’s copy winning on an id both hold', async () => {
    // The file's templates used to hide an imported set: it was read only in
    // a workspace whose file was empty. And an import without overwrite
    // skipped the whole category once the ConfigStore held `forge:templates`,
    // which it does as soon as a window with no folder open saved a template.
    const configStore = new ConfigStore(new InMemoryConfigStoreBackend());
    const ws = workspaceWith(
      [{ ...template('shared'), name: 'kept from the file' }, template('a')],
      { configStore },
    );
    const noFolder = workspaceWith([], { folder: null, configStore });
    await noFolder.handler.handle(msg('forge:templates:save', { template: template('t') }));
    await ws.profiles.importProfile(
      profileOf([{ ...template('shared'), name: 'from the profile' }, template('b')]),
      false,
    );

    expect(await ws.listed()).toEqual(['shared:kept from the file', 'a:recipe-a', 'b:recipe-b']);
    expect(ws.inFile()).toEqual(['shared', 'a', 'b']);
  });

  it('with overwrite, lists an imported template in place of the file’s own of its id', async () => {
    const ws = workspaceWith([
      { ...template('shared'), name: 'kept from the file' },
      template('a'),
    ]);
    await ws.profiles.importProfile(
      profileOf([{ ...template('shared'), name: 'from the profile' }, template('b')]),
      true,
    );

    expect(await ws.listed()).toEqual(['shared:from the profile', 'a:recipe-a', 'b:recipe-b']);
    expect(ws.inFile()).toEqual(['shared', 'a', 'b']);
  });

  it('merges an imported set once: a template deleted afterwards stays deleted', async () => {
    const ws = workspaceWith([template('a')]);
    await ws.profiles.importProfile(profileOf([template('b')]));
    expect(await ws.listed()).toEqual(['a:recipe-a', 'b:recipe-b']);

    await ws.handler.handle(msg('forge:templates:delete', { templateId: 'b' }));

    expect(await ws.listed()).toEqual(['a:recipe-a']);
  });

  it('leaves out of the workspace the templates the ConfigStore keeps', async () => {
    // The ConfigStore's `forge:templates` holds the templates of the windows
    // with no folder open, and up to 1.36 any window's list: merging it in
    // would write into this project's file templates it was never saved to.
    const ws = workspaceWith([template('a')]);
    ws.configStore.set('forge:templates', [template('elsewhere')], 'forge');

    expect(await ws.listed()).toEqual(['a:recipe-a']);
    expect(ws.inFile()).toEqual(['a']);
  });

  it('leaves a set imported in one workspace to that workspace’s window, whichever lists first', async () => {
    // The first window to list its templates merged the set, whatever project
    // it was on: this project's templates were written into another's file.
    const configStore = new ConfigStore(new InMemoryConfigStoreBackend());
    const here = workspaceWith([template('a')], { folder: '/ws', configStore });
    const elsewhere = workspaceWith([template('x')], { folder: '/other', configStore });
    await here.profiles.importProfile(profileOf([template('b')]));

    expect(await elsewhere.listed()).toEqual(['x:recipe-x']);
    expect(elsewhere.inFile()).toEqual(['x']);

    expect(await here.listed()).toEqual(['a:recipe-a', 'b:recipe-b']);
    expect(here.inFile()).toEqual(['a', 'b']);
  });

  it('exports from a workspace the templates its file holds, not those the ConfigStore keeps', async () => {
    // The export read the ConfigStore's `forge:templates`, which every window
    // wrote its list to, and which holds the templates of the windows with no
    // folder open.
    const configStore = new ConfigStore(new InMemoryConfigStoreBackend());
    const here = workspaceWith([template('a')], { folder: '/ws', configStore });
    const noFolder = workspaceWith([], { folder: null, configStore });
    await noFolder.handler.handle(msg('forge:templates:save', { template: template('x') }));

    const exported = JSON.parse(
      (await here.profiles.exportProfile(['forgePlans'])).json as string,
    ) as { data: { forgePlans: { 'forge:templates': ForgeTemplate[] } } };

    expect(exported.data.forgePlans['forge:templates'].map((t) => t.id)).toEqual(['a']);
  });

  it('in a window with no folder open, adds them to the templates its Forge lists', async () => {
    // The import wrote the profile's list over the ConfigStore's, which such
    // a window lists from: every template the profile did not carry was gone.
    const ws = workspaceWith([], { folder: null });
    await ws.handler.handle(msg('forge:templates:save', { template: template('a') }));
    await ws.profiles.importProfile(profileOf([template('b')]));

    expect(await ws.listed()).toEqual(['a:recipe-a', 'b:recipe-b']);
  });

  it('answers the list with what the file holds, and why, while the file refuses the imported templates', async () => {
    // A merge the workspace refused threw past the router: the page waited out
    // its timeout on every list, for as long as the set waited.
    let writable = false;
    const ws = workspaceWith([template('a')], { writable: () => writable });
    await ws.profiles.importProfile(profileOf([template('b')]));

    const refused = await ws.answer();
    expect(refused.templates.map((t) => t.id)).toEqual(['a']);
    expect(refused.importNotMerged).toContain('EROFS');
    expect(importedTemplatesFor(ws.configStore, '/ws')?.templates.map((t) => t.id)).toEqual(['b']);

    writable = true;
    const merged = await ws.answer();
    expect(merged.templates.map((t) => t.id)).toEqual(['a', 'b']);
    expect(merged.importNotMerged).toBeUndefined();
    expect(importedTemplatesFor(ws.configStore, '/ws')).toBeUndefined();
  });

  it('keeps the templates of a window with no folder open when a workspace saves its own', async () => {
    // A window with a folder open wrote its list over the ConfigStore's, where
    // a window with no folder open keeps its templates: they were gone at the
    // next save in any project.
    const configStore = new ConfigStore(new InMemoryConfigStoreBackend());
    const noFolder = workspaceWith([], { folder: null, configStore });
    const project = workspaceWith([template('p')], { configStore });
    await noFolder.handler.handle(msg('forge:templates:save', { template: template('t') }));

    await project.handler.handle(msg('forge:templates:save', { template: template('q') }));

    expect(await noFolder.listed()).toEqual(['t:recipe-t']);
    expect(project.inFile()).toEqual(['p', 'q']);
  });
});
