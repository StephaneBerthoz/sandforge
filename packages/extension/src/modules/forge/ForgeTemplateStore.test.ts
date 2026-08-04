import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForgeTemplateStore } from './ForgeTemplateStore.js';
import type { ForgeTemplate } from '@sandforge/shared';

const mockReadFile = vi.fn<[path: string], Promise<string>>();
const mockWriteFile = vi.fn<[path: string, content: string], Promise<void>>();
const mockMkdir = vi.fn<[path: string], Promise<void>>();

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
