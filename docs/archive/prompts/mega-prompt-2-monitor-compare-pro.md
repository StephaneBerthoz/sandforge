# SANDFORGE — MÉGA-PROMPT #2 : MONITOR & COMPARE PRO

Tu travailles sur SandForge, extension VSCode Salesforce (monorepo pnpm : packages/shared, packages/extension, packages/webview).
État actuel : UI refactorée avec panels full-width, design system VSCode tokens, 7 composants UI, 2996 tests, .vsix 2.08 MB.

Objectif : transformer Monitor et Compare de "afficheurs de données brutes" en outils intelligents qui analysent, expliquent et alertent.

Travaille phase par phase. Valide chaque phase (typecheck + test + build) avant de passer à la suivante. Ne me pose AUCUNE question, travaille en autonomie complète.

---

## PHASE 1 : Monitor — Health Score Expliqué (20 min)

### Concept
Le Health Score actuel est juste un nombre. Il faut le rendre transparent et actionnable.

### Extension : HealthScoreCalculator amélioré
Refactorer le calcul du health score dans un service dédié :

```typescript
// packages/extension/src/modules/monitor/HealthScoreCalculator.ts
interface HealthFactor {
  name: string;           // ex: "API Calls"
  category: 'limits' | 'jobs' | 'storage';
  score: number;          // 0-100 contribution
  weight: number;         // poids dans le total
  status: 'healthy' | 'warning' | 'critical';
  detail: string;         // ex: "83% used (12,450 / 15,000)"
  recommendation: string; // ex: "Consider optimizing batch jobs that consume API calls"
  trend: 'improving' | 'stable' | 'degrading'; // basé sur l'historique
}

interface HealthReport {
  overallScore: number;    // 0-100
  overallStatus: 'healthy' | 'warning' | 'critical';
  factors: HealthFactor[];
  summary: string;         // phrase lisible
  topRisks: HealthFactor[]; // top 3 facteurs les plus critiques
}
```

Règles de scoring :
- Chaque limite Salesforce a un poids (API Calls = 20%, Storage = 20%, SOQL = 15%, DML = 15%, Apex Jobs Failures = 15%, Other = 15%)
- Score par facteur : 100 si <50%, 80 si 50-75%, 50 si 75-90%, 20 si 90-95%, 0 si >95%
- Status : healthy (<75%), warning (75-90%), critical (>90%)
- Recommendations contextuelles :
  - API >80% → "Review scheduled batch jobs. XyzSchedulable consumed 40% of daily API calls."
  - Storage >80% → "Consider archiving old records. Attachments account for 60% of storage."
  - Failed jobs >5 → "5 Apex jobs failed in the last 24h. Most common error: System.LimitException"

### Extension : répondre monitor:data enrichi
Le message `monitor:data` doit maintenant inclure le HealthReport complet, pas juste un score number.

### WebView : HealthScoreCard refactoré
- Gauge radiale SVG animée (arc de cercle 270° style speedometer)
- Couleur de la gauge : gradient vert→orange→rouge selon le score
- Liste des top 3 risks avec icône codicon (check=healthy, warning=warning, error=critical)
- Chaque risk a son impact en points sur le score total
- Bouton "View Full Report" ouvre un modal avec TOUS les facteurs détaillés

### WebView : HealthReportModal
Quand on clique "View Full Report" :
- Modal plein écran avec tous les HealthFactors
- Chaque facteur dans une Card avec : nom, gauge mini, détail, recommendation
- Groupés par catégorie (Limits, Jobs, Storage)

Validation : pnpm typecheck + pnpm test + pnpm build

---

## PHASE 2 : Monitor — Trend Analysis & Sparklines (25 min)

### Concept
Stocker les snapshots de limites dans le temps pour afficher des tendances.

### Extension : TrendStorage service

```typescript
// packages/extension/src/modules/monitor/TrendStorage.ts
interface LimitSnapshot {
  timestamp: number;
  orgId: string;
  limits: Record<string, { used: number; max: number }>;
  healthScore: number;
}

class TrendStorage {
  // Stocker dans context.globalState sous la clé 'sandforge.trends.{orgId}'
  // Garder max 7 jours de données
  // Auto-purge des données > 7 jours
  
  async saveSnapshot(orgId: string, snapshot: LimitSnapshot): Promise<void>;
  async getSnapshots(orgId: string, hours: number): Promise<LimitSnapshot[]>;
  async getTrend(orgId: string, limitName: string, hours: number): Promise<TrendData>;
}

interface TrendData {
  points: { timestamp: number; value: number; max: number }[];
  direction: 'up' | 'down' | 'stable';
  changePercent: number;
  predictedTimeToLimit: number | null;
}
```

### Extension : sauvegarder automatiquement
- À chaque `monitor:start` ou `monitor:refresh`, sauvegarder un snapshot
- Ne pas sauvegarder plus d'1 snapshot par 15 minutes pour le même orgId

### Extension : nouveau message
- `monitor:trends` {orgId, limitNames[], hours} → `monitor:trends:data` {trends}

### WebView : Sparklines dans les KPI Cards
- Sparkline SVG : 50-100px large, 20-30px haut, courbes bézier lissées
- Couleur selon status (vert/orange/rouge)
- Indicateur trend (↑ +12%/24h, ↓ -5%/24h, → stable)
- Si trend up ET >75% : "Limit reached in ~2h14" en rouge

### WebView : composant Sparkline
```typescript
// packages/webview/src/components/ui/Sparkline.tsx
interface SparklineProps {
  data: number[];
  width?: number;      // default 100
  height?: number;     // default 24
  color?: string;
  fillOpacity?: number; // 0.1
  showDots?: boolean;
  animate?: boolean;
}
```
SVG pur, pas de librairie chart. Bézier pour le lissage. Fill gradient optionnel.

### WebView : Trend Detail Panel
Onglet "Trends" dans Monitor Dashboard :
- Graphiques 400x200 par limite clé
- Sélecteur période : 1h, 6h, 24h, 7d
- Seuils warning (75%) et critical (90%) en pointillés
- Prédiction en pointillé si trend up

Validation : pnpm typecheck + pnpm test + pnpm build

---

## PHASE 3 : Monitor — Smart Alerts & Apex Jobs Intelligence (15 min)

### Extension : JobAnalyzer service

```typescript
// packages/extension/src/modules/monitor/JobAnalyzer.ts
interface JobInsight {
  type: 'frequent_failures' | 'long_running' | 'high_consumer' | 'stuck';
  severity: 'info' | 'warning' | 'critical';
  title: string;
  detail: string;
  affectedJobs: string[];
  recommendation: string;
}
```

Détection : fails fréquents (>3/24h), jobs longs (>5min), gros consommateurs (>1000 batches), stuck (Processing >1h).

### Extension : enrichir monitor:data avec jobInsights[]

### WebView : Alerts Banner collapsible, badges sévérité, actions inline (Abort Job)

### WebView : Jobs Table améliorée
- Grouper par Apex Class (accordion)
- Stats par classe : runs, taux succès, durée moyenne
- Filtres : All | Running | Failed | Completed

### Extension : Abort Job handler
- `monitor:abort-job` {orgId, jobId} → PATCH AsyncApexJob Status='Aborted'

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
  summary: { total, added, removed, modified, byRisk };
  riskScore: number;
  deploymentAdvice: string;
}
```

### Règles de Risk Scoring
- Suppression champ avec données → critical
- Suppression champ référencé Flow/VR/Trigger → critical
- Modification type champ → high
- Suppression validation rule → medium
- Ajout champ required sans default → high
- Ajout champ non-required → none
- Modification Flow → medium
- Modification Profile/PermSet → low

### WebView : RiskScoreCard, DiffGroupAccordion, DiffItem, DiffDetailModal

### Actions : Export Report (JSON), Generate package.xml, Deploy (v2)

### Extension handlers : compare:export, compare:package-xml

Validation : pnpm typecheck + pnpm test + pnpm build

---

## PHASE 5 : Compare — Category Deep Dive & Metadata Types (20 min)

### Extension : CompareEngine élargi
Support : Custom Objects, Custom Fields, Validation Rules, Flows, Profiles, Permission Sets, Custom Labels, Apex Classes, Apex Triggers, LWC.

### WebView : Category Selector (chips/toggles), Tabs par catégorie, Heatmap visuelle

Validation : pnpm typecheck + pnpm test + pnpm build

---

## PHASE 6 : Monitor — Org Info Panel (10 min)

### Extension : OrgInfoFetcher
```typescript
interface OrgInfo {
  name: string;
  orgId: string;
  type: 'Production' | 'Sandbox' | 'Scratch' | 'Developer';
  edition: string;
  instanceName: string;
  apiVersion: string;
  userCount: number;
  customObjectCount: number;
  apexClassCount: number;
  flowCount: number;
  lastLoginDate: string;
}
```

### WebView : OrgInfoPanel — tab "Overview" dans Monitor

Validation : pnpm typecheck + pnpm test + pnpm build

---

## PHASE 7 : Validation finale (5 min)

1. pnpm typecheck → 0 erreurs
2. pnpm test → tous passent
3. pnpm build → success
4. pnpm package → sandforge.vsix
5. Vérifier --sf-* tokens
6. Vérifier handlers dans MessageRouter
7. Vérifier mocks jsforce

Résumé final : fichiers, tests, taille .vsix, services, messages, composants.

---

## CONTRAINTES GLOBALES
- SVG pur pour gauges et sparklines (PAS de librairie chart)
- Données trend dans globalState (PAS filesystem), max 7 jours, max 500KB/org
- Queries SOQL wrappées en try/catch
- Pas de breaking changes sur messages existants
- Compare : timeout 30s max, paralléliser avec Promise.allSettled
- Tous les textes en anglais
