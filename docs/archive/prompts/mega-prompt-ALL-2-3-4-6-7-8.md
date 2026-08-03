# SANDFORGE — MÉGA-PROMPT UNIFIÉ : MP#2 + MP#3+4 + MP#6+7+8

Tu travailles sur SandForge, extension VSCode Salesforce (monorepo pnpm : packages/shared, packages/extension, packages/webview).
État actuel : MP#1 (UI Revolution) terminé. Sidebar launcher, panels full-width, design system VSCode tokens, 7 composants UI (Icon, KPICard, DataTable, PageHeader, OrgBadge, Skeleton, PageTabs), WebviewPanelManager, LauncherTreeProvider, ConnectedOrgsTreeProvider, raccourcis Ctrl+Shift+M/D, StatusBar. 2996 tests, .vsix 2.08 MB.

Objectif : TOUT implémenter en une seule exécution — intelligence Monitor/Compare, Seed/Sync/DataOps/Automation/AI, i18n FR/EN, docs, onboarding, help, branding, easter egg.

Travaille phase par phase. Valide chaque phase (typecheck + test + build) avant de passer à la suivante. Ne me pose AUCUNE question, travaille en autonomie complète.

---

## PHASE 1 : Monitor — Health Score Expliqué (20 min)

### Extension : HealthScoreCalculator service

```typescript
// packages/extension/src/modules/monitor/HealthScoreCalculator.ts
interface HealthFactor {
  name: string;
  category: 'limits' | 'jobs' | 'storage';
  score: number;          // 0-100
  weight: number;
  status: 'healthy' | 'warning' | 'critical';
  detail: string;
  recommendation: string;
  trend: 'improving' | 'stable' | 'degrading';
}

interface HealthReport {
  overallScore: number;
  overallStatus: 'healthy' | 'warning' | 'critical';
  factors: HealthFactor[];
  summary: string;
  topRisks: HealthFactor[];
}
```

Règles de scoring :
- Poids : API Calls=20%, Storage=20%, SOQL=15%, DML=15%, Apex Jobs Failures=15%, Other=15%
- Score par facteur : 100 si <50%, 80 si 50-75%, 50 si 75-90%, 20 si 90-95%, 0 si >95%
- Status : healthy (<75%), warning (75-90%), critical (>90%)
- Recommendations contextuelles (API >80%, Storage >80%, Failed jobs >5)

### Extension : message `monitor:data` enrichi avec HealthReport complet

### WebView : HealthScoreCard — gauge radiale SVG 270° (speedometer), gradient vert→orange→rouge, top 3 risks avec codicons, bouton "View Full Report"

### WebView : HealthReportModal — modal plein écran, tous les HealthFactors, groupés par catégorie (Limits, Jobs, Storage)

Validation : pnpm typecheck + pnpm test + pnpm build

---

## PHASE 2 : Monitor — Trend Analysis & Sparklines (25 min)

### Extension : TrendStorage service
- Stocker snapshots dans context.globalState `sandforge.trends.{orgId}`
- Max 7 jours, auto-purge, max 500KB/org
- saveSnapshot (throttle 15min), getSnapshots, getTrend (avec direction, changePercent, predictedTimeToLimit via régression linéaire)

### Extension : message `monitor:trends` → `monitor:trends:data`

### WebView : Sparkline component (SVG pur, bézier, 100x24px, fill gradient, animate)

### WebView : KPICards avec sparkline + trend indicator (↑ +12%/24h) + "Limit reached in ~2h14" si >75% et trend up

### WebView : Trend Detail Panel — onglet "Trends" dans Monitor, graphiques 400x200, sélecteur période 1h/6h/24h/7d, seuils 75%/90% en pointillés, prédiction en pointillé

Validation : pnpm typecheck + pnpm test + pnpm build

---

## PHASE 3 : Monitor — Smart Alerts & Apex Jobs Intelligence (15 min)

### Extension : JobAnalyzer service
- Détecter : fails fréquents (>3/24h), jobs longs (>5min), gros consommateurs (>1000 batches), stuck (Processing >1h)
- Ajouter `jobInsights: JobInsight[]` dans monitor:data

### WebView : Alerts Banner collapsible, badges sévérité, actions inline (Abort Job)

### WebView : Jobs Table améliorée — grouper par Apex Class (accordion), stats par classe, filtres All/Running/Failed/Completed

### Extension : handler `monitor:abort-job` → PATCH AsyncApexJob Status='Aborted'

Validation : pnpm typecheck + pnpm test + pnpm build

---

## PHASE 4 : Compare — Smart Diff avec Grouping & Risk Score (25 min)

### Extension : DiffAnalyzer service

```typescript
interface EnrichedDiff {
  category: string;
  changeType: 'added' | 'removed' | 'modified';
  name: string;
  sourceValue?: any;
  targetValue?: any;
  riskLevel: 'none' | 'low' | 'medium' | 'high' | 'critical';
  riskReasons: string[];
  group: string;
  dependencies: string[];
}

interface CompareReport {
  diffs: EnrichedDiff[];
  summary: { total, added, removed, modified, byRisk: Record<string, number> };
  riskScore: number;        // 0-100
  deploymentAdvice: string;
}
```

### Règles de Risk Scoring
- Suppression champ avec données → critical
- Suppression champ référencé Flow/VR/Trigger → critical
- Modification type champ → high
- Ajout champ required sans default → high
- Suppression validation rule → medium
- Modification Flow → medium
- Modification Profile/PermSet → low
- Ajout champ non-required → none

### WebView : RiskScoreCard (gauge inversée 0=safe vert, 100=rouge), DiffGroupAccordion (Critical/High ouverts, Low/None fermés), DiffItem, DiffDetailModal (split view source/target)

### Actions : Export Report (JSON), Generate package.xml
### Extension handlers : compare:export, compare:package-xml

Validation : pnpm typecheck + pnpm test + pnpm build

---

## PHASE 5 : Compare — Category Deep Dive & Metadata Types (20 min)

### Extension : CompareEngine élargi — support Custom Objects, Custom Fields, Validation Rules, Flows, Profiles, Permission Sets, Custom Labels, Apex Classes, Apex Triggers, LWC

### WebView : Category Selector (chips/toggles avec icône + label + count, Select All/Deselect All, pré-sélection Objects/Fields/Flows/VR)

### WebView : Tabs par catégorie dans les résultats (PageTabs), badge count, heatmap visuelle

Validation : pnpm typecheck + pnpm test + pnpm build

---

## PHASE 6 : Monitor — Org Info Panel (10 min)

### Extension : OrgInfoFetcher
- Queries : Organization, COUNT() Users/ApexClass/FlowDefinition, describeGlobal
- Interface OrgInfo : name, orgId, type, edition, instanceName, apiVersion, userCount, customObjectCount, apexClassCount, flowCount, lastLoginDate

### WebView : OrgInfoPanel — tab "Overview" (premier onglet Monitor), infos org + KPI cards (Users, Objects, Apex)

Validation : pnpm typecheck + pnpm test + pnpm build

---

## PHASE 7 : Seed — ERD Visuel & Auto-Detection (25 min)

### Extension : SchemaAnalyzer service

```typescript
interface ObjectNode {
  apiName: string;
  label: string;
  recordCount: number;
  fields: FieldInfo[];
  relationships: Relationship[];
}

interface FieldInfo {
  apiName: string;
  label: string;
  type: string;
  required: boolean;
  defaultValue: any | null;
  picklistValues?: string[];
  referenceTo?: string;
  unique: boolean;
  externalId: boolean;
}

interface Relationship {
  fieldName: string;
  targetObject: string;
  type: 'Lookup' | 'MasterDetail';
  required: boolean;
}

interface ERDData {
  nodes: ObjectNode[];
  edges: { source: string; target: string; field: string; type: 'Lookup' | 'MasterDetail' }[];
  insertionOrder: string[];
  circularDeps: string[][];
  warnings: string[];
}
```

- Pour chaque objet : conn.describe(), extraire relationships, ajouter parents manquants, tri topologique, détecter cycles
- Handler : `seed:analyze-schema` → `seed:schema-data`
- Paralléliser describe avec Promise.allSettled (max 10 concurrents)

### WebView : ERDMiniMap (SVG pur)
- Rectangles arrondis (icône, nom, record count), bleu=sélectionné, gris=auto-ajouté
- Flèches : MasterDetail=pleine épaisse rouge, Lookup=pointillée bleue
- Layout niveaux horizontaux basés sur insertion order
- Badge circulaire avec numéro d'ordre, pan & zoom basique
- Intégrer dans Seed Wizard Step 3 (Relations)

Validation : pnpm typecheck + pnpm test + pnpm build

---

## PHASE 8 : Seed — Smart Field Generation (25 min)

### Extension : SmartFieldGenerator service
- Inférence auto par nom de champ : *Name*→faker person.firstName, *Email*→internet.email, *Phone*→phone.number, *Street*→location.streetAddress, *City*→location.city, *Company*→company.name, *Amount*→finance.amount, *Date*→date.past, Picklist→picklist_random, Lookup/MasterDetail→référence auto
- Inférence par type : Currency, Percent, DateTime, Checkbox, TextArea, Number/Double
- generatePreview(config, count): any[]

### Extension : enrichir seed:analyze-schema avec FieldGenerationConfig[] auto-inférés

### WebView : Step 2 (Configure Fields) amélioré
- Toggle enable/disable, dropdown mode (Auto/Faker/Fixed/Sequence/Null/Picklist Random)
- Live preview 3 valeurs, badges "required" rouge / "unique" bleu
- "Auto-configure all", "Reset to defaults"

### Extension : VRPreChecker service
- Query ValidationRule WHERE Active=true, parser formule, cross-référencer champs, évaluer risque
- WebView : VR Warnings dans Step 5 (Preview)

Validation : pnpm typecheck + pnpm test + pnpm build

---

## PHASE 9 : Sync — Auto-Mapping Intelligent (20 min)

### Extension : FieldMapper service
- 3 passes : Exact API name (100%), Normalized (lowercase, remove __c, 85%), Levenshtein <3 + same type (60%)
- Bonus : +10% même type, +5% même longueur, -20% types incompatibles
- Conflits : 1 source → 2 targets → status 'conflict'

### Handler : `sync:auto-map` → `sync:mapping-data`

### WebView : Mapping Table (Step 2 Sync wizard)
- Source → dropdown target, barre confiance colorée (vert>80%, orange 50-80%, rouge<50%)
- Filtres : All/Auto-mapped/Manual/Unmapped/Warnings
- Actions : Accept All Auto, Clear All, Map Remaining Manually

Validation : pnpm typecheck + pnpm test + pnpm build

---

## PHASE 10 : Sync — Conflict Detection & Impact Analysis (20 min)

### Extension : SyncAnalyzer service
- preview() : recordsToInsert/Update/Delete/Unchanged, conflicts[], estimatedDuration, warnings
- Handler : `sync:preview` → `sync:preview-data`

### WebView : Sync Preview Panel (Step 3) — KPI cards, conflicts list avec radio source/target wins, impact summary, estimated duration

### WebView : Sync Execution (Step 4) — progress bar par objet, real-time counter, error log, rollback button

Validation : pnpm typecheck + pnpm test + pnpm build

---

## PHASE 11 : DataOps — Backup, Restore & RGPD (25 min)

### Extension : BackupEngine service
- backup(full/incremental), listBackups, restore(insert/upsert, dryRun), deleteBackup
- Stocker dans globalStorageUri `backups/{orgId}/{timestamp}/`, manifest.json, max 10/org
- Handlers : dataops:backup, dataops:backup:list, dataops:restore, dataops:backup:delete

### Extension : RGPDScanner service
- Détection PII par patterns : *FirstName*→name, *Email*→email, *Phone*→phone, *SSN*→national_id, *CreditCard*→financial, *Birthdate*→other
- COUNT() records non-null, risk score
- Handler : `dataops:rgpd-scan` → `dataops:rgpd-scan:result`

### Extension : Anonymizer service
- Méthodes : hash (SHA256), faker, mask (S***e), null
- Backup auto avant anonymisation (safety net)
- Handler : `dataops:anonymize`

### WebView : DataOps Dashboard — Tabs Backup|Restore|RGPD & Privacy|Data Quality
- Backup : formulaire + liste + progress
- Restore : sélection backup + dry run + preview
- RGPD : Scan for PII, DataTable groupée, Risk Score card, Anonymize selected avec confirmation
- Data Quality : compteurs (records sans owner, orphelins, doublons)

Validation : pnpm typecheck + pnpm test + pnpm build

---

## PHASE 12 : Automation — Pipeline Builder & Execution (25 min)

### Extension : PipelineEngine service

```typescript
interface PipelineStep {
  id: string;
  name: string;
  type: 'seed' | 'sync' | 'backup' | 'restore' | 'compare' | 'anonymize' | 'soql' | 'wait';
  config: Record<string, any>;
  dependsOn: string[];
  condition?: { field: string; operator: '>' | '<' | '==' | '!='; value: any };
  timeout: number;     // default 300
  onError: 'stop' | 'continue' | 'retry';
  retryCount?: number;
}

interface Pipeline {
  id: string;
  name: string;
  description: string;
  steps: PipelineStep[];
  createdAt: number;
  lastRunAt?: number;
  lastRunStatus?: 'success' | 'partial' | 'failed';
}
```

- savePipeline, listPipelines, deletePipeline, executePipeline, cancelExecution
- Exécution : DAG → steps parallèles si pas de dépendances, conditions, error policy, progression temps réel
- Stocker dans globalState `sandforge.pipelines`, max 20, historique 5 dernières exécutions

### Extension : Pipeline Templates (3)
- Sandbox Refresh Setup : backup → seed → anonymize
- Data Migration Dry Run : compare → sync(dryRun)
- Nightly Data Cleanup : SOQL count → SOQL delete

### Handlers : automation:save-pipeline, automation:list-pipelines, automation:delete-pipeline, automation:execute, automation:cancel

### WebView : Automation Dashboard
- Liste pipelines (DataTable) + "New Pipeline" + "From Template"
- Pipeline Builder : drag & drop steps, flèches SVG, step editor modal, condition editor
- Execution View : timeline verticale, statut temps réel, log, Cancel/Retry

Validation : pnpm typecheck + pnpm test + pnpm build

---

## PHASE 13 : AI Layer — AIAssistant Service Optionnel (20 min)

### Extension : AIAssistant service
- API key dans context.secrets (SecretStorage VSCode, chiffré)
- Settings : sandforge.ai.enabled (boolean), sandforge.ai.model (string, default 'claude-sonnet-4-20250514')
- Commande : `sandforge.configureAI`
- callAPI() : POST https://api.anthropic.com/v1/messages, timeout 30s, gestion erreurs

### Fonctions IA spécialisées :
- explainHealthScore(report) → paragraphe exécutif
- suggestFieldGeneration(objectName, fields) → FieldGenerationConfig[]
- analyzeCompareRisk(diffs) → analyse narrative
- generateSOQL(naturalLanguage, objects) → SOQL
- explainError(error, context) → diagnostic + fix

### Handlers : ai:configure, ai:status, ai:explain, ai:suggest, ai:generate-soql

### WebView : bouton $(sparkle) partout
- Grisé si IA non configurée, tooltip "Configure AI in settings"
- Spinner pendant l'appel, résultat inline
- Monitor : à côté Health Score + alerts
- Seed : step 2 (suggest) + step 5 (explain VR)
- Compare : en haut du rapport (AI Risk Assessment)
- DataOps : RGPD (AI Privacy Assessment)
- Automation : builder (describe pipeline → IA génère steps)

### WebView : AI Settings Panel dans launcher — Toggle, Input API Key (masqué), Model selector, Test connection

Validation : pnpm typecheck + pnpm test + pnpm build

---

## PHASE 14 : Settings & Global Polish (15 min)

### Extension : Settings Panel (WebviewPanel "Settings" depuis launcher)

```typescript
interface SandForgeSettings {
  language: 'en' | 'fr';
  theme: 'auto' | 'light' | 'dark';
  monitorAutoRefresh: boolean;        // default true
  monitorRefreshInterval: number;     // default 30
  monitorTrendRetention: number;      // default 7
  seedDefaultBatchSize: number;       // default 200
  seedDefaultVolume: number;          // default 100
  syncBatchSize: number;              // default 200
  syncDefaultMode: 'insert' | 'upsert';
  backupMaxCount: number;             // default 10
  backupFormat: 'json' | 'csv';
  pipelineMaxSteps: number;           // default 10
  pipelineDefaultTimeout: number;     // default 300
  aiEnabled: boolean;
  aiModel: string;
}
```

### WebView : Settings Page — accordions par section, label+input+description, "Reset to defaults", sauvegarde auto (debounced)

### Global Polish : vérifier --sf-* tokens partout, codicons cohérents, empty/loading/error states, tooltips

Validation : pnpm typecheck + pnpm test + pnpm build

---

## PHASE 15 : i18n — Infrastructure (20 min)

### Shared : i18n Engine (packages/shared/src/i18n/index.ts)
- I18n class : setLocale, getLocale, t(key, params?) avec fallback EN, résolution nested keys, remplacement {{param}}
- Singleton : export i18n + t()
- PAS de librairie externe (pas i18next, react-intl)

### Structure fichiers traduction :
```
packages/shared/src/i18n/locales/
  en/ : common.ts, monitor.ts, seed.ts, sync.ts, compare.ts, dataops.ts, automation.ts, ai.ts, settings.ts, onboarding.ts
  fr/ : (même structure, traduit)
```

### common.ts : actions (save, cancel, delete, edit, refresh, export, run, stop, retry, close, back, next, finish, selectAll, search...), status (loading, error, success, noData, connecting, running, completed, failed...), time (justNow, minutesAgo, hoursAgo...), units (records, files, fields, objects), errors (networkError, timeout, unauthorized, orgNotConnected...), org (production, sandbox, scratch, developer, selectOrg, activeOrg...)

### Traductions par module : toutes les clés UI de chaque module en EN + FR

### Extension : détecter locale via vscode.env.language, mapper vers 'en'|'fr', override via sandforge.language, passer au WebView via message `app:locale`

### WebView : hook useTranslation() — écoute app:locale, retourne { t, locale }

Validation : pnpm typecheck + pnpm test + pnpm build

---

## PHASE 16 : i18n — Migration de TOUS les textes (30 min)

Parcourir systématiquement TOUS les composants WebView et remplacer les strings en dur par t() :
1. UI components : PageHeader, KPICard, DataTable, EmptyState, Skeleton, OrgBadge, PageTabs
2. Monitor : MonitorDashboard, HealthScoreCard, HealthReportModal, AlertsBanner, JobsTable, GovernorLimitsTable, TrendPanel, OrgInfoPanel
3. Seed : SeedWizard (6 steps), ERDMiniMap, FieldConfigTable, VRWarnings
4. Sync : SyncWizard (4 steps), MappingTable, ConflictPanel, SyncExecution
5. Compare : CompareDashboard, RiskScoreCard, DiffGroupAccordion, DiffItem, DiffDetailModal, CategorySelector
6. DataOps : DataOpsDashboard (4 tabs), BackupForm, RestorePanel, RGPDScanner, DataQualityPanel
7. Automation : AutomationDashboard, PipelineBuilder, StepEditor, PipelineExecutionView
8. AI : AISettingsPanel, AIResultPanel, sparkle buttons tooltips
9. Settings : SettingsPage

### Extension NLS : créer package.nls.json (EN) + package.nls.fr.json (FR) avec toutes les commandes, vues, settings

### package.json : remplacer strings par %extension.displayName%, %command.openMonitor%, etc.

Validation : pnpm typecheck + pnpm test + pnpm build

---

## PHASE 17 : Accessibilité (15 min)

- aria-label sur boutons icon-only, gauges SVG
- role="progressbar" + aria-valuenow/min/max sur progress bars
- role="alert" sur AlertsBanner
- role="table"/row/cell sur DataTable
- role="tablist"/tab/tabpanel sur PageTabs
- role="dialog" + aria-modal sur modals
- aria-expanded sur accordions
- aria-sort sur colonnes triables
- aria-live="polite" sur zones dynamiques
- Keyboard : Tab/Enter/Space, Escape modals, Arrow keys tables/tabs, focus trap modals
- High Contrast : vérifier SVG lisibles, patterns si nécessaire, badges avec texte + couleur

Validation : pnpm typecheck + pnpm test + pnpm build

---

## PHASE 18 : Welcome & Onboarding (20 min)

### Extension : OnboardingService
- shouldShowOnboarding() — globalState 'sandforge.onboardingCompleted'
- shouldShowWhatsNew() — compare lastVersion vs currentVersion
- markOnboardingComplete()
- Dans activate() : ouvrir Welcome ou WhatsNew

### WebView : WelcomePage (3 steps)
- Step 1 : Connect Your First Org — scanner SFDX orgs, afficher orgs trouvées, "Connect New Org"
- Step 2 : Explore Your Toolkit — grille 2x3 des 6 modules (icône+titre+description), cards cliquables
- Step 3 : Configure AI (Optional) — input API key, Skip, Test Connection
- Fin : "You're all set!" + "Open Monitor" + "Don't show again"

### WebView : WhatsNewPage — titre v{{version}}, liste features, "Got it!"

Validation : pnpm typecheck + pnpm test + pnpm build

---

## PHASE 19 : Contextual Hints + Help Panel (15 min)

### Extension : HintTracker — isHintSeen, markHintSeen, resetAllHints (globalState)
- 9 hints : monitor.firstOpen, monitor.sparklines, seed.firstOpen, seed.erd, compare.firstOpen, sync.firstOpen, dataops.firstOpen, automation.firstOpen, ai.available

### WebView : HintBubble component — tooltip avec flèche, "Got it" dismiss, fade-in, one-time

### Extension : ajouter "Help" au launcher (icône $(question), commande sandforge.openHelp)

### WebView : HelpPage — accordion par module (Getting Started, Monitor, Seed, Sync, Compare, DataOps, Automation, AI Assistant, Keyboard Shortcuts, FAQ)
- Boutons "Reset Onboarding" + "Open Settings"
- Tout i18n'd

Validation : pnpm typecheck + pnpm test + pnpm build

---

## PHASE 20 : Documentation — README & CHANGELOG (10 min)

### README.md à la racine
- Titre : 🔥 SandForge — Salesforce DevOps Toolkit
- Features par module (Monitor, Seed, Sync, Compare, DataOps, Automation, AI)
- Requirements : VSCode 1.85+, Salesforce CLI (sf), Node.js 18+, API key optionnelle
- Installation (from VSIX + from source)
- Getting Started (4 étapes)
- Keyboard Shortcuts table
- Configuration table (sandforge.language, ai.enabled, ai.model, monitor.autoRefresh, monitor.refreshInterval)
- Architecture (3 packages)
- Contributing (pnpm install/dev/test/typecheck/build/package)
- Author : Stéphane Berthoz
- License : MIT

### CHANGELOG.md v1.0.0
- Toutes les features des 6 modules + AI + i18n + Onboarding + Settings + Accessibility
- À la toute fin, ajouter cette ligne mystérieuse :
  `> 🍹 *Some features are better discovered than documented. Try being persistent...*`

Validation : pnpm typecheck + pnpm test + pnpm build

---

## PHASE 21 : Branding & Package Metadata (10 min)

### Logo SandForge
- Créer `resources/icon.svg` : lettres "SF" stylisées dans un hexagone, couleurs orange/sand (#E8A838) sur fond sombre (#1E1E2E)
- Convertir en `resources/icon.png` 128x128 via sharp ou canvas

### package.json metadata COMPLÈTE :

```json
{
  "name": "sandforge",
  "displayName": "%extension.displayName%",
  "description": "%extension.description%",
  "version": "1.0.0",
  "publisher": "StephaneBerthoz",
  "author": { "name": "Stéphane Berthoz" },
  "license": "MIT",
  "icon": "resources/icon.png",
  "categories": ["Other", "Testing"],
  "keywords": ["salesforce", "sfdc", "sfdx", "devops", "monitoring", "data-seeding", "metadata-comparison", "data-sync", "gdpr", "automation", "apex", "flow", "sandbox"],
  "engines": { "vscode": "^1.85.0" },
  "galleryBanner": { "color": "#1E1E2E", "theme": "dark" },
  "preview": true
}
```

### .vscodeignore
```
.github/
node_modules/
src/
**/*.test.ts
**/*.spec.ts
coverage/
.eslintrc*
tsconfig*.json
pnpm-lock.yaml
prompts/
```

### .gitignore : node_modules/, dist/, out/, *.vsix, coverage/, .DS_Store, *.log

### LICENSE : MIT, copyright Stéphane Berthoz

Validation : pnpm typecheck + pnpm test + pnpm build + pnpm package

---

## PHASE 22 : Easter Egg — Mojito 🍹 (10 min)

### Concept
Un easter egg caché qui affiche un mojito SVG animé quand l'utilisateur le découvre.

### WebView : MojitoOverlay component
SVG inline (viewBox 400x520) avec :
- Highball glass avec gradient mojito (#b8e986→#4a9e2f)
- Ice cubes, lime slice on rim, red striped straw
- Animations : mint leaves sway, rising bubbles, condensation drops
- Background semi-transparent sombre (#2a2a3e→#1a1a2e)
- Texte : "SANDFORGE v1.0.0" (#E8A838), "Crafted with love & mojitos by Stéphane B." (#b8e986), "Special thanks to Stéphane H. — partner in crime since day 1" (#7a7a92 italic)
- Click ou Escape pour fermer

### 3 triggers cachés :

**Trigger 1 : Konami Code**
- Hook useKonamiCode() — keydown listener dans WebView
- Séquence : ↑↑↓↓←→←→BA (ArrowUp ArrowUp ArrowDown ArrowDown ArrowLeft ArrowRight ArrowLeft ArrowRight KeyB KeyA)
- Sur séquence complète → showEasterEgg = true

**Trigger 2 : Commande cachée**
- `sandforge.cheers` — déclaré dans package.json contributes.commands mais PAS dans menus
- Dans activate() : registerCommand('sandforge.cheers') → post message 'app:cheers' au WebView
- Le WebView écoute 'app:cheers' → showEasterEgg = true

**Trigger 3 : 7 clics sur le logo SF**
- Click counter sur le logo/titre SandForge dans le PageHeader
- Reset après 3 secondes d'inactivité (timeout)
- Au 7ème clic → showEasterEgg = true

### Intégration : state `showEasterEgg` dans App root, MojitoOverlay rendu conditionnel

Validation : pnpm typecheck + pnpm test + pnpm build

---

## PHASE 23 : Validation finale (10 min)

1. `pnpm typecheck` → 0 erreurs
2. `pnpm test` → tous passent (noter le nombre exact)
3. `pnpm build` → success (3 packages)
4. `pnpm package` → sandforge.vsix (noter la taille, doit être < 5 MB)

5. Vérifier le contenu du .vsix :
   - icon.png présent
   - package.nls.json + package.nls.fr.json présents
   - README.md + CHANGELOG.md + LICENSE.txt présents
   - dist/extension.js présent
   - webview-dist/ présent

6. Vérifications code :
   - Tous les nouveaux composants utilisent les --sf-* tokens (PAS de couleurs en dur)
   - Tous les handlers sont enregistrés dans le MessageRouter
   - Tous les tests mockent jsforce correctement
   - L'AI Layer fonctionne si pas de clé API (graceful degradation)
   - Les pipelines se sauvegardent/chargent correctement
   - Easter egg : les 3 triggers sont implémentés
   - i18n : vérifier que t() est utilisé partout (aucun string en dur dans les composants)

Résumé final avec :
- Nombre total de fichiers dans le projet
- Nombre de tests total (avant/après)
- Taille du .vsix
- Liste COMPLÈTE des services créés
- Liste COMPLÈTE des messages WebView ↔ Extension
- Liste COMPLÈTE des composants WebView
- Liste des commandes Command Palette
- Nombre de clés i18n (EN + FR)

---

## CONTRAINTES GLOBALES (S'APPLIQUENT À TOUTES LES PHASES)

1. **SVG pur** pour tous les graphiques (gauges, sparklines, ERD) — PAS de librairie chart (recharts, d3, chart.js)
2. **Données** dans globalState ou SecretStorage, PAS dans le filesystem (sauf backups dans globalStorageUri)
3. **Queries SOQL** wrappées en try/catch (certaines queries tooling échouent sur des éditions limitées)
4. **Pas de breaking changes** sur les messages existants — enrichir, pas remplacer
5. **Batch size** configurable, default 200 pour toutes les opérations bulk
6. **Timeout** 30s pour les opérations réseau, 300s pour les pipelines
7. **AI Layer 100% optionnel** — tout fonctionne sans clé API
8. **i18n** : tous les textes visibles passent par t(), clés format `module.section.element`, fallback EN systématique, PAS de dépendance externe
9. **NLS** (package.nls.*.json) pour l'extension, fichiers locale TS pour le WebView
10. **Max** 20 pipelines, 10 backups par org, 7 jours trends, 500KB trends/org
11. **Le PipelineEngine** exécute des steps en parallèle quand pas de dépendances
12. **L'Anonymizer** crée un backup auto avant d'anonymiser (safety net)
13. **.vsix < 5 MB**
14. **Welcome wizard** non-bloquant (fermable à tout moment)
15. **Hints** non-intrusifs, masqués définitivement après dismiss
16. **Publisher** : `StephaneBerthoz`, **Author** : `Stéphane Berthoz`, **License** : MIT copyright Stéphane Berthoz
17. **PAS de GitHub Actions CI/CD** (sera fait manuellement plus tard)
18. **Easter egg** : commande `sandforge.cheers` déclarée dans package.json mais PAS dans les menus
