import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'url';

import { MockBridge } from './helpers';
import { sendExtensionMessage } from './mocks/vscode-api';

/**
 * Internationalization.
 *
 * Rewritten against the post-1.8.0 UI: the extension opens one module panel at a
 * time (`__SANDFORGE_MODULE__`) and there is no navigation sidebar left to
 * read labels off — the previous version of this file asserted on
 * `data-testid="sidebar"`, which no source file has rendered since.
 *
 * What is asserted here is the boot path `src/i18n/index.ts` actually runs:
 * English is the ONLY statically bundled locale, so any other language is a
 * bridge round trip (`i18n:locale` → `i18n:locale:response`). That makes
 * "the default language is English" true in a narrower way than it used to
 * be, and the narrower truth is the one worth pinning:
 *
 *   - editor locale English            → English, nothing crosses the bridge;
 *   - editor locale French, host mute  → English (the bundle never arrives);
 *   - editor locale French, host answers → French.
 *
 * The fourth test covers the other way a language arrives: the extension
 * pushing the saved settings blob at a panel that booted in English.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * The exact bundle the extension answers `i18n:locale` with.
 *
 * `I18nHandler` reads it from `webview-dist/locales/`, which the build copies
 * verbatim from this file — so serving the source JSON here tests the real
 * translations rather than a fixture that agrees with the assertions by
 * construction.
 */
const FR_BUNDLE = JSON.parse(
  readFileSync(path.resolve(__dirname, '../src/i18n/locales/fr.json'), 'utf8'),
) as Record<string, unknown>;

/** Home-page strings, in the two languages this file exercises. */
const EN = {
  heroTitle: 'Forge a Sandbox',
  startForge: 'Start Forge',
  quickActions: 'Quick Actions',
  recordIdPlaceholder: 'Record ID (e.g. 001...)',
};
const FR = {
  heroTitle: 'Forger une Sandbox',
  startForge: 'Lancer Forge',
  quickActions: 'Actions rapides',
  recordIdPlaceholder: "ID d'enregistrement (ex. 001...)",
};

/**
 * Boot the Home panel the way the extension does, bridge mocked.
 *
 * `MockBridge.setup` installs the `acquireVsCodeApi` mock as an init script,
 * so the `i18n:locale` request the boot restore fires — before React mounts —
 * is still captured in `__SANDFORGE_MESSAGES__`.
 */
async function openHome(page: Page): Promise<MockBridge> {
  const bridge = new MockBridge();
  await bridge.setup(page);
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = 'home';
  });
  await page.goto('/');
  return bridge;
}

/** Every `i18n:locale` request posted so far, unwrapped from its envelope. */
async function localeRequests(page: Page): Promise<Record<string, unknown>[]> {
  return page.evaluate(() => {
    const msgs = (window as unknown as Record<string, unknown[]>).__SANDFORGE_MESSAGES__ ?? [];
    return msgs
      .map((m) => {
        const e = m as Record<string, unknown>;
        return (e.payload as Record<string, unknown> | undefined) ?? e;
      })
      .filter((m) => m.type === 'i18n:locale') as Record<string, unknown>[];
  });
}

/** Assert the Home panel is rendering the English bundle. */
async function expectEnglishHome(page: Page): Promise<void> {
  await expect(page.getByTestId('forge-hero-card').getByRole('heading')).toHaveText(EN.heroTitle);
  await expect(page.getByTestId('start-forge-btn')).toHaveText(EN.startForge);
  await expect(page.getByTestId('quick-actions-tile').getByRole('heading')).toHaveText(
    EN.quickActions,
  );
}

test.describe('i18n — editor locale is English', () => {
  test.use({ locale: 'en-US' });

  test('renders English without asking the host for a bundle', async ({ page }) => {
    await openHome(page);
    await page.waitForSelector('[data-testid="home-page"]');

    await expectEnglishHome(page);

    // English is compiled into the bundle (`resources: { en }`), so a webview
    // that resolves to English must never spend a bridge round trip on it.
    expect(await localeRequests(page)).toHaveLength(0);
  });
});

test.describe('i18n — editor locale is French', () => {
  test.use({ locale: 'fr-FR' });

  test('falls back to English when the host never answers the locale request', async ({ page }) => {
    const bridge = await openHome(page);

    // Detection ran: `fr-FR` matched the shipped `fr` bundle and asked for it.
    const request = await bridge.waitForMessage('i18n:locale', { timeout: 10_000 });
    expect((request.payload as { lng?: string }).lng).toBe('fr');

    // ...and it is deliberately left unanswered. The boot gate gives up after
    // 500ms and paints English, which is what a user gets whenever the
    // extension host is slow, wedged, or missing its locale files.
    await page.waitForSelector('[data-testid="home-page"]');
    await expectEnglishHome(page);
    await expect(page.getByText(FR.heroTitle)).toHaveCount(0);
  });

  test('renders French once the host answers with the bundle', async ({ page }) => {
    const bridge = await openHome(page);
    await bridge.respondToNext(
      'i18n:locale',
      'i18n:locale:response',
      { lng: 'fr', bundle: FR_BUNDLE },
      { timeout: 10_000 },
    );

    await page.waitForSelector('[data-testid="home-page"]');
    await expect(page.getByTestId('forge-hero-card').getByRole('heading')).toHaveText(FR.heroTitle);
    await expect(page.getByTestId('start-forge-btn')).toHaveText(FR.startForge);
    await expect(page.getByTestId('quick-actions-tile').getByRole('heading')).toHaveText(
      FR.quickActions,
    );

    // Translations must reach the accessibility layer too — the record input
    // is labelled from the same key that fills its placeholder.
    await expect(page.getByTestId('forge-record-input')).toHaveAttribute(
      'aria-label',
      FR.recordIdPlaceholder,
    );

    // `languageChanged` restamps `<html lang>`, so assistive tech does not
    // announce French in an English voice.
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  });
});

test.describe('i18n — language pushed by the extension', () => {
  test.use({ locale: 'en-US' });

  test('switches to French when settings:response carries a saved language', async ({ page }) => {
    const bridge = await openHome(page);
    await page.waitForSelector('[data-testid="home-page"]');
    await expectEnglishHome(page);

    // The webview state is per-document and dies with the panel; the settings
    // blob (globalState) survives. BridgeProvider adopts the blob's language
    // once, via importLanguageFromSettings — this is what a user sees after
    // picking French in one panel and opening another.
    await sendExtensionMessage(page, {
      type: 'settings:response',
      id: 'resp-settings-1',
      correlationId: 'unsolicited',
      payload: { settings: { language: 'fr' } },
    });

    // Adoption is not a local flip: it fetches the bundle over the bridge
    // first, and keeps English if that fails.
    await bridge.respondToNext(
      'i18n:locale',
      'i18n:locale:response',
      { lng: 'fr', bundle: FR_BUNDLE },
      { timeout: 10_000 },
    );

    await expect(page.getByTestId('forge-hero-card').getByRole('heading')).toHaveText(FR.heroTitle);
    await expect(page.getByTestId('quick-actions-tile').getByRole('heading')).toHaveText(
      FR.quickActions,
    );
  });
});

test.describe('i18n — key integrity', () => {
  test.use({ locale: 'en-US' });

  test('home page content uses translated strings (not raw i18n keys)', async ({ page }) => {
    await openHome(page);
    await page.waitForSelector('[data-testid="home-page"]');

    const pageContent = (await page.getByTestId('home-page').textContent()) ?? '';

    // A missing key renders as the key itself ("home.forgeASandbox"), which
    // reads as text and passes every visibility assertion — so look for the
    // shape of a key rather than for a blank screen.
    expect(pageContent).not.toContain('home.forgeASandbox');
    expect(pageContent).not.toContain('home.quickActions');
    expect(pageContent).not.toContain('home.sandboxHealth');
    expect(pageContent).not.toMatch(/\b(home|nav|common|status|onboarding)\.[a-zA-Z]+\b/);
  });
});
