#!/usr/bin/env bash
# SandForge Version Bump
# Usage: ./scripts/bump-version.sh <patch|minor|major|x.y.z>
set -euo pipefail

BUMP_TYPE="${1:?Usage: bump-version.sh <patch|minor|major|x.y.z>}"

# Read current version from root package.json
CURRENT=$(node -p "require('./package.json').version")
echo "Current version: $CURRENT"

# Calculate new version
if [[ "$BUMP_TYPE" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  NEW_VERSION="$BUMP_TYPE"
else
  NEW_VERSION=$(node -p "
    const [major, minor, patch] = '$CURRENT'.split('.').map(Number);
    '$BUMP_TYPE' === 'major' ? \`\${major+1}.0.0\` :
    '$BUMP_TYPE' === 'minor' ? \`\${major}.\${minor+1}.0\` :
    '$BUMP_TYPE' === 'patch' ? \`\${major}.\${minor}.\${patch+1}\` :
    (() => { throw new Error('Invalid bump type: $BUMP_TYPE') })()
  ")
fi

echo "Bumping to: $NEW_VERSION"

# Update all package.json files
for PKG in package.json packages/shared/package.json packages/extension/package.json packages/webview/package.json; do
  node -e "
    const fs = require('fs');
    const pkg = JSON.parse(fs.readFileSync('$PKG', 'utf8'));
    pkg.version = '$NEW_VERSION';
    fs.writeFileSync('$PKG', JSON.stringify(pkg, null, 2) + '\n');
  "
  echo "Updated $PKG -> $NEW_VERSION"
done

# Keep the root README version badge in sync (shields pattern: badge/version-X.Y.Z)
if [[ -f "README.md" ]]; then
  node -e "
    const fs = require('fs');
    const md = fs.readFileSync('README.md', 'utf8');
    const updated = md.replace(/badge\/version-\d+\.\d+\.\d+/, 'badge/version-$NEW_VERSION');
    if (updated === md) {
      console.log('WARN: no version badge found in README.md');
    } else {
      fs.writeFileSync('README.md', updated);
      console.log('Updated README.md version badge -> $NEW_VERSION');
    }
  "
fi

echo "Version bump complete: $CURRENT -> $NEW_VERSION"
