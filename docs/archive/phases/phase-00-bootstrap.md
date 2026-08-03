# Phase 00 — Bootstrap

> **Status:** COMPLETED

## Objectifs

Mettre en place le monorepo pnpm, la configuration TypeScript, le build system et les fondations du projet SandForge.

## Fichiers crees

### Racine

- `package.json` — Workspace root avec scripts globaux
- `pnpm-workspace.yaml` — Declaration des packages
- `tsconfig.json` — Config TypeScript racine
- `.eslintrc.json` — ESLint config partagee
- `.prettierrc` — Prettier config
- `esbuild.config.mjs` — Build config extension
- `CHANGELOG.md` — Journal des changements
- `CLAUDE.md` — Instructions projet pour Claude Code

### packages/shared

- `package.json` — Package types/schemas/utils partages
- `tsconfig.json` — Config TypeScript shared
- `src/index.ts` — Point d'entree barrel exports

### packages/extension

- `package.json` — Extension VSCode (manifest, contributes, activationEvents)
- `tsconfig.json` — Config TypeScript extension
- `src/extension.ts` — Point d'entree activation/deactivation
- `src/logger.ts` — Logger Winston

### packages/webview

- `package.json` — Application React
- `tsconfig.json` — Config TypeScript webview
- `vite.config.ts` — Config Vite
- `tailwind.config.ts` — Config Tailwind CSS
- `src/main.tsx` — Point d'entree React
- `src/App.tsx` — Composant racine
- `src/index.css` — Styles globaux Tailwind

## Criteres de validation

- [x] `pnpm install` sans erreur
- [x] `pnpm typecheck` passe sur les 3 packages
- [x] `pnpm build` genere les bundles extension + webview
- [x] Structure monorepo fonctionnelle avec references croisees
- [x] Extension charge dans VSCode en mode dev
