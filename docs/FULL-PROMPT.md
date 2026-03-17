# 🔥 PROMPT ULTIME v3 — SandForge
# Extension VSCode ETL pour Salesforce — Full Autonomous Agent Build

> **Version** : 3.0 — Autonomous Agent Edition
> **Target** : Claude Code en mode agent autonome maximum
> **Objectif** : Développer une extension VSCode complète, testée, buildable et packageable, de manière 100% autonome.

## 🔥 BRANDING

```
Nom          : SandForge
Package      : sandforge
Publisher    : sandforge
Tagline      : "Forge your Salesforce sandboxes"
Description  : All-in-one Salesforce Sandbox ETL — Seed, Sync, Monitor, Compare, DataOps, Automation

Palette :
  Primary    : #F59E0B (Amber)
  Secondary  : #1E293B (Slate Dark)
  Success    : #10B981 (Emerald)
  Warning    : #F97316 (Orange)
  Danger     : #EF4444 (Red)
  Info       : #3B82F6 (Blue)

Module Colors :
  Seed       : #10B981 (Emerald)
  Sync       : #3B82F6 (Blue)
  Monitor    : #F59E0B (Amber)
  Compare    : #8B5CF6 (Violet)
  DataOps    : #EF4444 (Red)
  Automation : #F97316 (Orange)

Logo         : Enclume minimaliste avec particules de sable/étincelles
Icon style   : Lucide icons, consistent 24px, stroke-width 2
```

---

## ⚡ INSTRUCTIONS AGENT AUTONOME (CLAUDE CODE)

### Comportement attendu

Tu opères en mode **agent autonome maximum**. Tu dois :

1. **Développer de manière continue** — Pas de pause, pas de question. Si un choix technique est à faire, prends la meilleure décision et documente-la dans un `DECISIONS.md`.
2. **Tester systématiquement** — Après chaque fichier ou module, lance les tests. Si un test échoue, corrige immédiatement et re-teste en boucle jusqu'à ce que ça passe.
3. **Builder en continu** — Après chaque phase, lance le build complet. Si le build casse, corrige et rebuild.
4. **Auto-valider** — Utilise les linters, type-checkers, et tests comme boucle de feedback.
5. **Ne jamais laisser le projet dans un état cassé** — Chaque commit logique doit compiler et passer les tests.
6. **Documenter au fil de l'eau** — JSDoc, README, CHANGELOG.

### Boucle de développement autonome

```
Pour chaque module/fichier :
┌──────────────────────────────────────────────┐
│  1. Créer/modifier le fichier                │
│  2. Vérifier la syntaxe TypeScript (tsc)     │
│  3. Linter (eslint --fix)                    │
│  4. Formater (prettier --write)              │
│  5. Lancer les tests unitaires associés      │
│  6. Si test fail → corriger → retour en 2    │
│  7. Si test pass → passer au fichier suivant │
│  8. Après N fichiers → build global          │
│  9. Si build fail → corriger → retour en 2   │
│  10. Build OK → checkpoint ✅                │
└──────────────────────────────────────────────┘
```

### Commandes à utiliser

```bash
# Setup initial (à exécuter UNE FOIS au début)
pnpm install
pnpm build          # Build complet

# Boucle de dev (à exécuter SOUVENT)
pnpm typecheck      # tsc --noEmit
pnpm lint           # eslint
pnpm lint:fix       # eslint --fix
pnpm format         # prettier --write
pnpm test           # vitest run
pnpm test:watch     # vitest (en mode interactif si besoin de debug)
pnpm test:coverage  # vitest --coverage

# Build complet (à chaque fin de phase)
pnpm build
pnpm test
pnpm package        # vsce package

# Vérification finale
pnpm validate       # typecheck + lint + test + build en séquence
```

### Structure de scripts `package.json` (root)

```json
{
  "scripts": {
    "build": "pnpm -r build",
    "build:extension": "pnpm --filter extension build",
    "build:webview": "pnpm --filter webview build",
    "build:shared": "pnpm --filter shared build",
    "typecheck": "pnpm -r typecheck",
    "lint": "pnpm -r lint",
    "lint:fix": "pnpm -r lint:fix",
    "format": "prettier --write \"packages/*/src/**/*.{ts,tsx,json,css}\"",
    "format:check": "prettier --check \"packages/*/src/**/*.{ts,tsx,json,css}\"",
    "test": "pnpm -r test",
    "test:coverage": "pnpm -r test:coverage",
    "test:watch": "pnpm -r test:watch",
    "validate": "pnpm typecheck && pnpm lint && pnpm test && pnpm build",
    "package": "cd packages/extension && vsce package --no-dependencies",
    "clean": "pnpm -r clean && rm -rf node_modules",
    "dev": "pnpm --filter webview dev"
  }
}
```

### Règles de qualité (Quality Gates)

```yaml
TypeScript:
  strict: true
  noAny: true                    # Aucun 'any' autorisé
  noImplicitReturns: true
  noUnusedLocals: true
  noUnusedParameters: true

ESLint:
  extends: ["@typescript-eslint/recommended", "prettier"]
  rules:
    no-console: warn              # Utiliser le logger
    no-explicit-any: error
    prefer-const: error
    no-unused-vars: error

Tests:
  framework: vitest
  coverage_threshold:
    global: 80%                   # Minimum 80% coverage
    core_engine: 90%              # Core engine : 90%
    utils: 100%                   # Utils/helpers : 100%
  naming: "*.test.ts" ou "*.spec.ts"
  location: côte-à-côte (même dossier que le fichier source)

Build:
  zero_warnings: true             # Aucun warning au build
  bundle_size_limit: 5MB          # Extension bundle < 5MB
  webview_bundle_limit: 2MB       # WebView bundle < 2MB
```

### Checkpoints de validation par phase

Après chaque phase, vérifier :
```bash
✅ pnpm typecheck    → 0 errors
✅ pnpm lint         → 0 errors, 0 warnings  
✅ pnpm test         → All passing, coverage >= threshold
✅ pnpm build        → Success, no warnings
✅ pnpm package      → .vsix generated successfully
```

Si un checkpoint échoue, **NE PAS passer à la phase suivante**. Corriger d'abord.

### Gestion des dépendances npm

```bash
# Installer exactement ces versions (pinned)
# Extension
cd packages/extension
pnpm add jsforce@2 better-sqlite3 winston glob
pnpm add -D @types/better-sqlite3 @types/glob vitest esbuild @vscode/vsce

# Shared
cd packages/shared
pnpm add zod
pnpm add -D vitest typescript

# WebView  
cd packages/webview
pnpm add react react-dom @tanstack/react-table @tanstack/react-query zustand react-i18next i18next framer-motion recharts reactflow @radix-ui/react-dialog @radix-ui/react-popover @radix-ui/react-select @radix-ui/react-tabs @radix-ui/react-tooltip @radix-ui/react-accordion @radix-ui/react-switch @radix-ui/react-checkbox @radix-ui/react-slider lucide-react tailwind-merge clsx react-hook-form @hookform/resolvers monaco-editor @monaco-editor/react d3 papaparse
pnpm add -D @types/react @types/react-dom @types/d3 @types/papaparse vite @vitejs/plugin-react tailwindcss postcss autoprefixer vitest @testing-library/react @testing-library/jest-dom jsdom
```

### Mode de travail fichier par fichier

Pour chaque fichier créé :
1. Créer le fichier avec le contenu complet (pas de placeholder, pas de `// TODO`)
2. Créer le fichier test associé (`MonFichier.test.ts`) dans le même répertoire
3. Lancer `pnpm test -- --filter=MonFichier` pour vérifier
4. Fix si nécessaire
5. Passer au suivant

**INTERDICTION ABSOLUE** : 
- Laisser des `// TODO` ou `// FIXME` sans les traiter
- Laisser des `any` dans le code
- Créer des fichiers vides ou squelettes
- Passer à la phase suivante si le build est cassé
- Ignorer des erreurs TypeScript

---

## TABLE DES MATIÈRES ÉTENDUE

1. [Vision & Inspirations](#1)
2. [Stack Technique](#2)
3. [Architecture Monorepo](#3)
4. [Core Engine](#4)
5. [Mode Grappe (Cluster Processing)](#5)
6. [Module SEED](#6)
7. [Module SYNC (ETL)](#7)
8. [Module MONITORING](#8)
9. [Module COMPARE ORG](#9)
10. [Module DATA OPS](#10)
11. [Module AUTOMATION](#11)
12. [Système de Pre-Check](#12)
13. [Reporting & Analytics](#13)
14. [UI/UX Design System](#14)
15. [Sécurité & Compliance](#15)
16. [Internationalisation](#16)
17. [Scalabilité & Performance](#17)
18. [Extensibilité & Plugins](#18)
19. [CLI Mode (CI/CD)](#19)
20. [Offline & Resilience](#20)
21. [Migration depuis autres outils](#21)
22. [Settings & Configuration](#22)
23. [Collaboration & Team](#23)
24. [Standards Salesforce](#24)
25. [Plan de développement par phases](#25)
26. [Communication Protocol](#26)

---

## 1. VISION & INSPIRATIONS

**"SandForge"** (`sandforge`) — Le couteau suisse ultime pour les sandboxes Salesforce, directement dans VSCode.

### Inspirations du marché

| Outil | Features empruntées |
|---|---|
| **SFDMU** | Object Sets, migration scripts, CSV I/O, External ID management, Apex pré/post, polymorphic lookups, field mapping, add-on fields, excluded fields, value mapping, CSV values mapping |
| **Gearset** | Compare org avec diff, deployment builder, monitoring changes, snapshots, problem analyzers, dependency analysis, rollback deployments |
| **Copado** | Pipelines, environment management, compliance scanning, quality gates, user stories integration |
| **Prodly** | Data seeding templates, relation-aware deployment, sandbox refresh automation, data sets |
| **OwnBackup** | Backup scheduling, point-in-time restore, data masking, compare snapshots, sandbox seeding |
| **Talend** | Visual pipeline builder, 900+ transformations, data quality rules, lineage, profiling |
| **Informatica** | Mapping designer, data profiling, data quality scoring, metadata management |
| **Fivetran** | Schema drift detection, incremental sync, observability, connectors |
| **Airbyte** | Custom connectors API, CDC replication, normalized schemas |
| **dbt** | Transformation-as-code, lineage DAG, test framework, documentation |
| **Apache NiFi** | Flow-based programming, back-pressure, prioritized queuing |
| **Grafana** | Dashboard layout, alerting, multi-source monitoring |

### 6 Modules + Core

```
┌─────────────────────────────────────────────────┐
│                   SandForge             │
├─────────────────────────────────────────────────┤
│  🌱 SEED    │  🔄 SYNC    │  📊 MONITOR        │
│  🔍 COMPARE │  🛡️ DATAOPS │  ⚡ AUTOMATION      │
├─────────────────────────────────────────────────┤
│              CORE ENGINE                         │
│  Connection │ Metadata │ Execution │ Grappe     │
│  PreCheck   │ Reporting │ Security │ i18n       │
├─────────────────────────────────────────────────┤
│              UI SHELL (React WebView)            │
│  Sidebar │ TopBar │ StatusBar │ Notifications   │
└─────────────────────────────────────────────────┘
```

---

## 2. STACK TECHNIQUE

```yaml
Runtime:
  Node.js: ">=20"
  TypeScript: "~5.5" (strict mode)
  VSCode Engine: "^1.95.0"

Build:
  monorepo: pnpm workspaces
  extension_bundler: esbuild
  webview_bundler: vite 6
  shared_build: tsc

UI (WebView React):
  react: "^18.3"
  tailwindcss: "^4"
  shadcn_ui: latest (Radix primitives)
  framer-motion: "^11"
  recharts: "^2.12"
  d3: "^7" (graphes complexes, sankey, treemaps)
  reactflow: "^11" (DAG, pipelines, dependency graphs)
  tanstack-table: "^8" (tables virtualisées)
  tanstack-query: "^5" (data fetching/cache côté WebView)
  monaco-editor: "^0.47" (SOQL, JSON, Apex editors)
  zustand: "^4" (state management)
  react-hook-form: "^7" + zod (formulaires + validation)
  react-i18next: "^14" (multilingue)
  lucide-react: icons
  papaparse: CSV parsing
  date-fns: dates

Salesforce:
  jsforce: "^2"
  sf_cli: fallback
  APIs: Metadata v62+, Tooling, Bulk 2.0, REST, Composite, Composite Graph, Limits, Describe, Streaming, CDC

Storage:
  better-sqlite3: cache, historique, analytics, audit
  vscode_SecretStorage: credentials chiffrées
  JSON_files: templates, configs exportables

IA:
  anthropic_sdk: Claude API (claude-sonnet-4-5-20250514)
  faker-js: "^9" fallback

Observability:
  winston: logging structuré JSON
  
Testing:
  vitest: unit + integration
  testing-library_react: composants WebView
  nock: mock HTTP pour jsforce
  msw: mock Service Worker pour WebView

Quality:
  eslint: linting
  prettier: formatting
  typescript: type checking
  husky + lint-staged: pre-commit (optionnel)
```

---

## 3. ARCHITECTURE MONOREPO

```
sandforge/
├── pnpm-workspace.yaml
├── package.json                          # Root scripts
├── tsconfig.base.json                    # Config TS partagée
├── .eslintrc.json                        # ESLint partagé
├── .prettierrc                           # Prettier config
├── DECISIONS.md                          # Log des décisions techniques
├── CHANGELOG.md
├── README.md
│
├── packages/
│   ├── shared/                           # Types, schemas, utils partagés
│   │   ├── src/
│   │   │   ├── index.ts                  # Barrel export
│   │   │   ├── types/
│   │   │   │   ├── org.types.ts
│   │   │   │   ├── seed.types.ts
│   │   │   │   ├── sync.types.ts
│   │   │   │   ├── monitor.types.ts
│   │   │   │   ├── compare.types.ts
│   │   │   │   ├── dataops.types.ts
│   │   │   │   ├── automation.types.ts
│   │   │   │   ├── pipeline.types.ts
│   │   │   │   ├── grappe.types.ts       # Types du mode grappe
│   │   │   │   ├── reporting.types.ts
│   │   │   │   ├── messages.types.ts     # Protocol Extension ↔ WebView
│   │   │   │   ├── errors.types.ts
│   │   │   │   ├── precheck.types.ts
│   │   │   │   ├── settings.types.ts
│   │   │   │   └── common.types.ts
│   │   │   ├── schemas/                  # Zod validation schemas
│   │   │   │   ├── seed-config.schema.ts
│   │   │   │   ├── sync-config.schema.ts
│   │   │   │   ├── pipeline.schema.ts
│   │   │   │   ├── grappe.schema.ts
│   │   │   │   └── settings.schema.ts
│   │   │   ├── constants/
│   │   │   │   ├── sf-limits.ts          # Toutes les limites SF connues
│   │   │   │   ├── sf-standard-objects.ts
│   │   │   │   ├── sf-field-types.ts
│   │   │   │   ├── error-codes.ts        # Codes d'erreur SF mappés
│   │   │   │   └── defaults.ts
│   │   │   └── utils/
│   │   │       ├── sf-utils.ts
│   │   │       ├── string-utils.ts
│   │   │       ├── date-utils.ts
│   │   │       ├── format-utils.ts
│   │   │       ├── hash-utils.ts
│   │   │       └── validation-utils.ts
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── vitest.config.ts
│   │
│   ├── extension/                        # VSCode Extension (Node.js)
│   │   ├── src/
│   │   │   ├── extension.ts              # activate() / deactivate()
│   │   │   │
│   │   │   ├── core/
│   │   │   │   ├── connection/
│   │   │   │   │   ├── OrgManager.ts           # Gestion multi-org CRUD
│   │   │   │   │   ├── AuthProvider.ts         # OAuth, JWT, Username/Pwd
│   │   │   │   │   ├── ConnectionPool.ts       # Pool avec keep-alive
│   │   │   │   │   ├── OrgRegistry.ts          # Persistence des orgs (SQLite)
│   │   │   │   │   ├── OrgHealthProbe.ts       # Ping périodique
│   │   │   │   │   ├── SfdxBridge.ts           # Import orgs depuis SF CLI
│   │   │   │   │   ├── CircuitBreaker.ts       # Circuit breaker pattern
│   │   │   │   │   └── TokenRefresher.ts       # Auto-refresh tokens
│   │   │   │   │
│   │   │   │   ├── engine/
│   │   │   │   │   ├── DependencyResolver.ts   # Graphe de dépendances + tri topologique
│   │   │   │   │   ├── ExecutionPipeline.ts    # Pipeline step-by-step
│   │   │   │   │   ├── BatchProcessor.ts       # Batching REST/Composite
│   │   │   │   │   ├── BulkApiManager.ts       # Bulk API 2.0 abstraction
│   │   │   │   │   ├── CompositeApiManager.ts  # Composite + Graph API
│   │   │   │   │   ├── RateLimiter.ts          # Rate limiting adaptatif
│   │   │   │   │   ├── RetryStrategy.ts        # Exponential backoff
│   │   │   │   │   ├── RollbackManager.ts      # Rollback transactionnel
│   │   │   │   │   ├── QueueManager.ts         # File d'attente prioritaire
│   │   │   │   │   ├── WorkerPool.ts           # Worker threads
│   │   │   │   │   ├── CheckpointManager.ts    # Sauvegarde d'état pour recovery
│   │   │   │   │   └── ErrorClassifier.ts      # Classification des erreurs SF
│   │   │   │   │
│   │   │   │   ├── grappe/                     # 🆕 MODE GRAPPE (Cluster Processing)
│   │   │   │   │   ├── GrappeOrchestrator.ts   # Orchestrateur principal
│   │   │   │   │   ├── GrappePartitioner.ts    # Partitionnement des données
│   │   │   │   │   ├── GrappeWorkerManager.ts  # Gestion des workers parallèles
│   │   │   │   │   ├── GrappeAggregator.ts     # Agrégation des résultats
│   │   │   │   │   ├── GrappeScheduler.ts      # Scheduling intra-grappe
│   │   │   │   │   ├── BackPressureManager.ts  # Gestion de la pression (inspiré NiFi)
│   │   │   │   │   └── GrappeMonitor.ts        # Monitoring de la grappe
│   │   │   │   │
│   │   │   │   ├── metadata/
│   │   │   │   │   ├── MetadataReader.ts       # Describe + Tooling API
│   │   │   │   │   ├── SchemaAnalyzer.ts       # Analyse complète du schéma
│   │   │   │   │   ├── ObjectGraph.ts          # Graphe de relations
│   │   │   │   │   ├── SchemaCache.ts          # Cache avec TTL + invalidation
│   │   │   │   │   ├── SchemaDriftDetector.ts  # Drift detection
│   │   │   │   │   └── PolymorphicResolver.ts  # WhoId, WhatId, etc.
│   │   │   │   │
│   │   │   │   ├── storage/
│   │   │   │   │   ├── Database.ts             # SQLite wrapper
│   │   │   │   │   ├── MigrationRunner.ts      # Migrations de schéma DB
│   │   │   │   │   ├── ConfigStore.ts          # Configs & templates
│   │   │   │   │   ├── SecretVault.ts          # VSCode SecretStorage
│   │   │   │   │   └── CacheManager.ts         # Cache multi-layer
│   │   │   │   │
│   │   │   │   ├── precheck/
│   │   │   │   │   ├── PreCheckEngine.ts       # Moteur de pre-check
│   │   │   │   │   ├── checks/                 # Checks individuels
│   │   │   │   │   │   ├── PermissionCheck.ts
│   │   │   │   │   │   ├── ApiLimitCheck.ts
│   │   │   │   │   │   ├── StorageCheck.ts
│   │   │   │   │   │   ├── SchemaCheck.ts
│   │   │   │   │   │   ├── DataIntegrityCheck.ts
│   │   │   │   │   │   ├── OrgStatusCheck.ts
│   │   │   │   │   │   ├── CompatibilityCheck.ts
│   │   │   │   │   │   ├── SecurityCheck.ts
│   │   │   │   │   │   └── PerformanceCheck.ts
│   │   │   │   │   └── AutoFixer.ts            # Auto-correction
│   │   │   │   │
│   │   │   │   ├── reporting/
│   │   │   │   │   ├── ReportGenerator.ts
│   │   │   │   │   ├── AnalyticsCollector.ts
│   │   │   │   │   ├── AuditLogger.ts
│   │   │   │   │   ├── DataLineageTracker.ts
│   │   │   │   │   └── ExportEngine.ts         # Multi-format export
│   │   │   │   │
│   │   │   │   ├── i18n/
│   │   │   │   │   ├── I18nManager.ts
│   │   │   │   │   └── locales/
│   │   │   │   │       ├── en.json
│   │   │   │   │       ├── fr.json
│   │   │   │   │       ├── de.json
│   │   │   │   │       ├── es.json
│   │   │   │   │       ├── ja.json
│   │   │   │   │       └── pt-BR.json
│   │   │   │   │
│   │   │   │   ├── notifications/
│   │   │   │   │   ├── NotificationCenter.ts
│   │   │   │   │   ├── ToastBridge.ts          # Pont vers WebView toasts
│   │   │   │   │   ├── BadgeManager.ts
│   │   │   │   │   ├── SoundManager.ts
│   │   │   │   │   └── WebhookDispatcher.ts
│   │   │   │   │
│   │   │   │   └── cli/                        # 🆕 CLI Mode pour CI/CD
│   │   │   │       ├── CliRunner.ts            # Runner headless
│   │   │   │       ├── CliParser.ts            # Argument parsing
│   │   │   │       └── CliReporter.ts          # Output formaté pour CI
│   │   │   │
│   │   │   ├── modules/
│   │   │   │   ├── seed/
│   │   │   │   │   ├── SeedOrchestrator.ts
│   │   │   │   │   ├── AIDataGenerator.ts
│   │   │   │   │   ├── FakerFallback.ts
│   │   │   │   │   ├── SeedTemplateManager.ts
│   │   │   │   │   ├── DataPlanBuilder.ts
│   │   │   │   │   ├── FieldMapper.ts
│   │   │   │   │   ├── ReferenceLinker.ts
│   │   │   │   │   ├── SeedValidator.ts
│   │   │   │   │   ├── DataPatternAnalyzer.ts
│   │   │   │   │   ├── RecordTypeAwareSeed.ts
│   │   │   │   │   ├── CrossObjectConsistency.ts
│   │   │   │   │   ├── PostSeedValidator.ts
│   │   │   │   │   └── SeedGrappeAdapter.ts    # 🆕 Adapter pour mode grappe
│   │   │   │   │
│   │   │   │   ├── sync/
│   │   │   │   │   ├── SyncOrchestrator.ts
│   │   │   │   │   ├── DataSync.ts
│   │   │   │   │   ├── MetadataSync.ts
│   │   │   │   │   ├── DeltaDetector.ts
│   │   │   │   │   ├── ConflictResolver.ts
│   │   │   │   │   ├── FieldMapping.ts
│   │   │   │   │   ├── TransformPipeline.ts
│   │   │   │   │   ├── ExternalIdManager.ts
│   │   │   │   │   ├── SyncScheduler.ts
│   │   │   │   │   ├── CsvConnector.ts
│   │   │   │   │   ├── JsonConnector.ts
│   │   │   │   │   ├── ObjectSetManager.ts
│   │   │   │   │   ├── MigrationScript.ts      # Pre/Post Apex anonymous
│   │   │   │   │   ├── PolymorphicHandler.ts
│   │   │   │   │   ├── SelfReferenceHandler.ts
│   │   │   │   │   ├── RecordTypeMapper.ts
│   │   │   │   │   ├── UserMapper.ts
│   │   │   │   │   ├── DataMasker.ts
│   │   │   │   │   ├── SchemaValidator.ts
│   │   │   │   │   ├── IncrementalTracker.ts
│   │   │   │   │   └── SyncGrappeAdapter.ts    # 🆕 Adapter pour mode grappe
│   │   │   │   │
│   │   │   │   ├── monitor/
│   │   │   │   │   ├── MonitorOrchestrator.ts
│   │   │   │   │   ├── LimitsTracker.ts
│   │   │   │   │   ├── JobMonitor.ts
│   │   │   │   │   ├── ErrorLogMonitor.ts
│   │   │   │   │   ├── DeploymentTracker.ts
│   │   │   │   │   ├── UserSessionMonitor.ts
│   │   │   │   │   ├── AlertEngine.ts
│   │   │   │   │   ├── HealthCheck.ts
│   │   │   │   │   ├── ChangeDataCaptureListener.ts
│   │   │   │   │   ├── ApexLogAnalyzer.ts
│   │   │   │   │   ├── GovernorLimitPredictor.ts
│   │   │   │   │   ├── SandboxRefreshTracker.ts
│   │   │   │   │   └── OrgTrendAnalyzer.ts
│   │   │   │   │
│   │   │   │   ├── compare/
│   │   │   │   │   ├── CompareOrchestrator.ts
│   │   │   │   │   ├── MetadataCompare.ts
│   │   │   │   │   ├── ConfigCompare.ts
│   │   │   │   │   ├── PermissionCompare.ts
│   │   │   │   │   ├── DataCompare.ts
│   │   │   │   │   ├── DiffEngine.ts
│   │   │   │   │   ├── CompareReport.ts
│   │   │   │   │   ├── SnapshotManager.ts
│   │   │   │   │   ├── DriftDetector.ts
│   │   │   │   │   ├── ImpactAnalyzer.ts
│   │   │   │   │   ├── DeploymentBuilder.ts
│   │   │   │   │   └── ProblemAnalyzer.ts
│   │   │   │   │
│   │   │   │   ├── dataops/
│   │   │   │   │   ├── BackupManager.ts
│   │   │   │   │   ├── RollbackEngine.ts
│   │   │   │   │   ├── AnonymizationEngine.ts
│   │   │   │   │   ├── DataCleaner.ts
│   │   │   │   │   ├── MassDeleteManager.ts
│   │   │   │   │   ├── DataArchiver.ts
│   │   │   │   │   ├── RecycleBinManager.ts
│   │   │   │   │   ├── StorageOptimizer.ts
│   │   │   │   │   ├── DataQualityScanner.ts
│   │   │   │   │   └── ComplianceChecker.ts
│   │   │   │   │
│   │   │   │   └── automation/
│   │   │   │       ├── PipelineOrchestrator.ts
│   │   │   │       ├── PipelineBuilder.ts
│   │   │   │       ├── TriggerEngine.ts
│   │   │   │       ├── SchedulerService.ts
│   │   │   │       ├── StepLibrary.ts
│   │   │   │       ├── StepExecutor.ts
│   │   │   │       ├── ConditionalRouter.ts
│   │   │   │       └── PipelineHistory.ts
│   │   │   │
│   │   │   ├── providers/
│   │   │   │   ├── SidebarProvider.ts          # TreeView pour la sidebar
│   │   │   │   ├── StatusBarProvider.ts        # Items status bar
│   │   │   │   └── WebviewPanelManager.ts      # Gestion des panels WebView
│   │   │   │
│   │   │   └── bridge/
│   │   │       ├── MessageBroker.ts            # Communication typée
│   │   │       ├── MessageRouter.ts            # Routing des messages par type
│   │   │       └── WebviewStateSync.ts         # Sync d'état
│   │   │
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── esbuild.config.ts
│   │
│   └── webview/                                # Application React (WebView)
│       ├── src/
│       │   ├── main.tsx                        # Entry point
│       │   ├── App.tsx                         # Root avec providers
│       │   ├── router.tsx                      # Routes par module
│       │   │
│       │   ├── theme/                          # Design system
│       │   ├── stores/                         # Zustand stores
│       │   ├── hooks/                          # Custom hooks
│       │   ├── i18n/                           # Traductions
│       │   │
│       │   ├── layouts/                        # Shell, Sidebar, TopBar, StatusFooter
│       │   │   ├── AppShell.tsx
│       │   │   ├── Sidebar/
│       │   │   ├── TopBar/
│       │   │   ├── StatusFooter/
│       │   │   └── NotificationCenter/
│       │   │
│       │   ├── pages/                          # Pages par module
│       │   │   ├── Home/
│       │   │   ├── OrgManager/
│       │   │   ├── Seed/
│       │   │   ├── Sync/
│       │   │   ├── Monitor/
│       │   │   ├── Compare/
│       │   │   ├── DataOps/
│       │   │   ├── Automation/
│       │   │   ├── Reports/
│       │   │   └── Settings/
│       │   │
│       │   └── components/                     # Composants réutilisables
│       │       ├── ui/                         # Shadcn/ui base
│       │       ├── sf/                         # Salesforce-specific
│       │       ├── data/                       # DataTable, JsonViewer, DiffViewer
│       │       ├── viz/                        # Charts, Graphs, Gauges
│       │       ├── feedback/                   # Progress, Toasts, Empty states
│       │       └── wizard/                     # Framework de wizards
│       │
│       ├── package.json
│       ├── tsconfig.json
│       ├── vite.config.ts
│       └── tailwind.config.ts
│
├── resources/
│   ├── icons/
│   ├── templates/                              # Templates built-in
│   │   ├── seed/
│   │   ├── sync/
│   │   ├── anonymize/
│   │   ├── pipelines/
│   │   └── grappes/                            # 🆕 Templates de grappes
│   └── migrations/                             # SQLite migrations
│       ├── 001_initial.sql
│       └── 002_grappe_tables.sql
│
├── test/
│   ├── fixtures/                               # Données de test
│   │   ├── mock-describe-account.json
│   │   ├── mock-describe-contact.json
│   │   ├── mock-limits-response.json
│   │   ├── mock-bulk-job-response.json
│   │   └── sample-data/
│   │       ├── accounts.csv
│   │       └── contacts.csv
│   ├── helpers/
│   │   ├── sf-mock.ts                          # Mock jsforce connection
│   │   ├── vscode-mock.ts                      # Mock VSCode API
│   │   └── test-utils.ts
│   └── integration/
│       ├── seed-pipeline.test.ts
│       ├── sync-pipeline.test.ts
│       └── grappe-processing.test.ts
│
└── .sandforge.example.json                    # Config team d'exemple
```

---

## 4. CORE ENGINE

*(Reprend la v2 avec ajouts)*

### 4.1 OrgManager & Connections

```typescript
interface SalesforceOrg {
  id: string;
  alias: string;
  username: string;
  instanceUrl: string;
  orgId: string;
  orgType: 'Production' | 'Sandbox' | 'Scratch' | 'Developer';
  sandboxType?: 'Developer' | 'DeveloperPro' | 'Partial' | 'Full';
  authMethod: 'oauth_web' | 'oauth_device' | 'jwt' | 'usernamePassword' | 'sfdx_import';
  safetyTier: OrgSafetyTier;
  appearance: { color: string; icon: string; position: number };
  metadata: { apiVersion: string; edition: string; features: string[]; namespace?: string; isSandboxOf?: string };
  status: 'connected' | 'expired' | 'error' | 'refreshing';
  lastConnected: Date;
  tags: string[];
}

enum OrgSafetyTier {
  CRITICAL = 'critical',   // Production → typed confirmation + audit
  HIGH = 'high',           // Full/Partial Sandbox → confirmation
  MEDIUM = 'medium',       // Dev Pro → warning
  LOW = 'low',             // Dev/Scratch → libre
}
```

### 4.2 Dependency Resolver

```typescript
interface ObjectDependencyGraph {
  nodes: ObjectNode[];
  edges: DependencyEdge[];
  topologicalOrder: string[];
  cycles: CycleInfo[];
  layers: string[][];                  // Couches parallélisables
  grappePartitions: GrappePartition[]; // 🆕 Partitions pour le mode grappe
}

interface DependencyEdge {
  source: string;
  target: string;
  fieldApiName: string;
  type: 'lookup' | 'master_detail' | 'polymorphic' | 'self_reference' | 'hierarchical' | 'external_lookup';
  required: boolean;
  cascadeDelete: boolean;
  polymorphicTypes?: string[];
}
```

Algorithme : Describe → Graph → Tarjan (cycles) → Topological sort → Layer grouping → Grappe partitioning

### 4.3 Execution Pipeline

```typescript
interface ExecutionPipeline {
  id: string;
  status: 'idle' | 'pre_checking' | 'running' | 'paused' | 'waiting_user' | 'rolling_back' | 'completed' | 'completed_with_errors' | 'failed' | 'cancelled';
  steps: ExecutionStep[];
  options: {
    apiMode: 'rest' | 'bulk' | 'composite' | 'auto';
    grappeMode: boolean;              // 🆕 Activer le mode grappe
    grappeConfig?: GrappeConfig;      // 🆕 Config grappe
    parallelism: number;
    batchSize: number;
    errorHandling: 'stop_on_first' | 'continue_and_report' | 'retry_failed';
    enableRollback: boolean;
    dryRun: boolean;
    preScript?: string;
    postScript?: string;
    checkpoint: boolean;              // 🆕 Sauvegarder l'état pour recovery
  };
  progress: ExecutionProgress;
}
```

### 4.4 Error Classification

```typescript
// Classification automatique des erreurs SF pour un retry intelligent
const errorClassification: Record<string, ErrorClass> = {
  // Retryable (transient)
  'UNABLE_TO_LOCK_ROW':         { retryable: true, delay: 2000, strategy: 'exponential' },
  'REQUEST_RUNNING_TOO_LONG':   { retryable: true, delay: 5000, strategy: 'exponential' },
  'SERVER_UNAVAILABLE':         { retryable: true, delay: 10000, strategy: 'exponential' },
  'INVALID_SESSION_ID':         { retryable: true, delay: 0, strategy: 'reauth_then_retry' },
  'REQUEST_LIMIT_EXCEEDED':     { retryable: true, delay: 60000, strategy: 'fixed_delay' },
  
  // Non-retryable (data issues)
  'INVALID_FIELD':              { retryable: false, category: 'schema' },
  'REQUIRED_FIELD_MISSING':     { retryable: false, category: 'data' },
  'DUPLICATE_VALUE':            { retryable: false, category: 'data', suggestUpsert: true },
  'FIELD_CUSTOM_VALIDATION_EXCEPTION': { retryable: false, category: 'validation' },
  'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY': { retryable: false, category: 'trigger' },
  'STRING_TOO_LONG':            { retryable: false, category: 'data', suggestTruncate: true },
  'INVALID_CROSS_REFERENCE_KEY': { retryable: false, category: 'reference' },
  'ENTITY_IS_DELETED':          { retryable: false, category: 'reference' },
  
  // Retryable with modifications
  'STORAGE_LIMIT_EXCEEDED':     { retryable: false, category: 'limit', blockAll: true },
  'LIMIT_EXCEEDED':             { retryable: true, delay: 30000, strategy: 'reduce_batch' },
};
```

---

## 5. MODE GRAPPE (Cluster Processing) 🆕

### 5.1 Concept

Le **mode grappe** est un mode de traitement parallèle et distribué pour les opérations massives. Inspiré d'Apache NiFi (back-pressure, flow-based) et des ETL enterprise (Talend, Informatica).

Quand une opération dépasse un seuil configurable (ex: > 10,000 records), le système active automatiquement le mode grappe qui :
1. **Partitionne** les données en grappes (clusters) indépendantes
2. **Distribue** les grappes sur plusieurs workers parallèles
3. **Monitor** chaque grappe individuellement avec back-pressure
4. **Agrège** les résultats en un rapport unifié
5. **Recovery** : chaque grappe a son checkpoint, une grappe en échec ne bloque pas les autres

### 5.2 Architecture

```typescript
interface GrappeConfig {
  enabled: boolean;
  autoActivateThreshold: number;       // Records count to auto-activate (default: 10000)
  maxWorkers: number;                  // Max parallel workers (default: 4, max: 8)
  grappeSize: number;                  // Records per grappe (default: 5000)
  strategy: GrappePartitionStrategy;
  backPressure: BackPressureConfig;
  checkpointing: boolean;
  isolationLevel: 'none' | 'per_object' | 'per_grappe'; // Granularité du rollback
}

type GrappePartitionStrategy =
  | 'round_robin'                      // Distribution uniforme
  | 'by_record_type'                   // 1 grappe par Record Type
  | 'by_parent'                        // Grouper par Account/parent (cohérence relationnelle)
  | 'by_date_range'                    // Partitionner par date (incrémental)
  | 'by_hash'                          // Hash-based partitioning
  | 'by_volume'                        // Grappes de taille égale
  | 'dependency_aware';                // Respecte les dépendances inter-records

interface GrappePartition {
  id: string;
  index: number;
  totalPartitions: number;
  recordCount: number;
  records: string[];                   // IDs ou identifiants
  dependencies: string[];             // IDs des grappes dont celle-ci dépend
  status: GrappeStatus;
  assignedWorker?: number;
  progress: GrappeProgress;
  checkpoint?: GrappeCheckpoint;
  startTime?: Date;
  endTime?: Date;
  retryCount: number;
}

type GrappeStatus = 
  | 'pending'                          // En attente d'un worker
  | 'queued'                           // Dans la queue d'un worker
  | 'running'                          // En cours de traitement
  | 'paused'                           // Pausée (back-pressure ou user)
  | 'completed'                        // Terminée avec succès
  | 'failed'                           // Échouée
  | 'retrying'                         // En cours de retry
  | 'cancelled';                       // Annulée

interface BackPressureConfig {
  enabled: boolean;
  maxQueueDepth: number;               // Max grappes en queue par worker (default: 3)
  highWaterMark: number;               // % API limits pour ralentir (default: 80)
  lowWaterMark: number;                // % API limits pour reprendre (default: 60)
  strategy: 'pause' | 'throttle' | 'drop_priority';
  monitoringInterval: number;          // ms entre checks (default: 5000)
}

interface GrappeCheckpoint {
  grappeId: string;
  timestamp: Date;
  processedRecords: number;
  lastProcessedId?: string;
  state: Record<string, unknown>;
  recoverable: boolean;
}
```

### 5.3 Orchestration

```
Data In (N records)
     │
     ▼
┌─────────────┐
│ Partitioner  │ ─── Analyse les données, dépendances, crée les grappes
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  Scheduler   │ ─── Ordonne les grappes (respect dépendances), assigne aux workers
└──────┬──────┘
       │
       ├──────┬──────┬──────┐
       ▼      ▼      ▼      ▼
   ┌──────┐┌──────┐┌──────┐┌──────┐
   │ W-1  ││ W-2  ││ W-3  ││ W-4  │  ← Worker Threads
   │ G-1  ││ G-2  ││ G-3  ││ G-4  │
   │ G-5  ││ G-6  ││ G-7  ││ G-8  │
   └──┬───┘└──┬───┘└──┬───┘└──┬───┘
      │       │       │       │
      ▼       ▼       ▼       ▼
┌────────────────────────────────────┐
│ Back-Pressure Monitor               │ ─── Surveille API limits, throttle si nécessaire
└──────────────┬─────────────────────┘
               │
               ▼
┌─────────────┐
│  Aggregator  │ ─── Fusionne les résultats, génère le rapport
└─────────────┘
```

### 5.4 UI du Mode Grappe

```
┌──────────────────────────────────────────────────────────────┐
│ 🔄 Sync: Accounts (47,500 records) — GRAPPE MODE            │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Workers: 4/4 active    Back-Pressure: ░░░░░░░░░░ Normal    │
│  API Limits: ████████░░ 78% used                            │
│                                                              │
│  ┌─── Worker 1 ───┐  ┌─── Worker 2 ───┐                    │
│  │ G-1 ██████████ ✅│  │ G-2 ████████░░ 82% │               │
│  │ G-5 ████░░░░░░ 38%│  │ G-6 ░░░░░░░░░░ queue│             │
│  └─────────────────┘  └───────────────────┘                 │
│                                                              │
│  ┌─── Worker 3 ───┐  ┌─── Worker 4 ───┐                    │
│  │ G-3 ██████████ ✅│  │ G-4 ██████░░░░ 61% │               │
│  │ G-7 ██░░░░░░░░ 15%│  │ G-8 ░░░░░░░░░░ queue│             │
│  └─────────────────┘  └───────────────────┘                 │
│                                                              │
│  Overall: ████████░░ 76%   ETA: 2m 14s                      │
│  Processed: 36,100/47,500  Success: 35,987  Failed: 113     │
│                                                              │
│  [⏸️ Pause All] [⏭️ Skip Failed] [❌ Cancel] [📊 Details]   │
└──────────────────────────────────────────────────────────────┘
```

### 5.5 Activation automatique

```typescript
// Le mode grappe s'active automatiquement quand :
function shouldActivateGrappe(operation: OperationConfig): boolean {
  return (
    operation.totalRecords > config.grappeAutoThreshold ||  // > 10K records
    operation.estimatedApiCalls > 5000 ||                   // Beaucoup d'API calls
    operation.objects.length > 5 ||                         // Beaucoup d'objets
    operation.forceGrappe === true                          // Forçage manuel
  );
}
```

### 5.6 Templates de Grappe

| Template | Stratégie | Usage |
|---|---|---|
| **High Volume Seed** | `by_volume` + 4 workers | Seed > 50K records |
| **Multi-Object Sync** | `dependency_aware` + auto | Sync multi-objets complexe |
| **Full Org Backup** | `by_object` + max workers | Backup complet |
| **Mass Anonymization** | `by_volume` + 8 workers | Anonymisation massive |
| **Incremental Date Sync** | `by_date_range` + 2 workers | Sync incrémentale par période |

---

## 6-11. MODULES

*(Les modules SEED, SYNC, MONITORING, COMPARE, DATAOPS, AUTOMATION restent identiques à la v2 avec les ajouts suivants)*

### Ajouts transversaux à tous les modules

**Mode Grappe intégré** : Chaque module dispose d'un `GrappeAdapter` qui active le mode grappe quand le volume le nécessite.

**Undo / Redo** : Toutes les actions de configuration dans les wizards supportent Ctrl+Z / Ctrl+Y grâce à un history stack dans Zustand.

**Favoris & Raccourcis** : L'utilisateur peut marquer en favori n'importe quel template, objet, org, config pour un accès rapide depuis la sidebar.

**Recherche globale (⌘K)** : La palette de recherche interne recherche dans : orgs, objets SF, templates, pipelines, rapports, settings, documentation.

**Aide contextuelle** : Tooltip d'aide avec `?` sur chaque champ de configuration, lien vers la doc SF quand pertinent.

**Copier/Coller de config** : Chaque configuration (seed, sync, pipeline) peut être copiée en JSON et collée ailleurs (y compris dans un autre workspace).

### 6. Module SEED — Ajouts v3

- **Import de config SFDMU** : Peut lire un fichier `export.json` de SFDMU et le convertir en template Seed
- **AI Persona** : Possibilité de définir une "persona" IA (ex: "Tu es un data steward chez un assureur français") pour contextualiser la génération
- **Seed Diff** : Comparer 2 résultats de seed pour voir les différences
- **Seed Versioning** : Chaque exécution de seed est versionnée et comparable
- **Bulk Insert Optimization** : Auto-détection de la taille de batch optimale basée sur le describe (nombre de champs, triggers actifs, etc.)

### 7. Module SYNC — Ajouts v3

- **SFDMU Config Import** : Importer directement un `export.json` SFDMU comme base de config sync
- **Bidirectional Sync** : Sync dans les 2 sens avec résolution de conflits
- **CDC Live Sync** : Sync continue basée sur Change Data Capture (subscription)
- **Data Profiling** : Avant la sync, profiler les données source (distribution, null %, outliers)
- **Sankey + Waterfall** : 2 vues de visualisation du flux de données
- **Dry Run avec Diff** : Le dry run génère un diff exact de ce qui serait modifié

### 8. Module MONITOR — Ajouts v3

- **Custom Metrics** : Définir des métriques custom via SOQL (ex: COUNT de records créés aujourd'hui)
- **Dashboard Layouts** : Sauvegarder et charger des layouts de dashboard personnalisés
- **Multi-Org Comparison Monitor** : Comparer les métriques de N orgs côte à côte

### 9. Module COMPARE — Ajouts v3

- **Three-way Compare** : Comparer 3 orgs simultanément (Prod vs UAT vs Dev)
- **Compare with Git** : Comparer les métadonnées d'une org avec le contenu d'un repo Git
- **Auto-suggest Deployment** : Après comparaison, l'IA suggère quels composants devraient être déployés

### 10. Module DATAOPS — Ajouts v3

- **Smart Backup** : L'IA analyse l'usage et suggère quels objets sauvegarder en priorité
- **Backup Verification** : Après backup, vérification d'intégrité (checksum + sample query)
- **Anonymization Preview Live** : Preview en temps réel pendant la configuration des règles

### 11. Module AUTOMATION — Ajouts v3

- **Pipeline Marketplace** : Naviguer et importer des pipelines communautaires
- **Pipeline Versioning** : Git-like versioning des pipelines
- **Pipeline Dry Run** : Simuler l'exécution complète d'un pipeline sans aucune écriture
- **Approval Gates** : Step qui pause le pipeline et attend une approbation humaine (via toast/notification)

---

## 12. SYSTÈME DE PRE-CHECK

```typescript
interface PreCheckResult {
  status: 'pass' | 'warning' | 'fail';
  score: number;                       // 0-100
  checks: PreCheckItem[];
  estimations: {
    duration: number;
    apiCalls: number;
    dataStorageImpact: number;
    fileStorageImpact: number;
    bulkJobs: number;
    grappeRecommendation: boolean;     // 🆕 Recommandation d'activer le mode grappe
    optimalGrappeConfig?: GrappeConfig; // 🆕 Config grappe optimale estimée
  };
  canProceed: boolean;
  requiresConfirmation: ConfirmationItem[];
  autoFixable: PreCheckItem[];
}
```

**Checks complets :**

| Catégorie | Vérifications |
|---|---|
| **permissions** | CRUD par objet, FLS par champ, Modify All Data, View All Data, Bulk API permission |
| **api_limits** | API calls restantes vs estimées, concurrent requests, Bulk API job slots |
| **storage** | Data storage + File storage vs impact estimé |
| **schema** | Champs requis, validation rules actives, triggers actifs, flows actifs, duplicate rules |
| **data_integrity** | Lookup targets existants, unique field conflicts, picklist values valides, External ID disponible |
| **org_status** | Maintenance planifiée, sandbox refresh en cours, read-only mode, deployment in progress |
| **compatibility** | API version match, feature availability, managed package version |
| **security** | Safety tier, sensitive data detection, RGPD fields, Production guard |
| **performance** | Estimated time, batch size recommendation, grappe recommendation, parallel workers optimal |
| **connectivity** | Connection stable, latency acceptable, token validity |

---

## 13. REPORTING & ANALYTICS

*(Identique v2 avec ajout)*

**Data Lineage complet (inspiré dbt)** :
```
Source Org [Account] ──→ [Field Mapping] ──→ [Transform: uppercase] ──→ [Filter: Active=true] ──→ Target Org [Account]
                    └──→ [Anonymize: email] ──→ [Masked Org] [Account]
```

Visualisation DAG interactive (React Flow), click to drill-down par transformation.

---

## 14. UI/UX DESIGN SYSTEM 2026

*(Identique v2 avec ajouts)*

### Navigation enrichie

```
Sidebar (TreeView VSCode natif) :
├── 🏠 Home
├── 🔌 Orgs (N)                     ← Badge avec nombre
│   ├── 🔴 Production
│   ├── 🟡 UAT
│   └── 🟢 Dev1
├── ────────────
├── 🌱 Seed                          ← Badge si template en cours
├── 🔄 Sync                          ← Badge si sync en cours
├── 📊 Monitor                       ← Badge si alerte active (rouge !)
├── 🔍 Compare
├── 🛡️ Data Ops
├── ⚡ Automation                    ← Badge si pipeline running
├── ────────────
├── 📈 Reports
├── ⚙️ Settings
├── ────────────
├── ⚡ Quick Actions
│   ├── Quick Seed (last template)
│   ├── Refresh Monitor
│   └── Run last Pipeline
├── ⭐ Favorites
│   ├── B2B Seed Template
│   └── Nightly Backup Pipeline
└── 🕐 Recent Operations
    ├── Seed on Dev1 (2min ago) ✅
    ├── Sync UAT→Dev (1h ago) ⚠️
    └── Backup Prod (3h ago) ✅
```

### Status Bar (VSCode native)

```
[🟢 Prod] [API: 45%] [Jobs: 3 running] [⚠️ 2 alerts] [Grappe: idle]
```

Chaque item est cliquable et ouvre le panel WebView correspondant.

### Notification System

| Type | Canal | Durée | Action |
|---|---|---|---|
| Operation success | Toast (WebView) + Badge update | 5s auto-dismiss | "View Report" |
| Operation warning | Toast (WebView) + VSCode notification | 10s | "View Details" |
| Operation failure | Toast (WebView) + VSCode error notification | Persistent | "View Error" + "Retry" |
| Alert triggered | VSCode notification + Badge + Sound (opt) | Persistent | "View Alert" + "Dismiss" |
| Pipeline waiting | VSCode notification | Persistent | "Approve" / "Reject" |
| Back-pressure | Toast (WebView) | Until resolved | "View Grappe" |
| Sandbox refresh detected | VSCode notification | 30s | "Run Post-Refresh Pipeline" |

---

## 15. SÉCURITÉ & COMPLIANCE

*(Identique v2 — inclut : Safety Tiers, CSP, SecretStorage, audit trail, encryption, compliance RGPD/CCPA/HIPAA)*

---

## 16. INTERNATIONALISATION

*(Identique v2 — 6 langues : en, fr, de, es, ja, pt-BR — react-i18next + backend i18n)*

---

## 17. SCALABILITÉ & PERFORMANCE

| Seuil | Stratégie |
|---|---|
| < 200 records | REST API direct |
| 200 - 2,000 | Composite API (si liés) ou REST batched |
| 2,000 - 10,000 | Bulk API 2.0 single-thread |
| 10,000 - 100,000 | **Mode Grappe** : Bulk API 2.0 + workers parallèles |
| > 100,000 | **Mode Grappe MAX** : workers + chunking + streaming + checkpointing |

**Optimisations :**
- Worker Threads Node.js pour CPU-intensive (hashing, diff, compress)
- Web Workers dans la WebView pour les graphes D3 / React Flow lourds
- TanStack Table virtualisation pour 100K+ rows
- React.lazy + code splitting par module
- Schema cache avec stale-while-revalidate
- Connection pooling avec keep-alive
- SQLite WAL mode pour concurrent reads

---

## 18. EXTENSIBILITÉ & PLUGINS

```typescript
interface SandForgePlugin {
  id: string;
  name: string;
  version: string;
  
  // Extension points
  seedStrategies?: CustomSeedStrategy[];     // Nouvelles stratégies de génération
  transformers?: CustomTransformer[];         // Nouvelles transformations
  preChecks?: CustomPreCheck[];               // Nouveaux checks
  pipelineSteps?: CustomPipelineStep[];       // Nouveaux steps de pipeline
  exportFormats?: CustomExportFormat[];       // Nouveaux formats d'export
  connectors?: CustomConnector[];             // Nouvelles sources/destinations
  grappeStrategies?: CustomGrappeStrategy[];  // 🆕 Nouvelles stratégies de partitionnement
  
  settingsSchema?: ZodSchema;
  sidebarItems?: SidebarContribution[];
}
```

---

## 19. CLI MODE (CI/CD) 🆕

L'extension expose aussi un mode CLI headless pour l'automatisation CI/CD :

```bash
# Seed depuis un template
sandforge seed --template ./templates/b2b.json --org dev1 --records 1000

# Sync entre orgs
sandforge sync --config ./sync/prod-to-dev.json --dry-run

# Compare
sandforge compare --source prod --target uat --output ./reports/diff.html

# Backup
sandforge backup --org prod --objects Account,Contact --output ./backups/

# Run pipeline
sandforge pipeline run --config ./pipelines/nightly.json

# Anonymize
sandforge anonymize --org uat --template rgpd-france --report ./reports/

# Health check
sandforge health --org prod --format json

# Grappe status
sandforge grappe status --operation-id abc123
```

**Output formats** : `json` (default), `table`, `csv`, `html`

**Exit codes** : 0 (success), 1 (failure), 2 (warnings), 3 (partial success)

**Intégration CI** : GitHub Actions, GitLab CI, Jenkins, Azure DevOps — examples dans `./ci-examples/`

---

## 20. OFFLINE & RESILIENCE 🆕

### 20.1 Mode Offline

Quand la connexion SF est perdue :
- **Cache metadata** : Le schema cache local permet de configurer des opérations hors ligne
- **Queue d'opérations** : Les opérations sont mises en queue et exécutées à la reconnexion
- **Templates** : Création et édition de templates en offline
- **Rapports** : Consultation des rapports passés en offline
- **Settings** : Modification des paramètres en offline

### 20.2 Checkpoint & Recovery

```typescript
interface OperationCheckpoint {
  operationId: string;
  module: string;
  config: Record<string, unknown>;    // Config complète
  progress: {
    currentStep: number;
    processedObjects: string[];
    lastProcessedRecordId?: string;
    recordCounts: Record<string, number>;
  };
  grappeState?: GrappeCheckpoint[];
  timestamp: Date;
  expiresAt: Date;                    // Auto-cleanup
}
```

- **Auto-save** : Checkpoint toutes les 30s pendant les longues opérations
- **Recovery prompt** : Au redémarrage de VSCode, si un checkpoint existe → propose de reprendre
- **Manual resume** : Reprendre une opération interrompue depuis l'historique

### 20.3 Connection Resilience

```typescript
const resilienceConfig = {
  connectionRetry: { maxRetries: 5, initialDelay: 1000, maxDelay: 30000, backoff: 'exponential' },
  circuitBreaker: { failureThreshold: 5, resetTimeout: 60000, halfOpenRequests: 1 },
  tokenRefresh: { refreshBefore: 300000 }, // 5min avant expiration
  healthProbe: { interval: 60000, timeout: 5000 },
  reconnectOnResume: true,            // Reconnexion auto quand VSCode revient au premier plan
};
```

---

## 21. MIGRATION DEPUIS AUTRES OUTILS 🆕

### 21.1 Import SFDMU

```typescript
interface SfdmuImporter {
  // Lit un export.json de SFDMU et le convertit en config Sync
  importExportJson(filePath: string): SyncConfig;
  
  // Mapping des concepts
  // SFDMU "ScriptObject" → SyncObjectConfig
  // SFDMU "externalId" → ExternalIdManager config
  // SFDMU "fieldMapping" → FieldMapping config
  // SFDMU "valuesMapping" → TransformRule (map_value)
  // SFDMU "excludedFields" → field exclusion
  // SFDMU "master/child" → DependencyEdge
  // SFDMU "beforeAddons/afterAddons" → pre/post scripts
}
```

### 21.2 Import Gearset Comparison

- Import d'un rapport de comparaison Gearset pour bootstrapper un Compare
- Mapping des composants vers le format interne

### 21.3 Import CSV/JSON génériques

- Wizard d'import pour transformer n'importe quel CSV/JSON en config de sync
- Auto-detection des colonnes et mapping vers des champs SF

---

## 22. SETTINGS

*(Identique v2 avec ajout des settings Grappe et CLI)*

```yaml
# Ajouts aux settings
Grappe:
  autoActivate: true
  autoActivateThreshold: 10000
  maxWorkers: 4
  defaultGrappeSize: 5000
  defaultStrategy: "by_volume"
  backPressureEnabled: true
  backPressureHighWater: 80
  checkpointing: true

CLI:
  enabled: false                      # Activer le mode CLI
  defaultOutputFormat: "json"
  colorOutput: true
  verbosity: "normal"                 # quiet | normal | verbose | debug

Resilience:
  offlineMode: true
  checkpointInterval: 30000           # ms
  checkpointRetention: 24             # heures
  autoRecoveryPrompt: true
  connectionRetry: true

Onboarding:
  showWelcome: true
  showTips: true
  completedSteps: []
```

---

## 23. COLLABORATION & TEAM

*(Identique v2 avec ajout)*

**`.sandforge.json` enrichi :**
```json
{
  "$schema": "https://sandforge.dev/schema/v3.json",
  "version": "3.0",
  "team": { "name": "Dopamine", "locale": "fr_FR" },
  "orgs": { ... },
  "seed": { "templates": ["./sandforge/seed/*.json"] },
  "sync": { "objectSets": ["./sandforge/sync/*.json"] },
  "automation": { "pipelines": ["./sandforge/pipelines/*.json"] },
  "grappe": {
    "defaultConfig": { "maxWorkers": 4, "grappeSize": 5000, "strategy": "dependency_aware" }
  },
  "security": {
    "allowedOperationsOnProd": ["monitor", "compare", "backup"],
    "requireApprovalForProd": true
  },
  "migration": {
    "sfdmuConfigPath": "./sfdmu/export.json"   # 🆕 Import auto de la config SFDMU
  }
}
```

---

## 24. STANDARDS SALESFORCE

*(Identique v2 — liste exhaustive de tous les standards respectés)*

---

## 25. PLAN DE DÉVELOPPEMENT PAR PHASES

### Pré-requis (Claude Code setup)

```bash
# ÉTAPE 0 : Initialisation du monorepo
mkdir sandforge && cd sandforge
pnpm init
# Créer pnpm-workspace.yaml, tsconfig.base.json, .eslintrc.json, .prettierrc
# Créer les 3 packages avec leur package.json
# Installer toutes les dépendances
# Vérifier que pnpm build fonctionne (même vide)
# ✅ Checkpoint : pnpm install OK, structure créée
```

### Phase 1 — Shared Types & Utils (Jour 1)

```
Objectif : Tous les types, schemas, constantes, utils partagés
Fichiers : packages/shared/src/**/*
Tests : Chaque util a ses tests
Validation : pnpm typecheck && pnpm test → 100% pass
```

### Phase 2 — Core Engine Foundation (Jour 1-2)

```
Objectif : Connection, Metadata, Storage, i18n, Error handling
Fichiers : packages/extension/src/core/**/*
Tests : Mock jsforce, mock vscode API, test chaque service
Validation : pnpm typecheck && pnpm test && pnpm build:extension → 0 errors
```

### Phase 3 — WebView Shell & UI Foundation (Jour 2-3)

```
Objectif : React app, layouts, theme, sidebar, routing, composants de base
Fichiers : packages/webview/src/layouts/**, components/ui/**, theme/**
Tests : Render tests avec testing-library
Validation : pnpm build:webview → bundle OK + pnpm test → pass
```

### Phase 4 — Message Bridge & Org Manager (Jour 3)

```
Objectif : Communication Extension ↔ WebView, page Org Manager
Fichiers : bridge/**, providers/**, pages/OrgManager/**
Tests : Message round-trip, auth flows mockés
Validation : Full build + tests → L'extension s'ouvre dans VSCode avec l'Org Manager fonctionnel
```

### Phase 5 — Monitoring Module (Jour 3-4)

```
Objectif : Module le plus simple pour valider l'architecture end-to-end
Fichiers : modules/monitor/**, pages/Monitor/**
Tests : Mock Limits API, mock jobs, test alertes
Validation : Dashboard monitoring fonctionnel avec données mockées
```

### Phase 6 — Compare Module (Jour 4-5)

```
Objectif : Comparaison de métadonnées avec diff visuel
Fichiers : modules/compare/**, pages/Compare/**
Tests : Mock Metadata API, test diff engine
Validation : Comparaison fonctionnelle avec diff Monaco
```

### Phase 7 — Pre-Check Engine (Jour 5)

```
Objectif : Système de pre-check transversal
Fichiers : core/precheck/**
Tests : Chaque check individuellement + scénarios combinés
Validation : Pre-check fonctionnel, intégré dans Monitor et Compare
```

### Phase 8 — Seed Module (Jour 5-7)

```
Objectif : Wizard complet, génération IA/Faker, templates, preview
Fichiers : modules/seed/**, pages/Seed/**
Tests : Mock Claude API, test Faker, test pipeline d'insertion
Validation : Seed wizard fonctionnel end-to-end avec données mockées
```

### Phase 9 — Sync Module (Jour 7-9)

```
Objectif : ETL complet avec mapping, transforms, conflits, CSV I/O
Fichiers : modules/sync/**, pages/Sync/**
Tests : Mock Bulk API, test transforms, test conflict resolution
Validation : Sync fonctionnelle avec tous les modes
```

### Phase 10 — Mode Grappe (Jour 9-10)

```
Objectif : Cluster processing parallèle
Fichiers : core/grappe/**, UI grappe dans chaque module
Tests : Test partitioning, test workers, test back-pressure, test recovery
Validation : Grappe fonctionnelle avec monitoring UI
```

### Phase 11 — DataOps Module (Jour 10-11)

```
Objectif : Backup, Restore, Anonymisation, Nettoyage, Qualité
Fichiers : modules/dataops/**, pages/DataOps/**
Tests : Mock Bulk export, test anonymisation, test quality scanner
Validation : Backup/Restore fonctionnel, anonymisation testée
```

### Phase 12 — Automation Module (Jour 11-12)

```
Objectif : Pipeline builder, scheduler, triggers
Fichiers : modules/automation/**, pages/Automation/**
Tests : Test pipeline execution, test scheduling, test triggers
Validation : Pipeline builder fonctionnel, scheduler actif
```

### Phase 13 — Reporting & Analytics (Jour 12-13)

```
Objectif : Rapports, analytics, audit trail, lineage, export
Fichiers : core/reporting/**, pages/Reports/**
Tests : Test report generation, test export formats
Validation : Rapports générés et exportables
```

### Phase 14 — Polish & Integration (Jour 13-14)

```
Objectif : Onboarding, i18n complet, settings, favorites, search, CLI mode
Fichiers : Finitions dans tous les modules
Tests : Tests d'intégration cross-module, tests i18n
Validation : pnpm validate → TOUT passe
```

### Phase 15 — Final Validation (Jour 14)

```bash
# Checklist finale
✅ pnpm typecheck          → 0 errors
✅ pnpm lint               → 0 errors, 0 warnings
✅ pnpm format:check       → All formatted
✅ pnpm test               → All passing
✅ pnpm test:coverage      → Global >= 80%, Core >= 90%
✅ pnpm build              → Success
✅ pnpm package            → .vsix généré
✅ Taille bundle extension → < 5MB
✅ Taille bundle webview   → < 2MB
✅ DECISIONS.md            → Documenté
✅ README.md               → Complet
✅ CHANGELOG.md            → Rempli
✅ .sandforge.example.json → Valide
✅ Toutes les traductions  → en + fr minimum complets
```

---

## 26. COMMUNICATION PROTOCOL

*(Identique v2 — Protocol complet Extension ↔ WebView avec tous les types de messages)*

**Ajouts v3 :**

```typescript
// Messages Grappe
| { type: 'grappe:started'; payload: { operationId: string; partitions: GrappePartition[] } }
| { type: 'grappe:partitionProgress'; payload: { grappeId: string; progress: GrappeProgress } }
| { type: 'grappe:backPressure'; payload: { level: 'normal' | 'warning' | 'critical'; apiPercent: number } }
| { type: 'grappe:partitionCompleted'; payload: { grappeId: string; result: GrappeResult } }
| { type: 'grappe:completed'; payload: { operationId: string; aggregatedResult: AggregatedGrappeResult } }

// Messages Recovery
| { type: 'recovery:checkpointFound'; payload: { operationId: string; checkpoint: OperationCheckpoint } }
| { type: 'recovery:resume'; payload: { operationId: string } }
| { type: 'recovery:discard'; payload: { operationId: string } }

// Messages CLI
| { type: 'cli:execute'; payload: { command: string; args: Record<string, string> } }
| { type: 'cli:output'; payload: { stream: 'stdout' | 'stderr'; data: string } }
```

---

## ANNEXE A : Fichiers de configuration à créer au setup

```
pnpm-workspace.yaml
tsconfig.base.json
.eslintrc.json
.prettierrc
packages/shared/package.json
packages/shared/tsconfig.json
packages/shared/vitest.config.ts
packages/extension/package.json       (avec activationEvents, contributes, etc.)
packages/extension/tsconfig.json
packages/extension/esbuild.config.ts
packages/webview/package.json
packages/webview/tsconfig.json
packages/webview/vite.config.ts
packages/webview/tailwind.config.ts
packages/webview/postcss.config.js
packages/webview/index.html
```

## ANNEXE B : Métriques de succès

| Métrique | Cible |
|---|---|
| TypeScript errors | 0 |
| ESLint errors | 0 |
| ESLint warnings | 0 |
| Test coverage global | ≥ 80% |
| Test coverage core | ≥ 90% |
| Build time | < 30s |
| Extension bundle | < 5MB |
| WebView bundle | < 2MB |
| Time to first paint (WebView) | < 500ms |
| Memory usage idle | < 300MB |
| Supported languages | ≥ 2 (en, fr) |
| Accessibility | WCAG 2.1 AA |

---

> **CE PROMPT EST CONÇU POUR ÊTRE EXÉCUTÉ PAR CLAUDE CODE EN MODE AGENT AUTONOME MAXIMUM.**
>
> **Commence par la Phase 0 (setup monorepo) et avance phase par phase sans t'arrêter.**
> **Chaque phase doit être validée (build + tests) avant de passer à la suivante.**
> **Si un test échoue, corrige et re-teste en boucle. Ne laisse jamais le projet cassé.**
> **Documente chaque décision technique dans DECISIONS.md.**
> **L'objectif final est un fichier .vsix installable et fonctionnel.**
