# 📋 STRATÉGIE D'UTILISATION AVEC CLAUDE CODE

## Le problème

Le prompt complet fait ~66KB (~20K tokens). C'est trop pour une seule session Claude Code
qui doit aussi garder du contexte pour le code qu'il génère.

## La solution : Découpage en phases

Le projet est découpé en fichiers dans le dossier `docs/phases/`.
Chaque phase est un prompt autonome avec tout le contexte nécessaire.

## Structure des fichiers

```
sandforge/
├── CLAUDE.md                          # ← Claude Code lit ça EN PREMIER (toujours présent)
├── docs/
│   ├── ARCHITECTURE.md                # Architecture globale (types, structure, patterns)
│   ├── phases/
│   │   ├── phase-00-bootstrap.md      # Setup monorepo, configs, dépendances
│   │   ├── phase-01-shared.md         # Package shared (types, schemas, utils)
│   │   ├── phase-02-core-engine.md    # Core (connection, metadata, storage)
│   │   ├── phase-03-webview-shell.md  # WebView (layouts, theme, composants de base)
│   │   ├── phase-04-bridge-orgmgr.md  # Communication + Org Manager
│   │   ├── phase-05-monitor.md        # Module Monitoring
│   │   ├── phase-06-compare.md        # Module Compare Org
│   │   ├── phase-07-precheck.md       # Pre-Check Engine
│   │   ├── phase-08-seed.md           # Module Seed
│   │   ├── phase-09-sync.md           # Module Sync (ETL)
│   │   ├── phase-10-grappe.md         # Mode Grappe (Cluster)
│   │   ├── phase-11-dataops.md        # Module DataOps
│   │   ├── phase-12-automation.md     # Module Automation (Pipelines)
│   │   ├── phase-13-reporting.md      # Reporting & Analytics
│   │   └── phase-14-polish.md         # i18n, onboarding, CLI, final polish
│   └── specs/
│       ├── message-protocol.md        # Protocol complet Extension ↔ WebView
│       ├── grappe-spec.md             # Spec détaillée du mode grappe
│       ├── seed-strategies.md         # Toutes les stratégies de génération
│       ├── sync-transforms.md         # Toutes les transformations
│       ├── precheck-catalog.md        # Catalogue des pre-checks
│       └── sf-error-codes.md          # Classification des erreurs SF
│
├── packages/                          # Code source (généré par Claude Code)
│   ├── shared/
│   ├── extension/
│   └── webview/
│
└── resources/                         # Templates, icons, migrations
```

## Comment utiliser

### Option A : Session unique (recommandé pour les grosses machines)

Si tu as Claude Code avec un contexte large (200K tokens) :

```bash
# 1. Créer le projet et copier les fichiers de base
mkdir sandforge && cd sandforge
# Copier CLAUDE.md, docs/, et les fichiers bootstrap à la racine

# 2. Lancer Claude Code
claude

# 3. Première instruction :
# "Lis CLAUDE.md puis docs/phases/phase-00-bootstrap.md et exécute le setup complet du monorepo."

# 4. Ensuite, phase par phase :
# "Lis docs/phases/phase-01-shared.md et implémente tout le package shared."
# "Lis docs/phases/phase-02-core-engine.md et implémente le core engine."
# etc.
```

### Option B : Sessions multiples (recommandé)

```bash
# Session 1 : Bootstrap + Shared + Core
claude
> "Lis CLAUDE.md, puis exécute phase-00, phase-01 et phase-02 dans l'ordre."
> Attendre que ça finisse, vérifier le build

# Session 2 : WebView + Bridge + Monitor
claude
> "Lis CLAUDE.md, puis exécute phase-03, phase-04 et phase-05."

# Session 3 : Compare + PreCheck + Seed
claude
> "Lis CLAUDE.md, puis exécute phase-06, phase-07 et phase-08."

# Session 4 : Sync + Grappe
claude
> "Lis CLAUDE.md, puis exécute phase-09 et phase-10."

# Session 5 : DataOps + Automation + Reporting
claude
> "Lis CLAUDE.md, puis exécute phase-11, phase-12 et phase-13."

# Session 6 : Polish + Final validation
claude
> "Lis CLAUDE.md, puis exécute phase-14. Ensuite lance pnpm validate et corrige tout."
```

### Option C : Mode full autonome (expérimental)

```bash
claude --dangerously-skip-permissions
> "Tu es en mode agent autonome. Lis CLAUDE.md et le prompt complet dans docs/FULL-PROMPT.md. 
   Développe tout le projet phase par phase, du bootstrap au .vsix final. 
   Valide chaque phase (typecheck + lint + test + build) avant de passer à la suivante.
   Ne t'arrête que si un problème bloquant nécessite mon input.
   Log toutes tes décisions dans DECISIONS.md."
```

## Tips pour maximiser la performance de Claude Code

1. **`--dangerously-skip-permissions`** : Évite les prompts de confirmation à chaque commande shell
2. **CLAUDE.md court et précis** : Claude Code le relit souvent, il doit être concis
3. **Phase files self-contained** : Chaque phase a TOUT le contexte nécessaire (types référencés, patterns, etc.)
4. **Fixtures prêtes** : Les mock data dans `test/fixtures/` aident Claude Code à écrire les tests
5. **Un pattern = tous les modules** : Si Claude Code réussit Monitor, il répliquera le pattern pour les autres modules
6. **`pnpm validate` comme guard-rail** : Claude Code utilise cette commande comme feedback loop
