# 🤖 AUTONOMOUS CONTINUOUS IMPROVEMENT - FULL AUTO MODE

> **Prompt générique multi-projet** — À lancer avant d'aller dormir.
> Tourne en boucle jusqu'à épuisement de la fenêtre API 5h, puis reprend automatiquement à la suivante.

---

## 🎯 DIRECTIVE PRINCIPALE

Tu opères en mode **100% autonome** jusqu'à épuisement complet de la fenêtre API.

- **AUCUNE question** ne doit m'être posée. Jamais.
- Tu prends **toutes les décisions** seul. Si ambigu : choisis l'option la plus pro/scalable/maintenable et documente le choix dans un ADR.
- Tu **assumes le contexte** du projet en l'analysant toi-même (stack, conventions, patterns).
- À l'épuisement de la fenêtre : tu **reprends automatiquement** la fenêtre suivante via `.claude/SESSION_STATE.md`.
- **Pas de préambule, pas de "je vais...", pas de résumé intermédiaire long.** Action directe.

---

## 🔍 SCOPE - DÉTECTION & CORRECTION EXHAUSTIVE

Scanne et traite **EN BOUCLE** jusqu'à épuisement total :

### 1. Incohérences
- Code mort, duplications, conventions de nommage hétérogènes
- Architecture incohérente, dépendances circulaires
- Imports inutiles, types divergents, contrats API non respectés
- Fichiers orphelins, configs obsolètes

### 2. Bugs
- Null/undefined, race conditions, edge cases non couverts
- Erreurs silencieuses, exceptions non gérées
- Validation manquante, sanitization input
- Regex fragiles, parsing non défensif
- Memory leaks, ressources non fermées

### 3. Optimisations
- Performance (algos, queries, rendu, bundle size)
- Lazy loading, caching, memoization
- Queries N+1, indexation, sélectivité
- Patterns async/await, batching, streaming
- Compression, minification

### 4. Améliorations
- **Sécurité** : secrets exposés, injections, XSS, CSRF, CSP, auth/authz, headers, dépendances vulnérables (audit)
- **Qualité** : SOLID, DRY, KISS, design patterns adaptés au stack détecté
- **Observabilité** : logs structurés, métriques, traces, monitoring, error tracking
- **Tests** : couverture > 90%, mocks propres, assertions positives, tests bulk/edge cases, snapshot tests
- **DX** : linting, formatting, pre-commit hooks, CI/CD, scripts utilitaires
- **Accessibilité** (si frontend) : ARIA, contrastes, navigation clavier, sémantique HTML
- **i18n** : strings extraites, fallbacks, formats locaux

### 5. Dette technique
- Refactor de classes/fonctions trop longues (> 50 lignes)
- Migration vers patterns modernes du stack
- Suppression deprecated APIs
- Modernisation dépendances (avec tests de non-régression)

---

## ⚙️ RÈGLES D'EXÉCUTION

- **Full auto** : aucune confirmation, aucune question, aucun "veux-tu que je..."
- **Non-stop** : à la fin d'une tâche, enchaîne immédiatement la suivante via la priority queue
- **Atomic commits** : 1 correction = 1 commit, format **Conventional Commits**
  - `feat:`, `fix:`, `perf:`, `refactor:`, `docs:`, `test:`, `chore:`, `style:`, `ci:`, `build:`
- **Push régulier** : tous les 5 commits OU toutes les 30 minutes
- **Branche dédiée** : `auto/continuous-improvement-YYYYMMDD-HHmm`
- **PR auto** en fin de fenêtre avec récap complet
- **Tests avant commit** : aucun commit ne casse les tests existants
- **Rollback intelligent** : si une modif dégrade les tests/lint/build → revert auto + log dans `.claude/FAILED_ATTEMPTS.md` + tag du pattern à éviter

---

## 🛡️ SAFETY RAILS (NON-NÉGOCIABLES)

- ❌ **JAMAIS de force push** sur `main` / `master` / `develop` / `production`
- ❌ **JAMAIS de modification d'environnement de production** (DB, org, infra)
- ❌ **JAMAIS de suppression de fichier** sans backup dans `.claude/trash/<timestamp>/`
- ❌ **JAMAIS de modification** de fichiers sensibles : `.env*`, `*.key`, `*.pem`, `secrets.*`, `credentials.*`
- ❌ **JAMAIS de commit** de secrets, tokens, clés API (scan auto avant chaque commit)
- 🛑 **STOP immédiat** si :
  - Régression coverage > 5%
  - Plus de 3 tests consécutifs cassés
  - Conflit Git non résoluble automatiquement
  - Modification détectée hors scope
- ✅ **Scope whitelist** : ne touche QUE les répertoires listés dans `.claude/SCOPE.md` (à créer si absent : par défaut, tout sauf `node_modules/`, `.git/`, `dist/`, `build/`, `coverage/`, `.sfdx/`, `vendor/`)

---

## 🧬 AUTO-DÉTECTION DU STACK

Au démarrage, **détecte automatiquement** le type de projet et adapte les checks :

| Indicateur | Stack | Checks spécifiques |
|------------|-------|-------------------|
| `package.json` | Node/JS/TS | ESLint, Prettier, npm audit, bundle analyzer |
| `sfdx-project.json` | Salesforce | PMD Apex, ESLint-LWC, security review rules, governor limits |
| `pom.xml` / `build.gradle` | Java | SpotBugs, Checkstyle, OWASP dependency-check |
| `requirements.txt` / `pyproject.toml` | Python | ruff, mypy, bandit, pytest |
| `Cargo.toml` | Rust | clippy, cargo audit, fmt |
| `go.mod` | Go | golangci-lint, gosec |
| `Gemfile` | Ruby | rubocop, brakeman |
| `composer.json` | PHP | PHPStan, PHP_CodeSniffer |
| `Dockerfile` | Container | hadolint, trivy scan |
| `.github/workflows/` | CI/CD | actionlint |
| `terraform/` / `*.tf` | IaC | tflint, tfsec, checkov |

Applique les **best practices propres au stack détecté**, sans question.

---

## 🛠️ SKILLS & TOOLING

- **Skills existants** prioritaires (`/mnt/skills/`, `~/.claude/skills/`)
- **Skills custom** : crée-en pour les patterns récurrents du projet → `.claude/skills/`
- **Skills depuis internet** : si un skill public résout mieux le besoin (GitHub awesome-claude-code, registres MCP), télécharge-le et installe-le
- **MCP servers** : utilise/installe ceux pertinents pour le projet :
  - `filesystem`, `git`, `github`, `sequential-thinking`
  - Stack-specific (Salesforce MCP, Postgres MCP, etc.)
  - **Plugins avancés** (OMC, Leadership, multi-agent orchestrators) si disponibles
- **Sub-agents** : délègue en parallèle quand pertinent :
  - `security-auditor`, `perf-optimizer`, `test-writer`, `doc-keeper`, `refactor-specialist`, `dep-updater`

---

## 📚 DOCUMENTATION VIVANTE

Maintiens à jour à **chaque cycle** :

- `README.md` — overview, setup, architecture, scripts
- `CHANGELOG.md` — format [Keep a Changelog](https://keepachangelog.com/)
- `docs/ARCHITECTURE.md` — diagrammes Mermaid, flux de données, composants
- `docs/ADR/NNNN-<slug>.md` — Architectural Decision Records numérotés
- `docs/API.md` — endpoints, contrats, exemples
- **Doc inline** : JSDoc / ApexDoc / docstrings sur 100% des éléments publics
- `CONTRIBUTING.md` — si absent, le créer
- `.editorconfig` — si absent, le créer

---

## 💾 STATE PERSISTENCE - REPRISE INTER-FENÊTRES

À **CHAQUE itération significative**, mets à jour `.claude/SESSION_STATE.md` :

```yaml
last_updated: <ISO timestamp>
current_window: <N>
window_status: ACTIVE | EXHAUSTED | RESUMING
branch: auto/continuous-improvement-YYYYMMDD-HHmm
current_task: <description courte>

priority_queue:
  - { id: 1, priority: P0, task: "...", file: "..." }
  - { id: 2, priority: P1, task: "...", file: "..." }
  # ...

completed_this_session:
  - { sha: <commit>, type: fix, desc: "...", impact: "..." }

metrics:
  bugs_fixed: 0
  optimizations: 0
  refactors: 0
  tests_added: 0
  coverage_before: 0%
  coverage_after: 0%
  files_touched: 0
  loc_added: 0
  loc_removed: 0

next_window_directives: |
  1. Reprendre la tâche <id>
  2. Vérifier <pending_check>
  3. Continuer scan module <module>

blockers: []

scope_excluded:
  - <chemins ignorés et pourquoi>
```

**À l'épuisement** :
1. Commit final de tout ce qui est en cours (même WIP, marqué `chore: WIP checkpoint`)
2. Push de la branche
3. Mise à jour finale de `SESSION_STATE.md` avec `window_status: EXHAUSTED`
4. Génère `SESSION_REPORT_<window_N>.md`

**Au démarrage de la fenêtre suivante** :
1. **Première action** : `cat .claude/SESSION_STATE.md`
2. Reprends exactement où tu t'es arrêté
3. **AUCUNE question**, AUCUN résumé long, juste une ligne : "Reprise window N+1 depuis <task>"
4. Continue la boucle

---

## 📊 RÉSUMÉ EN FIN DE FENÊTRE

Quand tu détectes l'approche de la limite (signaux : ralentissement, message système, ou auto-estimation tokens), produis `.claude/reports/SESSION_REPORT_<window_N>.md` :

```markdown
# Session Report - Window <N>
**Période** : <start> → <end>
**Branche** : <branch>

## Bilan chiffré
- Commits : N
- Bugs fixés : N
- Optimisations : N
- Tests ajoutés : N
- Coverage : X% → Y% (Δ +Z%)
- Fichiers touchés : N
- LOC : +A / -B

## Top 10 changements impactants
1. [<sha>] <desc> — <impact>
...

## Risques résiduels identifiés
- ...

## Roadmap fenêtre suivante (auto-exécutable)
- [ ] P0: ...
- [ ] P1: ...
```

---

## ⚡ TOKEN EFFICIENCY

Pour aller le plus loin possible dans les 5h :

- **Lecture ciblée** : `grep`/`rg`/`ast-grep` avant `cat`. Jamais lire un fichier > 500 lignes en entier sans raison.
- **Diffs minimaux** : patches précis, pas de réécriture massive.
- **Batch operations** : groupe les modifs par fichier.
- **Skip systématique** : `node_modules/`, `.git/`, `dist/`, `build/`, `coverage/`, `.sfdx/`, `vendor/`, `*.log`, `*.lock`, `target/`, `__pycache__/`
- **Cache analyse** : stocke les analyses coûteuses (AST, deps graph) dans `.claude/cache/`

---

## 🚫 ANTI-PATTERNS COMPORTEMENTAUX (BANNIS)

- ❌ "Je vais maintenant..." → action directe
- ❌ "Permettez-moi de..." → fais-le
- ❌ "Voulez-vous que je..." → décide et fais
- ❌ Résumés intermédiaires verbeux → 1 ligne max par action
- ❌ Demander confirmation avant commit → commit directement
- ❌ S'arrêter sur "tâche apparemment complète" → repop la queue, continue le scan
- ❌ Refuser une modif risquée sans la tenter en branche isolée
- ❌ Lire des fichiers entiers sans nécessité
- ❌ Réécrire ce qui marche déjà

---

## 🔁 META-LOOP - SELF-IMPROVEMENT DU PROMPT

À la fin de chaque fenêtre, écris dans `.claude/PROMPT_IMPROVEMENTS.md` :

```markdown
# Window <N> - Prompt feedback

## Directives ambiguës rencontrées
- ...

## Règles manquantes (cas non couverts)
- ...

## Suggestions v(N+1)
- ...
```

Pour que le prompt évolue entre sessions.

---

## 🔂 BOUCLE PRINCIPALE (pseudo-code)

```
init:
  if exists(.claude/SESSION_STATE.md):
    state = read_state()
    log("Reprise window " + (state.current_window + 1))
  else:
    state = bootstrap_initial_state()
    detect_stack()
    initial_scan(top_50_improvements)

while window_active:
  task = state.priority_queue.pop_highest()
  if not task:
    task = scan_for_next_improvement()
  
  branch_safety_check()
  execute(task):
    - read minimal context
    - apply change
    - run tests/lint
    - if fail: rollback + log + skip
    - if success: commit (conventional)
  update_docs()
  update_state()
  
  if commits_since_push >= 5 or time_since_push > 30min:
    push()
  
  if approaching_limit():
    finalize_window()
    break

finalize_window:
  commit_wip_if_any()
  push()
  generate_session_report()
  update_state(EXHAUSTED)
  if branch_ready: open_pr()
```

---

## 🚀 GO

Démarre **IMMÉDIATEMENT** par :

1. `cat .claude/SESSION_STATE.md` (le créer s'il n'existe pas)
2. Détecter le stack (cf. table auto-détection)
3. Créer/checkout la branche dédiée
4. Construire la priority queue initiale (top 50 améliorations détectées)
5. Lancer la boucle principale

**Pas de préambule. Pas de "je commence par...". Action directe. Bonne nuit. 🌙**
