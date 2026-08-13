# Automation

Build and run multi-step data pipelines with a visual drag-and-drop canvas. Automation brings together Seed, Sync, DataOps, and custom steps into repeatable workflows with an execution history.

## Quick Start

1. Navigate to **Automation** from the sidebar
2. Click **Create Pipeline** to start a new pipeline
3. Drag steps from the Step Palette onto the Pipeline Canvas
4. Configure each step
5. Click **Run** to execute the pipeline and monitor progress in real time

## Features

### Pipeline Canvas

The visual builder for composing automation workflows:

- **Drag-and-drop canvas** -- Arrange steps visually with connections between them
- **Step Palette** -- A sidebar listing all available step types. Click to add a step to the canvas.
- **Step Config Panel** -- Select a step on the canvas to configure its parameters (object, query, batch size, etc.)
- **Pipeline Execution View** -- When running, the canvas switches to show real-time execution status per step
- **AI Pipeline Generator** -- Describe what you want in natural language and let the AI build the pipeline for you

### Step Types

15 step types available:

- **Query** -- Run a SOQL query to fetch data
- **Transform** -- Apply data transformations (uppercase, trim, format, etc.)
- **Load** -- Insert, update, upsert, or delete records
- **Validate** -- Check data against quality rules before proceeding
- **Notify** -- Send notifications (email, Slack, webhook) on success or failure
- **Branch** -- Conditional logic to route the pipeline based on data values
- **Loop** -- Iterate over a collection of records or objects
- **Wait** -- Pause execution for a specified duration
- **Approval** -- Gate the pipeline behind a manual approval step
- And more: Script, API Call, File, Aggregate, Split, Custom

### Triggers

> **Coming soon:** only **Manual** triggering is wired to an executor as of v1.3.0. The Automation scheduler is currently a no-op, so pipelines always start by hand. The trigger types below describe the planned design.

Configure how and when pipelines start:

- **Manual** -- Run on demand from the UI
- **Scheduled (Cron)** *(coming soon)* -- Set a cron expression with timezone support
- **Webhook** *(coming soon)* -- Trigger from external systems
- **File Watch** *(coming soon)* -- Start when a file appears in a watched directory
- **Record Change** *(coming soon)* -- React to Salesforce data changes
- **Pipeline Completion** *(coming soon)* -- Chain pipelines by triggering on another pipeline's completion

The Trigger Config Panel lets you add, remove, enable/disable triggers, and edit cron expressions.

### Scheduler

> **Coming soon:** the scheduler backend is a no-op as of v1.3.0 — no pipeline runs on a timer yet. The calendar view below describes the planned design.

A calendar view showing scheduled pipeline runs:

- Visual timeline of upcoming executions
- Calendar-based exclusion dates (holidays, maintenance windows)
- Timezone-aware scheduling

### Execution History

A searchable log of every pipeline run:

- Per-step timing and status
- Error details for failed steps
- Re-run capabilities from any history entry

### Pipeline Marketplace

Browse and install pre-configured pipeline templates:

- Templates organized by category
- Author attribution and descriptions
- One-click install to add a template to your workspace

### Saved Pipelines

- Save, version, and load pipelines
- Pipeline versioning with version badges
- Quick-load from the saved pipelines list

## Tips

- Start with a simple 3-step pipeline (Query, Transform, Load) to learn the canvas
- Use the AI Pipeline Generator to scaffold complex workflows from a natural language description
- Add an Approval step before any pipeline that modifies Production data
- Check Execution History after each run to identify bottlenecks and optimize step order
- Browse the Marketplace for templates that match your use case before building from scratch
