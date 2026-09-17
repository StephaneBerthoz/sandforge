/**
 * The colours VS Code hands the webview under each theme the panel is measured
 * on, for the static contrast model (design-system.test.ts) and the rendered
 * scans (e2e/axe-accessibility.spec.ts). Excluded from coverage: test
 * infrastructure.
 *
 * The measured themes, which are all a contrast claim in this package covers:
 * - Light 2026 and Dark 2026, the defaults (extensions/theme-defaults/package.json
 *   lists them first; workbenchThemeService.ts sets COLOR_THEME_LIGHT and
 *   COLOR_THEME_DARK to them);
 * - Light Modern and Dark Modern, which they include and which were the
 *   defaults before them;
 * - Light+ and Dark+;
 * - Quiet Light;
 * - Solarized Light, measured but held to no contrast bar: its own editor text
 *   reads 3.64:1 on its side bar and widgets, and no colour pulled toward that
 *   text can clear AA. "Every measured theme" in a contrast claim leaves it out.
 * The other themes VS Code bundles are not measured: Visual Studio Light and
 * Dark, Monokai, Monokai Dimmed, Abyss, Red, Kimbie Dark, Solarized Dark,
 * Tomorrow Night Blue and the two high contrast themes.
 *
 * A webview receives one `--vscode-<id>` custom property per registered colour
 * the active theme resolves to something, with the first `.` of the id turned
 * into `-` (src/vs/workbench/contrib/webview/browser/themeing.ts). A colour
 * resolves to what the theme file sets, following its `include` chain, and
 * otherwise to the registry default for the theme's kind. A colour whose
 * default is null is not sent at all, so the panel paints its own fallback.
 *
 * Read from microsoft/vscode main on 2026-09-17:
 * - theme files: extensions/theme-defaults/themes/{2026-light,2026-dark,dark_vs,
 *   dark_plus,dark_modern,light_vs,light_plus,light_modern}.json,
 *   extensions/theme-quietlight/themes/quietlight-color-theme.json,
 *   extensions/theme-solarized-light/themes/solarized-light-color-theme.json;
 * - registry defaults: src/vs/platform/theme/common/colors/{base,editor,input,
 *   list,misc}Colors.ts, src/vs/workbench/common/theme.ts,
 *   src/vs/workbench/contrib/testing/browser/theme.ts,
 *   src/vs/workbench/contrib/debug/browser/breakpointEditorContribution.ts.
 *
 * Only the colours the webview reads are listed, plus the ones their defaults
 * are derived from: the panel's own, and those of the default stylesheet VS Code
 * prepends to every webview (e2e/fixtures/vscode-default-styles.ts) but its two
 * find highlights, which nothing the scans render shows.
 */

export type ThemeKind = 'light' | 'dark';

/** A default derived from another colour, as the registry writes it. */
interface Derived {
  /** A colour id, or a literal `#rrggbb`. */
  readonly of: string;
  /** `transparent(of, factor)`: alpha multiplied by the factor. */
  readonly transparent?: number;
  /** `lighten(of, factor)`: HSL lightness raised by that share of itself. */
  readonly lighten?: number;
  /** `darken(of, factor)`: HSL lightness lowered by that share of itself. */
  readonly darken?: number;
}

type RegistryValue = string | Derived | null;

const both = (value: RegistryValue): Record<ThemeKind, RegistryValue> => ({
  light: value,
  dark: value,
});

/** Registry defaults, for the two theme kinds the measured themes come in. */
const REGISTRY: Readonly<Record<string, Readonly<Record<ThemeKind, RegistryValue>>>> = {
  foreground: { dark: '#CCCCCC', light: '#616161' },
  descriptionForeground: { light: '#717171', dark: { of: 'foreground', transparent: 0.7 } },
  disabledForeground: { dark: '#CCCCCC80', light: '#61616180' },
  errorForeground: { dark: '#F48771', light: '#A1260D' },
  focusBorder: { dark: '#007FD4', light: '#0090F1' },
  'widget.border': both(null),
  'textLink.foreground': { light: '#006AB1', dark: '#3794FF' },
  'textLink.activeForeground': { light: '#006AB1', dark: '#3794FF' },
  'textPreformat.foreground': { light: '#A31515', dark: '#D7BA7D' },
  'textPreformat.background': { light: '#0000001A', dark: '#FFFFFF1A' },
  'textBlockQuote.background': { light: '#F2F2F2', dark: '#222222' },
  'textBlockQuote.border': both('#007ACC80'),
  'keybindingLabel.background': {
    dark: { of: '#808080', transparent: 0.17 },
    light: { of: '#DDDDDD', transparent: 0.4 },
  },
  'keybindingLabel.foreground': { dark: '#CCCCCC', light: '#555555' },
  'keybindingLabel.border': {
    dark: { of: '#333333', transparent: 0.6 },
    light: { of: '#CCCCCC', transparent: 0.4 },
  },
  'keybindingLabel.bottomBorder': {
    dark: { of: '#444444', transparent: 0.6 },
    light: { of: '#BBBBBB', transparent: 0.4 },
  },
  'widget.shadow': {
    dark: { of: '#000000', transparent: 0.36 },
    light: { of: '#000000', transparent: 0.16 },
  },
  'editor.background': { light: '#FFFFFF', dark: '#1E1E1E' },
  'editor.foreground': { light: '#333333', dark: '#BBBBBB' },
  'editor.selectionBackground': { light: '#ADD6FF', dark: '#264F78' },
  'editor.inactiveSelectionBackground': both({
    of: 'editor.selectionBackground',
    transparent: 0.5,
  }),
  'editorWidget.background': { dark: '#252526', light: '#F3F3F3' },
  'editorWidget.foreground': both({ of: 'foreground' }),
  'editorWidget.border': both({ of: 'editorWidget.foreground', transparent: 0.2 }),
  'editorHoverWidget.background': both({ of: 'editorWidget.background' }),
  'editorHoverWidget.foreground': both({ of: 'editorWidget.foreground' }),
  'editorHoverWidget.border': both({ of: 'editorWidget.border' }),
  'editorError.foreground': { dark: '#F14C4C', light: '#E51400' },
  'editorWarning.foreground': { dark: '#CCA700', light: '#BF8803' },
  'editorInfo.foreground': { dark: '#59A4F9', light: '#0063D3' },
  'editorInfo.background': both(null),
  'editorInfo.border': both(null),
  'editorGroupHeader.tabsBackground': { dark: '#252526', light: '#F3F3F3' },
  'input.background': { dark: '#3C3C3C', light: '#FFFFFF' },
  'input.foreground': both({ of: 'foreground' }),
  'input.border': both(null),
  'input.placeholderForeground': both({ of: 'foreground', transparent: 0.5 }),
  'inputValidation.errorBackground': { dark: '#5A1D1D', light: '#F2DEDE' },
  'inputValidation.warningBackground': { dark: '#352A05', light: '#F6F5D2' },
  'inputValidation.infoBackground': { dark: '#063B49', light: '#D6ECF2' },
  'dropdown.background': { dark: '#3C3C3C', light: '#FFFFFF' },
  'list.hoverBackground': { dark: '#2A2D2E', light: '#F0F0F0' },
  'list.activeSelectionBackground': { dark: '#04395E', light: '#0060C0' },
  'list.activeSelectionForeground': both('#FFFFFF'),
  'list.errorForeground': { dark: '#F88070', light: '#B01011' },
  'button.background': { dark: '#0E639C', light: '#007ACC' },
  'button.foreground': both('#FFFFFF'),
  'button.hoverBackground': {
    dark: { of: 'button.background', lighten: 0.2 },
    light: { of: 'button.background', darken: 0.2 },
  },
  'button.secondaryBackground': both({ of: 'list.hoverBackground' }),
  'button.secondaryForeground': both({ of: 'foreground' }),
  'button.secondaryHoverBackground': both({ of: 'list.hoverBackground', lighten: 0.2 }),
  'badge.background': { dark: '#4D4D4D', light: '#C4C4C4' },
  'badge.foreground': { dark: '#FFFFFF', light: '#333333' },
  'progressBar.background': both('#0E70C0'),
  'toolbar.hoverBackground': { dark: '#5A5D5E50', light: '#B8B8B850' },
  'panel.border': both({ of: '#808080', transparent: 0.35 }),
  'sideBar.background': { dark: '#252526', light: '#F3F3F3' },
  'scrollbarSlider.background': {
    dark: { of: '#797979', transparent: 0.4 },
    light: { of: '#646464', transparent: 0.4 },
  },
  'scrollbarSlider.hoverBackground': both({ of: '#646464', transparent: 0.7 }),
  'scrollbarSlider.activeBackground': {
    dark: { of: '#BFBFBF', transparent: 0.4 },
    light: { of: '#000000', transparent: 0.6 },
  },
  'notifications.background': both({ of: 'editorWidget.background' }),
  'notifications.foreground': both({ of: 'editorWidget.foreground' }),
  'notificationCenterHeader.background': {
    dark: { of: 'notifications.background', lighten: 0.3 },
    light: { of: 'notifications.background', darken: 0.05 },
  },
  'notifications.border': both({ of: 'notificationCenterHeader.background' }),
  'notificationsErrorIcon.foreground': both({ of: 'editorError.foreground' }),
  'notificationsWarningIcon.foreground': both({ of: 'editorWarning.foreground' }),
  'notificationsInfoIcon.foreground': both({ of: 'editorInfo.foreground' }),
  'testing.iconPassed': both('#73C991'),
  'testing.iconFailed': both({ of: 'list.errorForeground' }),
  'debugIcon.breakpointForeground': both('#E51400'),
};

export interface VsCodeTheme {
  readonly name: string;
  readonly kind: ThemeKind;
  /** What the theme file sets, its include chain flattened, for the colours above. */
  readonly sets: Readonly<Record<string, string>>;
}

export const VSCODE_THEMES: readonly VsCodeTheme[] = [
  {
    name: 'Light 2026',
    kind: 'light',
    sets: {
      'badge.background': '#0069CC',
      'badge.foreground': '#FFFFFF',
      'button.background': '#0069CC',
      'button.foreground': '#FFFFFF',
      'button.hoverBackground': '#0063C1',
      'button.secondaryBackground': '#EAEAEA',
      'button.secondaryForeground': '#202020',
      'button.secondaryHoverBackground': '#F2F3F4',
      descriptionForeground: '#606060',
      disabledForeground: '#BBBBBB',
      'dropdown.background': '#FFFFFF',
      'editor.background': '#FFFFFF',
      'editor.foreground': '#202020',
      'editor.inactiveSelectionBackground': '#0069CC1A',
      'editor.selectionBackground': '#0069CC40',
      'editorGroupHeader.tabsBackground': '#EAEAEA',
      'editorHoverWidget.background': '#FAFAFD',
      'editorHoverWidget.border': '#E4E5E6',
      'editorWidget.background': '#FAFAFD',
      'editorWidget.border': '#E4E5E6',
      'editorWidget.foreground': '#202020',
      errorForeground: '#AD0707',
      focusBorder: '#0069CC',
      foreground: '#202020',
      'input.background': '#FFFFFF',
      'input.border': '#D8D8D866',
      'input.foreground': '#202020',
      'input.placeholderForeground': '#999999',
      'inputValidation.errorBackground': '#FDEDED',
      'inputValidation.infoBackground': '#E6F2FA',
      'inputValidation.warningBackground': '#FDF6E3',
      'keybindingLabel.foreground': '#3B3B3B',
      'list.activeSelectionBackground': '#00000025',
      'list.activeSelectionForeground': '#202020',
      'list.errorForeground': '#AD0707',
      'list.hoverBackground': '#00000014',
      'notificationCenterHeader.background': '#FAFAFD',
      'notifications.background': '#FAFAFD',
      'notifications.border': '#F0F1F2',
      'notifications.foreground': '#202020',
      'notificationsErrorIcon.foreground': '#AD0707',
      'notificationsInfoIcon.foreground': '#0069CC',
      'notificationsWarningIcon.foreground': '#B69500',
      'panel.border': '#F0F1F2',
      'progressBar.background': '#0069CC',
      'scrollbarSlider.activeBackground': '#646464E0',
      'scrollbarSlider.background': '#646464C0',
      'scrollbarSlider.hoverBackground': '#646464D0',
      'sideBar.background': '#FAFAFD',
      'textBlockQuote.background': '#EAEAEA',
      'textBlockQuote.border': '#F0F1F2',
      'textLink.activeForeground': '#0069CC',
      'textLink.foreground': '#0069CC',
      'textPreformat.background': '#ECECEC',
      'textPreformat.foreground': '#606060',
      'toolbar.hoverBackground': '#0000001F',
      'widget.border': '#E2E2E5',
      'widget.shadow': '#00000000',
    },
  },
  {
    name: 'Dark 2026',
    kind: 'dark',
    sets: {
      'badge.background': '#307E9F',
      'badge.foreground': '#FFFFFF',
      'button.background': '#297AA0',
      'button.foreground': '#FFFFFF',
      'button.hoverBackground': '#2B7DA3',
      'button.secondaryBackground': '#00000000',
      'button.secondaryForeground': '#CCCCCC',
      'button.secondaryHoverBackground': '#FFFFFF10',
      descriptionForeground: '#8C8C8C',
      disabledForeground: '#555555',
      'dropdown.background': '#191A1B',
      'editor.background': '#121314',
      'editor.foreground': '#BBBEBF',
      'editor.inactiveSelectionBackground': '#27678260',
      'editor.selectionBackground': '#276782DD',
      'editorGroupHeader.tabsBackground': '#202122',
      'editorHoverWidget.background': '#202122',
      'editorHoverWidget.border': '#2A2B2C',
      'editorWidget.background': '#202122',
      'editorWidget.border': '#2A2B2C',
      'editorWidget.foreground': '#BFBFBF',
      errorForeground: '#F48771',
      focusBorder: '#3994BCB3',
      foreground: '#BFBFBF',
      'input.background': '#191A1B',
      'input.border': '#333536',
      'input.foreground': '#BFBFBF',
      'input.placeholderForeground': '#555555',
      'inputValidation.errorBackground': '#3A1D1D',
      'inputValidation.infoBackground': '#1E3A47',
      'inputValidation.warningBackground': '#352A05',
      'keybindingLabel.foreground': '#CCCCCC',
      'list.activeSelectionBackground': '#FFFFFF22',
      'list.activeSelectionForeground': '#EDEDED',
      'list.errorForeground': '#F48771',
      'list.hoverBackground': '#FFFFFF14',
      'notificationCenterHeader.background': '#242526',
      'notifications.background': '#202122',
      'notifications.border': '#2A2B2C',
      'notifications.foreground': '#BFBFBF',
      'notificationsErrorIcon.foreground': '#F48771',
      'notificationsInfoIcon.foreground': '#3A94BC',
      'notificationsWarningIcon.foreground': '#CCA700',
      'panel.border': '#2A2B2C',
      'progressBar.background': '#878889',
      'scrollbarSlider.activeBackground': '#A8A9AA9C',
      'scrollbarSlider.background': '#A8A9AA85',
      'scrollbarSlider.hoverBackground': '#A8A9AA90',
      'sideBar.background': '#191A1B',
      'textBlockQuote.background': '#242526',
      'textBlockQuote.border': '#2A2B2C',
      'textLink.activeForeground': '#53A5CA',
      'textLink.foreground': '#48A0C7',
      'textPreformat.background': '#262626',
      'textPreformat.foreground': '#8C8C8C',
      'widget.border': '#2A2B2C',
    },
  },
  {
    name: 'Dark+',
    kind: 'dark',
    sets: {
      'editor.background': '#1E1E1E',
      'editor.foreground': '#D4D4D4',
      'editor.inactiveSelectionBackground': '#3A3D41',
      'editorGroupHeader.tabsBackground': '#303031',
      'input.placeholderForeground': '#A6A6A6',
      'widget.border': '#303031',
    },
  },
  {
    name: 'Dark Modern',
    kind: 'dark',
    sets: {
      'badge.background': '#616161',
      'badge.foreground': '#F8F8F8',
      'button.background': '#0078D4',
      'button.foreground': '#FFFFFF',
      'button.hoverBackground': '#026EC1',
      'button.secondaryBackground': '#00000000',
      'button.secondaryForeground': '#CCCCCC',
      'button.secondaryHoverBackground': '#2B2B2B',
      descriptionForeground: '#9D9D9D',
      'dropdown.background': '#313131',
      'editor.background': '#1F1F1F',
      'editor.foreground': '#CCCCCC',
      'editor.inactiveSelectionBackground': '#3A3D41',
      'editorGroupHeader.tabsBackground': '#2B2B2B',
      'editorWidget.background': '#202020',
      errorForeground: '#F85149',
      focusBorder: '#0078D4',
      foreground: '#CCCCCC',
      'input.background': '#313131',
      'input.border': '#3C3C3C',
      'input.foreground': '#CCCCCC',
      'input.placeholderForeground': '#989898',
      'keybindingLabel.foreground': '#CCCCCC',
      'notificationCenterHeader.background': '#1F1F1F',
      'notifications.background': '#1F1F1F',
      'notifications.border': '#2B2B2B',
      'notifications.foreground': '#CCCCCC',
      'panel.border': '#2B2B2B',
      'progressBar.background': '#0078D4',
      'sideBar.background': '#181818',
      'textBlockQuote.background': '#2B2B2B',
      'textBlockQuote.border': '#616161',
      'textLink.activeForeground': '#4DAAFC',
      'textLink.foreground': '#4DAAFC',
      'textPreformat.background': '#3C3C3C',
      'textPreformat.foreground': '#D0D0D0',
      'widget.border': '#313131',
    },
  },
  {
    name: 'Light+',
    kind: 'light',
    sets: {
      'editor.background': '#FFFFFF',
      'editor.foreground': '#000000',
      'editor.inactiveSelectionBackground': '#E5EBF1',
      'editorGroupHeader.tabsBackground': '#E8E8E8',
      'input.placeholderForeground': '#767676',
      'list.hoverBackground': '#E8E8E8',
      'widget.border': '#D4D4D4',
    },
  },
  {
    name: 'Light Modern',
    kind: 'light',
    sets: {
      'badge.background': '#CCCCCC',
      'badge.foreground': '#3B3B3B',
      'button.background': '#005FB8',
      'button.foreground': '#FFFFFF',
      'button.hoverBackground': '#0258A8',
      'button.secondaryBackground': '#E5E5E5',
      'button.secondaryForeground': '#3B3B3B',
      'button.secondaryHoverBackground': '#CCCCCC',
      descriptionForeground: '#3B3B3B',
      'dropdown.background': '#FFFFFF',
      'editor.background': '#FFFFFF',
      'editor.foreground': '#3B3B3B',
      'editor.inactiveSelectionBackground': '#E5EBF1',
      'editorGroupHeader.tabsBackground': '#E5E5E5',
      'editorWidget.background': '#F8F8F8',
      errorForeground: '#F85149',
      focusBorder: '#005FB8',
      foreground: '#3B3B3B',
      'input.background': '#FFFFFF',
      'input.border': '#CECECE',
      'input.foreground': '#3B3B3B',
      'input.placeholderForeground': '#767676',
      'keybindingLabel.foreground': '#3B3B3B',
      'list.activeSelectionBackground': '#E8E8E8',
      'list.activeSelectionForeground': '#000000',
      'list.hoverBackground': '#F2F2F2',
      'notificationCenterHeader.background': '#FFFFFF',
      'notifications.background': '#FFFFFF',
      'notifications.border': '#E5E5E5',
      'notifications.foreground': '#3B3B3B',
      'panel.border': '#E5E5E5',
      'progressBar.background': '#005FB8',
      'sideBar.background': '#F8F8F8',
      'textBlockQuote.background': '#F8F8F8',
      'textBlockQuote.border': '#E5E5E5',
      'textLink.activeForeground': '#005FB8',
      'textLink.foreground': '#005FB8',
      'textPreformat.background': '#0000001F',
      'textPreformat.foreground': '#3B3B3B',
      'widget.border': '#E5E5E5',
    },
  },
  {
    name: 'Quiet Light',
    kind: 'light',
    sets: {
      'badge.background': '#705697AA',
      'button.background': '#705697',
      'dropdown.background': '#F5F5F5',
      'editor.background': '#F5F5F5',
      'editor.selectionBackground': '#C9D0D9',
      'editorGroupHeader.tabsBackground': '#E4E4E4',
      errorForeground: '#F1897F',
      focusBorder: '#9769DC',
      'inputValidation.errorBackground': '#FFEAEA',
      'inputValidation.infoBackground': '#F2FCFF',
      'inputValidation.warningBackground': '#FFFEE2',
      'list.activeSelectionBackground': '#C4D9B1',
      'list.activeSelectionForeground': '#6C6C6C',
      'list.hoverBackground': '#E0E0E0',
      'progressBar.background': '#705697',
      'sideBar.background': '#F2F2F2',
    },
  },
  {
    name: 'Solarized Light',
    kind: 'light',
    sets: {
      'badge.background': '#B58900AA',
      'button.background': '#AC9D57',
      'dropdown.background': '#EEE8D5',
      'editor.background': '#FDF6E3',
      'editor.foreground': '#657B83',
      'editor.selectionBackground': '#EEE8D5',
      'editorGroupHeader.tabsBackground': '#D9D2C2',
      'editorHoverWidget.background': '#CCC4B0',
      'editorWidget.background': '#EEE8D5',
      focusBorder: '#B49471',
      'input.background': '#DDD6C1',
      'input.foreground': '#586E75',
      'input.placeholderForeground': '#586E75AA',
      'list.activeSelectionBackground': '#DFCA88',
      'list.activeSelectionForeground': '#6C6C6C',
      'list.hoverBackground': '#DFCA8844',
      'panel.border': '#DDD6C1',
      'progressBar.background': '#B58900',
      'sideBar.background': '#EEE8D5',
    },
  },
];

export function vscodeTheme(name: string): VsCodeTheme {
  const theme = VSCODE_THEMES.find((candidate) => candidate.name === name);
  if (!theme) throw new Error(`${name} is not a measured theme`);
  return theme;
}

interface Rgba8 {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  /** 0 to 1, kept unrounded as VS Code's Color does. */
  readonly a: number;
}

const roundFloat = (n: number, decimals: number): number =>
  Math.round(n * 10 ** decimals) / 10 ** decimals;
const unit = (n: number): number => roundFloat(Math.max(Math.min(1, n), 0), 3);

function fromHex(hex: string): Rgba8 {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
    a: h.length === 8 ? roundFloat(parseInt(h.slice(6, 8), 16) / 255, 3) : 1,
  };
}

function toHex({ r, g, b, a }: Rgba8): string {
  const byte = (n: number): string => Math.round(n).toString(16).padStart(2, '0').toUpperCase();
  return `#${byte(r)}${byte(g)}${byte(b)}${a < 1 ? byte(a * 255) : ''}`;
}

/**
 * `Color.lighten`/`Color.darken` in src/vs/base/common/color.ts: through
 * HSLA.fromRGBA and HSLA.toRGBA, with the rounding their constructors apply.
 */
function scaleLightness(colour: Rgba8, factor: number): Rgba8 {
  const r = colour.r / 255;
  const g = colour.g / 255;
  const b = colour.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = unit((min + max) / 2);
  const chroma = max - min;
  if (chroma > 0) {
    s = Math.min((min + max) / 2 <= 0.5 ? chroma / (min + max) : chroma / (2 - (min + max)), 1);
    if (max === r) h = (g - b) / chroma + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / chroma + 2;
    else h = (r - g) / chroma + 4;
    h = Math.round(h * 60);
  }
  s = unit(s);
  const lightness = unit(l + l * factor);
  const hue = (Math.max(Math.min(360, h), 0) | 0) / 360;
  const toChannel = (p: number, q: number, t: number): number => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  if (s === 0) {
    const grey = Math.round(lightness * 255);
    return { r: grey, g: grey, b: grey, a: colour.a };
  }
  const q = lightness < 0.5 ? lightness * (1 + s) : lightness + s - lightness * s;
  const p = 2 * lightness - q;
  return {
    r: Math.round(toChannel(p, q, hue + 1 / 3) * 255),
    g: Math.round(toChannel(p, q, hue) * 255),
    b: Math.round(toChannel(p, q, hue - 1 / 3) * 255),
    a: colour.a,
  };
}

function resolve(theme: VsCodeTheme, id: string, seen: ReadonlySet<string>): Rgba8 | null {
  if (id.startsWith('#')) return fromHex(id);
  if (seen.has(id)) throw new Error(`colour ${id} refers to itself`);
  const set = theme.sets[id];
  if (set !== undefined) return fromHex(set);
  const entry = REGISTRY[id];
  if (!entry) throw new Error(`colour ${id} is not in the registry excerpt`);
  const value = entry[theme.kind];
  if (value === null) return null;
  if (typeof value === 'string') return fromHex(value);
  const base = resolve(theme, value.of, new Set([...seen, id]));
  if (!base) return null;
  if (value.transparent !== undefined) return { ...base, a: unit(base.a * value.transparent) };
  if (value.lighten !== undefined) return scaleLightness(base, value.lighten);
  if (value.darken !== undefined) return scaleLightness(base, -value.darken);
  return base;
}

/** The colour a theme gives a registered id, or null when VS Code sends nothing for it. */
export function themeColour(theme: VsCodeTheme, id: string): string | null {
  const colour = resolve(theme, id, new Set());
  return colour ? toHex(colour) : null;
}

/**
 * The custom properties the webview receives under a theme, named without
 * their `--vscode-` prefix: `editor-background`, `button-secondaryForeground`.
 */
export function hostColours(theme: VsCodeTheme): Record<string, string> {
  const colours: Record<string, string> = {};
  for (const id of Object.keys(REGISTRY)) {
    const value = themeColour(theme, id);
    if (value !== null) colours[id.replace('.', '-')] = value;
  }
  return colours;
}
