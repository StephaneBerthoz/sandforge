/**
 * Doc/code drift guard for the Compare module page.
 *
 * `docs/modules/compare.md` is the only public description of what Compare
 * offers, and it drifted far enough to describe a different product: it
 * advertised six tabs including an "Impact Graph" that exists in no package,
 * and sold Deploy as a working feature while `ComparePage` mounted
 * `<DeployFromDiff />` with no `suggestion`/`onDeploy`, so the tab could only
 * ever render `common.noData`. Every one of those claims was falsifiable
 * straight from the source, so this test reads it back and fails when the
 * prose and the code stop agreeing.
 *
 * It runs through the repo-root `vitest.config.ts`, whose `include` covers
 * every `.test.ts` under `docs/`, as `pnpm test:docs` inside `pnpm validate`.
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

/** The English catalogue, which gives each tab the label the panel shows. */
const EN = JSON.parse(
  readFileSync(resolve(REPO_ROOT, 'packages/webview/src/i18n/locales/en.json'), 'utf8'),
) as Record<string, unknown>;

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

/**
 * The labels the panel shows on its tabs, in their order: each tab's
 * `label: t('…')` key, read in the English catalogue. Compared with the tab
 * ids, the doc's "Diff, Permissions, Objects, Drift, and Deploy" passed,
 * while the panel reads "Diff Viewer", "Permission Presence", "Objects",
 * "Org Settings Drift" and "Deploy from Diff".
 */
function tabLabelsFromSource(source: string): string[] {
  const block = /const COMPARE_TABS: PageTab\[\] = \[([\s\S]*?)\n\s*\];/.exec(source);
  if (block?.[1] === undefined) {
    throw new Error('COMPARE_TABS array literal not found in ComparePage.tsx');
  }
  return [...block[1].matchAll(/label: t\('([^']+)'\)/g)].map((m) => {
    const key = m[1] ?? '';
    const label = key
      .split('.')
      .reduce<unknown>((at, part) => (at as Record<string, unknown> | undefined)?.[part], EN);
    if (typeof label !== 'string') throw new Error(`en.json has no string at ${key}`);
    return label;
  });
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
  // JavaScript has no `\z`: written that way it matched a literal "z", and a
  // section ended at the first one ("Organization").
  const match = new RegExp(`^### ${escaped}$([\\s\\S]*?)(?=^#{2,3} |(?![\\s\\S]))`, 'm').exec(doc);
  if (match?.[1] === undefined) {
    throw new Error(`Section "${heading}" not found in compare.md`);
  }
  return match[1];
}

describe('docs/modules/compare.md', () => {
  it('promises exactly the tabs ComparePage renders, by the labels the panel shows', () => {
    const tabIds = tabIdsFromSource(COMPARE_PAGE);
    const { countWord, names } = tabsFromQuickStart(DOC);

    expect(names).toEqual(tabLabelsFromSource(COMPARE_PAGE));
    expect(countWord.toLowerCase()).toBe(NUMBER_WORDS[tabIds.length]);
  });

  it('documents each tab under the label the panel shows, and no tab that does not exist', () => {
    // "### Metadata Diff" described the tab the panel calls "Diff Viewer".
    expect(featureHeadings(DOC)).toEqual(tabLabelsFromSource(COMPARE_PAGE));
  });

  it('documents no Schema Advice, whose button is gone', () => {
    // It described four fixed objects of the source org in English sentences
    // and compared nothing: the button, its request and its rules went, and
    // the page sells none of them.
    expect(COMPARE_PAGE).not.toMatch(/schema-?advice/i);
    expect(DOC).not.toMatch(/schema advice/i);
  });

  it('scores only what a deployment changes, and names what only the target holds apart', () => {
    const enrich = readFileSync(
      resolve(REPO_ROOT, 'packages/webview/src/pages/Compare/enrichDiffs.ts'),
      'utf8',
    );
    // A component only the target holds weighs nothing: a deployment leaves it.
    const mult = /const CHANGE_MULT[^=]*= \{([\s\S]*?)\};/.exec(enrich)?.[1] ?? '';
    expect(mult).toMatch(/removed:/);
    expect(mult).not.toMatch(/added:/);
    const card = /- \*\*Risk Score Card\*\* -- ([^\n]+)/.exec(DOC)?.[1] ?? '';
    expect(card).toMatch(/only in the target are on a line of their own, with no risk level/);
    expect(card).toMatch(/nor while a change it deploys rates high or critical/);
  });

  it('describes the deployment the code runs: validated check-only first, nothing deleted', () => {
    const handler = readFileSync(
      resolve(REPO_ROOT, 'packages/extension/src/bridge/handlers/CompareHandler.ts'),
      'utf8',
    );
    const deployer = readFileSync(
      resolve(REPO_ROOT, 'packages/extension/src/modules/compare/MetadataDeployer.ts'),
      'utf8',
    );
    const payloads = readFileSync(
      resolve(REPO_ROOT, 'packages/extension/src/bridge/validatePayload.ts'),
      'utf8',
    );
    // The tab holds the panel that sends both requests.
    expect(COMPARE_PAGE).toMatch(/hidden=\{activeTab !== 'deploy'\}[^>]*>\s*<DeployPanel/);
    // A validation deploys check-only; a deployment names a kept validation
    // and nothing else, so it cannot carry what was not validated.
    expect(handler).toMatch(/deployOptions\(true, payload\.testLevel/);
    const deploySchema =
      /compareDeployPayloadSchema = z\s*\.object\(\{([\s\S]*?)\n {2}\}\)\s*\.strict\(\);/.exec(
        payloads,
      )?.[1] ?? '';
    expect([...deploySchema.matchAll(/^ {4}(\w+):/gm)].map((m) => m[1])).toEqual([
      'validationId',
      'targetOrgId',
    ]);
    // No destructive change: nothing is purged, and no manifest of deletions is built.
    expect(deployer).toContain('purgeOnDelete: false');
    expect(deployer).not.toMatch(/destructiveChanges/);

    const section = sectionBody(DOC, 'Deploy from Diff');
    expect(section).not.toContain('Coming soon');
    expect(section).toContain('check-only');
    expect(section).toMatch(/Only a validation that succeeded can be deployed/);
    expect(section).toMatch(/destructive change, and\s+SandForge deploys none/);
    expect(section).toMatch(/A production target is refused/);
  });

  it('names every org the guard lets a deployment reach, a Developer Edition among them', () => {
    // The guard refuses a deployment only on the production tier; since one
    // rule types a Developer Edition, it is a development org, as a sandbox
    // is, and a scratch org has a tier of its own. The page said "sandboxes
    // only", and a Developer Edition user read Deploy as closed to them.
    const kind = readFileSync(resolve(REPO_ROOT, 'packages/shared/src/utils/org-kind.ts'), 'utf8');
    const tiers = /const GUARD_TIERS[^=]*= \{([\s\S]*?)\};/.exec(kind)?.[1] ?? '';
    expect(tiers).toMatch(/Sandbox: 'development'/);
    expect(tiers).toMatch(/Scratch: 'scratch'/);
    expect(tiers).toMatch(/Developer: 'development'/);
    const guard = readFileSync(
      resolve(REPO_ROOT, 'packages/extension/src/core/precheck/ProductionGuard.ts'),
      'utf8',
    );
    expect(guard).toMatch(/if \(request\.operation === 'deploy'\) \{[\s\S]{0,400}?allowed: false/);

    const section = sectionBody(DOC, 'Deploy from Diff').replace(/\s+/g, ' ');
    expect(section).not.toMatch(/sandboxes only/);
    expect(section).toMatch(/a sandbox, a scratch org or a Developer Edition org/);
    expect(DOC.split('\n')[2]).toMatch(/a sandbox, a scratch org or a Developer Edition org/);
  });

  it('promises no permission grid, since only names are read', () => {
    // `handlePermissions` queries PermissionSet and Profile by name and splits
    // the names three ways. It never touches ObjectPermissions, so there is no
    // CRUD or FLS anywhere behind this tab.
    const handler = readFileSync(
      resolve(REPO_ROOT, 'packages/extension/src/bridge/handlers/CompareHandler.ts'),
      'utf8',
    );
    expect(/ObjectPermissions|FieldPermissions/.test(handler)).toBe(false);
    expect(sectionBody(DOC, 'Permission Presence')).not.toMatch(/CRUD|FLS|grid/i);
  });

  it('claims no automated drift, since the tab reads five Organization fields on request', () => {
    const handler = readFileSync(
      resolve(REPO_ROOT, 'packages/extension/src/bridge/handlers/CompareHandler.ts'),
      'utf8',
    );
    // The one query the drift path runs, and there is no second one.
    expect(handler).toContain('FROM Organization');
    expect(/metadata\.read|SecuritySettings|CompanyInfo/.test(handler)).toBe(false);
    expect(sectionBody(DOC, 'Org Settings Drift')).not.toMatch(/automated|categories|dashboard/i);
  });

  it('does not say only differing fields are listed, since matching ones get a row too', () => {
    const handler = readFileSync(
      resolve(REPO_ROOT, 'packages/extension/src/bridge/handlers/CompareHandler.ts'),
      'utf8',
    );
    expect(handler).toContain("status: 'match'");
    expect(sectionBody(DOC, 'Org Settings Drift')).not.toMatch(/where they differ|only .*differ/i);
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
