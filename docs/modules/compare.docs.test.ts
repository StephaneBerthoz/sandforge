/**
 * Doc/code drift guard for the Compare module page.
 *
 * `docs/modules/compare.md` is the only public description of what Compare
 * offers, and it drifted far enough to describe a different product: it
 * advertised six tabs including an "Impact Graph" that exists in no package,
 * and sold Deploy as a working feature although `ComparePage` mounts
 * `<DeployFromDiff />` with no `suggestion`/`onDeploy`, so the tab can only
 * ever render `common.noData`. Every one of those claims was falsifiable
 * straight from `ComparePage.tsx`, so this test reads the source back and
 * fails when the prose and the tab table stop agreeing.
 *
 * NOT YET WIRED INTO CI. It sits next to the doc it guards, but every vitest
 * project scopes `include` to its own `src/`, and the `vitest` package is
 * installed per workspace package rather than at the root — so from here the
 * suite is reachable by an explicit `npx vitest run` at the repo root and by
 * nothing else, and `tsc` cannot resolve the import below. Moving the file to
 * `packages/webview/src/pages/Compare/` fixes both at once; that is the
 * intended home once someone owns that directory.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

// Normalised: the assertions below are LF-anchored and miss on a CRLF checkout.
const DOC = readFileSync(resolve(HERE, 'compare.md'), 'utf8').replace(/\r\n/g, '\n');
const COMPARE_PAGE = readFileSync(
  resolve(REPO_ROOT, 'packages/webview/src/pages/Compare/ComparePage.tsx'),
  'utf8',
);

/**
 * Feature headings that document a tab, mapped to the tab id they describe.
 * The heading wording is prose ("Metadata Diff") and the id is code ("diff"),
 * so the link has to be stated rather than derived.
 */
const HEADING_TO_TAB: Readonly<Record<string, string>> = {
  'Metadata Diff': 'diff',
  'Permission Matrix': 'permissions',
  Snapshots: 'snapshots',
  'Drift Detection': 'drift',
  'Deploy from Diff': 'deploy',
};

/** Headings that describe a control on the page rather than one of its tabs. */
const NON_TAB_HEADINGS: readonly string[] = ['Schema Advice'];

/** Spelled-out counts, so the doc's "five tabs" can be checked against the code. */
const NUMBER_WORDS: readonly string[] = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
];

/** Tab ids in the order `ComparePage` renders them. */
function tabIdsFromSource(source: string): string[] {
  const block = /const COMPARE_TABS: PageTab\[\] = \[([\s\S]*?)\n\s*\];/.exec(source);
  if (block?.[1] === undefined) {
    throw new Error('COMPARE_TABS array literal not found in ComparePage.tsx');
  }
  return [...block[1].matchAll(/id: '([^']+)'/g)].flatMap((m) =>
    m[1] === undefined ? [] : [m[1]],
  );
}

/** The tab roster the Quick Start promises the reader. */
function tabsFromQuickStart(doc: string): { countWord: string; names: string[] } {
  const line = /Browse results across (\w+) tabs: ([^\n]+)/.exec(doc);
  if (line?.[1] === undefined || line[2] === undefined) {
    throw new Error('Quick Start tab roster not found in compare.md');
  }
  const names = line[2]
    .split(',')
    .map((n) => n.replace(/^\s*and\s+/, '').trim())
    .filter((n) => n.length > 0);
  return { countWord: line[1], names };
}

/** Every `###` feature heading in the doc, in document order. */
function featureHeadings(doc: string): string[] {
  return [...doc.matchAll(/^### (.+)$/gm)].flatMap((m) =>
    m[1] === undefined ? [] : [m[1].trim()],
  );
}

/** Body text under a `###` heading, up to the next heading of any level. */
function sectionBody(doc: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^### ${escaped}$([\\s\\S]*?)(?=^#{2,3} |\\z)`, 'm').exec(doc);
  if (match?.[1] === undefined) {
    throw new Error(`Section "${heading}" not found in compare.md`);
  }
  return match[1];
}

describe('docs/modules/compare.md', () => {
  it('promises exactly the tabs ComparePage renders', () => {
    const tabIds = tabIdsFromSource(COMPARE_PAGE);
    const { countWord, names } = tabsFromQuickStart(DOC);

    expect(names.map((n) => n.toLowerCase())).toEqual(tabIds);
    expect(countWord.toLowerCase()).toBe(NUMBER_WORDS[tabIds.length]);
  });

  it('documents no feature section for a tab that does not exist', () => {
    const tabIds = tabIdsFromSource(COMPARE_PAGE);

    for (const heading of featureHeadings(DOC)) {
      if (NON_TAB_HEADINGS.includes(heading)) continue;
      const tabId = HEADING_TO_TAB[heading];
      expect(tabId, `"### ${heading}" documents no known tab or control`).toBeDefined();
      expect(tabIds, `"### ${heading}" describes a tab absent from COMPARE_TABS`).toContain(tabId);
    }
  });

  it('does not sell the rule-based schema advice as AI', () => {
    // SchemaAdvisor is a local rule engine — `new SchemaAdvisor()` takes no
    // provider and `analyzeSchema` is synchronous — so the doc must not put a
    // model behind the button.
    const section = /\n### Schema Advice([^\n]*)\n([\s\S]*?)(?=\n#{2,3} |$)/.exec(DOC);
    expect(section, 'no "### Schema Advice" section in compare.md').not.toBeNull();
    expect(section![1], 'the heading must not qualify Schema Advice').toBe('');
    expect(section![2], 'the section must not put a model behind the button').not.toMatch(/\bAI\b/);
  });

  it('marks Deploy as coming soon while the tab is mounted without deploy props', () => {
    // The propless mount is what forces the empty state: DeployFromDiff only
    // renders a builder (and a deploy button) when given `suggestion`/`onDeploy`.
    const mountedPropless = /activeTab === 'deploy' && <DeployFromDiff \/>/.test(COMPARE_PAGE);
    if (!mountedPropless) return;

    expect(sectionBody(DOC, 'Deploy from Diff')).toContain('> **Coming soon:**');
  });

  it('claims no scheduled drift monitoring, since drift is request/response only', () => {
    const schemas = readFileSync(
      resolve(REPO_ROOT, 'packages/shared/src/bridge/messageSchemas.ts'),
      'utf8',
    );
    // A scheduler would need a channel to hang off, the way sync:schedule:* does.
    expect(/'compare:[^']*schedule/.test(schemas)).toBe(false);
    expect(DOC).not.toMatch(/scheduled monitoring/i);
  });
});
