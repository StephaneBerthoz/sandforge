/**
 * Sas (quarantine zone) path guard.
 *
 * Every output of the frozen-dataset engine that may contain source-org
 * identifiers (exports, retained-ID lists, working manifests) MUST live
 * outside the git repository: versioned, such a file would become a
 * real↔anonymized correspondence table (spec §1/§2). This guard resolves
 * candidate paths and refuses anything located inside the repo.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Walk up from `startDir` to the repository root. A directory is the repo
 * root when it contains a `.git` entry (directory or worktree file) or a
 * `pnpm-workspace.yaml` (monorepo root marker).
 *
 * @throws {Error} When no repo root is found above `startDir`.
 */
export function findRepoRoot(startDir: string): string {
  let current = path.resolve(startDir);
  for (;;) {
    if (
      fs.existsSync(path.join(current, '.git')) ||
      fs.existsSync(path.join(current, 'pnpm-workspace.yaml'))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`No repository root found above ${startDir}`);
    }
    current = parent;
  }
}

/** Normalize for comparison: resolve, and lowercase on case-insensitive filesystems. */
function normalizeForCompare(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Error thrown when an output path points inside the repository. */
export class InsideRepoPathError extends Error {
  constructor(
    /** The offending path as resolved. */
    readonly resolvedPath: string,
    /** The repository root the path fell into. */
    readonly repoRoot: string,
  ) {
    super(
      `Refusing output path inside the repository: ${resolvedPath} ` +
        `(repo root: ${repoRoot}). Frozen-dataset exports, retained-ID lists and ` +
        `working manifests must live in a sas directory OUTSIDE the repo — ` +
        `versioning them would create a real↔anonymized correspondence table.`,
    );
    this.name = 'InsideRepoPathError';
  }
}

/**
 * Validates that output paths stay outside the repository. Instantiate
 * once per operation; the repo root defaults to the root found above the
 * current working directory and can be injected for tests.
 */
export class SasPathGuard {
  /** Absolute path of the repository root used for containment checks. */
  readonly repoRoot: string;

  constructor(repoRoot?: string) {
    this.repoRoot = repoRoot ? path.resolve(repoRoot) : findRepoRoot(process.cwd());
  }

  /** True when `candidate` resolves to the repo root itself or a path under it. */
  isInsideRepo(candidate: string): boolean {
    const root = normalizeForCompare(this.repoRoot);
    const resolved = normalizeForCompare(candidate);
    if (resolved === root) {
      return true;
    }
    const rel = path.relative(root, resolved);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  /**
   * Return the absolute resolved form of `candidate` when it is outside
   * the repo; throw {@link InsideRepoPathError} otherwise.
   */
  assertOutsideRepo(candidate: string): string {
    if (this.isInsideRepo(candidate)) {
      throw new InsideRepoPathError(path.resolve(candidate), this.repoRoot);
    }
    return path.resolve(candidate);
  }
}
