# Back into service

A sandbox refresh copies production into the sandbox again: what the testers made there is gone, the users are production's, their addresses under `.invalid`, and what is scheduled or points elsewhere is production's too. The page **Back into service**, titled **Bring \<alias\> back into service**, lists the ten steps that bring the sandbox back into use, in the order `sandforge env apply` takes them, each with where it stands: to do, done, skipped, does not apply, or refused with why. A status is read from what SandForge keeps — the users runs, the checkpoints and their replays, the masking runs, the inventories of the scheduled jobs —, never ticked by hand; only **Skip**, and **Mark as done** on the deliverability and the endpoints, which a person checks in Setup, are kept. A production org is refused before anything of it is read.

**Not yet proven on a refreshed sandbox.** The steps have run on scratch orgs, not yet on a sandbox just refreshed: that a refresh puts each address under `.invalid`, that the sandbox is reached on its My Domain host, and what a refresh leaves of the scheduled jobs and the deliverability rest on what the code reads and what Salesforce documents ([After a sandbox refresh](../environments.md#after-a-sandbox-refresh)). The page says so above its steps.

<!-- how-to:start: written by scripts/sync-module-howto.mjs from howTo.recovery in packages/webview/src/i18n/locales/en.json -->

## How to

1. Pick the refreshed sandbox in the org picker: the page reads where its recovery stands.
2. Choose the users to bring back, simulate, then apply: each address awaits its owner's click.
3. Mask production's data, replay the checkpoint of before, then take Testers' start.
4. Read the deliverability, the scheduled jobs and the endpoints, and check them in Setup.
5. Write the handoff note, then keep what the next refresh starts from.

**Tip:** Take a checkpoint named Before refresh before each refresh: the next recovery replays it.

<!-- how-to:end -->

## When it opens

A refreshed sandbox is a new org under the same username, with another Organization Id. SandForge notices the refresh three ways, and the first step says which:

- **When it connects to the sandbox**: the Organization Id the sandbox answers with is not the one it answered with last.
- **By the Monitor**, which reads the sandbox's `Organization` row when its dashboard opens or refreshes.
- **By production's refresh history**: the Monitor of the production org reads its `SandboxProcess` rows, and a refresh it shows completing is recorded on the registered sandbox it names ([Sandbox Refreshes](monitor.md#sandbox-refreshes)).

From then on, the way to the page is offered where you look:

- the launcher's hero, **Bring \<alias\> back into service**, with when it was refreshed and how many of its steps are done, and the first tile of **Home**, with the step it is at, until every step is done or skipped, or the recovery is finished; the selected sandbox comes first, else the one refreshed last;
- **Back into service** in the launcher's **Protect and restore** group, listed once a sandbox is registered;
- on **Monitor**, open on the sandbox, **Bring back into service…** beside the newest refresh noticed, and in the band at the top of the dashboard while that refresh is less than 7 days old and the recovery is not finished;
- the warning VS Code shows when it notices the refresh, by its **Bring back into service** button;
- the card of the sandbox on **Organizations**, by **Bring back into service**;
- on **Help**, the section **After a sandbox refresh**, by **Open Back into service**, the second on the page after **Getting Started**;
- **SandForge: Back into service** in the VS Code command palette.

The page works on the org selected in the org picker: the launcher, Home, the warning and the card select the sandbox first. With no refresh noticed, it opens on a sandbox, a scratch org or a Developer Edition org all the same: the first step says SandForge noticed no refresh, the others stay usable, and **Before the next refresh** comes first. With no org connected, it offers **Connect an org**.

## What it never does

- **Production.** For a production org, the page says it brings back only a sandbox, a scratch org or a Developer Edition org, and the extension refuses one before it reads anything of it: by SandForge's list of orgs first — a production org is not even asked who is connected —, then by what the org says it is, read live. Both must say a sandbox, a scratch org or a Developer Edition org. Production Guard asks before the users are written, as before any update, but it is never what stops a production org here: its answer would let the write through.
- **Passwords.** SandForge resets none. Once a tester has confirmed the address asked back, **Forgot your password?** on the sandbox's login page sends one.
- **An address called restored.** An address asked back is _awaiting confirmation_ until its owner clicks the link Salesforce sends; the page never calls it restored.
- **An acceptance kept.** The emails to people and the automation a run sets off are accepted for that run only: the next run asks again.
- **What the audits find.** The deliverability, the scheduled jobs and the endpoints are read, never changed: Setup, `sf` or your deployment puts them right.
- **A step ticked for you.** A step is done when what it runs has run on the org the sandbox is now, or when you mark one of the two checks done.

## The steps

1. **Refresh noticed**: done as soon as the refresh is noticed, with when and how, the org it was before and the one it is now, the instance it moved to when it moved, and that SandForge forgot what it had cached of the org before. With no refresh noticed, it does not apply. It is never skipped.
2. **Users**: **Choose the users** opens the users of the sandbox to bring back ([The users](#the-users)). Done once a run of the users ended a success on the org the sandbox is now; it is to do again once `sandforge users remove` takes that run back. It does not apply when no user of the sandbox has an address under `.invalid`, nor is frozen or inactive.
3. **Mask the data copied from production**: **Open Masking** opens DataOps on Masking, the sandbox as its target, the objects of the sandbox's last masking picked — else those of the last masking on this machine —, on the template that masks them. Done once a masking of the sandbox ran a success after the refresh. It does not apply to a Developer or Developer Pro sandbox, a scratch org or a Developer Edition org: none of production's data was copied.
4. **Replay the checkpoint of before**: **Open the replay** opens, on Checkpoints, the replay of the newest checkpoint taken of the sandbox before the refresh, into the sandbox: a simulation first, then the replay ([Replay into a sandbox marked Staging](#replay-into-a-sandbox-marked-staging)). Done once a replay of a checkpoint of the org before wrote into the org the sandbox is now. It does not apply when no checkpoint was taken before the refresh: **Before the next refresh** takes one.
5. **Reload the frozen dataset**: **Open the load** opens Frozen Dataset on Load, the sandbox as its target, with the day the dataset was frozen and how many objects and records it holds. Done once a load into the sandbox ran a success after the refresh. It does not apply when no frozen dataset is kept on this machine. On a sandbox marked Staging the step is refused, since the mark refuses the load: replay a checkpoint instead, or skip the step.
6. **Testers' start checkpoint**: **Take Testers' start…** opens a checkpoint take named Testers' start, kept until deleted: the state the testers start from, which the sandbox can be rewound to. Done once a checkpoint of the org the sandbox is now has been taken.
7. **Email deliverability**: **Read** says whether the sandbox delivers every email (Setup > Deliverability: All email), so that what runs there reaches real people, or system email at most; then **Open Setup** opens its page. **Mark as done** once checked there.
8. **Scheduled jobs**: **Read** compares the jobs scheduled now with the inventory kept before the refresh, filed by the sandbox's My Domain host, which a refresh keeps: each job gone since the inventory, new since, run as a frozen user, run as an inactive user, or as before. The jobs read are kept as the inventory of the next refresh, and the step is then done. Then **Open Setup** opens Scheduled Jobs. With no inventory of before, it does not apply, and **Keep the inventory for the next refresh** keeps one now.
9. **Endpoints that still name production**: **Read** lists the Named Credentials and Remote Sites whose URL names a production host — those deduced from the sandbox's My Domain host, and `login.salesforce.com` —, each with **Open Setup** on its page. When production's hosts cannot be deduced from the sandbox's host, `login.salesforce.com` alone is looked for, and the step says so. **Mark as done** once they are changed. The fields of Custom Metadata or Custom Settings, and the production hosts a file lists, are read by `sandforge env audit` ([Audits and the handoff note](../environments.md#audits-and-the-handoff-note)).
10. **Handoff note**: **Write the note** writes it and opens it in the editor ([The handoff note](#the-handoff-note)). Done once a note of the org the sandbox is now is written. **Open the note** opens the newest again as it was left, and **Write it again and open it** writes it anew.

**Skip** sets a step aside, every step but the first; **Undo** takes a skip or a mark back. A step skipped and then run is done. The count, n of N, takes in the steps that apply, and counts those done or skipped. A skip and a mark are kept for this refresh alone: after the next one, every step starts again.

## The users

**Choose the users** reads the users of the sandbox that a refresh leaves to bring back: those whose address is under `.invalid`, those frozen, and those inactive, a box each, the active ones first. Only people who sign in are listed — not the automated process, a site's guest or a Chatter Free user —, and never the user SandForge is connected as, whom a run would lock out. An address is read only to tell whether it is under `.invalid`: the page shows none. The list holds 200 users at most, and says how many it left out: a `users.json` names the others.

- **Simulate** plans a run of the users chosen, nothing written: for each user, what would change — the address asked back, activated or unfrozen —, the licenses it takes, and the API requests it costs. Their profile, permission sets and groups stay as copied, unless a `users.json` you import says otherwise.
- **Apply** waits for a simulation of the users chosen as they are now, and a simulation is used by one run alone. Before it writes, the extension reads the plan again and refuses the run when the sandbox changed since. Under the simulation, it asks, for this run only, what the run needs: to let Salesforce email each person whose address is asked back the link that confirms it; when the sandbox delivers every email and an address would be asked back before the masking is done, that what runs there may email these people; and, when the sandbox runs automation as a user is written, to write all the same, each flow, Apex trigger, Process Builder process or workflow rule that would fire listed under the question. The run says user by user how far it is, and **Stop the run** stops it.
- **Awaiting confirmation**: an address asked back stays under `.invalid` until its owner clicks the link Salesforce sent; the run's result and the list say _awaiting confirmation_.
- **The list for the next refresh**: **Save the list for the next refresh** keeps the users chosen for the sandbox, filed by its My Domain host, which a refresh keeps: the next recovery opens with them chosen. **Export users.json** writes them in the format `sandforge users --config` reads, for a terminal or a CI job; **Import users.json** reads one, its users chosen and set up as it says, profiles, permission sets, groups and queues included.

A run sets up 200 users at most. Its runs are kept where the command line keeps them, `~/.sandforge/users/`: `sandforge users remove --org <alias> --run <n>` takes one back, and the step is to do again: the page says the next run replaces one its removal took back, and sets the users up from what the sandbox holds now, and the handoff note names it taken back beside how it ended.

## Replay into a sandbox marked Staging

A sandbox you marked **Staging** in its **Edit** dialog on Organizations may hold real data. Its replay of the checkpoint of before is allowed all the same: the step says so, and **Replay** asks you to type the sandbox's name under the simulation before it writes, as a rewind does; without it, the extension refuses the replay before it reads anything of the org. Masking is that of any replay: a checkpoint of a Partial Copy, a Full or a Staging sandbox goes into another org masked, but into that very sandbox refreshed, which held the same data ([Replay in another org](checkpoint.md#replay-in-another-org)). A Frozen Dataset load into a sandbox marked Staging stays refused.

## Before the next refresh

What the next recovery starts from, kept now, each with whether it is kept already:

- **Take Before refresh…**: a checkpoint named Before refresh, kept until deleted, which the next recovery replays.
- **Keep the inventory**: the inventory of the scheduled jobs, which the next recovery compares the jobs with.
- **Choose the users**: the list of the testers, saved for the sandbox.
- **Automate after each refresh…**: opens Automation on its Sandbox Refresh Post-Processing template, a pipeline that runs after each refresh of the sandbox; nothing is installed before you click **Install** there.

With no refresh noticed, this section comes first.

## The handoff note

The note is written in Markdown, in English, for whoever takes the sandbox from there: the sandbox and its refresh, each step with its status and when, the checkpoint the testers start from, what is left to do in the order a refresh guide gives it — credentials and technical components, scheduled jobs, automations that send email, deliverability —, and what SandForge never touches, passwords among them. It names steps, checkpoints, runs, jobs and hosts; never a record's value, never an address.

It is kept in `~/.sandforge/handoff/_recovery/`, or `handoff/_recovery/` in the folder `SANDFORGE_JOURNAL_DIR` names, one file per note, named by when it was written and the sandbox's Organization Id, readable by you alone. The page says where it wrote it, and **Open the note** opens it in the editor again. `sandforge env apply` writes its own notes beside it, in `handoff/<name>/`: neither writes over the other.

## Finish and Resume

**Finish**, under the steps of a refreshed sandbox, ends the recovery once the sandbox is back in use: the launcher and Home no longer lead with it. The page opened again says when it was finished, and **Resume** puts it back at their head.

## From a terminal

The page and the command lines share what they keep on this machine: a run of `sandforge users`, a replay by `sandforge checkpoint replay`, a checkpoint taken by `sandforge checkpoint` and an inventory kept by `sandforge env audit --save` count for the steps of the page. A masking and a Frozen Dataset load count when they ran in the editor.

| Step                                      | From a terminal                                                                                                                                                                                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Users                                     | `sandforge users plan`, then `sandforge users apply`, with `--org <alias> --config users.json`; `sandforge users remove --org <alias> --run <n>` takes a run back; or a [users resource](../environments.md#a-users-resource) of `sandforge env apply` |
| Masking                                   | a [mask resource](../environments.md#a-mask-resource) of `sandforge env apply`                                                                                                                                                                         |
| Replay of the checkpoint of before        | `sandforge checkpoint replay`, or a [replay resource](../environments.md#a-replay-resource) of `sandforge env apply`                                                                                                                                   |
| Testers' start                            | `sandforge checkpoint take`, or `checkpoint.after` of the file `sandforge env apply` applies                                                                                                                                                           |
| Deliverability, scheduled jobs, endpoints | `sandforge env audit`, with `--save` to keep the inventory of the jobs                                                                                                                                                                                 |
| Handoff note                              | `audits: { handoff: true }` of the file `sandforge env apply` applies                                                                                                                                                                                  |

One `sandforge.yaml`, applied after each refresh, runs them in this order in one command: [After a sandbox refresh](../environments.md#after-a-sandbox-refresh).
