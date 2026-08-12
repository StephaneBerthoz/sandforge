#!/usr/bin/env node
/**
 * Rasterise the SandForge icons from their SVG sources.
 *
 * The PNG ships to the Marketplace, so it must be reproducible from the repo
 * rather than exported by hand from a design tool and forgotten. Chromium via
 * Playwright is the renderer because it is already a dev dependency of the
 * webview package and matches what VSCode itself uses.
 *
 *   node scripts/render-icon.mjs           # write resources/icon.png
 *   node scripts/render-icon.mjs --proof   # also write size proofs to .icon-proof/
 */
import { readFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROOF = process.argv.includes('--proof');

// chromium comes from @playwright/test — the webview workspace has it as a
// dev dependency; the standalone `playwright` package is not installed.
const require = createRequire(pathToFileURL(join(ROOT, 'packages/webview/package.json')));
const { chromium } = require('@playwright/test');

/** Render an SVG file to PNG at an exact pixel size. */
async function render(page, svgPath, outPath, size, background = 'transparent', color = '#000') {
  const svg = readFileSync(svgPath, 'utf8');
  await page.setViewportSize({ width: size, height: size });
  // `color` drives fill="currentColor" — without it the mono mark renders
  // black, which on a dark activity bar proves nothing. VSCode tints the icon
  // with the theme foreground, so the proof has to do the same.
  await page.setContent(
    `<!doctype html><style>
       html,body{margin:0;padding:0;background:${background};color:${color};}
       svg{display:block;width:${size}px;height:${size}px;}
     </style>${svg}`,
  );
  await page.screenshot({ path: outPath, omitBackground: background === 'transparent' });
}

/** Width/height straight out of the PNG IHDR chunk — trust the file, not the request. */
function pngSize(path) {
  const buf = readFileSync(path);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });

const markSvg = join(ROOT, 'resources/icon.svg');
const monoSvg = join(ROOT, 'resources/icons/toolkit.svg');
const markPng = join(ROOT, 'resources/icon.png');

// The Marketplace requires >=128; 256 stays crisp on the extension page.
await render(page, markSvg, markPng, 256);
const { width, height } = pngSize(markPng);
console.log(`resources/icon.png -> ${width}x${height}`);
if (width !== 256 || height !== 256) {
  throw new Error(`Expected a 256x256 PNG, got ${width}x${height}`);
}

// The extension package ships its own copy; pre-publish-check.sh requires it.
const pkgResources = join(ROOT, 'packages/extension/resources');
if (existsSync(pkgResources)) {
  copyFileSync(markPng, join(pkgResources, 'icon.png'));
  copyFileSync(markSvg, join(pkgResources, 'icon.svg'));
  mkdirSync(join(pkgResources, 'icons'), { recursive: true });
  copyFileSync(monoSvg, join(pkgResources, 'icons/toolkit.svg'));
  console.log('mirrored icon.png / icon.svg / icons/toolkit.svg -> packages/extension/resources');
}

if (PROOF) {
  const dir = join(ROOT, '.icon-proof');
  mkdirSync(dir, { recursive: true });
  // The sizes that actually decide whether the mark works.
  for (const size of [256, 128, 42]) {
    await render(page, markSvg, join(dir, `mark-${size}.png`), size);
  }
  for (const size of [24, 20]) {
    // The two activity-bar grounds with the foreground VSCode actually tints
    // with, plus a hard silhouette: VSCode may render the icon as a mask,
    // which discards any internal contrast the mark might have leaned on.
    await render(page, monoSvg, join(dir, `mono-${size}-dark.png`), size, '#252526', '#CCCCCC');
    await render(page, monoSvg, join(dir, `mono-${size}-light.png`), size, '#F3F3F3', '#424242');
    await render(page, monoSvg, join(dir, `mono-${size}-mask.png`), size, '#FFFFFF', '#000000');
  }
  console.log(`proofs -> .icon-proof/`);
}

await browser.close();
