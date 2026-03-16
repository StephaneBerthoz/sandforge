# DataOps

Manage the full lifecycle of your sandbox data: backup and restore, anonymize sensitive fields, enforce GDPR/CCPA compliance, clean up stale records, and monitor data quality -- all from a single tabbed page.

## Quick Start

1. Navigate to **DataOps** from the sidebar
2. The KPI row shows records processed, error rate, and anonymization template count
3. Use the tab bar to switch between Backup, Restore, Anonymize, Compliance, Cleanup, and Quality
4. Start with a backup to establish a restore point before other operations

## Features

### Backup

Create full or incremental backups of your org data:

- Select objects to include in the backup
- Track backup history with record counts and status per object
- One-click backup creation from the Backup Panel

### Restore

Restore data from a previously saved backup:

- Browse available backups with timestamps and record counts
- Select a specific backup and restore it to the current org
- Point-in-time recovery for precise rollback scenarios

### Anonymize

Mask sensitive data using pre-built or custom anonymization templates:

- Browse anonymization templates from the template library
- Preview anonymization effects before applying
- Apply templates to replace PII with realistic but fake data
- Masking Template Panel for creating and managing custom templates

### Compliance (GDPR/CCPA)

The GDPR Panel provides compliance-focused data management:

- Data Subject Request (DSR) workflows for access, deletion, and portability
- PII detection and classification across your org schema
- Audit-ready reports for regulatory compliance
- Support for GDPR, CCPA, HIPAA, and PCI DSS frameworks

### Cleanup

Remove stale, orphaned, or duplicate records:

- AI-powered recommendations for records to clean up
- Review recommendations before executing
- Safe cleanup with pre-operation backup

### Data Quality

A dashboard for monitoring data quality across your org:

- Rule-based validation: completeness, format, consistency, uniqueness, range, and pattern
- Quality score per object
- Actionable insights for improving data health

## Tips

- Always create a backup before running anonymization or cleanup operations
- Use the Compliance tab to prepare for audits -- it generates reports aligned with regulatory frameworks
- Anonymization templates can be shared across teams by exporting and importing them
- The Quality dashboard is useful for identifying data issues before syncing between orgs
- Check the KPI row for a quick overview of your DataOps activity and error rates
