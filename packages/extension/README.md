# SandForge: Forge your Salesforce Sandboxes

**The all-in-one Salesforce sandbox ETL toolkit for VSCode.** Seed test data with AI, sync orgs bidirectionally, compare metadata, monitor limits, manage bulk operations, and automate pipelines, all from a single WebView UI. No Command Palette required.

---

## Getting Started

1. **Install**: Search for **SandForge** in the Extensions tab (`Ctrl+Shift+X`) and click Install
2. **Connect**: Click the SandForge icon in the Activity Bar, then go to Organizations and import your Salesforce CLI-authenticated orgs
3. **Explore**: The Home Dashboard shows your connected orgs, quick actions, and smart recommendations
4. **Seed**: Navigate to Seed, pick a mode (AI, CSV, or Clone), and populate your sandbox in seconds

---

## Features

### Seed: AI Generation, CSV Import & Org Cloning

Three ways to populate your sandbox, from zero-config to fully customized.

- **3 Seed Modes**: AI Generate, CSV Upload, or Clone from Org via card-based mode selector
- **AI Personas**: 10 industry-specific personas (Insurance FR, Hospital US, Startup, etc.) with locale badges and 5-record preview
- **CSV Import**: Drag-and-drop upload with auto column mapping, inline validation, and 4-step wizard
- **Clone from Org**: Clone records between orgs with relationship-ordered insert, SOQL filters, and ID mapping CSV export
- **Smart Actions**: Home Dashboard analyzes your orgs and recommends the best action with a one-click "Just Do It" CTA
- **Quick Seed**: 1-click seed from template gallery: Sales Cloud, Service Cloud, or Minimal Demo
- **Adaptive Wizard**: Auto-advance for small selections, grouped accordion for large ones
- **AI Generation**: LLM-backed realistic data (OpenAI, Anthropic, Ollama) with customizable field patterns
- **Locale-Aware**: Realistic data in 6 locales (en, fr, de, es, ja, pt-BR) with geo-coherent addresses
- **VR-Aware**: Auto-adjusts field rules to satisfy your org's validation rules
- **Dependency Resolution**: Automatic topological sort of parent-child relationships before insert

### Sync: Bidirectional Data Synchronization

Data sync with real-time CDC, conflict resolution, and scheduling.

- **Quick Sync**: 3-click flow: pick orgs, select objects, go (auto-field mapping, smart defaults)
- **CDC Real-Time Sync**: Change Data Capture subscriptions with live event feed, metrics dashboard, and auto-sync toggle
- **Conflict Resolution**: Side-by-side 2-way/3-way diff viewer with per-field resolution and bulk actions
- **Sync History**: Full execution history (500 entries FIFO) with detail view and one-click re-run
- **Cron Scheduling**: Visual builder + raw expression with timezone support, sleep/wake resilient
- **Smart Object Suggestions**: Top 5 most-used objects with one-click add
- **Relationship Auto-Detection**: Adding "Opportunity" auto-suggests "Account" as parent dependency
- **Pre-Built Templates**: Full Account Hierarchy, Opportunities + Products, Cases + Attachments
- **4 Sync Modes**: Upsert, Insert, Update, Delete with per-object configuration
- **7 Mapping Types**: Direct, Lookup, Formula, Constant, Concatenation, Conditional, External ID
- **13 Transforms**: String, date, number formatting, regex replace, and conditional logic
- **5 Conflict Strategies**: Source wins, target wins, newest wins, manual, or auto-merge
- **Rollback**: Automatic savepoints with one-click rollback on partial failures
- **Config Persistence**: Save, load, and reuse sync configurations across sessions

### Monitor: Real-Time Org Health

Live dashboard for tracking API limits, jobs, storage, and org health.

- **Health Score Gauge**: Composite metric aggregating limits, jobs, storage, and error rates
- **Alert System**: Configurable thresholds with severity levels, VSCode notifications, and history timeline
- **API Limits Tracking**: Live REST, Bulk, and Metadata API quota consumption with CSV export
- **Storage Breakdown**: Per-object record count donut chart
- **Deployment Timeline**: Recent deployments with status indicators
- **Trend Charts**: Historical trends with predictive analytics
- **Anomaly Detection**: Statistical outlier detection with IQR and temporal patterns
- **Governance**: Custom rule definitions with evaluation engine and alert pipeline
- **Dashboard Refresh UX**: Panel-level loading, stale data indicator, error recovery

### Compare: Metadata Diff and Permissions

Side-by-side comparison with six analysis tabs.

- **Metadata Diff**: Side-by-side comparison of fields, objects, flows, and Apex classes
- **Permission Matrix**: Visual CRUD and FLS grid across profiles and permission sets
- **Drift Detection**: Flag configuration drift between orgs
- **Impact Graph**: Interactive dependency visualization for change impact analysis
- **Deploy from Diff**: Cherry-pick and deploy individual metadata changes

### DataOps: Backup, Compliance, and Quality

Full data lifecycle management with compliance built in.

- **Backup and Restore**: Full or incremental backups with point-in-time restore and retention policies
- **Anonymization**: PII detection and masking with pre-built GDPR/CCPA/HIPAA/PCI DSS templates
- **Data Quality**: 7 rule types: completeness, format, consistency, uniqueness, range, pattern, custom
- **Production Guard**: 3 safety tiers with double confirmation, DELETE blocking, and audit trail
- **Encryption at Rest**: AES-256-GCM with PBKDF2 key derivation

### Automation: Visual Pipeline Builder

Build and run multi-step workflows visually.

- **Drag-and-Drop Canvas**: Compose pipelines from 15 step types
- **Pipeline Marketplace**: 15 pre-configured templates across 5 categories
- **Scheduling**: Cron expressions with timezone support and calendar-based exclusions
- **Execution History**: Searchable log with per-step timing and error details
- **Dry Run Mode**: Simulated execution with impact preview before running for real

### Streaming & Background Execution

Chunked streaming and background execution for large-scale operations.

- **Streaming Pipeline**: Async generator-based chunk processing for datasets > 10,000 records
- **Chunked Bulk API 2.0**: Multi-upload to a single Bulk API job (2000 records/chunk)
- **Background Operations**: Long-running operations detach from UI, run in background with full lifecycle tracking
- **Abort Support**: Cancel any running background operation
- **Native Notifications**: VSCode desktop notifications when background operations complete while panel is hidden

### AI Assistant

- **NL2SOQL**: Natural language to SOQL translation (English + French)
- **Error Resolver**: Contextual Salesforce error analysis with auto-fix
- **Predictive Analytics**: Trend forecasting for API limits and storage
- **10 Industry Personas**: Pre-configured data profiles with locale-aware field patterns

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
| `Ctrl+1..6` | Navigate to module |
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

**Stephane Berthoz**

## License

[MIT](LICENSE)
