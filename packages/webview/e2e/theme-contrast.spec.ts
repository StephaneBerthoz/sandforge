import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { themeContrastShortfalls } from './helpers/theme-contrast';
import { vscodeTheme } from '../src/styles/testing/vscodeThemes';

/**
 * The rendered contrast check held to what it is for: each fixture paints one
 * way a text can fall short, and the check must say so. Every spec that calls
 * it asserts an empty list, which a text it cannot see passes as well as a
 * readable one. None of these colours is a theme's, so each is held to the
 * full bar.
 */

const THEME = vscodeTheme('Dark Modern');

/** A page of `body` on a white ground, with no VS Code styles. */
async function paint(page: Page, body: string): Promise<void> {
  await page.setContent(
    `<!DOCTYPE html><html><head><style>
      body { margin: 0; background: #ffffff; font: 14px sans-serif; }
      select { appearance: none; background: #ffffff; border: 1px solid #000000; padding: 4px 8px; }
    </style></head><body>${body}</body></html>`,
  );
}

/** A veil over the whole page, of white at `alpha`: axe reads the text under it as if bare. */
const veil = (alpha: number): string =>
  `<div style="position:fixed;inset:0;background:rgba(255,255,255,${alpha})"></div>`;

/**
 * `content` in a section with a veil of white at `alpha` over the section
 * alone: axe leaves the text under it incomplete, overlapped.
 */
const veiledSection = (content: string, alpha: number): string =>
  `<section style="position:relative;margin:24px;padding:8px">${content}
     <div style="position:absolute;inset:0;background:rgba(255,255,255,${alpha})"></div>
   </section>`;

test.describe('rendered contrast check', () => {
  test('measures a text axe reads as bare through the veil drawn over it', async ({ page }) => {
    // Black on white reads 21:1; under four fifths of white, 1.6:1.
    await paint(page, `<p style="color:#000000;margin:24px">Words under a veil</p>${veil(0.8)}`);
    const shortfalls = await themeContrastShortfalls(page, THEME);
    expect(shortfalls.filter((line) => line.includes('Words under a veil'))).toEqual([
      expect.stringMatching(/: #cccccc on #ffffff = 1\.6\d*:1, needs 4\.5:1$/),
    ]);
  });

  test('measures a text axe calls overlapped through the veil drawn over it', async ({ page }) => {
    await paint(page, veiledSection('<p style="color:#000000">Words in a veiled section</p>', 0.8));
    const shortfalls = await themeContrastShortfalls(page, THEME);
    expect(shortfalls.filter((line) => line.includes('Words in a veiled section'))).toEqual([
      expect.stringMatching(/: #cccccc on #ffffff = 1\.6\d*:1, needs 4\.5:1$/),
    ]);
  });

  test('reads a text a light veil leaves readable as readable', async ({ page }) => {
    await paint(
      page,
      `<p style="color:#000000;margin:24px">Words under a light veil</p>${veil(0.2)}` +
        veiledSection('<p style="color:#000000">Words in a lightly veiled section</p>', 0.2),
    );
    expect(await themeContrastShortfalls(page, THEME)).toEqual([]);
  });

  test('says a text an opaque layer hides is covered', async ({ page }) => {
    await paint(
      page,
      `<p style="color:#000000;margin:24px">Words under a card</p>
       <div data-testid="card" style="position:fixed;inset:0;background:#ffffff"></div>`,
    );
    const shortfalls = await themeContrastShortfalls(page, THEME);
    expect(shortfalls.filter((line) => line.includes('Words under a card'))).toEqual([
      expect.stringMatching(/: covered by <div data-testid="card">$/),
    ]);
  });

  test('measures the text of a select axe calls overlapped through the veil over it', async ({
    page,
  }) => {
    // #333333 on white reads 12.6:1; under four fifths of white, 1.4:1.
    await paint(
      page,
      veiledSection(
        `<select aria-label="Mode" style="color:#333333">
           <option>Chosen under a veil</option><option>Other</option>
         </select>`,
        0.8,
      ),
    );
    const shortfalls = await themeContrastShortfalls(page, THEME);
    expect(shortfalls).toEqual([
      expect.stringMatching(/^<select.*: #d6d6d6 on #ffffff = 1\.4\d*:1, needs 4\.5:1$/s),
    ]);
  });

  test('reads a select a light veil leaves readable as readable', async ({ page }) => {
    await paint(
      page,
      veiledSection(
        `<select aria-label="Mode" style="color:#333333">
           <option>Chosen under a light veil</option>
         </select>`,
        0.2,
      ),
    );
    expect(await themeContrastShortfalls(page, THEME)).toEqual([]);
  });

  test('holds a select axe reads in the open to its colours', async ({ page }) => {
    await paint(
      page,
      `<label style="display:block;margin:24px">Mode
         <select style="color:#aaaaaa"><option>Pale choice</option></select>
       </label>`,
    );
    const shortfalls = await themeContrastShortfalls(page, THEME);
    expect(shortfalls.filter((line) => line.includes('Pale choice'))).toEqual([
      expect.stringMatching(/: #aaaaaa on #ffffff = 2\.3\d*:1, needs 4\.5:1$/),
    ]);
  });

  test('holds what a modal dialog shows, and nothing it leaves outside it', async ({ page }) => {
    await paint(
      page,
      `<style>.pale::placeholder { color: #aaaaaa; }</style>
       <input class="pale" placeholder="Pale behind the dialog" style="margin:24px">
       <dialog style="border:0;background:#ffffff">
         <p style="color:#aaaaaa">Pale in the dialog</p>
       </dialog>`,
    );
    await page.locator('dialog').evaluate((dialog) => (dialog as HTMLDialogElement).showModal());
    const shortfalls = await themeContrastShortfalls(page, THEME);
    expect(shortfalls).toEqual([
      expect.stringMatching(/Pale in the dialog.*= 2\.3\d*:1, needs 4\.5:1$/),
    ]);
  });

  test('holds nothing a veil marked aria-modal leaves behind it', async ({ page }) => {
    await paint(
      page,
      `<p style="color:#000000;margin:24px">Words behind a modal</p>
       <div role="dialog" aria-modal="true" aria-label="Modal"
            style="position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center">
         <p style="color:#000000;background:#ffffff;padding:8px">Words in the modal</p>
       </div>`,
    );
    expect(await themeContrastShortfalls(page, THEME)).toEqual([]);
  });

  test('holds nothing a dialog leaves outside it while the page takes no pointer', async ({
    page,
  }) => {
    // As the confirmations draw it: the page hidden from assistive technology
    // but for its live region, out of the pointer's reach, a veil, the dialog.
    await paint(
      page,
      `<main aria-hidden="true"><p style="color:#000000;margin:24px">Words behind a confirmation</p></main>
       <p aria-live="polite" style="color:#000000;margin:24px">Live words behind a confirmation</p>
       <div style="position:fixed;inset:0;background:rgba(10,10,15,0.75);display:flex;align-items:center;justify-content:center">
         <div role="dialog" aria-label="Confirm" style="background:#ffffff;padding:8px;pointer-events:auto">
           <p style="color:#aaaaaa">Pale in the confirmation</p>
         </div>
       </div>`,
    );
    await page.evaluate(() => {
      document.body.style.pointerEvents = 'none';
    });
    const shortfalls = await themeContrastShortfalls(page, THEME);
    expect(shortfalls).toEqual([
      expect.stringMatching(/Pale in the confirmation.*= 2\.3\d*:1, needs 4\.5:1$/),
    ]);
  });

  test('holds the page under a dialog that leaves it within reach', async ({ page }) => {
    await paint(
      page,
      `<p style="color:#000000;margin:24px">Words beside a popover</p>${veil(0.8)}
       <div role="dialog" aria-label="Popover" style="position:fixed;right:0;bottom:0;background:#ffffff;padding:8px">
         <p style="color:#000000">In the popover</p>
       </div>`,
    );
    const shortfalls = await themeContrastShortfalls(page, THEME);
    expect(shortfalls.filter((line) => line.includes('Words beside a popover'))).toEqual([
      expect.stringMatching(/= 1\.6\d*:1, needs 4\.5:1$/),
    ]);
  });
});
