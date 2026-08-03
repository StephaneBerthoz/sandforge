# SandForge CI/CD Examples

Ready-to-use CI/CD pipeline configurations for automating what SandForge **actually ships**: no fictional CLI commands.

## What exists (and what doesn't)

SandForge is a **VSCode extension**. Most operations (seed, sync, backup, health checks) run inside the extension UI and have **no headless CLI**. There is no `sandforge` binary and no `bin` entry in `package.json`.

The only headless entry points are two TypeScript CLI scripts, run with `tsx` from the **repository root** of a checkout of this repo:

| Script | Purpose | Required flags | Useful options |
|--------|---------|----------------|----------------|
| `packages/extension/cli/sandforge-clone.ts` | Record-scoped clone (Forge) from a source org to a target sandbox | `--record <id> --source <alias> --target <alias>` | `--dry-run`, `--json`, `--upsert`, `--max <n>`, `--depth direct\|full\|custom`, `--custom-depth <n>`, `--anonymize`, `--exclude <obj.field>`, `--owner-map <src=tgt>`, `--filter <obj=where>`, `--map <obj.src=tgt>`, `--remap-csv <file>`, `--skip-preflight`, `--expand-orphans` |
| `packages/extension/cli/sandforge-cleanup.ts` | Bulk-delete records cloned by the current user on a target sandbox | `--target <alias>` | `--dry-run`, `--since today\|yesterday\|last_week\|last_n_days:N`, `--objects a,b,c`, `--max <n>` |

Both scripts:

- are invoked as `pnpm exec tsx packages/extension/cli/sandforge-<name>.ts ...`
- delegate org authentication to the **Salesforce CLI** (`sf org display --target-org <alias>`), so `sf` must be installed and both orgs must be authenticated (in CI: `sf org login sfdxurl` with an `SFDX_AUTH_URL_*` secret)
- require `pnpm install` + `pnpm build:shared` to have run first (they import `@sandforge/shared` and extension sources)
- support `--dry-run`: the pipelines default to it so nothing is written unless you opt in

## Available Examples

| File | Platform | Jobs |
|------|----------|------|
| `github-actions.yml` | GitHub Actions | quality gates → clone/cleanup (gated) → VSIX package → Slack notify |
| `gitlab-ci.yml` | GitLab CI | quality → clone (rule-gated) → package |
| `Jenkinsfile` | Jenkins | Quality gates → Clone → Cleanup → Package VSIX, artifact archiving |
| `azure-pipelines.yml` | Azure DevOps | Quality → Clone (condition-gated) → Package |

Every pipeline implements the same four stages:

1. **Quality gates**: `pnpm typecheck`, `pnpm test`, `pnpm build:extension` (minified esbuild bundle)
2. **Clone**: `sandforge-clone.ts --dry-run --json --remap-csv` against sf-authenticated orgs (skipped unless org secrets are configured)
3. **Cleanup**: `sandforge-cleanup.ts --dry-run` on the target sandbox
4. **VSIX package**: `pnpm package`, uploaded/archived as an artifact

## Setup

### 1. Configure credentials

The clone/cleanup stages authenticate via the Salesforce CLI. Store **sfdx auth URLs** (obtained via `sf org display --verbose --json` → `sfdxAuthUrl`) as secrets:

| Variable | Description |
|----------|-------------|
| `SFDX_AUTH_URL_SOURCE` | sfdx auth URL of the source org (secret) |
| `SFDX_AUTH_URL_TARGET` | sfdx auth URL of the target sandbox (secret) |
| `SANDFORGE_SF_ORGS` | Set to `true` to enable the clone/cleanup stages |
| `SF_CLONE_RECORD_ID` | Salesforce record Id to clone (15/18-char, e.g. `500...`) |
| `SLACK_WEBHOOK_URL` | (Optional) Slack webhook for failure alerts |

If `SANDFORGE_SF_ORGS` is not set, the pipelines still run quality gates and the VSIX package; the org-touching stages are skipped.

### 2. Platform-specific instructions

#### GitHub Actions
1. Repository **Settings > Secrets and variables > Actions**: add the two `SFDX_AUTH_URL_*` secrets (+ optional `SLACK_WEBHOOK_URL`)
2. Same page, **Variables** tab: `SANDFORGE_SF_ORGS=true`, `SF_CLONE_RECORD_ID=<id>`
3. Copy `github-actions.yml` to `.github/workflows/sandforge.yml`

#### GitLab CI
1. **Settings > CI/CD > Variables**: add the variables, marking the auth URLs as "Masked"
2. Copy `gitlab-ci.yml` to `.gitlab-ci.yml` in your project root

#### Jenkins
1. **Manage Jenkins > Credentials**: create Secret text credentials `sfdx-auth-url-source`, `sfdx-auth-url-target` (+ optional `slack-webhook`)
2. Set `SANDFORGE_SF_ORGS=true` in folder/job environment
3. Copy `Jenkinsfile` to your project root and point a Pipeline job at it
4. Pass `SF_CLONE_RECORD_ID` as a build parameter

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
All pipelines default to dry-run (no writes):

- **GitHub Actions**: `workflow_dispatch` input `dry_run` (default `true`)
- **GitLab CI**: `DRY_RUN` variable (default `"true"`)
- **Jenkins**: `DRY_RUN` parameter (default checked)
- **Azure DevOps**: `dryRun` parameter (default `true`)

### Scheduling
Pipelines are scheduled every Monday at 6 AM UTC. Adjust the cron expression to your needs.

### Building only the VSIX
The `package` stage is independent of org credentials: it always runs `pnpm package` (build shared → extension → webview → `vsce package`) and publishes `sandforge.vsix`.

## Security Best Practices

1. **Never commit credentials**: use platform-native secrets management
2. **Rotate sfdx auth URLs** regularly, especially after team changes
3. **Use sandbox-only credentials**: never connect to production orgs in CI/CD
4. **Keep dry-run on by default**: flip it off only for deliberate, reviewed runs
5. **Enable audit logging** in your Salesforce orgs to track CI/CD operations
