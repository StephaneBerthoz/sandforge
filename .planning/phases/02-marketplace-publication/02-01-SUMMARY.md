# Plan 02-01 Summary

**Completed:** 2026-03-16
**Phase:** 2 -- Marketplace Publication

## What was built

Release infrastructure for the first public marketplace publication. All 4 package.json files were bumped from internal v3.2.0 to public v1.0.0. A version bump script synchronizes versions across the monorepo. CI was extended from Windows-only to a 3-OS matrix (ubuntu, macOS, Windows) with E2E tests restricted to Windows. A pre-publish check script validates version consistency, required extension fields, icon, README, CHANGELOG, VSIX size, bundle size, and command integrity before publishing.

## Key files

- `package.json`, `packages/*/package.json`: All at version 1.0.0
- `scripts/bump-version.sh`: Monorepo version synchronization (patch/minor/major/x.y.z)
- `scripts/pre-publish-check.sh`: 11-point pre-publish validation
- `.github/workflows/ci.yml`: 3-OS matrix with Windows-only E2E
- `.gitattributes`: Consistent LF line endings for source files
- `packages/extension/.vscodeignore`: Extended exclusions for docs, CI, dev configs
- `changelog.md`: Added [1.0.0] release section

## Decisions made

- Used `node` for file size checks in pre-publish script instead of `stat`/`bc` for Windows cross-platform compatibility
- Created `packages/webview/src/vite-env.d.ts` to fix pre-existing `import.meta.env.DEV` type error that blocked `pnpm validate`
- Extension categories changed to `["Other", "Data Science", "Formatters"]` per plan
- Kept `preview: true` in extension manifest (will be changed when ready for GA)

## Deviations from plan

- Added `vite-env.d.ts` in task 01 to fix a pre-existing typecheck error (`import.meta.env` not typed) -- this was not in the plan but was required for `pnpm validate` to pass
- Pre-publish script uses `node -p "require('fs').statSync(...).size"` instead of `stat -c%s`/`stat -f%z` and `bc` for cross-platform support on Windows

## Notes for downstream

- VSIX size is 1.08 MB (well under 5 MB limit)
- Extension bundle is 3.25 MB (over the 2048 KB warn threshold in pre-publish script -- this is expected for a full-featured extension with jsforce bundled)
- `pnpm validate` passes on Windows; CI will verify macOS and Linux
- The `preview: true` flag remains set -- Plan 03 (publish workflow) should decide when to flip it
- The `.gitattributes` file will normalize line endings on the next `git checkout` after commit
