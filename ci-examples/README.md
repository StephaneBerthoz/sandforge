# SandForge CI/CD Examples

Ready-to-use CI/CD pipeline configurations for automating what SandForge **actually ships**: no fictional CLI commands.

## What exists (and what doesn't)

SandForge is a **VSCode extension**. Most operations (seed, sync, backup, health checks) run inside the extension UI and have **no headless CLI**. There is no `sandforge` binary and no `bin` entry in `package.json`.

The only headless entry points are two TypeScript CLI scripts, run with `tsx` from the **repository root** of a checkout of this repo:

| Script                                        | Purpose                                                                                                 | Required flags                                    | Useful options                                                                                                                                                                                                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/extension/cli/sandforge-clone.ts`   | Record-scoped clone (Forge) from a source org to a target sandbox                                       | `--record <id> --source <alias> --target <alias>` | `--dry-run`, `--json`, `--upsert`, `--max <n>`, `--depth direct\|full\|custom`, `--custom-depth <n>`, `--anonymize`, `--exclude <obj.field>`, `--owner-map <src=tgt>`, `--filter <obj=where>`, `--map <obj.src=tgt>`, `--remap-csv <file>`, `--skip-preflight`, `--expand-orphans` |
| `packages/extension/cli/sandforge-cleanup.ts` | Bulk-delete records the current user created on a target sandbox in the `--since` window, cloned or not | `--target <alias>`                                | `--dry-run`, `--since today\|yesterday\|last_week\|last_n_days:N`, `--objects a,b,c`, `--max <n>`                                                                                                                                                                                  |

Both scripts:

- are invoked as `pnpm exec tsx packages/extension/cli/sandforge-<name>.ts ...`
- delegate org authentication to the **Salesforce CLI** (`sf org display --target-org <alias>`), so `sf` must be installed and both orgs must be authenticated (in CI: `sf org login sfdxurl` with an `SFDX_AUTH_URL_*` secret)
- require `pnpm install` + `pnpm build:shared` to have run first (they import `@sandforge/shared` and extension sources)
- support `--dry-run`: the pipelines default the clone to it so nothing is written unless you opt in, and run the cleanup with it unconditionally

## Available Examples

| File                  | Platform       | Jobs                                                                                       |
| --------------------- | -------------- | ------------------------------------------------------------------------------------------ |
| `github-actions.yml`  | GitHub Actions | quality gates → clone/cleanup (gated) → VSIX package → Slack notify                        |
| `gitlab-ci.yml`       | GitLab CI      | quality → clone (rule-gated) → package → Slack notify on any failed job                    |
| `Jenkinsfile`         | Jenkins        | Quality gates → Clone → Cleanup → Package VSIX, artifact archiving, Slack notify           |
| `azure-pipelines.yml` | Azure DevOps   | Quality → Clone (condition-gated) → Package; no Slack step, use Azure DevOps notifications |

Every pipeline implements the same four stages:

1. **Quality gates**: `pnpm validate` — chains `pnpm build:shared` → `pnpm typecheck` → `pnpm lint` → `pnpm test` → `pnpm check:i18n` → `pnpm build`. If you split it into separate stages for per-step reporting, keep `pnpm build:shared` first: the other packages import `@sandforge/shared` from its `dist/`, so a typecheck that runs before it fails on a fresh checkout.
2. **Clone**: `sandforge-clone.ts --dry-run --json --remap-csv` against sf-authenticated orgs (skipped unless org secrets and a record Id are configured)
3. **Cleanup**: `sandforge-cleanup.ts --dry-run` on the target sandbox, always. The pipelines never delete: `--since today` selects every record the CI user created today on the target, whether this clone wrote it or not, so a real cleanup after a real clone would also remove anything else that user created. Read the counts the preview prints, then run the delete by hand, narrowed with `--objects`.
4. **VSIX package**: `pnpm package`, uploaded/archived as an artifact

## Setup

### 1. Configure credentials

The clone/cleanup stages authenticate via the Salesforce CLI. Store **sfdx auth URLs** (obtained via `sf org display --verbose --json` → `sfdxAuthUrl`) as secrets:

| Variable               | Description                                                                      |
| ---------------------- | -------------------------------------------------------------------------------- |
| `SFDX_AUTH_URL_SOURCE` | sfdx auth URL of the source org (secret)                                         |
| `SFDX_AUTH_URL_TARGET` | sfdx auth URL of the target sandbox (secret)                                     |
| `SANDFORGE_SF_ORGS`    | Set to `true` to enable the clone/cleanup stages                                 |
| `SF_CLONE_RECORD_ID`   | Salesforce record Id to clone (15/18-char, e.g. `500...`)                        |
| `SLACK_WEBHOOK_URL`    | (Optional) Slack webhook for failure alerts (GitHub Actions, GitLab CI, Jenkins) |

If `SANDFORGE_SF_ORGS` or `SF_CLONE_RECORD_ID` is not set, the pipelines still run quality gates and the VSIX package; the org-touching stages are skipped.

The login step writes each auth URL to a private temporary directory (`umask 077`, `mktemp -d`) and a `trap` removes it when that shell exits, a failed login included. Keep the whole sequence in one shell step if you edit it: a trap does not outlive the shell that set it, and self-hosted runners and Jenkins agents keep `/tmp` between runs.

### 2. Platform-specific instructions

#### GitHub Actions

1. Repository **Settings > Secrets and variables > Actions**: add the two `SFDX_AUTH_URL_*` secrets (+ optional `SLACK_WEBHOOK_URL`)
2. Same page, **Variables** tab: `SANDFORGE_SF_ORGS=true`, `SF_CLONE_RECORD_ID=<id>`
3. Copy `github-actions.yml` to `.github/workflows/sandforge.yml`

#### GitLab CI

1. **Settings > CI/CD > Variables**: add the variables, marking the auth URLs as "Masked"
2. Copy `gitlab-ci.yml` to `.gitlab-ci.yml` in your project root

#### Jenkins

1. **Manage Jenkins > Tools** (Global Tool Configuration on older releases): a NodeJS installation named `Node-22`
2. **Manage Jenkins > Credentials**: create Secret text credentials `sfdx-auth-url-source`, `sfdx-auth-url-target` (+ optional `slack-webhook`)
3. Set `SANDFORGE_SF_ORGS=true` in folder/job environment
4. Copy `Jenkinsfile` to your project root and point a Pipeline job at it
5. Pass `SF_CLONE_RECORD_ID` as a build parameter: Clone and Cleanup both run only when it is set, and the build logs the `ci-source` and `ci-target` aliases out when it ends

#### Azure DevOps

1. **Pipelines > Library > Variable Groups**: create `SandForge-Credentials` with all variables (auth URLs as secrets)
2. Copy `azure-pipelines.yml` to your project root and create a pipeline referencing it

### 3. Try the CLIs locally first

```bash
pnpm install
pnpm build:shared
pnpm exec tsx packages/extension/cli/sandforge-clone.ts --help
pnpm exec tsx packages/extension/cli/sandforge-cleanup.ts --help
```

## Customization

### Dry Run Mode

All pipelines default the clone to dry-run (no writes). The switch covers the clone only; the cleanup stays a preview either way:

- **GitHub Actions**: `workflow_dispatch` input `dry_run` (default `true`)
- **GitLab CI**: `DRY_RUN` variable (default `"true"`)
- **Jenkins**: `DRY_RUN` parameter (default checked)
- **Azure DevOps**: `dryRun` parameter (default `true`)

### Scheduling

Pipelines are scheduled every Monday at 6 AM UTC. Adjust the cron expression to your needs.

### Branch

The triggers name `main`: read it as your repository's default branch and rename it if yours is `master` or anything else.

### pnpm version

No pipeline pins a pnpm version. GitHub Actions' `pnpm/action-setup` and `corepack enable` on the other platforms both take it from the `packageManager` field of the root `package.json`, so the pipelines follow the repository when it moves to a new pnpm release.

### Building only the VSIX

The `package` stage is independent of org credentials: it always runs `pnpm package` (build shared → extension → webview → `vsce package`) and publishes `sandforge.vsix`.

## Security Best Practices

1. **Never commit credentials**: use platform-native secrets management
2. **Rotate sfdx auth URLs** regularly, especially after team changes
3. **Use sandbox-only credentials**: never connect to production orgs in CI/CD
4. **Keep dry-run on by default**: flip it off only for deliberate, reviewed runs
5. **Keep auth URLs off shared disks**: write them only inside the `umask 077` / `mktemp -d` / `trap` block the examples use, never to a fixed path under `/tmp`
6. **Enable audit logging** in your Salesforce orgs to track CI/CD operations
