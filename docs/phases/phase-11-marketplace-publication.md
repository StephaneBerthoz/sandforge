# Phase 11 — Marketplace Publication

> **Status:** IN PROGRESS (package preparation done as of 2026-03-13)

## Objectifs

Preparer et publier SandForge sur le Visual Studio Code Marketplace. Optimisation du package, documentation utilisateur, branding et processus de release.

## Avancement (2026-03-13)

### Preparation du package — DONE

- `package.json` (extension) — All Marketplace fields complete:
  - `displayName`, `description` (i18n via `package.nls.json`)
  - `categories`: Other, Data Science, Testing, Snippets
  - `keywords`: 15 keywords (salesforce, sfdc, sfdx, devops, etl, sandbox, etc.)
  - `icon`: `resources/icon.png` (256x256)
  - `galleryBanner`: dark theme (#1E1E2E)
  - `repository`, `bugs`, `homepage`: all set
  - `engines.vscode`: ^1.95.0
  - `publisher`: StephaneBerthoz
- `.vscodeignore` — Fully optimized:
  - Excludes source files, tests, config files, build intermediates
  - Excludes source maps, type declarations
  - Excludes unnecessary dist subdirectories (esbuild bundles to single file)
  - Excludes dev tooling (.claude/, .serena/, .vscode/)
  - **Result: VSIX size = 1.07 MB** (well under the 10 MB target)
- `LICENSE` — MIT license present

## Fichiers restants a creer / modifier

### Assets visuels

- `assets/icon.png` — Icone 256x256 pour le Marketplace
- `assets/banner.png` — Banniere pour la page Marketplace
- `assets/screenshots/` — Screenshots de chaque module :
  - `home.png` — Dashboard principal
  - `seed.png` — Module Seed en action
  - `sync.png` — Module Sync avec FieldMapper
  - `monitor.png` — Dashboard Monitor
  - `compare.png` — Comparaison d'orgs
  - `dataops.png` — Operations DataOps
  - `automation.png` — Pipeline visuel
  - `ai.png` — Chat IA
  - `autopilot.png` — Mode Autopilot

### Documentation utilisateur

- `docs/getting-started.md` — Guide de demarrage rapide
- `docs/connection-guide.md` — Guide de connexion Salesforce
- `docs/module-guides/` — Guide par module (seed, sync, monitor, compare, dataops, automation)
- `docs/faq.md` — Questions frequentes
- `docs/troubleshooting.md` — Guide de depannage

### Release process

- `.github/workflows/release.yml` — Workflow de release automatise :
  - Bump de version (patch/minor/major)
  - Mise a jour du CHANGELOG
  - Build + tests + package
  - Publication sur le Marketplace via `vsce publish`
  - Creation de la release GitHub avec .vsix
- `.github/workflows/ci.yml` — Workflow CI (PR checks) :
  - Typecheck, lint, tests, build
  - Verification taille du .vsix (< 10MB)
  - Verification des traductions (cles manquantes)
- `scripts/bump-version.sh` — Script de bump de version synchronise (3 packages)
- `scripts/pre-publish-check.sh` — Verifications pre-publication

### Qualite pre-publication

- Verification que toutes les commandes sont documentees
- Verification des `when` clauses dans le `package.json`
- Test d'installation clean (nouveau VSCode, aucune extension)
- Test sur les 3 OS (Windows, macOS, Linux)
- Performance : temps de chargement de l'extension < 2s
- Taille du .vsix optimisee (< 5MB cible)

## Criteres de validation

- [x] .vsix genere avec `pnpm package` < 10MB (1.07 MB achieved)
- [x] Icone conforme aux specifications Marketplace (256x256 PNG)
- [x] Licence choisie et fichier LICENSE present (MIT)
- [x] README.md Marketplace attractif avec badges et feature list
- [x] Metadata package.json complete (categories, keywords, galleryBanner, repository)
- [x] .vscodeignore optimise (exclusion source, tests, maps, dev tooling)
- [ ] Banniere et au moins 5 screenshots de qualite
- [ ] Documentation utilisateur complete (getting started + 1 guide par module)
- [ ] Workflow CI passe sur les 3 OS
- [ ] Workflow release publie automatiquement sur le Marketplace
- [ ] Extension testee sur VSCode stable + insiders
