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
 * lists and the module command table — so the next module added to the
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

// Line endings are normalised because the markers below are LF-anchored
// (`## heading\n`), and none of them match on a CRLF checkout.
const read = (relativePath: string): string =>
  readFileSync(resolve(REPO_ROOT, relativePath), 'utf8').replace(/\r\n/g, '\n');

const GUIDE = read('docs/getting-started.md');
const SIDE_PANEL = read('packages/webview/src/SidePanel.tsx');
const NAV_GROUPS_SRC = read('packages/webview/src/navigation/navGroups.tsx');
const EN = JSON.parse(read('packages/webview/src/i18n/locales/en.json')) as {
  nav: Record<string, string>;
  sidePanel: { group: Record<string, string>; needsSecondOrg: string };
};
const MODULE_COMMANDS_SRC = read('packages/extension/src/composition/moduleCommands.ts');
const SHORTCUTS_SRC = read('packages/webview/src/hooks/useGlobalShortcuts.ts');

/** English nav labels — the strings the launcher actually renders. */
const NAV_LABELS = EN.nav;

/** The rows navGroups.tsx declares — those the launcher, Home and Help list — by route id. */
const NAV_ROWS = [
  ...NAV_GROUPS_SRC.matchAll(/\bid: '([^']+)',\s*labelKey: '[^']+',\s*icon: </g),
].map((m) => m[1]);

/**
 * Route ids of a list of navGroups.tsx (`TOOL_ITEMS`), in its order. Each is a
 * row navGroups.tsx declares.
 *
 * Read from the source text rather than imported: this file runs outside the
 * webview package (no JSX transform, no path aliases), and the lists are
 * plain literals whose shape is stable.
 */
function navIds(listName: string): string[] {
  const rowList = new RegExp(
    `const ${listName}: readonly NavItem\\[\\] = \\[([\\s\\S]*?)\\n\\];`,
  ).exec(NAV_GROUPS_SRC);
  if (!rowList) {
    throw new Error(`${listName} not found in navGroups.tsx — update this test with it`);
  }
  const ids = [...rowList[1].matchAll(/\bid: '([^']+)'/g)].map((m) => m[1]);
  const undeclared = ids.filter((id) => !NAV_ROWS.includes(id));
  if (undeclared.length > 0) {
    throw new Error(`${undeclared.join(', ')}, listed by ${listName}, is no row of navGroups.tsx`);
  }
  return ids;
}

/** A group of `NAV_GROUPS`, as navGroups.tsx declares it. */
interface NavGroupSource {
  id: string;
  /** Its rows in their order, each with the condition it is listed under, if any. */
  rows: Array<{ id: string; shownWhen?: string }>;
}

/**
 * The groups of `NAV_GROUPS` in their order, each with its rows: what the
 * launcher, Home and Help list. A group is `id: '…', labelKey:
 * 'sidePanel.group.…', items: [`, its rows the objects up to the next group.
 */
function navGroups(): NavGroupSource[] {
  const starts = [
    ...NAV_GROUPS_SRC.matchAll(/\bid: '(\w+)',\s*labelKey: 'sidePanel\.group\.\w+',\s*items: \[/g),
  ];
  if (starts.length === 0) {
    throw new Error('no group of NAV_GROUPS found in navGroups.tsx — update this test with it');
  }
  const end = NAV_GROUPS_SRC.indexOf('export const MODULE_ITEMS');
  return starts.map((start, i) => {
    const body = NAV_GROUPS_SRC.slice(
      (start.index ?? 0) + start[0].length,
      starts[i + 1]?.index ?? end,
    );
    const rows = [
      ...body.matchAll(/\{\s*id: '([\w-]+)',\s*labelKey: '[^']+',\s*icon: <[^}]*\}/g),
    ].map((row) => ({ id: row[1], shownWhen: /shownWhen: '(\w+)'/.exec(row[0])?.[1] }));
    return { id: start[1], rows };
  });
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

    it('lists the launcher’s groups in its order, each with its modules in theirs', () => {
      // Positive control: the launcher draws its modules from NAV_GROUPS.
      expect(SIDE_PANEL).toMatch(/NAV_GROUPS\.map\(/);
      const groups = navGroups();
      expect(groups).toHaveLength(5);
      const at = groups.map((group) => {
        const heading = EN.sidePanel.group[group.id];
        expect(heading, `sidePanel.group.${group.id} missing from en.json`).toBeDefined();
        const line = bullet(body, heading);
        const positions = group.rows.map(({ id }) => {
          const label = NAV_LABELS[id];
          expect(label, `nav.${id} missing from en.json`).toBeDefined();
          expect(line, `module "${label}" missing from the ${heading} group`).toContain(label);
          return line.indexOf(label);
        });
        expect(positions).toEqual([...positions].sort((a, b) => a - b));
        return body.indexOf(line);
      });
      expect(at).toEqual([...at].sort((a, b) => a - b));
    });

    it('says when a module is listed only under a condition', () => {
      const conditioned = navGroups().flatMap((group) =>
        group.rows
          .filter((row) => row.shownWhen !== undefined)
          .map((row) => ({ group: group.id, ...row })),
      );
      // Positive control: Back into service, once a sandbox is registered.
      expect(conditioned.map((row) => row.id)).toContain('recovery');
      for (const row of conditioned) {
        expect(row.shownWhen).toBe('sandboxRegistered');
        expect(bullet(body, EN.sidePanel.group[row.group])).toMatch(
          new RegExp(`${NAV_LABELS[row.id]}, listed once a sandbox is registered`),
        );
      }
    });

    it('says what stands under Copy between orgs while fewer than two orgs are connected', () => {
      expect(SIDE_PANEL).toContain("t('sidePanel.needsSecondOrg')");
      expect(bullet(body, EN.sidePanel.group.copy)).toContain(`**${EN.sidePanel.needsSecondOrg}**`);
    });

    it('names no section the launcher no longer has', () => {
      for (const gone of [
        'Advanced',
        'Modules',
        'Orgs / Ops',
        'Open Full UI',
        'Running / Last Operation',
      ]) {
        expect(body, gone).not.toContain(`- **${gone}**`);
      }
      expect(body).not.toContain('Open Full UI');
      expect(body).not.toContain(NAV_LABELS.grappe);
    });

    it('lists every tool the launcher renders', () => {
      const line = bullet(body, 'Tools');
      for (const label of labelsFor('TOOL_ITEMS')) {
        expect(line, `tool "${label}" missing`).toContain(label);
      }
    });

    it('presents Home as the button beside the mark, which the launcher draws there', () => {
      // Positive control: the button beside the mark is named nav.home.
      expect(SIDE_PANEL).toMatch(
        /data-testid="sidepanel-brand"[\s\S]*?\{t\('nav\.home'\)\}[\s\S]*?<\/div>/,
      );
      expect(bullet(body, NAV_LABELS.home)).toContain('Beside the SandForge mark');
      expect(bullet(body, 'Tools')).not.toContain(NAV_LABELS.home);
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
        // Both in-panel routes, not just the palette. The section called the
        // palette "the one way in" while the chord map has bound `h` to home
        // since chords existed, so the sentence sent readers the long way
        // round and the gate did not notice: it only looked for "Ctrl+K".
        const chordsHome = /\bh:\s*'home'/.test(SHORTCUTS_SRC);
        if (chordsHome) {
          expect(body).not.toMatch(/the one way in/);
          expect(body).toMatch(/`G`/);
        }
      }
    });
  });
});

describe('the org card of "Connect Your Org"', () => {
  /** The labels a type badge can read, as `orgTypeLabel` takes them from the catalogue. */
  const BADGES = Object.values(
    (
      JSON.parse(read('packages/webview/src/i18n/locales/en.json')) as {
        sidePanel: { orgType: Record<string, string> };
      }
    ).common.orgType,
  );
  /** The environment tags a badge shows as the user wrote them. */
  const TAGS = [
    ...(
      /const ENV_TAGS = \[([\s\S]*?)\]/.exec(
        read('packages/webview/src/utils/orgFormatters.ts'),
      )?.[1] ?? ''
    ).matchAll(/'([^']+)'/g),
  ].map((m) => m[1]);

  it('names every badge the card can show, and no other', () => {
    // The guide promised "PROD/SBX": no badge reads SBX, and a sandbox is
    // shown by its kind.
    const step = GUIDE.split('\n').find((line) => /^\d\. Once connected/.test(line));
    expect(step, 'the step that shows the org card').toBeDefined();
    expect(TAGS.length).toBeGreaterThan(3);

    const named = [...(step ?? '').matchAll(/\b[A-Z]{2,}(?: [A-Z]{2,})*\b/g)].map((m) => m[0]);
    expect(named.filter((word) => !BADGES.includes(word) && !TAGS.includes(word))).toEqual([]);
    expect(BADGES.filter((badge) => !named.includes(badge))).toEqual([]);
  });
});
