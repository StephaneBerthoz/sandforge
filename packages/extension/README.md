# SandForge — Forge your Salesforce Sandboxes

**The all-in-one Salesforce sandbox ETL toolkit for VSCode.** Seed test data with AI, sync orgs bidirectionally, compare metadata, monitor limits, manage bulk operations, and automate pipelines — all from a single WebView UI. No Command Palette required.

---

## Getting Started

1. **Install** — Search for **SandForge** in the Extensions tab (`Ctrl+Shift+X`) and click Install
2. **Connect** — Click the SandForge icon in the Activity Bar, then go to Organizations and import your Salesforce CLI-authenticated orgs
3. **Explore** — The Home Dashboard shows your connected orgs, quick actions, and recent operations
4. **Seed** — Navigate to Seed, select an object, set a record count, and generate test data in seconds

---

## Features

### Seed — AI-Powered Data Generation

AI-powered and template-driven data generation with full dependency resolution.

- **Guided Wizard** — 4-step flow: Select objects, configure fields, execute, view results
- **AI Generation** — LLM-backed realistic data with context-aware field values (OpenAI, Anthropic, Ollama)
- **NL2SOQL** — Describe what you need in plain English and get a validated SOQL query
- **Faker Profiles** — 30+ locale-aware generators for names, addresses, emails, and more
- **Forge Mode** — Graph-based discovery with source-to-target org cloning and PII anonymization
- **Dependency Resolution** — Automatic topological sort of parent-child relationships before insert

### Sync — Bidirectional Data Synchronization

Full-featured data sync with field mapping, transforms, and conflict resolution.

- **3 Sync Modes** — Full, Incremental, and Delta
- **Visual Field Mapper** — Drag-and-drop mapping with auto-match and 7 mapping types
- **13 Transforms** — String, date, number formatting, regex replace, and conditional logic
- **5 Conflict Strategies** — Source wins, target wins, newest wins, manual, or auto-merge
- **Field Type Validation** — Automatic source-to-target type compatibility check before upsert
- **Sankey Flow Diagram** — Visualize data flow before execution
- **Rollback** — Automatic savepoints with one-click rollback on partial failures

### Monitor — Real-Time Org Health

Live dashboard for tracking API limits, jobs, storage, and org health.

- **Health Score Gauge** — Composite metric aggregating limits, jobs, storage, and error rates
- **API Limits Tracking** — Live REST, Bulk, and Metadata API quota consumption with CSV export
- **API Usage Breakdown** — Per-category usage with progress bars and warning/critical badges
- **Storage Breakdown** — Per-object record count donut chart
- **Deployment Timeline** — Recent deployments with status indicators
- **Governor Limits** — Expandable list of all limits sorted by usage percentage
- **Trend Charts** — Historical trends with predictive analytics
- **Anomaly Detection** — AI-powered statistical outlier detection
- **Live Operations** — Real-time progress for running SandForge operations
- **Dashboard Refresh UX** — Panel-level loading, stale data indicator, error recovery, connection loss warning

### Compare — Metadata Diff and Permissions

Side-by-side comparison with six analysis tabs.

- **Metadata Diff** — Side-by-side comparison of fields, objects, flows, and Apex classes
- **Permission Matrix** — Visual CRUD and FLS grid across profiles and permission sets
- **Drift Detection** — Flag configuration drift between orgs
- **Impact Graph** — Interactive dependency visualization for change impact analysis
- **Deploy from Diff** — Cherry-pick and deploy individual metadata changes
- **Schema Advice** — AI-powered schema analysis with actionable recommendations

### DataOps — Backup, Compliance, and Quality

Full data lifecycle management with compliance built in.

- **Backup and Restore** — Full or incremental backups with point-in-time restore
- **Anonymization** — PII detection and masking with pre-built GDPR/CCPA/HIPAA templates
- **Compliance (GDPR)** — Data Subject Request workflows, audit reports
- **Data Quality** — Rule-based validation for completeness, format, and consistency
- **Cleanup** — AI-recommended removal of stale, orphaned, or duplicate records

### Automation — Visual Pipeline Builder

Build and run multi-step workflows visually.

- **Drag-and-Drop Canvas** — Compose pipelines from 15 step types
- **AI Pipeline Generator** — Describe your workflow in natural language
- **Triggers** — Manual, scheduled (cron), webhook, file watch, record change
- **Pipeline Marketplace** — Pre-configured templates organized by category
- **Execution History** — Searchable log with per-step timing and error details

### AI Assistant

Intelligent assistance across every module.

- **NL2SOQL** — Natural language to SOQL translation
- **AI Data Generation** — Context-aware realistic data generation
- **Schema Advice** — AI-powered schema analysis and recommendations
- **Pipeline Generator** — Build automation pipelines from natural language
- **Predictive Analytics** — Trend forecasting for API limits and storage

### Robustness

Production-grade reliability for real-world scale.

- **Bulk API 2.0** — Automatic switch for operations above 200 records
- **Retry with Backoff** — Exponential backoff with smart error classification (max 3 retries)
- **Configurable Timeouts** — Per-operation timeout with AbortController for long-running queries
- **Parallel Processing** — Grappe engine with 7 partitioning strategies for 10K+ records

### Production Guard

Safety first for production orgs.

- **3 Safety Tiers** — Configurable protection levels per org
- **Double Confirmation** — Required for any production operation
- **DELETE Blocking** — Production DELETE operations blocked by default
- **Audit Trail** — Immutable log of every operation

---

## Requirements

| Requirement | Version |
|---|---|
| Visual Studio Code | 1.95+ |
| Salesforce CLI (`sf`) | Latest |
| AI API Key (optional) | OpenAI, Anthropic, or Ollama |

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+M` | Open Monitor |
| `Ctrl+Shift+D` | Open Seed |
| `Ctrl+Shift+Y` | Open Sync |
| `Ctrl+Shift+K` | Open Compare |
| `Ctrl+Shift+O` | Open DataOps |
| `Ctrl+Shift+A` | Open Automation |
| `Ctrl+Shift+G` | Open Organizations |

---

## Configuration

| Setting | Description | Default |
|---|---|---|
| `sandforge.language` | UI language (`en`, `fr`, `de`, `es`, `ja`, `pt-BR`) | `auto` |
| `sandforge.ai.enabled` | Enable AI features | `true` |
| `sandforge.ai.provider` | AI provider (`openai`, `anthropic`, `ollama`) | `openai` |
| `sandforge.grappe.enabled` | Enable parallel processing for large datasets | `true` |
| `sandforge.grappe.threshold` | Record count to trigger Grappe mode | `10000` |
| `sandforge.safety.requireProdConfirmation` | Require confirmation for prod operations | `true` |
| `sandforge.safety.auditLogging` | Enable audit logging | `true` |

---

## Internationalization

SandForge supports 6 languages:

| Language | Code |
|---|---|
| English | `en` |
| French | `fr` |
| German | `de` |
| Spanish | `es` |
| Japanese | `ja` |
| Brazilian Portuguese | `pt-BR` |

---

## Author

Crafted with passion by **Stephane Berthoz**.

## License

[MIT](LICENSE)
