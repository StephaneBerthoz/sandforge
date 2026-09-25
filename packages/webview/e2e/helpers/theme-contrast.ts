/**
 * Contrast as Chromium paints it, judged against what the host theme itself
 * reaches, for what the flat axe scan does not judge.
 *
 * axe holds every text to 4.5:1 (3:1 when large). Light+ and Quiet Light write
 * their own description text under that on their own surfaces, so a flat scan
 * there fails the theme rather than the panel. And axe measures no placeholder
 * and no SVG text, skips a text made only of symbols (`□`, `−`) unless told
 * otherwise, and leaves as "incomplete" any text it finds overlapped by another
 * element: a label centred in an SVG gauge, a button floating over a canvas.
 *
 * Here every text axe measures, every text it leaves incomplete, every SVG text
 * and every placeholder on screen is measured, and held to the bar or, where
 * lower, to the theme's own contrast for its colour: when the text is in one of
 * the theme's foregrounds, the ratio that foreground reaches on the background
 * the theme pairs it with, on that very background when the text sits right on
 * it, on the best of those backgrounds when the panel has laid something of its
 * own under the text. Anything else meets the full bar.
 *
 * What axe does not measure is measured in the page: the colour Chromium
 * computes for the text (`color`, `fill`, or `::placeholder`), over everything
 * the page paints at the text's own position (backgrounds, and the fill of SVG
 * shapes), composited in paint order, opacity groups included.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { hostColours, type VsCodeTheme } from '../../src/styles/testing/vscodeThemes';
import { waitForStillness } from './axe-helper';

interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  /** 0 to 1. */
  readonly a: number;
}

const PANEL_SURFACES = ['editor-background', 'sideBar-background', 'editorWidget-background'];

/**
 * The foregrounds a theme designs to be read on given backgrounds, by the name
 * of their `--vscode-*` property: the pairs the static contrast test holds a
 * theme's own colours to.
 */
const THEME_PAIRS: Readonly<Record<string, readonly string[]>> = {
  'editor-foreground': PANEL_SURFACES,
  foreground: PANEL_SURFACES,
  descriptionForeground: PANEL_SURFACES,
  'input-foreground': ['input-background'],
  'input-placeholderForeground': ['input-background'],
  'button-foreground': ['button-background'],
  'button-secondaryForeground': ['button-secondaryBackground'],
  'badge-foreground': ['badge-background'],
  'list-activeSelectionForeground': ['list-activeSelectionBackground'],
  'notifications-foreground': ['notifications-background'],
  'editorHoverWidget-foreground': ['editorHoverWidget-background'],
};

function hex(text: string): Rgba {
  const h = text.replace('#', '');
  const byte = (at: number): number => parseInt(h.slice(at, at + 2), 16);
  return { r: byte(0), g: byte(2), b: byte(4), a: h.length === 8 ? byte(6) / 255 : 1 };
}

/** `top` painted over an opaque `under`. */
function over(top: Rgba, under: Rgba): Rgba {
  return {
    r: top.r * top.a + under.r * (1 - top.a),
    g: top.g * top.a + under.g * (1 - top.a),
    b: top.b * top.a + under.b * (1 - top.a),
    a: 1,
  };
}

function luminance({ r, g, b }: Rgba): number {
  const channel = (value: number): number => {
    const s = value / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The same colour, give or take the rounding of each side to 8-bit channels. */
const sameColour = (a: Rgba, b: Rgba): boolean =>
  Math.abs(a.r - b.r) <= 1 && Math.abs(a.g - b.g) <= 1 && Math.abs(a.b - b.b) <= 1;

const truncate = (n: number): number => Math.floor(n * 100) / 100;

const rgbHex = ({ r, g, b }: Rgba): string =>
  `#${[r, g, b].map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;

/** The ratio a text must reach: the bar, or the theme's own contrast for its colour where lower. */
function requiredRatio(
  theme: VsCodeTheme,
  foreground: Rgba,
  background: Rgba,
  bar: number,
): number {
  const colours = hostColours(theme);
  const editor = hex(colours['editor-background']);
  // A translucent background the theme pairs a colour with (Quiet Light's badge)
  // shows whichever panel surface is under it.
  const panels = PANEL_SURFACES.map((id) => over(hex(colours[id]), editor));
  let best: number | null = null;
  for (const [id, backgroundIds] of Object.entries(THEME_PAIRS)) {
    const own = colours[id];
    if (!own || !sameColour(over(hex(own), background), foreground)) continue;
    for (const backgroundId of backgroundIds) {
      const paired = colours[backgroundId];
      if (!paired) continue;
      for (const surface of panels.map((panel) => over(hex(paired), panel))) {
        // Right on a background the theme pairs it with: the text reads exactly as
        // the theme wrote it, which is the theme's own figure.
        if (sameColour(surface, background)) {
          return Math.min(bar, contrast(foreground, background));
        }
        best = Math.max(best ?? 0, contrast(over(hex(own), surface), surface));
      }
    }
  }
  return Math.min(bar, best ?? Infinity);
}

/** One text or placeholder as the page paints it, or why it could not be measured. */
interface Painted {
  readonly html: string;
  readonly foreground: Rgba | null;
  readonly background: Rgba | null;
  readonly fontSizePx: number;
  readonly bold: boolean;
  readonly unmeasured: string | null;
}

/**
 * Measure, in the page, the texts at `selectors`, every SVG text inside `scope`
 * (the whole page without it) and every placeholder on screen.
 */
async function paintedInPage(
  page: Page,
  selectors: readonly string[],
  scope: string | undefined,
): Promise<Painted[]> {
  return page.evaluate(
    ({ textSelectors, svgScope }) => {
      type Colour = { r: number; g: number; b: number; a: number };
      type Measured = Omit<Painted, 'html'>;
      const probe = document.createElement('canvas').getContext('2d', {
        willReadFrequently: true,
      }) as CanvasRenderingContext2D;
      const parse = (css: string): Colour | null => {
        if (css === 'none' || css.startsWith('url(')) return null;
        const numbers = (text: string): number[] =>
          text
            .split(/[\s,/]+/)
            .filter(Boolean)
            .map((part) => (part.endsWith('%') ? parseFloat(part) / 100 : parseFloat(part)));
        const legacy = /^rgba?\(([^)]*)\)$/.exec(css);
        if (legacy) {
          const [r, g, b, a = 1] = numbers(legacy[1]);
          return { r, g, b, a };
        }
        const srgb = /^color\(srgb ([^)]*)\)$/.exec(css);
        if (srgb) {
          const [r, g, b, a = 1] = numbers(srgb[1]);
          return { r: r * 255, g: g * 255, b: b * 255, a };
        }
        // Any other syntax: let the canvas resolve it to 8-bit sRGB.
        probe.clearRect(0, 0, 1, 1);
        probe.fillStyle = css;
        probe.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
        return { r, g, b, a: a / 255 };
      };
      const paintOver = (top: Colour, under: Colour): Colour => ({
        r: top.r * top.a + under.r * (1 - top.a),
        g: top.g * top.a + under.g * (1 - top.a),
        b: top.b * top.a + under.b * (1 - top.a),
        a: 1,
      });
      const lerp = (from: Colour, to: Colour, t: number): Colour => ({
        r: from.r + (to.r - from.r) * t,
        g: from.g + (to.g - from.g) * t,
        b: from.b + (to.b - from.b) * t,
        a: 1,
      });
      const SHAPES = new Set(['rect', 'circle', 'ellipse', 'path', 'polygon', 'polyline']);

      /** The colour an element paints across its box, or what no single colour stands for. */
      const ownPaint = (element: Element, style: CSSStyleDeclaration): Colour | string | null => {
        if (element instanceof SVGElement && !(element instanceof SVGSVGElement)) {
          if (!SHAPES.has(element.tagName.toLowerCase())) return null;
          if (style.fill.startsWith('url(')) return `the gradient fill of <${element.tagName}>`;
          const fill = parse(style.fill);
          return fill ? { ...fill, a: fill.a * parseFloat(style.fillOpacity) } : null;
        }
        if (style.backgroundImage !== 'none') {
          return `the background image of <${element.tagName.toLowerCase()}>`;
        }
        return parse(style.backgroundColor);
      };

      /** What `text` paints at (x, y) inside `element`, over everything under it there. */
      const measure = (
        element: Element,
        text: Colour | null,
        style: CSSStyleDeclaration,
        x: number,
        y: number,
      ): Measured => {
        const fontSizePx = parseFloat(style.fontSize);
        const bold = parseFloat(style.fontWeight) >= 700;
        const fail = (unmeasured: string): Measured => ({
          foreground: null,
          background: null,
          fontSizePx,
          bold,
          unmeasured,
        });
        if (!text) return fail('its colour is not a single colour');

        // Everything painted under the text, bottom first. Every element takes
        // pointer events while this runs, so the stack is what the page paints.
        // The hit can be a child holding the glyphs, as a `<tspan>` does.
        const stack = document.elementsFromPoint(x, y);
        const at = stack.findIndex((hit) => element.contains(hit));
        if (at < 0) return fail('not found at its own text position');

        const layers: ({ colour: Colour } | { group: number })[] = [];
        // A paint no single colour stands for (an image, a pattern) counts only
        // while nothing opaque has been painted over it since.
        let hidden: { reason: string; at: number } | null = null;
        for (const layer of stack.slice(at).reverse()) {
          const own = getComputedStyle(layer);
          const opacity = parseFloat(own.opacity);
          const holdsText = layer === element || layer.contains(element);
          if (holdsText && opacity < 1) layers.push({ group: opacity });
          // An SVG text paints its glyphs, not a box.
          if (layer === element && element instanceof SVGElement) continue;
          const colour = ownPaint(layer, own);
          if (typeof colour === 'string') {
            hidden = { reason: colour, at: layers.length };
            continue;
          }
          if (colour && colour.a > 0) {
            const paint = holdsText ? colour : { ...colour, a: colour.a * opacity };
            layers.push({ colour: paint });
            const grouped = hidden && layers.slice(hidden.at).some((entry) => 'group' in entry);
            if (paint.a >= 1 && !grouped) hidden = null;
          }
        }
        if (hidden) return fail(`painted on ${hidden.reason}`);
        const render = (base: Colour, from: number): { background: Colour; foreground: Colour } => {
          let background = base;
          for (let i = from; i < layers.length; i += 1) {
            const layer = layers[i];
            if ('group' in layer) {
              const inner = render(background, i + 1);
              return {
                background: lerp(background, inner.background, layer.group),
                foreground: lerp(background, inner.foreground, layer.group),
              };
            }
            background = paintOver(layer.colour, background);
          }
          return { background, foreground: paintOver(text, background) };
        };
        const pixel = render({ r: 255, g: 255, b: 255, a: 1 }, 0);
        return { ...pixel, fontSizePx, bold, unmeasured: null };
      };

      const unmeasured = (html: string, reason: string): Painted => ({
        html,
        foreground: null,
        background: null,
        fontSizePx: 0,
        bold: false,
        unmeasured: reason,
      });
      const painted: Painted[] = [];
      const hitTestAll = document.createElement('style');
      hitTestAll.textContent = '* { pointer-events: auto !important; }';
      document.head.append(hitTestAll);
      try {
        for (const selector of textSelectors) {
          const element = document.querySelector(selector);
          if (!element) {
            painted.push(unmeasured(selector, 'no longer on the page'));
            continue;
          }
          // Painted with `fill`, not `color`: measured with the SVG texts below.
          if (element instanceof SVGElement) continue;
          const html = element.outerHTML.slice(0, 160);
          element.scrollIntoView({ block: 'center', inline: 'nearest' });
          const textNode = Array.from(element.childNodes).find(
            (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '',
          );
          const range = document.createRange();
          range.selectNodeContents(textNode ?? element);
          const box = Array.from(range.getClientRects()).find((rect) => rect.width > 0);
          if (!box) {
            painted.push(unmeasured(html, 'its text has no box on screen'));
            continue;
          }
          const style = getComputedStyle(element);
          painted.push({
            html,
            ...measure(
              element,
              parse(style.color),
              style,
              box.left + box.width / 2,
              box.top + box.height / 2,
            ),
          });
        }

        const svgRoot = svgScope ? document.querySelector(svgScope) : document;
        const svgTexts = Array.from(svgRoot?.querySelectorAll('svg text') ?? []).filter(
          (text) =>
            (text.textContent ?? '').trim() !== '' &&
            text.getClientRects().length > 0 &&
            getComputedStyle(text).visibility === 'visible' &&
            getComputedStyle(text).fill !== 'none',
        );
        for (const text of svgTexts) {
          const html = text.outerHTML.slice(0, 160);
          text.scrollIntoView({ block: 'center', inline: 'nearest' });
          const box = text.getBoundingClientRect();
          const style = getComputedStyle(text);
          const fill = parse(style.fill);
          painted.push({
            html,
            ...measure(
              text,
              fill && { ...fill, a: fill.a * parseFloat(style.fillOpacity) },
              style,
              box.left + box.width / 2,
              box.top + box.height / 2,
            ),
          });
        }

        const fields = Array.from(
          document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
            'input[placeholder], textarea[placeholder]',
          ),
        ).filter(
          (field) =>
            field.placeholder.trim() !== '' &&
            field.value === '' &&
            !field.disabled &&
            field.getClientRects().length > 0 &&
            getComputedStyle(field).visibility === 'visible',
        );
        for (const field of fields) {
          field.scrollIntoView({ block: 'center', inline: 'nearest' });
          const style = getComputedStyle(field);
          const placeholder = getComputedStyle(field, '::placeholder');
          const box = field.getBoundingClientRect();
          painted.push({
            html: `${field.outerHTML.slice(0, 160)} placeholder`,
            ...measure(
              field,
              parse(placeholder.color),
              placeholder,
              box.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft) + 2,
              box.top + parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop) + 2,
            ),
          });
        }
      } finally {
        hitTestAll.remove();
      }
      return painted;
    },
    { textSelectors: selectors, svgScope: scope },
  );
}

/**
 * What falls short on the page as it is painted now: every text axe measures
 * or leaves incomplete (symbols included) and every SVG text, inside `include`
 * (the whole page without it), and every placeholder on screen, each held to the
 * bar or to the theme's own contrast for its colour.
 */
export async function themeContrastShortfalls(
  page: Page,
  theme: VsCodeTheme,
  include?: string,
): Promise<string[]> {
  await waitForStillness(page);
  // axe reads options for one check at run time, merged over its defaults; its
  // RunOptions type does not declare them.
  const measureSymbols: Parameters<AxeBuilder['options']>[0] & {
    checks: Record<string, { options: Record<string, unknown> }>;
  } = { checks: { 'color-contrast': { options: { ignoreUnicode: false } } } };
  let builder = new AxeBuilder({ page }).options(measureSymbols).withRules(['color-contrast']);
  if (include) builder = builder.include(include);
  const results = await builder.analyze();

  const shortfalls: string[] = [];
  const judge = (html: string, foreground: Rgba, background: Rgba, bar: number): void => {
    const ratio = contrast(foreground, background);
    const required = requiredRatio(theme, foreground, background, bar);
    if (ratio < required) {
      shortfalls.push(
        `${html}: ${rgbHex(foreground)} on ${rgbHex(background)} = ${truncate(ratio)}:1, needs ${truncate(required)}:1`,
      );
    }
  };

  for (const node of results.violations.flatMap((violation) => violation.nodes)) {
    const data = node.any[0]?.data as
      { fgColor?: string; bgColor?: string; expectedContrastRatio?: string } | undefined;
    if (!data?.fgColor || !data.bgColor || !data.expectedContrastRatio) {
      shortfalls.push(`${node.html.slice(0, 120)}: ${node.any[0]?.message ?? 'unmeasured'}`);
      continue;
    }
    judge(
      node.html.slice(0, 120),
      hex(data.fgColor),
      hex(data.bgColor),
      parseFloat(data.expectedContrastRatio),
    );
  }

  const incomplete = results.incomplete
    .flatMap((result) => result.nodes)
    .map((node) => node.target[0])
    .filter((target): target is string => typeof target === 'string');
  for (const painted of await paintedInPage(page, incomplete, include)) {
    if (painted.unmeasured || !painted.foreground || !painted.background) {
      shortfalls.push(`${painted.html}: ${painted.unmeasured ?? 'unmeasured'}`);
      continue;
    }
    const large = painted.fontSizePx >= 24 || (painted.bold && painted.fontSizePx >= 18.66);
    judge(painted.html, painted.foreground, painted.background, large ? 3 : 4.5);
  }
  return shortfalls;
}
