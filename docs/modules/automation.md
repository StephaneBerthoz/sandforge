# Automation

Compose multi-step pipelines on a visual canvas, save them, run them, and read back what each step of a run did. A pipeline runs when you click Run Pipeline; a saved one also runs on a schedule, or when SandForge notices a refresh of a sandbox, while VS Code is open.

<!-- how-to:start: written by scripts/sync-module-howto.mjs from howTo.automation in packages/webview/src/i18n/locales/en.json -->

## How to

1. Click Create Pipeline at the top of the page.
2. Under Steps, click a step such as Pre-Check to add it to the Pipeline Canvas.
3. Click the step on the canvas, then fill its fields under Step Configuration.
4. Click Save Pipeline, then Run Pipeline once no step is marked Cannot run.
5. Open the History tab to read what each step of the run did.

**Tip:** Sync, Seed, Anonymize and Rewind steps write to an org. Seed and Anonymize never write to a production org; a Rewind runs once confirmed.

<!-- how-to:end -->

> **What a pipeline runs:** Backup, Checkpoint, Compare, Pre-Check,
> Notification, Delay, Condition, Approval, Sync, Seed, Anonymize and Rewind
> steps. A Backup step takes a DataOps snapshot into local storage, a
> Checkpoint step takes a checkpoint of an org on this machine, a Compare step
> runs the Compare page's metadata diff, a Pre-Check reads the Monitor's health
> signals, a Notification shows a VS Code notification, and an Approval waits
> for someone to approve the run in VS Code.
> **Four steps write to an org, each only as its own page writes:** Sync runs
> a configuration saved on the Sync page, through Sync's own run and its
> Production Guard, and a Sync step into an org the guard asks about -- a
> production org, or a sandbox marked Staging when the Sync deletes there --
> needs an Approval step before it, whose answer the guard takes. Seed seeds
> with a template of the Seed page and Anonymize masks with a template of the
> DataOps page: neither ever writes to a production org, whatever an Approval
> answers, and a sandbox marked Staging needs an Approval step before them.
> Rewind puts an org back to a checkpoint kept on this machine, once you have
> confirmed the step by typing the org's alias below its preview.
> Restore and Delete run only from their own pages. The list under Steps
> offers only steps a pipeline runs; a pipeline that holds one it cannot run --
> from a template, an AI draft or an older save -- is refused before its first
> step: nothing runs, and the run is written to the history as failed, with
> the reason.

## Quick Start

1. Navigate to **Automation** from the sidebar
2. Click **Create Pipeline** to start a new pipeline
3. Click a step under **Steps** to add it to the Pipeline Canvas
4. Select each step and configure it under **Step Configuration**: the org and objects of a Backup, the two orgs and the metadata types of a Compare, the org and checks of a Pre-Check, the message of a Notification, the seconds of a Delay, the test of a Condition, the message and wait of an Approval, the saved configuration of a Sync, the org and template of a Seed or an Anonymize, what a Checkpoint takes, and the checkpoint, the bounds and the confirmation of a Rewind
5. Click **Run Pipeline** once every step can run: the canvas shows each step as it starts and ends, and **Cancel** stops the run where it is. While a step cannot run, **Run Pipeline** is disabled and a note under the header names the step and the reason
6. To start the pipeline without a click, add a **Schedule** or a **Sandbox Refresh** trigger on the **Triggers** tab and save the pipeline: it then starts on its own while VS Code is open, and the tab shows the next run, or the sandbox it waits for

## Features

### Pipeline Canvas

The visual builder for composing automation workflows:

- **Canvas** -- Steps run in the order they are listed; a step that cannot run is marked where it sits, with the reason
- **Steps** -- A sidebar listing the twelve step types it can add and a pipeline runs: Seed, Sync, Backup, Anonymize, Checkpoint, Rewind, Compare, Pre-Check, Condition, Delay, Approval and Notification. Click to add a step to the canvas. A note above the list says what the steps that write ask for, and where Restore and Delete run instead
- **Step Configuration** -- Select a step on the canvas to configure it: its name, timeout (up to 24 days), retries, whether the run goes on after it fails, and the fields of its type
- **Pipeline Execution View** -- While a run lasts, the canvas shows each step's status as the extension reports it, what each finished step did, and a Cancel button that stops the run. An Approval step that waits shows its message, until when it waits, and **Approve** and **Reject**
- **AI Pipeline Generator** -- Describe what you want in natural language and let the AI draft the pipeline; its steps are marked when they cannot run

### Step Types

A pipeline step is one of 14 types, and the list under Steps offers the twelve a pipeline runs, grouped:

- **Data** -- Seed, Sync, Backup, Anonymize, Checkpoint, Rewind
- **Quality** -- Compare, Pre-Check
- **Control Flow** -- Condition, Delay, Approval
- **Notification** -- Notification

Twelve of them run in a pipeline:

- **Backup** -- takes the snapshot the DataOps Backup button takes, of the objects you list, from the org you choose: the same per-org lock, the same cap of records per object, the same retention. The records go to local storage, where the DataOps page lists the backup; nothing is written to the org. A snapshot that stopped at the cap says it is partial.
- **Compare** -- runs the Compare page's metadata diff between the two orgs and the metadata types you choose, and keeps its counts: only in the source, only in the target, modified, unchanged, not compared. Both orgs are only read. It hands on how many components differ (`compareDifferenceCount`), for a Condition to test.
- **Pre-Check** -- reads the Monitor's health signals you choose on an org: API usage, data storage, the Apex error logs of the last 24 hours, the failed Apex jobs. A reading the Monitor calls critical, or one it cannot read, fails the step and stops the run. It hands what it read on to the steps after it (`apiUsagePercent`, `storageUsagePercent`, `recentErrorCount`, `failedJobCount`), for a Condition to test.
- **Notification** -- shows its message as a VS Code notification, to whoever runs the pipeline. It sends nothing anywhere else: SandForge talks to no chat, mail or incident tool.
- **Delay** -- waits the seconds set under Step Configuration, from 0 up to 24 days. A run cut short stops its wait where it is.
- **Condition** -- tests its condition against the run's variables and the values the steps before it handed on. One that does not hold ends the run there, unless it names a step to go on from. Step Configuration offers the tests a run can answer: the previous step succeeded, or failed (after a step set to continue on error); a Compare found more than N differences; a Pre-Check read API usage or data storage above N %, more than N Apex errors, or more than N failed Apex jobs. A condition a Marketplace template set is shown as it stands until another is chosen. A Condition testing a value no step before it hands on -- differences with no Compare before it -- is refused before the run.
- **Approval** -- holds the run until someone answers: a VS Code notification asks, with **Approve** and **Reject**, and so does the step on the canvas while the run is open there; the first answer counts. Reject fails the step, as does no answer within its wait (an hour unless set, at most a day): "not approved in time". A cancel of the run while it waits ends it. The wait does not count against `sandforge.pipeline.timeout`. A run a schedule or a sandbox refresh starts asks through the notification, which is how a run started while VS Code is open is answered; with VS Code closed, nothing runs. Who answered, where and when are kept in Execution History and the audit trail.
- **Sync** -- runs a Sync configuration saved on the Sync page, through the run its schedule makes: the configuration is checked as Sync checks it, Production Guard is consulted, and the run is listed in Live Operations and Sync's history as a pipeline's run, where a cancel of the pipeline stops it. The Sync run does not count against `sandforge.pipeline.timeout`: it has its own Pause, Cancel and progress. A Sync into an org the guard lets through without asking -- a scratch org, a Developer Edition, a sandbox not marked Staging, or one marked Staging that the Sync deletes nothing in -- runs with no approval. One into an org the guard asks about -- a production org, or a sandbox marked Staging when the Sync deletes there -- is refused before the run unless an Approval step comes before it; the run then never shows the guard's question: the guard takes the Approval's answer, and records it as confirmed. A Sync the guard refuses -- a delete on a production org -- is refused whatever is answered. A configuration deleted or no longer valid refuses the run. The step keeps Sync's counts: records read, written, failed and skipped, per object.
- **Seed** -- seeds the org you choose with a template saved on the Seed page, or one SandForge ships, through the Seed page's own run: the same gates of storage, emails, API requests and Production Guard, listed in Live Operations, recorded in the audit trail, and kept in Seed's Recent runs under the pipeline's name, where its records are taken back. A pipeline never seeds a production org, nor one SandForge cannot tell is not one, whatever an Approval step answers; a sandbox marked Staging needs an Approval step before it, whose answer stands for every question the Seed page would put. With no Approval, the answer is no: a seed whose storage cannot be read is refused, where the page's goes on. A template with an AI rule is refused: an AI rule sends field names to Anthropic on each run, with nobody there to see it. The step is never tried again (its retries must be 0), and a seed that does not end in success fails the step, with what it created and failed. Each run adds the template's records: a Rewind step before it puts the org back to a checkpoint first.
- **Anonymize** -- masks the org you choose with a template DataOps ships or its page saved, every object its rules name or the one object you choose, its rows held to a SOQL condition, through the DataOps page's own run: first the fields the template names, which a field the org does not show the user SandForge connects as, or rules that mask nothing there, refuse before anything is written; then Production Guard; then a snapshot of every value it writes over, always, before the first one; then the masking. Without a condition it masks every row of those objects. The same rules of org as a Seed step hold: never a production org, an Approval step before it in a sandbox marked Staging, never tried again. Rows left unmasked fail the step, with how many are left per object. Nothing unmasks what it masked: its snapshot keeps the values it wrote over, in clear, on this machine, until it is deleted on the DataOps page, where a restore writes them back.
- **Checkpoint** -- takes a checkpoint of the org you choose, a sandbox, a scratch org or a Developer Edition, as the Checkpoints page takes one: everything people work in, or the objects you list, with the objects left out, the name (`{date}` in it is replaced by when the take starts), the days it is kept (30 unless set, 0 keeps it until you delete it: a nightly step then keeps one a night) and the most records it holds. Its guards are the page's, read live, and a refusal fails the step with its words. It says the checkpoint it took, its records and the space it takes on this machine. The take does not count against `sandforge.pipeline.timeout`.
- **Rewind** -- puts the org you choose back to a checkpoint kept on this machine, once you have confirmed the step (see [The confirmation of a Rewind step](#the-confirmation-of-a-rewind-step)). At each run it reads a preview of its own and is held to its bounds in the place of the person who would read it: no more records than its `maxRecords`, all objects together; none while someone other than the user it writes as and the org's Automated Process changed records of the checkpoint's objects in the hour before, unless you turn that off; and each acceptance the rewind needs, set on the step as the command line's flags. A refusal fails the step with nothing written. A deletion of records the user may not delete is answered no, nobody being there to ask: it is left untouched, and the step fails naming the objects. A rewind that does not end in success fails the step, with its counts and what still differs. It does not count against `sandforge.pipeline.timeout`. Undo is not a step: it stays on the Checkpoints page and the command line.

The other two are not offered under Steps, and a pipeline that holds one -- from a template, an AI draft or an older save -- is refused before its first step, with the step marked on the canvas and the reason:

- **Restore, Delete** write to an org with no preview to read nor run to bound them. Each runs from its own page, where Production Guard stops a write to a production org or asks you first. A Rewind step is the way back a pipeline runs.

Script, Loop and Parallel steps, which never ran, are gone. A pipeline saved with one still opens: the step is marked as no longer supported, and the pipeline is refused before it starts until the step is removed.

A step of a type SandForge does not have -- a pipeline saved by a later release, or written by hand -- is marked so where it sits, and the pipeline is refused before its first step, written to History as failed with the step and the reason; its triggers start nothing, and the SandForge output channel says why, once.

Every step is read before the run the way its module's own request is read: a Backup with no org or with an object that is not an API name, a Compare of an org with itself, a Pre-Check naming a check SandForge does not have, a Notification with no message, an Approval waiting less than a minute or more than a day, a Sync naming no saved configuration, a Seed or an Anonymize naming no template, one no longer saved, or a condition with no object, a Checkpoint of picked objects naming none, a Rewind naming no checkpoint, `latest`, or no bound on records, a timeout longer than 24 days. The page marks such a step, and the extension refuses it with the same reason.

### What each step's result is taken back by

- **Sync** -- the removal of the run in Sync's run history.
- **Seed** -- Remove in Seed's Recent runs, where the run is listed under the pipeline's name.
- **Anonymize** -- nothing unmasks a value: a restore of the step's snapshot, on the DataOps page, writes back the values it wrote over.
- **Checkpoint** -- the checkpoint is deleted on the Checkpoints page, or at the end of the days it is kept.
- **Rewind** -- Undo on the Checkpoints page, or `sandforge-checkpoint undo`, for the org's last rewind, while the recycle bin keeps what it deleted.

### The confirmation of a Rewind step

A rewind from the Checkpoints page asks for the org's alias, typed under its preview. A Rewind step runs where nobody may be there to type it, so it is confirmed once, for its configuration as saved:

1. Save the pipeline. On the step, **Confirm this rewind…** opens the preview of the rewind, read from the org as the Checkpoints page reads it, with no Rewind button: nothing is written.
2. **Confirm for this step…** asks for the org's alias -- its username when it has none -- typed as the Checkpoints page asks it. The extension reads the step from the pipeline as saved, never from the page, compares what was typed with the org it knows character for character, checks the checkpoint is kept here, can be rewound to and is of that org, and keeps the confirmation on this machine.
3. The step then reads "Confirmed on <date>: this step rewinds <org> to <checkpoint> whenever the pipeline runs, by schedule too, at most <n> records, taking back everyone's work since." **Take back the confirmation** removes it.

The confirmation is bound to what the step does to the org: its org, its checkpoint, its objects, each acceptance, its `maxRecords` and its refusal while people are at work. A save that changes any of them takes it back, and saving the old configuration again does not bring it back; a change of its name does not. It is kept in this machine's storage, never in the pipeline: a pipeline imported with a profile, installed from the Marketplace or drafted by the AI arrives unconfirmed, and an import or an install that writes a pipeline takes back the confirmations of its steps. A pipeline no longer saved, or a checkpoint deleted or past its days, leaves the confirmation void. Any VS Code window of this account on this machine runs a confirmed pipeline. Where people sign in as the user SandForge connects as -- trainees sharing a Developer Edition's one user, say -- their changes are that user's, and the refusal while people are at work does not see them.

A Rewind step without its confirmation is refused before the pipeline starts, and so is a pipeline whose checkpoint was made by the org before a refresh of its sandbox: a trigger on it starts nothing, and its starts are written to History as missed, with the reason. An Approval step before a Rewind is allowed, not needed: at 2 a.m. nobody answers, and the step would fail after its wait.

**A nightly reset of a training org**: take a baseline once on the Checkpoints page, kept until you delete it; build a pipeline "Nightly reset" with a Rewind step to it, its `maxRecords` set to what a day of training writes, and a Schedule trigger `0 2 * * *` in your time zone; save it and confirm the step. It runs only while VS Code is open: a night it is closed shows as missed, never run late. For a machine that sleeps, run `sandforge-checkpoint rewind --org <alias> --checkpoint <id> --yes --max-records <n> --refuse-when-active` from cron or CI instead (see [Checkpoint & Rewind](checkpoint.md#from-the-command-line)). A Seed step after the Rewind step seeds the org afresh each night, with no records of the night before left over.

### Triggers

The **Triggers** tab offers the trigger types that start a pipeline:

- **Manual** -- Run on demand from the Run Pipeline button
- **Schedule** -- Starts the pipeline at each time a five-field cron expression names (minute, hour, day of the month, month, day of the week), in the time zone chosen on the trigger, while VS Code is open
- **Sandbox Refresh** -- Starts the pipeline when SandForge notices that the sandbox the trigger names was refreshed (see [Monitor](monitor.md#sandbox-refreshes)), provided every step of the pipeline can run

A pipeline saved by an older release, imported with a profile or installed from a template can hold an **Event**, a **Webhook** or a **Deployment Complete** trigger. Those start nothing: no event source feeds an event trigger, SandForge opens no port a webhook could reach, and it reads an org's deployments only when the Monitor asks for them. The panel does not add them, and the card of one a pipeline holds says why it starts nothing.

A trigger starts the pipeline as it was last saved: an edit on the Triggers tab takes effect when the pipeline is saved, and the tab says so until then. For each saved trigger the tab shows what it will do -- the next run of a schedule, in its time zone, the sandbox a refresh trigger waits for, and when it last fired -- or why it starts nothing: switched off, a cron expression it cannot read or that no date of the coming year matches (the 31st of February or April never comes), a sandbox SandForge no longer knows, a step of the pipeline that cannot run.

How a run a trigger starts goes:

- Only while VS Code is open. Every VS Code window runs SandForge, and the windows open on one machine share which of them makes each start, so a pipeline is started once however many windows are open. Each window reads the saved pipelines when it opens: a trigger changed and saved in one window takes effect in the others once they are reloaded. With VS Code closed, nothing runs.
- On time, or not at all. A schedule is looked at when it falls due, and at least once a minute. A start that falls due while VS Code is closed, or while the computer sleeps and the look comes more than two minutes late, is not made late: it is written to Execution History as missed, VS Code shows a warning, and the schedule goes on from its next time. A start missed while VS Code was closed is found at the next launch.
- One run of a pipeline at a time. A trigger that fires while a run of the same pipeline is going -- started by hand or by a trigger, in any window -- starts nothing, and History writes the start as missed, naming the run that was in the way. **Run Pipeline** is refused in the same way while a triggered run of that pipeline is going.
- Only a pipeline whose steps can all run. A trigger on a pipeline that holds a step that cannot run starts nothing, and the tab says so. The starts a schedule of such a pipeline falls due for are written to History as missed, with the step and the reason, gathered into one entry and said once in a VS Code warning until the pipeline runs or the reason changes; so is a sandbox refresh that finds one.
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
- Each step, with its status, how long it took, and what it did or why it failed: the records a Backup took, the counts a Compare found, what a Pre-Check read, the records a Sync wrote, and how an Approval was answered, where and when

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
listed above. Several built-in templates hold a Restore step, or a Pre-Check
naming a check SandForge does not have, so they cannot run as installed; each
card names the step types that do not run in a pipeline, and the tab says so
above the list. An installed template's Backup, Compare, Pre-Check, Seed and
Anonymize steps ask for their orgs, and its Sync steps for a saved
configuration, before the pipeline can run: Sandbox Refresh Post-Processing
masks with GDPR Standard and seeds with the Minimal Demo template once its two
steps name the refreshed sandbox. An installed pipeline is never confirmed: a
Rewind step in it asks to be confirmed on this machine.

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
- Put an Approval step before a Sync into a production org, and after a Compare, so the person who approves has the differences in front of them
- A pipeline writes to an org through four steps: a saved Sync configuration, a Seed template, a masking template, and a confirmed Rewind. Restoring and deleting run from their own pages
- After a sandbox refresh, a Sandbox Refresh trigger on an Anonymize step then a Seed step masks the copy of production's data and seeds test records; without a condition, the Anonymize step masks every row of the template's objects, in a sandbox others share too
