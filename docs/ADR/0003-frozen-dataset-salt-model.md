# 0003 — Frozen dataset salt model

**Status:** Accepted
**Date:** 2026-08-03

## Context

The Frozen Reference Dataset module (spec: `PROMPT_FROZEN_DATASET.md`)
pseudonymizes a business dataset extracted from a UAT sandbox so it can be
replayed identically into refreshed dev sandboxes. Determinism requires a
stable key — but that key is also the re-identification vector, so where
the salt lives *is* the security model.

## Decision

- **Salt is environment-only.** Pseudonymization is
  `HMAC-SHA256(SANDFORGE_FROZEN_SALT, "generator|value")`. The salt comes
  from an environment variable / secret manager, is never written to the
  repo, and is never persisted by the module.
- **Same output across objects.** The HMAC input deliberately excludes the
  carrying object/field, so the same source value produces the same
  pseudonym everywhere — cross-object joins (dedup, beneficiary lookup)
  behave like production.
- **Fingerprint, not salt, in the manifest.** The frozen manifest records
  only the salt's SHA-256 fingerprint (12 hex chars) plus volumetry and
  control outcomes — enough to detect a salt mismatch before replaying,
  useless for re-identification.
- **Staging area (sas) outside the repo.** The retained source-ID lists
  live in a local sas whose path is enforced outside the repository
  (`SasPathGuard` refuses any output path inside the repo): a versioned ID
  list would be a real ↔ anonymized mapping table.
- **No silent second salt.** Rotating the salt starts a new dataset
  lineage (new fingerprint); regenerating a salt in silence would destroy
  cross-version determinism and is treated as an operator error, not a
  feature.

## Consequences

- A leaked repo (or VSIX) contains nothing that helps re-identify records.
- Replaying a dataset with the wrong salt fails fast on the manifest
  fingerprint instead of producing a quietly divergent dataset.
- Losing the salt means the frozen lineage can never be extended — an
  accepted trade-off, documented in the module guide
  (`docs/modules/frozen-dataset.md`).
