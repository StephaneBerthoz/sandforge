# Automation

Compose multi-step pipelines on a visual canvas, save them, run them, and read back what each step of a run did. A pipeline runs when you click Run Pipeline; a saved one also runs on a schedule, or when SandForge notices a refresh of a sandbox, while VS Code is open. With VS Code closed, a pipeline exported with **Export…** runs from cron, Task Scheduler or GitHub Actions through `sandforge pipeline`: [When VS Code is closed](#when-vs-code-is-closed).

<!-- how-to:start: written by scripts/sync-module-howto.mjs from howTo.automation in packages/webview/src/i18n/locales/en.json -->

## How to

1. Click New pipeline or install a template, then under Add a step click a step such as Pre-Check.
2. Click the step on the canvas, then fill its fields under Step Configuration.
3. Click Save Pipeline and Simulate, then Run Pipeline once no step is marked Cannot run.
4. Open the History tab to read what each step of the run did.
5. To run it with VS Code closed, click Export… and save the file and its launcher.

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
> confirmed the step by typing the org's alias below its preview. Where an org
> delivers the emails of what still runs, or would not say whether it does, a
> Sync or a Seed goes on only if an Approval before it was approved, and a
> Rewind only if the step accepts them.
> Restore and Delete run only from their own pages. The list under Add a step
> offers only steps a pipeline runs; a pipeline that holds one it cannot run --
> from a template, an AI draft or an older save -- is refused before its first
> step: nothing runs, and the run is written to the history as failed, with
> the reason.

## Quick Start

1. Navigate to **Automation** from the sidebar
2. Click **New pipeline** to start a new pipeline, install one from the **Templates** tab, or click a step under **Add a step**: a new pipeline starts with it
3. Click a step under **Add a step** to add it to the canvas of the **Steps** tab. A step is named after its type -- Delay, then Delay 2 -- until you rename it
4. Select each step and configure it under **Step Configuration**, which then comes above the list of steps: the org and objects of a Backup, the two orgs and the metadata types of a Compare, the org and checks of a Pre-Check, the message of a Notification, the seconds of a Delay, the test of a Condition, the message and wait of an Approval, the saved configuration of a Sync, the org and template of a Seed or an Anonymize, what a Checkpoint takes, and the checkpoint, the bounds and the confirmation of a Rewind
5. Click **Simulate** to see what each step would do, writing nothing, then **Run Pipeline** once every step can run: the canvas shows each step as it starts and ends, and **Cancel** stops the run where it is. While a step cannot run, **Run Pipeline** is disabled and a note under the header names the step and the reason
6. To start the pipeline without a click, add a **Schedule** or a **Sandbox Refresh** trigger under **This pipeline** on the **Start** tab and save the pipeline: it then starts on its own while VS Code is open, and the tab shows the next run, or the sandbox it waits for

## Features

### Steps

The first tab, the visual builder for composing automation workflows:

- **Canvas** -- Steps run top to bottom, in the order they are listed; a step that cannot run is marked where it sits, with the reason. A step renamed from its type shows its type beside its name
- **Add a step** -- A sidebar listing the twelve step types it can add and a pipeline runs: Seed, Sync, Backup, Anonymize, Checkpoint, Rewind, Compare, Pre-Check, Condition, Delay, Approval and Notification. Click to add a step to the canvas, or, with no pipeline open, to start one with that step. A line above the list says only the steps a pipeline runs are listed, and its **Why?** says what the steps that write ask for, and where Restore and Delete run instead
- **Step Configuration** -- Select a step on the canvas to configure it: its configuration comes above the list of steps, into view. Its name, its timeout in minutes (up to 24 days, 34,560 minutes; empty for none), retries, whether the run goes on after it fails, and the fields of its type
- **Pipeline Execution View** -- While a run lasts, the canvas shows each step's status as the extension reports it, what each finished step did, and a Cancel button that stops the run. An Approval step that waits shows its message, until when it waits, and **Approve** and **Reject**
- **Simulate** -- Beside **Run Pipeline**, a run along the same route that writes nothing to any org, named as Forge, Sync and a checkpoint's replay name theirs: a Sync simulates, an Anonymize and a Rewind preview, a Checkpoint says what it would take, a Seed meets its run's gates -- the data storage and the API requests its org has left, the emails it would make it send -- and says what it would seed, or is refused in its run's words; Compare and Pre-Check read the orgs, so a Condition tests what they found. No Delay waits, no Approval is asked, no Notification is shown, and the history keeps nothing. Each step says what it would do ("would run", "would stop here"), and a refusal says where the run would stop
- **AI Pipeline Generator** -- Describe what you want in natural language and let the AI draft the pipeline; its steps are marked when they cannot run
- **No pipeline open** -- The canvas says how to start one, and **Browse templates** opens the **Templates** tab
- **Next run** and **Last run** -- Above the tabs while a pipeline is open, and for it alone: the soonest start a schedule of the pipeline as saved plans, in its time zone, or the sandbox whose refresh starts it, or **None** when only Run Pipeline starts it (the launcher, for a pipeline whose schedule was handed to one); then how its latest run ended, and when. A start a trigger missed is no run

### Step Types

A pipeline step is one of 14 types, and the list under Add a step offers the twelve a pipeline runs, grouped:

- **Data** -- Seed, Sync, Backup, Anonymize, Checkpoint, Rewind
- **Quality** -- Compare, Pre-Check
- **Control Flow** -- Condition, Delay, Approval
- **Notification** -- Notification

Twelve of them run in a pipeline:

- **Backup** -- takes the snapshot the DataOps Backup button takes, of the objects you list, from the org you choose: the same per-org lock, the same cap of records per object, the same retention. The records go to local storage, where the DataOps page lists the backup; nothing is written to the org. A snapshot that stopped at the cap says it is partial. The snapshot does not count against `sandforge.pipeline.timeout`: it is listed in Live Operations with its own Cancel.
- **Compare** -- runs the Compare page's metadata diff between the two orgs and the metadata types you choose, and keeps its counts: only in the source, only in the target, modified, unchanged, not compared. Both orgs are only read. It hands on how many components differ (`compareDifferenceCount`), for a Condition to test.
- **Pre-Check** -- reads the Monitor's health signals you choose on an org: API usage, data storage, the Apex error logs of the last 24 hours, the failed Apex jobs. A reading the Monitor calls critical, or one it cannot read, fails the step and stops the run. A reading that meets a session the org no longer takes, or a connection that does not reach the org, is read once more on a new connection, its session renewed through the Salesforce CLI; one still not read says why, the org's error or the session that could not be renewed and how to sign in again. It hands what it read on to the steps after it (`apiUsagePercent`, `storageUsagePercent`, `recentErrorCount`, `failedJobCount`), for a Condition to test.
- **Notification** -- shows its message as a VS Code notification, to whoever runs the pipeline; run by `sandforge pipeline`, with no window to show it in, it prints the message in the run's output. It sends nothing anywhere else: SandForge talks to no chat, mail or incident tool.
- **Delay** -- waits the seconds set under Step Configuration, from 0 up to 24 days. The wait does not count against `sandforge.pipeline.timeout`. A run cut short stops its wait where it is. The step says how long it really waited, by the wall clock: a wait is timed on the machine's own clock, which stops while the machine sleeps and may run slower than the wall's, and one that held more than 5 s or a hundredth past its time says the machine's clock or a sleep may account for it.
- **Condition** -- tests its condition against the run's variables and the values the steps before it handed on. One that does not hold ends the run there, unless it names a step to go on from. Step Configuration offers the tests a run can answer: the previous step succeeded, or failed (after a step set to continue on error); a Compare found more than N differences; a Pre-Check read API usage or data storage above N %, more than N Apex errors, or more than N failed Apex jobs. A condition a template set is shown as it stands until another is chosen. A Condition testing a value no step before it hands on -- differences with no Compare before it -- is refused before the run.
- **Approval** -- holds the run until someone answers: a VS Code notification asks, with **Approve** and **Reject**, and so does the step on the canvas while the run is open there; the first answer counts. Reject fails the step, as does no answer within its wait (an hour unless set, at most a day): "not approved in time". A cancel of the run while it waits ends it. The wait does not count against `sandforge.pipeline.timeout`. A run a schedule or a sandbox refresh starts asks through the notification, which is how a run started while VS Code is open is answered. Run with VS Code closed by `sandforge pipeline`, it asks the person at the terminal of the run, or is answered ahead with `--approve "<step>"`, but for one that stands before a write to a sandbox marked Staging, which only a person at a terminal answers: [When VS Code is closed](#when-vs-code-is-closed). Who answered, where -- the notification, the page, the terminal or the command line -- and when are kept in Execution History and the audit trail.
- **Sync** -- runs a Sync configuration saved on the Sync page, through the run its schedule makes: the configuration is checked as Sync checks it, Production Guard is consulted, and the run is listed in Live Operations and Sync's history as a pipeline's run, where a cancel of the pipeline stops it. The Sync run does not count against `sandforge.pipeline.timeout`: it has its own Pause, Cancel and progress. A Sync into an org the guard lets through without asking -- a scratch org, a Developer Edition, a sandbox not marked Staging, or one marked Staging that the Sync deletes nothing in -- runs with no approval. One into an org the guard asks about -- a production org, or a sandbox marked Staging when the Sync deletes there -- is refused before the run unless an Approval step comes before it; the run then never shows the guard's question: the guard takes the Approval's answer, and records it as confirmed. A Sync the guard refuses -- a delete on a production org -- is refused whatever is answered. Into a target that delivers the emails of what still runs, or would not say whether it does, any Sync step needs an Approval before it, approved, whatever the guard says: that answer is the accord to send them, and the step fails otherwise, nothing written, saying so. Nothing else stands for it. An automation that could not be read asks the same way. A configuration deleted or no longer valid refuses the run. The step keeps Sync's counts: records read, written, failed and skipped, per object.
- **Seed** -- seeds the org you choose with a template saved on the Seed page, or one SandForge ships, through the Seed page's own run: the same gates of storage, emails, API requests and Production Guard, listed in Live Operations, recorded in the audit trail, and kept in Seed's History under the pipeline's name, where its records are taken back. A pipeline never seeds a production org, nor one SandForge cannot tell is not one, whatever an Approval step answers; a sandbox marked Staging needs an Approval step before it, whose answer stands for every question the Seed page would put, the emails an org delivers among them. With no Approval, the answer is no: a seed whose storage cannot be read is refused, where the page's goes on, and so is one into an org that delivers the emails of what still runs, or would not say whether it does. A template with an AI rule is refused: an AI rule sends field names to Anthropic on each run, with nobody there to see it. The step is never tried again (its retries must be 0), and a seed that does not end in success fails the step, with what it created and failed. Each run adds the template's records: a Rewind step before it puts the org back to a checkpoint first.
- **Anonymize** -- masks the org you choose with a template DataOps ships or its page saved, every object its rules name or the one object you choose, its rows held to a SOQL condition, through the DataOps page's own run: first the fields the template names, which a field the org does not show the user SandForge connects as, or rules that mask nothing there, refuse before anything is written; then Production Guard; then a snapshot of every value it writes over, always, before the first one; then the masking. Without a condition it masks every row of those objects. Before its first write it reads what the org runs as it writes over the records, the emails that sends and whether the org delivers them, as a masking of the DataOps page does, and takes three settings for it, each off by default, as a Rewind step does: `acceptAutomation` lets what fires run, `acceptEmails` lets an org on All email send the emails, which the first never stands for, and `muteAutomation` mutes what the org's own bypass keeps quiet, for the masking alone. Without the one it needs, the step fails with nothing masked, its code (`AUTOMATION_NOT_ACCEPTED`, `EMAILS_NOT_ACCEPTED`) and the setting to turn on; past the day's emails, nothing lifts it. An Approval step stands for none of them. The same rules of org as a Seed step hold: never a production org, an Approval step before it in a sandbox marked Staging, never tried again. Rows left unmasked fail the step, with how many are left per object. Nothing unmasks what it masked: its snapshot keeps the values it wrote over, in clear, on this machine, until it is deleted on the DataOps page, where a restore writes them back.
- **Checkpoint** -- takes a checkpoint of the org you choose, a sandbox, a scratch org or a Developer Edition, as the Checkpoints page takes one: everything people work in, or the objects you list, with the objects left out, the name (`{date}` in it is replaced by when the take starts), the days it is kept (30 unless set, 0 keeps it until you delete it: a nightly step then keeps one a night) and the most records it holds. Its guards are the page's, read live, and a refusal fails the step with its words. It says the checkpoint it took, its records and the space it takes on this machine. The take does not count against `sandforge.pipeline.timeout`.
- **Rewind** -- puts the org you choose back to a checkpoint kept on this machine, once you have confirmed the step (see [The confirmation of a Rewind step](#the-confirmation-of-a-rewind-step)). At each run it reads a preview of its own and is held to its bounds in the place of the person who would read it: no more records than its `maxRecords`, all objects together; none while someone other than the user it writes as and the org's Automated Process changed records of the checkpoint's objects in the hour before, unless you turn that off; and each acceptance the rewind needs, set on the step as the command line's flags, the emails an org delivers among them, off by default. The step can mute the org's automation for the rewind, through its own bypass, as the Checkpoints page and `--mute-automation` do; off by default, and what no bypass keeps quiet still needs its acceptance. A refusal fails the step with nothing written, and past the day's emails no acceptance lifts it. A deletion of records the user may not delete is answered no, nobody being there to ask: it is left untouched, and the step fails naming the objects. A rewind that does not end in success fails the step, with its counts and what still differs. It does not count against `sandforge.pipeline.timeout`. Undo is not a step: it stays on the Checkpoints page and the command line.

The other two are not offered under Add a step, and a pipeline that holds one -- from a template, an AI draft or an older save -- is refused before its first step, with the step marked on the canvas and the reason:

- **Restore, Delete** write to an org with no preview to read nor run to bound them. Each runs from its own page, where Production Guard stops a write to a production org or asks you first. A Rewind step is the way back a pipeline runs.

Script, Loop and Parallel steps, which never ran, are gone. A pipeline saved with one still opens: the step is marked as no longer supported, and the pipeline is refused before it starts until the step is removed.

A step of a type SandForge does not have -- a pipeline saved by a later release, or written by hand -- is marked so where it sits, and the pipeline is refused before its first step, written to History as failed with the step and the reason; its triggers start nothing, and the SandForge output channel says why, once.

Every step is read before the run the way its module's own request is read: a Backup with no org or with an object that is not an API name, a Compare of an org with itself, a Pre-Check naming a check SandForge does not have, a Notification with no message, an Approval waiting less than a minute or more than a day, a Sync naming no saved configuration, a Seed or an Anonymize naming no template, one no longer saved, or a condition with no object, a Checkpoint of picked objects naming none, a Rewind naming no checkpoint, `latest`, or no bound on records, a timeout longer than 24 days. The page marks such a step, and the extension refuses it with the same reason.

### What each step's result is taken back by

- **Sync** -- the removal of the run in Sync's run history.
- **Seed** -- Remove in Seed's History, where the run is listed under the pipeline's name.
- **Anonymize** -- nothing unmasks a value: a restore of the step's snapshot, on the DataOps page, writes back the values it wrote over.
- **Checkpoint** -- the checkpoint is deleted on the Checkpoints page, or at the end of the days it is kept.
- **Rewind** -- Undo on the Checkpoints page, or `sandforge checkpoint undo`, for the org's last rewind, while the recycle bin keeps what it deleted.

### The confirmation of a Rewind step

A rewind from the Checkpoints page asks for the org's alias, typed under its preview. A Rewind step runs where nobody may be there to type it, so it is confirmed once, for its configuration as saved:

1. Save the pipeline. On the step, **Preview and confirm…** opens the preview of the rewind, read from the org as the Checkpoints page reads it, with no Rewind button: nothing is written.
2. **Type the org alias to confirm…** opens **Allow unattended rewinds of <org>**, which asks for the org's alias -- its username when it has none -- typed as the Checkpoints page asks it. The extension reads the step from the pipeline as saved, never from the page, compares what was typed with the org it knows character for character, checks the checkpoint is kept here, can be rewound to and is of that org, and keeps the confirmation on this machine.
3. The step then reads "Confirmed on <date>: this step rewinds <org> to <checkpoint> on each run, scheduled ones included, at most <n> records, reverting or deleting every change anyone made since." **Revoke confirmation** removes it.

The acceptances a Rewind step gives sit under **Allow riskier changes (off by default)**, folded while none is ticked, and are worded as the Checkpoints preview words the same boxes: mute the org's automation for this rewind, through its own bypass, which the preview of the confirmation then shows, what it would assign and what still runs; run even if triggers, flows or workflow rules fire on the records it writes; run even if the org delivers the emails its flows, processes or workflow rules send as it writes (All email), or would not say whether it does, which the first never stands for; allow deletions that Undo of this rewind cannot bring back; recreate, with new Ids, records already emptied from the Recycle Bin; allow deletions that cascade to child records of objects outside the checkpoint; allow deletions that cascade to records the connected user may not see.

The confirmation is bound to what the step does to the org: its org, its checkpoint, its objects, each acceptance, its `maxRecords` and its refusal while people are at work. A save that changes any of them takes it back, and saving the old configuration again does not bring it back; a change of its name does not. A step confirmed before 1.72.0 asks to be confirmed again: its confirmation now covers the emails it accepts. It is kept in this machine's storage, never in the pipeline: a pipeline imported with a profile, installed from a template or drafted by the AI arrives unconfirmed, and an import or an install that writes a pipeline takes back the confirmations of its steps. A pipeline no longer saved, or a checkpoint deleted or past its days, leaves the confirmation void. Any VS Code window of this account on this machine runs a confirmed pipeline. Where people sign in as the user SandForge connects as -- trainees sharing a Developer Edition's one user, say -- their changes are that user's, and the refusal while people are at work does not see them.

A Rewind step without its confirmation is refused before the pipeline starts, and so is a pipeline whose checkpoint was made by the org before a refresh of its sandbox: a trigger on it starts nothing, and its starts are written to History as missed, with the reason. An Approval step before a Rewind is allowed, not needed: at 2 a.m. nobody answers, and the step would fail after its wait.

**A nightly reset of a training org**: take a baseline once on the Checkpoints page, kept until you delete it; build a pipeline "Nightly reset" with a Rewind step to it, its `maxRecords` set to what a day of training writes, and a Schedule trigger `0 2 * * *` in your time zone; save it and confirm the step. From VS Code it runs only while VS Code is open: a night it is closed shows as missed, never run late. To run it with VS Code closed, **Export…** it with the bash launcher and its crontab line, and tick **Let this launcher start the pipeline**: cron then runs `sandforge pipeline run --file nightly-reset.sandforge-pipeline.json` each night, and the Rewind step runs once its org is confirmed on that machine -- `sandforge pipeline confirm --file nightly-reset.sandforge-pipeline.json` at a terminal, or `--confirm-rewind <alias>` in the launcher -- its checkpoint kept on that machine (see [When VS Code is closed](#when-vs-code-is-closed)). A rewind alone runs from cron or CI as `sandforge checkpoint rewind --org <alias> --checkpoint <id> --yes --max-records <n> --refuse-when-active` (see [Checkpoint & Rewind](checkpoint.md#from-the-command-line)). A Seed step after the Rewind step seeds the org afresh each night, with no records of the night before left over.

### Templates

The second tab: browse and install pre-configured pipeline templates.

- Templates organized by category
- Author attribution and descriptions
- One-click install to add a template to your workspace
- With no pipeline open, the canvas offers **Browse templates**, which opens this tab. Back into service's **Automate after each refresh…** opens it on Sandbox Refresh Post-Processing, its card marked and its **Install** button under the keyboard: nothing is installed before that click

A template is a composition, not a capability: its steps are the same step types
listed above. Every built-in template runs once installed: each card is held to
the checks a pipeline's steps pass before a run, the orgs and a Sync step's
saved configuration left to choose. A card whose template holds a step that
would not run -- a Restore, a Pre-Check naming a check SandForge does not have,
a Seed or an Anonymize naming no template, as an imported template can -- names
each such step and why, and the tab says so above the list. An installed
template's Backup, Checkpoint, Compare, Pre-Check, Seed and Anonymize steps ask
for their orgs, and its Sync steps for a saved configuration, before the
pipeline can run: Sandbox Refresh Post-Processing
masks with GDPR Standard and seeds with the Minimal Demo template once its two
steps name the refreshed sandbox. An installed pipeline is never confirmed: a
Rewind step in it asks to be confirmed on this machine.

### Start

The third tab says what starts the pipeline open, then every run planned on
this machine. It took the place of two tabs, Triggers and Scheduler.

<a id="triggers"></a>

#### This pipeline

**This pipeline** offers the trigger types that start the pipeline open. **Run Pipeline** runs one without any trigger; a pipeline with no trigger runs only from it:

- **Schedule** -- Starts the pipeline at each time a five-field cron expression names (minute, hour, day of the month, month, day of the week), in the time zone chosen on the trigger, while VS Code is open
- **Sandbox Refresh** -- Starts the pipeline when SandForge notices that the sandbox the trigger names was refreshed (see [Monitor](monitor.md#sandbox-refreshes)), provided every step of the pipeline can run

A pipeline saved by an older release, imported with a profile or installed from a template can hold a **Manual**, an **Event**, a **Webhook** or a **Deployment Complete** trigger. Those start nothing: Run Pipeline runs a pipeline with or without a Manual trigger, no event source feeds an event trigger, SandForge opens no port a webhook could reach, and it reads an org's deployments only when the Monitor asks for them. The panel does not add them, and the card of one a pipeline holds is badged **Starts nothing**, says why, and has nothing to switch on or off. **Next run**, above the tabs, gives the soonest start of a schedule switched on, or the sandbox a refresh trigger switched on waits for.

A trigger starts the pipeline as it was last saved: an edit under This pipeline takes effect when the pipeline is saved, and the tab says so until then. For each saved trigger the tab shows what it will do -- the next run of a schedule, in its time zone, the sandbox a refresh trigger waits for, and when it last fired -- or why it starts nothing: switched off, a cron expression it cannot read or that no date of the coming year matches (the 31st of February or April never comes), a sandbox SandForge no longer knows, a step of the pipeline that cannot run.

How a run a trigger starts goes:

- Only while VS Code is open. Every VS Code window runs SandForge, and the windows open on one machine share which of them makes each start, so a pipeline is started once however many windows are open. Each window reads the saved pipelines when it opens: a trigger changed and saved in one window takes effect in the others once they are reloaded. With VS Code closed, no trigger starts anything: a pipeline exported with **Export…** is started by its launcher instead -- cron, Task Scheduler or a GitHub Actions workflow -- through `sandforge pipeline` ([When VS Code is closed](#when-vs-code-is-closed)).
- On time, or not at all. A schedule is looked at when it falls due, and at least once a minute. A start that falls due while VS Code is closed, or while the computer sleeps and the look comes more than two minutes late, is not made late: it is written to Execution History as missed, VS Code shows a warning, and the schedule goes on from its next time. A start missed while VS Code was closed is found at the next launch. The line History gives a start missed while VS Code was closed or the computer slept says that a pipeline exported with **Export…**, beside Run Pipeline, runs from its launcher instead. A schedule handed to a launcher is off in VS Code: its starts are the launcher's, and none is written as missed here.
- One run of a pipeline at a time. A trigger that fires while a run of the same pipeline is going -- started by hand or by a trigger, in any window -- starts nothing, and History writes the start as missed, naming the run that was in the way. **Run Pipeline** is refused in the same way while a triggered run of that pipeline is going.
- Only a pipeline whose steps can all run. A trigger on a pipeline that holds a step that cannot run starts nothing, and the tab says so. The starts a schedule of such a pipeline falls due for are written to History as missed, with the step and the reason, gathered into one entry and said once in a VS Code warning until the pipeline runs or the reason changes; so is a sandbox refresh that finds one.
- A run a trigger starts is written to Execution History with what started it. One that fails is also shown in a VS Code notification; one that completes says nothing more.

#### All scheduled runs

The second part of the Start tab lists the sync schedules, the ones the Sync
page's Saved tab keeps (see [Sync](sync.md#schedules)), by the day each next
runs:

- Today, tomorrow and each later day, with the time of each run. A run whose
  time has passed is listed as due until it has run: the extension runs it at
  its next check, once a minute while VS Code is open
- For each schedule, its cron expression and time zone, and how its last run
  went and when. A paused schedule is listed apart, with no run time
- Pause or resume, edit and delete, as on the Sync page. A new one is made
  there: **Manage Sync schedules** opens the Sync page's Saved tab, where a
  schedule is made for a saved Sync configuration
- The tab asks for the schedules again once the soonest run is past, so the
  next run and the last result follow the runs while it is open

Below them, it lists the pipeline schedules: the Schedule trigger of each saved
pipeline, with its cron expression, its time zone and its next run, or why it
starts nothing. A pipeline schedule is edited under This pipeline, above, with
its pipeline open. It runs only while VS Code is open, like a sync schedule, but
it is never made late: where a sync schedule runs a run it missed at its next check,
a pipeline schedule writes the start to Execution History as missed.

### When VS Code is closed

The pipelines are kept in VS Code's own storage, which nothing outside the editor reads. **Export…**, beside **Run Pipeline**, writes a saved pipeline to a file, and a launcher runs that file with `sandforge pipeline` from the `sandforge` npm package, through the same handler as the page: the same steps, the same checks before the first step, the same guards.

**Export…** is offered on a saved pipeline with no unsaved change ("Save first: the export takes the saved pipeline."). It reads the pipeline as saved, writes nothing until you choose where, and shows:

- **Steps, with VS Code closed**, each **Runs as here**, **Asks something** -- an Approval asks a person at the terminal of the run, or is answered ahead with `--approve "<step>"`; a Rewind runs once its org is confirmed on the machine of the run, its checkpoint kept there; a Notification prints its message in the run's output -- or **Refused**, with the reason the page gives it. A step refused refuses the run before its first step.
- **Orgs**: each by its alias, its kind, its Staging mark, the steps that read and write it, and whether the Salesforce CLI of this machine is signed in to it, with the line that signs in where it is not. An org with no alias of its own is named as the run starts (`--org <key>=<alias>`).
- **Variables**: a secret's value never goes in the file: it is given as the run starts, `--var-env <name>=<ENV>`.
- **Launcher**: none (the file alone); bash, started by cron, with the crontab line in the zone of this machine's clock -- the times it runs early or late across a change of the clock are said, and a schedule no line of cron keeps leaves the launcher on no schedule, said so; PowerShell 7 (`pwsh`), started by Task Scheduler, with the command that registers its task when the schedule is a daily or weekly one, by hand otherwise -- started by an older PowerShell, Windows PowerShell 5.1 among them, it says it needs PowerShell 7 and runs nothing; or a GitHub Actions workflow, its schedule, a run by hand, and a repository secret per org, `SFDX_AUTH_URL_<ALIAS>`.
- **Let this launcher start the pipeline: turn its schedule off here**, ticked once a launcher is chosen for a pipeline with a schedule: once the launcher is saved beside the file, the pipeline is saved with its schedule off. The Start tab and History then say "Started by \<launcher\> since \<date\> (file \<name\>)", with **Resume the schedule here**, which turns it on again once saved and says to remove the crontab line, the task or the workflow, or both start it. A save that changes the pipeline after the export says the file no longer holds it: export again.
- **What keeps two runs apart, and what does not**: a run from VS Code and one from a launcher on the same machine take the same lock, and the second is refused (`PIPELINE_RUNNING`); that lock holds the pipeline, not its orgs; a CI runner is held off by nothing here.

The file, saved first, is `<name>.sandforge-pipeline.json`: the pipeline as saved, its schedule and time zone, each org by its alias and its Organization Id, its kind and its Staging mark, the Sync configurations, Seed templates and masking templates its steps run, and the settings its steps read. Never a username, a token, nor a secret's value. The launcher is saved second, in the folder of the file.

`sandforge pipeline` reads that file:

| Command                 | What it does                                                                                                                                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plan --file <file>`    | Connects each org, types it live and checks every step as a run would; writes nothing, to the orgs or to the store. Exit `2` when a run would be refused                                                       |
| `run --file <file>`     | Runs the pipeline as the page runs it; each step is printed as it ends, then what it did, and the lines that take the run back. `--dry-run` runs it along the same route writing nothing, as **Simulate** does |
| `confirm --file <file>` | Confirms the Rewind steps at the terminal: the alias of each one's org typed, as the page asks it, kept in the store                                                                                           |
| `history --file <file>` | The runs the command line made of the pipeline on this machine, newest first; no org is reached                                                                                                                |

- **Orgs**: each org is reached by the alias the file names, or the one `--org <key>=<alias>` gives. A sandbox or a production org is held to its Organization Id: one that answers with another -- a sandbox refreshed since -- refuses the run (`ORG_MOVED`), saying whether its kind changed too, until you have checked it is the org and run again with `--accept-org <alias>=<00D…>` (the org by its alias, or by its key in the file, and the Id it answers with), or export again. A scratch org or a Developer Edition org, made again under the same alias, is not held to its Id. The Staging mark comes from the file, and is set on a sandbox alone.
- **Approval**: at a terminal, the run asks the person there. With no terminal -- cron, Task Scheduler, a CI job -- `--approve "<step>"`, repeated, answers a step yes ahead, and the history says it was answered on the command line. Never for one that stands before a write to a sandbox marked Staging: only a person at a terminal answers it (`STAGING_NEEDS_PERSON`), or take the mark off on the Organizations page and export again.
- **Rewind**: it runs once its org's alias is confirmed on this machine, by `confirm` or by `--confirm-rewind <alias>`, and its checkpoint is kept on this machine -- taken here, or imported with `sandforge checkpoint import`.
- **Production**: a step of the command line never writes to a production org, whatever an Approval answers (`PRODUCTION_TARGET`): the page lets a Sync write there behind an Approval, a run nobody watches does not.
- **Variables**: `--var <name>=<value>` and `--var-env <name>=<ENV>`, repeated; a required variable with no value, or one the pipeline does not declare, is refused.
- **The store**: the Sync watermarks a delta Sync reads on from, the Rewind confirmations and the audit, kept between runs in `pipelines/<id>/store/` of the folder `SANDFORGE_JOURNAL_DIR` names, `~/.sandforge` by default, or the folder `--store` names -- a CI job caches it. It is not the editor's: the command line reads none of VS Code's, nor VS Code its. The lock and the history are in `pipelines/<id>/`: the Automation page lists the command line's runs of this machine in History, marked **Command line**; a CI's are not there.
- **Refused before the first step**, nothing run, exit `2`, every cause at once, each with what lifts it: `ORG_MOVED`, `ORG_NO_ALIAS`, `ORG_UNKNOWN_KEY`, `ORG_NOT_CONNECTED`, `PRODUCTION_TARGET`, `STEP_REFUSED`, `PIPELINE_REFUSED`, `APPROVAL_NO_TERMINAL`, `STAGING_NEEDS_PERSON`, `APPROVE_UNKNOWN_STEP`, `CONFIRM_UNKNOWN_ORG`, `REWIND_NOT_CONFIRMED`, `VARIABLE_MISSING`, `VARIABLE_UNKNOWN`, `PIPELINE_RUNNING`. A file a newer SandForge exported names the release that reads it.
- **Taking a run back**: the run ends on "To take this run back, in this order:", the last step first -- `sandforge seed --remove <run> --target <alias>`, `sandforge sync --remove <run> --target <alias> --store <store>`, `sandforge dataops anonymize --org <alias> --restore <snapshot>`, `sandforge checkpoint undo --org <alias> --checkpoint <id>`, `sandforge checkpoint delete --org <alias> --checkpoint <id>` -- each line of a step that wrote. A Sync is named by its run's file, which its removal reads. A Seed or a Sync whose records a later step of the run wrote over again -- a Rewind that deleted in a Seed's org, an Anonymize of the objects either wrote -- is taken back with `--include-changed`: that step's line, run first, dates their records anew -- the undo brings them back from the recycle bin, the restore writes the masked values back --, and the removal would keep them as changed since the run. The snapshot an Anonymize step took is listed under the alias of its org, which its restore names, and keeps the values it masked in clear on this machine until the retention takes it: the run names the line that deletes it, `sandforge backup --delete <snapshot> --org <alias>`.
- **Exit codes**: `0` completed (with warnings unless `--fail-on-partial`); `1` failed, or could not start; `2` a bad command line, a file that does not read, or a run refused before its first step; `3` with `--fail-on-partial`, completed with warnings; `129`, `130`, `143` a SIGHUP, a Ctrl-C or a SIGTERM stopped it: the step under way is stopped, and the run ends cancelled. A launcher exits `127` when it finds no Node.js 20.19 or later, or no Salesforce CLI.

Not proven by a run: the cron daemon on a machine that sleeps (a start missed is lost, as in VS Code), Task Scheduler on Windows, the macOS keychain under cron, and GitHub's own schedule, which starts late when its runners are busy and is turned off in a public repository after 60 days without activity. On WSL, cron runs only where systemd does. The [CI guide](../../ci-examples/README.md#an-automation-pipeline-with-vs-code-closed) has the CI side.

### History

Every run that completes, fails or is cancelled is written to extension
storage when it ends, and the tab, which asks for the history again each time a
run answers, lists them newest first -- a run a trigger started included, which
the tab asks for when it ends. A pipeline refused before its first step
is written as failed, with one error per step that cannot run, and the page
says why under its header. A run cut off by the pipeline timeout is stopped
where it is -- a Compare or a Pre-Check stops where it reads, and no later step
starts -- and is written as failed, and the page says it ran out of time. A
Delay's wait and a Backup do not count against `sandforge.pipeline.timeout`,
nor do Sync, Seed, Anonymize, Checkpoint, Rewind and an Approval's wait: a Delay
waits the seconds it is set to, a Backup has its own Cancel in Live Operations,
and a cancel of the run stops either where it is. A run you stop is written as cancelled, and a
notification names the step it stopped at: that step reads **Stopped**, neither
failed nor completed, with what the stop left, and no later step starts. A run
stopped by an error before it returns leaves no entry. The tab shows for each
run:

- Its status, trigger, start time -- in your language and time zone -- and duration
- How many steps ran, and how many of them failed
- Each step, with its status, how long it took, and what it did, why it failed or what its stop left: the records a Backup took, the counts a Compare found, what a Pre-Check read, the records a Sync wrote, and how an Approval was answered, where and when

The runs `sandforge pipeline` made on this machine are listed among them, marked **Command line**, read from the history it keeps beside its lock (its 50 most recent runs); a run with `--dry-run` keeps none, and a run in CI shows on the CI's side alone.

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

### Saved Pipelines

- The header names the pipeline: type there to rename it. **New pipeline** starts another, under a name no saved pipeline has ("New pipeline 2"), **Open…** lists the saved ones, and a blank name refuses Save and Run with the reason
- **New pipeline**, **Open…**, a template's **Install** and **Generate with AI** ask first when they would replace a pipeline with unsaved changes, which the header marks. Going to another page of the panel keeps those changes; closing the VS Code tab loses them, as a panel cannot refuse to close
- **Delete**, on a saved pipeline's row, asks first: its schedules and sandbox refresh triggers no longer start it, the confirmations of its Rewind steps are taken back, and its runs stay in the history. A pipeline a run holds is refused until the run ends
- Save a pipeline, and quick-load it back from the saved pipelines list
- The version badge on each entry always reads `v1`: the builder stamps
  `version: 1` and a save overwrites the pipeline under its own id. No earlier
  revision is kept, so there is nothing to compare or roll back to.

## Tips

- Start with a Backup and a Compare between two sandboxes to learn the canvas and the history
- Give a saved pipeline a Schedule trigger to take a backup every night while VS Code is open; a night VS Code is closed shows in the history as missed. For the nights VS Code is closed, **Export…** it with a launcher and hand it its schedule
- **Simulate** a pipeline before its first real run, and `sandforge pipeline plan` a file on the machine that will run it
- Put a Pre-Check first to stop a run when an org's API usage or storage is critical
- Use the AI Pipeline Generator to sketch a workflow from a natural language description; its steps are marked when they cannot run
- Browse the **Templates** tab for a template that matches your use case before building from scratch
- Read Execution History for each run's status and for what each of its steps did
- Put an Approval step before a Sync into a production org, and after a Compare, so the person who approves has the differences in front of them
- A pipeline writes to an org through four steps: a saved Sync configuration, a Seed template, a masking template, and a confirmed Rewind. Restoring and deleting run from their own pages
- After a sandbox refresh, a Sandbox Refresh trigger on an Anonymize step then a Seed step masks the copy of production's data and seeds test records; without a condition, the Anonymize step masks every row of the template's objects, in a sandbox others share too
