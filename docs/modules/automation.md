# Automation

Compose multi-step pipelines on a visual canvas, save them, run them, and read back what each step of a run did.

> **What a pipeline runs:** Backup, Compare, Pre-Check, Notification, Delay and
> Condition steps. A Backup step takes a DataOps snapshot into local storage, a
> Compare step runs the Compare page's metadata diff, a Pre-Check reads the
> Monitor's health signals, and a Notification shows a VS Code notification.
> **No pipeline step writes to an org:** Seed, Sync, Restore, Anonymize and
> Delete run only from their own pages, where Production Guard stops a write to
> a production org or asks you first, and a pipeline runs unattended. Script,
> Approval, Loop and Parallel cannot run yet. A pipeline that holds a step it
> cannot run is refused before its first step: nothing runs, and the run is
> written to the history as failed, with the reason.

## Quick Start

1. Navigate to **Automation** from the sidebar
2. Click **Create Pipeline** to start a new pipeline
3. Click a step in the Step Palette to add it to the Pipeline Canvas
4. Select each step and configure it in the Step Config Panel: the org and objects of a Backup, the two orgs and the metadata types of a Compare, the org and checks of a Pre-Check, the message of a Notification, the seconds of a Delay
5. Click **Run** once every step can run: the canvas shows each step as it starts and ends, and **Cancel** stops the run where it is. While a step cannot run, the Run button is disabled and a note under the header names the step and the reason

## Features

### Pipeline Canvas

The visual builder for composing automation workflows:

- **Canvas** -- Steps run in the order they are listed; a step that cannot run is marked where it sits, with the reason
- **Step Palette** -- A sidebar listing all 15 step types. Click to add a step to the canvas; a type that cannot run in a pipeline is shown disabled, with the reason.
- **Step Config Panel** -- Select a step on the canvas to configure it: its name, timeout (up to 24 days), retries, whether the run goes on after it fails, and the fields of its type
- **Pipeline Execution View** -- While a run lasts, the canvas shows each step's status as the extension reports it, what each finished step did, and a Cancel button that stops the run
- **AI Pipeline Generator** -- Describe what you want in natural language and let the AI draft the pipeline; its steps are marked when they cannot run

### Step Types

15 step types, grouped the way the Step Palette groups them:

- **Data** -- Seed, Sync, Backup, Restore, Anonymize, Delete
- **Quality** -- Compare, Pre-Check
- **Control Flow** -- Condition, Loop, Parallel, Delay, Approval, Script
- **Notification** -- Notification

Six of them run in a pipeline:

- **Backup** -- takes the snapshot the DataOps Backup button takes, of the objects you list, from the org you choose: the same per-org lock, the same row bound, the same retention. The records go to local storage, where the DataOps page lists the backup; nothing is written to the org. A snapshot that stopped at the row bound says it is partial.
- **Compare** -- runs the Compare page's metadata diff between the two orgs and the metadata types you choose, and keeps its counts: added, removed, modified, unchanged, not compared. Both orgs are only read.
- **Pre-Check** -- reads the Monitor's health signals you choose on an org: API usage, data storage, the Apex error logs of the last 24 hours, the failed Apex jobs. A reading the Monitor calls critical, or one it cannot read, fails the step and stops the run. It hands what it read on to the steps after it (`apiUsagePercent`, `storageUsagePercent`, `recentErrorCount`, `failedJobCount`), for a Condition to test.
- **Notification** -- shows its message as a VS Code notification, to whoever runs the pipeline. It sends nothing anywhere else: SandForge talks to no chat, mail or incident tool.
- **Delay** -- waits the seconds set in its config panel, from 0 up to 24 days. A run cut short stops its wait where it is.
- **Condition** -- tests its condition against the run's variables and the values the steps before it handed on. One that does not hold ends the run there, unless it names a step to go on from. This page cannot set a condition yet, so the palette offers Condition disabled; a Condition step from a Marketplace template carries its own, and runs.

The other nine are refused before a pipeline's first step, and the palette says why:

- **Seed, Sync, Restore, Anonymize, Delete** write to an org. Each runs from its own page, where Production Guard stops a write to a production org or asks you first; a pipeline runs unattended, with nobody there to answer.
- **Script, Approval, Loop, Parallel** have no handler yet: a Parallel step would run no branch, and an Approval would hold nothing back.

Every step is read before the run the way its module's own request is read: a Backup with no org or with an object that is not an API name, a Compare of an org with itself, a Pre-Check naming a check SandForge does not have, a Notification with no message, a timeout longer than 24 days. The page marks such a step, and the extension refuses it with the same reason.

### Triggers

> **Coming soon:** only **Manual** triggering is wired to an executor. SandForge has no pipeline scheduler, so pipelines always start by hand. The other trigger types below can be added, but nothing fires them; the panel marks each one coming soon.

The Trigger Config Panel offers these trigger types:

- **Manual** -- Run on demand from the UI
- **Schedule** _(coming soon)_ -- Takes a cron expression
- **Event** _(coming soon)_
- **Webhook** _(coming soon)_
- **Sandbox Refresh** _(coming soon)_ -- SandForge notices a sandbox refresh and warns you (see Monitor), but this trigger starts no pipeline: the work a refresh calls for, anonymizing and seeding, writes to an org, and no pipeline step does
- **Deployment Complete** _(coming soon)_

The Trigger Config Panel lets you add, remove, enable/disable triggers, and edit cron expressions.

### Scheduler

> **Coming soon:** no pipeline runs on a timer yet: a pipeline starts from its Run Pipeline button. The scheduler behind this tab runs saved Sync configurations only.

The tab lists the sync schedules, the ones the Sync page's Schedules tab keeps
(see [Sync](sync.md#schedules)), by the day each next runs:

- Today, tomorrow and each later day, with the time of each run. A run whose
  time has passed is listed as due until it has run: the extension runs it at
  its next check, once a minute while VS Code is open
- For each schedule, its cron expression and time zone, and how its last run
  went and when. A paused schedule is listed apart, with no run time
- Pause or resume, edit and delete, as on the Sync page, and **New schedule**
  to create one. A schedule runs a saved Sync configuration, so one has to be
  saved from the Sync page first
- The tab asks for the schedules again once the soonest run is past, so the
  next run and the last result follow the runs while it is open

### Execution History

Every run that completes, fails or is cancelled is written to extension
storage when it ends, and the tab, which asks for the history again each time a
run answers, lists them newest first. A pipeline refused before its first step
is written as failed, with one error per step that cannot run, and the page
says why under its header. A run cut off by the pipeline timeout is stopped
where it is -- a Delay stops waiting, a Backup stops between two objects and
saves nothing, and no later step starts -- and is written as failed, and the
page says it ran out of time. A run stopped by an error before it returns
leaves no entry. The tab shows for each run:

- Its status, trigger, start time and duration
- How many steps ran, and how many of them failed
- Each step, with its status, how long it took, and what it did or why it failed: the records a Backup took, the counts a Compare found, what a Pre-Check read

Storage also keeps the pipeline definition as it stood when the run started,
since saving a pipeline overwrites it under its own id. The tab does not show
that snapshot and does not send it to the page.

The log holds the 50 most recent runs; older entries are dropped as new ones
arrive. Entries are read-only: there is no re-run channel, so a past run can be
inspected but not replayed.

### Pipeline Marketplace

Browse and install pre-configured pipeline templates:

- Templates organized by category
- Author attribution and descriptions
- One-click install to add a template to your workspace

A template is a composition, not a capability: its steps are the same step types
listed above. Most built-in templates hold a step that writes to an org, or a
Pre-Check naming a check SandForge does not have, so they cannot run as
installed; each card names the step types that do not run in a pipeline, and
the tab says so above the list. An installed template's Backup, Compare and
Pre-Check steps ask for their orgs before the pipeline can run.

### Saved Pipelines

- Save a pipeline, and quick-load it back from the saved pipelines list
- The version badge on each entry always reads `v1`: the builder stamps
  `version: 1` and a save overwrites the pipeline under its own id. No earlier
  revision is kept, so there is nothing to compare or roll back to.

## Tips

- Start with a Backup and a Compare between two sandboxes to learn the canvas and the history
- Put a Pre-Check first to stop a run when an org's API usage or storage is critical
- Use the AI Pipeline Generator to sketch a workflow from a natural language description; its steps are marked when they cannot run
- Browse the Marketplace for templates that match your use case before building from scratch
- Read Execution History for each run's status and for what each of its steps did
- Remember that no pipeline writes to an org: seeding, syncing, restoring, anonymizing and deleting run from their own pages
