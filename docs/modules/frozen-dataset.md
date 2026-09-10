# Frozen Dataset

Extract a business dataset from a UAT sandbox **once**, pseudonymize it deterministically, freeze it (manifest + salt fingerprint), then **replay it identically** after every dev sandbox refresh -- with a non-reidentification gate before versioning and a verification pass after loading.

Typical case: a Developer sandbox refresh leaves you with metadata and zero records. Frozen Dataset gives you back a realistic set of root records covering your functional paths in one run, without ever shipping identifying data.

## Quick Start

1. Open **Frozen Dataset** from the sidebar (or `SandForge: Open Frozen Dataset` from the command palette)
2. **Extract** tab: fill in the root object, the coverage axes and the volume budget, then **Save configuration**
3. Set the salt -- `export SANDFORGE_FROZEN_SALT="<stable-secret>"` (never in the repository) -- and create the pseudonymization rules file
4. **Run selection** (coverage matrix), then **Run extraction**. The 4-point control must return PASS for the dataset to be written
5. **Load** tab: pick the target sandbox, tick **Pilot** to try a single root graph first, then **Run load**. Post-load verification is chained automatically

## Features

### Extraction Flow

1. **Coverage-matrix selection** (no random sampling): each axis is a configurable SOQL aggregate query; the module enumerates the **combinations actually observed** in the source org and keeps **one healthy root graph per combination** (complete graph via Forge discovery -- never a partial root), plus one per declared edge case. The volume budget (2,500 records by default) is **enforced mechanically**: anything above it is refused.
2. **Scope-aware extraction**: reuses `RecordScopeCache` and `ScopedSoqlBuilder` (full descendants plus the reference data they need, never `SELECT *`), with a frozen date bound (`CreatedDate <= asOf`) and an `rt-map.json` written to the sas.
3. **Deterministic pseudonymization**: `HMAC-SHA256(salt, "generator|value")`. The same input value produces the same output whatever object carries it, so cross-object joins survive. `RecordTypeId` is replaced by the RecordType **Name**, resolved on the target by **DeveloperName**, never by label.
4. **Non-reidentification control (gate)**: 4 checks -- substitution actually applied (including a value leaking into another field of the same record), fields under the `clear` generator left empty, shapes preserved (`registrationSIV`, `phoneE164`, `email`, `postalCodeGeneralize`), and zero residual source ID (18-character Salesforce checksum). **One FAIL and nothing is written or versioned.**
5. **Manifest**: semver version, `status: frozen`, source (org + decision date), salt fingerprint (SHA-256, 12 hex -- never the salt), rules version, volumetry (ceiling + measured), control results.

### Load Flow (Replayable)

Entry guards refuse with an actionable message, and never issue DML against the source:

- **sandbox only** (Production Guard tier check);
- configured **protected environments** are refused, as is the source org recorded in the manifest;
- **mocked callouts**: detected through custom metadata (`mockDetection`); when it is not configured the guard is explicitly disabled and reported in the tab;
- an **empty dataset** is refused.

Then: schema alignment (missing fields dropped **and listed**, restricted picklists including per-RecordType assignment gaps via the UI API), **technical placeholders** for lookups that became required on the target (never a silent exclusion), a two-pass insert for cycle FKs, a **post-load PersonContact** pass (sidecar `referenceId -> referenceId` resolved into targeted updates), and persistence of the `referenceId -> Id` mapping in the sas.

**Reload without refresh**: per-object identity keys (ExternalId, name, composite pairs) let the load reuse existing records; leftovers are purged **children before parents**, and undeletable objects are **deactivated** through a configured field. Native duplicate rejections on the target are an explicit degraded mode: those records are **skipped and listed**.

**Pilot**: a single root graph (~2 min) before committing to the full load.

### Post-Load Verification

Read-only, chained to the load (or replayed with **Re-verify**): per-object counts against the **counting contract**, orphans on mandatory lookups, presence by key (ExternalId), restored PersonContact links. For robustness it re-measures until **two identical readings** before returning a verdict (`passed` / `failed` / `unstable`). The verdict is recorded in the manifest under `controls.dryRunLoad`.

### Configuration

Per-project configuration persisted by the extension (main keys):

| Key                                       | Role                                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `rootObject`                              | Root object API name                                                                              |
| `axes`                                    | Coverage axes (`name`, `label`, `filterField`, `valuesSoql` aggregate with the `axisValue` alias) |
| `edgeCases`                               | Edge cases (`whereFragment`, marker in the data)                                                  |
| `budgetMaxRecords`                        | Volumetry ceiling (default 2,500)                                                                 |
| `expectedObjects`                         | Objects a root graph must contain to count as healthy                                             |
| `excludedFields`                          | Per-object fields excluded from the SELECT clause                                                 |
| `sasDir` / `datasetDir` / `rulesFilePath` | Paths (defaults: `~/.sandforge-sas`, `<sas>/dataset`, `<sas>/rules.json`)                         |
| `datasetVersion`                          | Semver stamped on the next frozen dataset                                                         |
| `protectedOrgIds`                         | Protected environments (refused at load time)                                                     |
| `identityKeys`                            | Per-object identity keys (reuse on reload)                                                        |
| `undeletableObjects`                      | Object -> deactivation field (leftovers deactivated, not deleted)                                 |
| `requiredLookupPlaceholders`              | `Object.field` placeholders (required lookup missing from the dataset)                            |
| `requiredFieldDefaults`                   | Declared default values, keyed `Object.field`                                                     |
| `picklistRules` / `defaultPicklistRule`   | Declared removal or replacement of rejected values                                                |
| `duplicateErrorPatterns`                  | Markers of the target's native duplicate-rejection errors                                         |
| `mockDetection`                           | Custom metadata + `IsMocked` boolean field                                                        |
| `mandatoryLookups` / `presenceKeys`       | Mandatory lookups and presence keys used by the verification                                      |

The **Extract** tab edits `rootObject`, the budget, the axes and the edge cases through a form; everything else goes through the **Advanced configuration** JSON area.

### Security and the Quarantine Directory (Sas)

- The **sas** (`~/.sandforge-sas` by default) is **outside the repository by construction**: `SasPathGuard` refuses any output path located inside the repo. The selection (source IDs), `rt-map.json`, the `{{TOKEN}}` values (`tokens.json`) and the `referenceId -> Id` mapping never leave it.
- The **salt** comes from `SANDFORGE_FROZEN_SALT` and nowhere else; only its **fingerprint** (12 hex) is recorded. Never regenerate a second salt silently -- determinism across dataset versions would be lost.
- The bridge **redacts**: the selection sent to the UI carries no source ID, and the details of `clear-empty` violations (which may embed a residual value) are redacted on the extension side.
- All DML goes through the existing **Production Guard** (tier check + audit trail).

## Limits

- Selection measures volumetry by running a **real extraction pass** on the retained roots (bounded by the budget). It is an interactive operation, not a batch job.
- Without `mockDetection` configured, the "mocked callouts" guard is disabled (shown as a warning). Deploy it before loading into an org that makes callouts.
- Reload without refresh needs identity keys that are usable on the target (ExternalId recommended).
- Picklist values outside the RecordType assignment require the **UI API** on the target (available on recent orgs).
