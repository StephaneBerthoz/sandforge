import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { compile } from '@tailwindcss/node';
import postcss from 'postcss';
import * as ts from 'typescript';
import {
  VSCODE_THEMES,
  hostColours,
  themeColour,
  vscodeTheme,
  type VsCodeTheme,
} from './testing/vscodeThemes';

/**
 * Token gate: every `var(--sf-*)` consumed anywhere under src/ — or by the
 * Tailwind theme, which mints utility classes from the same tokens — must be
 * defined in design-system.css. Guards against ghost tokens (used but never
 * defined), which silently fall back to hardcoded hex values.
 */

const SRC_ROOT = path.resolve(__dirname, '..');
const DESIGN_SYSTEM_PATH = path.join(SRC_ROOT, 'styles', 'design-system.css');
const THEME_PATH = path.join(SRC_ROOT, 'styles', 'theme.css');

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

/** Where `tailwindBlock` finds each theme key in theme.css's `@theme`. */
const THEME_NAMESPACES: Readonly<Record<string, string>> = {
  status: '--color-status-',
  hue: '--color-hue-',
  borderColor: '--border-color-',
};

/** A theme key's entries, `{ error: 'color-mix(…)', … }`, read out of theme.css's `@theme`. */
function tailwindBlock(name: string): Record<string, string> {
  const prefix = THEME_NAMESPACES[name];
  if (!prefix) return {};
  const theme = fs.readFileSync(THEME_PATH, 'utf8');
  const entries: Record<string, string> = {};
  const declaration = new RegExp(`${prefix}([a-z][\\w-]*):\\s*([^;]+);`, 'g');
  for (const [, key, value] of theme.matchAll(declaration)) {
    entries[key] = value.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim();
  }
  return entries;
}

describe('design-system tokens', () => {
  it('defines every var(--sf-*) token used by src/ and the Tailwind theme', () => {
    const defined = definedTokens();
    const ghosts: string[] = [];
    for (const file of collectSourceFiles(SRC_ROOT)) {
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
 * The colours VS Code sends under each measured theme, so the ratios below are
 * measured against what a user sees rather than against a convenient fixture:
 * each theme's own values and, for the keys it leaves unset, the registry
 * defaults, as ./testing/vscodeThemes.ts records them from microsoft/vscode
 * (which also names the measured themes).
 *
 * `backgrounds` lists every surface the webview is painted on (editor, side
 * bar, widget), because the severity has to hold up on all of them.
 */
interface MeasuredTheme {
  readonly name: string;
  readonly backgrounds: readonly string[];
  /** `--vscode-editor-foreground`, which `--sf-text-primary` resolves to. */
  readonly editorForeground: string;
  /**
   * `--vscode-descriptionForeground`, which `--sf-text-secondary` resolves to:
   * the theme's own value, else the registry default — `#717171` on a light
   * theme, the dark foreground at 70% on a dark one.
   */
  readonly descriptionForeground: string;
  /** The values `--sf-{error,warning,success,info}` resolve to in this theme. */
  readonly severities: Readonly<Record<Severity, string>>;
}

const MEASURED_THEMES: readonly MeasuredTheme[] = VSCODE_THEMES.map((theme) => {
  const colour = (id: string): string => {
    const value = themeColour(theme, id);
    if (value === null) throw new Error(`${theme.name} sends no ${id}`);
    return value;
  };
  return {
    name: theme.name,
    backgrounds: [
      ...new Set(
        ['editor.background', 'sideBar.background', 'editorWidget.background'].map(colour),
      ),
    ],
    editorForeground: colour('editor.foreground'),
    descriptionForeground: colour('descriptionForeground'),
    severities: {
      error: colour('errorForeground'),
      warning: colour('editorWarning.foreground'),
      success: colour('testing.iconPassed'),
      info: colour('editorInfo.foreground'),
    },
  };
});

/** How legible the theme's own editor text is — the ceiling any token can reach. */
function bodyTextContrast(theme: MeasuredTheme): number {
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
 * The exact declaration the theme must carry: a mix that hardens the hue
 * against the theme. Tailwind 4 gives it its `/10` through a mix of its own.
 */
const SEVERITY_DECLARATION =
  /^color-mix\(in srgb, var\((--sf-[a-z-]+)\) (\d+)%, var\((--sf-[a-z-]+)\)\)$/;

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
function renderedSeverity(theme: MeasuredTheme, severity: Severity, keep: number): Rgb {
  return mixSrgb(parseHex(theme.severities[severity]), parseHex(theme.editorForeground), keep);
}

function worstContrast(theme: MeasuredTheme, colour: Rgb): number {
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
    // And each severity only while it reads the host colour MEASURED_THEMES takes for it.
    expect(css).toMatch(/--sf-error:\s*var\(--vscode-errorForeground/);
    expect(css).toMatch(/--sf-warning:\s*var\(--vscode-editorWarning-foreground/);
    expect(css).toMatch(/--sf-success:\s*var\(--vscode-testing-iconPassed/);
    expect(css).toMatch(/--sf-info:\s*var\(--vscode-editorInfo-foreground/);
  });

  it('clears AA on every measured theme whose own editor text clears AA', () => {
    const tokens = severityTokens();
    const failures: string[] = [];
    for (const theme of MEASURED_THEMES) {
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
  it('names the one measured theme that is already below AA for its own text', () => {
    const belowAA = MEASURED_THEMES.filter((theme) => bodyTextContrast(theme) < AA).map(
      (theme) => theme.name,
    );
    expect(belowAA).toEqual(['Solarized Light']);
    const solarized = MEASURED_THEMES.find((theme) => theme.name === 'Solarized Light');
    expect(round(bodyTextContrast(solarized as MeasuredTheme))).toBe(3.64);
  });

  it('never leaves a severity below both AA and the raw theme colour it replaces', () => {
    const tokens = severityTokens();
    const regressions: string[] = [];
    for (const theme of MEASURED_THEMES) {
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
    const illegible = MEASURED_THEMES.flatMap((theme) =>
      SEVERITIES.filter(
        (severity) => worstContrast(theme, parseHex(theme.severities[severity])) < AA,
      ).map((severity) => `${theme.name}/${severity}`),
    );
    // The measured light themes fail on warning and success untreated.
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

/** Tailwind 4's utilities, `candidates` alone, over the default theme and `theme`. */
async function buildWithTheme(theme: string, candidates: Iterable<string>): Promise<string> {
  const compiler = await compile(
    `@import 'tailwindcss/theme' layer(theme);\n${theme}\n@import 'tailwindcss/utilities' layer(utilities);`,
    { base: SRC_ROOT, onDependency: () => {} },
  );
  return compiler.build([...candidates]);
}

/** The severity utilities, with `colours` as the status tokens. */
async function buildUtilities(colours: Record<string, string>): Promise<string> {
  const tokens = Object.entries(colours)
    .map(([key, value]) => `--color-status-${key}: ${value};`)
    .join(' ');
  return buildWithTheme(`@theme { ${tokens} }`, MODIFIER_PROBE);
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
    expect(css).toContain('color-mix(in oklab, var(--color-status-warning) 10%, transparent)');
    expect(css).toContain('color-mix(in oklab, var(--color-status-warning) 40%, transparent)');
  });

  /**
   * The shape half of the defect, kept executable: Tailwind 3 could not parse
   * a bare `var(--sf-*)` as a colour, emitted nothing for its modified
   * variants and no error either — the Forge SOQL callout rendered with
   * neither background nor border. Tailwind 4 mixes any colour with
   * transparent, so the tokens no longer carry an alpha channel of their own.
   */
  it('gives a bare var() token its opacity modifiers', async () => {
    const css = await buildUtilities({
      error: 'var(--sf-error)',
      warning: 'var(--sf-warning)',
      success: 'var(--sf-success)',
      info: 'var(--sf-info)',
    });
    for (const utility of MODIFIER_PROBE) {
      expect(css, `${utility} did not compile`).toContain(`.${utility.replace('/', '\\/')} `);
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

/* ===================== fixed colours ===================== */

/**
 * A fixed palette shade is picked for one background and fails on the other:
 * `text-amber-400` reads 1.57:1 on Light Modern's widget background, and a
 * `-700` fill under `-100` text painted the same dark pill on every theme
 * instead of following it. Every shade from `-50` to `-950` is refused, and no
 * file of the product is excepted: severity goes through `status`, a module's
 * or a syntax colour's identity through `hue`, neutral text through
 * `text-text-*`, surfaces and borders through `surface-*` and `subtle`.
 * eslint.config.mjs refuses the same classes where they are written.
 */
const PALETTE =
  /(?<![\w-])(?:text|bg|border(?:-[xytrblse])?|ring(?:-offset)?|fill|stroke|from|via|to|outline|divide|decoration|placeholder|caret|accent|shadow)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|100|200|300|400|500|600|700|800|900|950)(?![\w-])/g;

/**
 * A fixed palette class joined from its parts at runtime. The probes and the
 * model's fixtures in this file write such classes on purpose, and the lint
 * rule reads this file's strings too.
 */
const paletteClass = (prefix: string, hue: string, shade: number): string =>
  `${prefix}-${hue}-${shade}`;

/** A hex colour inside a string of the source: a class, an inline style, an SVG attribute. */
const HEX_COLOUR = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;

/**
 * What stands right before a hex written as the fallback of a `var()`: `var(--x, ` in CSS,
 * `bg-(--x,` in a Tailwind 4 class, `_` included for a class.
 */
const VAR_FALLBACK = /(?:var\(|-\()--[\w-]+\s*,[\s_]*$/;

/**
 * The files whose hex colours stay, each with the reason the colour is not the
 * theme's to choose. Anywhere else a hex cannot follow the theme either: it
 * goes through a token, or survives only as the fallback of a `var()`.
 */
const HEX_ALLOWLIST: Readonly<Record<string, string>> = {
  'pages/OrgManager/OrgEditDialog.tsx':
    'the colours a user picks for an org: data the org keeps, shown as it was chosen',
  'components/EasterEgg/MojitoOverlay.tsx':
    'a decorative illustration on its own dark backdrop, painted the same on every theme',
};

/** The product's own TypeScript: no tests, no test infrastructure under `testing/`. */
function productionSources(): string[] {
  return collectSourceFiles(SRC_ROOT).filter(
    (file) =>
      /\.tsx?$/.test(file) &&
      !/\.test\.tsx?$/.test(file) &&
      !file.split(path.sep).includes('testing'),
  );
}

/** Every hex colour the product writes outside a `var()` fallback, as `file:line #hex`. */
function rawHexColours(): string[] {
  const found: string[] = [];
  for (const file of productionSources()) {
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const relative = path.relative(SRC_ROOT, file).split(path.sep).join('/');
    eachNode(source, (node) => {
      if (!isClassChunk(node)) return;
      for (const match of node.text.matchAll(HEX_COLOUR)) {
        if (VAR_FALLBACK.test(node.text.slice(0, match.index ?? 0))) continue;
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        found.push(`${relative}:${line + 1} ${match[0]}`);
      }
    });
  }
  return found;
}

describe('fixed colour gate', () => {
  it('uses no fixed palette shade anywhere in the product', () => {
    const offenders: string[] = [];
    for (const file of productionSources()) {
      const content = fs.readFileSync(file, 'utf8');
      for (const match of content.matchAll(PALETTE)) {
        offenders.push(`${match[0]} (${path.relative(SRC_ROOT, file)})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('writes a hex colour only as a var() fallback, outside the allowlisted files', () => {
    const allowed = new Set(Object.keys(HEX_ALLOWLIST));
    const outside = rawHexColours().filter((hit) => !allowed.has(hit.slice(0, hit.indexOf(':'))));
    expect(outside).toEqual([]);
  });

  it('allowlists only files that still write a hex colour', () => {
    const writing = new Set(rawHexColours().map((hit) => hit.slice(0, hit.indexOf(':'))));
    expect(Object.keys(HEX_ALLOWLIST).filter((file) => !writing.has(file))).toEqual([]);
  });

  it('is rejected by the lint rule in pages and in design-system primitives alike, at every shade', async () => {
    const { ESLint } = await import('eslint');
    const repoRoot = path.resolve(SRC_ROOT, '..', '..', '..');
    const eslint = new ESLint({ cwd: repoRoot });
    const offending = [
      `export const accent = '${paletteClass('text', 'red', 400)}';`,
      `export const Tip = () => <span className="p-1 hover:${paletteClass('bg', 'amber', 500)}/20">x</span>;`,
      'export const Row = ({ on }: { on: boolean }) => <i className={`h-2 ${on ? "p-1" : ""} ' +
        paletteClass('ring', 'blue', 950) +
        '`} />;',
      `export const Edge = { stroke: '${paletteClass('stroke', 'violet', 50)}', rail: '${paletteClass('border-l', 'emerald', 700)}' };`,
      `export const Focus = 'focus:${paletteClass('ring-offset', 'sky', 300)}';`,
    ].join('\n');
    // Near misses: a width, a size, an offset, a module accent and the tokens themselves.
    const clean =
      "export const accent = 'text-status-error bg-hue-amber/20 border-2 text-2xl ring-offset-2 bg-forge/20';\n";

    const restricted = async (code: string, file: string): Promise<number> => {
      const [result] = await eslint.lintText(code, {
        filePath: path.join(repoRoot, 'packages', 'webview', 'src', file),
      });
      return result.messages.filter((m) => m.ruleId === 'no-restricted-syntax').length;
    };

    expect(await restricted(offending, 'pages/Probe/Probe.tsx')).toBe(6);
    expect(await restricted(offending, 'components/ui/Probe.tsx')).toBe(6);
    expect(await restricted(clean, 'pages/Probe/Probe.tsx')).toBe(0);
  }, 30_000);
});

/* ===================== identity hues: contrast ===================== */

/**
 * A module's accent, a syntax colour, a brand mark: colours that say which
 * thing this is, not how it went. Each is a literal hue pulled toward the
 * editor foreground, by the largest share of the hue that still clears AA.
 */
const HUE_DECLARATION = /^color-mix\(in srgb, (#[0-9a-f]{6}) (\d+)%, var\(--sf-text-primary\)\)$/;

describe('identity hue token contrast', () => {
  it('declares every hue as a literal pulled toward the editor foreground', () => {
    const block = tailwindBlock('hue');
    expect(Object.keys(block).length).toBeGreaterThan(0);
    for (const [name, value] of Object.entries(block)) {
      expect(value, `hue.${name} is not a hardened token: ${value}`).toMatch(HUE_DECLARATION);
    }
  });

  it('clears AA on every measured theme whose own editor text clears AA', () => {
    const failures: string[] = [];
    for (const [name, value] of Object.entries(tailwindBlock('hue'))) {
      const parsed = HUE_DECLARATION.exec(value);
      if (!parsed) continue;
      const [, hex, keep] = parsed;
      for (const theme of MEASURED_THEMES) {
        if (bodyTextContrast(theme) < AA) continue;
        const rendered = mixSrgb(parseHex(hex), parseHex(theme.editorForeground), Number(keep));
        const ratio = worstContrast(theme, rendered);
        if (ratio < AA) failures.push(`${theme.name}/${name} = ${round(ratio)}:1`);
      }
    }
    expect(failures).toEqual([]);
  });
});

/* ===================== what the panel paints: the model ===================== */

/**
 * The contrast tests below model, from the source, what the browser paints: a
 * static model, not a rendering. They guard against contrast regressions in the
 * class, style and theme shapes listed here, on every commit and without a
 * browser, and prove nothing about a shape they do not follow. Known ones: an
 * inline colour held in a variable set by a call or destructured from a map;
 * two colour classes on one element, which the model settles in the order they
 * are written and the stylesheet in the order it emits them; a condition that
 * pairs a state with `!disabled`, taken for the disabled state; a rule from
 * outside Tailwind's utilities and design-system.css (preflight's placeholder
 * colour, the layer VS Code prepends to every webview, a third-party
 * component's own stylesheet). What Chromium paints is measured by the scans in
 * e2e/axe-accessibility.spec.ts, the reference evidence for a contrast claim.
 *
 * - A colour is read from Tailwind's own output for the real config, and every
 *   `var()` in it is substituted the way the browser does it, through
 *   design-system.css down to the `--vscode-*` values VS Code sends under each
 *   measured theme (./testing/vscodeThemes.ts). A class that compiles to
 *   nothing, or to a declaration the browser drops, is a failure of its own
 *   instead of a colour nobody measured.
 * - A text is measured on everything painted under it: the background of every
 *   ancestor, composited in order over the panel surfaces, and any `opacity`
 *   group it sits in. Ancestors are followed through the JSX of a file, into
 *   the components it renders (with the props that usage passes), back out to
 *   the children those components render, into the functions it hands a
 *   component to render with (`renderItem={(row) => …}`), and through class
 *   strings and style objects kept in constants, maps and helpers, in the same
 *   file or an imported one.
 * - Every text colour counts: tokens, arbitrary values, palette shades, inline
 *   styles. The disabled foreground is refused for anything a user reads.
 * - A text in a theme's own foreground is held to AA, or to the theme's own
 *   contrast for that foreground on the surface it sits on where that is lower:
 *   nothing the panel lays between the two may make it worse than the theme.
 * - Every state a class is written for is measured (hover, focus, selected,
 *   placeholder…) except the disabled ones, which WCAG exempts.
 */

interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  /** 0 to 1. */
  readonly a: number;
}

const TRANSPARENT: Rgba = { r: 0, g: 0, b: 0, a: 0 };

function hexColour(text: string): Rgba | null {
  const h = text.trim().replace(/^#/, '');
  if (!/^(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(h)) return null;
  const full = h.length <= 4 ? [...h].map((c) => c + c).join('') : h;
  const byte = (at: number): number => parseInt(full.slice(at, at + 2), 16);
  return { r: byte(0), g: byte(2), b: byte(4), a: full.length === 8 ? byte(6) / 255 : 1 };
}

/** `top` painted over an opaque `under`. */
function over(top: Rgba, under: Rgba): Rgba {
  const keep = 1 - top.a;
  return {
    r: top.r * top.a + under.r * keep,
    g: top.g * top.a + under.g * keep,
    b: top.b * top.a + under.b * keep,
    a: 1,
  };
}

/** Two opaque colours, `weight` of the second. */
function lerp(from: Rgba, to: Rgba, weight: number): Rgba {
  return {
    r: from.r + (to.r - from.r) * weight,
    g: from.g + (to.g - from.g) * weight,
    b: from.b + (to.b - from.b) * weight,
    a: 1,
  };
}

function rgbaContrast(a: Rgba, b: Rgba): number {
  return contrastRatio([a.r, a.g, a.b], [b.r, b.g, b.b]);
}

function closingParenthesis(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split at a separator that is not inside parentheses or brackets. */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '(' || c === '[') depth += 1;
    else if (c === ')' || c === ']') depth -= 1;
    else if (c === separator && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

type Scope = (name: string) => string | undefined;

/**
 * `var()` substitution as the browser performs it at computed-value time. A
 * variable that resolves to nothing takes its fallback; with no fallback the
 * whole declaration is invalid, which is null here. `used` collects the
 * variables actually substituted, outermost first.
 */
function substitute(value: string, scope: Scope, used: string[], depth = 0): string | null {
  if (depth > 32) return null;
  let out = '';
  let from = 0;
  for (;;) {
    const at = value.indexOf('var(', from);
    if (at < 0) return out + value.slice(from);
    const close = closingParenthesis(value, at + 3);
    if (close < 0) return null;
    out += value.slice(from, at);
    const [rawName = '', ...fallback] = splitTopLevel(value.slice(at + 4, close), ',');
    const name = rawName.trim();
    const defined = scope(name);
    const inner: string[] = [];
    let replacement = defined === undefined ? null : substitute(defined, scope, inner, depth + 1);
    if (replacement !== null) {
      used.push(name, ...inner);
    } else if (fallback.length > 0) {
      replacement = substitute(fallback.join(','), scope, used, depth + 1);
    }
    if (replacement === null) return null;
    out += replacement;
    from = close + 1;
  }
}

/** A colour, `currentColor` (which inherits), or null for a value that is not a colour. */
type Parsed = Rgba | 'currentColor' | null;

function percentage(text: string): number | null {
  const t = text.trim();
  const plain = /^(-?\d*\.?\d+)%$/.exec(t);
  if (plain) return Number(plain[1]);
  const scaled = /^calc\(\s*(-?\d*\.?\d+)\s*\*\s*(-?\d*\.?\d+)%\s*\)$/.exec(t);
  return scaled ? Number(scaled[1]) * Number(scaled[2]) : null;
}

function mixOperand(text: string): { readonly colour: Parsed; readonly percent: number | null } {
  const parts = splitTopLevel(text.trim(), ' ').filter(Boolean);
  const last = parts.length > 1 ? percentage(parts[parts.length - 1]) : null;
  return last === null
    ? { colour: parseColour(text), percent: null }
    : { colour: parseColour(parts.slice(0, -1).join(' ')), percent: last };
}

function parseColour(text: string): Parsed {
  const value = text.trim();
  const keyword = value.toLowerCase();
  if (keyword === 'transparent') return TRANSPARENT;
  if (keyword === 'currentcolor' || keyword === 'inherit') return 'currentColor';
  if (keyword === 'white') return { r: 255, g: 255, b: 255, a: 1 };
  if (keyword === 'black') return { r: 0, g: 0, b: 0, a: 1 };
  if (value.startsWith('#')) return hexColour(value);
  const call = /^([a-z-]+)\((.*)\)$/is.exec(value);
  if (!call) return null;
  const [, fn, body] = call;
  if (fn === 'rgb' || fn === 'rgba') {
    const [channelText = '', slashAlpha] = splitTopLevel(body, '/');
    const channels = channelText.split(/[\s,]+/).filter(Boolean);
    const alphaText = (slashAlpha ?? channels[3] ?? '1').trim();
    const alpha = alphaText.endsWith('%')
      ? Number(alphaText.slice(0, -1)) / 100
      : Number(alphaText);
    const [r, g, b] = channels.slice(0, 3).map(Number);
    if ([r, g, b, alpha].some((n) => n === undefined || Number.isNaN(n))) return null;
    return { r, g, b, a: alpha };
  }
  if (fn === 'color-mix') {
    const [space = '', first = '', second = ''] = splitTopLevel(body, ',');
    const interpolation = space.trim();
    if (interpolation !== 'in srgb' && interpolation !== 'in oklab') return null;
    const left = mixOperand(first);
    const right = mixOperand(second);
    const x = left.colour;
    const y = right.colour;
    if (x === null || y === null || x === 'currentColor' || y === 'currentColor') return null;
    // Tailwind 4's opacity modifier mixes in oklab with transparent, where the
    // space makes no difference: the colour keeps its channels and takes the
    // share as its alpha. Two colours mixed in oklab are not modelled here.
    if (interpolation === 'in oklab' && x.a !== 0 && y.a !== 0) return null;
    const px = left.percent ?? (right.percent === null ? 50 : 100 - right.percent);
    const py = right.percent ?? 100 - px;
    const sum = px + py;
    if (sum <= 0) return null;
    const wx = px / sum;
    const wy = py / sum;
    const alpha = x.a * wx + y.a * wy;
    if (alpha === 0) return TRANSPARENT;
    const channel = (key: 'r' | 'g' | 'b'): number =>
      (x[key] * x.a * wx + y[key] * y.a * wy) / alpha;
    return {
      r: channel('r'),
      g: channel('g'),
      b: channel('b'),
      a: alpha * (Math.min(sum, 100) / 100),
    };
  }
  return null;
}

/** The custom properties design-system.css declares on `:root`. */
const ROOT_VARIABLES: ReadonlyMap<string, string> = (() => {
  const variables = new Map<string, string>();
  postcss.parse(fs.readFileSync(DESIGN_SYSTEM_PATH, 'utf8')).walkRules((rule) => {
    if (rule.selector.trim() !== ':root') return;
    rule.walkDecls((decl) => {
      if (decl.prop.startsWith('--')) variables.set(decl.prop, decl.value);
    });
  });
  return variables;
})();

/**
 * The theme variables Tailwind 4 writes in its `theme` layer for the utilities
 * it compiled (`--color-status-error`, `--spacing`…), which those utilities
 * read through `var()`. Filled by `compileUtilities`.
 */
const THEME_VARIABLES = new Map<string, string>();

const HOST_COLOURS: ReadonlyMap<string, Readonly<Record<string, string>>> = new Map(
  VSCODE_THEMES.map((theme) => [theme.name, hostColours(theme)]),
);

/** A CSS colour value and the custom properties its rule declares next to it. */
interface Paint {
  readonly css: string;
  readonly locals: Readonly<Record<string, string>>;
}

const paintKey = (paint: Paint): string => `${paint.css}${JSON.stringify(paint.locals)}`;

interface Resolved {
  readonly colour: Parsed;
  /** The value after substitution, null when the declaration is invalid. */
  readonly text: string | null;
  readonly variables: readonly string[];
}

const resolvedPaints = new Map<string, Resolved>();

function resolvePaint(theme: VsCodeTheme, paint: Paint): Resolved {
  const key = `${theme.name}|${paintKey(paint)}`;
  const cached = resolvedPaints.get(key);
  if (cached) return cached;
  const host = HOST_COLOURS.get(theme.name) ?? {};
  const scope: Scope = (name) =>
    paint.locals[name] ??
    THEME_VARIABLES.get(name) ??
    ROOT_VARIABLES.get(name) ??
    (name.startsWith('--vscode-') ? host[name.slice('--vscode-'.length)] : undefined);
  const variables: string[] = [];
  const text = substitute(paint.css, scope, variables);
  const resolved = { colour: text === null ? null : parseColour(text), text, variables };
  resolvedPaints.set(key, resolved);
  return resolved;
}

function opaqueColour(theme: VsCodeTheme, css: string): Rgba {
  const { colour } = resolvePaint(theme, { css, locals: {} });
  if (colour === null || colour === 'currentColor' || colour.a !== 1) {
    throw new Error(`${css} is not an opaque colour on ${theme.name}`);
  }
  return colour;
}

/** Where a panel is painted: the editor, the side bar, a widget. */
const PANEL_SURFACES = ['var(--sf-bg-primary)', 'var(--sf-bg-secondary)', 'var(--sf-bg-card)'];

function panelSurfaces(theme: VsCodeTheme): Rgba[] {
  return PANEL_SURFACES.map((css) => opaqueColour(theme, css));
}

/** The colour body text inherits, read from design-system.css. */
const BODY_TEXT: Paint = (() => {
  let colour = '';
  postcss.parse(fs.readFileSync(DESIGN_SYSTEM_PATH, 'utf8')).walkRules('body', (rule) => {
    rule.walkDecls('color', (decl) => {
      colour = decl.value;
    });
  });
  return { css: colour, locals: {} };
})();

/**
 * The foregrounds a theme designs to be read on a given background. Light+
 * writes description text under 4.5:1 on its own side bar and widgets, and
 * Quiet Light on all three of its surfaces: there, no class can do better with
 * that colour.
 */
const THEME_PAIRS: Readonly<Record<string, readonly string[]>> = {
  '--vscode-editor-foreground': PANEL_SURFACES,
  '--vscode-foreground': PANEL_SURFACES,
  '--vscode-descriptionForeground': PANEL_SURFACES,
  '--vscode-input-foreground': ['var(--vscode-input-background)'],
  '--vscode-input-placeholderForeground': ['var(--vscode-input-background)'],
  '--vscode-button-foreground': ['var(--vscode-button-background)'],
  '--vscode-button-secondaryForeground': ['var(--vscode-button-secondaryBackground)'],
  '--vscode-badge-foreground': ['var(--vscode-badge-background)'],
  '--vscode-list-activeSelectionForeground': ['var(--vscode-list-activeSelectionBackground)'],
  '--vscode-notifications-foreground': ['var(--vscode-notifications-background)'],
  '--vscode-editorHoverWidget-foreground': ['var(--vscode-editorHoverWidget-background)'],
};

/** The backgrounds a theme pairs `resolved` with, when it is exactly one of the theme's foregrounds. */
function themePairBackgrounds(theme: VsCodeTheme, resolved: Resolved): Rgba[] {
  const host = resolved.variables.find((name) => name.startsWith('--vscode-'));
  const backgrounds = host ? THEME_PAIRS[host] : undefined;
  if (!host || !backgrounds || resolved.text === null) return [];
  const own = resolvePaint(theme, { css: `var(${host})`, locals: {} });
  if (own.text !== resolved.text) return [];
  return backgrounds
    .map((css) => resolvePaint(theme, { css, locals: {} }).colour)
    .filter((colour): colour is Rgba => colour !== null && colour !== 'currentColor');
}

const sameColour = (a: Rgba, b: Rgba): boolean =>
  Math.abs(a.r - b.r) < 0.5 &&
  Math.abs(a.g - b.g) < 0.5 &&
  Math.abs(a.b - b.b) < 0.5 &&
  Math.abs(a.a - b.a) < 0.002;

/**
 * The theme's own contrast for a foreground on the surface under a stack: the
 * topmost layer that is one of the backgrounds the theme pairs it with, or the
 * panel surface when it is one. A tint or a hover above that surface is the
 * panel's doing, so it never lowers the figure. Text on an opaque layer the
 * theme does not pair it with has no figure to fall back on (Infinity): the
 * full bar applies.
 */
function themeOwnContrast(
  pairs: readonly Rgba[],
  surface: Rgba,
  layers: readonly (Rgba | { readonly group: number })[],
  foreground: Rgba,
): number {
  if (pairs.length === 0) return Infinity;
  const paints = layers.filter((layer): layer is Rgba => !('group' in layer));
  for (let top = paints.length - 1; top >= -1; top -= 1) {
    const colour = top < 0 ? surface : paints[top];
    if (pairs.some((pair) => sameColour(pair, colour))) {
      let under = surface;
      for (const paint of paints.slice(0, top + 1)) under = over(paint, under);
      return rgbaContrast(over(foreground, under), under);
    }
    if (colour.a >= 1) return Infinity;
  }
  return Infinity;
}

/* ---------- classes, as Tailwind compiles them ---------- */

interface Utility {
  /** Position in the stylesheet, which decides between rules of equal specificity. */
  readonly order: number;
  readonly declarations: readonly (readonly [string, string])[];
  /** Declarations Tailwind scopes to `::placeholder` (the `placeholder-*` colours). */
  readonly placeholder: readonly (readonly [string, string])[];
}

function cssUnescape(text: string): string {
  return text.replace(/\\([0-9a-fA-F]{1,6}\s?|[^0-9a-fA-F])/g, (_, escaped: string) =>
    /^[0-9a-fA-F]/.test(escaped) ? String.fromCodePoint(parseInt(escaped, 16)) : escaped,
  );
}

async function compileUtilities(names: Iterable<string>): Promise<Map<string, Utility>> {
  const root = postcss.parse(await buildWithTheme(`@import './styles/theme.css';`, names));
  // Each theme variable as Chromium reads it: a value inside `@supports
  // (color: color-mix(…))` replaces the fallback written before it.
  root.walkAtRules('layer', (layer) => {
    if (layer.params !== 'theme') return;
    layer.walkDecls((decl) => {
      if (decl.prop.startsWith('--')) THEME_VARIABLES.set(decl.prop, decl.value);
    });
  });
  const compiled = new Map<
    string,
    { order: number; declarations: [string, string][]; placeholder: [string, string][] }
  >();
  let order = 0;
  root.walkRules((rule) => {
    // A utility sits in the `utilities` layer; a variant's rule sits in an
    // at-rule of its own (`@media (hover: hover)`) and is none of the box.
    const parent = rule.parent;
    if (parent?.type !== 'atrule' || (parent as postcss.AtRule).params !== 'utilities') return;
    for (const selector of rule.selectors) {
      const trimmed = selector.trim();
      // `divide-*` and `space-*` style the children, as
      // `:where(.space-y-2 > :not(:last-child))`: compiled, but nothing of this box.
      const children = /^:where\(\.((?:\\[0-9a-fA-F]{1,6}\s?|\\.|[\w-])+) > /.exec(trimmed);
      const match = children
        ? null
        : /^\.((?:\\[0-9a-fA-F]{1,6}\s?|\\.|[\w-])+)(.*)$/.exec(trimmed);
      const own = match?.[2] === '';
      const placeholder = match?.[2] === '::placeholder';
      if (!children && !own && !placeholder) continue;
      const name = cssUnescape((children ?? match)?.[1] ?? '');
      const entry = compiled.get(name) ?? { order: order++, declarations: [], placeholder: [] };
      if (own || placeholder) {
        const into = own ? entry.declarations : entry.placeholder;
        // As Chromium reads it, the colour inside `@supports (color: color-mix(…))`
        // after the fallback before it: the last declaration of a property wins.
        rule.each((node) => {
          if (node.type === 'decl') into.push([node.prop, node.value]);
          else if (node.type === 'atrule' && node.name === 'supports') {
            node.each((inner) => {
              if (inner.type === 'decl') into.push([inner.prop, inner.value]);
            });
          }
        });
      }
      compiled.set(name, entry);
    }
  });
  return compiled;
}

interface ClassToken {
  readonly raw: string;
  readonly variants: readonly string[];
  readonly utility: string;
}

function parseToken(raw: string): ClassToken {
  const parts = splitTopLevel(raw, ':');
  return { raw, variants: parts.slice(0, -1), utility: (parts.at(-1) ?? '').replace(/^!/, '') };
}

/** Prefixes of the utilities that take a colour. */
const COLOUR_UTILITY =
  /^-?(?:bg|text|border(?:-[xytrblse])?|ring(?:-offset)?|outline|divide|decoration|fill|stroke|from|via|to|placeholder|caret|accent|shadow)-/;

/** A class written like a colour utility; `border-3` names a width. */
const isColourUtility = (utility: string): boolean =>
  COLOUR_UTILITY.test(utility) && !/^-\d+$/.test(utility.replace(COLOUR_UTILITY, '-'));

/** A string inside a JSX `style={{…}}`: a CSS value, never a class list. */
function inStyleAttribute(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isJsxAttribute(current)) return current.name.getText() === 'style';
    if (ts.isFunctionLike(current) || ts.isSourceFile(current)) return false;
  }
  return false;
}

/** A state WCAG does not hold to contrast, or one the panel never shows. */
const EXEMPT_VARIANT =
  /^(?:disabled|aria-disabled|group-disabled|peer-disabled|forced-colors|print|selection)$/;

/** A variant that styles a pseudo-element, not the element's own box or text. */
const PSEUDO_ELEMENT_VARIANT = /^(?:backdrop|before|after|file|marker|first-letter|first-line)$/;

/** Classes that do not paint the element in any state the contrast bar applies to. */
const notPainted = (token: ClassToken): boolean =>
  token.variants.some(
    (variant) => EXEMPT_VARIANT.test(variant) || PSEUDO_ELEMENT_VARIANT.test(variant),
  );

/** What an element paints in one state. */
interface Look {
  /** The variant chain, e.g. `hover`; empty at rest. */
  readonly state: string;
  readonly background: Paint | null;
  readonly backgroundLabel: string;
  /** A background image (a gradient): nothing a single colour can stand for. */
  readonly image: string | null;
  readonly colour: Paint | null;
  readonly colourLabel: string;
  readonly placeholder: Paint | null;
  readonly placeholderLabel: string;
  readonly opacity: number;
  readonly opacityLabel: string;
  /** Not painted in this state: `sr-only`, `hidden`, `invisible`, `opacity-0`. */
  readonly hidden: boolean;
}

/** An inline `style` object's colours. */
interface StyleColours {
  readonly color?: string;
  /** Where `color` came from when it is not the style object: an SVG `fill`, an axis `stroke`. */
  readonly colorSource?: string;
  readonly background?: string;
  readonly opacity?: string;
}

function looksOf(
  tokens: readonly ClassToken[],
  style: StyleColours,
  compiled: ReadonlyMap<string, Utility>,
  /** SVG `<text>`: its glyphs are painted with `fill`, not `color`. */
  svgText = false,
): Look[] {
  const chains = new Set<string>(['']);
  for (const token of tokens) {
    const variants = token.variants.filter((variant) => variant !== 'placeholder');
    if (notPainted(token)) continue;
    chains.add(variants.join(':'));
  }
  const looks: Look[] = [];
  for (const state of chains) {
    const applying = tokens.filter((token) => {
      if (notPainted(token)) return false;
      const chain = token.variants.filter((variant) => variant !== 'placeholder').join(':');
      return chain === '' || chain === state;
    });
    // Rest first, then the state's own classes: a state class wins over a resting one.
    const ordered = [
      ...applying.filter((token) => token.variants.every((v) => v === 'placeholder')),
      ...applying.filter((token) => token.variants.some((v) => v !== 'placeholder')),
    ];
    const locals: Record<string, string> = {};
    // Custom properties follow the stylesheet: `bg-opacity-20` lands after `bg-[#4ec9b0]`.
    for (const token of [...ordered].sort(
      (x, y) => (compiled.get(x.utility)?.order ?? 0) - (compiled.get(y.utility)?.order ?? 0),
    )) {
      for (const [prop, value] of compiled.get(token.utility)?.declarations ?? []) {
        if (prop.startsWith('--')) locals[prop] = value;
      }
    }
    let background: string | null = null;
    let backgroundLabel = '';
    let image: string | null = null;
    let colour: string | null = null;
    let colourLabel = '';
    let placeholder: string | null = null;
    let placeholderLabel = '';
    let opacity = 1;
    let opacityLabel = '';
    let hidden = false;
    for (const token of ordered) {
      const utility = compiled.get(token.utility);
      if (!utility) continue;
      const inPlaceholder = token.variants.includes('placeholder');
      for (const [prop, value] of utility.declarations) {
        if (prop === 'color' && inPlaceholder) {
          placeholder = value;
          placeholderLabel = token.raw;
        } else if (prop === 'color' || (svgText && prop === 'fill')) {
          colour = value;
          colourLabel = token.raw;
        } else if (prop === 'background-color') {
          background = value;
          backgroundLabel = token.raw;
        } else if (prop === 'background-image') {
          image = value === 'none' ? null : token.raw;
        } else if (prop === 'opacity') {
          // Tailwind 4 writes `opacity-50` as `opacity: 50%`.
          opacity = value.endsWith('%') ? Number(value.slice(0, -1)) / 100 : Number(value);
          opacityLabel = token.raw;
        } else if (
          (prop === 'display' && value === 'none') ||
          (prop === 'visibility' && value === 'hidden') ||
          (prop === 'clip' && /rect\(0/.test(value))
        ) {
          hidden = true;
        } else if (prop === 'display' || prop === 'visibility' || prop === 'clip') {
          hidden = false;
        }
      }
      for (const [prop, value] of utility.placeholder) {
        if (prop === 'color') {
          placeholder = value;
          placeholderLabel = token.raw;
        }
      }
    }
    // An inline style wins over every class, in every state.
    if (style.color !== undefined) {
      colour = style.color;
      colourLabel = `${style.colorSource ?? 'style color'}: ${style.color}`;
    }
    if (style.background !== undefined) {
      if (/gradient\(|url\(/.test(style.background)) {
        image = `style background: ${style.background}`;
      } else if (/^\s*(?:none|transparent|initial|unset|inherit)?\s*$/.test(style.background)) {
        background = null;
      } else {
        background = style.background;
        backgroundLabel = `style background: ${style.background}`;
      }
    }
    if (style.opacity !== undefined) {
      opacity = Number(style.opacity);
      opacityLabel = `style opacity: ${style.opacity}`;
    }
    if (opacity === 0) hidden = true;
    // A paint keeps only the custom properties its value reads, so a ring or a
    // shadow set next to it does not make two identical colours look different.
    const paintOf = (css: string | null): Paint | null => {
      if (css === null) return null;
      const read: Record<string, string> = {};
      for (const [name, value] of Object.entries(locals)) {
        if (css.includes(`var(${name}`)) read[name] = value;
      }
      return { css, locals: read };
    };
    looks.push({
      state,
      background: paintOf(background),
      backgroundLabel,
      image,
      colour: paintOf(colour),
      colourLabel,
      placeholder: paintOf(placeholder),
      placeholderLabel,
      opacity,
      opacityLabel,
      hidden,
    });
  }
  return looks;
}

/* ---------- class strings, followed through the source ---------- */

/** Stands for a value the source does not say. */
const UNKNOWN = '\u0000';

/** A value for a message, with what the source does not say shown as `…`. */
const printable = (text: string): string => text.split(UNKNOWN).join('…');

/** `undefined`, for a prop a usage leaves out. */
const UNDEFINED_VALUE = ts.factory.createIdentifier('undefined');

/**
 * Whether a condition holds exactly when the element is disabled (`true`), is
 * the negation of that (`false`), or says nothing about it (null). Classes
 * written for a disabled element are held to no contrast bar, as the
 * `disabled:` variant is not.
 */
function disabledWhen(condition: ts.Expression): boolean | null {
  const inner = skipOuter(condition);
  if (ts.isPrefixUnaryExpression(inner) && inner.operator === ts.SyntaxKind.ExclamationToken) {
    const negated = disabledWhen(inner.operand);
    return negated === null ? null : !negated;
  }
  let mentions = false;
  eachNode(inner, (node) => {
    if (ts.isIdentifier(node) && /disabled/i.test(node.text)) mentions = true;
  });
  return mentions ? true : null;
}

/** The same classes, applied only while the element is disabled. */
const asDisabled = (classes: string): string =>
  classes
    .split(/\s+/)
    .map((raw) => (raw === '' || raw === UNKNOWN ? raw : `disabled:${raw}`))
    .join(' ');
/** More alternatives than this for one expression is a failure: the model would be guessing. */
const MAX_ALTERNATIVES = 512;

/**
 * What a render assumes about the conditions its classes were written under:
 * condition source → `true`, `false`, `=value` or `!=value`.
 */
type Conditions = ReadonlyMap<string, string>;

/** A string an expression can produce, and the conditions it holds under. */
interface Alternative {
  readonly text: string;
  readonly when: Conditions;
}

const NO_CONDITIONS: Conditions = new Map();
const PLAIN: Alternative = { text: '', when: NO_CONDITIONS };
const unknownAlternative = (): Alternative => ({ text: UNKNOWN, when: NO_CONDITIONS });

interface Condition {
  readonly key: string;
  /** What the render assumes when the condition holds, and when it does not. */
  readonly holds: string;
  readonly fails: string;
}

/**
 * A condition as something two renders can agree or disagree on. `!x` is `x`
 * failing; `status === 'running'` and `status === 'done'` are one key with two
 * values, which cannot both hold.
 */
function conditionOf(expr: ts.Expression): Condition | null {
  let inner = skipOuter(expr);
  let negated = false;
  while (ts.isPrefixUnaryExpression(inner) && inner.operator === ts.SyntaxKind.ExclamationToken) {
    negated = !negated;
    inner = skipOuter(inner.operand);
  }
  if (inner.pos < 0 || !inner.getSourceFile()) return null;
  // The same words mean the same value only inside one function.
  let scope: ts.Node = inner.getSourceFile();
  for (let node: ts.Node | undefined = inner.parent; node; node = node.parent) {
    if (ts.isFunctionLike(node)) {
      scope = node;
      break;
    }
  }
  const where = `@${scope.pos}:${scope.getSourceFile().fileName}`;
  const text = (node: ts.Node): string => node.getText().replace(/\s+/g, '');
  let condition: Condition = { key: `${text(inner)}${where}`, holds: 'true', fails: 'false' };
  if (ts.isBinaryExpression(inner)) {
    const operator = inner.operatorToken.kind;
    const equal =
      operator === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      operator === ts.SyntaxKind.EqualsEqualsToken;
    const unequal =
      operator === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      operator === ts.SyntaxKind.ExclamationEqualsToken;
    const literal = (node: ts.Expression): boolean =>
      ts.isStringLiteralLike(node) || ts.isNumericLiteral(node);
    const [subject, value] = literal(inner.right)
      ? [inner.left, inner.right]
      : literal(inner.left)
        ? [inner.right, inner.left]
        : [null, null];
    if ((equal || unequal) && subject && value) {
      const is = `=${text(value)}`;
      const isNot = `!=${text(value)}`;
      condition = {
        key: `${text(subject)}${where}`,
        holds: equal ? is : isNot,
        fails: equal ? isNot : is,
      };
    }
  }
  return negated ? { ...condition, holds: condition.fails, fails: condition.holds } : condition;
}

/** Whether two assumptions about one condition can hold at once. */
function compatible(a: string, b: string): boolean {
  if (a === b) return true;
  if ((a === 'true' && b === 'false') || (a === 'false' && b === 'true')) return false;
  if (a.startsWith('=') && b.startsWith('=')) return false;
  if (a.startsWith('=') && b === `!${a}`) return false;
  if (b.startsWith('=') && a === `!${b}`) return false;
  return true;
}

function assume(
  alternatives: readonly Alternative[],
  condition: Condition | null,
  holds: boolean,
  disabled: boolean,
): Alternative[] {
  return alternatives
    .map(({ text, when }) => {
      const marked = disabled ? asDisabled(text) : text;
      if (!condition) return { text: marked, when };
      const merged = mergeConditions(
        when,
        new Map([[condition.key, holds ? condition.holds : condition.fails]]),
      );
      return merged ? { text: marked, when: merged } : null;
    })
    .filter((alternative): alternative is Alternative => alternative !== null);
}

function mergeConditions(a: Conditions, b: Conditions): Conditions | null {
  if (a.size === 0) return b;
  if (b.size === 0) return a;
  const merged = new Map(a);
  for (const [key, value] of b) {
    const known = merged.get(key);
    if (known === undefined) {
      merged.set(key, value);
      continue;
    }
    if (!compatible(known, value)) return null;
    // Keep the assumption that says more: a value over a value ruled out.
    if (value.startsWith('=') && !known.startsWith('=')) merged.set(key, value);
  }
  return merged;
}

function uniqueAlternatives(alternatives: readonly Alternative[]): Alternative[] {
  const unique = new Map<string, Alternative>();
  for (const alternative of alternatives) {
    const key = `${alternative.text}|${[...alternative.when].sort().join(',')}`;
    if (!unique.has(key)) unique.set(key, alternative);
  }
  return [...unique.values()];
}

/**
 * A function evaluated at one place: a component rendered by a JSX element
 * with the props it passes, or a helper called with its arguments.
 */
interface Binding {
  readonly id: number;
  readonly fn: ts.SignatureDeclaration;
  readonly usage: ts.JsxOpeningLikeElement | ts.CallExpression;
  readonly children: readonly ts.JsxChild[];
  readonly parent: Binding | null;
  readonly depth: number;
}

/** An expression and the render it is evaluated in. */
interface Value {
  readonly expr: ts.Expression;
  readonly binding: Binding | null;
  /** The arguments from this index on, when the expression is a call and they fill a rest parameter. */
  readonly restFrom?: number;
}

type FunctionLike = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

/** A binding and the ones it was evaluated in, innermost first. */
function bindingChain(binding: Binding | null): Binding[] {
  const chain: Binding[] = [];
  let current = binding;
  while (current) {
    chain.push(current);
    current = current.parent;
  }
  return chain;
}

function skipOuter(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))
    return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) {
    return name.expression.text;
  }
  return undefined;
}

function isJsx(node: ts.Node): boolean {
  const inner = ts.isExpression(node) ? skipOuter(node) : node;
  return ts.isJsxElement(inner) || ts.isJsxSelfClosingElement(inner) || ts.isJsxFragment(inner);
}

class SourceModel {
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  readonly files: readonly ts.SourceFile[];
  compiled: ReadonlyMap<string, Utility> = new Map();
  /** Every JSX element that renders a component of the product, by component function. */
  private readonly usages = new Map<ts.Node, ts.JsxOpeningLikeElement[]>();
  readonly bindings = new Map<string, Binding>();
  readonly alternativesCache = new Map<ts.Node, Map<number, Alternative[]>>();
  /** String literals some className reached. */
  readonly consumed = new Set<ts.Node>();
  /** String literals only an inline style reached: CSS values, not class lists. */
  readonly styleValues = new Set<ts.Node>();
  /** Set while an inline style is being read. */
  readingStyle = false;
  /** The colour, background and opacity properties of the style objects some render read. */
  readonly styleColoursRead = new Set<ts.Node>();
  readonly overflows = new Set<string>();

  private readonly fileSet: ReadonlySet<ts.SourceFile>;
  /** Colour classes the walk assembled that Tailwind has not compiled, with where. */
  readonly pending = new Map<string, string>();

  constructor(
    readonly root: string,
    fileNames: readonly string[],
  ) {
    const options: ts.CompilerOptions = {
      jsx: ts.JsxEmit.Preserve,
      noLib: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      types: [],
    };
    const host = ts.createCompilerHost(options, true);
    const inside = (file: string): boolean => path.resolve(file).startsWith(root + path.sep);
    const fileExists = host.fileExists.bind(host);
    host.fileExists = (file) => inside(file) && fileExists(file);
    this.program = ts.createProgram(fileNames, options, host);
    this.checker = this.program.getTypeChecker();
    const wanted = new Set(fileNames.map((file) => path.resolve(file)));
    this.files = this.program
      .getSourceFiles()
      .filter((source) => wanted.has(path.resolve(source.fileName)));
    this.fileSet = new Set(this.files);
    for (const source of this.files) this.indexUsages(source);
  }

  /** Every function the product renders as a component, or names like one. */
  componentDeclarations(): FunctionLike[] {
    const found = new Set<FunctionLike>();
    for (const fn of this.usages.keys()) found.add(fn as FunctionLike);
    for (const source of this.files) {
      eachNode(source, (node) => {
        if (ts.isFunctionDeclaration(node) && node.name && /^[A-Z]/.test(node.name.text)) {
          found.add(node);
        } else if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          /^[A-Z]/.test(node.name.text) &&
          node.initializer
        ) {
          const fn = this.functionIn(node.initializer);
          if (fn) found.add(fn);
        }
      });
    }
    this.componentSet = found;
    return [...found];
  }

  private componentSet = new Set<FunctionLike>();

  isComponentDeclaration(node: ts.Node): boolean {
    return this.componentSet.has(node as FunctionLike);
  }

  /** Rendered by some JSX outside its own body. */
  isRendered(fn: FunctionLike): boolean {
    return (this.usages.get(fn) ?? []).some((usage) => {
      for (let node: ts.Node | undefined = usage; node; node = node.parent) {
        if (node === fn) return false;
      }
      return true;
    });
  }

  private indexUsages(node: ts.Node): void {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      for (const fn of this.componentFunctions(node.tagName)) {
        const list = this.usages.get(fn) ?? [];
        list.push(node);
        this.usages.set(fn, list);
      }
    }
    ts.forEachChild(node, (child) => this.indexUsages(child));
  }

  private inProduct(node: ts.Node): boolean {
    const file = node.getSourceFile();
    return !file.isDeclarationFile && this.fileSet.has(file);
  }

  declarationsOf(node: ts.Node): ts.Declaration[] {
    let symbol = this.checker.getSymbolAtLocation(node);
    if (symbol && ts.isShorthandPropertyAssignment(node.parent)) {
      symbol = this.checker.getShorthandAssignmentValueSymbol(node.parent) ?? symbol;
    }
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
      symbol = this.checker.getAliasedSymbol(symbol);
    }
    return (symbol?.declarations ?? []).filter((declaration) => this.inProduct(declaration));
  }

  /** The function a JSX tag renders, when the product defines it. */
  componentFunctions(tag: ts.JsxTagNameExpression): FunctionLike[] {
    const text = tag.getText();
    if (!/^[A-Z]/.test(text.split('.').pop() ?? '') || /^(?:m|motion)\./.test(text)) return [];
    const target = ts.isPropertyAccessExpression(tag) ? tag.name : tag;
    return this.declarationsOf(target).flatMap((declaration) => {
      if (ts.isFunctionDeclaration(declaration)) return [declaration];
      if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
        const fn = this.functionIn(declaration.initializer);
        return fn ? [fn] : [];
      }
      return [];
    });
  }

  /** `(props) => …`, or the one inside `forwardRef(…)` / `memo(…)`. */
  private functionIn(expr: ts.Expression, depth = 0): FunctionLike | null {
    const inner = skipOuter(expr);
    if (ts.isArrowFunction(inner) || ts.isFunctionExpression(inner)) return inner;
    if (depth > 4) return null;
    if (ts.isCallExpression(inner)) {
      for (const argument of inner.arguments) {
        const fn = this.functionIn(argument, depth + 1);
        if (fn) return fn;
      }
    }
    // `forwardRef(WelcomePageView)`: the function is declared under its own name.
    if (ts.isIdentifier(inner) && ts.isCallExpression(inner.parent)) {
      for (const declaration of this.declarationsOf(inner)) {
        if (ts.isFunctionDeclaration(declaration)) return declaration;
        if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
          const fn = this.functionIn(declaration.initializer, depth + 1);
          if (fn) return fn;
        }
      }
    }
    return null;
  }

  bind(
    fn: FunctionLike,
    usage: ts.JsxOpeningLikeElement | ts.CallExpression,
    parent: Binding | null,
  ): Binding {
    const key = `${fn.pos}:${fn.getSourceFile().fileName}|${usage.pos}:${usage.getSourceFile().fileName}|${parent?.id ?? 0}`;
    const known = this.bindings.get(key);
    if (known) return known;
    const element = usage.parent;
    const binding: Binding = {
      id: this.bindings.size + 1,
      fn,
      usage,
      // Only an opening tag has children; a self-closing one's parent is the element around it.
      children:
        ts.isJsxOpeningElement(usage) && ts.isJsxElement(element) ? [...element.children] : [],
      parent,
      depth: (parent?.depth ?? 0) + 1,
    };
    this.bindings.set(key, binding);
    return binding;
  }

  /**
   * Whether rendering or calling `fn` at `site` would walk it inside itself:
   * the site is in its own body, or the render already holds it.
   *
   * Each function is walked once per render chain. A component handed its `t`
   * through spread props reads, to the model, a prop only the element's own
   * tag stands for, and so called itself: every `t('…', { count })` walked the
   * whole body again inside the call, and each of those did the same, down to
   * the depth limit, with the contexts nested at every level multiplying past
   * four million visits. A true recursion, such as a tree node rendering its
   * children, draws the same classes again one level deeper; what that deeper
   * level would stack on itself is left to the axe scans.
   */
  reenters(fn: ts.SignatureDeclaration, site: ts.Node, binding: Binding | null): boolean {
    for (let node = site.parent; node; node = node.parent) if (node === fn) return true;
    return bindingChain(binding).some((b) => b.fn === fn);
  }

  /** The values a component's prop takes: in this render if bound, else over every usage. */
  private propValues(
    fn: ts.SignatureDeclaration,
    name: string,
    binding: Binding | null,
    fallback?: ts.Expression,
  ): Value[] {
    for (const b of bindingChain(binding)) {
      if (b.fn !== fn || ts.isCallExpression(b.usage)) continue;
      return this.attributeValues(b.usage, name, b.parent, fallback);
    }
    const values: Value[] = [];
    for (const usage of this.usages.get(fn) ?? []) {
      values.push(...this.attributeValues(usage, name, null, fallback));
    }
    if (fallback && values.length === 0) values.push({ expr: fallback, binding: null });
    return values;
  }

  private attributeValues(
    usage: ts.JsxOpeningLikeElement,
    name: string,
    binding: Binding | null,
    fallback?: ts.Expression,
  ): Value[] {
    let spread = false;
    for (const property of usage.attributes.properties) {
      if (ts.isJsxSpreadAttribute(property)) spread = true;
      if (!ts.isJsxAttribute(property) || property.name.getText() !== name) continue;
      const init = property.initializer;
      if (!init) return [];
      if (ts.isStringLiteral(init)) return [{ expr: init, binding }];
      if (ts.isJsxExpression(init) && init.expression) return [{ expr: init.expression, binding }];
      return [];
    }
    if (spread) return [{ expr: usage.tagName as ts.Expression, binding: null }];
    // A prop the usage does not pass is undefined, or its default.
    return [{ expr: fallback ?? UNDEFINED_VALUE, binding: null }];
  }

  /** The prop a binding element or `props.x` reads, as [function, name, default]. */
  private propOf(
    node: ts.Node,
  ): { fn: ts.SignatureDeclaration; name: string; fallback?: ts.Expression } | null {
    // `({ tone = 'info' }) =>`
    if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const pattern = node.parent;
      const name = node.propertyName
        ? propertyNameText(node.propertyName)
        : ts.isIdentifier(node.name)
          ? node.name.text
          : undefined;
      if (!name) return null;
      const holder = pattern.parent;
      if (ts.isParameter(holder) && holder.parent.parameters[0] === holder) {
        return { fn: holder.parent, name, fallback: node.initializer };
      }
      // `const { tone } = props;`
      if (ts.isVariableDeclaration(holder) && holder.initializer) {
        const source = skipOuter(holder.initializer);
        if (ts.isIdentifier(source)) {
          for (const declaration of this.declarationsOf(source)) {
            if (ts.isParameter(declaration) && declaration.parent.parameters[0] === declaration) {
              return { fn: declaration.parent, name, fallback: node.initializer };
            }
          }
        }
      }
    }
    return null;
  }

  /** What an expression can evaluate to, through names, lookups, helpers and props. */
  valuesOf(value: Value, stack: readonly ts.Node[] = []): Value[] {
    const all = this.valuesOfInner(value, stack);
    const unique = new Map<string, Value>();
    for (const v of all) {
      unique.set(
        `${v.expr.pos}:${v.expr.end}:${v.expr.getSourceFile()?.fileName}|${v.binding?.id ?? 0}|${v.restFrom ?? ''}`,
        v,
      );
    }
    return [...unique.values()];
  }

  private valuesOfInner(value: Value, stack: readonly ts.Node[] = []): Value[] {
    const expr = skipOuter(value.expr);
    if (expr === UNDEFINED_VALUE) return [value];
    if (stack.includes(expr) || stack.length > 48) return [];
    const next = [...stack, expr];
    if (value.restFrom !== undefined) return [value];
    const leaf = [{ expr, binding: value.binding }];
    if (ts.isIdentifier(expr)) {
      const out: Value[] = [];
      for (const declaration of this.declarationsOf(expr)) {
        const prop = this.propOf(declaration);
        if (prop) {
          for (const v of this.propValues(prop.fn, prop.name, value.binding, prop.fallback)) {
            out.push(...this.valuesOf(v, next));
          }
        } else if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
          out.push(
            ...this.valuesOf({ expr: declaration.initializer, binding: value.binding }, next),
          );
        } else if (ts.isBindingElement(declaration)) {
          out.push(...this.bindingElementValues(declaration, value.binding, next));
        } else if (ts.isParameter(declaration)) {
          const argument = this.argumentValues(declaration, value.binding);
          out.push(
            ...(argument
              ? argument.flatMap((v) => (v.restFrom === undefined ? this.valuesOf(v, next) : [v]))
              : this.callbackParameterValues(declaration, value.binding, next)),
          );
        }
      }
      return out.length > 0 ? out : leaf;
    }
    if (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) {
      const key = ts.isPropertyAccessExpression(expr)
        ? expr.name.text
        : ts.isStringLiteralLike(expr.argumentExpression) ||
            ts.isNumericLiteral(expr.argumentExpression)
          ? expr.argumentExpression.text
          : undefined;
      // `props.tone`
      if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
        for (const declaration of this.declarationsOf(expr.expression)) {
          if (
            ts.isParameter(declaration) &&
            ts.isIdentifier(declaration.name) &&
            declaration.parent.parameters[0] === declaration &&
            key
          ) {
            const out = this.propValues(declaration.parent, key, value.binding).flatMap((v) =>
              this.valuesOf(v, next),
            );
            return out.length > 0 ? out : leaf;
          }
        }
      }
      const out: Value[] = [];
      for (const receiver of this.valuesOf(
        { expr: expr.expression, binding: value.binding },
        next,
      )) {
        const target = skipOuter(receiver.expr);
        if (ts.isObjectLiteralExpression(target)) {
          for (const property of target.properties) {
            if (
              ts.isPropertyAssignment(property) &&
              (key === undefined || propertyNameText(property.name) === key)
            ) {
              out.push(
                ...this.valuesOf({ expr: property.initializer, binding: receiver.binding }, next),
              );
            } else if (
              ts.isShorthandPropertyAssignment(property) &&
              (key === undefined || property.name.text === key)
            ) {
              out.push(...this.valuesOf({ expr: property.name, binding: receiver.binding }, next));
            }
          }
        } else if (ts.isArrayLiteralExpression(target) && ts.isElementAccessExpression(expr)) {
          for (const element of target.elements) {
            out.push(...this.valuesOf({ expr: element, binding: receiver.binding }, next));
          }
        }
      }
      return out.length > 0 ? out : leaf;
    }
    if (ts.isCallExpression(expr) && (value.binding?.depth ?? 0) < 24) {
      const fns = this.functionsCalled(expr.expression, value.binding).filter(
        (fn) => !this.reenters(fn, expr, value.binding),
      );
      if (fns.length > 0) {
        return fns.flatMap((fn) => {
          const call = this.bind(fn, expr, value.binding);
          return this.returned(fn).flatMap((returned) =>
            this.valuesOf({ expr: returned, binding: call }, next),
          );
        });
      }
      return leaf;
    }
    if (ts.isConditionalExpression(expr)) {
      return [
        ...this.valuesOf({ expr: expr.whenTrue, binding: value.binding }, next),
        ...this.valuesOf({ expr: expr.whenFalse, binding: value.binding }, next),
      ];
    }
    if (
      ts.isBinaryExpression(expr) &&
      (expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        expr.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      return [
        ...this.valuesOf({ expr: expr.left, binding: value.binding }, next),
        ...this.valuesOf({ expr: expr.right, binding: value.binding }, next),
      ];
    }
    return leaf;
  }

  /** A helper's parameter, in a call the binding chain records. */
  private argumentValues(
    parameter: ts.ParameterDeclaration,
    binding: Binding | null,
  ): Value[] | null {
    const fn = parameter.parent;
    const index = fn.parameters.indexOf(parameter);
    for (const b of bindingChain(binding)) {
      if (b.fn !== fn || !ts.isCallExpression(b.usage)) continue;
      if (parameter.dotDotDotToken) return [{ expr: b.usage, binding: b.parent, restFrom: index }];
      const argument = b.usage.arguments[index] ?? parameter.initializer;
      return argument ? [{ expr: argument, binding: b.parent }] : [];
    }
    return null;
  }

  private bindingElementValues(
    element: ts.BindingElement,
    binding: Binding | null,
    stack: readonly ts.Node[],
  ): Value[] {
    const pattern = element.parent;
    const holder = pattern.parent;
    const name = element.propertyName
      ? propertyNameText(element.propertyName)
      : ts.isIdentifier(element.name)
        ? element.name.text
        : undefined;
    if (!name) return [];
    let sources: Value[] = [];
    if (ts.isVariableDeclaration(holder) && holder.initializer) {
      sources = this.valuesOf({ expr: holder.initializer, binding }, stack);
    } else if (ts.isParameter(holder)) {
      sources = this.callbackParameterValues(holder, binding, stack);
    }
    const out: Value[] = [];
    for (const source of sources) {
      const target = skipOuter(source.expr);
      if (ts.isObjectLiteralExpression(target)) {
        for (const property of target.properties) {
          if (ts.isPropertyAssignment(property) && propertyNameText(property.name) === name) {
            out.push(
              ...this.valuesOf({ expr: property.initializer, binding: source.binding }, stack),
            );
          }
        }
      } else if (ts.isArrayLiteralExpression(target) && ts.isArrayBindingPattern(pattern)) {
        const index = pattern.elements.indexOf(element);
        const item = target.elements[index];
        if (item) out.push(...this.valuesOf({ expr: item, binding: source.binding }, stack));
      }
    }
    if (element.initializer) out.push({ expr: element.initializer, binding });
    return out;
  }

  /** The item parameter of `list.map((item) => …)` over a list the source spells out. */
  private callbackParameterValues(
    parameter: ts.ParameterDeclaration,
    binding: Binding | null,
    stack: readonly ts.Node[],
  ): Value[] {
    const fn = parameter.parent;
    const call = fn.parent;
    if (
      fn.parameters[0] !== parameter ||
      !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) ||
      !ts.isCallExpression(call) ||
      !ts.isPropertyAccessExpression(call.expression) ||
      !['map', 'flatMap', 'forEach', 'filter', 'find', 'some', 'every'].includes(
        call.expression.name.text,
      )
    ) {
      return [];
    }
    const out: Value[] = [];
    for (const list of this.valuesOf({ expr: call.expression.expression, binding }, stack)) {
      const target = skipOuter(list.expr);
      if (ts.isArrayLiteralExpression(target)) {
        for (const element of target.elements) out.push({ expr: element, binding: list.binding });
      } else if (ts.isCallExpression(target) && ts.isPropertyAccessExpression(target.expression)) {
        // `Object.entries(MAP)`, `Object.values(MAP)`
        const receiver = target.arguments[0];
        if (receiver && /^(?:entries|values)$/.test(target.expression.name.text)) {
          for (const object of this.valuesOf({ expr: receiver, binding: list.binding }, stack)) {
            const literal = skipOuter(object.expr);
            if (!ts.isObjectLiteralExpression(literal)) continue;
            for (const property of literal.properties) {
              if (ts.isPropertyAssignment(property)) {
                out.push({ expr: property.initializer, binding: object.binding });
              }
            }
          }
        }
      }
    }
    return out;
  }

  /**
   * The functions a call runs: one declared under the callee's name, or one
   * handed over as a value — a render prop (`renderItem(item, index)` inside
   * the component that was given it), a callback kept in a prop or a map.
   */
  private functionsCalled(callee: ts.Expression, binding: Binding | null): FunctionLike[] {
    const inner = skipOuter(callee);
    if (ts.isIdentifier(inner)) {
      const declared = this.declarationsOf(inner).flatMap((declaration): FunctionLike[] => {
        if (ts.isFunctionDeclaration(declaration)) return [declaration];
        if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
          const init = skipOuter(declaration.initializer);
          if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return [init];
        }
        return [];
      });
      if (declared.length > 0) return declared;
    } else if (!ts.isPropertyAccessExpression(inner) || !ts.isIdentifier(inner.expression)) {
      return [];
    }
    const handed = new Set<FunctionLike>();
    for (const value of this.valuesOf({ expr: inner, binding })) {
      const fn = skipOuter(value.expr);
      if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) handed.add(fn);
    }
    return [...handed];
  }

  returned(fn: FunctionLike): ts.Expression[] {
    if (!fn.body) return [];
    if (!ts.isBlock(fn.body)) return [fn.body];
    const out: ts.Expression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node) && node.expression) out.push(node.expression);
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(fn.body, visit);
    return out;
  }

  /** The class strings an expression can produce, as whole strings. */
  alternatives(value: Value, raw = false): string[] {
    return this.conditionalAlternatives(value, raw).map((alternative) => alternative.text);
  }

  /**
   * The strings an expression can produce, each with the conditions it assumes:
   * `open ? 'bg-x' : 'bg-y'` in one argument and `open && 'text-z'` in another
   * never meet as `bg-y text-z`.
   */
  conditionalAlternatives(
    value: Value,
    raw = false,
    stack: readonly ts.Node[] = [],
  ): Alternative[] {
    const expr = ts.isExpression(value.expr) ? skipOuter(value.expr) : value.expr;
    const bindingId = value.binding?.id ?? 0;
    if (value.restFrom !== undefined && ts.isCallExpression(expr)) {
      let joined: Alternative[] = [PLAIN];
      for (const argument of expr.arguments.slice(value.restFrom)) {
        joined = this.product(
          joined,
          this.conditionalAlternatives({ expr: argument, binding: value.binding }, raw, [
            ...stack,
            expr,
          ]),
          ' ',
          argument,
        );
      }
      return joined;
    }
    if (!raw) {
      const cached = this.alternativesCache.get(expr)?.get(bindingId);
      if (cached) return cached;
    }
    if (stack.includes(expr) || stack.length > 48) return [unknownAlternative()];
    const next = [...stack, expr];
    const sub = (e: ts.Expression, rawInner = raw): Alternative[] =>
      this.conditionalAlternatives({ expr: e, binding: value.binding }, rawInner, next);
    let out: Alternative[];
    if (
      ts.isStringLiteral(expr) ||
      ts.isNoSubstitutionTemplateLiteral(expr) ||
      ts.isNumericLiteral(expr)
    ) {
      (this.readingStyle ? this.styleValues : this.consumed).add(expr);
      out = [{ text: expr.text, when: NO_CONDITIONS }];
    } else if (ts.isTemplateExpression(expr)) {
      (this.readingStyle ? this.styleValues : this.consumed).add(expr);
      out = [{ text: expr.head.text, when: NO_CONDITIONS }];
      for (const span of expr.templateSpans) {
        out = this.product(out, sub(span.expression, true), '', expr);
        out = this.product(out, [{ text: span.literal.text, when: NO_CONDITIONS }], '', expr);
      }
    } else if (ts.isConditionalExpression(expr)) {
      const condition = conditionOf(expr.condition);
      const disabled = disabledWhen(expr.condition);
      out = [
        ...assume(sub(expr.whenTrue), condition, true, disabled === true),
        ...assume(sub(expr.whenFalse), condition, false, disabled === false),
      ];
    } else if (ts.isBinaryExpression(expr)) {
      const operator = expr.operatorToken.kind;
      if (operator === ts.SyntaxKind.AmpersandAmpersandToken) {
        const condition = conditionOf(expr.left);
        out = [
          ...assume([PLAIN], condition, false, false),
          ...assume(sub(expr.right), condition, true, disabledWhen(expr.left) === true),
        ];
      } else if (
        operator === ts.SyntaxKind.BarBarToken ||
        operator === ts.SyntaxKind.QuestionQuestionToken
      ) {
        out = [...sub(expr.left), ...sub(expr.right)];
      } else if (operator === ts.SyntaxKind.PlusToken) {
        out = this.product(sub(expr.left, true), sub(expr.right, true), '', expr);
      } else out = [unknownAlternative()];
    } else if (ts.isArrayLiteralExpression(expr)) {
      out = [PLAIN];
      for (const element of expr.elements) out = this.product(out, sub(element), ' ', expr);
    } else if (ts.isObjectLiteralExpression(expr)) {
      // clsx's `{ 'bg-x': active }`
      out = [PLAIN];
      for (const property of expr.properties) {
        const key = ts.isPropertyAssignment(property) ? propertyNameText(property.name) : undefined;
        if (key === undefined || !ts.isPropertyAssignment(property)) continue;
        const condition = conditionOf(property.initializer);
        const disabled = disabledWhen(property.initializer) === true;
        out = this.product(
          out,
          [
            ...assume([PLAIN], condition, false, false),
            ...assume([{ text: key, when: NO_CONDITIONS }], condition, true, disabled),
          ],
          ' ',
          expr,
        );
      }
    } else if (ts.isCallExpression(expr)) {
      const fns =
        (value.binding?.depth ?? 0) < 24
          ? this.functionsCalled(expr.expression, value.binding)
          : [];
      if (fns.length > 0) {
        out = fns.flatMap((fn) => {
          const call = this.bind(fn, expr, value.binding);
          return this.returned(fn).flatMap((returned) =>
            this.conditionalAlternatives({ expr: returned, binding: call }, raw, next),
          );
        });
      } else if (
        ts.isPropertyAccessExpression(expr.expression) &&
        ['join', 'filter', 'trim', 'concat'].includes(expr.expression.name.text)
      ) {
        out = sub(expr.expression.expression);
      } else {
        out = [PLAIN];
        for (const argument of expr.arguments) out = this.product(out, sub(argument), ' ', expr);
      }
    } else if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
      out = this.returned(expr).flatMap((returned) => sub(returned));
    } else if (
      expr.kind === ts.SyntaxKind.TrueKeyword ||
      expr.kind === ts.SyntaxKind.FalseKeyword ||
      expr.kind === ts.SyntaxKind.NullKeyword ||
      (ts.isIdentifier(expr) && expr.text === 'undefined')
    ) {
      out = [PLAIN];
    } else if (
      ts.isIdentifier(expr) ||
      ts.isPropertyAccessExpression(expr) ||
      ts.isElementAccessExpression(expr)
    ) {
      const values = this.valuesOf({ expr, binding: value.binding }, stack);
      out =
        values.length === 1 &&
        skipOuter(values[0].expr) === expr &&
        values[0].restFrom === undefined
          ? [unknownAlternative()]
          : values.flatMap((v) => this.conditionalAlternatives(v, raw, next));
    } else {
      out = [unknownAlternative()];
    }
    if (!raw) out = this.normalise(out, expr);
    out = uniqueAlternatives(out);
    if (out.length > MAX_ALTERNATIVES) {
      this.overflows.add(this.site(expr));
      out = out.slice(0, MAX_ALTERNATIVES);
    }
    if (out.length === 0) out = [PLAIN];
    if (!raw) {
      const byBinding = this.alternativesCache.get(expr) ?? new Map<number, Alternative[]>();
      byBinding.set(bindingId, out);
      this.alternativesCache.set(expr, byBinding);
    }
    return out;
  }

  private product(
    left: readonly Alternative[],
    right: readonly Alternative[],
    separator: string,
    site: ts.Node,
  ): Alternative[] {
    const out: Alternative[] = [];
    for (const a of left) {
      for (const b of right) {
        const when = mergeConditions(a.when, b.when);
        if (!when) continue;
        out.push({ text: `${a.text}${separator}${b.text}`, when });
      }
      if (out.length > MAX_ALTERNATIVES * 4) {
        this.overflows.add(this.site(site));
        break;
      }
    }
    return uniqueAlternatives(out);
  }

  /** Keep the classes that bear on colour, so equivalent strings collapse into one. */
  private normalise(alternatives: readonly Alternative[], site: ts.Node): Alternative[] {
    return alternatives.map(({ text, when }) => {
      const kept = text
        .split(/\s+/)
        .filter((raw) => raw !== '' && raw !== UNKNOWN && this.bearsOnColour(raw));
      for (const raw of kept) {
        const { utility } = parseToken(raw);
        if (!this.compiled.has(utility) && !this.pending.has(utility)) {
          this.pending.set(utility, this.site(site));
        }
      }
      return { text: kept.join(' '), when };
    });
  }

  bearsOnColour(raw: string): boolean {
    const { utility } = parseToken(raw);
    const compiled = this.compiled.get(utility);
    if (!compiled) return isColourUtility(utility);
    return [...compiled.declarations, ...compiled.placeholder].some(
      ([prop, value]) =>
        prop === 'color' ||
        prop === 'fill' ||
        prop === 'background-color' ||
        prop === 'background-image' ||
        prop === 'opacity' ||
        prop.startsWith('--tw-') ||
        (prop === 'display' && value === 'none') ||
        prop === 'visibility' ||
        prop === 'clip',
    );
  }

  site(node: ts.Node): string {
    const source = node.getSourceFile();
    if (!source) return '(generated)';
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    return `${path.relative(this.root, source.fileName)}:${line}`;
  }

  clearCaches(): void {
    this.alternativesCache.clear();
  }
}

/* ---------- walking what renders ---------- */

type Layer =
  | { readonly kind: 'paint'; readonly paint: Paint; readonly label: string; readonly site: string }
  | {
      readonly kind: 'group';
      readonly opacity: number;
      readonly label: string;
      readonly site: string;
    }
  | { readonly kind: 'image'; readonly label: string; readonly site: string };

interface Context {
  readonly layers: readonly Layer[];
  readonly text: Paint;
  readonly textLabel: string;
  /** The nearest element that set the colour already had it measured on these layers. */
  readonly measured: boolean;
  /** The conditions the ancestors' classes were written under, which descendants share. */
  readonly when: Conditions;
  readonly key: string;
}

function layerKey(layer: Layer): string {
  if (layer.kind === 'paint') return `p:${paintKey(layer.paint)}`;
  if (layer.kind === 'group') return `g:${layer.opacity}`;
  return `i:${layer.label}`;
}

function contextOf(
  layers: readonly Layer[],
  text: Paint,
  textLabel: string,
  measured: boolean,
  when: Conditions,
): Context {
  return {
    layers,
    text,
    textLabel,
    measured,
    when,
    key: `${layers.map(layerKey).join('>')}|${paintKey(text)}|${measured}|${[...when].sort().join(',')}`,
  };
}

const ROOT_CONTEXT = contextOf([], BODY_TEXT, 'body text', true, NO_CONDITIONS);

/** The context, assuming a condition holds or fails; null where it cannot. */
function assumeIn(context: Context, condition: Condition | null, holds: boolean): Context | null {
  if (!condition) return context;
  const when = mergeConditions(
    context.when,
    new Map([[condition.key, holds ? condition.holds : condition.fails]]),
  );
  if (!when) return null;
  return when === context.when
    ? context
    : contextOf(context.layers, context.text, context.textLabel, context.measured, when);
}

/** A colour painted somewhere, and what it is painted on. */
interface Measurement {
  readonly site: string;
  readonly state: string;
  readonly textLabel: string;
  readonly text: Paint;
  /** What `currentColor` or an invalid colour falls back to. */
  readonly inherited: Paint;
  readonly layers: readonly Layer[];
  readonly required: number;
}

const TEXT_CONTROLS = new Set(['input', 'textarea', 'select', 'option']);
const SVG_TEXT_TAGS = new Set(['text', 'tspan']);
const CHART_AXIS_TAGS = new Set(['XAxis', 'YAxis', 'ZAxis', 'PolarAngleAxis', 'PolarRadiusAxis']);
const NON_TEXT_INPUTS = /^(?:checkbox|radio|range|color|file|hidden|image)$/;

/** Past this many element visits the walk has run away, and says so rather than exhaust memory. */
const MAX_VISITS = 4_000_000;

function samePaint(a: Look, b: Look): boolean {
  const key = (paint: Paint | null): string => (paint ? paintKey(paint) : '');
  return (
    key(a.colour) === key(b.colour) &&
    key(a.background) === key(b.background) &&
    key(a.placeholder) === key(b.placeholder) &&
    a.image === b.image &&
    a.opacity === b.opacity &&
    a.hidden === b.hidden
  );
}

/** A composited pixel of the text and of the background right beside it. */
function renderPixel(
  base: Rgba,
  layers: readonly (Rgba | { readonly group: number })[],
  text: Rgba,
): { background: Rgba; foreground: Rgba } {
  let background = base;
  for (let i = 0; i < layers.length; i += 1) {
    const layer = layers[i];
    if ('group' in layer) {
      const inner = renderPixel(background, layers.slice(i + 1), text);
      return {
        background: lerp(background, inner.background, layer.group),
        foreground: lerp(background, inner.foreground, layer.group),
      };
    }
    background = over(layer, background);
  }
  return { background, foreground: over(text, background) };
}

/**
 * What stands between a measurement and the bar on each theme: the failures,
 * as `Theme = ratio:1`, or the reason the colour cannot be measured at all.
 */
function measurementShortfalls(measurement: Measurement): string[] {
  const failures: string[] = [];
  for (const theme of VSCODE_THEMES) {
    const body = resolvePaint(theme, BODY_TEXT).colour as Rgba;
    const bodyCeiling = Math.min(
      ...panelSurfaces(theme).map((surface) => rgbaContrast(body, surface)),
    );
    // Solarized Light: its own body text is under AA, and no severity or identity
    // colour pulled toward it can climb past it. The theme is measured and held to
    // no bar; 'names the one measured theme that is already below AA for its own
    // text' pins it as the one theme left out.
    if (bodyCeiling < AA) continue;
    let resolved = resolvePaint(theme, measurement.text);
    if (resolved.colour === null && resolved.text !== null) {
      return [
        `${printable(measurement.text.css)} is not a colour: the browser drops the declaration`,
      ];
    }
    if (resolved.colour === 'currentColor') resolved = resolvePaint(theme, measurement.inherited);
    if (resolved.colour === null || resolved.colour === 'currentColor') {
      return [`${printable(measurement.text.css)} resolves to nothing`];
    }
    if (resolved.variables.includes('--vscode-disabledForeground')) {
      return ['the disabled foreground, on something a user reads'];
    }
    const image = measurement.layers.find((layer) => layer.kind === 'image');
    if (image) return [`painted on ${image.label}, which no single colour stands for`];
    const layers: (Rgba | { group: number })[] = [];
    for (const layer of measurement.layers) {
      if (layer.kind === 'group') layers.push({ group: layer.opacity });
      else if (layer.kind === 'paint') {
        const colour = resolvePaint(theme, layer.paint).colour;
        if (colour === null) return [`${layer.label} (${layer.site}) resolves to nothing`];
        if (colour !== 'currentColor') layers.push(colour);
      }
    }
    const foreground = resolved.colour;
    const pairs = themePairBackgrounds(theme, resolved);
    let worst: { ratio: number; bar: number } | null = null;
    for (const surface of panelSurfaces(theme)) {
      const pixel = renderPixel(surface, layers, foreground);
      const ratio = rgbaContrast(pixel.foreground, pixel.background);
      const bar = Math.min(
        measurement.required,
        themeOwnContrast(pairs, surface, layers, foreground),
      );
      if (ratio < bar && (!worst || ratio < worst.ratio)) worst = { ratio, bar };
    }
    if (worst) {
      const own =
        worst.bar < measurement.required ? ` (the theme's own: ${round(worst.bar)}:1)` : '';
      failures.push(`${theme.name} = ${round(worst.ratio)}:1${own}`);
    }
  }
  return failures;
}

function describeMeasurement(measurement: Measurement): string {
  const state = measurement.state ? ` [${measurement.state}]` : '';
  const under = [...measurement.layers]
    .reverse()
    .map((layer) => `${layer.label} (${layer.site})`)
    .join(' over ');
  return printable(
    `${measurement.site} ${measurement.textLabel}${state}${under ? ` on ${under}` : ''}`,
  );
}

class RenderWalker {
  /** `site text on layers` → what falls short, for every measurement that does. */
  readonly failures = new Map<string, string>();
  /** The class (or inline style) of every colour measured, and of every layer under one. */
  readonly painted = new Set<string>();
  visits = 0;
  private readonly measuredKeys = new Set<string>();
  private readonly visited = new Map<ts.Node, Set<string>>();
  private readonly contextIds = new Map<string, number>();
  /** Renders whose component put the children it was given somewhere. */
  private readonly childrenRendered = new Set<number>();
  /** Component bodies walked at least once, in some render. */
  private readonly walkedComponents = new Set<ts.Node>();
  /**
   * Work still to do, last in first out. The walk goes as deep as the app
   * renders — panel, page, card, badge — which the call stack does not hold.
   */
  private readonly work: (() => void)[] = [];

  constructor(
    private readonly model: SourceModel,
    private readonly maxVisits = MAX_VISITS,
  ) {}

  /**
   * A component is walked where it is rendered, with what that render passes
   * it. Walking starts from what nothing else renders — a panel, a lazily
   * loaded page, an unused component — and from the JSX outside components.
   */
  walk(): void {
    const components = this.model.componentDeclarations();
    for (const source of this.model.files) {
      this.schedule(source, ROOT_CONTEXT, null);
      this.drain();
    }
    const roots = components.filter((fn) => !this.model.isRendered(fn));
    for (let pending = roots; pending.length > 0; ) {
      for (const fn of pending) {
        this.walkedComponents.add(fn);
        if (fn.body) this.schedule(fn.body, ROOT_CONTEXT, null);
        this.drain();
      }
      // Rendered only from code nothing renders: walk it on its own.
      pending = components.filter((fn) => !this.walkedComponents.has(fn)).slice(0, 1);
    }
  }

  private drain(): void {
    for (let task = this.work.pop(); task; task = this.work.pop()) task();
  }

  private schedule(node: ts.Node, context: Context, binding: Binding | null): void {
    this.work.push(() => this.visit(node, context, binding));
  }

  private firstVisit(node: ts.Node, context: Context, binding: Binding | null): boolean {
    let id = this.contextIds.get(context.key);
    if (id === undefined) {
      id = this.contextIds.size;
      this.contextIds.set(context.key, id);
    }
    const key = `${id}|${binding?.id ?? 0}`;
    const seen = this.visited.get(node) ?? new Set<string>();
    if (seen.has(key)) return false;
    seen.add(key);
    this.visited.set(node, seen);
    this.visits += 1;
    if (this.visits > this.maxVisits) {
      throw new Error(
        `the render walk passed ${this.maxVisits} visits at ${this.model.site(node)}`,
      );
    }
    return true;
  }

  private visit(node: ts.Node, context: Context, binding: Binding | null): void {
    // A component's body is walked where it is rendered, not where it is declared.
    if (!binding && context === ROOT_CONTEXT && this.model.isComponentDeclaration(node)) return;
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      this.element(node, context, binding);
      return;
    }
    // What renders under a condition renders only where the condition can hold:
    // `{step.status === 'done' && <Check />}` never sits on a running step's row.
    if (ts.isConditionalExpression(node)) {
      const condition = conditionOf(node.condition);
      this.schedule(node.condition, context, binding);
      for (const [branch, holds] of [
        [node.whenTrue, true],
        [node.whenFalse, false],
      ] as const) {
        const assumed = assumeIn(context, condition, holds);
        if (assumed) this.schedule(branch, assumed, binding);
      }
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      this.schedule(node.left, context, binding);
      const assumed = assumeIn(context, conditionOf(node.left), true);
      if (assumed) this.schedule(node.right, assumed, binding);
      return;
    }
    if (ts.isJsxExpression(node) && node.expression) {
      if (this.childrenOf(node.expression, context, binding)) return;
      const expr = skipOuter(node.expression);
      if (
        ts.isIdentifier(expr) ||
        ts.isPropertyAccessExpression(expr) ||
        ts.isElementAccessExpression(expr) ||
        ts.isCallExpression(expr)
      ) {
        for (const value of this.model.valuesOf({ expr, binding })) {
          if (skipOuter(value.expr) !== expr && isJsx(value.expr)) {
            this.schedule(value.expr, context, value.binding);
          }
        }
      }
    }
    ts.forEachChild(node, (child) => this.schedule(child, context, binding));
  }

  /** `{children}` inside a component rendered with children: render those here. */
  private childrenOf(expr: ts.Expression, context: Context, binding: Binding | null): boolean {
    if (!binding) return false;
    const inner = skipOuter(expr);
    const named =
      (ts.isIdentifier(inner) && inner.text === 'children') ||
      (ts.isPropertyAccessExpression(inner) && inner.name.text === 'children');
    if (!named) return false;
    const target = ts.isPropertyAccessExpression(inner) ? inner.expression : inner;
    for (const b of bindingChain(binding)) {
      if (ts.isCallExpression(b.usage)) continue;
      const own = this.model.declarationsOf(target).some((declaration) => {
        let node: ts.Node | undefined = declaration;
        while (node && !ts.isFunctionLike(node)) node = node.parent;
        return node === b.fn;
      });
      if (!own) continue;
      this.childrenRendered.add(b.id);
      this.renderChildren(b.children, context, b.parent);
      return true;
    }
    return false;
  }

  private renderChildren(
    children: readonly ts.JsxChild[],
    context: Context,
    binding: Binding | null,
  ): void {
    for (const child of children) {
      if (!context.measured && this.rendersText(child, binding)) {
        this.measure({
          site: this.model.site(child),
          state: '',
          textLabel: context.textLabel,
          text: context.text,
          inherited: context.text,
          layers: context.layers,
          required: AA,
        });
      }
      this.schedule(child, context, binding);
    }
  }

  private rendersText(child: ts.JsxChild, binding: Binding | null): boolean {
    if (ts.isJsxText(child)) return child.text.trim() !== '';
    if (ts.isJsxExpression(child) && child.expression) {
      return this.expressionRendersText(child.expression, binding, 0);
    }
    return false;
  }

  private expressionRendersText(
    expr: ts.Expression,
    binding: Binding | null,
    depth: number,
  ): boolean {
    const inner = skipOuter(expr);
    if (depth > 8 || isJsx(inner)) return false;
    if (ts.isConditionalExpression(inner)) {
      return (
        this.expressionRendersText(inner.whenTrue, binding, depth + 1) ||
        this.expressionRendersText(inner.whenFalse, binding, depth + 1)
      );
    }
    if (ts.isBinaryExpression(inner)) {
      if (inner.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
        return this.expressionRendersText(inner.right, binding, depth + 1);
      }
      if (
        inner.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        inner.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      ) {
        return (
          this.expressionRendersText(inner.left, binding, depth + 1) ||
          this.expressionRendersText(inner.right, binding, depth + 1)
        );
      }
    }
    if (
      inner.kind === ts.SyntaxKind.NullKeyword ||
      inner.kind === ts.SyntaxKind.TrueKeyword ||
      inner.kind === ts.SyntaxKind.FalseKeyword ||
      (ts.isIdentifier(inner) && inner.text === 'undefined')
    ) {
      return false;
    }
    if (ts.isCallExpression(inner) && ts.isPropertyAccessExpression(inner.expression)) {
      if (['map', 'flatMap'].includes(inner.expression.name.text)) {
        const callback = inner.arguments[0];
        return callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
          ? this.model
              .returned(callback)
              .some((r) => this.expressionRendersText(r, binding, depth + 1))
          : false;
      }
    }
    if (ts.isIdentifier(inner) && inner.text === 'children') return false;
    if (ts.isIdentifier(inner) || ts.isPropertyAccessExpression(inner)) {
      const values = this.model.valuesOf({ expr: inner, binding });
      if (values.length > 0 && values.every((v) => isJsx(v.expr))) return false;
    }
    return true;
  }

  private element(
    element: ts.JsxElement | ts.JsxSelfClosingElement,
    context: Context,
    binding: Binding | null,
  ): void {
    if (!this.firstVisit(element, context, binding)) return;
    const opening = ts.isJsxElement(element) ? element.openingElement : element;
    const site = this.model.site(opening);

    const components =
      (binding?.depth ?? 0) < 16 ? this.model.componentFunctions(opening.tagName) : [];
    if (components.length > 0) {
      for (const fn of components) {
        // A component rendered inside itself is not walked again; what it was
        // handed to render still is, where it stands.
        if (this.model.reenters(fn, opening, binding)) {
          if (ts.isJsxElement(element)) this.renderChildren(element.children, context, binding);
          continue;
        }
        const inner = this.model.bind(fn, opening, binding);
        this.walkedComponents.add(fn);
        // Children the component hands on some other way are still rendered inside
        // it. Queued first, so it runs once the whole body has been walked.
        this.work.push(() => {
          if (ts.isJsxElement(element) && !this.childrenRendered.has(inner.id)) {
            this.renderChildren(element.children, context, binding);
          }
        });
        if (fn.body) this.schedule(fn.body, context, inner);
      }
      return;
    }

    const attribute = (name: string): ts.JsxAttribute | undefined =>
      opening.attributes.properties.find(
        (property): property is ts.JsxAttribute =>
          ts.isJsxAttribute(property) && property.name.getText() === name,
      );
    const initializerOf = (attr: ts.JsxAttribute | undefined): ts.Expression | undefined => {
      const init = attr?.initializer;
      if (!init) return undefined;
      if (ts.isStringLiteral(init)) return init;
      return ts.isJsxExpression(init) ? init.expression : undefined;
    };
    const classExpr = initializerOf(attribute('className'));
    const classAlternatives = classExpr
      ? this.model.conditionalAlternatives({ expr: classExpr, binding })
      : [PLAIN];
    const tag = opening.tagName.getText().replace(/^(?:m|motion)\./, '');
    // SVG text is painted with `fill`; a Recharts axis paints its tick labels with `stroke`.
    const paintAttribute = SVG_TEXT_TAGS.has(tag)
      ? 'fill'
      : CHART_AXIS_TAGS.has(tag)
        ? 'stroke'
        : null;
    const styleAlternatives = this.styles(
      initializerOf(attribute('style')),
      binding,
      paintAttribute ? initializerOf(attribute(paintAttribute)) : undefined,
    );
    const typeAttr = initializerOf(attribute('type'));
    const textControl =
      TEXT_CONTROLS.has(tag) &&
      !(typeAttr && ts.isStringLiteral(typeAttr) && NON_TEXT_INPUTS.test(typeAttr.text));
    // An icon: a component written without children, an `<svg>`, or a codicon
    // glyph (`<span className="codicon codicon-check" />`).
    const iconGlyph =
      ts.isJsxSelfClosingElement(element) &&
      classExpr !== undefined &&
      /(?:^|[\s'"`])codicon(?=[\s'"`]|$)/.test(classExpr.getText());
    const graphic =
      (ts.isJsxSelfClosingElement(element) &&
        (/^[A-Z]/.test(tag) || tag === 'svg') &&
        !CHART_AXIS_TAGS.has(tag)) ||
      iconGlyph;
    // A wrapper that colours nothing but icons (`<span className=…><Icon /></span>`)
    // is held to the bar of what it paints: 3:1 for a graphic.
    const wrapsOnlyGraphics =
      ts.isJsxElement(element) &&
      element.children.some((child) => !ts.isJsxText(child)) &&
      element.children.every((child) => {
        if (ts.isJsxText(child)) return child.text.trim() === '';
        if (ts.isJsxSelfClosingElement(child)) return /^[A-Z]/.test(child.tagName.getText());
        if (ts.isJsxExpression(child)) {
          let onlyIcons = !this.rendersText(child, binding);
          eachNode(child, (node) => {
            if (ts.isJsxElement(node) || ts.isJsxFragment(node)) onlyIcons = false;
            if (ts.isJsxSelfClosingElement(node) && !/^[A-Z]/.test(node.tagName.getText())) {
              onlyIcons = false;
            }
          });
          return onlyIcons;
        }
        return false;
      });

    const childContexts = new Map<string, Context>();
    const combinations = new Set<string>();
    for (const classes of classAlternatives) {
      const tokens = classes.text.split(/\s+/).filter(Boolean).map(parseToken);
      for (const { style, when } of styleAlternatives) {
        // Classes, style and the ancestors' classes written under the same
        // condition hold together.
        const classWhen = mergeConditions(classes.when, when);
        const assumed = classWhen && mergeConditions(context.when, classWhen);
        if (!assumed) continue;
        const combination = `${classes.text}|${JSON.stringify(style)}`;
        if (combinations.has(combination)) continue;
        combinations.add(combination);
        // A class written for a disabled state is accounted for: the bar exempts it.
        for (const token of tokens) {
          if (token.variants.some((variant) => EXEMPT_VARIANT.test(variant))) {
            this.painted.add(token.raw.replace(/^disabled:/, ''));
          }
        }
        const looks = looksOf(tokens, style, this.model.compiled, SVG_TEXT_TAGS.has(tag));
        const rest = looks.find((look) => look.state === '');
        for (const look of looks) {
          if (look.hidden) continue;
          // A state that paints nothing differently was measured at rest.
          if (look !== rest && rest && !rest.hidden && samePaint(look, rest)) continue;
          const layers: Layer[] = [...context.layers];
          if (look.opacity < 1) {
            layers.push({ kind: 'group', opacity: look.opacity, label: look.opacityLabel, site });
          }
          if (look.image) layers.push({ kind: 'image', label: look.image, site });
          else if (look.background) {
            layers.push({
              kind: 'paint',
              paint: look.background,
              label: look.backgroundLabel,
              site,
            });
          }
          const text = look.colour ?? context.text;
          const textLabel = look.colour ? look.colourLabel : context.textLabel;
          const addedLayer = layers.length !== context.layers.length;
          // A graphic draws in currentColor; one that paints its own background is that background.
          const drawsInText = graphic && !look.background && (addedLayer || !context.measured);
          if (look.colour || textControl || drawsInText) {
            this.measure({
              site,
              state: look.state,
              textLabel,
              text,
              inherited: context.text,
              layers,
              required: (graphic || wrapsOnlyGraphics) && !textControl ? 3 : AA,
            });
          }
          if (look.placeholder) {
            this.measure({
              site,
              state: look.state ? `${look.state}:placeholder` : 'placeholder',
              textLabel: look.placeholderLabel,
              text: look.placeholder,
              inherited: text,
              layers,
              required: AA,
            });
          }
          const measured = look.colour ? true : context.measured && !addedLayer;
          const child = contextOf(layers, text, textLabel, measured, assumed);
          if (look.state === '' || addedLayer || look.colour) childContexts.set(child.key, child);
        }
      }
    }
    if (childContexts.size === 0) childContexts.set(context.key, context);
    // A stylesheet, a script or an SVG title is not painted as text.
    const paintsChildren = !/^(?:style|script|title|desc)$/.test(tag);
    for (const child of childContexts.values()) {
      if (ts.isJsxElement(element) && paintsChildren) {
        this.renderChildren(element.children, child, binding);
      }
      for (const property of opening.attributes.properties) {
        if (
          ts.isJsxAttribute(property) &&
          property.initializer &&
          ts.isJsxExpression(property.initializer)
        ) {
          const init = property.initializer.expression;
          const name = property.name.getText();
          if (init && name !== 'className' && name !== 'style') {
            this.schedule(init, child, binding);
          }
        }
      }
    }
  }

  private styles(
    expr: ts.Expression | undefined,
    binding: Binding | null,
    textPaint?: ts.Expression,
  ): { readonly style: StyleColours; readonly when: Conditions }[] {
    const none = [{ style: {}, when: NO_CONDITIONS }];
    if (textPaint) {
      this.model.readingStyle = true;
      const paints = this.model.conditionalAlternatives({ expr: textPaint, binding }, true);
      this.model.readingStyle = false;
      const source = ts.isJsxAttribute(textPaint.parent)
        ? textPaint.parent.name.getText()
        : ts.isJsxExpression(textPaint.parent) && ts.isJsxAttribute(textPaint.parent.parent)
          ? textPaint.parent.parent.name.getText()
          : 'fill';
      const withText = paints
        .filter((paint) => paint.text.trim() !== '')
        .map((paint) => ({ style: { color: paint.text, colorSource: source }, when: paint.when }));
      const styled = this.styles(expr, binding);
      const out = withText.flatMap((text) =>
        styled.flatMap((other) => {
          const when = mergeConditions(text.when, other.when);
          return when ? [{ style: { ...text.style, ...other.style }, when }] : [];
        }),
      );
      return out.length > 0 ? out : styled;
    }
    if (!expr) return none;
    const out: { style: StyleColours; when: Conditions }[] = [];
    for (const value of this.model.valuesOf({ expr, binding })) {
      const literal = skipOuter(value.expr);
      if (!ts.isObjectLiteralExpression(literal)) {
        out.push(...none);
        continue;
      }
      let combos: { style: StyleColours; when: Conditions }[] = none;
      for (const { property, binding: owner } of this.styleProperties(literal, value.binding)) {
        const name = propertyNameText(property.name);
        const key =
          name === 'color'
            ? 'color'
            : name === 'background' || name === 'backgroundColor'
              ? 'background'
              : name === 'opacity'
                ? 'opacity'
                : null;
        if (!key) continue;
        this.model.styleColoursRead.add(property);
        this.model.readingStyle = true;
        const options = this.model.conditionalAlternatives(
          { expr: property.initializer, binding: owner },
          true,
        );
        this.model.readingStyle = false;
        const nextCombos: { style: StyleColours; when: Conditions }[] = [];
        for (const combo of combos) {
          for (const option of options) {
            const when = mergeConditions(combo.when, option.when);
            if (!when) continue;
            // An empty value (a prop left out) sets nothing.
            const style =
              option.text.trim() === '' ? combo.style : { ...combo.style, [key]: option.text };
            nextCombos.push({ style, when });
          }
        }
        combos = nextCombos.slice(0, MAX_ALTERNATIVES);
      }
      out.push(...combos);
    }
    return out.length > 0 ? out : none;
  }

  /**
   * A style object's properties in the order they apply, with what a spread
   * (`{ ...ROW_STYLE, backgroundColor: tint }`) brings in expanded where it stands.
   */
  private styleProperties(
    literal: ts.ObjectLiteralExpression,
    binding: Binding | null,
    depth = 0,
  ): { readonly property: ts.PropertyAssignment; readonly binding: Binding | null }[] {
    const out: { property: ts.PropertyAssignment; binding: Binding | null }[] = [];
    for (const property of literal.properties) {
      if (ts.isPropertyAssignment(property)) {
        out.push({ property, binding });
      } else if (ts.isSpreadAssignment(property) && depth < 8) {
        const spread = this.model
          .valuesOf({ expr: property.expression, binding })
          .filter((value) => ts.isObjectLiteralExpression(skipOuter(value.expr)));
        // A spread that could be one of several objects is not expanded.
        if (spread.length !== 1) continue;
        const [only] = spread;
        out.push(
          ...this.styleProperties(
            skipOuter(only.expr) as ts.ObjectLiteralExpression,
            only.binding,
            depth + 1,
          ),
        );
      }
    }
    return out;
  }

  measure(measurement: Measurement): void {
    const label = describeMeasurement(measurement);
    const key = `${label}|${paintKey(measurement.text)}|${paintKey(measurement.inherited)}|${measurement.required}|${measurement.layers.map(layerKey).join('>')}`;
    if (this.measuredKeys.has(key)) return;
    this.measuredKeys.add(key);
    this.painted.add(measurement.textLabel);
    for (const layer of measurement.layers) this.painted.add(layer.label);
    if (this.failures.has(label)) return;
    const shortfalls = measurementShortfalls(measurement);
    if (shortfalls.length > 0) this.failures.set(label, shortfalls.join(', '));
  }
}

interface RenderReport {
  /** Every measurement under the bar, as `site text on layers: Theme = ratio:1`. */
  readonly failures: readonly string[];
  /** Colour classes that compile to nothing, as `site class`. */
  readonly uncompiled: readonly string[];
  /** Every text colour class written in the sources, with a site that writes it. */
  readonly colourClasses: ReadonlyMap<string, string>;
  /** The classes some measurement painted, or that only a disabled state writes. */
  readonly painted: ReadonlySet<string>;
  /** Inline style colours no render the walk follows reads, as `site style property`. */
  readonly unreadStyles: readonly string[];
  /** The elements the walk visited, each once per context and render it was reached in. */
  readonly visits: number;
}

const STYLE_COLOUR_PROPERTY = /^(?:color|background|backgroundColor)$/;

/** An object literal written as a style: a JSX `style={{…}}`, or a constant typed as CSS properties. */
function isStyleObject(literal: ts.ObjectLiteralExpression): boolean {
  if (inStyleAttribute(literal)) return true;
  const holder = literal.parent;
  return (
    ts.isVariableDeclaration(holder) &&
    holder.initializer === literal &&
    holder.type !== undefined &&
    /\bCSSProperties\b/.test(holder.type.getText())
  );
}

const isClassChunk = (node: ts.Node): node is ts.StringLiteralLike | ts.TemplateLiteralLikeNode =>
  ts.isStringLiteralLike(node) ||
  ts.isTemplateHead(node) ||
  ts.isTemplateMiddle(node) ||
  ts.isTemplateTail(node);

function eachNode(source: ts.Node, fn: (node: ts.Node) => void): void {
  const pending: ts.Node[] = [source];
  for (let node = pending.pop(); node; node = pending.pop()) {
    fn(node);
    ts.forEachChild(node, (child) => {
      pending.push(child);
    });
  }
}

async function buildRenderReport(
  root: string,
  fileNames: readonly string[],
  maxVisits = MAX_VISITS,
): Promise<RenderReport> {
  const model = new SourceModel(root, fileNames);
  const utilities = new Set<string>();
  for (const source of model.files) {
    eachNode(source, (node) => {
      if (!isClassChunk(node)) return;
      for (const raw of node.text.split(/\s+/)) if (raw) utilities.add(parseToken(raw).utility);
    });
  }
  model.compiled = await compileUtilities(utilities);

  let walker = new RenderWalker(model, maxVisits);
  walker.walk();
  // A class joined from pieces is only known once the walk has joined it.
  const assembled = [...model.pending.keys()].filter((utility) => !utilities.has(utility));
  if (assembled.length > 0) {
    const more = await compileUtilities([...utilities, ...assembled]);
    if (assembled.some((utility) => more.has(utility))) {
      model.compiled = more;
      model.clearCaches();
      walker = new RenderWalker(model, maxVisits);
      walker.walk();
    }
  }

  // A string no className or style reached (handed on under another prop name,
  // kept for later) is still painted somewhere: measure it on the panel as written.
  for (const source of model.files) {
    eachNode(source, (node) => {
      if (!(ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) return;
      if (model.consumed.has(node)) return;
      const tokens = node.text.split(/\s+/).filter(Boolean).map(parseToken);
      if (!tokens.some((token) => model.compiled.has(token.utility))) return;
      const site = model.site(node);
      for (const look of looksOf(tokens, {}, model.compiled)) {
        if (look.hidden) continue;
        const layers: Layer[] = [];
        if (look.opacity < 1) {
          layers.push({ kind: 'group', opacity: look.opacity, label: look.opacityLabel, site });
        }
        if (look.image) layers.push({ kind: 'image', label: look.image, site });
        else if (look.background) {
          layers.push({ kind: 'paint', paint: look.background, label: look.backgroundLabel, site });
        }
        if (look.colour) {
          walker.measure({
            site,
            state: look.state,
            textLabel: look.colourLabel,
            text: look.colour,
            inherited: BODY_TEXT,
            layers,
            required: AA,
          });
        }
        if (look.placeholder) {
          walker.measure({
            site,
            state: look.state ? `${look.state}:placeholder` : 'placeholder',
            textLabel: look.placeholderLabel,
            text: look.placeholder,
            inherited: BODY_TEXT,
            layers,
            required: AA,
          });
        }
      }
    });
  }

  const uncompiled = new Set<string>();
  const colourClasses = new Map<string, string>();
  for (const source of model.files) {
    eachNode(source, (node) => {
      if (!isClassChunk(node)) return;
      const cssValue =
        (model.styleValues.has(node) && !model.consumed.has(node)) || inStyleAttribute(node);
      if (cssValue || (ts.isTemplateLiteralToken(node) && model.styleValues.has(node.parent)))
        return;
      const raws = node.text.split(/\s+/).filter(Boolean);
      // Prose and identifiers are not class lists; a string with one compiled class is.
      if (!raws.some((raw) => model.compiled.has(parseToken(raw).utility))) return;
      raws.forEach((raw, index) => {
        const token = parseToken(raw);
        const compiled = model.compiled.get(token.utility);
        if (compiled) {
          const exempt = token.variants.some((variant) => EXEMPT_VARIANT.test(variant));
          if (
            !exempt &&
            [...compiled.declarations, ...compiled.placeholder].some(([prop]) => prop === 'color')
          ) {
            colourClasses.set(raw, model.site(node));
          }
          return;
        }
        if (!isColourUtility(token.utility)) return;
        // An interpolation can cut a class at either end of a template chunk.
        const template = !ts.isStringLiteralLike(node);
        if (template && index === raws.length - 1 && !/\s$/.test(node.text)) return;
        if (template && index === 0 && !ts.isTemplateHead(node) && !/^\s/.test(node.text)) return;
        uncompiled.add(`${model.site(node)} ${raw}`);
      });
    });
  }
  for (const [utility, site] of model.pending) {
    if (!model.compiled.has(utility) && isColourUtility(utility)) {
      uncompiled.add(`${site} ${utility.split(UNKNOWN).join('…')}`);
    }
  }
  for (const site of model.overflows) {
    uncompiled.add(`${site} more class combinations than the model follows`);
  }

  const unreadStyles: string[] = [];
  for (const source of model.files) {
    eachNode(source, (node) => {
      if (!ts.isPropertyAssignment(node) || !ts.isObjectLiteralExpression(node.parent)) return;
      const name = propertyNameText(node.name);
      if (!name || !STYLE_COLOUR_PROPERTY.test(name) || !isStyleObject(node.parent)) return;
      if (!model.styleColoursRead.has(node)) unreadStyles.push(`${model.site(node)} style ${name}`);
    });
  }

  return {
    failures: [...walker.failures].map(([label, shortfall]) => `${label}: ${shortfall}`).sort(),
    uncompiled: [...uncompiled].sort(),
    colourClasses,
    painted: walker.painted,
    unreadStyles: unreadStyles.sort(),
    visits: walker.visits,
  };
}

let productReport: Promise<RenderReport> | undefined;

/** The whole product, walked once for every test that reads it. */
function productColours(): Promise<RenderReport> {
  return (productReport ??= buildRenderReport(SRC_ROOT, productionSources()));
}

describe('the static colour model', () => {
  it('composites a tint the way the browser does', () => {
    // The Scratch org badge as it first shipped: `bg-purple-500/20` under
    // `text-hue-purple` kept at 55%, on Light Modern's widget background.
    // axe measured it at 3.59:1 in Chromium.
    const lightModern = vscodeTheme('Light Modern');
    const tint = parseColour('rgb(168 85 247 / 0.2)') as Rgba;
    const under = over(tint, opaqueColour(lightModern, 'var(--sf-bg-card)'));
    const text = parseColour(
      `color-mix(in srgb, #c084fc 55%, ${themeColour(lightModern, 'editor.foreground')})`,
    ) as Rgba;
    expect(rgbaContrast(text, under)).toBeCloseTo(3.59, 1);
  });

  it('reads the panel surfaces and host colours VS Code sends, not the dark fallbacks', () => {
    const lightModern = vscodeTheme('Light Modern');
    expect(
      panelSurfaces(lightModern).map((c) => rgbaContrast(c, hexColour('#FFFFFF') as Rgba)),
    ).toEqual([
      1,
      expect.closeTo(rgbaContrast(hexColour('#F8F8F8') as Rgba, hexColour('#FFFFFF') as Rgba), 5),
      expect.closeTo(rgbaContrast(hexColour('#F8F8F8') as Rgba, hexColour('#FFFFFF') as Rgba), 5),
    ]);
    // Light Modern leaves disabledForeground unset: the registry default applies.
    expect(resolvePaint(lightModern, { css: 'var(--sf-text-muted)', locals: {} }).colour).toEqual(
      hexColour('#61616180'),
    );
  });

  it("measures VS Code's default themes, Light 2026 and Dark 2026, and six more core themes", () => {
    expect(VSCODE_THEMES.map((theme) => theme.name)).toEqual([
      'Light 2026',
      'Dark 2026',
      'Dark+',
      'Dark Modern',
      'Light+',
      'Light Modern',
      'Quiet Light',
      'Solarized Light',
    ]);
    // Dark 2026 includes Dark Modern: what it sets wins (description, list hover),
    // what it leaves comes from Dark Modern (the secondary button foreground).
    const dark2026 = hostColours(vscodeTheme('Dark 2026'));
    expect(dark2026['descriptionForeground']).toBe('#8C8C8C');
    expect(dark2026['list-hoverBackground']).toBe('#FFFFFF14');
    expect(dark2026['button-secondaryForeground']).toBe(
      hostColours(vscodeTheme('Dark Modern'))['button-secondaryForeground'],
    );
  });

  describe('on sources written for it', () => {
    let root = '';
    const report = async (
      files: Record<string, string>,
      maxVisits?: number,
    ): Promise<RenderReport> => {
      root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sf-contrast-')));
      const names = Object.entries(files).map(([name, content]) => {
        const file = path.join(root, name);
        fs.writeFileSync(file, content);
        return file;
      });
      return buildRenderReport(root, names, maxVisits);
    };
    afterEach(() => {
      if (root) fs.rmSync(root, { recursive: true, force: true });
      root = '';
    });

    /**
     * Composite `layers` (outermost first) over each Light Modern surface — the
     * editor, and the side bar and widgets at #F8F8F8 — and measure `text` on
     * them, by hand: the worst ratio, rounded as the report rounds it.
     */
    const byHand = (layers: string[], text: string): number =>
      round(
        Math.min(
          ...['#FFFFFF', '#F8F8F8'].map((surface) => {
            let under = hexColour(surface) as Rgba;
            for (const layer of layers) under = over(parseColour(layer) as Rgba, under);
            return rgbaContrast(over(parseColour(text) as Rgba, under), under);
          }),
        ),
      );

    it('measures a badge on every tint stacked under it, through a lookup map', async () => {
      // Tailwind 3's orange-500 and orange-700, written as the colours they
      // were: Tailwind 4's palette is written in oklch, which this model does
      // not read, and the product writes no palette shade.
      const tint = 'bg-[#f97316]/20';
      const ink = 'text-[#c2410c]';
      const pattern = (text: string): string => text.replace(/[[\]/#]/g, '\\$&');
      const { failures } = await report({
        'Panel.tsx': [
          `const stage: Record<string, string> = { insert: '${tint} ${ink}' };`,
          'export const Panel = ({ kind }: { kind: string }) => (',
          `  <div className="${tint}">`,
          '    <span className={stage[kind]}>insert</span>',
          '  </div>',
          ');',
        ].join('\n'),
      });
      const orange = 'rgb(249 115 22 / 0.2)';
      const stacked = byHand([orange, orange], 'rgb(194 65 12)');
      const single = byHand([orange], 'rgb(194 65 12)');
      expect(stacked).toBeLessThan(single);
      expect(failures).toContainEqual(
        expect.stringMatching(
          new RegExp(
            `^Panel\\.tsx:4 ${pattern(ink)} on ${pattern(tint)} \\(Panel\\.tsx:4\\) over ${pattern(tint)} \\(Panel\\.tsx:3\\): .*Light Modern = ${stacked}:1`,
          ),
        ),
      );
    });

    it('follows a component: its props, its own tint, and the children it renders', async () => {
      const { failures } = await report({
        'cn.ts':
          'export function cn(...parts: (string | false)[]): string { return parts.filter(Boolean).join(" "); }',
        'Callout.tsx': [
          "import { cn } from './cn';",
          'export const Callout = ({ tone, children }: { tone: string; children: unknown }) => (',
          "  <div className={cn('rounded-sm p-2', tone)}>{children}</div>",
          ');',
        ].join('\n'),
        'Page.tsx': [
          "import { Callout } from './Callout';",
          'export const Page = () => (',
          `  <Callout tone="${paletteClass('bg', 'amber', 500)}/30">`,
          `    <p className="${paletteClass('text', 'amber', 600)}">hello</p>`,
          '  </Callout>',
          ');',
        ].join('\n'),
      });
      expect(failures).toContainEqual(
        expect.stringMatching(
          /^Page\.tsx:4 text-amber-600 on bg-amber-500\/30 \(Callout\.tsx:3\): /,
        ),
      );
    });

    it('refuses the disabled foreground and a class that compiles to nothing', async () => {
      const result = await report({
        'Row.tsx': [
          'export const Row = () => (',
          '  <div className="bg-surface-9/50">',
          '    <span className="text-text-muted">label</span>',
          '    <button className="disabled:text-text-muted text-text-primary" disabled>go</button>',
          '  </div>',
          ');',
        ].join('\n'),
      });
      expect(result.failures).toEqual([
        'Row.tsx:3 text-text-muted: the disabled foreground, on something a user reads',
      ]);
      expect(result.uncompiled).toEqual(['Row.tsx:2 bg-surface-9/50']);
    });

    it('measures fixed palette text and inline colours, and refuses a gradient under text', async () => {
      const result = await report({
        'Chip.tsx': [
          'export const Chip = () => (',
          '  <p>',
          '    <span className="text-forge">a</span>',
          "    <span style={{ color: 'var(--sf-success)' }}>b</span>",
          '    <span className="bg-linear-to-r from-forge to-transparent text-text-primary">c</span>',
          '  </p>',
          ');',
        ].join('\n'),
      });
      const { failures } = result;
      expect(failures).toContainEqual(
        expect.stringMatching(/^Chip\.tsx:3 text-forge: .*Light Modern = /),
      );
      expect(failures).toContainEqual(
        expect.stringMatching(/^Chip\.tsx:4 style color: var\(--sf-success\): .*Light\+ = /),
      );
      expect(failures).toContainEqual(
        expect.stringMatching(
          /^Chip\.tsx:5 text-text-primary on bg-linear-to-r .*: painted on bg-linear-to-r/,
        ),
      );
    });

    it('measures opacity, a hover state and SVG text, and keeps what one condition pairs', async () => {
      const { failures } = await report({
        'State.tsx': [
          'export const State = ({ open, status }: { open: boolean; status: string }) => (',
          '  <div>',
          '    <span className="opacity-50 text-text-primary">faded</span>',
          '    <button className="text-status-error hover:bg-[#ef4444]/40">hover</button>',
          '    <svg><text className="fill-text-muted">axis</text></svg>',
          "    <div className={open ? 'bg-(--sf-button-bg)' : 'bg-transparent'}>",
          "      <span className={open ? 'text-(--sf-button-fg)' : 'text-text-primary'}>ok</span>",
          '    </div>',
          '    {status === \'done\' && <span className="text-status-success">done</span>}',
          '  </div>',
          ');',
        ].join('\n'),
      });
      expect(failures).toContainEqual(
        expect.stringMatching(/^State\.tsx:3 text-text-primary on opacity-50 \(State\.tsx:3\): /),
      );
      expect(failures).toContainEqual(
        expect.stringMatching(
          /^State\.tsx:4 text-status-error \[hover\] on hover:bg-\[#ef4444\]\/40 /,
        ),
      );
      expect(failures).toContain(
        'State.tsx:5 fill-text-muted: the disabled foreground, on something a user reads',
      );
      // The button foreground is only ever written on the button background.
      expect(failures.filter((failure) => failure.startsWith('State.tsx:7'))).toEqual([]);
    });

    it("holds the theme's description text to what the theme itself reaches on that surface, never lower", async () => {
      const { failures } = await report({
        'Rows.tsx': [
          'export const Rows = () => (',
          '  <div className="bg-surface-0">',
          '    <p className="bg-status-info/10">',
          '      <span className="text-text-secondary">running</span>',
          '    </p>',
          '    <p className="bg-surface-1">',
          '      <span className="text-text-secondary">on a widget</span>',
          '      <span className="hover:bg-(--sf-bg-hover) text-text-secondary">hovered</span>',
          '    </p>',
          '  </div>',
          ');',
        ].join('\n'),
      });
      // Light+ writes description text at 4.88:1 on its editor: the bar there stays AA,
      // and a /10 info tint over that editor brings it under.
      const lightPlus = vscodeTheme('Light+');
      const editor = opaqueColour(lightPlus, 'var(--sf-bg-primary)');
      const description = opaqueColour(lightPlus, 'var(--sf-text-secondary)');
      expect(rgbaContrast(description, editor)).toBeGreaterThan(AA);
      const tint = resolvePaint(lightPlus, {
        css: 'color-mix(in oklab, color-mix(in srgb, var(--sf-info) 80%, var(--sf-text-primary)) 10%, transparent)',
        locals: {},
      }).colour as Rgba;
      const tinted = over(tint, editor);
      const ratio = round(rgbaContrast(over(description, tinted), tinted));
      expect(ratio).toBeLessThan(AA);
      expect(failures).toContainEqual(
        expect.stringMatching(
          new RegExp(
            `^Rows\\.tsx:4 text-text-secondary on bg-status-info/10 \\(Rows\\.tsx:3\\) over bg-surface-0 \\(Rows\\.tsx:2\\): .*Light\\+ = ${ratio}:1(?! \\()`,
          ),
        ),
      );
      // On its own widget surface Light+ reaches 4.4:1, and so may the panel.
      expect(failures.filter((failure) => failure.startsWith('Rows.tsx:7'))).toEqual([]);
      // Dark 2026, a default, pairs its description text with no hover background.
      expect(failures).toContainEqual(
        expect.stringMatching(
          /^Rows\.tsx:8 text-text-secondary \[hover\] on hover:bg-\(--sf-bg-hover\) .*Dark 2026 = 3\.8:1/,
        ),
      );
    });

    it('follows a render prop a component calls inside a map, written under a condition, into its inline styles', async () => {
      const { failures } = await report({
        'List.tsx': [
          'export function List<T>({',
          '  items,',
          '  renderItem,',
          '}: {',
          '  items: T[];',
          '  renderItem: (item: T, index: number) => unknown;',
          '}) {',
          '  return (',
          '    <ul>',
          '      {items.map((item, index) => (',
          '        <li key={index}>{renderItem(item, index)}</li>',
          '      ))}',
          '    </ul>',
          '  );',
          '}',
        ].join('\n'),
        'Groups.tsx': [
          "import { List } from './List';",
          "const ROW = { color: '#ffffff', padding: 4 };",
          'type Group = { name: string; rows: string[] };',
          'export const Groups = ({ groups, open }: { groups: Group[]; open: Set<string> }) => (',
          '  <div>',
          '    {groups.map((group) => {',
          '      const expanded = open.has(group.name);',
          '      return (',
          '        <section key={group.name}>',
          '          {expanded && (',
          '            <List',
          '              items={group.rows}',
          '              renderItem={(row) => (',
          "                <p style={{ ...ROW, cursor: 'pointer' }}>",
          "                  <span style={{ color: row === 'a' ? '#fefefe' : 'inherit' }}>{row}</span>",
          '                </p>',
          '              )}',
          '            />',
          '          )}',
          '        </section>',
          '      );',
          '    })}',
          '  </div>',
          ');',
        ].join('\n'),
      });
      expect(failures).toContainEqual(
        expect.stringMatching(/^Groups\.tsx:14 style color: #ffffff: .*Light Modern = 1:1/),
      );
      expect(failures).toContainEqual(
        expect.stringMatching(/^Groups\.tsx:15 style color: #fefefe: .*Light Modern = 1\.01:1/),
      );
    });

    it('reports an inline colour that no render it follows reads', async () => {
      const { unreadStyles } = await report({
        'Menu.tsx': [
          "import type { CSSProperties } from 'react';",
          "const HINT: CSSProperties = { color: '#ffffff' };",
          'const Shell = ({ title }: { title: string; renderEmpty?: () => unknown }) => (',
          '  <section>{title}</section>',
          ');',
          'export const Menu = () => (',
          '  <Shell title="x" renderEmpty={() => <i style={{ color: \'#ffffff\' }}>none</i>} />',
          ');',
        ].join('\n'),
      });
      expect(unreadStyles).toEqual(['Menu.tsx:2 style color', 'Menu.tsx:7 style color']);
    });

    it('walks a component once in its own render, however it reaches itself', async () => {
      // A row handed its `t` through spread props calls, to the model, what the
      // element's own tag stands for: the row itself. Each `t('…', { count })`
      // walked the row again inside the call, each of those did the same, and
      // over the Seed field panel written that way the walk ran eight minutes
      // before giving up past four million visits. A tree that renders itself
      // twice doubled at every level.
      // Tailwind 3's amber-500 and amber-600: see the badge above.
      const tint = 'bg-[#f59e0b]/20';
      const ink = 'text-[#d97706]';
      const { failures, visits } = await report(
        {
          'Rows.tsx': [
            'type T = (key: string, options?: Record<string, unknown>) => string;',
            'type Row = { name: string; count: number };',
            'const Line = ({ name, count, t }: Row & { t: T }) => (',
            `  <p className="${tint}">`,
            `    <span className="${ink}">{t('rows.fields', { count })}</span>`,
            "    <em>{t('rows.named', { count, name })}</em>",
            '  </p>',
            ');',
            'export const Rows = ({ rows, t }: { rows: Row[]; t: T }) => {',
            '  const shared = { t };',
            '  return <div>{rows.map((row) => <Line key={row.name} {...row} {...shared} />)}</div>;',
            '};',
            'type Node = { name: string; left?: Node; right?: Node };',
            'export const Tree = ({ node }: { node: Node }) => (',
            `  <ul className="${tint}">`,
            `    <li className="${ink}">{node.name}</li>`,
            '    {node.left && <Tree node={node.left} />}',
            '    {node.right && <Tree node={node.right} />}',
            '  </ul>',
            ');',
          ].join('\n'),
        },
        1_000,
      );
      // Each text measured once, on the one tint its own element paints.
      expect(failures.map((failure) => failure.slice(0, failure.indexOf(': ')))).toEqual([
        `Rows.tsx:16 ${ink} on ${tint} (Rows.tsx:15)`,
        `Rows.tsx:5 ${ink} on ${tint} (Rows.tsx:4)`,
      ]);
      expect(visits).toBeLessThan(20);
    });
  });
});

/**
 * A guard against contrast regressions in the shapes the model follows, not a
 * measurement of what the panel paints: the axe scans in
 * e2e/axe-accessibility.spec.ts are that.
 */
describe('modelled colour contrast', () => {
  it('compiles every colour class the product writes', async () => {
    const { uncompiled } = await productColours();
    expect(uncompiled).toEqual([]);
  }, 120_000);

  it('models every colour class the product writes, or finds it in a state WCAG exempts', async () => {
    const { colourClasses, painted } = await productColours();
    const unmeasured = [...colourClasses]
      .filter(([raw]) => !painted.has(raw))
      .map(([raw, site]) => `${site} ${raw}`);
    expect(unmeasured).toEqual([]);
  }, 120_000);

  it('reads every inline style colour the product writes in some render it follows', async () => {
    expect((await productColours()).unreadStyles).toEqual([]);
  }, 120_000);

  /**
   * Text needs 4.5:1 and a graphic 3:1 (WCAG 1.4.3, 1.4.11), or the theme's own
   * contrast for that colour where lower, on what the model finds painted under
   * it, on every measured theme whose own editor text clears AA.
   */
  it('holds every text and graphic the model resolves to AA or 3:1, on every measured theme whose own editor text clears AA', async () => {
    expect((await productColours()).failures).toEqual([]);
  }, 120_000);
});

describe('severity and identity text', () => {
  /**
   * An opacity modifier blends a severity or identity colour into whatever is
   * under it, and the contrast each token is sized for goes with it.
   */
  it('writes severity and identity text at full strength', () => {
    const faded: string[] = [];
    for (const file of productionSources()) {
      const content = fs.readFileSync(file, 'utf8');
      for (const match of content.matchAll(/(?<![\w-])text-(?:status|hue)-[a-z]+\/\d+(?![\w-])/g)) {
        faded.push(`${match[0]} (${path.relative(SRC_ROOT, file)})`);
      }
    }
    expect(faded).toEqual([]);
  });
});

/* ===================== every token utility the product writes ===================== */

const TOKEN_UTILITY =
  /(?<![\w-])(?:text|bg|border(?:-[xytrbl])?|ring|fill|stroke|from|via|to|outline|divide|decoration)-(?:status|hue)-[a-z]+(?:\/\d+)?(?![\w-])/g;

describe('token utilities in use', () => {
  it('compiles every status and hue utility written under src/', async () => {
    const used = new Set<string>();
    for (const file of productionSources()) {
      for (const match of fs.readFileSync(file, 'utf8').matchAll(TOKEN_UTILITY)) {
        used.add(match[0]);
      }
    }
    expect(used.size).toBeGreaterThan(0);

    const css = await buildWithTheme(`@import './styles/theme.css';`, used);

    const missing = [...used].filter(
      (utility) => !css.includes(`.${utility.replace('/', '\\/')} `),
    );
    expect(missing).toEqual([]);
  });
});

/* ===================== reduced motion ===================== */

describe('reduced motion', () => {
  it('stops animations and transitions when the system asks for reduced motion', () => {
    const root = postcss.parse(fs.readFileSync(DESIGN_SYSTEM_PATH, 'utf8'));
    const blocks: postcss.AtRule[] = [];
    root.walkAtRules('media', (rule) => {
      if (/\(\s*prefers-reduced-motion:\s*reduce\s*\)/.test(rule.params)) blocks.push(rule);
    });
    expect(blocks, 'no @media (prefers-reduced-motion: reduce) block').toHaveLength(1);

    const universal = blocks[0].nodes?.find(
      (node): node is postcss.Rule =>
        node.type === 'rule' && node.selectors.map((s) => s.trim()).includes('*'),
    );
    expect(universal, 'the block does not reach every element').toBeDefined();

    const declared = new Map<string, postcss.Declaration>();
    universal?.walkDecls((decl) => {
      declared.set(decl.prop, decl);
    });
    for (const prop of [
      'animation-duration',
      'animation-iteration-count',
      'transition-duration',
      'scroll-behavior',
    ]) {
      const decl = declared.get(prop);
      expect(decl, `${prop} is not reset`).toBeDefined();
      // Tailwind utilities and inline styles set these too; only !important wins.
      expect(decl?.important, `${prop} is not !important`).toBe(true);
    }
    expect(declared.get('animation-iteration-count')?.value).toBe('1');
    expect(universal?.selectors.map((s) => s.trim())).toEqual(
      expect.arrayContaining(['*::before', '*::after']),
    );
  });
});
