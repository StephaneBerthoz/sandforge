import { promises as fs, type Stats } from 'node:fs';
import * as path from 'node:path';
import type { TelemetryAdapter } from '../telemetry/TelemetryAdapter.js';

/**
 * FsAdapter — safe filesystem IO wrapper.
 *
 * Every read/write is constrained to stay inside the caller-provided
 * `workspaceRoot`. Any attempt to escape the root via `..` or absolute paths
 * throws before touching disk. All fs errors are tagged with a telemetry
 * breadcrumb before being rethrown so observability captures failed IO.
 */
export class FsAdapter {
  private readonly telemetry: TelemetryAdapter;

  constructor(telemetry: TelemetryAdapter) {
    this.telemetry = telemetry;
  }

  /** Read a UTF-8 file constrained to `workspaceRoot`. */
  async readFile(relPath: string, workspaceRoot: string): Promise<string> {
    const absolute = this.resolveSafe(relPath, workspaceRoot, 'readFile');
    try {
      return await fs.readFile(absolute, 'utf8');
    } catch (err) {
      this.breadcrumbError('readFile', absolute, err);
      throw err;
    }
  }

  /** Write a UTF-8 file constrained to `workspaceRoot`. Creates parent dirs if needed. */
  async writeFile(relPath: string, content: string, workspaceRoot: string): Promise<void> {
    const absolute = this.resolveSafe(relPath, workspaceRoot, 'writeFile');
    try {
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, content, 'utf8');
    } catch (err) {
      this.breadcrumbError('writeFile', absolute, err);
      throw err;
    }
  }

  /** Return true if `p` exists on disk. Does not apply path-traversal guards (caller supplies absolute path). */
  async exists(p: string): Promise<boolean> {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }

  /** Stat a file (returns the node:fs Stats object). */
  async stat(p: string): Promise<Stats> {
    try {
      return await fs.stat(p);
    } catch (err) {
      this.breadcrumbError('stat', p, err);
      throw err;
    }
  }

  // ── internals ──────────────────────────────────────────────

  /** Resolve `relPath` inside `workspaceRoot` and reject any traversal. */
  private resolveSafe(relPath: string, workspaceRoot: string, op: string): string {
    const rootAbs = path.resolve(workspaceRoot);
    const candidate = path.resolve(rootAbs, relPath);
    const rel = path.relative(rootAbs, candidate);
    const escapes = rel === '' ? false : rel.startsWith('..') || path.isAbsolute(rel);
    if (escapes) {
      const err = new Error(
        `[FsAdapter] ${op} refused: "${relPath}" escapes workspace root "${workspaceRoot}"`
      );
      this.telemetry.addBreadcrumb(
        `fs-path-traversal op=${op} rel=${relPath}`,
        'fs',
        'error'
      );
      throw err;
    }
    return candidate;
  }

  private breadcrumbError(op: string, p: string, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    this.telemetry.addBreadcrumb(`fs-error op=${op} path=${p} message=${msg}`, 'fs', 'error');
  }
}
