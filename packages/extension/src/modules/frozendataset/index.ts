/**
 * Frozen Reference Dataset — core engine (spec §1-§5 + dead-ID sweep) and
 * load phase (spec §6-§7).
 *
 * Core engine: the FrozenDataset data structures, the manifest, and the
 * PersonContact sidecar. Load phase: FrozenDatasetLoader (replayable load
 * with entry guards, schema alignment, placeholders, 2-pass cycles and
 * PersonContact post-load) and PostLoadVerifier, plus the implementations
 * of the engine extension points (TargetRecordTypeIdResolver,
 * SasReferenceIdMappingStore).
 */

export * from './types.js';
export * from './salesforceId.js';
export * from './SasPathGuard.js';
export * from './DeterministicPseudonymizer.js';
export * from './rulesFile.js';
export * from './queryTemplates.js';
export * from './CoverageMatrixSelector.js';
export * from './ForgeGraphHealthChecker.js';
export * from './selectionStore.js';
export * from './FrozenDatasetExtractor.js';
export * from './FrozenDatasetAnonymizer.js';
export * from './NonReidentificationControl.js';
export * from './manifest.js';
export * from './FrozenDatasetWriter.js';

// Load phase (spec §6) and post-load verification (spec §7).
export * from './loadTypes.js';
export * from './LoadGuards.js';
export * from './TargetRecordTypeIdResolver.js';
export * from './SasReferenceIdMappingStore.js';
export * from './CountingContract.js';
export * from './SchemaAligner.js';
export * from './FrozenDatasetLoader.js';
export * from './PostLoadVerifier.js';
export * from './BulkDmlWriterAdapter.js';
