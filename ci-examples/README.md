# SandForge CI/CD Examples

Ready-to-use CI/CD pipeline configurations for automating what SandForge **actually ships**: no fictional CLI commands.

## What exists (and what doesn't)

SandForge is a **VSCode extension**: there is no `sandforge` binary and no `bin` entry in `package.json`. What runs headless is nine TypeScript scripts in `packages/extension/cli/`, run with `tsx` from the **repository root** of a checkout of this repo; the other files there (`sfSession.ts`, `panelHost.ts`, `fileConfigStore.ts`) are what the scripts share. The pipelines run the clone; the cleanup deletes what a user created in a window of time; each of the other seven drives a module the way its page in the extension does:

| Script                                          | Purpose                                                                                                    | Required flags                                                                                   | Useful options                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/extension/cli/sandforge-clone.ts`     | Record-scoped clone (Forge) from a source org to a target sandbox, and removal of what a run of it created | `--record <id> --source <alias> --target <alias>`, or `--remove <summary.json> --target <alias>` | `--dry-run`, `--json`, `--list-objects`, `--upsert`, `--max <n>`, `--max-nodes <n>`, `--depth direct\|full\|custom`, `--custom-depth <n>`, `--anonymize`, `--exclude <obj.field>`, `--exclude-object <obj>`, `--owner-map <src=tgt>`, `--filter <obj=where>`, `--map <obj.src=tgt>`, `--remap-csv <file>`, `--files`, `--skip-preflight`, `--expand-orphans`, `--include-changed` (with `--remove`) |
| `packages/extension/cli/sandforge-cleanup.ts`   | Bulk-delete records the current user created on a target sandbox in the `--since` window, cloned or not    | `--target <alias>`                                                                               | `--dry-run`, `--since today\|yesterday\|last_week\|last_n_days:N`, `--objects a,b,c`, `--max <n>`                                                                                                                                                                                                                                                                                                   |
| `packages/extension/cli/sandforge-sync.ts`      | Sync the records of the objects named from one org to another                                              | `--source <alias> --target <alias> --object <ApiName>`                                           | `--operation insert\|upsert\|update`, `--where <obj=clause>`, `--dry-run`, `--json`                                                                                                                                                                                                                                                                                                                 |
| `packages/extension/cli/sandforge-seed.ts`      | Fill an org from a seed template, or with generated rows                                                   | `--target <alias>`, with `--template <id>` or `--object <ApiName>:<count>`                       | `--relation <Child>.<Lookup>=<Parent>`, `--dry-run`, `--json`                                                                                                                                                                                                                                                                                                                                       |
| `packages/extension/cli/sandforge-autopilot.ts` | Autopilot copy between two orgs, in the order their dependencies set                                       | `--source <alias> --target <alias> --object <ApiName>`                                           | `--compliance <name>`, `--plan-only`, `--json`                                                                                                                                                                                                                                                                                                                                                      |
| `packages/extension/cli/sandforge-backup.ts`    | Take, list and restore DataOps snapshots                                                                   | `--org <alias>`, with `--object <ApiName>`, `--list` or `--restore <id>`                         | `--store <dir>`, `--yes`, `--json`                                                                                                                                                                                                                                                                                                                                                                  |
| `packages/extension/cli/sandforge-frozen.ts`    | Build a Frozen Dataset and replay it into a sandbox: select, extract, load, verify, remove                 | `<step> --config <file>`                                                                         | `--source <alias>`, `--target <alias>`, `--reload`, `--include-changed`, `--yes`, `--json`                                                                                                                                                                                                                                                                                                          |
| `packages/extension/cli/sandforge-compare.ts`   | Compare two orgs as the Compare page does, or validate a deployment check-only                             | `--source <alias> --target <alias>`                                                              | `--op <name>`, `--type <Type>`, `--validate <Type:Name>`, `--json`                                                                                                                                                                                                                                                                                                                                  |
| `packages/extension/cli/sandforge-monitor.ts`   | Read an org as the Monitor page does                                                                       | `--org <alias>`                                                                                  | `--op <name>`, `--repeat <n>`, `--json`                                                                                                                                                                                                                                                                                                                                                             |

Every script:

- is invoked as `pnpm exec tsx packages/extension/cli/sandforge-<name>.ts ...`, and lists its flags with `--help`
- delegates org authentication to the **Salesforce CLI** (`sf org display --target-org <alias>`), so `sf` must be installed and the orgs must be authenticated (in CI: `sf org login sfdxurl` with an `SFDX_AUTH_URL_*` secret)
- requires `pnpm install` + `pnpm build:shared` to have run first (it imports `@sandforge/shared` and extension sources)

The clone, the cleanup, Sync and Seed take `--dry-run`: the pipelines default the clone to it, so nothing is written unless you opt in.

## Available Examples

| File                  | Platform       | Jobs                                                                                                       |
| --------------------- | -------------- | ---------------------------------------------------------------------------------------------------------- |
| `github-actions.yml`  | GitHub Actions | quality gates → clone and its removal (gated) → VSIX package → Slack notify                                |
| `gitlab-ci.yml`       | GitLab CI      | quality → clone and its removal (rule-gated) → package → Slack notify on any failed job                    |
| `Jenkinsfile`         | Jenkins        | Quality gates → Clone and its removal → Package VSIX, artifact archiving, Slack notify                     |
| `azure-pipelines.yml` | Azure DevOps   | Quality → Clone and its removal (condition-gated) → Package; no Slack step, use Azure DevOps notifications |

Every pipeline implements the same four stages:

1. **Quality gates**: `pnpm validate` — chains `pnpm build:shared` → `pnpm typecheck` → `pnpm lint` → `pnpm test` → `pnpm check:i18n` → `pnpm build`. If you split it into separate stages for per-step reporting, keep `pnpm build:shared` first: the other packages import `@sandforge/shared` from its `dist/`, so a typecheck that runs before it fails on a fresh checkout.
2. **Clone**: `sandforge-clone.ts --dry-run --json --remap-csv` against sf-authenticated orgs, its summary saved to `clone-summary.json` (skipped unless org secrets and a record Id are configured)
3. **Removal**: `sandforge-clone.ts --remove clone-summary.json` on the target sandbox, off unless you ask for it, and only after a real clone (see [Removal](#removal)). It takes back what that clone created and nothing else: never a record the target already held, and not one changed since the clone.
4. **VSIX package**: `pnpm package`, uploaded/archived as an artifact

The clone's report — `clone-summary.json`, `remap.csv`, and after a removal `clone-removal.json` and `clone-summary.removals.json` — is kept as an artifact whether the job passed or not.

## Setup

### 1. Configure credentials

The clone stage authenticates via the Salesforce CLI. Store **sfdx auth URLs** (obtained via `sf org display --verbose --json` → `sfdxAuthUrl`) as secrets:

| Variable               | Description                                                                      |
| ---------------------- | -------------------------------------------------------------------------------- |
| `SFDX_AUTH_URL_SOURCE` | sfdx auth URL of the source org (secret)                                         |
| `SFDX_AUTH_URL_TARGET` | sfdx auth URL of the target sandbox (secret)                                     |
| `SANDFORGE_SF_ORGS`    | Set to `true` to enable the clone stage                                          |
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

1. **Manage Jenkins > Tools** (Global Tool Configuration on older releases): a NodeJS installation named `Node-24`
2. **Manage Jenkins > Credentials**: create Secret text credentials `sfdx-auth-url-source`, `sfdx-auth-url-target` (+ optional `slack-webhook`)
3. Set `SANDFORGE_SF_ORGS=true` in folder/job environment
4. Copy `Jenkinsfile` to your project root and point a Pipeline job at it
5. Pass `SF_CLONE_RECORD_ID` as a build parameter: the Clone stage runs only when it is set, and the build logs the `ci-source` and `ci-target` aliases out when it ends

#### Azure DevOps

1. **Pipelines > Library > Variable Groups**: create `SandForge-Credentials` with all variables (auth URLs as secrets)
2. Copy `azure-pipelines.yml` to your project root and create a pipeline referencing it

### 3. Try the scripts locally first

```bash
pnpm install
pnpm build:shared
pnpm exec tsx packages/extension/cli/sandforge-clone.ts --help
pnpm exec tsx packages/extension/cli/sandforge-cleanup.ts --help
```

## Customization

### Dry Run Mode

All pipelines default the clone to dry-run (no writes):

- **GitHub Actions**: `workflow_dispatch` input `dry_run` (default `true`)
- **GitLab CI**: `DRY_RUN` variable (default `"true"`)
- **Jenkins**: `DRY_RUN` parameter (default checked)
- **Azure DevOps**: `dryRun` parameter (default `true`)

### Removal

A real clone stays in the sandbox unless you ask for its removal at the end of the job: for test data your own checks use and nothing after them should keep. Put those checks between the clone and the removal, where each pipeline says so:

- **GitHub Actions**: `workflow_dispatch` input `remove_after` (default `false`)
- **GitLab CI**: `REMOVE_AFTER` variable (default `"false"`)
- **Jenkins**: `REMOVE_AFTER` parameter (default unchecked)
- **Azure DevOps**: `removeAfter` parameter (default `false`)

The removal runs only after a real clone: a dry run created nothing, and `--remove` refuses its summary. It is the removal the wizard runs from **Recent runs**: it deletes the records the clone created, children first, and keeps a record the target already held, one changed since the clone (add `--include-changed` when your checks change them), and one that records staying in the org depend on. It exits `3` when it left records of the clone in the org, which fails the job; `clone-removal.json` says per object what became of them.

To take a run back later, by hand: download the clone report, put `clone-summary.json` (and `clone-summary.removals.json`, if a removal ran) at the root of a checkout, and run `pnpm exec tsx packages/extension/cli/sandforge-clone.ts --remove clone-summary.json --target <alias>` against the org the run wrote to. A removal keeps in `clone-summary.removals.json` what it wrote to the records it left, which the next removal of the same summary reads: keep the two files together.

`sandforge-cleanup.ts` remains for a run whose summary you did not keep, or one printed before the summary said which records the run created. It knows nothing of the clone, and `--since today` selects every record the user created today on the target, whether a clone wrote it or not: preview it with `--dry-run`, then narrow the delete with `--objects`.

### Automation on insert, and volume

A real clone writes nothing when the target runs a record-triggered flow or an Apex trigger as the records are inserted, or could not say what it runs: the job fails with exit code `1`, and the clone's output names each one. To clone all the same — after assigning the custom permission its output names to the CI user, say, or turning that automation off in the sandbox — ask for it:

- **GitHub Actions**: `workflow_dispatch` input `accept_automation` (default `false`)
- **GitLab CI**: `ACCEPT_AUTOMATION` variable (default `"false"`)
- **Jenkins**: `ACCEPT_AUTOMATION` parameter (default unchecked)
- **Azure DevOps**: `acceptAutomation` parameter (default `false`)

A dry run says what fires and goes on. Before its first write, a real clone also refuses a run of more than 10 000 records in all, and one whose records take more data storage than the target has left: nothing is written, and the job fails with exit code `1`. Add `--max-total <n>` to the clone call to set another ceiling.

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
