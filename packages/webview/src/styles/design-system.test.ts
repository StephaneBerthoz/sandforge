import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';

/**
 * Token gate: every `var(--sf-*)` consumed anywhere under src/ — or by the
 * Tailwind theme, which mints utility classes from the same tokens — must be
 * defined in design-system.css. Guards against ghost tokens (used but never
 * defined), which silently fall back to hardcoded hex values.
 */

const SRC_ROOT = path.resolve(__dirname, '..');
const DESIGN_SYSTEM_PATH = path.join(SRC_ROOT, 'styles', 'design-system.css');
const TAILWIND_CONFIG_PATH = path.resolve(SRC_ROOT, '..', 'tailwind.config.ts');

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectSourceFiles(full));
    } else if (/\.(ts|tsx|css)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function definedTokens(): Set<string> {
  const css = fs.readFileSync(DESIGN_SYSTEM_PATH, 'utf8');
  return new Set([...css.matchAll(/(--sf-[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1]));
}

/** Parse a `name: { key: 'value', … }` block out of the Tailwind config source. */
function tailwindBlock(name: string): Record<string, string> {
  const config = fs.readFileSync(TAILWIND_CONFIG_PATH, 'utf8');
  const block = new RegExp(`\\b${name}:\\s*\\{([^}]*)\\}`).exec(config);
  if (!block) return {};
  return Object.fromEntries(
    [...block[1].matchAll(/([A-Za-z][\w-]*):\s*'([^']*)'/g)].map((m) => [m[1], m[2]]),
  );
}

describe('design-system tokens', () => {
  it('defines every var(--sf-*) token used by src/ and the Tailwind theme', () => {
    const defined = definedTokens();
    const ghosts: string[] = [];
    for (const file of [...collectSourceFiles(SRC_ROOT), TAILWIND_CONFIG_PATH]) {
      // This test file mentions the pattern only as a regex — skip itself.
      if (file === __filename) continue;
      const content = fs.readFileSync(file, 'utf8');
      for (const match of content.matchAll(/var\((--sf-[a-zA-Z0-9-]+)/g)) {
        if (!defined.has(match[1])) {
          ghosts.push(`${match[1]} (${path.relative(SRC_ROOT, file)})`);
        }
      }
    }
    expect(ghosts).toEqual([]);
  });
});

/* ===================== severity tokens: contrast, not shape ===================== */

const AA = 4.5;

type Severity = 'error' | 'warning' | 'success' | 'info';
const SEVERITIES: readonly Severity[] = ['error', 'warning', 'success', 'info'];

type Rgb = readonly [number, number, number];

function parseHex(hex: string): Rgb {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** WCAG 2.1 relative luminance of an sRGB colour. */
function relativeLuminance([r, g, b]: Rgb): number {
  const channel = (value: number): number => {
    const s = value / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** What `color-mix(in srgb, a keep%, b)` resolves to when both operands are opaque. */
function mixSrgb(a: Rgb, b: Rgb, keep: number): Rgb {
  const t = keep / 100;
  return [a[0] * t + b[0] * (1 - t), a[1] * t + b[1] * (1 - t), a[2] * t + b[2] * (1 - t)];
}

const round = (n: number): number => Math.round(n * 100) / 100;

/**
 * The colours VSCode actually ships, so the ratios below are measured against
 * what a user sees rather than against a convenient fixture. Read from
 * microsoft/vscode on 2026-09-09: `extensions/theme-defaults/themes/*.json`,
 * `extensions/theme-quietlight`, `extensions/theme-solarized-light`, and — for
 * the keys a theme leaves unset — the registry defaults in
 * `src/vs/platform/theme/common/colors/{base,editor}Colors.ts` and
 * `src/vs/workbench/contrib/testing/browser/theme.ts`.
 *
 * `backgrounds` lists every surface the webview is painted on (editor, widget,
 * side bar), because the severity has to hold up on all of them.
 */
interface ShippedTheme {
  readonly name: string;
  readonly backgrounds: readonly string[];
  /** `--vscode-editor-foreground`, which `--sf-text-primary` resolves to. */
  readonly editorForeground: string;
  /** The values `--sf-{error,warning,success,info}` resolve to in this theme. */
  readonly severities: Readonly<Record<Severity, string>>;
}

const SHIPPED_THEMES: readonly ShippedTheme[] = [
  {
    name: 'Dark+',
    backgrounds: ['#1E1E1E'],
    editorForeground: '#D4D4D4',
    severities: { error: '#F48771', warning: '#CCA700', success: '#73c991', info: '#59a4f9' },
  },
  {
    name: 'Dark Modern',
    backgrounds: ['#1F1F1F', '#202020', '#181818'],
    editorForeground: '#CCCCCC',
    severities: { error: '#F85149', warning: '#CCA700', success: '#73c991', info: '#59a4f9' },
  },
  {
    name: 'Light+',
    backgrounds: ['#FFFFFF'],
    editorForeground: '#000000',
    severities: { error: '#A1260D', warning: '#BF8803', success: '#73c991', info: '#0063d3' },
  },
  {
    name: 'Light Modern',
    backgrounds: ['#FFFFFF', '#F8F8F8'],
    editorForeground: '#3B3B3B',
    severities: { error: '#F85149', warning: '#BF8803', success: '#73c991', info: '#0063d3' },
  },
  {
    name: 'Quiet Light',
    backgrounds: ['#F5F5F5', '#F2F2F2'],
    editorForeground: '#333333',
    severities: { error: '#f1897f', warning: '#BF8803', success: '#73c991', info: '#0063d3' },
  },
  {
    name: 'Solarized Light',
    backgrounds: ['#FDF6E3', '#EEE8D5'],
    editorForeground: '#657B83',
    severities: { error: '#A1260D', warning: '#BF8803', success: '#73c991', info: '#0063d3' },
  },
];

/** How legible the theme's own editor text is — the ceiling any token can reach. */
function bodyTextContrast(theme: ShippedTheme): number {
  return Math.min(
    ...theme.backgrounds.map((bg) => contrastRatio(parseHex(theme.editorForeground), parseHex(bg))),
  );
}

interface SeverityToken {
  /** The `--sf-*` variable carrying the theme's own severity colour. */
  readonly hue: string;
  /** Percentage of that hue kept; the remainder is pulled toward `anchor`. */
  readonly keep: number;
  /** The `--sf-*` variable the hue is pulled toward, or null if it is not pulled. */
  readonly anchor: string | null;
}

/**
 * The exact declaration the config must carry: an inner mix that hardens the
 * hue against the theme, wrapped in an outer mix that hands Tailwind the alpha
 * channel it needs to honour `/10`.
 */
const SEVERITY_DECLARATION =
  /^color-mix\(in srgb, color-mix\(in srgb, var\((--sf-[a-z-]+)\) (\d+)%, var\((--sf-[a-z-]+)\)\) calc\(<alpha-value> \* 100%\), transparent\)$/;

/**
 * Reads the config at face value — it never asserts. A token declared some
 * other way (a bare `var(--sf-error)`, say) parses as its hue kept whole with
 * nothing to pull it toward the theme, so the contrast tests below go on to
 * measure that declaration instead of stopping at its shape.
 */
function severityTokens(): Record<Severity, SeverityToken> {
  const block = tailwindBlock('status');
  const parsed: Partial<Record<Severity, SeverityToken>> = {};
  for (const severity of SEVERITIES) {
    const value = block[severity] ?? '';
    const hardened = SEVERITY_DECLARATION.exec(value);
    const bare = /^var\((--sf-[a-z-]+)\)$/.exec(value);
    parsed[severity] = hardened
      ? { hue: hardened[1], keep: Number(hardened[2]), anchor: hardened[3] }
      : { hue: bare ? bare[1] : '', keep: 100, anchor: null };
  }
  return parsed as Record<Severity, SeverityToken>;
}

/** The colour `text-status-<severity>` actually paints in a given theme. */
function renderedSeverity(theme: ShippedTheme, severity: Severity, keep: number): Rgb {
  return mixSrgb(parseHex(theme.severities[severity]), parseHex(theme.editorForeground), keep);
}

function worstContrast(theme: ShippedTheme, colour: Rgb): number {
  return Math.min(...theme.backgrounds.map((bg) => contrastRatio(colour, parseHex(bg))));
}

describe('severity token contrast', () => {
  /**
   * The defect the tokens replace, and a check on the luminance maths above:
   * these two ratios are the bounds the accessibility audit reported.
   */
  it('measures the fixed palette as illegible on a white editor', () => {
    const palette400 = {
      'red-400': '#f87171',
      'amber-400': '#fbbf24',
      'yellow-400': '#facc15',
      'green-400': '#4ade80',
      'blue-400': '#60a5fa',
      'orange-400': '#fb923c',
    };
    const white = parseHex('#FFFFFF');
    const failures = Object.entries(palette400).filter(
      ([, hex]) => contrastRatio(parseHex(hex), white) >= AA,
    );
    expect(failures).toEqual([]);
    expect(round(contrastRatio(parseHex(palette400['yellow-400']), white))).toBe(1.53);
    expect(round(contrastRatio(parseHex(palette400['red-400']), white))).toBe(2.77);
  });

  it('pulls each severity toward the editor foreground the themes are modelled with', () => {
    const block = tailwindBlock('status');
    const tokens = severityTokens();
    const defined = definedTokens();
    const css = fs.readFileSync(DESIGN_SYSTEM_PATH, 'utf8');

    for (const severity of SEVERITIES) {
      const { hue, anchor, keep } = tokens[severity];
      expect(
        anchor,
        `status.${severity} is not a hardened, alpha-capable token: ${block[severity]}`,
      ).toBe('--sf-text-primary');
      expect(defined.has(hue), `${hue} is not defined in design-system.css`).toBe(true);
      expect(keep).toBeGreaterThan(0);
      expect(keep).toBeLessThanOrEqual(100);
    }
    // The model above reads `editorForeground` per theme; that is only the
    // right anchor while --sf-text-primary still resolves to it.
    expect(css).toMatch(/--sf-text-primary:\s*var\(--vscode-editor-foreground/);
  });

  it('clears AA on every shipped theme whose own editor text clears AA', () => {
    const tokens = severityTokens();
    const failures: string[] = [];
    for (const theme of SHIPPED_THEMES) {
      if (bodyTextContrast(theme) < AA) continue;
      for (const severity of SEVERITIES) {
        const ratio = worstContrast(
          theme,
          renderedSeverity(theme, severity, tokens[severity].keep),
        );
        if (ratio < AA) {
          failures.push(`${theme.name}/${severity} = ${round(ratio)}:1`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  /**
   * Solarized Light cannot be rescued: its own editor text is below AA, so no
   * colour anchored on that foreground can climb past it. Pinned by name so the
   * skip in the test above stays one known theme rather than a growing list.
   */
  it('names the one shipped theme that is already below AA for its own text', () => {
    const belowAA = SHIPPED_THEMES.filter((theme) => bodyTextContrast(theme) < AA).map(
      (theme) => theme.name,
    );
    expect(belowAA).toEqual(['Solarized Light']);
    const solarized = SHIPPED_THEMES.find((theme) => theme.name === 'Solarized Light');
    expect(round(bodyTextContrast(solarized as ShippedTheme))).toBe(3.64);
  });

  it('never leaves a severity below both AA and the raw theme colour it replaces', () => {
    const tokens = severityTokens();
    const regressions: string[] = [];
    for (const theme of SHIPPED_THEMES) {
      for (const severity of SEVERITIES) {
        const raw = worstContrast(theme, parseHex(theme.severities[severity]));
        const hardened = worstContrast(
          theme,
          renderedSeverity(theme, severity, tokens[severity].keep),
        );
        if (hardened < AA && hardened <= raw) {
          regressions.push(`${theme.name}/${severity}: ${round(raw)} -> ${round(hardened)}`);
        }
      }
    }
    expect(regressions).toEqual([]);
  });

  it('leaves the raw theme severities failing, which is why they are hardened', () => {
    const illegible = SHIPPED_THEMES.flatMap((theme) =>
      SEVERITIES.filter(
        (severity) => worstContrast(theme, parseHex(theme.severities[severity])) < AA,
      ).map((severity) => `${theme.name}/${severity}`),
    );
    // Every light theme VSCode ships fails on warning and success untreated.
    expect(illegible).toContain('Light+/success');
    expect(illegible).toContain('Quiet Light/error');
    expect(illegible).toContain('Solarized Light/warning');
    expect(illegible.length).toBeGreaterThanOrEqual(9);
  });
});

/* ===================== severity tokens: the opacity modifier ===================== */

const MODIFIER_PROBE = [
  'bg-status-warning/10',
  'border-status-warning/40',
  'text-status-error',
  'text-status-info/70',
  'bg-status-success/20',
  'border-status-error/40',
  'bg-status-error/10',
  'bg-status-info/10',
  'border-status-success/40',
  'border-status-info/40',
];

async function buildUtilities(colours: Record<string, string>): Promise<string> {
  const result = await postcss([
    tailwindcss({
      content: [{ raw: MODIFIER_PROBE.join(' '), extension: 'html' }],
      corePlugins: { preflight: false },
      theme: { extend: { colors: { status: colours } } },
    }),
  ]).process('@tailwind utilities;', { from: undefined });
  return result.css;
}

describe('severity token opacity modifiers', () => {
  it('compiles every bg/border/text utility the product asks for', async () => {
    const tokens = severityTokens();
    const css = await buildUtilities(tailwindBlock('status'));
    const missing = MODIFIER_PROBE.filter(
      (utility) => !css.includes(`.${utility.replace('/', '\\/')} `),
    );
    expect(missing).toEqual([]);
    // The Forge SOQL callout: a background and a border, both with a modifier.
    expect(css).toContain(`var(${tokens.warning.hue}) ${tokens.warning.keep}%`);
    expect(css).toContain('calc(0.1 * 100%)');
    expect(css).toContain('calc(0.4 * 100%)');
  });

  /**
   * The shape half of the defect, kept executable: a bare `var(--sf-*)` is not
   * a colour Tailwind can parse, so it emits nothing for the modified variants
   * and no error either. This is what the callout used to compile to.
   */
  it('confirms a bare var() token is what Tailwind drops in silence', async () => {
    const css = await buildUtilities({
      error: 'var(--sf-error)',
      warning: 'var(--sf-warning)',
      success: 'var(--sf-success)',
      info: 'var(--sf-info)',
    });
    expect(css).toContain('.text-status-error');
    for (const utility of MODIFIER_PROBE.filter((u) => u.includes('/'))) {
      expect(css, `${utility} unexpectedly compiled`).not.toContain(utility.replace('/', '\\/'));
    }
  });
});

/**
 * Severity and state colours must resolve through the theme, not through a
 * fixed palette hue: a value baked into the config can only satisfy AA against
 * one background, and the webview is rendered on whichever theme the user picked.
 */
describe('theme-resolved colours', () => {
  it('carries no literal colour in the severity block', () => {
    for (const [severity, value] of Object.entries(tailwindBlock('status'))) {
      expect(value, `status.${severity} hardcodes a colour: ${value}`).not.toMatch(
        /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/,
      );
    }
  });

  it('resolves the active border through the accent token', () => {
    const active = tailwindBlock('borderColor').active;
    expect(active, 'borderColor.active is missing').toBeDefined();
    expect(active).toContain('var(--sf-accent');
  });
});
