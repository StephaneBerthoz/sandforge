#!/usr/bin/env bash
# SandForge E2E Test Org Setup
# Creates test data in a scratch/sandbox org for integration testing.
# Usage: ./setup-test-org.sh <org-alias>
#
# Prerequisites:
#   - sf CLI installed and authenticated to target org
#   - Target org is a scratch org or sandbox (NEVER production)

set -euo pipefail

ORG_ALIAS="${1:?Usage: setup-test-org.sh <org-alias>}"

echo "Setting up test data in org: $ORG_ALIAS"

# Verify org type (safety check — refuse production orgs)
ORG_INFO=$(sf org display --target-org "$ORG_ALIAS" --json 2>/dev/null)
IS_SANDBOX=$(echo "$ORG_INFO" | grep -c '"isSandbox": true' || true)
IS_SCRATCH=$(echo "$ORG_INFO" | grep -c '"isScratchOrg": true' || true)

if [[ "$IS_SANDBOX" -eq 0 && "$IS_SCRATCH" -eq 0 ]]; then
  echo "ERROR: Org $ORG_ALIAS is not a sandbox or scratch org. Refusing to create test data."
  exit 1
fi

# Create test accounts
sf data create record --sobject Account --values "Name='SandForge Test Account 1' Type='Customer' Industry='Technology'" --target-org "$ORG_ALIAS"
sf data create record --sobject Account --values "Name='SandForge Test Account 2' Type='Prospect' Industry='Consulting'" --target-org "$ORG_ALIAS"

# Create test contacts
sf data create record --sobject Contact --values "FirstName='Test' LastName='Contact1' Email='test1@sandforge.dev'" --target-org "$ORG_ALIAS"
sf data create record --sobject Contact --values "FirstName='Test' LastName='Contact2' Email='test2@sandforge.dev'" --target-org "$ORG_ALIAS"

echo "Test data created successfully in $ORG_ALIAS"
