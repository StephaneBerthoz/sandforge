import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForgeTemplateStore } from './ForgeTemplateStore.js';
import type { ForgeTemplate } from '@sandforge/shared';

const mockReadFile = vi.fn<(path: string) => Promise<string>>();
const mockWriteFile = vi.fn<(path: string, content: string) => Promise<void>>();
const mockMkdir = vi.fn<(path: string) => Promise<void>>();

function createStore(): ForgeTemplateStore {
  return new ForgeTemplateStore({
    workspacePath: '/workspace',
    readFile: mockReadFile,
    writeFile: mockWriteFile,
    mkdir: mockMkdir,
  });
}

const sampleTemplate: ForgeTemplate = {
  id: 'tpl-1',
  name: 'Test Template',
  description: 'A test template',
  config: {
    inputMode: 'record',
    depth: 'direct',
    anonymizePII: false,
    skipEmpty: false,
    batchSize: 'auto',
  },
  objectCount: 1,
  recordCount: 100,
  createdAt: '2026-01-01T00:00:00Z',
  lastUsedAt: '2026-01-01T00:00:00Z',
};

describe('ForgeTemplateStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
  });

  it('should return empty array when file does not exist', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));
    const store = createStore();
    const result = await store.list();
    expect(result).toEqual([]);
  });

  it('should parse existing templates from file', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify([sampleTemplate]));
    const store = createStore();
    const result = await store.list();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('tpl-1');
  });

  it.each([
    ['an object', JSON.stringify({ templates: [sampleTemplate] })],
    ['a template on its own', JSON.stringify(sampleTemplate)],
    ['a string', JSON.stringify('tpl-1')],
    ['a number', '42'],
    ['null', 'null'],
  ])('reads a file holding %s as holding no template', async (_what, content) => {
    mockReadFile.mockResolvedValue(content);
    const store = createStore();
    expect(await store.list()).toEqual([]);
  });

  it('leaves out the entries no template operation can address, and keeps every entry with an id', async () => {
    // An entry another version wrote, or one edited by hand, keeps its place:
    // the handler leaves it out of the list the page gets.
    const handEdited = { id: 'broken', name: 'no config at all' };
    mockReadFile.mockResolvedValue(
      JSON.stringify([
        null,
        7,
        'tpl-2',
        [],
        { name: 'no id' },
        { id: '' },
        sampleTemplate,
        handEdited,
      ]),
    );
    const store = createStore();
    expect(await store.list()).toEqual([sampleTemplate, handEdited]);
  });

  it('saves over a file holding an object, rather than failing on it', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ id: 'tpl-0' }));
    const store = createStore();
    await store.save(sampleTemplate);
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string) as ForgeTemplate[];
    expect(written).toEqual([sampleTemplate]);
  });

  it('deletes from a list holding a null entry, rather than failing on it', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify([null, sampleTemplate]));
    const store = createStore();
    await store.delete('tpl-1');
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string) as ForgeTemplate[];
    expect(written).toEqual([]);
  });

  it('should save a new template to file', async () => {
    mockReadFile.mockResolvedValue('[]');
    const store = createStore();
    await store.save(sampleTemplate);
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string) as ForgeTemplate[];
    expect(written).toHaveLength(1);
    expect(written[0].id).toBe('tpl-1');
  });

  it('should update an existing template by id', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify([sampleTemplate]));
    const store = createStore();
    const updated = { ...sampleTemplate, name: 'Updated' };
    await store.save(updated);
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string) as ForgeTemplate[];
    expect(written).toHaveLength(1);
    expect(written[0].name).toBe('Updated');
  });

  it('should delete a template by id', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify([sampleTemplate]));
    const store = createStore();
    await store.delete('tpl-1');
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string) as ForgeTemplate[];
    expect(written).toHaveLength(0);
  });

  describe('merge', () => {
    it('adds the templates whose id the file does not hold, and keeps the file’s own on one it does', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify([sampleTemplate]));
      const store = createStore();

      const merged = await store.merge([
        { ...sampleTemplate, name: 'imported copy' },
        { ...sampleTemplate, id: 'tpl-2', name: 'Imported' },
      ]);

      expect(merged.map((t) => [t.id, t.name])).toEqual([
        ['tpl-1', 'Test Template'],
        ['tpl-2', 'Imported'],
      ]);
      expect(mockWriteFile).toHaveBeenCalledTimes(1);
      expect(JSON.parse(mockWriteFile.mock.calls[0][1])).toEqual(merged);
    });

    it('drops what no template operation could address, and a second entry of one id', async () => {
      mockReadFile.mockResolvedValue('[]');
      const store = createStore();

      const merged = await store.merge([
        null,
        'tpl-3',
        { name: 'no id' },
        { ...sampleTemplate, id: 'tpl-3' },
        { ...sampleTemplate, id: 'tpl-3', name: 'second of the id' },
      ]);

      expect(merged.map((t) => [t.id, t.name])).toEqual([['tpl-3', 'Test Template']]);
    });

    it('writes nothing when the file holds every id already', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify([sampleTemplate]));
      const store = createStore();

      expect(await store.merge([{ ...sampleTemplate, name: 'imported copy' }])).toEqual([
        sampleTemplate,
      ]);
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('puts a template whose id is replacing in place of the file’s own', async () => {
      // What an import with "overwrite" brought: the file kept its own copy.
      const second = { ...sampleTemplate, id: 'tpl-2', name: 'Second' };
      mockReadFile.mockResolvedValue(JSON.stringify([sampleTemplate, second]));
      const store = createStore();

      const merged = await store.merge(
        [
          { ...sampleTemplate, name: 'imported copy' },
          { ...second, name: 'not replacing' },
        ],
        new Set(['tpl-1']),
      );

      expect(merged.map((t) => [t.id, t.name])).toEqual([
        ['tpl-1', 'imported copy'],
        ['tpl-2', 'Second'],
      ]);
      expect(JSON.parse(mockWriteFile.mock.calls[0][1])).toEqual(merged);
    });

    it('writes nothing when a replacing template is the one the file holds', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify([sampleTemplate]));
      const store = createStore();

      await store.merge([{ ...sampleTemplate }], new Set(['tpl-1']));

      expect(mockWriteFile).not.toHaveBeenCalled();
    });
  });

  it('names the workspace folder its file lives in', () => {
    expect(createStore().workspacePath).toBe('/workspace');
  });

  it('should use .sandforge/forge-templates.json path', async () => {
    mockReadFile.mockResolvedValue('[]');
    const store = createStore();
    await store.list();
    // path.join uses platform separator — test resilient to win32 vs posix.
    const expected = ['workspace', '.sandforge', 'forge-templates.json'];
    const actual = (mockReadFile.mock.calls[0]?.[0] as string).replace(/^[/\\]/, '').split(/[/\\]/);
    expect(actual).toEqual(expected);
  });

  it('should create directory before writing', async () => {
    mockReadFile.mockResolvedValue('[]');
    const store = createStore();
    await store.save(sampleTemplate);
    const expected = ['workspace', '.sandforge'];
    const actual = (mockMkdir.mock.calls[0]?.[0] as string).replace(/^[/\\]/, '').split(/[/\\]/);
    expect(actual).toEqual(expected);
  });
});
