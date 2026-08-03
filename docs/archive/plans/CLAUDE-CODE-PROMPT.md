# 🔥 MEGA PROMPT CLAUDE CODE — SandForge Ultimate Intelligence Upgrade

> **Copier-coller ce prompt dans Claude Code pour lancer l'upgrade complet.**
> **Prérequis** : Être dans le répertoire `sandforge/` avec le projet existant.

---

## PROMPT

```
Tu es un agent autonome expert en TypeScript, VSCode Extensions, React, Salesforce APIs, UX Design et IA.

## CONTEXTE

Tu travailles sur **SandForge**, une extension VSCode ETL tout-en-un pour les sandboxes Salesforce. Le projet est à 80% de la spec (score 7.5/10). Lis CLAUDE.md pour les règles du projet, puis AUDIT.md pour l'état actuel.

Le projet est un monorepo pnpm avec 3 packages :
- `packages/shared` — Types, Zod schemas, constantes
- `packages/extension` — Extension VSCode (Node.js, esbuild)  
- `packages/webview` — React app (Vite, Tailwind, Shadcn/ui)

**État actuel** : 3 197 tests, build green, .vsix généré. Le bridge Extension↔WebView est connecté via ExtensionHandlers.ts (78KB). L'AI Assistant est intégré. Les 6 modules métier sont implémentés. 27 composants UI dans components/ui/. CommandPalette existe déjà. Home page existe. Welcome/Onboarding 3 steps existe.

## MISSION

Transformer SandForge en un outil **intelligent, performant et visuellement exceptionnel** en implémentant les améliorations suivantes, **dans cet ordre exact**. Chaque phase doit passer `pnpm validate` avant de passer à la suivante.

---

## ═══════════════════════════════════════════
## PHASE A — RÉSILIENCE ET FIABILITÉ
## ═══════════════════════════════════════════

### A1. CheckpointManager amélioré
**Fichier** : `packages/extension/src/core/engine/CheckpointManager.ts`
- Auto-save de l'état toutes les 30s pendant les opérations longues
- Stockage via ConfigStore avec TTL de 24h et compression JSON
- Interface : `save(operationId, state)`, `load(operationId)`, `hasCheckpoint(operationId)`, `clear(operationId)`, `listAll()`, `getExpired()`
- Au redémarrage VSCode, si un checkpoint existe → envoyer message `recovery:prompt` à la WebView
- Afficher un toast avec "Reprendre l'opération interrompue ?" + boutons Reprendre/Ignorer
- Cleanup automatique des checkpoints expirés au démarrage
- Tests : CheckpointManager.test.ts avec mock ConfigStore, tests TTL, tests recovery

### A2. TokenRefresher avec monitoring
**Fichier** : `packages/extension/src/core/connection/TokenRefresher.ts`
- Refresh proactif du token OAuth 5 minutes avant expiration
- Utilise le `refreshToken` stocké dans SecretVault
- Circuit breaker intégré : si 3 refresh échouent → déconnecter l'org + notification
- Événement `token:refreshed` et `token:expired` via EventEmitter
- Dashboard de santé des tokens dans le Monitor (temps restant, dernière refresh, échecs)
- Tests : TokenRefresher.test.ts avec mock SecretVault et timers

### A3. Mode Offline complet
**Fichier** : `packages/extension/src/core/connection/OfflineManager.ts`
- Détection perte de connexion SF via HealthProbe (ping toutes les 30s)
- Queue d'opérations en attente (max 50, persistée dans ConfigStore)
- Exécution automatique FIFO à la reconnexion avec progress bar
- Notification WebView du statut online/offline avec indicateur visuel permanent
- Mode dégradé : permettre la consultation des rapports, édition de templates, configuration
- Sync automatique des changements de config à la reconnexion
- Tests : OfflineManager.test.ts avec simulation perte/reprise connexion

### A4. Connection Resilience avancée
**Modifier** : `packages/extension/src/core/connection/ConnectionPool.ts`
- Pool de connexions jsforce avec keep-alive et health check
- Max 5 connexions simultanées par org, recyclage toutes les 15min
- Timeout et cleanup automatique des connexions idle (> 5min)
- Retry automatique avec exponential backoff sur erreurs réseau
- Métriques de latence par org (min, max, avg, p95, p99)
- Tests avec mock connections et simulation de pannes

### A5. Tests d'intégration E2E Bridge
**Créer** : `packages/extension/src/bridge/__integration__/BridgeE2E.test.ts`
- Tester le flux complet : WebView envoie message → ExtensionHandlers traite → réponse renvoyée
- Couvrir : org:connect, org:disconnect, seed:execute, sync:start, monitor:refresh, compare:execute, backup:execute, pipeline:run
- Utiliser des mocks jsforce réalistes avec données SF simulées
- Tester les cas d'erreur : timeout, auth expired, rate limit, network error

### A6. Couverture > 85% partout
- Augmenter la couverture de `DataQualityScanner.ts` de 61% à > 85%
- Augmenter la couverture de `SyncPage.tsx` de 63% à > 80%
- Augmenter la couverture de `TransformPipeline.ts` de 75% à > 85%
- Ajouter les branches manquantes dans les tests existants

**Validation Phase A** : `pnpm validate` → 0 errors, couverture globale > 85%

---

## ═══════════════════════════════════════════
## PHASE B — INTELLIGENCE IA AVANCÉE
## ═══════════════════════════════════════════

### B1. Natural Language to SOQL
**Fichier** : `packages/extension/src/modules/ai/NL2SOQL.ts`
- L'utilisateur tape en français ou anglais : "Tous les comptes créés ce mois avec plus de 5 contacts"
- L'IA génère le SOQL correspondant en utilisant le schema cache pour valider objets/champs
- Preview du SOQL avec syntax highlighting avant exécution
- Historique des requêtes NL avec possibilité de les sauvegarder en favoris
- Auto-complétion des noms d'objets et champs pendant la saisie
- Interface : `generateSOQL(naturalLanguage: string, orgId: string): Promise<{ soql: string; explanation: string; confidence: number; alternatives?: string[] }>`
- Tests avec 15+ cas variés (simple, jointures, agrégations, sous-requêtes, filtres complexes, dates relatives)

### B2. AI Error Resolution
**Fichier** : `packages/extension/src/modules/ai/ErrorResolver.ts`
- Quand une erreur SF survient (FIELD_CUSTOM_VALIDATION_EXCEPTION, INSUFFICIENT_ACCESS, DUPLICATE_VALUE, etc.)
- L'IA analyse le contexte complet (objet, champs, opération, permissions, validation rules, triggers)
- Suggère des solutions classées par probabilité de succès
- Auto-fix quand possible (ex: retry avec batch size réduit, skip du record, mapping alternatif)
- Apprentissage : mémoriser les résolutions réussies pour les suggérer en premier la prochaine fois
- Interface : `resolveError(error: SalesforceError, context: OperationContext): Promise<ErrorResolution>`
- `ErrorResolution` : `explanation`, `suggestions[]`, `autoFixable`, `autoFixAction`, `confidence`, `relatedDocs[]`
- Tests avec les 25 erreurs SF les plus courantes

### B3. AI Persona pour Seed
**Modifier** : `packages/extension/src/modules/seed/AIDataGenerator.ts`
- Ajouter un champ `persona` dans la config de génération
- 10 personas built-in :
  - "Assureur français" → noms FR, SIRET, contrats assurance
  - "Hôpital américain" → noms US, codes médicaux, HIPAA-compliant
  - "E-commerce B2C" → produits, commandes, avis clients
  - "Banque européenne" → IBAN, BIC, transactions, compliance
  - "Startup SaaS" → subscriptions, MRR, churn, features
  - "Immobilier" → biens, mandats, visites, compromis
  - "Éducation" → étudiants, cours, notes, diplômes
  - "Logistique" → colis, entrepôts, tournées, tracking
  - "Ressources humaines" → employés, congés, paie, évaluations
  - "ONG/Association" → donateurs, campagnes, bénévoles, projets
- Persona custom : l'utilisateur décrit son métier en texte libre
- La persona influence les noms, adresses, montants, types de produits, vocabulaire
- Tests avec 3 personas différentes + persona custom

### B4. Smart Suggestions contextuelles
**Fichier** : `packages/extension/src/modules/ai/SmartSuggestions.ts`
- Après un Compare : suggérer quels composants déployer et dans quel ordre, avec estimation d'impact
- Après un Seed : suggérer des améliorations au template basées sur les erreurs rencontrées
- Après un Sync : suggérer des optimisations de mapping et de batch size
- Après un Monitor : suggérer des actions correctives basées sur les alertes
- Après un DataOps : suggérer des règles d'anonymisation manquantes pour la compliance
- Proactive : analyser les patterns d'utilisation et suggérer des automatisations
- Interface : `suggest(module: string, context: Record<string, unknown>): Promise<Suggestion[]>`
- Chaque suggestion a : `title`, `description`, `impact`, `confidence`, `action`, `dismissable`
- Tests par module avec contextes variés

### B5. AI Pipeline Generator
**Fichier** : `packages/extension/src/modules/ai/PipelineGenerator.ts`
- L'utilisateur décrit un workflow en langage naturel :
  "Chaque nuit à 2h, backup les comptes et contacts de prod, anonymise les emails, puis seed 1000 records de test dans dev1"
- L'IA génère un pipeline complet avec tous les steps configurés
- Preview visuelle du pipeline généré avant validation
- Possibilité d'éditer chaque step après génération
- Interface : `generatePipeline(description: string, availableOrgs: OrgInfo[]): Promise<PipelineConfig>`
- Tests avec 5 descriptions de complexité croissante

### B6. Data Anomaly Detection
**Fichier** : `packages/extension/src/modules/ai/AnomalyDetector.ts`
- Scanner les données d'un objet SF pour détecter les anomalies :
  - Valeurs aberrantes (outliers statistiques)
  - Patterns inhabituels (ex: 1000 records créés en 1 minute)
  - Données incohérentes (ex: date de naissance dans le futur)
  - Champs vides qui ne devraient pas l'être
  - Doublons potentiels (fuzzy matching sur nom + email)
- Rapport visuel avec graphiques de distribution
- Interface : `detectAnomalies(orgId: string, objectName: string): Promise<AnomalyReport>`
- Tests avec datasets synthétiques contenant des anomalies connues

### B7. AI-Powered Schema Advisor
**Fichier** : `packages/extension/src/modules/ai/SchemaAdvisor.ts`
- Analyser le schema d'une org et suggérer des améliorations :
  - Champs inutilisés (0 records avec valeur)
  - Index manquants sur les champs fréquemment filtrés
  - Validation rules contradictoires
  - Champs dupliqués entre objets
  - Relations manquantes (ex: lookup qui devrait être master-detail)
- Score de santé du schema (0-100)
- Interface : `analyzeSchema(orgId: string): Promise<SchemaAdvice>`
- Tests avec schemas réalistes

**Validation Phase B** : `pnpm validate` + vérifier que l'AI fonctionne avec une clé API mock

---

## ═══════════════════════════════════════════
## PHASE C — PERFORMANCE ET SCALABILITÉ
## ═══════════════════════════════════════════

### C1. Streaming Bulk API
**Modifier** : `packages/extension/src/core/engine/BulkApiManager.ts`
- Remplacer le chargement en mémoire par du streaming Node.js Transform
- Backpressure automatique quand le consumer est lent
- Mémoire constante quel que soit le volume (objectif : < 100MB pour 1M records)
- Progress reporting en temps réel (records/sec, ETA)
- Tests avec mock streams de 100K+ records

### C2. Auto Batch Size Optimizer
**Fichier** : `packages/extension/src/core/engine/BatchOptimizer.ts`
- Analyser le describe de l'objet (nombre de champs, taille moyenne, triggers actifs, flows actifs)
- Calculer la taille de batch optimale (entre 200 et 10 000)
- Ajuster dynamiquement pendant l'exécution basé sur les temps de réponse et les erreurs
- Mémoriser les batch sizes optimaux par objet pour les prochaines exécutions
- Interface : `calculateOptimalBatchSize(objectDescribe: DescribeResult, history?: BatchHistory): number`
- Tests avec différents profils d'objets (simple, complexe, avec triggers, sans triggers)

### C3. Code Splitting WebView
**Modifier** : `packages/webview/vite.config.ts` et les routes
- Ajouter React.lazy pour chaque page de module (Seed, Sync, Monitor, Compare, DataOps, Automation, Reports, Settings)
- Suspense avec skeleton loading animé (utiliser le composant Skeleton existant)
- Précharger le module suivant probable basé sur la navigation (prefetch on hover)
- Vérifier que le bundle initial < 500KB, chaque chunk < 200KB

### C4. Virtual Scrolling pour grandes tables
**Modifier** : `packages/webview/src/components/ui/DataTable.tsx`
- Intégrer TanStack Virtual pour le rendu de 100K+ lignes
- Scroll infini avec chargement progressif
- Tri et filtrage côté client sans re-render complet
- Export CSV/JSON depuis la table virtuelle
- Tests avec 10K lignes simulées

### C5. Web Workers pour calculs lourds
**Créer** : `packages/webview/src/workers/`
- `diffWorker.ts` — Calcul de diff entre 2 datasets en background
- `chartWorker.ts` — Préparation des données pour les graphiques D3/Recharts
- `searchWorker.ts` — Recherche full-text dans les données locales
- Communication via postMessage typé
- Fallback synchrone si Web Workers non disponibles
- Tests unitaires pour chaque worker

### C6. Métriques de performance intégrées
**Fichier** : `packages/extension/src/core/engine/PerformanceTracker.ts`
- Mesurer automatiquement : durée opération, records/sec, API calls, mémoire utilisée
- Historique des performances par opération et par objet
- Détection de dégradation (alerte si performance < 80% de la moyenne)
- Dashboard de performance dans le Monitor
- Interface : `track(operationId: string): PerformanceMetrics`
- Tests avec mock timers

**Validation Phase C** : `pnpm validate` + bundle size < 5MB extension, < 2MB webview

---

## ═══════════════════════════════════════════
## PHASE D — SÉCURITÉ ET COMPLIANCE
## ═══════════════════════════════════════════

### D1. CSP Strict
**Modifier** : `packages/extension/src/providers/WebviewPanelManager.ts`
- Ajouter Content-Security-Policy dans le HTML de la WebView
- Générer un nonce unique par session pour scripts et styles
- Bloquer toute ressource externe non autorisée
- Tests : vérifier que le CSP est présent et correct dans le HTML généré

### D2. Détection PII automatique
**Fichier** : `packages/extension/src/core/precheck/PIIDetector.ts`
- Scanner les champs d'un objet SF pour détecter les PII :
  - Email, Phone, SSN, Address, Birthdate, National ID, Credit Card, IBAN
  - Patterns regex + noms de champs courants (PersonEmail, MobilePhone, etc.)
  - Détection par contenu (échantillonnage de 100 records)
- Classification : PII, PHI (santé), PCI (paiement), Confidentiel
- Alerter avant toute opération sur des champs PII sans anonymisation
- Intégrer dans le PreCheck Engine comme check automatique
- Interface : `detectPII(fields: FieldDescribe[], sampleData?: Record<string, unknown>[]): PIIField[]`
- Tests avec des describes et données réalistes

### D3. Audit Trail enrichi avec export
**Modifier** : `packages/extension/src/core/reporting/AuditLogger.ts`
- Ajouter : user identity, durée opération, volume traité, erreurs rencontrées
- Chaque entrée : timestamp, module, action, orgId, userId, duration, recordCount, status, details
- Export en CSV, JSON et PDF
- Rétention configurable (7j, 30j, 90j, 1an) avec cleanup automatique
- Recherche et filtrage dans l'historique d'audit
- Tests d'export dans les 3 formats

### D4. Encryption at rest
**Fichier** : `packages/extension/src/core/storage/EncryptionManager.ts`
- Chiffrer les données sensibles stockées localement (tokens, configs avec credentials)
- Utiliser AES-256-GCM avec clé dérivée du SecretStorage VSCode
- Transparent pour les consommateurs (encrypt/decrypt automatique)
- Interface : `encrypt(data: string): string`, `decrypt(data: string): string`
- Tests avec données variées

### D5. Production Safety Guard
**Fichier** : `packages/extension/src/core/precheck/ProductionGuard.ts`
- Double confirmation obligatoire pour toute opération d'écriture sur une org Production
- Afficher un résumé de l'impact avant confirmation (nombre de records, objets touchés)
- Option "require approval" : un autre membre de l'équipe doit approuver
- Blocage automatique des opérations destructives (DELETE, HARD DELETE) sur Prod
- Logging renforcé de toutes les opérations Prod
- Tests avec simulation d'opérations sur différents safety tiers

**Validation Phase D** : `pnpm validate` + vérifier CSP dans le HTML

---

## ═══════════════════════════════════════════
## PHASE E — UI/UX DESIGN PREMIUM
## ═══════════════════════════════════════════

### E1. Home Page Dashboard enrichi
**Modifier** : `packages/webview/src/pages/Home/HomePage.tsx`
- **Section Hero** : Greeting personnalisé ("Bonjour [user], voici votre tableau de bord")
- **KPI Cards animées** : Orgs connectées, Opérations aujourd'hui, Taux de succès, API usage
- **Graphique d'activité** : Sparkline des opérations des 7 derniers jours (Recharts)
- **Quick Actions** avec icônes et descriptions : Quick Seed, Quick Sync, Refresh Monitor, Run Pipeline
- **Orgs Health** : Mini-cards avec indicateur de santé par org (vert/jaune/rouge)
- **Recent Operations** : Timeline avec statut, durée, module, org
- **Alertes actives** : Bannière si des alertes Monitor sont en cours
- **Getting Started** : Guide interactif pour les nouveaux utilisateurs (si < 3 opérations)
- Animations Framer Motion sur les transitions et les KPI

### E2. Micro-interactions et animations
**Créer** : `packages/webview/src/components/ui/Animations.tsx`
- Composants d'animation réutilisables :
  - `FadeIn` — Apparition progressive avec direction configurable
  - `SlideIn` — Glissement depuis un bord
  - `ScaleIn` — Zoom depuis le centre
  - `Stagger` — Animation séquentielle d'une liste d'éléments
  - `CountUp` — Animation de compteur numérique (pour les KPI)
  - `Pulse` — Pulsation pour les éléments en cours de chargement
  - `Confetti` — Célébration quand une opération réussit (optionnel, activable dans settings)
- Utiliser Framer Motion pour toutes les animations
- Respecter `prefers-reduced-motion` pour l'accessibilité
- Tests : vérifier le rendu avec et sans animations

### E3. Thème et Design System enrichi
**Modifier** : `packages/webview/src/styles/design-system.css`
- Ajouter des tokens pour :
  - Glassmorphism : `backdrop-filter: blur(10px)` pour les overlays
  - Gradient subtils pour les headers de modules (couleur du module → transparent)
  - Ombres portées améliorées avec 3 niveaux (sm, md, lg)
  - Micro-ombres internes pour les inputs focus
- Ajouter des classes utilitaires :
  - `.sf-glass` — Effet glassmorphism
  - `.sf-gradient-[module]` — Gradient par module (seed, sync, monitor, etc.)
  - `.sf-glow-[color]` — Lueur subtile autour des éléments importants
  - `.sf-shimmer` — Effet de brillance pour les éléments premium
- Ajouter un mode "Compact" pour les écrans petits (réduire les paddings de 25%)

### E4. Composants UI manquants
**Créer dans** : `packages/webview/src/components/ui/`
- `Stepper.tsx` — Indicateur de progression multi-étapes (pour les wizards)
- `Timeline.tsx` — Timeline verticale pour l'historique des opérations
- `Accordion.tsx` — Sections collapsibles avec animation
- `Drawer.tsx` — Panneau latéral glissant (pour les détails)
- `ContextMenu.tsx` — Menu contextuel au clic droit
- `Breadcrumb.tsx` — Fil d'Ariane pour la navigation
- `Avatar.tsx` — Avatar avec initiales ou image (pour les orgs)
- `StatusDot.tsx` — Indicateur de statut coloré (online/offline/warning)
- `Chip.tsx` — Tag/chip pour les filtres et catégories
- `Divider.tsx` — Séparateur avec label optionnel
- `CopyButton.tsx` — Bouton copier avec feedback visuel
- `JsonViewer.tsx` — Affichage JSON avec syntax highlighting et collapse
- Chaque composant avec tests et JSDoc

### E5. Recherche globale Cmd+K améliorée
**Modifier** : `packages/webview/src/components/CommandPalette/CommandPalette.tsx`
- Ajouter des catégories de résultats avec icônes :
  - 🔌 Orgs — recherche dans les orgs connectées
  - 📦 Objets SF — recherche dans le schema cache
  - 📋 Templates — recherche dans les templates seed/sync
  - ⚡ Pipelines — recherche dans les pipelines
  - 📊 Rapports — recherche dans les rapports générés
  - ⚙️ Settings — recherche dans les paramètres
  - 🤖 AI — commandes IA (NL→SOQL, suggestions, etc.)
  - 📖 Aide — recherche dans la documentation
- Raccourcis clavier affichés à droite de chaque résultat
- Historique des recherches récentes
- Actions rapides : "Seed 1000 Accounts on Dev1", "Compare Prod vs UAT"
- Fuzzy search avec scoring de pertinence

### E6. Favoris et raccourcis
**Créer** : `packages/webview/src/stores/useFavoritesStore.ts`
- Store Zustand pour les favoris avec catégories
- Marquer en favori : templates, orgs, pipelines, configs, requêtes SOQL
- Section "⭐ Favoris" dans la sidebar avec drag & drop pour réordonner
- Raccourcis clavier personnalisables pour les favoris (Ctrl+1 à Ctrl+9)
- Persistance via ConfigStore
- Tests du store et de la sidebar

### E7. Undo/Redo universel
**Créer** : `packages/webview/src/hooks/useUndoRedo.ts`
- Hook React générique pour undo/redo sur n'importe quel state
- History stack avec max 50 entrées et compression des états similaires
- Ctrl+Z / Ctrl+Y (Cmd+Z / Cmd+Y sur Mac)
- Indicateur visuel "Undo disponible" dans la TopBar
- Intégrer dans : SeedWizard, SyncWizard, PipelineBuilder, FieldMappingCanvas
- Tests du hook avec différents types de state

### E8. Drag & Drop avancé
**Créer** : `packages/webview/src/hooks/useDragDrop.ts`
- Hook pour drag & drop natif HTML5
- Utiliser dans :
  - Pipeline Builder : réordonner les steps
  - Field Mapping : mapper les champs par drag & drop
  - Sidebar Favoris : réordonner les favoris
  - Object Set Editor : réordonner les objets
- Feedback visuel pendant le drag (ghost element, drop zone highlight)
- Support tactile pour les écrans tactiles
- Tests avec simulation d'événements drag

### E9. Notifications enrichies
**Modifier** : `packages/webview/src/layouts/NotificationCenter/NotificationCenter.tsx`
- Catégories de notifications : Info, Success, Warning, Error, AI Suggestion
- Actions contextuelles sur chaque notification (View, Retry, Dismiss, Snooze)
- Groupement des notifications similaires ("3 opérations terminées")
- Son optionnel pour les alertes critiques (configurable dans Settings)
- Badge de compteur sur l'icône de notification dans la TopBar
- Historique des notifications avec recherche et filtrage
- Tests avec différents types de notifications

### E10. Dark/Light theme toggle
**Modifier** : `packages/webview/src/hooks/useTheme.ts`
- Détecter automatiquement le thème VSCode (dark/light/high-contrast)
- Adapter les couleurs du design system en conséquence
- Supporter les 3 modes : Auto (suit VSCode), Dark forcé, Light forcé
- Tester le rendu dans les 3 modes

**Validation Phase E** : `pnpm validate` + vérifier visuellement les animations et le design

---

## ═══════════════════════════════════════════
## PHASE F — AUTOMATISATION AVANCÉE
## ═══════════════════════════════════════════

### F1. Pipeline Marketplace
**Créer** : `packages/extension/src/modules/automation/PipelineMarketplace.ts`
- Catalogue de 15 templates de pipelines built-in :
  1. Sandbox Refresh Post-Processing
  2. Nightly Data Backup
  3. Weekly Data Quality Scan
  4. GDPR Compliance Check
  5. New Developer Onboarding (seed dev data)
  6. Release Validation (compare + precheck)
  7. Data Migration Dry Run
  8. Mass Anonymization
  9. Incremental Sync (daily)
  10. Full Org Backup
  11. Schema Drift Detection
  12. API Limit Monitoring
  13. Stale Data Cleanup
  14. Cross-Org Data Sync
  15. Emergency Rollback
- Import/Export de pipelines en JSON avec validation Zod
- Rating et description pour chaque template
- Catégories : Environment, Migration, Maintenance, Compliance, Monitoring
- Tests d'import/export et de validation

### F2. Pipeline Dry Run
**Modifier** : `packages/extension/src/modules/automation/PipelineOrchestrator.ts`
- Mode "Dry Run" qui simule l'exécution complète sans aucune écriture SF
- Génère un rapport détaillé de ce qui SERAIT fait :
  - Nombre de records affectés par step
  - API calls estimés
  - Durée estimée
  - Risques identifiés
- Diff visuel entre l'état actuel et l'état après exécution
- Tests avec pipelines complexes

### F3. Approval Gates
**Créer** : `packages/extension/src/modules/automation/ApprovalGate.ts`
- Step spécial qui pause le pipeline et attend une approbation humaine
- Notification VSCode + toast WebView avec boutons Approve/Reject
- Timeout configurable (1h, 4h, 24h, 7j)
- Historique des approbations avec qui a approuvé et quand
- Support multi-approbateur (ex: 2 sur 3 doivent approuver)
- Tests avec simulation d'approbation/rejet/timeout

### F4. Triggers intelligents
**Modifier** : `packages/extension/src/modules/automation/TriggerEngine.ts`
- Nouveaux types de triggers :
  - `on_sandbox_refresh` — Détecte quand une sandbox est refresh
  - `on_deployment` — Détecte un déploiement de métadonnées
  - `on_api_limit_threshold` — Quand les API limits dépassent un seuil
  - `on_schema_change` — Quand le schema d'un objet change
  - `on_data_quality_drop` — Quand le score de qualité baisse
  - `on_error_spike` — Quand le taux d'erreur augmente soudainement
- Conditions composées (AND/OR) entre triggers
- Tests pour chaque type de trigger

### F5. Pipeline Versioning
**Créer** : `packages/extension/src/modules/automation/PipelineVersioning.ts`
- Historique des versions de chaque pipeline (Git-like)
- Diff entre 2 versions d'un pipeline
- Rollback à une version précédente
- Tags et annotations sur les versions
- Interface : `saveVersion(pipelineId, config)`, `listVersions(pipelineId)`, `diff(v1, v2)`, `rollback(pipelineId, version)`
- Tests avec historique de versions

### F6. Scheduled Operations Dashboard
**Créer** : `packages/webview/src/pages/Automation/ScheduleDashboard.tsx`
- Vue calendrier des opérations planifiées (jour/semaine/mois)
- Timeline des prochaines exécutions
- Historique des exécutions passées avec statut
- Possibilité de pause/resume/cancel depuis le dashboard
- Tests avec mock data

**Validation Phase F** : `pnpm validate`

---

## ═══════════════════════════════════════════
## PHASE G — ONBOARDING ET EXPÉRIENCE PREMIER CONTACT
## ═══════════════════════════════════════════

### G1. Onboarding interactif enrichi
**Modifier** : `packages/webview/src/pages/Welcome/WelcomePage.tsx`
- 5 étapes au lieu de 3 :
  1. **Bienvenue** — Animation de logo SandForge + tagline + choix de langue
  2. **Connecter une org** — Formulaire inline avec test de connexion en temps réel
  3. **Explorer les modules** — Carrousel interactif des 6 modules avec mini-démo
  4. **Configurer l'IA** — Setup optionnel de la clé API avec test
  5. **Premier pas** — Suggestion d'action basée sur le type d'org (dev → seed, prod → monitor)
- Progress bar animée en haut
- Possibilité de skip chaque étape
- "Don't show again" avec persistance
- Animations Framer Motion entre les étapes

### G2. Guided Tours par module
**Créer** : `packages/webview/src/components/GuidedTour/GuidedTour.tsx`
- Système de tour guidé avec spotlight sur les éléments UI
- Un tour par module (6 tours) + 1 tour général
- Chaque tour : 5-8 étapes avec tooltip positionné et flèche
- Boutons : Suivant, Précédent, Passer, Terminer
- Persistance de la progression (ne pas remontrer les tours terminés)
- Déclenchement : première visite d'un module OU bouton "?" dans la TopBar
- Tests avec simulation de navigation

### G3. Hints contextuels
**Modifier** : `packages/webview/src/components/HintBubble/HintBubble.tsx`
- Bulles d'aide contextuelles sur les champs de configuration complexes
- Lien vers la documentation Salesforce quand pertinent
- Exemples de valeurs pour chaque champ
- "Ne plus afficher" par hint avec persistance
- Animations d'apparition subtiles

### G4. What's New amélioré
**Modifier** : `packages/webview/src/pages/Welcome/WhatsNewPage.tsx`
- Affichage automatique après mise à jour de l'extension
- Changelog visuel avec icônes par catégorie (Feature, Fix, Improvement)
- Screenshots/GIFs des nouvelles fonctionnalités
- Bouton "Essayer maintenant" qui navigue vers la feature
- Lien vers le CHANGELOG.md complet

### G5. Empty States engageants
**Modifier** : `packages/webview/src/components/ui/EmptyState.tsx`
- Illustrations SVG personnalisées par module (pas juste du texte)
- Message d'encouragement contextuel
- Bouton d'action principal (ex: "Créer votre premier template" pour Seed)
- Lien vers la documentation ou le tour guidé
- Animations subtiles sur l'illustration

### G6. Help Center intégré
**Modifier** : `packages/webview/src/pages/Help/HelpPage.tsx`
- Sections :
  - **Getting Started** — Guide pas à pas pour chaque module
  - **FAQ** — Questions fréquentes avec recherche
  - **Keyboard Shortcuts** — Liste complète des raccourcis
  - **Troubleshooting** — Problèmes courants et solutions
  - **API Reference** — Documentation des commandes CLI
  - **Release Notes** — Historique des versions
- Recherche full-text dans l'aide
- Liens vers la documentation Salesforce
- Tests de rendu

**Validation Phase G** : `pnpm validate`

---

## ═══════════════════════════════════════════
## PHASE H — EXTENSIBILITÉ ET ÉCOSYSTÈME
## ═══════════════════════════════════════════

### H1. Import SFDMU
**Créer** : `packages/extension/src/modules/migration/SfdmuImporter.ts`
- Lire un fichier `export.json` de SFDMU et le convertir en SyncConfig SandForge
- Mapping complet : ScriptObject → SyncObjectConfig, externalId → ExternalIdManager, fieldMapping → FieldMapping, valuesMapping → TransformRule, excludedFields → exclusion, master/child → DependencyEdge
- Wizard d'import dans la WebView avec preview du mapping
- Validation et avertissements sur les features non supportées
- Tests avec un export.json réaliste

### H2. Import Gearset
**Créer** : `packages/extension/src/modules/migration/GearsetImporter.ts`
- Importer un rapport de comparaison Gearset
- Mapper les composants vers le format Compare interne
- Tests avec un rapport Gearset simulé

### H3. Import/Export CSV/JSON universel
**Créer** : `packages/extension/src/modules/migration/UniversalImporter.ts`
- Wizard d'import pour transformer n'importe quel CSV/JSON en config de sync
- Auto-détection des colonnes et mapping intelligent vers des champs SF
- Preview des données avec validation
- Export de n'importe quelle config en CSV/JSON
- Tests avec différents formats

### H4. Plugin API
**Créer** : `packages/extension/src/core/plugins/PluginManager.ts`
- Interface `SandForgePlugin` avec extension points :
  - `seedStrategies` — Nouvelles stratégies de génération
  - `transformers` — Nouvelles transformations
  - `preChecks` — Nouveaux checks
  - `pipelineSteps` — Nouveaux steps de pipeline
  - `exportFormats` — Nouveaux formats d'export
  - `grappeStrategies` — Nouvelles stratégies de partitionnement
- Chargement dynamique des plugins depuis un dossier `.sandforge/plugins/`
- Validation Zod du manifest de plugin
- Tests avec un plugin mock

### H5. CI/CD Examples
**Créer** : `ci-examples/`
- `github-actions.yml` — Workflow GitHub Actions complet
- `gitlab-ci.yml` — Pipeline GitLab CI
- `Jenkinsfile` — Pipeline Jenkins
- `azure-pipelines.yml` — Pipeline Azure DevOps
- Chaque exemple : seed + sync + backup + health check + report
- README.md expliquant chaque exemple

### H6. .sandforge.example.json
**Créer** à la racine du projet
- Fichier de configuration d'équipe complet et documenté
- Tous les champs avec commentaires explicatifs
- Sections : team, orgs, seed, sync, automation, grappe, security, migration
- Validation par le schema Zod existant

### H7. Telemetry opt-in
**Créer** : `packages/extension/src/core/telemetry/TelemetryService.ts`
- Collecte anonyme et opt-in des métriques d'usage :
  - Modules les plus utilisés
  - Taille moyenne des opérations
  - Erreurs les plus fréquentes
  - Temps moyen par opération
- Aucune donnée personnelle ou de contenu
- Toggle dans les Settings avec explication claire
- Tests avec mock

**Validation Phase H** : `pnpm validate`

---

## ═══════════════════════════════════════════
## PHASE I — i18n, ACCESSIBILITÉ ET BRANDING
## ═══════════════════════════════════════════

### I1. Ajouter 4 langues
**Créer dans** : `packages/webview/src/i18n/locales/`
- `de.json` (Allemand) — Traduction complète de toutes les clés
- `es.json` (Espagnol) — Traduction complète
- `ja.json` (Japonais) — Traduction complète
- `pt-BR.json` (Portugais Brésil) — Traduction complète
- Ajouter les locales dans la config i18next
- Sélecteur de langue dans Settings et dans l'onboarding
- Tests : vérifier que toutes les clés existent dans chaque locale

### I2. Accessibilité WCAG 2.1 AA
- Ajouter `aria-label` sur tous les boutons d'action et icônes
- Ajouter `role` sur les sections de navigation (nav, main, aside, complementary)
- Vérifier le contraste des couleurs (ratio 4.5:1 minimum pour le texte)
- Support complet clavier : Tab, Shift+Tab, Enter, Escape, Arrow keys
- Focus visible sur tous les éléments interactifs
- Skip links pour la navigation au clavier
- Screen reader friendly : descriptions alternatives pour les graphiques
- Tests d'accessibilité avec @testing-library/jest-dom (toHaveAccessibleName, etc.)

### I3. Branding cohérent
**Créer** : `packages/webview/src/components/ui/Logo.tsx`
- Composant Logo SVG SandForge (enclume + particules de sable/étincelles)
- 3 tailles : small (24px), medium (48px), large (96px)
- Version monochrome pour les contextes sombres
- Animation subtile au hover (particules qui bougent)
- Utiliser dans : Sidebar header, Welcome page, About dialog, Loading screen

### I4. Loading Screen branded
**Créer** : `packages/webview/src/components/LoadingScreen.tsx`
- Écran de chargement avec logo SandForge animé
- Barre de progression avec étapes ("Connexion...", "Chargement du schema...", "Prêt !")
- Affiché au premier chargement de la WebView
- Transition fluide vers le contenu
- Tests de rendu

### I5. About Dialog
**Créer** : `packages/webview/src/components/AboutDialog.tsx`
- Version de l'extension
- Logo et tagline
- Liens : GitHub, Documentation, Changelog, License
- Crédits et remerciements
- Easter egg : Konami code → animation spéciale (le MojitoOverlay existe déjà !)
- Tests de rendu

### I6. Locale-aware formatting
**Créer** : `packages/webview/src/utils/formatters.ts`
- `formatNumber(n, locale)` — Formatage des nombres selon la locale
- `formatDate(d, locale, format)` — Formatage des dates
- `formatCurrency(n, currency, locale)` — Formatage des devises
- `formatDuration(ms)` — "2h 14min" ou "3s"
- `formatFileSize(bytes)` — "1.2 MB"
- `formatRelativeTime(date)` — "il y a 5 minutes"
- Utiliser Intl.NumberFormat et Intl.DateTimeFormat
- Tests avec différentes locales

**Validation Phase I** : `pnpm validate` + vérifier les 6 langues

---

## ═══════════════════════════════════════════
## PHASE J — CHANGELOG, DOCUMENTATION ET POLISH FINAL
## ═══════════════════════════════════════════

### J1. CHANGELOG.md enrichi
**Mettre à jour** : `CHANGELOG.md`
- Documenter TOUTES les nouvelles features ajoutées dans les phases A-I
- Format Keep a Changelog avec catégories : Added, Changed, Fixed, Improved
- Liens vers les fichiers modifiés
- Version bump à 2.0.0

### J2. README.md complet
**Créer/Mettre à jour** : `README.md`
- Hero section avec logo, tagline, badges (build, coverage, version, license)
- Screenshots/GIFs des 6 modules
- Quick Start en 3 étapes
- Table des features avec statut
- Architecture diagram (Mermaid)
- Contributing guide
- License

### J3. DECISIONS.md mis à jour
**Mettre à jour** : `DECISIONS.md`
- Documenter chaque choix technique fait pendant l'upgrade
- Format : Contexte, Décision, Alternatives, Conséquences

### J4. AUDIT.md v2
**Mettre à jour** : `AUDIT.md`
- Nouveau rapport d'audit complet
- Nouveau score par catégorie
- Comparaison avant/après

### J5. Validation finale
```bash
✅ pnpm typecheck          → 0 errors
✅ pnpm lint               → 0 errors, 0 warnings
✅ pnpm format:check       → All formatted
✅ pnpm test               → All passing
✅ pnpm test:coverage      → Global >= 85%, Core >= 90%
✅ pnpm build              → Success
✅ pnpm package            → .vsix généré
✅ Taille bundle extension → < 5MB
✅ Taille bundle webview   → < 2MB
✅ 6 langues               → en, fr, de, es, ja, pt-BR
✅ Accessibilité           → WCAG 2.1 AA
✅ CSP                     → Strict
✅ CHANGELOG.md            → Complet
✅ README.md               → Complet
✅ DECISIONS.md            → À jour
✅ AUDIT.md                → Score >= 9/10
```

---

## RÈGLES ABSOLUES

1. **Lis CLAUDE.md en premier** — Il contient toutes les conventions du projet
2. **TypeScript strict** — Aucun `any`, `noImplicitReturns`, `noUnusedLocals`
3. **Tests obligatoires** — Chaque fichier `.ts` a un `.test.ts` dans le même dossier
4. **Build toujours vert** — `pnpm validate` après chaque phase
5. **i18n** — Tout texte visible utilise `t('key')`, jamais de string hardcodée
6. **Zod** — Toute donnée externe validée par Zod
7. **JSDoc** — Sur toute interface/méthode publique
8. **Pas de console.log** — Utiliser le logger
9. **Pas de TODO/FIXME** — Tout code livré est complet
10. **Accessibilité** — aria-label sur tous les éléments interactifs
11. **Animations** — Respecter prefers-reduced-motion
12. **Performance** — React.memo sur les composants lourds, useMemo/useCallback appropriés

## BOUCLE DE TRAVAIL

```
Pour chaque fichier :
1. Créer le fichier complet (pas de squelette)
2. Créer le fichier test associé
3. pnpm typecheck → fix si erreurs
4. pnpm test → fix si échecs
5. Toutes les 5 fichiers : pnpm build → fix si cassé
6. À chaque fin de phase : pnpm validate
```

## COMMANDES

```bash
pnpm install          # Setup
pnpm typecheck        # tsc --noEmit
pnpm lint:fix         # eslint --fix
pnpm test             # vitest run
pnpm build            # Build tous les packages
pnpm validate         # typecheck + lint + test + build
pnpm package          # Génère le .vsix
```

## OBJECTIF FINAL

Score cible : **9.5/10** → **10/10**

| Catégorie | Avant | Après |
|-----------|-------|-------|
| Architecture | 9/10 | 10/10 |
| Tests | 9/10 | 9.5/10 |
| Modules métier | 9/10 | 10/10 |
| Intelligence IA | 4/10 | 9.5/10 |
| Intégration E2E | 4/10 | 9/10 |
| Résilience | 3/10 | 9.5/10 |
| Sécurité | 6/10 | 9.5/10 |
| i18n | 5/10 | 9.5/10 |
| UX/Design | 7/10 | 9.5/10 |
| Performance | 7/10 | 9.5/10 |
| Automatisation | 7/10 | 9.5/10 |
| Onboarding | 5/10 | 9.5/10 |
| Branding | 6/10 | 9/10 |
| Documentation | 6/10 | 9.5/10 |

Commence par la Phase A. Ne t'arrête que si un problème bloquant nécessite mon input. Log toutes tes décisions dans DECISIONS.md.
```

---

## NOTES D'UTILISATION

### Option 1 : Full autonome (contexte large)
```bash
cd sandforge
claude --dangerously-skip-permissions
# Coller le prompt ci-dessus
```

### Option 2 : Par phase (recommandé pour contrôle)
```bash
# Session 1 : Phase A + B
claude
> "Lis CLAUDE.md puis plans/CLAUDE-CODE-PROMPT.md. Exécute les Phases A et B."

# Session 2 : Phase C + D
claude
> "Lis CLAUDE.md puis plans/CLAUDE-CODE-PROMPT.md. Exécute les Phases C et D."

# Session 3 : Phase E + F
claude
> "Lis CLAUDE.md puis plans/CLAUDE-CODE-PROMPT.md. Exécute les Phases E et F."

# Session 4 : Phase G + H
claude
> "Lis CLAUDE.md puis plans/CLAUDE-CODE-PROMPT.md. Exécute les Phases G et H."

# Session 5 : Phase I + J
claude
> "Lis CLAUDE.md puis plans/CLAUDE-CODE-PROMPT.md. Exécute les Phases I et J."
```

### Option 3 : Phase par phase avec validation manuelle
```bash
# Après chaque phase, vérifier manuellement :
pnpm validate
pnpm test:coverage
# Puis lancer la phase suivante
```
