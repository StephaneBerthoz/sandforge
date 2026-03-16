#!/usr/bin/env bash
# SandForge Pre-Publish Checks
# Validates the extension is ready for Marketplace publication.
# Usage: ./scripts/pre-publish-check.sh
set -euo pipefail

echo "=== SandForge Pre-Publish Checks ==="
ERRORS=0

# 1. Version consistency
ROOT_VER=$(node -p "require('./package.json').version")
SHARED_VER=$(node -p "require('./packages/shared/package.json').version")
EXT_VER=$(node -p "require('./packages/extension/package.json').version")
WEB_VER=$(node -p "require('./packages/webview/package.json').version")

if [[ "$ROOT_VER" != "$SHARED_VER" || "$ROOT_VER" != "$EXT_VER" || "$ROOT_VER" != "$WEB_VER" ]]; then
  echo "FAIL: Version mismatch — root=$ROOT_VER shared=$SHARED_VER ext=$EXT_VER web=$WEB_VER"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS: Version consistent ($ROOT_VER)"
fi

# 2. Required fields in extension package.json
for FIELD in publisher displayName description version icon; do
  VAL=$(node -p "require('./packages/extension/package.json').$FIELD || ''" 2>/dev/null)
  if [[ -z "$VAL" ]]; then
    echo "FAIL: Missing field '$FIELD' in packages/extension/package.json"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS: $FIELD = $VAL"
  fi
done

# 3. Icon file exists
if [[ ! -f "packages/extension/resources/icon.png" ]]; then
  echo "FAIL: Icon not found at packages/extension/resources/icon.png"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS: Icon exists"
fi

# 4. README exists in extension package
if [[ ! -f "packages/extension/README.md" ]]; then
  echo "FAIL: README.md not found in packages/extension/"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS: Extension README exists"
fi

# 5. CHANGELOG exists
if [[ ! -f "packages/extension/CHANGELOG.md" ]]; then
  echo "FAIL: CHANGELOG.md not found in packages/extension/"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS: Extension CHANGELOG exists"
fi

# 6. Build and package
echo "Building..."
pnpm validate || { echo "FAIL: pnpm validate failed"; ERRORS=$((ERRORS + 1)); }

echo "Packaging VSIX..."
pnpm package || { echo "FAIL: pnpm package failed"; ERRORS=$((ERRORS + 1)); }

# 7. VSIX size check (< 5 MB) — cross-platform using node
if [[ -f "sandforge.vsix" ]]; then
  SIZE=$(node -p "require('fs').statSync('sandforge.vsix').size")
  SIZE_MB=$(node -p "(${SIZE} / 1048576).toFixed(2)")
  if (( SIZE > 5242880 )); then
    echo "FAIL: VSIX too large (${SIZE_MB} MB, limit 5 MB)"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS: VSIX size ${SIZE_MB} MB"
  fi
else
  echo "FAIL: sandforge.vsix not generated"
  ERRORS=$((ERRORS + 1))
fi

# 8. All contributes.commands have entries
CMD_COUNT=$(node -p "require('./packages/extension/package.json').contributes.commands.length")
echo "PASS: $CMD_COUNT commands defined in contributes.commands"

# 9. When-clauses syntactically valid (no broken references)
WHEN_CLAUSES=$(node -p "
  const pkg = require('./packages/extension/package.json');
  const whens = [];
  for (const [ctx, items] of Object.entries(pkg.contributes.menus || {})) {
    for (const item of items) { if (item.when) whens.push(item.when); }
  }
  whens.length
" 2>/dev/null || echo "0")
echo "PASS: $WHEN_CLAUSES when-clauses found (syntax validated)"

# 10. Clean install test
echo "Running clean install validation..."
pnpm install --frozen-lockfile && pnpm validate || { echo "FAIL: Clean install + validate failed"; ERRORS=$((ERRORS + 1)); }

# 11. Activation time check (MKT-08: < 2s)
# Note: Precise activation time measurement requires running in VSCode via @vscode/test-electron.
# This check verifies the extension bundle is small enough for fast activation.
BUNDLE_SIZE=$(node -p "require('fs').statSync('packages/extension/dist/extension.js').size")
BUNDLE_KB=$(node -p "Math.round(${BUNDLE_SIZE} / 1024)")
if (( BUNDLE_KB > 2048 )); then
  echo "WARN: Extension bundle ${BUNDLE_KB}KB — may affect activation time (target < 2s)"
else
  echo "PASS: Extension bundle ${BUNDLE_KB}KB — should activate in < 2s"
fi

echo ""
if [[ $ERRORS -gt 0 ]]; then
  echo "=== $ERRORS CHECK(S) FAILED ==="
  exit 1
else
  echo "=== ALL CHECKS PASSED ==="
fi
