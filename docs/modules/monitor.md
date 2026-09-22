# Monitor

Track your Salesforce org health in real time. Monitor shows API limits consumption, active jobs, storage usage, alerts, trend analysis, and predictive analytics -- all in a single dashboard.

## Quick Start

1. Navigate to **Monitor** from the sidebar
2. Select a connected org from the org selector (or click an org card in the empty state)
3. The dashboard loads with KPIs, trends, jobs, and governor limits
4. Click the refresh button to pull the latest data, or enable auto-refresh for continuous monitoring.
   A refresh re-reads the KPIs, trends, jobs, limits, live operations and the
   org health check. The storage, API usage, deployments, error logs, sessions,
   Apex insights, sandbox refresh and governance panels read their data when
   the page opens and when another org is selected, not on a refresh

## Features

### KPI Overview

The top row shows four key metrics at a glance:

- **Health Score** -- A composite gauge aggregating limits, jobs, storage, and error rates. Displayed as a radial gauge with color coding (green/amber/red).
- **API Calls Today** -- Current REST API consumption with a progress bar and percentage. Includes a prediction warning when approaching the daily limit.
- **Data Storage** -- Storage used vs. allocated in GB with usage percentage.
- **Alerts** -- Active alert count with severity-based coloring.

### Org Info Panel

A compact panel below the KPIs showing:

- Org name, ID, edition, instance, and API version
- Release name and upcoming release info
- User count, custom object count, Apex class count, and Flow count
- Namespace prefix, creation date, pod name, and datacenter
- Hyperforce indicator badge

### Live Operations

When a Seed or Sync run is in progress, a Live Operations panel appears showing:

- Each run's progress bar, current step and records per second
- A Cancel control, which stops the run the same way the Seed page's Cancel
  does, scheduled syncs included. When the extension cannot find the run, a
  notification says so

Seed and Sync runs cannot be paused, so the panel offers no pause or resume.
The list is read when the dashboard opens, again on each dashboard refresh and
after a Cancel. Between readings it shows each run as it last was, not live.

Background operations do not survive a reload. The extension keeps the list in
memory only, so after a window reload or an extension host restart the panel
no longer shows a run that was in progress and cannot cancel it.

### Records by Object

Record counts per object, not megabytes, and not data storage:

- The 20 objects that hold the most records, largest first, read from the
  org's Record Count API, with how many objects hold records in all
- Every object the org counts is in the list, setup and log objects included
  (object and field permissions, login history, the setup audit trail), and
  these often lead it; the panel says so. What uses data storage is the Data
  Storage tile
- A donut chart of the ten largest and a table of all of them, each with its
  share of the records counted
- The same list feeds the anomaly scan's object dropdown

### Trends and Charts

- Trend charts for the key limits: daily API requests, data and file storage,
  daily Bulk API batches, Bulk API 2.0 query jobs and async Apex executions
- One snapshot of those limits every 15 minutes while the dashboard refreshes,
  kept for 7 days; the chart shows the last 24 hours or the whole week
- Direction, change and the predictions tile read the last 24 hours only, since
  most of those limits are daily counters that reset every day

### Jobs Table

- Active Apex jobs, Bulk API jobs, and scheduled tasks
- Status badges (running, completed, failed)
- Job type, object type, record counts, and timing
- A job created within the last day shows how long ago, in the interface
  language, with the exact date and time in a tooltip on that time; an older job
  shows its date and time
- The Created column header sorts the rows of every class group, newest or
  oldest first, and announces that order to screen readers
- While the dashboard is re-reading an org whose previous read found no jobs,
  the table shows placeholder rows rather than "No recent jobs", which would
  claim the org has none
- A stalled batch job links to the org's Setup › Apex Jobs page in Salesforce,
  where it can be aborted; SandForge does not abort jobs itself

### Governor Limits

An expandable section listing all Salesforce governor limits:

- Sorted by usage percentage (highest first)
- Color-coded progress bars (green/amber/red)
- Critical limit badges highlighted at the top
- Anomaly scan button: statistical outliers, future dates, negative amounts,
  bursts where most of a date field's values fall less than a minute apart (a
  sign of bulk or automated creation), near-empty fields and duplicate names or
  emails over a sample of up to 500 records of one object. The dropdown next to
  the button chooses that object -- it starts on Account, then lists up to 20
  of the org's objects that hold records, largest first. Its last choice,
  **Other object…**, opens a field for any other object's API name, such as
  `Invoice__c`: the scan button stays disabled until the name starts with a
  letter and holds only letters, digits and underscores, 80 characters at most,
  and says why under the button when it does not. Selecting another org puts
  it back on Account, clears the name typed and drops the previous report. A
  scan that finds nothing, or that fails, says so under the button. Rules only
  -- no model, no key, and it works with AI off

### API Usage Breakdown

Sixteen API-related limits from the org's `/limits` endpoint, as far as the org
returns them: REST and Bulk API requests, Bulk API 2.0 query jobs and their
file storage, streaming events, async Apex executions, async report runs,
time-based workflow, SOQL queries, workflow, mass and single emails, published
platform events and standard-volume platform messages. Each row shows used
against maximum and the percentage used, most used first, with a warning badge
from 80% and a critical one from 95%. A `/limits` answer the dashboard read
less than 30 seconds earlier is reused.

### Recent Deployments

The 20 most recent deployments to the org, newest first, read from
`DeployRequest` through the Tooling API: who started each one, how many
components it carried, its status with the number of component errors, and
when it started.

### Error Logs

Apex debug logs whose status is not `Success`, read from the org's `ApexLog`
records: up to 50, newest first, starting 24 hours back. A later reading in
the same session starts from the oldest log the previous one returned. Each
row shows when the log started, its status, the operation that wrote it and
the user; the header counts the rows, and the first three statuses are
counted above the table. Only debug logs the org holds are listed.

### Active Sessions

The 100 most recent login sessions, read from the org's `AuthSession` records:
username, session type, login time and source IP, with the number of distinct
users in the header. One user holding several sessions gets one row per
session; a session whose row carries no username falls back to the user's
record ID.

### Apex Insights

The 20 most recent Apex debug logs of any status, read from `ApexLog`. Log
bodies are not downloaded, so the figures are estimates from each log's size
and duration: one SOQL query per 500 bytes (at most 100), one DML statement per
1,000 bytes (at most 150) and ten bytes of heap per byte of log (at most
6,000,000). A log is flagged critical when an estimate reaches its limit, as a
warning at 80% of the SOQL, 60% of the DML or 70% of the heap limit, and as a
warning when it ran longer than 5 seconds. The most frequent flags lead the
panel.

### Sandbox Refreshes

The 20 most recent `SandboxProcess` records, one per sandbox creation or
refresh: sandbox name, status, the date the process was created and its
description. A "Refresh in progress" badge shows while one is pending or
processing. `SandboxProcess` exists only on an org that manages sandboxes, such
as production: on an org that cannot query it, such as a sandbox, the panel says
the org keeps no refresh history to read, and the org is not asked again in the
same session.

A sandbox cannot list its own refreshes, but a refreshed sandbox is a new org:
it answers with another org id under the same username. SandForge reads the org
id each registered sandbox answers with — on every new connection, and from the
`Organization` row when this panel opens or the dashboard refreshes — and keeps
the last one. When it changes, the panel lists the refresh under "Refreshes
SandForge noticed", VS Code shows a warning, and SandForge drops what it held
about the old org: the pooled connection, object describes, Forge discovery
graphs, and the Monitor's org info, limits and trend history. A Frozen Dataset
verification refuses to run against a target refreshed since its last load. A
refresh a production org's history shows completing is recorded the same way on
the registered sandbox it names.

### Org Health Check

Computed by the extension on each dashboard refresh and sent with the rest of
the dashboard; it is a separate figure from the Health Score gauge. Four
signals, each scored out of 100:

- API limits: daily API requests used, from `/limits` -- a warning above 60%,
  critical above 80%
- Storage: data storage used, from `/limits` -- a warning above 70%, critical
  above 85%
- Jobs: failed jobs among the recent `AsyncApexJob` rows the refresh reads, ten
  points each -- a warning from one, critical above five
- Recent errors: the `ApexLog` rows of the last 24 hours whose status is not
  Success, counted by the refresh itself, five points each -- a warning above
  three, critical above ten

The badge is the average of the four scores: healthy from 80, degraded from
50, critical below. A signal whose data cannot be read counts as a full 100.
Failed Jobs shows the number of failed jobs that refresh read, and Recent Error
Logs the number of error logs; each shows 0 when its rows cannot be read.

### Alerts Panel

- Configurable alert thresholds by severity
- Active alerts with timestamps
- Integration with the notification system

### Governance

Policies of threshold rules, checked against the selected org when asked:

- **Add Policy** saves the built-in policies not saved yet: Security (MFA,
  password policy strength), Performance (API usage, storage usage) and
  Compliance (Apex code coverage). Policies are kept in the extension's global
  state on this machine, for every org, and each can be deleted from its row
- **Evaluate** checks the enabled rules of the policy selected in the list
  against a fresh read of the org's `/limits` endpoint. Each limit's percentage
  used goes by its limit name, such as `DailyApiRequests`, and the two metrics
  the built-in Performance rules name, `apiUsagePercent` and
  `storageUsagePercent`, are read from `DailyApiRequests` and `DataStorageMB`.
  It shows a compliance score (100 per passing rule, 50 per warning, 0 per
  failure, averaged), the rule results with failures first, and a remediation
  checklist for the rules that did not pass
- A rule whose metric the org gave no reading for is marked **not measured**: it
  is left out of the compliance score and of the remediation checklist instead
  of being counted as a failure. `/limits` carries nothing about multi-factor
  authentication, password policy strength or Apex code coverage, so the
  built-in Security and Compliance rules read as not measured, and a policy
  where no rule was measured shows no score
- Selecting another org drops the evaluation on screen

## Tips

- Enable auto-refresh (clock icon) during long-running operations to keep the dashboard current
- Expand Governor Limits when troubleshooting API limit errors
- Use the Anomaly Scan to catch unusual patterns in your org data -- one object
  per run, so pick the object in the dropdown, or choose Other object… and type
  its API name, before scanning
- Critical job insights appear as red banners at the top of the dashboard -- act on those first
- API limit predictions show hours remaining before the daily limit is reached
