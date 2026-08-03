# Phase 05 — Compare Module

> **Status:** COMPLETED

## Objectifs

Construire le module Compare Org pour la comparaison entre organisations Salesforce : diff de metadonnees, permissions, configuration, detection de drift et analyse d'impact.

## Fichiers crees

### packages/extension/src/modules/compare

- `CompareOrchestrator.ts` — Point d'entree, orchestre la comparaison
- `DiffEngine.ts` — Moteur de diff generique (ajout, suppression, modification)
- `DiffAnalyzer.ts` — Analyse approfondie des differences
- `MetadataCompare.ts` — Comparaison de metadonnees (objets, champs, layouts)
- `DataCompare.ts` — Comparaison de donnees entre orgs
- `ConfigCompare.ts` — Comparaison de configuration (custom settings, etc.)
- `PermissionCompare.ts` — Comparaison des permissions (profiles, permission sets)
- `SnapshotManager.ts` — Gestion des snapshots d'org (capture, stockage, restauration)
- `DriftDetector.ts` — Detection de derive (drift) entre orgs
- `ImpactAnalyzer.ts` — Analyse d'impact des differences detectees
- `DeploymentBuilder.ts` — Construction de package de deploiement depuis les diffs
- `CompareReport.ts` — Generation de rapports de comparaison
- `ProblemAnalyzer.ts` — Analyse des problemes detectes
- Tests associes (`*.test.ts`) pour chaque fichier (13 fichiers de test)

### packages/shared/src/types

- `compare.types.ts` — Types du module Compare (DiffResult, CompareConfig, DriftInfo, etc.)
- `compare.types.test.ts` — Tests des types

### packages/extension/src/bridge/handlers

- `CompareHandler.ts` — Handler bridge pour operations de comparaison

### packages/webview/src/pages/Compare

- `ComparePage.tsx` — Page principale avec 6 onglets
- `OrgSelector.tsx` — Selecteur d'organisations a comparer
- `CategorySelector.tsx` — Selecteur de categories de metadonnees
- `DiffViewer.tsx` — Visualiseur de diff inline
- `DiffGroupAccordion.tsx` — Accordion de groupes de differences
- `DiffDetailModal.tsx` — Modale de detail d'une difference
- `PermissionMatrix.tsx` — Matrice de comparaison de permissions
- `SnapshotTimeline.tsx` — Timeline des snapshots d'org
- `DriftDashboard.tsx` — Dashboard de detection de drift
- `ImpactGraph.tsx` — Graphe d'impact des modifications
- `DeployFromDiff.tsx` — Deploiement depuis les differences
- `RiskScoreCard.tsx` — Carte de score de risque
- `enrichDiffs.ts` — Enrichissement des diffs avec metadata
- Tests associes (`*.test.tsx` / `*.test.ts`) pour chaque fichier

## Criteres de validation

- [x] DiffEngine compare metadonnees, donnees et configuration
- [x] PermissionCompare detecte les differences de permissions par profil
- [x] SnapshotManager capture et restaure des snapshots d'org
- [x] DriftDetector identifie les derives non planifiees
- [x] ImpactAnalyzer evalue l'impact des differences
- [x] DeploymentBuilder genere un package deployable depuis les diffs
- [x] ComparePage affiche 6 onglets (diff, permissions, snapshots, drift, impact, deploy)
- [x] `pnpm validate` passe sans erreur
