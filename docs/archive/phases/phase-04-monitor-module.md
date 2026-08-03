# Phase 04 — Monitor Module

> **Status:** COMPLETED

## Objectifs

Construire le module Monitor pour le suivi en temps reel des organisations Salesforce : health scores, limites API, jobs, alertes, tendances et predictions.

## Fichiers crees

### packages/extension/src/modules/monitor

- `MonitorOrchestrator.ts` — Point d'entree, orchestre le monitoring
- `HealthCheck.ts` — Verification de sante globale de l'org
- `HealthScoreCalculator.ts` — Calcul du score de sante (0-100)
- `JobMonitor.ts` — Surveillance des jobs en cours (Bulk, Batch, Apex)
- `JobAnalyzer.ts` — Analyse et categorisation des jobs
- `LimitsTracker.ts` — Suivi des Governor Limits en temps reel
- `GovernorLimitPredictor.ts` — Prediction de depassement de limites
- `AlertEngine.ts` — Moteur d'alertes configurables (seuils, conditions)
- `ErrorLogMonitor.ts` — Surveillance des logs d'erreur
- `ApexLogAnalyzer.ts` — Analyse des debug logs Apex
- `OrgInfoFetcher.ts` — Recuperation des informations de l'org
- `OrgTrendAnalyzer.ts` — Analyse des tendances org (usage, growth)
- `TrendStorage.ts` — Stockage historique des donnees de tendance
- `trendUtils.ts` — Utilitaires pour traitement des tendances
- `transformLimitsResponse.ts` — Transformation de la reponse API Limits
- `SandboxRefreshTracker.ts` — Suivi des rafraichissements de sandbox
- `DeploymentTracker.ts` — Suivi des deployments
- `UserSessionMonitor.ts` — Monitoring des sessions utilisateur
- `ChangeDataCaptureListener.ts` — Ecoute Change Data Capture (CDC)
- Tests associes (`*.test.ts`) pour chaque fichier (19 fichiers de test)

### packages/shared/src/types

- `monitor.types.ts` — Types du module Monitor (HealthScore, LimitStatus, JobInfo, Alert, etc.)
- `monitor.types.test.ts` — Tests des types

### packages/extension/src/bridge/handlers

- `MonitorOpsHandler.ts` — Handler bridge pour operations de monitoring

### packages/webview/src/pages/Monitor

- `MonitorPage.tsx` — Page principale avec layout Bento
- `HealthGauge.tsx` — Jauge de sante radiale SVG
- `HealthScoreCard.tsx` — Carte de score de sante avec rapport
- `HealthScoreGauge.tsx` — Composant jauge du score de sante
- `JobsPanel.tsx` — Panneau des jobs en cours
- `JobsTable.tsx` — Table interactive des jobs
- `JobInsightsPanel.tsx` — Panneau d'insights sur les jobs
- `LimitsPanel.tsx` — Panneau des Governor Limits
- `AlertsPanel.tsx` — Panneau des alertes actives
- `OrgInfoPanel.tsx` — Panneau d'informations org
- `TrendChart.tsx` — Graphique de tendances Recharts
- `TrendCharts.tsx` — Collection de graphiques de tendances
- `PredictionsTile.tsx` — Tuile de predictions
- `useMonitorPageData.ts` — Hook donnees de la page Monitor
- Tests associes (`*.test.tsx`) pour chaque composant

## Criteres de validation

- [x] HealthScoreCalculator produit un score 0-100 avec decomposition
- [x] LimitsTracker surveille tous les Governor Limits principaux
- [x] GovernorLimitPredictor anticipe les depassements
- [x] AlertEngine declenche des alertes sur conditions configurables
- [x] TrendStorage stocke et restitue les donnees historiques
- [x] MonitorPage affiche le dashboard Bento avec KPIs en temps reel
- [x] HealthGauge visualise le score de sante en jauge radiale SVG
- [x] `pnpm validate` passe sans erreur
