import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Documentation gate for the "First Launch" section.
 *
 * The section described a Home dashboard with a bento grid, quick actions and
 * a getting-started card — a surface that has no launcher entry and no
 * `sandforge.open*` command, so no reader ever saw it on first click. Nothing
 * failed, because prose is not compiled. This file compiles it: the section is
 * checked against the two sources of truth it paraphrases — the launcher's own
 * nav arrays and the module command table — so the next module added to the
 * sidebar, or the day `home` finally gets a command, breaks the doc loudly.
 *
 * `docs/` is not a workspace package, so this sits beside the document it
 * guards rather than in a package suite — which also means `pnpm test` does
 * not sweep it up. Run it explicitly, from the repo root:
 *
 *   npx vitest run docs/getting-started.test.ts
 */

const DOCS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(DOCS_DIR, '..');

const read = (relativePath: string): string =>
  readFileSync(resolve(REPO_ROOT, relativePath), 'utf8');

const GUIDE = read('docs/getting-started.md');
const SIDE_PANEL = read('packages/webview/src/SidePanel.tsx');
const MODULE_COMMANDS_SRC = read('packages/extension/src/composition/moduleCommands.ts');

/** English nav labels — the strings the launcher actually renders. */
const NAV_LABELS = (
  JSON.parse(read('packages/webview/src/i18n/locales/en.json')) as {
    nav: Record<string, string>;
  }
).nav;

/**
 * Route ids listed in one of SidePanel's nav arrays.
 *
 * Read from the source text rather than imported: this file runs outside the
 * webview package (no JSX transform, no path aliases), and the arrays are
 * plain literals whose shape is stable.
 */
function navIds(arrayName: string): string[] {
  const block = new RegExp(`const ${arrayName}: NavItem\\[\\] = \\[([\\s\\S]*?)\\n\\];`).exec(
    SIDE_PANEL,
  );
  if (!block) {
    throw new Error(`${arrayName} not found in SidePanel.tsx — update this test with it`);
  }
  return [...block[1].matchAll(/\bid: '([^']+)'/g)].map((m) => m[1]);
}

/** Labels for a nav array, in the order the launcher shows them. */
const labelsFor = (arrayName: string): string[] =>
  navIds(arrayName).map((id) => {
    const label = NAV_LABELS[id];
    if (!label) {
      throw new Error(`nav.${id} missing from en.json`);
    }
    return label;
  });

/** The body of a `## ` section, up to the next one. */
function section(heading: string): string {
  const start = GUIDE.indexOf(`## ${heading}\n`);
  expect(start, `"## ${heading}" section missing`).toBeGreaterThan(-1);
  const rest = GUIDE.slice(start);
  const end = rest.indexOf('\n## ', 1);
  return end === -1 ? rest : rest.slice(0, end);
}

/** The bullet whose label is `- **<name>**`. */
function bullet(body: string, name: string): string {
  const line = body.split('\n').find((l) => l.startsWith(`- **${name}**`));
  expect(line, `"- **${name}**" bullet missing from the First Launch section`).toBeDefined();
  return line as string;
}

describe('docs/getting-started.md', () => {
  it('references only screenshots that exist on disk', () => {
    const referenced = [...GUIDE.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1]);
    expect(referenced.length).toBeGreaterThan(0);
    const dangling = referenced.filter((rel) => !existsSync(resolve(DOCS_DIR, rel)));
    expect(dangling).toEqual([]);
  });

  describe('First Launch', () => {
    const body = section('First Launch');

    it('lists every module the launcher renders, in the launcher order', () => {
      const line = bullet(body, 'Modules');
      const positions = labelsFor('MODULE_ITEMS').map((label) => {
        expect(line, `module "${label}" missing`).toContain(label);
        return line.indexOf(label);
      });
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    });

    it('lists every tool the launcher renders', () => {
      const line = bullet(body, 'Tools');
      for (const label of labelsFor('TOOL_ITEMS')) {
        expect(line, `tool "${label}" missing`).toContain(label);
      }
    });

    it('does not present Home as a launcher entry', () => {
      expect(bullet(body, 'Modules')).not.toContain('Home');
      expect(bullet(body, 'Tools')).not.toContain('Home');
    });

    it('documents the Ctrl+K route for as long as `home` has no module command', () => {
      const hasHomeCommand = /moduleId: 'home'/.test(MODULE_COMMANDS_SRC);
      if (hasHomeCommand) {
        // `home` became a real command: the "in-panel only" wording is now a
        // lie and the section has to be rewritten around the new entry point.
        expect(body).not.toMatch(/in-panel view only/);
      } else {
        expect(body).toMatch(/\bHome\b/);
        expect(body).toMatch(/Ctrl\+K/);
      }
    });
  });
});
