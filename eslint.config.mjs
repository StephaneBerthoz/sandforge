import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';

/** Message shared by both token-gate selectors (webview design-system rule). */
const VSCODE_VAR_MSG =
  'Hardcoded var(--vscode-*) is forbidden outside the design system. Use token classes (bg-surface-*, text-text-*, border-subtle) or var(--sf-*) — see src/styles/design-system.css.';

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
    files: ['packages/*/src/**/*.{ts,tsx}'],
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
    // is covered by tsconfig.test.json (include: src/**/*).
    files: ['packages/extension/src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: './packages/extension/tsconfig.test.json',
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
      ],
    },
  },
  {
    // By design: design-system primitives and token definitions own the raw
    // VSCode variable mapping (single source of truth).
    files: [
      'packages/webview/src/components/ui/**/*',
      'packages/webview/src/styles/**/*',
      'packages/webview/src/theme/**/*',
    ],
    rules: { 'no-restricted-syntax': 'off' },
  },
);
