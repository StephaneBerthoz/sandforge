import type { Config } from 'tailwindcss';

/**
 * `status` — the severity tokens. Both halves of their declaration are load-bearing.
 *
 * VALUE. A frozen palette hue only ever clears AA against one background:
 * `text-red-400` reads 2.77:1 on a white editor and `text-yellow-400` 1.53:1.
 * But the raw VSCode severity variables are no better as *text* — they are
 * squiggle and icon colours, picked to be spotted, not read. On Light+
 * `testing.iconPassed` (#73c991) reads 2.00:1 and `editorWarning.foreground`
 * (#bf8803) 3.12:1; Quiet Light's `errorForeground` (#f1897f) reads 2.17:1.
 * So each severity keeps a share of its own hue and is pulled the rest of the
 * way toward `--sf-text-primary` — the editor foreground, the one colour a
 * theme guarantees is meant to be read on its own background. The share is the
 * largest that still clears 4.5:1 on every theme VSCode ships, which is why the
 * four differ: `info` is nearly legible on its own, `success` is not legible at
 * all. design-system.test.ts recomputes each ratio from the shipped themes.
 *
 * SHAPE. Tailwind cannot parse `var(--sf-warning)` as a colour, so it dropped
 * `bg-status-warning/10` and `border-status-warning/40` on the floor without a
 * word — the Forge SOQL callout rendered with neither background nor border.
 * A colour only takes the `/opacity` modifier if its declaration exposes an
 * alpha channel, so each token carries `<alpha-value>` through an outer
 * `color-mix()`, which Tailwind substitutes with the modifier (or 1).
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}', './index.html'],
  theme: {
    extend: {
      colors: {
        // Surface scale — mapped to VSCode CSS variables for theme support
        surface: {
          0: 'var(--sf-bg-primary, #0A0A0F)',
          1: 'var(--sf-bg-card, #12121A)',
          2: 'var(--sf-bg-secondary, #1C1C28)',
          3: 'var(--sf-bg-input, #262635)',
        },
        // Module accent colors (more saturated for dark)
        forge: { DEFAULT: '#F97316', light: '#FFEDD5', dark: '#9A3412' },
        seed: { DEFAULT: '#22C55E', light: '#D1FAE5', dark: '#065F46' },
        sync: { DEFAULT: '#3B82F6', light: '#DBEAFE', dark: '#1E40AF' },
        monitor: { DEFAULT: '#EAB308', light: '#FEF3C7', dark: '#92400E' },
        compare: { DEFAULT: '#A855F7', light: '#EDE9FE', dark: '#5B21B6' },
        dataops: { DEFAULT: '#06B6D4', light: '#CFFAFE', dark: '#0E7490' },
        automation: { DEFAULT: '#F43F5E', light: '#FFE4E6', dark: '#9F1239' },
        // Severity — see the `status` note above the config.
        status: {
          error:
            'color-mix(in srgb, color-mix(in srgb, var(--sf-error) 50%, var(--sf-text-primary)) calc(<alpha-value> * 100%), transparent)',
          warning:
            'color-mix(in srgb, color-mix(in srgb, var(--sf-warning) 60%, var(--sf-text-primary)) calc(<alpha-value> * 100%), transparent)',
          success:
            'color-mix(in srgb, color-mix(in srgb, var(--sf-success) 40%, var(--sf-text-primary)) calc(<alpha-value> * 100%), transparent)',
          info: 'color-mix(in srgb, color-mix(in srgb, var(--sf-info) 80%, var(--sf-text-primary)) calc(<alpha-value> * 100%), transparent)',
        },
        // Text — mapped to VSCode CSS variables
        'text-primary': 'var(--sf-text-primary, #F2F2F2)',
        'text-secondary': 'var(--sf-text-secondary, #A3A3A3)',
        'text-muted': 'var(--sf-text-muted, #6B6B7B)',
      },
      borderColor: {
        subtle: 'var(--sf-border-subtle, rgba(255,255,255,0.06))',
        DEFAULT: 'var(--sf-border, rgba(255,255,255,0.10))',
        // Marks hover/focus state, so it must stay visible on light themes too —
        // a translucent white is invisible against a light editor background.
        active: 'var(--sf-accent)',
      },
      borderRadius: {
        xl: '12px',
        lg: '8px',
      },
      fontFamily: {
        display: ['Inter Display', 'Inter', 'system-ui', 'sans-serif'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
    },
  },
  plugins: [],
};

export default config;
