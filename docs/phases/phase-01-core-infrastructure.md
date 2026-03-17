# Phase 01 — Core Infrastructure

> **Status:** COMPLETED

## Objectifs

Construire l'infrastructure technique partagee : types, schemas Zod, message broker, connection pool, bridge WebView-Extension, moteur d'execution et systeme de grappe (parallelisation).

## Fichiers crees

### packages/shared/src/types

- `common.types.ts` — Types communs (OrgInfo, FieldDescribe, SObjectDescribe, etc.)
- `messages.types.ts` — Types de messages WebView <-> Extension
- `org.types.ts` — Types organisation Salesforce
- `settings.types.ts` — Types configuration utilisateur
- `errors.types.ts` — Types et codes d'erreur
- `pipeline.types.ts` — Types pipeline d'execution
- `grappe.types.ts` — Types systeme de grappe (partitionnement)
- `precheck.types.ts` — Types pre-verification
- `reporting.types.ts` — Types rapports et analytics
- Tests associes (`*.test.ts`) pour chaque fichier

### packages/shared/src/schemas

- `message.schema.ts` — Schemas Zod pour messages
- `pipeline.schema.ts` — Schemas Zod pour pipelines
- `settings.schema.ts` — Schemas Zod pour settings
- `grappe.schema.ts` — Schemas Zod pour grappes
- `index.ts` — Barrel exports
- Tests associes (`*.test.ts`) pour chaque fichier

### packages/shared/src/constants

- `ai-config.ts` — Configuration IA (providers, modeles)
- `defaults.ts` — Valeurs par defaut
- `error-codes.ts` — Codes d'erreur standardises
- `sf-field-types.ts` — Types de champs Salesforce
- `sf-limits.ts` — Governor Limits Salesforce
- `sf-standard-objects.ts` — Objets standard Salesforce
- `monitor.ts` — Constantes monitoring
- Tests associes (`*.test.ts`) pour chaque fichier

### packages/shared/src/utils

- `date-utils.ts` — Utilitaires date/heure
- `format-utils.ts` — Formatage (bytes, nombres, durees)
- `hash-utils.ts` — Fonctions de hachage
- `sf-utils.ts` — Utilitaires Salesforce (isValidApiName, estimateApiCalls)
- `string-utils.ts` — Utilitaires string (truncate, slugify)
- `validation-utils.ts` — Utilitaires validation (isValidCron, etc.)
- `execution-result.ts` — Type Result monadique
- Tests associes (`*.test.ts`) pour chaque fichier

### packages/extension/src/bridge

- `MessageBroker.ts` — Routeur central de messages Extension <-> WebView
- `MessageRouter.ts` — Routage par type de message vers handlers
- `WebviewStateSync.ts` — Synchronisation d'etat WebView
- `ExtensionHandlers.ts` — Enregistrement des handlers globaux
- `handlers/HandlerTypes.ts` — Types pour les handlers de bridge
- `handlers/OrgHandler.ts` — Handler messages organisation
- `handlers/SettingsHandler.ts` — Handler messages settings
- Tests associes (`*.test.ts`)

### packages/extension/src/core/connection

- `AuthProvider.ts` — Authentification OAuth2 / JWT / Username-Password
- `ConnectionPool.ts` — Pool de connexions jsforce reutilisables
- `ConnectionHelper.ts` — Helpers connexion Salesforce
- `CircuitBreaker.ts` — Circuit breaker pour appels API
- `OrgManager.ts` — Gestion multi-org (ajout, suppression, switch)
- `OrgRegistry.ts` — Registre des organisations connectees
- `OrgHealthProbe.ts` — Sonde de sante des organisations
- `TokenRefresher.ts` — Rafraichissement automatique des tokens
- `OfflineManager.ts` — Detection et gestion mode hors-ligne
- `SfdxBridge.ts` — Integration avec Salesforce CLI (sfdx/sf)
- Tests associes (`*.test.ts`) pour chaque fichier

### packages/extension/src/core/engine

- `BatchProcessor.ts` — Traitement par lots avec isolation d'erreur
- `BatchOptimizer.ts` — Optimisation dynamique de la taille des lots
- `BulkApiManager.ts` — Gestion Bulk API 2.0 (create, poll, results)
- `CompositeApiManager.ts` — Gestion Composite API (records lies)
- `DependencyResolver.ts` — Resolution de dependances (tri topologique)
- `ExecutionPipeline.ts` — Pipeline d'execution multi-etapes
- `ErrorClassifier.ts` — Classification des erreurs SF (retryable, fatal, etc.)
- `RetryStrategy.ts` — Strategies de retry avec backoff exponentiel + jitter
- `RateLimiter.ts` — Rate limiting par fenetre glissante
- `CheckpointManager.ts` — Checkpoints pour reprise apres erreur
- `RollbackManager.ts` — Rollback en cas d'echec
- `PerformanceTracker.ts` — Suivi des performances (duree, throughput)
- `QueueManager.ts` — File d'attente de jobs
- `WorkerPool.ts` — Pool de workers pour parallelisation
- Tests associes (`*.test.ts`) pour chaque fichier

### packages/extension/src/core/grappe

- `GrappeOrchestrator.ts` — Orchestrateur du systeme de grappe
- `GrappePartitioner.ts` — Partitionnement des donnees en grappes
- `GrappeWorkerManager.ts` — Gestion des workers de grappe
- `GrappeScheduler.ts` — Ordonnancement des grappes
- `GrappeAggregator.ts` — Agregation des resultats de grappes
- `GrappeMonitor.ts` — Monitoring des grappes en cours
- `BackPressureManager.ts` — Gestion de la back-pressure
- Tests associes (`*.test.ts`) pour chaque fichier

### packages/extension/src/core/common

- `TypedEventEmitter.ts` — EventEmitter generique type avec isolation
- `DmlOperationTracker.ts` — Suivi des operations DML
- `RateLimiter.ts` — Rate limiter commun
- `extractErrorMessage.ts` — Extraction message d'erreur
- `queryLimits.ts` — Requete des limites API
- `sforceLimitParser.ts` — Parser du header Sforce-Limit-Info
- `soqlQueryHelper.ts` — Helpers requetes SOQL
- `soqlValidator.ts` — Validation de requetes SOQL
- Tests associes (`*.test.ts`) pour chaque fichier

### packages/extension/src/core (autres sous-modules)

- `storage/ConfigStore.ts` — Store de configuration persistant
- `storage/ConfigStoreBackend.ts` — Backend abstrait pour ConfigStore
- `storage/MementoConfigStoreBackend.ts` — Backend via VSCode Memento
- `storage/BackupStorage.ts` — Stockage des backups
- `storage/EncryptionManager.ts` — Chiffrement AES des donnees sensibles
- `storage/SecretVault.ts` — Coffre-fort pour secrets (tokens, credentials)
- `metadata/MetadataReader.ts` — Lecture des metadonnees Salesforce
- `metadata/SchemaAnalyzer.ts` — Analyse du schema d'objets
- `metadata/SchemaCache.ts` — Cache de schema avec invalidation
- `metadata/ObjectGraph.ts` — Graphe de dependances entre objets
- `metadata/CrudFlsGuard.ts` — Verification CRUD + FLS avant operations
- `notifications/NotificationCenter.ts` — Centre de notifications
- `reporting/ReportGenerator.ts` — Generation de rapports
- `reporting/ExportEngine.ts` — Export (CSV, Excel, PDF)
- `reporting/AuditLogger.ts` — Journal d'audit
- `reporting/AnalyticsCollector.ts` — Collecte de metriques
- `reporting/DataLineageTracker.ts` — Suivi de lignee de donnees
- `telemetry/TelemetryService.ts` — Service de telemetrie
- `plugins/PluginManager.ts` — Gestionnaire de plugins
- `onboarding/OnboardingService.ts` — Service d'onboarding
- `onboarding/HintTracker.ts` — Suivi des hints affiches
- `cli/CliParser.ts` — Parser de commandes CLI
- `cli/CliRunner.ts` — Executeur de commandes CLI
- `cli/CliReporter.ts` — Reporter de resultats CLI
- Tests associes (`*.test.ts`) pour chaque fichier

### packages/extension/src/core/precheck

- `PreCheckEngine.ts` — Moteur de pre-verification
- `PermissionCheck.ts` — Verification des permissions
- `SchemaCheck.ts` — Verification du schema
- `ApiLimitCheck.ts` — Verification des limites API
- `OrgStatusCheck.ts` — Verification du statut org
- `DataIntegrityCheck.ts` — Verification integrite des donnees
- `SecurityCheck.ts` — Verification securite
- `PerformanceCheck.ts` — Verification performance
- `StorageCheck.ts` — Verification stockage
- `CompatibilityCheck.ts` — Verification compatibilite
- `PIIDetector.ts` — Detection de donnees PII
- `ProductionGuard.ts` — Protection contre operations en production
- `AutoFixer.ts` — Correction automatique de problemes detectes
- Tests associes (`*.test.ts`) pour chaque fichier

### packages/extension/src/providers

- `SidebarViewProvider.ts` — Provider pour la sidebar VSCode
- `StatusBarProvider.ts` — Provider pour la status bar
- `WebviewPanelManager.ts` — Gestionnaire de panneaux WebView
- Tests associes (`*.test.ts`)

### packages/webview/src/bridge

- `BridgeProvider.tsx` — React context provider pour le bridge
- `messageHelpers.ts` — Helpers pour creation de messages
- Tests associes (`*.test.ts`)

### packages/webview/src/hooks

- `useBridgeQuery.ts` — Hook React pour requetes via bridge
- `useBridgeMutation.ts` — Hook React pour mutations via bridge
- `useMessageResponse.ts` — Hook partage pour lifecycle des messages
- `useMessageBus.ts` — Hook pour ecoute de messages
- `useVSCodeApi.ts` — Hook pour API VSCode WebView
- `useTheme.ts` — Hook pour theme VSCode
- `useConnectivityStatus.ts` — Hook statut de connexion
- `useErrorNotification.ts` — Hook notifications d'erreur
- `useGlobalShortcuts.ts` — Hook raccourcis clavier globaux
- `useKonamiCode.ts` — Easter egg Konami Code
- `useAIFeatures.ts` — Hook pour fonctionnalites IA
- Tests associes (`*.test.ts`)

### packages/webview/src/stores

- `useAppStore.ts` — Store global application (navigation, module actif)
- `useOrgStore.ts` — Store organisations connectees
- `useSettingsStore.ts` — Store parametres utilisateur
- `useNotificationStore.ts` — Store notifications
- `useCommandStore.ts` — Store commandes (CommandPalette)
- `useFavoritesStore.ts` — Store favoris
- `useRecentOpsStore.ts` — Store operations recentes
- `useGrappeStore.ts` — Store grappes
- Tests associes (`*.test.ts`)

## Criteres de validation

- [x] Tous les types compiles sans erreur avec TypeScript strict
- [x] Tous les schemas Zod alignes avec les types TypeScript
- [x] MessageBroker route correctement les messages entre WebView et Extension
- [x] ConnectionPool gere les connexions avec circuit breaker et retry
- [x] Systeme de grappe partitionne, execute et agregue correctement
- [x] PreCheckEngine execute toutes les verifications avant operations
- [x] 100% des fichiers ont un test associe
- [x] `pnpm validate` passe sans erreur
