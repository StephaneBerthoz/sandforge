# Phase 02 — Seed Module (Forge)

> **Status:** COMPLETED

## Objectifs

Construire le module Seed/Forge pour la generation de donnees intelligente dans les sandboxes Salesforce. Generation assistee par IA avec respect des contraintes de schema, validation rules, relations et record types.

## Fichiers crees

### packages/extension/src/modules/seed

- `SeedOrchestrator.ts` — Point d'entree, orchestre le flux complet de seeding
- `SchemaAnalyzer.ts` — Analyse du schema Salesforce (champs, relations, contraintes)
- `FieldMapper.ts` — Mapping des champs source vers cible
- `AIDataGenerator.ts` — Generation de donnees via IA (prompts adaptatifs)
- `SmartFieldGenerator.ts` — Generation intelligente par type de champ
- `FakerFallback.ts` — Fallback Faker.js quand l'IA n'est pas disponible
- `DataPatternAnalyzer.ts` — Analyse des patterns de donnees existantes
- `DataPlanBuilder.ts` — Construction du plan d'execution (ordre, volumes)
- `CrossObjectConsistency.ts` — Coherence inter-objets (references croisees)
- `ReferenceLinker.ts` — Resolution et liaison des references (lookups, master-detail)
- `RecordTypeAwareSeed.ts` — Gestion des Record Types dans la generation
- `SeedValidator.ts` — Validation des donnees generees avant insertion
- `PostSeedValidator.ts` — Validation post-insertion (integrite, counts)
- `VRPreChecker.ts` — Pre-verification des Validation Rules
- `SeedTemplateManager.ts` — Gestion des templates de seed reutilisables
- `SeedGrappeAdapter.ts` — Adapter pour parallelisation via systeme de grappe
- Tests associes (`*.test.ts`) pour chaque fichier (16 fichiers de test)

### packages/shared/src/types

- `seed.types.ts` — Types du module Seed (SeedConfig, SeedPlan, SeedResult, etc.)
- `seed.types.test.ts` — Tests des types

### packages/shared/src/schemas

- `seed-config.schema.ts` — Schema Zod pour configuration de seed
- `seed-config.schema.test.ts` — Tests du schema

### packages/extension/src/bridge/handlers

- `SeedOpsHandler.ts` — Handler bridge pour operations de seed

### packages/webview/src/pages/Seed

- `SeedPage.tsx` — Page principale du module Seed
- `SeedWizard.tsx` — Wizard multi-etapes
- `Step1_SelectOrg.tsx` — Etape 1 : Selection de l'organisation cible
- `Step2_SelectObjects.tsx` — Etape 2 : Selection des objets a seeder
- `Step3_ConfigureFields.tsx` — Etape 3 : Configuration des champs
- `Step4_ConfigureRelations.tsx` — Etape 4 : Configuration des relations
- `Step5_SetVolumes.tsx` — Etape 5 : Definition des volumes
- `Step6_ReviewPlan.tsx` — Etape 6 : Revue du plan d'execution
- `Step7_Execute.tsx` — Etape 7 : Execution avec suivi en temps reel
- `Step8_Results.tsx` — Etape 8 : Resultats et rapport
- `ERDMiniMap.tsx` — Mini-carte du diagramme entite-relation
- `useSeedWizardState.ts` — Hook etat du wizard
- `useSeedOrgSelection.ts` — Hook selection d'org
- `useSeedObjectSelection.ts` — Hook selection d'objets
- `useSeedFieldConfig.ts` — Hook configuration des champs
- `useSeedFieldRules.ts` — Hook regles de champs
- `useSeedRelations.ts` — Hook configuration des relations
- `useSeedVolumes.ts` — Hook volumes
- `useSeedExecution.ts` — Hook execution
- `useSeedNL2SOQL.ts` — Hook Natural Language to SOQL
- `useSeedPIIScan.ts` — Hook scan PII
- Tests associes (`*.test.ts` / `*.test.tsx`) pour chaque fichier

## Criteres de validation

- [x] Wizard 8 etapes fonctionnel avec navigation avant/arriere
- [x] SchemaAnalyzer detecte champs obligatoires, relations, record types
- [x] AIDataGenerator produit des donnees coherentes par champ
- [x] CrossObjectConsistency maintient les references inter-objets
- [x] VRPreChecker identifie les Validation Rules bloquantes
- [x] SeedGrappeAdapter partitionne les gros volumes pour parallelisation
- [x] PostSeedValidator verifie l'integrite apres insertion
- [x] Templates reutilisables pour seedings repetitifs
- [x] `pnpm validate` passe sans erreur
