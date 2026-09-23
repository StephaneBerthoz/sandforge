# Automation

Compose multi-step data pipelines on a visual drag-and-drop canvas, save them, run them, and read back what each run did.

> **Coming soon: only Delay steps run.** A pipeline that holds any other step
> type -- Seed, Sync, Backup, Restore, Anonymize, Delete, Condition and the rest
> -- is refused before its first step: nothing runs, and the run is written to
> the history as failed, with the reason. No step moves a record. The palette
> shows the other step types disabled, and a pipeline that holds one, from the
> Marketplace, the AI generator or an earlier save, is marked on the canvas and
> cannot be run. Until step handlers ship, Automation is a design surface: use
> it to compose and store pipelines, not to run work. Each section below says
> which part is real.

## Quick Start

1. Navigate to **Automation** from the sidebar
2. Click **Create Pipeline** to start a new pipeline
3. Drag steps from the Step Palette onto the Pipeline Canvas
4. Configure each step
5. Click **Run** once every step can run -- for now, Delay steps with their seconds set: the canvas shows the execution view while the run lasts, and the run is written to the history. While a step cannot run, the Run button is disabled and a note under the header names the step and the reason

## Features

### Pipeline Canvas

The visual builder for composing automation workflows:

- **Drag-and-drop canvas** -- Arrange steps visually with connections between them
- **Step Palette** -- A sidebar listing all 15 step types. Click to add a step to the canvas; a type that cannot run yet is shown disabled, with the reason.
- **Step Config Panel** -- Select a step on the canvas to configure its parameters (object, query, batch size, etc.)
- **Pipeline Execution View** -- When running, the canvas switches to show real-time execution status per step
- **AI Pipeline Generator** -- Describe what you want in natural language and let the AI build the pipeline for you

### Step Types

15 step types, grouped the way the Step Palette groups them:

- **Data** -- Seed, Sync, Backup, Restore, Anonymize, Delete
- **Quality** -- Compare, Pre-Check
- **Control Flow** -- Condition, Loop, Parallel, Delay, Approval, Script
- **Notification** -- Notification

One of them runs from this page today: **Delay**, which waits the seconds set in
its config panel, from 0 up to 24 days. A Delay step with no seconds set cannot
run, and a run cut short stops its wait where it is.

The extension also evaluates a **Condition** step that carries a condition,
against the run's variables. Nothing on the page sets a step's condition,
though, and a run started here carries no variables, so the palette offers
Condition disabled with the others.

The other thirteen have no handler. They can still be drawn and configured, but
a pipeline that holds one is refused before its first step and recorded as
failed -- including **Parallel**, which would run no branch, **Approval**, which
would hold nothing back, and **Notification**, which would send no message: the
extension talks to no chat, mail or incident tool.

### Triggers

> **Coming soon:** only **Manual** triggering is wired to an executor. SandForge has no pipeline scheduler, so pipelines always start by hand. The other trigger types below can be added, but nothing fires them; the panel marks each one coming soon.

The Trigger Config Panel offers these trigger types:

- **Manual** -- Run on demand from the UI
- **Schedule** _(coming soon)_ -- Takes a cron expression
- **Event** _(coming soon)_
- **Webhook** _(coming soon)_
- **Sandbox Refresh** _(coming soon)_ -- SandForge notices a sandbox refresh and warns you (see Monitor), but this trigger starts no pipeline: a pipeline runs only Delay and Condition steps, and the work a refresh calls for is made of data steps
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

Every run that completes or fails is written to extension storage when it
ends, and the tab, which asks for the history again each time a run answers,
lists them newest first. A pipeline refused before its first step is written as
failed, with one error per step that cannot run, and the page says why under
its header. A run cut off by the pipeline timeout is stopped where it is -- a
Delay stops waiting and no later step starts -- and is written as failed, and
the page says it ran out of time. A run stopped by an error before it returns
leaves no entry. The tab shows for each run:

- Its status, trigger, start time and duration
- How many steps ran, and how many of them failed

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
listed above, and every built-in template holds at least one that cannot run, so
an installed template cannot be run yet. Each card names the step types that
cannot run, and the tab says so above the list.

### Saved Pipelines

- Save a pipeline, and quick-load it back from the saved pipelines list
- The version badge on each entry always reads `v1`: the builder stamps
  `version: 1` and a save overwrites the pipeline under its own id. No earlier
  revision is kept, so there is nothing to compare or roll back to.

## Tips

- Start with a short pipeline of Delay steps to learn the canvas and the history
- Use the AI Pipeline Generator to sketch a workflow from a natural language description; its steps are marked when they cannot run
- Browse the Marketplace for templates that match your use case before building from scratch
- Read Execution History for each run's status, duration, step count and errors
- Remember that no pipeline moves data yet: a run is made of Delay steps, and anything else is refused before it starts
