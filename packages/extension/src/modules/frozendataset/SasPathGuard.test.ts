import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findRepoRoot, InsideRepoPathError, SasPathGuard } from './SasPathGuard.js';

// Tests run with cwd = packages/extension → the repo root is two levels up.
const repoRoot = findRepoRoot(process.cwd());

describe('findRepoRoot', () => {
  it('finds the monorepo root above the package dir', () => {
    // Do not assert the checkout directory name (CI checks out under the
    // repo name, local clones may differ): the root must be an ancestor of
    // the package dir and carry a monorepo marker.
    const cwd = process.cwd();
    expect(cwd.startsWith(repoRoot + path.sep)).toBe(true);
    expect(path.relative(repoRoot, cwd)).toBe(path.join('packages', 'extension'));
    expect(fs.existsSync(path.join(repoRoot, 'pnpm-workspace.yaml'))).toBe(true);
  });

  it('throws when no repo root exists', () => {
    expect(() => findRepoRoot(path.parse(repoRoot).root)).toThrow(/No repository root/);
  });
});

describe('SasPathGuard', () => {
  const guard = new SasPathGuard(repoRoot);

  it('refuses a path at the repo root', () => {
    expect(() => guard.assertOutsideRepo(repoRoot)).toThrow(InsideRepoPathError);
  });

  it('refuses a path inside the repo (relative or nested)', () => {
    expect(() => guard.assertOutsideRepo(path.join(repoRoot, 'exports', 'out.json'))).toThrow(
      /outside the repo/i,
    );
    expect(() =>
      guard.assertOutsideRepo(path.join(repoRoot, 'packages', 'extension', 'out.json')),
    ).toThrow(InsideRepoPathError);
  });

  it('refuses paths that resolve into the repo via ".." segments', () => {
    const inside = path.join(repoRoot, '..', path.basename(repoRoot), 'x.json');
    expect(() => guard.assertOutsideRepo(inside)).toThrow(InsideRepoPathError);
  });

  it('accepts a path outside the repo and returns it resolved', () => {
    const outside = path.join(os.tmpdir(), 'sandforge-sas-test', 'out.json');
    expect(guard.assertOutsideRepo(outside)).toBe(path.resolve(outside));
    expect(guard.isInsideRepo(outside)).toBe(false);
  });

  it('accepts a sibling directory of the repo', () => {
    const sibling = path.join(path.dirname(repoRoot), 'sas-outside', 'x.json');
    expect(guard.isInsideRepo(sibling)).toBe(false);
  });

  it('defaults to detecting the repo root from cwd', () => {
    const defaultGuard = new SasPathGuard();
    expect(defaultGuard.repoRoot).toBe(path.resolve(repoRoot));
  });
});
