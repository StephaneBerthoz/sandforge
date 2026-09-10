# Automation

Compose multi-step data pipelines on a visual drag-and-drop canvas, save them, run them, and read back what each run did.

> **Coming soon: the steps do not do the work their names promise.** A pipeline
> runs, the canvas reports each step's status and timing, and the run is written
> to the history -- but every step type except **Delay** and
> **Condition** to a pass-through handler that returns success without opening a
> connection. No Seed, Sync, Backup, Restore, Anonymize or Delete step has ever
> moved a record. Until step handlers ship, Automation is a design surface: use
> it to compose and store pipelines, not to run work. Each section below says
> which part is real.

## Quick Start

1. Navigate to **Automation** from the sidebar
2. Click **Create Pipeline** to start a new pipeline
3. Drag steps from the Step Palette onto the Pipeline Canvas
4. Configure each step
5. Click **Run** to walk the pipeline: the canvas switches to the execution view and reports per-step status and timing (see the banner above -- the steps themselves are inert)

## Features

### Pipeline Canvas

The visual builder for composing automation workflows:

- **Drag-and-drop canvas** -- Arrange steps visually with connections between them
- **Step Palette** -- A sidebar listing all available step types. Click to add a step to the canvas.
- **Step Config Panel** -- Select a step on the canvas to configure its parameters (object, query, batch size, etc.)
- **Pipeline Execution View** -- When running, the canvas switches to show real-time execution status per step
- **AI Pipeline Generator** -- Describe what you want in natural language and let the AI build the pipeline for you

### Step Types

15 step types, grouped the way the Step Palette groups them:

- **Data** -- Seed, Sync, Backup, Restore, Anonymize, Delete
- **Quality** -- Compare, Pre-Check
- **Control Flow** -- Condition, Loop, Parallel, Delay, Approval, Script
- **Notification** -- Notification

Two of them do something today. **Delay** waits for its configured duration, and
**Condition** evaluates its field/operator/value against the run's variables. The
other thirteen are accepted, configured, drawn, and reported as succeeded, and
execute nothing -- including **Parallel**, which runs no branch in parallel
because it runs no branch at all.

### Triggers

> **Coming soon:** only **Manual** triggering is wired to an executor as of v1.3.0. The Automation scheduler is currently a no-op, so pipelines always start by hand. The trigger types below describe the planned design.

Configure how and when pipelines start:

- **Manual** -- Run on demand from the UI
- **Scheduled (Cron)** _(coming soon)_ -- Set a cron expression with timezone support
- **Webhook** _(coming soon)_ -- Trigger from external systems
- **File Watch** _(coming soon)_ -- Start when a file appears in a watched directory
- **Record Change** _(coming soon)_ -- React to Salesforce data changes
- **Pipeline Completion** _(coming soon)_ -- Chain pipelines by triggering on another pipeline's completion

The Trigger Config Panel lets you add, remove, enable/disable triggers, and edit cron expressions.

### Scheduler

> **Coming soon:** the scheduler backend is a no-op as of v1.3.0 — no pipeline runs on a timer yet. The calendar view below describes the planned design.

A calendar view showing scheduled pipeline runs:

- Visual timeline of upcoming executions
- Calendar-based exclusion dates (holidays, maintenance windows)
- Timezone-aware scheduling

### Execution History

A log of every pipeline run, kept in extension storage:

- Per-step timing and status
- Error details for failed steps

Entries are read-only: there is no re-run channel, so a past run can be inspected
but not replayed.

### Pipeline Marketplace

Browse and install pre-configured pipeline templates:

- Templates organized by category
- Author attribution and descriptions
- One-click install to add a template to your workspace

### Saved Pipelines

- Save a pipeline, and quick-load it back from the saved pipelines list
- The version badge on each entry always reads `v1`: the builder stamps
  `version: 1` and a save overwrites the pipeline under its own id. No earlier
  revision is kept, so there is nothing to compare or roll back to.

## Tips

- Start with a short pipeline (Seed, Compare, Notification) to learn the canvas
- Use the AI Pipeline Generator to scaffold a complex workflow from a natural language description
- Browse the Marketplace for templates that match your use case before building from scratch
- Read Execution History for the shape of a run -- the order steps ran in, and how long each took
- Remember that a green run proves the pipeline walked end to end, not that any data moved
