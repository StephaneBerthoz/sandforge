import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MockBridge } from './helpers';
import { MOCK_ORGS } from './fixtures';

/**
 * Every panel opens, says something, and says it in words.
 *
 * What this proves, and what it does not, because the difference cost a
 * release to learn:
 *
 * It opens all seventeen routes the panel router can mount, in English and in
 * French, and refuses three things — a page that throws into the error
 * boundary, a page that renders nothing at all, and a catalogue key rendered
 * as its own text. It reads the FIRST screen of each route: whatever the panel
 * shows with nothing answered over the bridge but the locale. Empty states,
 * "connect an org" prompts, forms awaiting input. Those are screens users see,
 * and until this existed nothing looked at fourteen of them.
 *
 * It does NOT reach a page's populated state. The sixteen raw keys that
 * shipped in 1.23.0 were all in one — the Autopilot legend appears only once a
 * graph exists, the sync history's status column only once a run has finished
 * — and this check passes with every one of them reintroduced. It was written
 * believing otherwise. `scripts/i18n-key-literals.test.mjs` is what catches
 * them: a key is a literal, so reading the source is the complete check and
 * rendering is the partial one. That is the opposite of the contrast rule,
 * where only the render tells the truth, and the difference is which side
 * holds the whole answer.
 *
 * What it caught on its first run is the kind of thing it is actually for:
 * `OrgRegistry.loadAll` handed the webview an org stored by an older build
 * with no `tags`, `orgTypeLabel` called `.map` on it, and the Organizations
 * page — the first page most people open — went to its error boundary. No
 * suite had ever opened that page.
 *
 * The key rule is kept anyway, and costs nothing: built from the catalogue's
 * own top-level sections, it matches none of the 1755 strings English defines,
 * provided a match may not start after a dot — the only near-misses are help
 * texts quoting a setting id (`sandforge.grappe.enabled`).
 *
 * `innerText`, not `textContent`: it is what a person can read.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES = path.join(__dirname, '..', 'src', 'i18n', 'locales');

const EN_BUNDLE = JSON.parse(readFileSync(path.join(LOCALES, 'en.json'), 'utf8')) as Record<
  string,
  unknown
>;
const FR_BUNDLE = JSON.parse(readFileSync(path.join(LOCALES, 'fr.json'), 'utf8')) as Record<
  string,
  unknown
>;

/**
 * Every route `PanelRouter` can mount. The extension opens one module per panel
 * (`__SANDFORGE_MODULE__`), and this list is that contract seen from the
 * webview side; the test below holds it to the router's own table, so a route
 * added there cannot quietly go unchecked.
 */
const ROUTES: readonly string[] = [
  'home',
  'orgs',
  'forge',
  'frozen',
  'grappe',
  'monitor',
  'compare',
  'dataops',
  'automation',
  'migration',
  'reports',
  'settings',
  'help',
  'seed',
  'sync',
  'autopilot',
  'ai',
];

/**
 * A raw catalogue key, as it renders.
 *
 * Built from the catalogue's own top-level sections. The lookbehind is what
 * keeps a quoted setting id (`sandforge.seed.defaultBatchSize`) out of it.
 */
const RAW_KEY = new RegExp(
  `(?<![A-Za-z0-9_.])(${Object.keys(EN_BUNDLE).sort().join('|')})\\.[A-Za-z0-9_]+`,
  'g',
);

/**
 * The one message a route needs answered before it renders words.
 *
 * Monitor holds a skeleton until its data arrives — a real loading state with
 * no text in it, so there would be nothing to read. Everything else opens on a
 * screen that says something: empty, unconnected, or asking for input.
 */
const PRIMED: Record<string, { request: string; response: string; payload: unknown }> = {
  monitor: {
    request: 'monitor:refresh',
    response: 'monitor:data',
    payload: { healthScore: 85, healthReport: null, jobs: [], limits: [], alerts: [] },
  },
};

/** Boot one module panel, with the bundle for `lng` served over the bridge. */
async function openModule(page: Page, moduleId: string, lng: 'en' | 'fr'): Promise<void> {
  const bridge = new MockBridge();
  await bridge.setup(page);
  await page.addInitScript((id) => {
    (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = id;
  }, moduleId);
  await page.goto('/');

  if (lng === 'fr') {
    await bridge.respondToNext(
      'i18n:locale',
      'i18n:locale:response',
      { lng: 'fr', bundle: FR_BUNDLE },
      { timeout: 10_000 },
    );
  }
  await bridge.seedOrgs(MOCK_ORGS);

  const primed = PRIMED[moduleId];
  if (primed) {
    await bridge.respondToNext(
      primed.request,
      primed.response,
      primed.payload as Record<string, unknown>,
      { timeout: 10_000 },
    );
  }
}

/** Read the panel as it stands and refuse any catalogue key on screen. */
async function assertNoRawKey(page: Page, id: string, lng: string): Promise<void> {
  await page.waitForSelector('[data-testid="panel-app"]', { timeout: 15_000 });
  await expect(page.getByTestId('error-boundary')).toHaveCount(0);

  const visible = await page.getByTestId('panel-app').innerText();
  // A panel that rendered nothing would pass every assertion below by saying
  // nothing at all.
  expect(visible.trim().length, `${id} (${lng}) rendered an empty panel`).toBeGreaterThan(40);

  const keys = [...new Set(visible.match(RAW_KEY) ?? [])];
  expect(keys, `${id} (${lng}) rendered its own translation keys`).toEqual([]);
}

test.describe('every page reads as text, not as keys', () => {
  test('the route table covers every route the router mounts', () => {
    // A page missing from ROUTES is a page nothing below ever opens, and the
    // check would go green over it.
    const router = readFileSync(path.join(__dirname, '..', 'src', 'PanelRouter.tsx'), 'utf8');
    const table = /const panelComponents[^{]*\{([\s\S]*?)\n\};/.exec(router);
    expect(table, 'panelComponents is not where this expects it').not.toBeNull();
    const mounted = [...(table?.[1] ?? '').matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]).sort();
    expect(mounted).toEqual([...ROUTES].sort());
  });

  for (const id of ROUTES) {
    test(`${id} shows no raw translation key`, async ({ page }) => {
      await openModule(page, id, 'en');
      await assertNoRawKey(page, id, 'en');
    });
  }

  test('the welcome wizard does not greet you twice', async ({ page }) => {
    // Its header and its first step used to carry the same title and the same
    // subtitle, word for word, on the first screen a new user ever sees.
    await openModule(page, 'home', 'en');
    await page.waitForSelector('[data-testid="home-page"]');

    const headings = await page.getByRole('heading').allInnerTexts();
    const seen = new Set<string>();
    const repeated = headings
      .map((h) => h.trim())
      .filter((h) => h.length > 0)
      .filter((h) => (seen.has(h) ? true : (seen.add(h), false)));
    expect(repeated, 'the same heading is rendered twice').toEqual([]);
  });
});

test.describe('every page reads as text in French too', () => {
  // The panel only asks the host for a bundle when the editor is not English,
  // so the locale is what puts this pass on the translated path at all.
  test.use({ locale: 'fr-FR' });

  for (const id of ROUTES) {
    test(`${id} shows no raw translation key in French`, async ({ page }) => {
      await openModule(page, id, 'fr');
      await assertNoRawKey(page, id, 'fr');
    });
  }
});
