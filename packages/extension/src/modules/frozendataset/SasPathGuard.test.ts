import { describe, expect, it } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { findRepoRoot, InsideRepoPathError, SasPathGuard } from './SasPathGuard.js';

// Tests run with cwd = packages/extension → the repo root is two levels up.
const repoRoot = findRepoRoot(process.cwd());

describe('findRepoRoot', () => {
  it('finds the monorepo root above the package dir', () => {
    expect(path.basename(repoRoot)).toBe('sand-forge');
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
