# Phase 03 — Sync Module

> **Status:** COMPLETED

## Objectifs

Construire le module Sync (ETL) pour la synchronisation de donnees entre organisations Salesforce et sources externes (CSV, JSON). Detection delta, field mapping interactif, transformations, gestion des conflits et scheduling.

## Fichiers crees

### packages/extension/src/modules/sync

- `SyncOrchestrator.ts` — Point d'entree, orchestre le flux complet de sync
- `DataSync.ts` — Moteur principal de synchronisation
- `DeltaDetector.ts` — Detection des changements (delta) entre source et cible
- `IncrementalTracker.ts` — Suivi incremental pour syncs repetitives
- `AutoFieldMapper.ts` — Mapping automatique des champs par nom/type
- `FieldMapping.ts` — Gestion du mapping de champs (manuel + auto)
- `TransformPipeline.ts` — Pipeline de transformations (format, calcul, enrichissement)
- `ConflictResolver.ts` — Resolution de conflits (last-write-wins, source-wins, merge)
- `DataMasker.ts` — Masquage de donnees sensibles pendant la sync
- `SchemaValidator.ts` — Validation du schema source vs cible
- `SyncAnalyzer.ts` — Analyse pre-sync (volumes, risques, estimations)
- `SyncScheduler.ts` — Planification de syncs recurrentes
- `ObjectSetManager.ts` — Gestion de sets d'objets predefined
- `MetadataSync.ts` — Synchronisation de metadonnees
- `MigrationScript.ts` — Scripts de migration programmables
- `CsvConnector.ts` — Connecteur source CSV
- `JsonConnector.ts` — Connecteur source JSON
- `ExternalIdManager.ts` — Gestion des External IDs pour upsert
- `UserMapper.ts` — Mapping des utilisateurs entre orgs
- `RecordTypeMapper.ts` — Mapping des Record Types entre orgs
- `PolymorphicHandler.ts` — Gestion des champs polymorphiques (WhoId, WhatId)
- `SelfReferenceHandler.ts` — Gestion des auto-references (parent Account, etc.)
- `SyncGrappeAdapter.ts` — Adapter pour parallelisation via systeme de grappe
- Tests associes (`*.test.ts`) pour chaque fichier (23 fichiers de test)

### packages/shared/src/types

- `sync.types.ts` — Types du module Sync (SyncConfig, SyncResult, FieldMapping, etc.)
- `sync.types.test.ts` — Tests des types

### packages/shared/src/schemas

- `sync-config.schema.ts` — Schema Zod pour configuration de sync
- `sync-config.schema.test.ts` — Tests du schema

### packages/extension/src/bridge/handlers

- `SyncOpsHandler.ts` — Handler bridge pour operations de sync
- `SyncOpsHandler.test.ts` — Tests du handler

### packages/webview/src/pages/Sync

- `SyncPage.tsx` — Page principale du module Sync
- `SyncWizard.tsx` — Wizard multi-etapes de synchronisation
- `FieldMappingCanvas.tsx` — Canvas interactif de mapping de champs (drag & drop)
- `ObjectSetEditor.tsx` — Editeur de sets d'objets
- `SoqlBuilder.tsx` — Constructeur de requetes SOQL visuel
- `SankeyFlow.tsx` — Visualisation Sankey du flux de donnees
- `SyncPreviewPanel.tsx` — Panneau de preview avant execution
- `TransformBuilder.tsx` — Constructeur de transformations
- `useSyncPageData.ts` — Hook donnees de la page Sync
- Tests associes (`*.test.tsx`) pour chaque composant

## Criteres de validation

- [x] DeltaDetector detecte les records modifies/ajoutes/supprimes
- [x] FieldMappingCanvas permet le mapping drag & drop interactif
- [x] TransformPipeline chaine les transformations correctement
- [x] ConflictResolver gere les 3 strategies de resolution
- [x] Connecteurs CSV et JSON fonctionnels avec validation
- [x] PolymorphicHandler et SelfReferenceHandler gerent les cas complexes
- [x] SyncScheduler planifie les syncs recurrentes
- [x] SyncGrappeAdapter partitionne les gros volumes
- [x] `pnpm validate` passe sans erreur
