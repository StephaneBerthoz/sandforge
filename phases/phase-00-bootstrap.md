# Phase 00 — Bootstrap du Monorepo

## Objectif

Créer toute la structure du monorepo, installer les dépendances, et vérifier que `pnpm build` fonctionne sur un projet vide.

## Étapes

### 1. Créer le fichier `pnpm-workspace.yaml`

```yaml
packages:
  - "packages/*"
```

### 2. Créer le `package.json` racine

```json
{
  "name": "sandforge",
  "version": "0.1.0",
  "private": true,
  "description": "Salesforce Sandbox ETL Toolkit for VSCode",
  "scripts": {
    "build": "pnpm --filter shared build && pnpm --filter extension build && pnpm --filter webview build",
    "build:shared": "pnpm --filter shared build",
    "build:extension": "pnpm --filter extension build",
    "build:webview": "pnpm --filter webview build",
    "typecheck": "pnpm -r typecheck",
    "lint": "pnpm -r lint",
    "lint:fix": "pnpm -r lint:fix",
    "format": "prettier --write \"packages/*/src/**/*.{ts,tsx,json,css}\"",
    "format:check": "prettier --check \"packages/*/src/**/*.{ts,tsx,json,css}\"",
    "test": "pnpm -r test",
    "test:coverage": "pnpm -r test:coverage",
    "validate": "pnpm typecheck && pnpm lint && pnpm test && pnpm build",
    "package": "cd packages/extension && npx @vscode/vsce package --no-dependencies -o ../../sandforge.vsix",
    "clean": "pnpm -r clean && rm -rf node_modules"
  },
  "devDependencies": {
    "prettier": "^3.2",
    "typescript": "~5.5"
  },
  "engines": {
    "node": ">=20",
    "pnpm": ">=9"
  }
}
```

### 3. Créer `tsconfig.base.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "lib": ["ES2022"],
    "strict": true,
    "noImplicitAny": true,
    "noImplicitReturns": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "forceConsistentCasingInFileNames": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "resolveJsonModule": true,
    "isolatedModules": true
  }
}
```

### 4. Créer `.prettierrc`

```json
{
  "semi": true,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2,
  "arrowParens": "always"
}
```

### 5. Créer `.eslintrc.json`

```json
{
  "root": true,
  "parser": "@typescript-eslint/parser",
  "plugins": ["@typescript-eslint"],
  "extends": [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "prettier"
  ],
  "rules": {
    "no-console": "warn",
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_" }],
    "prefer-const": "error"
  },
  "ignorePatterns": ["dist/", "out/", "node_modules/", "*.js"]
}
```

### 6. Créer `packages/shared/package.json`

```json
{
  "name": "@sandforge/shared",
  "version": "0.1.0",
  "private": true,
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src/ --ext .ts",
    "lint:fix": "eslint src/ --ext .ts --fix",
    "test": "vitest run",
    "test:coverage": "vitest run --coverage",
    "test:watch": "vitest",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "zod": "^3.23"
  },
  "devDependencies": {
    "@typescript-eslint/eslint-plugin": "^7",
    "@typescript-eslint/parser": "^7",
    "eslint": "^8",
    "eslint-config-prettier": "^9",
    "typescript": "~5.5",
    "vitest": "^1"
  }
}
```

### 7. Créer `packages/shared/tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"]
}
```

### 8. Créer `packages/shared/vitest.config.ts`

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/index.ts'],
      thresholds: {
        global: {
          branches: 80,
          functions: 80,
          lines: 80,
          statements: 80,
        },
      },
    },
  },
});
```

### 9. Créer `packages/shared/src/index.ts`

```typescript
// Barrel exports — will grow as types are added
export * from './types/common.types';
```

### 10. Créer le premier fichier shared pour vérifier le build

`packages/shared/src/types/common.types.ts` :

```typescript
/** Unique identifier string (UUID v4) */
export type UUID = string;

/** ISO 8601 date string */
export type ISODateString = string;

/** Salesforce 15 or 18 character ID */
export type SalesforceId = string;

/** Salesforce API name (e.g., 'Account', 'Custom__c') */
export type ApiName = string;

/** Result of any operation */
export interface OperationResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: OperationError;
  warnings: string[];
  duration: number;
  timestamp: ISODateString;
}

/** Structured error */
export interface OperationError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  retryable: boolean;
  category: ErrorCategory;
}

/** Error categories for classification */
export type ErrorCategory =
  | 'auth'
  | 'permission'
  | 'schema'
  | 'data'
  | 'validation'
  | 'limit'
  | 'network'
  | 'trigger'
  | 'reference'
  | 'unknown';

/** Pagination */
export interface PaginatedResult<T> {
  items: T[];
  totalCount: number;
  hasMore: boolean;
  nextCursor?: string;
}

/** Key-value pair */
export interface KeyValue<V = string> {
  key: string;
  value: V;
}

/** Date range */
export interface DateRange {
  start: ISODateString;
  end: ISODateString;
}
```

`packages/shared/src/types/common.types.test.ts` :

```typescript
import { describe, it, expect } from 'vitest';
import type { OperationResult, OperationError } from './common.types';

describe('common.types', () => {
  it('should allow creating a successful OperationResult', () => {
    const result: OperationResult<string> = {
      success: true,
      data: 'test',
      warnings: [],
      duration: 100,
      timestamp: new Date().toISOString(),
    };
    expect(result.success).toBe(true);
    expect(result.data).toBe('test');
  });

  it('should allow creating a failed OperationResult', () => {
    const error: OperationError = {
      code: 'INVALID_FIELD',
      message: 'Field not found',
      retryable: false,
      category: 'schema',
    };
    const result: OperationResult = {
      success: false,
      error,
      warnings: [],
      duration: 50,
      timestamp: new Date().toISOString(),
    };
    expect(result.success).toBe(false);
    expect(result.error?.retryable).toBe(false);
  });
});
```

### 11. Créer `packages/extension/package.json`

```json
{
  "name": "sandforge",
  "displayName": "SandForge — Salesforce Sandbox ETL",
  "description": "All-in-one Salesforce Sandbox ETL: Seed, Sync, Monitor, Compare, DataOps, Automation",
  "version": "0.1.0",
  "publisher": "sandforge",
  "license": "MIT",
  "engines": {
    "vscode": "^1.95.0"
  },
  "categories": ["Other", "Data Science", "Testing"],
  "keywords": ["salesforce", "sandbox", "etl", "seed", "sync", "monitoring", "data"],
  "activationEvents": [
    "onView:sandforge.sidebar"
  ],
  "main": "./dist/extension.js",
  "contributes": {
    "viewsContainers": {
      "activitybar": [
        {
          "id": "sandforge",
          "title": "SandForge",
          "icon": "resources/icons/toolkit.svg"
        }
      ]
    },
    "views": {
      "sandforge": [
        {
          "id": "sandforge.sidebar",
          "name": "SandForge",
          "type": "webview"
        }
      ]
    },
    "configuration": {
      "title": "SandForge",
      "properties": {
        "sandforge.language": {
          "type": "string",
          "default": "auto",
          "enum": ["auto", "en", "fr", "de", "es", "ja", "pt-BR"],
          "description": "Display language"
        },
        "sandforge.telemetry": {
          "type": "boolean",
          "default": false,
          "description": "Enable anonymous usage telemetry"
        }
      }
    }
  },
  "scripts": {
    "build": "esbuild ./src/extension.ts --bundle --outfile=dist/extension.js --external:vscode --external:better-sqlite3 --format=cjs --platform=node --sourcemap",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src/ --ext .ts",
    "lint:fix": "eslint src/ --ext .ts --fix",
    "test": "vitest run",
    "test:coverage": "vitest run --coverage",
    "test:watch": "vitest",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@sandforge/shared": "workspace:*",
    "jsforce": "^2",
    "better-sqlite3": "^11",
    "winston": "^3",
    "glob": "^10"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7",
    "@types/glob": "^8",
    "@types/vscode": "^1.95",
    "@typescript-eslint/eslint-plugin": "^7",
    "@typescript-eslint/parser": "^7",
    "@vscode/vsce": "^3",
    "esbuild": "^0.21",
    "eslint": "^8",
    "eslint-config-prettier": "^9",
    "typescript": "~5.5",
    "vitest": "^1"
  }
}
```

### 12. Créer `packages/extension/tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "types": ["node"]
  },
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts"]
}
```

### 13. Créer `packages/extension/src/extension.ts` (squelette fonctionnel)

```typescript
import * as vscode from 'vscode';

/**
 * Called when the extension is activated.
 * Activation is triggered by the sidebar view being opened.
 */
export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel('SandForge');
  outputChannel.appendLine('SandForge is now active.');

  // TODO: Phase 2+ will register providers here
  // - SidebarProvider (TreeView or WebView)
  // - StatusBarProvider
  // - WebviewPanelManager

  context.subscriptions.push(outputChannel);
}

/**
 * Called when the extension is deactivated.
 */
export function deactivate(): void {
  // Cleanup: close connections, stop monitors, save state
}
```

### 14. Créer `packages/webview/package.json`

```json
{
  "name": "@sandforge/webview",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src/ --ext .ts,.tsx",
    "lint:fix": "eslint src/ --ext .ts,.tsx --fix",
    "test": "vitest run",
    "test:coverage": "vitest run --coverage",
    "test:watch": "vitest",
    "preview": "vite preview",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@sandforge/shared": "workspace:*",
    "react": "^18.3",
    "react-dom": "^18.3",
    "zustand": "^4",
    "react-i18next": "^14",
    "i18next": "^23",
    "framer-motion": "^11",
    "recharts": "^2.12",
    "reactflow": "^11",
    "@tanstack/react-table": "^8",
    "@tanstack/react-query": "^5",
    "@radix-ui/react-dialog": "^1",
    "@radix-ui/react-popover": "^1",
    "@radix-ui/react-select": "^2",
    "@radix-ui/react-tabs": "^1",
    "@radix-ui/react-tooltip": "^1",
    "@radix-ui/react-accordion": "^1",
    "@radix-ui/react-switch": "^1",
    "@radix-ui/react-checkbox": "^1",
    "@radix-ui/react-slider": "^1",
    "lucide-react": "^0.376",
    "tailwind-merge": "^2",
    "clsx": "^2",
    "react-hook-form": "^7",
    "@hookform/resolvers": "^3",
    "zod": "^3.23",
    "papaparse": "^5",
    "date-fns": "^3",
    "@monaco-editor/react": "^4",
    "d3": "^7"
  },
  "devDependencies": {
    "@types/react": "^18",
    "@types/react-dom": "^18",
    "@types/d3": "^7",
    "@types/papaparse": "^5",
    "@vitejs/plugin-react": "^4",
    "vite": "^5",
    "tailwindcss": "^3",
    "postcss": "^8",
    "autoprefixer": "^10",
    "typescript": "~5.5",
    "vitest": "^1",
    "jsdom": "^24",
    "@testing-library/react": "^15",
    "@testing-library/jest-dom": "^6",
    "@typescript-eslint/eslint-plugin": "^7",
    "@typescript-eslint/parser": "^7",
    "eslint": "^8",
    "eslint-config-prettier": "^9",
    "eslint-plugin-react-hooks": "^4"
  }
}
```

### 15. Créer les configs WebView

`packages/webview/tsconfig.json` :
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "outDir": "./dist",
    "rootDir": "./src",
    "types": ["node"]
  },
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts", "src/**/*.test.tsx"]
}
```

`packages/webview/vite.config.ts` :
```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]',
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
```

`packages/webview/tailwind.config.ts` :
```typescript
import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}', './index.html'],
  theme: {
    extend: {
      colors: {
        // SandForge brand
        sandforge: { DEFAULT: '#F59E0B', light: '#FEF3C7', dark: '#92400E' },
        // Module accents
        seed: { DEFAULT: '#10B981', light: '#D1FAE5', dark: '#065F46' },
        sync: { DEFAULT: '#3B82F6', light: '#DBEAFE', dark: '#1E40AF' },
        monitor: { DEFAULT: '#F59E0B', light: '#FEF3C7', dark: '#92400E' },
        compare: { DEFAULT: '#8B5CF6', light: '#EDE9FE', dark: '#5B21B6' },
        dataops: { DEFAULT: '#EF4444', light: '#FEE2E2', dark: '#991B1B' },
        automation: { DEFAULT: '#F97316', light: '#FFEDD5', dark: '#9A3412' },
      },
    },
  },
  plugins: [],
};

export default config;
```

`packages/webview/postcss.config.js` :
```javascript
module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
```

`packages/webview/index.html` :
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>SandForge</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`packages/webview/src/main.tsx` :
```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './index.css';

const root = document.getElementById('root');
if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
```

`packages/webview/src/App.tsx` :
```tsx
import React from 'react';

export const App: React.FC = () => {
  return (
    <div className="min-h-screen bg-[var(--vscode-editor-background,#1e1e1e)] text-[var(--vscode-editor-foreground,#d4d4d4)]">
      <div className="flex items-center justify-center h-screen">
        <div className="text-center">
          <h1 className="text-2xl font-bold mb-2">🔥 SandForge</h1>
          <p className="text-sm opacity-70">Forge your Salesforce sandboxes</p>
        </div>
      </div>
    </div>
  );
};
```

`packages/webview/src/index.css` :
```css
@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 13px;
  line-height: 1.5;
}

body {
  margin: 0;
  padding: 0;
  background: var(--vscode-editor-background, #1e1e1e);
  color: var(--vscode-editor-foreground, #d4d4d4);
}
```

### 16. Créer l'icône placeholder

`resources/icons/toolkit.svg` :
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M12 2L2 7l10 5 10-5-10-5z"/>
  <path d="M2 17l10 5 10-5"/>
  <path d="M2 12l10 5 10-5"/>
</svg>
```

### 17. Créer `DECISIONS.md`

```markdown
# Decisions Log

Ce fichier documente toutes les décisions techniques prises pendant le développement.

## Format

### [DATE] — Titre de la décision

**Contexte** : Pourquoi cette décision a été nécessaire
**Décision** : Ce qui a été choisi
**Alternatives** : Ce qui a été considéré et rejeté
**Conséquences** : Impact de la décision

---

### Phase 0 — Bootstrap

**Contexte** : Choix du bundler pour l'extension
**Décision** : esbuild (pas webpack)
**Alternatives** : webpack 5 (plus lent, plus de config)
**Conséquences** : Build < 1s, config minimale, tree-shaking efficace
```

### 18. Validation de la Phase 0

```bash
# Exécuter dans cet ordre :
pnpm install
pnpm build:shared    # ✅ Doit compiler sans erreur
pnpm test            # ✅ Le test common.types.test.ts doit passer
pnpm build:extension # ✅ Doit produire dist/extension.js
pnpm build:webview   # ✅ Doit produire dist/
pnpm typecheck       # ✅ 0 erreurs
pnpm lint            # ✅ 0 erreurs

# Si tout est vert → Phase 0 terminée ✅
```
