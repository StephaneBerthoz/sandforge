# Automation

Compose multi-step pipelines on a visual canvas, save them, run them, and read back what each step of a run did. A pipeline runs when you click Run; a saved one also runs on a schedule, or when SandForge notices a refresh of a sandbox, while VS Code is open.

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
6. To start the pipeline without a click, add a **Schedule** or a **Sandbox Refresh** trigger on the **Triggers** tab and save the pipeline: it then starts on its own while VS Code is open, and the tab shows the next run, or the sandbox it waits for

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
- **Compare** -- runs the Compare page's metadata diff between the two orgs and the metadata types you choose, and keeps its counts: only in the source, only in the target, modified, unchanged, not compared. Both orgs are only read.
- **Pre-Check** -- reads the Monitor's health signals you choose on an org: API usage, data storage, the Apex error logs of the last 24 hours, the failed Apex jobs. A reading the Monitor calls critical, or one it cannot read, fails the step and stops the run. It hands what it read on to the steps after it (`apiUsagePercent`, `storageUsagePercent`, `recentErrorCount`, `failedJobCount`), for a Condition to test.
- **Notification** -- shows its message as a VS Code notification, to whoever runs the pipeline. It sends nothing anywhere else: SandForge talks to no chat, mail or incident tool.
- **Delay** -- waits the seconds set in its config panel, from 0 up to 24 days. A run cut short stops its wait where it is.
- **Condition** -- tests its condition against the run's variables and the values the steps before it handed on. One that does not hold ends the run there, unless it names a step to go on from. This page cannot set a condition yet, so the palette offers Condition disabled; a Condition step from a Marketplace template carries its own, and runs.

The other nine are refused before a pipeline's first step, and the palette says why:

- **Seed, Sync, Restore, Anonymize, Delete** write to an org. Each runs from its own page, where Production Guard stops a write to a production org or asks you first; a pipeline runs unattended, with nobody there to answer.
- **Script, Approval, Loop, Parallel** have no handler yet: a Parallel step would run no branch, and an Approval would hold nothing back.

Every step is read before the run the way its module's own request is read: a Backup with no org or with an object that is not an API name, a Compare of an org with itself, a Pre-Check naming a check SandForge does not have, a Notification with no message, a timeout longer than 24 days. The page marks such a step, and the extension refuses it with the same reason.

### Triggers

> **Coming soon:** the **Event**, **Webhook** and **Deployment Complete** triggers start nothing. No event source feeds an event trigger, SandForge opens no port a webhook could reach, and it reads an org's deployments only when the Monitor asks for them. The panel marks each of them coming soon, and says why on its card.

The Trigger Config Panel offers these trigger types:

- **Manual** -- Run on demand from the Run Pipeline button
- **Schedule** -- Starts the pipeline at each time a five-field cron expression names (minute, hour, day of the month, month, day of the week), in the time zone chosen on the trigger, while VS Code is open
- **Event** _(coming soon)_ -- no event source feeds it
- **Webhook** _(coming soon)_ -- nothing outside VS Code can reach one
- **Sandbox Refresh** -- Starts the pipeline when SandForge notices that the sandbox the trigger names was refreshed (see [Monitor](monitor.md#sandbox-refreshes)), provided every step of the pipeline can run
- **Deployment Complete** _(coming soon)_ -- nothing watches an org's deployments

A trigger starts the pipeline as it was last saved: an edit on the Triggers tab takes effect when the pipeline is saved, and the tab says so until then. For each saved trigger the tab shows what it will do -- the next run of a schedule, in its time zone, the sandbox a refresh trigger waits for, and when it last fired -- or why it starts nothing: switched off, a cron expression it cannot read or that no date of the coming year matches (the 31st of February or April never comes), a sandbox SandForge no longer knows, a step of the pipeline that cannot run.

How a run a trigger starts goes:

- Only while VS Code is open. Every VS Code window runs SandForge, and the windows open on one machine share which of them makes each start, so a pipeline is started once however many windows are open. Each window reads the saved pipelines when it opens: a trigger changed and saved in one window takes effect in the others once they are reloaded. With VS Code closed, nothing runs.
- On time, or not at all. A schedule is looked at when it falls due, and at least once a minute. A start that falls due while VS Code is closed, or while the computer sleeps and the look comes more than two minutes late, is not made late: it is written to Execution History as missed, VS Code shows a warning, and the schedule goes on from its next time. A start missed while VS Code was closed is found at the next launch.
- One run of a pipeline at a time. A trigger that fires while a run of the same pipeline is going -- started by hand or by a trigger, in any window -- starts nothing, and History writes the start as missed, naming the run that was in the way. **Run Pipeline** is refused in the same way while a triggered run of that pipeline is going.
- Only a pipeline whose steps can all run. A trigger on a pipeline that holds a step that cannot run starts nothing, and the tab says so; a sandbox refresh that finds such a pipeline is written to History as missed, with the step and the reason.
- A run a trigger starts is written to Execution History with what started it. One that fails is also shown in a VS Code notification; one that completes says nothing more.

### Scheduler

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

Below them, it lists the pipeline schedules: the Schedule trigger of each saved
pipeline, with its cron expression, its time zone and its next run, or why it
starts nothing. A pipeline schedule is edited on the Triggers tab of its
pipeline. It runs only while VS Code is open, like a sync schedule, but it is
never made late: where a sync schedule runs a run it missed at its next check,
a pipeline schedule writes the start to Execution History as missed.

### Execution History

Every run that completes, fails or is cancelled is written to extension
storage when it ends, and the tab, which asks for the history again each time a
run answers, lists them newest first -- a run a trigger started included, which
the tab asks for when it ends. A pipeline refused before its first step
is written as failed, with one error per step that cannot run, and the page
says why under its header. A run cut off by the pipeline timeout is stopped
where it is -- a Delay stops waiting, a Backup stops between two objects and
saves nothing, and no later step starts -- and is written as failed, and the
page says it ran out of time. A run stopped by an error before it returns
leaves no entry. The tab shows for each run:

- Its status, trigger, start time and duration
- How many steps ran, and how many of them failed
- Each step, with its status, how long it took, and what it did or why it failed: the records a Backup took, the counts a Compare found, what a Pre-Check read

A start a trigger owed and did not make is written there too, as **Missed**:
when it fell due, how many fell due when there were several, and why -- VS Code
was closed, the computer slept, a run of the pipeline was still going, or a step
of the pipeline cannot run.

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
- Give a saved pipeline a Schedule trigger to take a backup every night while VS Code is open; a night VS Code is closed shows in the history as missed
- Put a Pre-Check first to stop a run when an org's API usage or storage is critical
- Use the AI Pipeline Generator to sketch a workflow from a natural language description; its steps are marked when they cannot run
- Browse the Marketplace for templates that match your use case before building from scratch
- Read Execution History for each run's status and for what each of its steps did
- Remember that no pipeline writes to an org: seeding, syncing, restoring, anonymizing and deleting run from their own pages
