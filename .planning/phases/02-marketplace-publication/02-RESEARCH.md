# Phase 2: Marketplace Publication - Research

**Completed:** 2026-03-16

## Don't Hand-Roll

### VS Code Extension Publishing
- Use `@vscode/vsce` (already in project as `npx @vscode/vsce package`) — the official CLI for packaging and publishing
- `vsce publish` handles Marketplace upload, version validation, and asset attachment
- Requires Azure DevOps PAT stored as `VSCE_PAT` in GitHub Actions secrets
- `vsce` validates `package.json` fields: `publisher`, `name`, `displayName`, `description`, `version`, `engines.vscode`

### Cross-Platform CI Matrix
- GitHub Actions `strategy.matrix.os` is the standard pattern for multi-OS testing
- Use `runs-on: ${{ matrix.os }}` with `[ubuntu-latest, macos-latest, windows-latest]`
- Playwright E2E should only run on one OS (Windows, to match dev) — use `if: matrix.os == 'windows-latest'`
- pnpm cache works cross-platform with `actions/setup-node@v4` cache option

### Version Synchronization
- `pnpm -r exec` can run commands across all packages in the monorepo
- `npm version` built-in handles package.json version bumping with git tag support
- For synchronized bumps: a shell script is simpler and more transparent than a custom Node tool

## Common Pitfalls

### Marketplace Publication
- **Missing `README.md` in extension package**: `vsce` looks for README in the extension package directory, not root. Either set `"readme"` in package.json or ensure README is accessible.
- **Large VSIX**: Assets (screenshots, docs) inside the extension bloat the VSIX. Keep screenshots in repo root `assets/` for README but NOT in the extension package. Use `.vscodeignore` to exclude dev files.
- **`preview: true` can't be removed via API**: Must be changed in package.json and re-published.
- **Categories mismatch**: Only use official VS Code Marketplace categories. "Formatters" is valid but not the best fit — "Other" + "Data Science" are appropriate.

### Screenshots
- **Playwright screenshots in headless mode**: CSS variables from VSCode host won't be present. The E2E Vite config already provides fallback CSS variables — screenshots will use those.
- **Resolution**: Marketplace recommends 1280x800 or similar 16:10 ratio. Use `page.setViewportSize()` before screenshots.
- **Dark theme**: Ensure the Vite E2E HTML template loads dark theme CSS variables.

### Cross-Platform CI
- **Path separators**: Tests using hardcoded `\` paths fail on Linux/Mac. The codebase uses TypeScript with path.join — should be fine.
- **Line endings**: `git config core.autocrlf` differences can cause test failures. Use `.gitattributes` with `* text=auto`.
- **Shell scripts**: `.sh` scripts need `chmod +x` on Windows runners (Git Bash handles this, but `run: bash script.sh` is safer than `run: ./script.sh`).

### Version Bumping
- **Lockfile drift**: Bumping version in package.json without updating pnpm-lock.yaml causes `--frozen-lockfile` failures in CI. Run `pnpm install --no-frozen-lockfile` after bump.
- **Monorepo version sync**: Root, shared, extension, and webview all have version fields. Miss one and the VSIX metadata is wrong.

### Activation Time
- **< 2s requirement (MKT-08)**: VS Code measures activation time from `activate()` call to resolution. Heavy imports at activation time slow this down. Use lazy imports for Salesforce-heavy modules.
- **Measuring**: `vscode.extensions.getExtension('publisher.name')?.activationTime` or use the "Developer: Show Running Extensions" command.

## Key Technical Details

### .vscodeignore
Current state unknown — must ensure it excludes: `src/`, `test/`, `e2e/`, `node_modules/`, `.github/`, `docs/`, `*.map`, `tsconfig*.json`, etc. Only `dist/`, `webview-dist/`, `resources/`, `package.json`, `package.nls.*.json`, `CHANGELOG.md`, `README.md`, `LICENSE` should be in the VSIX.

### Extension README for Marketplace
The Marketplace uses the extension package's README as the listing page. Currently `packages/extension/README.md` exists but content unknown — likely needs to be the main README or a marketplace-specific version with screenshots and feature highlights.

### GitHub Actions Release Workflow
Standard pattern:
```yaml
on:
  workflow_dispatch:
    inputs:
      version:
        type: choice
        options: [patch, minor, major]
```
Steps: bump version → commit → tag → validate → package → publish → create GitHub release.
