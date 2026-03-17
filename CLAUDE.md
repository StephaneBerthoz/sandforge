# CLAUDE.md — SandForge 🔥

> **Ce fichier est lu en priorité par Claude Code. Il contient les instructions maîtresses du projet.**

## Identité du projet

**SandForge** — "Forge your Salesforce sandboxes"
Extension VSCode ETL tout-en-un pour les sandboxes Salesforce.
Package : `sandforge` | Publisher : `sandforge`
6 modules : Seed (IA), Sync (ETL), Monitor, Compare Org, DataOps, Automation.
UI 100% WebView React — ZERO Command Palette.

## Architecture

Monorepo pnpm avec 3 packages :
- `packages/shared` — Types TypeScript, Zod schemas, constantes, utils
- `packages/extension` — Extension VSCode (Node.js, esbuild)
- `packages/webview` — Application React (Vite, Tailwind, Shadcn/ui)

## Règles absolues

1. **TypeScript strict** — Aucun `any`, `noImplicitReturns`, `noUnusedLocals`
2. **Aucun TODO/FIXME** — Tout code livré est complet et fonctionnel
3. **Tests obligatoires** — Chaque fichier `.ts` a un `.test.ts` associé (même dossier)
4. **Build toujours vert** — Ne jamais passer à un nouveau fichier si le build est cassé
5. **i18n from day 1** — Tout texte visible utilise `t('key')`, jamais de string hardcodée
6. **Zod pour toute donnée externe** — Toute config, tout message, tout input est validé par Zod
7. **JSDoc sur toute interface/méthode publique**
8. **Pas de `console.log`** — Utiliser le logger Winston

## Boucle de travail

```
Pour chaque fichier :
1. Créer le fichier complet (pas de squelette)
2. Créer le fichier test associé
3. pnpm typecheck → fix si erreurs
4. pnpm lint:fix → fix si warnings/erreurs
5. pnpm test → fix si échecs
6. Toutes les 5 fichiers : pnpm build → fix si cassé
7. Avant chaque commit : pnpm validate (typecheck + lint + test + build)
```

## Commandes

```bash
pnpm install                    # Setup
pnpm typecheck                  # tsc --noEmit sur tous les packages
pnpm lint                       # eslint
pnpm lint:fix                   # eslint --fix
pnpm test                       # vitest run
pnpm build                      # Build tous les packages
pnpm validate                   # typecheck + lint + test + build
pnpm package                    # Génère le .vsix
```

## Conventions de nommage

- Fichiers : PascalCase pour classes/composants, camelCase pour utils/hooks
- Types/Interfaces : PascalCase, suffixe descriptif (pas de I-prefix)
- Tests : `MonFichier.test.ts` dans le même dossier
- Composants React : `.tsx`, functional components uniquement, hooks
- Stores Zustand : `use[Name]Store.ts`

## Ordre de développement

Suivre les phases dans `docs/phases/` dans l'ordre numérique.
Chaque phase a un fichier `phase-XX.md` avec les objectifs, fichiers à créer et critères de validation.

## Dépendances Salesforce

- jsforce v2 pour toutes les API SF
- Bulk API 2.0 pour > 200 records
- Composite API pour les records liés parent/enfant
- Toujours vérifier les permissions (CRUD + FLS) avant chaque opération
- Respecter les Governor Limits (monitorer via headers `Sforce-Limit-Info`)

## WebView ↔ Extension

Communication via `vscode.postMessage()` / `webview.onDidReceiveMessage()`.
Tous les messages sont typés dans `packages/shared/src/types/messages.types.ts`.
Utiliser le `MessageBroker` pour router les messages.

## Structure d'un module

Chaque module suit le même pattern :
```
modules/[name]/
├── [Name]Orchestrator.ts      # Point d'entrée, orchestre les sous-services
├── [SubService].ts            # Services spécialisés
├── [Name]GrappeAdapter.ts     # Adapter pour le mode grappe
└── *.test.ts                  # Tests pour chaque fichier
```

Côté WebView :
```
pages/[Name]/
├── [Name]Page.tsx             # Page principale du module
├── [Name]Wizard/              # Wizard multi-step (si applicable)
│   ├── [Name]Wizard.tsx
│   └── Step[N]_[Name].tsx
├── [SubView].tsx              # Vues spécialisées
└── *.test.tsx                 # Tests composants
```
