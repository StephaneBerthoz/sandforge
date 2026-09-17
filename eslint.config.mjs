import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';

/** Message shared by both token-gate selectors (webview design-system rule). */
const VSCODE_VAR_MSG =
  'Hardcoded var(--vscode-*) is forbidden outside the design system. Use token classes (bg-surface-*, text-text-*, border-subtle) or var(--sf-*) — see src/styles/design-system.css.';

/**
 * Fixed `-400` palette classes read on a dark editor and fail AA on a light
 * one. Severity goes through `*-status-*`, identity colours through `*-hue-*`,
 * neutral text through `text-text-*` (tailwind.config.ts).
 */
const PALETTE_400 =
  '(^|[^\\w-])(text|bg|border(-[xytrbl])?|ring|fill|stroke|from|via|to|outline|divide|decoration|placeholder|caret|accent|shadow)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-400($|[^\\w-])';
const PALETTE_400_MSG =
  'Fixed -400 palette classes fail contrast on light themes. Use text-status-*, text-hue-* or text-text-* — see tailwind.config.ts.';
const PALETTE_400_SELECTORS = [
  { selector: `Literal[value=/${PALETTE_400}/]`, message: PALETTE_400_MSG },
  { selector: `TemplateElement[value.raw=/${PALETTE_400}/]`, message: PALETTE_400_MSG },
];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/out/**',
      '**/node_modules/**',
      '**/webview-dist/**',
      '**/coverage/**',
      '**/*.js',
      'reports/**',
      '.stryker-tmp/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: [
      'packages/*/src/**/*.{ts,tsx}',
      'packages/extension/cli/**/*.ts',
      'packages/extension/tools/**/*.ts',
    ],
    rules: {
      'no-console': 'warn',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'prefer-const': 'error',
    },
  },
  {
    // Typed linting for the extension host: catches floating promises (the
    // 1.3.0 panel-leak class of bugs). Every file under packages/extension/src
    // is covered by tsconfig.test.json (include: src/**/*), and the command-line
    // scripts beside it by tsconfig.scripts.json (cli/**, tools/**).
    files: [
      'packages/extension/src/**/*.ts',
      'packages/extension/cli/**/*.ts',
      'packages/extension/tools/**/*.ts',
    ],
    languageOptions: {
      parserOptions: {
        project: [
          './packages/extension/tsconfig.test.json',
          './packages/extension/tsconfig.scripts.json',
          // The smoke suite runs under mocha, so it is typed by a project of
          // its own; without it here, type-aware rules cannot read those files.
          './packages/extension/tsconfig.smoke.json',
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
  {
    // Webview: react-hooks (same two rules as the legacy config).
    files: ['packages/webview/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    /* Accessibility of the markup itself: a label that names nothing, a click
       handler on a div no keyboard reaches, an image with no alternative. They
       are warnings, not errors: the panel is not clean yet, and a gate that
       fails on the first run is a gate somebody turns off. The count is in
       CONTRIBUTING.md — bring it down, and make these errors once it is zero. */
    files: ['packages/webview/src/**/*.tsx'],
    plugins: { 'jsx-a11y': jsxA11y },
    rules: {
      ...Object.fromEntries(
        Object.entries(jsxA11y.flatConfigs.recommended.rules).map(([rule]) => [rule, 'warn']),
      ),
      // Deprecated by the plugin itself, and still in its recommended set.
      // label-has-associated-control, which is on above, is what replaced it.
      'jsx-a11y/label-has-for': 'off',
    },
  },
  {
    // Token gate — hardcoded `var(--vscode-*)` in string literals / template
    // literals is forbidden in src/**. Consume the design system instead:
    // Tailwind token classes (bg-surface-*, text-text-*, border-subtle...) or
    // var(--sf-*) arbitrary values (see src/styles/design-system.css).
    // Scoped via files so e2e/ and config files stay out of scope.
    files: ['packages/webview/src/**/*.ts', 'packages/webview/src/**/*.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/var\\(--vscode-/]',
          message: VSCODE_VAR_MSG,
        },
        {
          selector: 'TemplateElement[value.raw=/var\\(--vscode-/]',
          message: VSCODE_VAR_MSG,
        },
        ...PALETTE_400_SELECTORS,
      ],
    },
  },
  {
    // By design: design-system primitives and token definitions own the raw
    // VSCode variable mapping (single source of truth). The palette gate still
    // applies to them: a primitive is rendered on light themes too.
    files: [
      'packages/webview/src/components/ui/**/*',
      'packages/webview/src/styles/**/*',
      'packages/webview/src/theme/**/*',
    ],
    rules: { 'no-restricted-syntax': ['error', ...PALETTE_400_SELECTORS] },
  },
);
