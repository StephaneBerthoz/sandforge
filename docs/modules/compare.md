# Compare

Compare metadata, permissions, and configuration between two Salesforce orgs. Identify differences and track drift from a single tabbed interface. Deploying those differences is not wired yet -- see [Deploy from Diff](#deploy-from-diff).

## Quick Start

1. Navigate to **Compare** from the sidebar (requires at least 2 connected orgs)
2. Select a source org and a target org using the org selector
3. Choose metadata component types to compare (fields, objects, flows, Apex classes, profiles, etc.)
4. Click **Run Compare** to execute the comparison
5. Browse results across five tabs: Diff, Permissions, Snapshots, Drift, and Deploy

## Features

### Metadata Diff

The primary tab shows a side-by-side comparison of metadata between the two orgs:

- **Summary Bar** -- Counts of added (+), removed (-), modified (~), and unchanged (=) components
- **Risk Score Card** -- An enriched risk assessment computed from the diff results
- **Diff Group Accordion** -- Components grouped by type, expandable to see individual changes
- **Diff Detail Modal** -- Click any diff entry to see the full before/after comparison

### Permission Matrix

A visual grid comparing CRUD and FLS permissions across profiles and permission sets:

- Source vs. target labels for clear side-by-side comparison
- Highlights differences between the two orgs
- Useful for security audits and permission troubleshooting

### Snapshots

A live capture of both orgs, taken with `describeGlobal` at the moment you open
the tab. Nothing is stored between runs, so there is no history to browse and no
earlier capture to compare against -- the tab compares the two orgs as they are
right now:

- Object counts per org: total, custom, standard, and queryable
- The objects that exist on only one side, listed per org, plus the shared count
- The capture timestamp, which is the time of the run that produced it

### Drift Detection

Automated detection of configuration drift between orgs:

- Dashboard showing drift metrics and categories
- Identifies when sandbox configuration has diverged from production
- Useful for compliance and governance workflows

### Deploy from Diff

> **Coming soon:** the Deploy tab renders an empty state as of v1.16.0 -- no deployment channel is wired to it, so nothing can be pushed to the target org from here yet. Cherry-picking changes out of a diff and deploying them without leaving SandForge is the planned design.

### Schema Advice

The Schema Advice button reads your source org's describe and runs it through a
set of rules -- no model, no key, nothing leaves the machine:

- Field-level issues with severity badges (high/medium/low)
- Actionable recommendations for schema improvements
- Object-specific analysis

Rules cover unused custom fields, naming conventions, labels duplicated across
objects and missing standard relationships. Each run returns a score out of 100.

## Tips

- Run a compare before any major deployment to understand the full scope of changes
- Use the Risk Score Card to quickly assess whether changes are safe to deploy
- The Permission Matrix is the fastest way to audit security differences between orgs
- Re-run the Drift tab after each release to catch configuration divergence early
- Once Deploy from Diff ships, prefer it over deploying everything at once
