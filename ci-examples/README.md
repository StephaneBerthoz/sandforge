# SandForge CI/CD Examples

This directory contains ready-to-use CI/CD pipeline configurations for automating SandForge operations across different platforms.

## Available Examples

| File | Platform | Description |
|------|----------|-------------|
| `github-actions.yml` | GitHub Actions | Full pipeline with artifact upload and Slack notifications |
| `gitlab-ci.yml` | GitLab CI | Multi-stage pipeline with caching and artifact retention |
| `Jenkinsfile` | Jenkins | Declarative pipeline with HTML report publishing |
| `azure-pipelines.yml` | Azure DevOps | Multi-stage pipeline with variable groups and artifact downloads |

## Pipeline Stages

Each pipeline implements the same five stages:

1. **Seed** — Populate sandbox with test data using SandForge seed templates
2. **Sync** — Synchronize data between source and target orgs
3. **Backup** — Create a backup of the target org data
4. **Health Check** — Run health diagnostics on the target org
5. **Report** — Generate an HTML report combining all stage results

## Setup

### 1. Install SandForge CLI

Ensure `sandforge` CLI is available in your CI environment. The pipelines install Node.js and pnpm, then use the project's local SandForge installation.

### 2. Configure Credentials

Each platform has its own secrets/credentials management. You need to configure the following variables:

| Variable | Description | Example |
|----------|-------------|---------|
| `SF_SOURCE_USERNAME` | Source org Salesforce username | `admin@dev.sandbox` |
| `SF_SOURCE_PASSWORD` | Source org password + security token | `MyP@ss123TOKEN` |
| `SF_SOURCE_LOGIN_URL` | Source org login URL | `https://test.salesforce.com` |
| `SF_TARGET_USERNAME` | Target org Salesforce username | `admin@qa.sandbox` |
| `SF_TARGET_PASSWORD` | Target org password + security token | `MyP@ss456TOKEN` |
| `SF_TARGET_LOGIN_URL` | Target org login URL | `https://test.salesforce.com` |
| `SLACK_WEBHOOK_URL` | (Optional) Slack webhook for failure alerts | `https://hooks.slack.com/...` |

### Platform-Specific Instructions

#### GitHub Actions
1. Go to your repository Settings > Secrets and variables > Actions
2. Add each variable as a Repository Secret
3. Copy `github-actions.yml` to `.github/workflows/sandforge.yml`

#### GitLab CI
1. Go to your project Settings > CI/CD > Variables
2. Add each variable, marking passwords as "Masked"
3. Copy `gitlab-ci.yml` to `.gitlab-ci.yml` in your project root

#### Jenkins
1. Go to Jenkins > Manage Jenkins > Credentials
2. Create Username/Password and Secret Text credentials
3. Copy `Jenkinsfile` to your project root
4. Configure a Pipeline job pointing to the Jenkinsfile

#### Azure DevOps
1. Go to Pipelines > Library > Variable Groups
2. Create a group named `SandForge-Credentials` with all variables
3. Copy `azure-pipelines.yml` to your project root
4. Create a new pipeline referencing the YAML file

### 3. Configure SandForge

Ensure your project has a `.sandforge.json` configuration file. See `.sandforge.example.json` in the project root for a complete template.

## Customization

### Dry Run Mode
All pipelines support a dry-run mode that simulates operations without writing data. This is useful for testing pipeline configurations.

- **GitHub Actions**: Use `workflow_dispatch` with `dry_run: true`
- **GitLab CI**: Set the `DRY_RUN` variable to any non-empty value
- **Jenkins**: Check the `DRY_RUN` parameter when triggering a build
- **Azure DevOps**: Set the `dryRun` parameter to `true`

### Scheduling
By default, pipelines are scheduled to run every Monday at 6 AM UTC. Adjust the cron expression in each file to match your team's needs.

### Notifications
All pipelines include Slack notification on failure. To use a different notification method:
1. Replace the `curl` command in the notification step
2. Options: email, Microsoft Teams webhook, PagerDuty, custom HTTP endpoint

### Adding Custom Stages
To add stages (e.g., data anonymization, comparison):

```yaml
# Example: Add a compare stage after sync
- name: Compare orgs after sync
  run: |
    sandforge compare \
      --config .sandforge.json \
      --mode metadata \
      --output-format json \
      --output compare-report.json
```

## Security Best Practices

1. **Never commit credentials** to your repository
2. **Use platform-native secrets management** (not environment files)
3. **Rotate credentials** regularly, especially after team changes
4. **Use sandbox-only credentials** — never connect to production orgs in CI/CD
5. **Enable audit logging** in your Salesforce orgs to track CI/CD operations
6. **Restrict pipeline permissions** to minimum required access
