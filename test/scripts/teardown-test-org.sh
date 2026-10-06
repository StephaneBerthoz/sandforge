#!/usr/bin/env bash
# SandForge E2E Test Org Teardown
# Removes test data created by setup-test-org.sh.
# Usage: ./teardown-test-org.sh <org-alias>

set -euo pipefail

ORG_ALIAS="${1:?Usage: teardown-test-org.sh <org-alias>}"

echo "Cleaning up test data in org: $ORG_ALIAS"

# Delete test contacts
sf data delete bulk --sobject Contact --where "Email LIKE '%@sandforge.dev'" --target-org "$ORG_ALIAS" --hard-delete 2>/dev/null || true

# Delete test accounts
sf data delete bulk --sobject Account --where "Name LIKE 'SandForge Test%'" --target-org "$ORG_ALIAS" --hard-delete 2>/dev/null || true

echo "Test data cleaned up in $ORG_ALIAS"
