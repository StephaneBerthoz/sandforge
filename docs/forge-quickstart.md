# Forge: Dev Sandbox Quickstart

> **Goal:** clone a real record graph from a partial-copy sandbox into your dev sandbox in 60 seconds.

## Why Forge?

Hand-crafting test data for a dev sandbox takes time. Pick a real record on a partial-copy / full-copy sandbox, and Forge clones it + the related records (Account, Contacts, Opportunities, Cases…) into your dev sandbox with full referential integrity.

What it handles for you:

- **Record-scoped clone**: only the transitive closure of the root record (1 Case → ~50 records, not 261 858)
- **RecordType cross-org**: re-mapped automatically by `DeveloperName`
- **Reference data**: `BusinessHours`, `OperatingHours`, `ServiceTerritory` mapped by `Name` instead of cloned
- **Person Account quirks**: `__pc` and auto-`Name` fields stripped per-record
- **Picklist drift**: values not present on the target are silently stripped
- **Cycle FKs** (Account ↔ Contact): 2-pass insert + UPDATE
- **Required orphan parents**: single-hop fetch when an Asset references an Account outside the scope
- **Upsert via External Id**: re-runs patch existing rows instead of failing on `DUPLICATE_VALUE`
- **GDPR / PHI presets**: one-click anonymization for Email, Phone, Address, Birthdate (4 starter presets)

## 60-second wizard quickstart

```
1. Open VSCode → Sidebar → SandForge → Forge
2. Pick a Source org (your partial copy) and a Target sandbox
3. Paste a record ID (e.g. a Case Id) or pick a Salesforce URL
4. Choose a Starter template:
     • Account 360
     • Case Workflow      ← typical Service Cloud dev case
     • Lead → Opportunity
5. Click "Discover Graph"
6. Review the preview card:
     • What will be cloned (X obj / Y records)
     • What will be mapped (BusinessHours, OperatingHours)
     • What will be skipped (excluded / out-of-scope)
7. (Optional) Pick an anonymization preset:
     • GDPR — default
     • GDPR — strict
     • Healthcare — PHI
     • Internal-test — minimal
8. Click "Execute Forge"
9. The Errors panel groups any failures by object/stage with
    Salesforce-code → human-friendly explanation + action hint
```

## Headless quickstart (CLI)

When you're scripting (CI, batch sandbox refresh), skip the wizard:

```bash
# Authenticate the orgs (one-time)
sf org login web --alias MY-PARTIAL-COPY
sf org login web --alias MY-DEV

# Clone a record graph (dry-run first, real second)
pnpm tsx packages/extension/cli/sandforge-clone.ts \
  --record 500AP00000fXeQsYAK \
  --source MY-PARTIAL-COPY \
  --target MY-DEV \
  --depth custom --custom-depth 5 \
  --max 50 \
  --anonymize \
  --dry-run

# When happy, drop --dry-run
pnpm tsx packages/extension/cli/sandforge-clone.ts \
  --record 500AP00000fXeQsYAK \
  --source MY-PARTIAL-COPY \
  --target MY-DEV \
  --depth custom --custom-depth 5 \
  --max 50

# Cleanup later (delete what you cloned today)
pnpm tsx packages/extension/cli/sandforge-cleanup.ts \
  --target MY-DEV \
  --since today \
  --dry-run

# Confirmed? drop --dry-run
pnpm tsx packages/extension/cli/sandforge-cleanup.ts \
  --target MY-DEV --since today
```

CLI exit code is `1` when the run produced **only** failures and `0` otherwise; wire it as a CI gate.

## Common errors and what they mean

| Error                                        | What it means                                                | What to do                                              |
| -------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------- |
| `DUPLICATE_VALUE`                            | A record with this External Id already exists on target.     | Enable upsert mode, or run `sandforge-cleanup`.         |
| `INVALID_CROSS_REFERENCE_KEY: Owner ID`      | Source User doesn't exist on target.                         | Auto-handled: Salesforce assigns the running user.     |
| `REQUIRED_FIELD_MISSING`                     | A required FK pointed outside the scope.                     | Enable "Auto-fetch parents" toggle in the wizard.       |
| `INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST`    | Source picklist value missing on target.                     | Auto-handled: value is silently stripped.              |
| `CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY`       | Object is read-only (audit/history table).                   | Auto-handled: node is now skipped pre-flight.          |
| `FIELD_INTEGRITY_EXCEPTION` (Asset)          | Asset needs at least an Account or Contact.                  | Enable "Auto-fetch parents" toggle.                     |

The wizard's Errors panel shows the explanation + action hint inline, in your VSCode locale (FR/EN).

## What's next?

- [Forge: Record-Scoped Clone (architecture)](./forge-record-scoped.md)
- Sample scenarios: see `packages/extension/examples/`
