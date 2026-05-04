import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TelemetryAdapter } from '../telemetry/TelemetryAdapter.js';
import { FsAdapter } from './FsAdapter.js';

function fakeTelemetry(): TelemetryAdapter & { addBreadcrumb: ReturnType<typeof vi.fn> } {
  return {
    addBreadcrumb: vi.fn(),
    captureException: vi.fn(),
    getLogger: vi.fn(),
    setUser: vi.fn(),
    flush: vi.fn(),
    isEnabled: vi.fn(() => false),
  } as unknown as TelemetryAdapter & { addBreadcrumb: ReturnType<typeof vi.fn> };
}

async function mktemp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'sandforge-fsadapter-'));
}

describe('FsAdapter', () => {
  let root: string;
  let telemetry: ReturnType<typeof fakeTelemetry>;
  let adapter: FsAdapter;

  beforeEach(async () => {
    root = await mktemp();
    telemetry = fakeTelemetry();
    adapter = new FsAdapter(telemetry);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  describe('readFile / writeFile roundtrip', () => {
    it('writes and reads a file via relative paths inside workspace', async () => {
      await adapter.writeFile('hello.txt', 'world', root);
      const content = await adapter.readFile('hello.txt', root);
      expect(content).toBe('world');
    });

    it('writeFile creates missing parent directories', async () => {
      await adapter.writeFile('nested/a/b/c.txt', 'deep', root);
      const content = await adapter.readFile('nested/a/b/c.txt', root);
      expect(content).toBe('deep');
    });
  });

  describe('path traversal guards', () => {
    it('readFile refuses a relative path that escapes via ../', async () => {
      await expect(adapter.readFile('../../etc/passwd', root)).rejects.toThrow(
        /escapes workspace root/,
      );
      expect(telemetry.addBreadcrumb).toHaveBeenCalledWith(
        expect.stringContaining('fs-path-traversal'),
        'fs',
        'error',
      );
    });

    it('readFile refuses a backslash-style traversal on Windows-like input', async () => {
      await expect(adapter.readFile('..\\..\\Windows\\System32\\config', root)).rejects.toThrow(
        /escapes workspace root/,
      );
    });

    it('writeFile refuses an absolute path that escapes the root', async () => {
      const outside = path.isAbsolute('/tmp/attack.txt')
        ? '/tmp/attack.txt'
        : 'C:\\temp\\attack.txt';
      await expect(adapter.writeFile(outside, 'leak', root)).rejects.toThrow(
        /escapes workspace root/,
      );
      // file must NOT have been created
      await expect(fs.access(outside)).rejects.toThrow();
    });

    it('writeFile refuses a relative ../ escape and does not create the file', async () => {
      const parentDir = path.dirname(root);
      await expect(adapter.writeFile('../leaked.txt', 'bad', root)).rejects.toThrow(/escapes/);
      const candidate = path.join(parentDir, 'leaked.txt');
      await expect(fs.access(candidate)).rejects.toThrow();
    });
  });

  describe('exists', () => {
    it('returns true when the path exists', async () => {
      const p = path.join(root, 'there.txt');
      await fs.writeFile(p, 'x');
      expect(await adapter.exists(p)).toBe(true);
    });

    it('returns false when the path is missing', async () => {
      const p = path.join(root, 'nope.txt');
      expect(await adapter.exists(p)).toBe(false);
    });
  });

  describe('stat', () => {
    it('returns a Stats object with an mtime for an existing file', async () => {
      const p = path.join(root, 'dated.txt');
      await fs.writeFile(p, 'x');
      const stats = await adapter.stat(p);
      expect(stats.isFile()).toBe(true);
      expect(stats.mtime).toBeInstanceOf(Date);
    });

    it('rethrows and breadcrumbs on stat of a missing path', async () => {
      const p = path.join(root, 'missing');
      await expect(adapter.stat(p)).rejects.toThrow();
      expect(telemetry.addBreadcrumb).toHaveBeenCalledWith(
        expect.stringContaining('fs-error'),
        'fs',
        'error',
      );
    });
  });
});
