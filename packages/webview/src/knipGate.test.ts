import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

/**
 * Guards on the dead-code gate itself, because a gate that only reports is a
 * report.
 *
 * Knip ran non-blocking for eleven releases and its output grew to 471 lines,
 * of which the single actionable entry was wrong: `src/main.sidepanel.tsx` —
 * the module vite builds into the sidebar bundle the extension actually loads
 * — was listed as unused, because the second `vite build --mode sidepanel`
 * pass was added to package.json and knip.json was never told. Nobody reads
 * 471 lines to find the one line that is a lie about a shipped file.
 *
 * The two halves of the fix live in files that cannot see each other, so both
 * are pinned here against the real sources:
 *   1. every entry vite builds is an entry knip knows about;
 *   2. knip.yml lets knip's exit code reach the job.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..');

function readRepoFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf-8');
}

interface KnipConfig {
  workspaces: Record<string, { entry?: string[]; project?: string[] }>;
  ignore?: string[];
}

const knipConfig = JSON.parse(readRepoFile('knip.json')) as KnipConfig;
const viteConfig = readRepoFile('packages/webview/vite.config.ts');
const knipWorkflow = readRepoFile('.github/workflows/knip.yml');

/**
 * Knip's built-in entry patterns for a workspace. Declaring one of these in
 * knip.json is redundant and knip emits a configuration hint for it, so the
 * webview entry array legitimately omits `src/main.tsx` — the check below has
 * to accept the defaults as much as the explicit list.
 */
const KNIP_DEFAULT_ENTRY = /^src\/(index|main|cli)\.[cm]?[jt]sx?$/;

/** Every `src/…` module vite.config.ts hands to rollup as a build entry. */
function viteBuildEntries(): string[] {
  return Array.from(viteConfig.matchAll(/'(src\/[^']+\.tsx?)'/g)).map((m) => m[1]);
}

describe('knip dead-code gate', () => {
  const webviewEntry = knipConfig.workspaces['packages/webview'].entry ?? [];

  it('knows about every module vite builds into a shipped bundle', () => {
    const entries = viteBuildEntries();

    // Guard the guard: a rewritten vite.config.ts that no longer states its
    // entries as literals would silently make this test assert nothing.
    expect(entries).toContain('src/main.sidepanel.tsx');
    expect(entries).toContain('src/main.tsx');

    for (const entry of entries) {
      expect(
        webviewEntry.includes(entry) || KNIP_DEFAULT_ENTRY.test(entry),
        `${entry} is a vite build entry but knip.json does not list it — knip will report it as an unused file`,
      ).toBe(true);
    }
  });

  it('is wired to fail the job rather than narrate it', () => {
    expect(knipWorkflow).toMatch(/run: pnpm knip /);
    expect(knipWorkflow).not.toMatch(/\|\|\s*true/);
    expect(knipWorkflow).not.toMatch(/continue-on-error/);
    // The PR comment used to tell reviewers the findings do not fail CI.
    // Blocking wording and a blocking job have to move together.
    expect(knipWorkflow).not.toMatch(/non-blocking|informational/i);
  });

  it('carries no suppression for a path that no longer exists', () => {
    const literalPaths = [
      ...(knipConfig.ignore ?? []),
      ...Object.entries(knipConfig.workspaces).flatMap(([workspace, config]) =>
        (config.entry ?? []).map((pattern) => join(workspace, pattern)),
      ),
    ].filter((pattern) => !/[*!]/.test(pattern));

    for (const path of literalPaths) {
      expect(existsSync(join(REPO_ROOT, path)), `knip.json points at missing ${path}`).toBe(true);
    }
  });
});
