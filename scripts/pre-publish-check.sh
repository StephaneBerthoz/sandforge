#!/usr/bin/env bash
# SandForge Pre-Publish Checks
# Validates the extension is ready for Marketplace publication.
# Usage: bash scripts/pre-publish-check.sh
#
# Env flags:
#   SKIP_BUILD_CHECKS=1 — skip the heavy build steps (6: pnpm validate +
#   package, 10: clean install + validate). Used by .github/workflows/release.yml
#   and the package job in .github/workflows/ci.yml, which build and package
#   as their own steps before calling this script. The VSIX/bundle size checks
#   (7, 11) still run — they only need the artifacts those earlier steps
#   produced.
#
#   ALLOW_MISSING_WHATS_NEW=1 — accept a release with no What's New highlights
#   (check 5c). For a release that genuinely has nothing to announce to an
#   upgrader; it has to be said out loud, because the panel fails silently.
set -euo pipefail

SKIP_BUILD_CHECKS="${SKIP_BUILD_CHECKS:-0}"
ALLOW_MISSING_WHATS_NEW="${ALLOW_MISSING_WHATS_NEW:-0}"

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

# 5c. What's New freshness. The extension sends `whats-new:show` on every
# version change, and the panel looks the version up in WHATS_NEW: a release
# with no entry there shows nothing at all, and says nothing about it — the
# page dismisses itself. Between 1.0.0 and 1.22.0 that list gained no entry,
# so no upgrader saw a single highlight. Blocking, with
# ALLOW_MISSING_WHATS_NEW=1 for a release that really has nothing to announce.
WHATS_NEW_FILE="packages/webview/src/pages/Welcome/WhatsNewPage.tsx"
if [[ ! -f "$WHATS_NEW_FILE" ]]; then
  echo "FAIL: $WHATS_NEW_FILE not found — the What's New check ran against nothing"
  ERRORS=$((ERRORS + 1))
elif grep -qF "'$EXT_VER': [" "$WHATS_NEW_FILE"; then
  echo "PASS: What's New lists highlights for $EXT_VER"
elif [[ "$ALLOW_MISSING_WHATS_NEW" == "1" ]]; then
  echo "SKIP: What's New has no '$EXT_VER' entry (ALLOW_MISSING_WHATS_NEW=1)"
else
  echo "FAIL: WHATS_NEW has no '$EXT_VER' entry in $WHATS_NEW_FILE — upgraders would see no What's New panel"
  ERRORS=$((ERRORS + 1))
fi

# 6. Build and package
if [[ "$SKIP_BUILD_CHECKS" != "1" ]]; then
  echo "Building..."
  pnpm validate || { echo "FAIL: pnpm validate failed"; ERRORS=$((ERRORS + 1)); }

  echo "Packaging VSIX..."
  pnpm package || { echo "FAIL: pnpm package failed"; ERRORS=$((ERRORS + 1)); }
else
  echo "SKIP: build + package (SKIP_BUILD_CHECKS=1 — caller already ran them)"
fi

# 6b/6c. VSIX payload gates — the two files the extension loads lazily at
# runtime. A VSIX missing either passes every other check and then breaks on
# first use: no AI call, or no org connection at all.
#
# Placed immediately after packaging on purpose. Step 10 rebuilds dist/, so a
# payload check after it judges an artifact that no longer corresponds to the
# tree that produced it.
#
# NOT gated on SKIP_BUILD_CHECKS: these need only the packaged artifact. They
# used to be, which meant release.yml — which packages separately and then
# calls this script with SKIP_BUILD_CHECKS=1 — never ran either of them.
#
# grep -c, not grep -q: -q exits at the first match, SIGPIPEs unzip, and under
# `set -o pipefail` that makes the pipeline non-zero even when the entry was
# found. Counting consumes the whole listing, and reporting the count means a
# failure distinguishes "payload absent" from "listing unreadable".
if [[ -f "sandforge.vsix" ]]; then
  VSIX_LINES=$(unzip -l sandforge.vsix | wc -l)

  SDK_COUNT=$(unzip -l sandforge.vsix | grep -c 'extension/dist/node_modules/@anthropic-ai/sdk/' || true)
  if (( SDK_COUNT > 0 )); then
    echo "PASS: VSIX contains the vendored @anthropic-ai/sdk ($SDK_COUNT entries)"
  else
    echo "FAIL: VSIX has no @anthropic-ai/sdk entries (listing: $VSIX_LINES lines) — AI calls would break at runtime"
    ERRORS=$((ERRORS + 1))
  fi

  CHUNK_COUNT=$(unzip -l sandforge.vsix | grep -c 'extension/dist/jsforceEntry.js' || true)
  if (( CHUNK_COUNT > 0 )); then
    echo "PASS: VSIX contains the lazy jsforce chunk"
  else
    echo "FAIL: VSIX has no extension/dist/jsforceEntry.js (listing: $VSIX_LINES lines) — every org connection would break at runtime"
    ERRORS=$((ERRORS + 1))
  fi

  # 6d. The same reasoning as 6b/6c, for the third thing read lazily off disk.
  # The webview bundle carries English only; every other language is served
  # over the bridge from extension/webview-dist/locales/, which arrives there
  # by a copy step in the webview build and a second one into the extension. A
  # VSIX that lost either copy installs, activates and shows a UI — in English,
  # whatever the user picked, with an error where each translation should be.
  #
  # The list comes from the whitelist the extension reads by, so a language
  # added there is gated here without anyone remembering to come back.
  LOCALES=$(node -e "
    const src = require('fs').readFileSync('packages/extension/src/core/i18n/localeBundles.ts', 'utf8');
    const codes = /SUPPORTED_LOCALE_CODES = \[([^\]]+)\]/.exec(src);
    if (!codes) { console.error('SUPPORTED_LOCALE_CODES not found in localeBundles.ts'); process.exit(1); }
    console.log([...codes[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).join(' '));
  " || true)
  if [[ -z "$LOCALES" ]]; then
    echo "FAIL: could not read the supported locale codes — the locale payload gate checked nothing"
    ERRORS=$((ERRORS + 1))
  else
    MISSING_LOCALES=""
    for LNG in $LOCALES; do
      LOCALE_COUNT=$(unzip -l sandforge.vsix | grep -c -F "extension/webview-dist/locales/$LNG.json" || true)
      if (( LOCALE_COUNT == 0 )); then
        MISSING_LOCALES="$MISSING_LOCALES $LNG"
      fi
    done
    if [[ -n "$MISSING_LOCALES" ]]; then
      echo "FAIL: VSIX has no locale bundle for:$MISSING_LOCALES (listing: $VSIX_LINES lines) — those languages would fail to load at runtime"
      ERRORS=$((ERRORS + 1))
    else
      echo "PASS: VSIX contains a locale bundle for each of: $LOCALES"
    fi
  fi
else
  echo "SKIP: VSIX payload gates (sandforge.vsix not present)"
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

# 8. Every %key% placeholder in the extension manifest resolves in
#    package.nls.json — not just command titles: views, viewContainers,
#    walkthroughs, configuration descriptions, etc. Any string whose whole
#    value is a %key% placeholder must resolve.
if node -e "
  const pkg = require('./packages/extension/package.json');
  const nls = require('./packages/extension/package.nls.json');
  const isPlaceholder = (s) => /^%([^%]+)%$/.exec(s || '');
  const missing = new Set();
  let checked = 0;
  const walk = (v) => {
    if (typeof v === 'string') {
      const m = isPlaceholder(v);
      if (m) {
        checked++;
        if (!(m[1] in nls)) missing.add(m[1]);
      }
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(pkg);
  // Command titles must additionally BE placeholders (no hardcoded literals)
  const literalTitles = (pkg.contributes.commands || [])
    .map(c => c.title)
    .filter(t => !isPlaceholder(t));
  if (literalTitles.length) {
    console.error('Command titles not using %key% placeholders: ' + literalTitles.join(', '));
    process.exit(1);
  }
  if (missing.size) {
    console.error('Unresolvable %key% placeholders: ' + [...missing].join(', '));
    process.exit(1);
  }
  console.log(checked + ' manifest placeholders checked');
"; then
  echo "PASS: All manifest %key% placeholders resolve in package.nls.json"
else
  echo "FAIL: Manifest %key% placeholders missing from package.nls.json (see above)"
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

# 11. Activation-path bundle size.
#
# This measures one number: the bytes of the bundle VSCode loads to activate
# the extension. It is not an activation time and it has never been one —
# nothing here starts an extension host. What it catches is the regression that
# would lengthen activation: a heavy dependency finding its way back out of a
# lazy chunk and into the entry point.
if [[ -f "packages/extension/dist/extension.js" ]]; then
  BUNDLE_SIZE=$(node -p "require('fs').statSync('packages/extension/dist/extension.js').size")
  BUNDLE_KB=$(node -p "Math.round(${BUNDLE_SIZE} / 1024)")
  if (( BUNDLE_KB > 1100 )); then
    echo "FAIL: Extension bundle ${BUNDLE_KB}KB > 1100KB — jsforce (or another heavy dep) is being bundled into the activation path again"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS: Extension bundle ${BUNDLE_KB}KB (limit 1100KB)"
  fi
else
  echo "FAIL: packages/extension/dist/extension.js not found — run the build first"
  ERRORS=$((ERRORS + 1))
fi

# 11b. README badges match reality.
#
# The badges are a public claim nobody re-reads, so they decay: version sat at
# 1.12.0 through two releases, the VSIX size was 130 KB out, and a hardcoded
# `build-passing` asserted a green build while CI was red.
#
# NOT gated on SKIP_BUILD_CHECKS — release.yml calls this script with that flag
# set, and a gate it never runs is the same mistake the VSIX payload checks
# made. It needs only the packaged artifact, which exists by this point.
if node scripts/sync-readme-badges.mjs --check > /tmp/sf-badges.txt 2>&1; then
  echo "PASS: README badges match the repository state"
else
  echo "FAIL: README badges are stale — run 'pnpm sync:badges'"
  grep -E "measured:|STALE" /tmp/sf-badges.txt | sed 's/^/       /'
  ERRORS=$((ERRORS + 1))
fi
rm -f /tmp/sf-badges.txt

# 11c. Every README image reaches an anonymous reader.
#
# The Marketplace renders packages/extension/README.md on its own site and
# fetches the images over the public internet — it cannot see inside the VSIX
# and it has no GitHub session. All six screenshots pointed at
# raw.githubusercontent.com on a private repo, so the listing shipped with six
# broken images while every file sat present and correct on disk.
#
# NOT gated on SKIP_BUILD_CHECKS, for the same reason as 11b.
if node scripts/check-public-links.mjs > /tmp/sf-links.txt 2>&1; then
  echo "PASS: $(tail -1 /tmp/sf-links.txt)"
else
  echo "FAIL: public URLs are unreachable to a Marketplace visitor"
  grep -E "✗|→" /tmp/sf-links.txt | sed 's/^/       /'
  ERRORS=$((ERRORS + 1))
fi
rm -f /tmp/sf-links.txt

# 11e. The shipped screenshots were produced by the generator that exists.
#
# It hashes the generator spec and compares that fingerprint with the one the
# last screenshot run wrote to assets/screenshots/.generated-from, then checks
# that every image a README shows is on disk and not empty. It reads files
# only, so it needs no git history.
if node scripts/check-screenshots.mjs > /tmp/sf-shots.txt 2>&1; then
  echo "PASS: $(tail -1 /tmp/sf-shots.txt)"
else
  echo "FAIL: shipped screenshots are older than the generator that makes them"
  grep -E "✗" /tmp/sf-shots.txt | sed 's/^/       /'
  ERRORS=$((ERRORS + 1))
fi
rm -f /tmp/sf-shots.txt

# 11d. (retired in v1.18.0)
#
# This step compared the bytes of every screenshot against a copy published in
# a separate public repository, because this one was private and the
# Marketplace fetches images anonymously. Making the repository public removed
# the second copy, and with it the drift it existed to catch: the listing now
# reads its images out of the same commit as the file on disk. 11c above still
# proves every URL resolves to an anonymous visitor.

# 12. Client-confidentiality gate — no client name and no real org identifier
# may reach a public artifact. Both the GitHub repo and the VSIX (which ships
# changelog.md as the Marketplace "Changelog" tab) are public, so the whole
# tracked tree is scanned, the scanner included.
#
# The names live OUTSIDE the repository, in an untracked `.confidential-names`.
# They used to be hardcoded right here, so the gate meant to keep client
# identity out of a public repo was itself publishing it. The identifier rules,
# and why the pattern that preceded them could never pass, are in the script.
if node scripts/check-confidential.mjs > /tmp/sf-confidential.txt 2>&1; then
  grep "^WARN" /tmp/sf-confidential.txt || true
  echo "PASS: $(tail -1 /tmp/sf-confidential.txt)"
else
  echo "FAIL: client identity or real org identifiers in tracked files — scrub before publishing"
  grep -E "✗|^Confidentiality:" /tmp/sf-confidential.txt | head -20 | sed 's/^/       /'
  ERRORS=$((ERRORS + 1))
fi
rm -f /tmp/sf-confidential.txt

echo ""
if [[ $ERRORS -gt 0 ]]; then
  echo "=== $ERRORS CHECK(S) FAILED ==="
  exit 1
else
  echo "=== ALL CHECKS PASSED ==="
fi
