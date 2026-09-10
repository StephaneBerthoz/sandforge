# DataOps

Back up your org data and anonymize sensitive fields from a single tabbed page.

> **Status.** Backup, Restore and Anonymize are wired end to end. Compliance,
> Cleanup and Data Quality ship as previews: the tabs render, but are not yet
> connected to a backend. Each section below says which it is.

## Quick Start

1. Navigate to **DataOps** from the sidebar
2. The KPI row shows records processed, error rate, and anonymization template count
3. Use the tab bar to switch between Backup, Restore, Anonymize, Compliance, Cleanup, and Quality (Backup, Restore and Anonymize are wired today)
4. Start with a backup to establish a restore point before other operations

## Features

### Backup

Create full or incremental backups of your org data:

- Select objects to include in the backup
- Every backup is written to extension storage with per-object record counts, and listed newest-first in the Backup tab
- One-click backup creation from the Backup Panel

### Restore

> **Wired since v1.18.0.** The tab sends `dataops:rollback`, the backup list it
> reads is populated, and the CRUD/FLS gate that used to refuse every restore
> now answers field by field. Before 1.18.0 the button reached the backend and
> the backend said no, on every object, every time.

Restore data from a previously saved backup:

- Browse available backups with timestamps and record counts, newest first
- Select a specific backup and restore it to the current org
- Point-in-time recovery for precise rollback scenarios

What a restore does, in order:

- Refuses a backup taken from a different org than the one selected
- Passes through Production Guard like every other write path: a blocked
  operation stops, and `safety.requireProdConfirmation` asks first
- Upserts on `Id` in batches of 200, per object, reporting progress per object
- Drops the fields _nobody_ may write — a backup is a verbatim
  `SELECT FIELDS(ALL)` snapshot, so it always carries `CreatedDate`,
  `SystemModstamp` and friends — and logs which ones it dropped
- Stops with an FLS error if a field _you_ may not write is in the payload,
  rather than restoring the record with that column silently missing

### Anonymize

Mask sensitive data using the built-in anonymization templates:

- Browse anonymization templates from the template library
- Apply a template to replace PII with realistic but fake data
- **No preview.** The Preview button is disabled: the preview it used to run
  applied the mask to the org for real, so it was inerted rather than left in
  place. Apply is the only path, and it is irreversible -- back up first.
- **The library is read-only.** It exposes lookups only,
  and no channel creates, edits, imports or exports a template. The templates
  that ship with the extension are the whole set.

### Compliance (GDPR/CCPA)

> **Coming soon.** the tab renders the DSR form and PII list but is not connected to a backend — submitting a request sends nothing and no data is loaded. PII _detection_ is live and already runs in the Seed and Sync pre-flight checks.

The GDPR Panel provides compliance-focused data management:

- Data Subject Request (DSR) workflows for access, deletion, and portability
- PII detection and classification across your org schema
- Audit-ready reports for regulatory compliance
- Support for GDPR, CCPA, HIPAA, and PCI DSS frameworks

### Cleanup

> **Coming soon.** the tab renders against an empty recommendation list; no scan produces one yet.

Remove stale, orphaned, or duplicate records:

- AI-powered recommendations for records to clean up
- Review recommendations before executing
- Safe cleanup with pre-operation backup

### Data Quality

> **Coming soon.** the dashboard renders against an empty result list; no quality scan produces one yet.

A dashboard for monitoring data quality across your org:

- Rule-based validation: completeness, format, consistency, uniqueness, range, and pattern
- Quality score per object
- Actionable insights for improving data health

## Tips

- Always create a backup before running anonymization: the mask is applied in
  place and cannot be undone
- A backup can only be restored into the org it was taken from, so keep one
  backup per org rather than one per project
- Check the KPI row for a quick overview of your DataOps activity and error rates
