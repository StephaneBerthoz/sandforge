# Forge — Example Scenarios

Copy-paste recipes for the most common dev sandbox seeding scenarios.
All examples assume `sf` CLI is authenticated for the source and target
aliases.

## Scenario 1 — Clone a Service Cloud Case

**Use case:** debug a customer support flow on a real Case from prod.

```bash
# Dry-run first (no writes)
pnpm tsx packages/extension/cli/sandforge-clone.ts \
  --record 500XX00000000001AAA \
  --source SOURCE-UAT \
  --target TARGET-DEV \
  --depth custom --custom-depth 5 \
  --max 50 \
  --dry-run

# Real run with anonymization
pnpm tsx packages/extension/cli/sandforge-clone.ts \
  --record 500XX00000000001AAA \
  --source SOURCE-UAT \
  --target TARGET-DEV \
  --depth custom --custom-depth 5 \
  --max 50 \
  --anonymize
```

Expected output (SOURCE-UAT → TARGET-DEV, fresh Case 00001234):

```
Case          1/1 ✓
Contact       1/1 ✓
Account       2/2 ✓ (Person Account stripped __pc + auto-Name)
Asset         2/2 ✓ (parents auto-fetched)
InsurancePolicy 1/1 ✓
InsurancePolicyCoverage 1/1 ✓
Contract      1/1 ✓
CustomChild__c 1/5 ⚠ (4 hit a custom required field — see error panel)
BusinessHours mapped via reference-data lookup
```

## Scenario 2 — Clone an Account 360

**Use case:** populate dev sandbox with an Account + its Contacts + Opportunities + Cases for end-to-end testing.

In the wizard:

```
1. Forge → Source: PROD-COPY, Target: DEV
2. Starter template: "Account 360"
3. Record ID: 001XX00000000001AAA
4. Anonymization preset: "GDPR — default"
5. Toggle "Auto-fetch parents"
6. Discover Graph → Review → Execute
```

Or via CLI:

```bash
pnpm tsx packages/extension/cli/sandforge-clone.ts \
  --record 001XX00000000001AAA \
  --source PROD-COPY \
  --target DEV \
  --depth custom --custom-depth 4 \
  --anonymize
```

## Scenario 3 — Re-run after a partial-copy refresh

**Use case:** you cloned a Case last week, your dev sandbox has been refreshed, you want to re-clone the same Case fresh.

Two options depending on your External Id setup:

**A) With External Id field on the object (recommended)** — wizard "upsert mode" automatically patches existing rows:

```bash
# In the wizard, set "upsertMode: 'auto'" via ForgeConfig OR
pnpm tsx packages/extension/cli/sandforge-clone.ts \
  --record 500XX00000000001AAA \
  --source SOURCE-UAT \
  --target TARGET-DEV \
  --upsert
```

**B) Without External Id** — clean up first, then re-clone:

```bash
# Step 1 — wipe today's clones
pnpm tsx packages/extension/cli/sandforge-cleanup.ts \
  --target TARGET-DEV --since today

# Step 2 — re-clone
pnpm tsx packages/extension/cli/sandforge-clone.ts \
  --record 500XX00000000001AAA \
  --source SOURCE-UAT --target TARGET-DEV
```

## Scenario 4 — CI gate (sandbox refresh job)

**Use case:** your CI job refreshes a shared dev sandbox every night with a curated set of records.

```yaml
# .github/workflows/seed-sandbox.yml
- name: Seed sandbox
  run: |
    for caseId in 500XX00000000003AAA 500XX00000000004AAA 500XX00000000005AAA; do
      pnpm tsx packages/extension/cli/sandforge-clone.ts \
        --record "$caseId" \
        --source PROD-COPY --target DEV-SHARED \
        --max 100 --anonymize \
        || exit 1
    done
```

CLI returns exit code `1` if all records failed, `0` otherwise — fail the job loudly.

## Tips

- **Always dry-run first** with `--dry-run` to inspect SOQL and counts before writing.
- **Inspect the graph alone** with `tools/recipe-forge-grappe.ts` — a repo-only dev recipe that replays discovery and planning against live orgs. It does run the executor, but `SCENARIO.dryRun` is hardcoded `true` and the write deps are stubbed under that flag, so nothing reaches the target org until you flip it.
- **Cap with `--max`** while iterating — start at 5, raise once you trust the output.
- **Use `--anonymize`** as soon as you share the dev sandbox with anyone outside your immediate team.
- **Pick a fresh Case** for each demo — re-runs hit `DUPLICATE_VALUE` until you pass `--upsert`.
- **Cleanup** after sensitive demos: `sandforge-cleanup --target X --since today`.
