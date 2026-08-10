#!/usr/bin/env bash
# SandForge Pre-Publish Checks
# Validates the extension is ready for Marketplace publication.
# Usage: ./scripts/pre-publish-check.sh
#
# Env flags:
#   SKIP_BUILD_CHECKS=1 — skip the heavy build steps (6: pnpm validate +
#   package, 10: clean install + validate). Used by .github/workflows/release.yml,
#   which already runs validate + package as its own steps before calling this
#   script. The VSIX/bundle size checks (7, 11) still run — they only need the
#   artifacts those earlier steps produced.
set -euo pipefail

SKIP_BUILD_CHECKS="${SKIP_BUILD_CHECKS:-0}"

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

# 5b. Changelog freshness: the current version must have an entry in BOTH
# changelogs (pattern [X.Y.Z]). Blocking — 1.2.11 and 1.2.12 shipped without
# changelog entries.
for CL in "changelog.md" "packages/extension/CHANGELOG.md"; do
  if [[ ! -f "$CL" ]]; then
    echo "FAIL: $CL not found"
    ERRORS=$((ERRORS + 1))
  elif grep -qF "[$EXT_VER]" "$CL"; then
    echo "PASS: $CL has an entry for [$EXT_VER]"
  else
    echo "FAIL: $CL has no entry for current version [$EXT_VER] — add release notes before publishing"
    ERRORS=$((ERRORS + 1))
  fi
done

# 6. Build and package
if [[ "$SKIP_BUILD_CHECKS" != "1" ]]; then
  echo "Building..."
  pnpm validate || { echo "FAIL: pnpm validate failed"; ERRORS=$((ERRORS + 1)); }

  echo "Packaging VSIX..."
  pnpm package || { echo "FAIL: pnpm package failed"; ERRORS=$((ERRORS + 1)); }
else
  echo "SKIP: build + package (SKIP_BUILD_CHECKS=1 — caller already ran them)"
fi

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

# 8. Every command title %key% resolves in package.nls.json
if node -e "
  const pkg = require('./packages/extension/package.json');
  const nls = require('./packages/extension/package.nls.json');
  const cmds = pkg.contributes.commands || [];
  const bad = cmds
    .map(c => c.title)
    .filter(t => {
      const m = /^%([^%]+)%$/.exec(t || '');
      return !m || !(m[1] in nls);
    });
  if (bad.length) {
    console.error('Unresolvable command titles: ' + bad.join(', '));
    process.exit(1);
  }
  console.log(cmds.length + ' command titles checked');
"; then
  echo "PASS: All command titles resolve in package.nls.json"
else
  echo "FAIL: Command titles missing from package.nls.json (see above)"
  ERRORS=$((ERRORS + 1))
fi

# 9. Every keybinding references a declared command
if node -e "
  const pkg = require('./packages/extension/package.json');
  const declared = new Set((pkg.contributes.commands || []).map(c => c.command));
  const kb = pkg.contributes.keybindings || [];
  const dangling = kb.map(k => k.command).filter(c => !declared.has(c));
  if (dangling.length) {
    console.error('Keybindings reference undeclared commands: ' + dangling.join(', '));
    process.exit(1);
  }
  console.log(kb.length + ' keybindings checked');
"; then
  echo "PASS: All keybindings reference declared commands"
else
  echo "FAIL: Keybindings reference undeclared commands (see above)"
  ERRORS=$((ERRORS + 1))
fi

# 10. Clean install test
if [[ "$SKIP_BUILD_CHECKS" != "1" ]]; then
  echo "Running clean install validation..."
  pnpm install --frozen-lockfile && pnpm validate || { echo "FAIL: Clean install + validate failed"; ERRORS=$((ERRORS + 1)); }
else
  echo "SKIP: clean install validation (SKIP_BUILD_CHECKS=1)"
fi

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
