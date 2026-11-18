# Back into service

After a sandbox refresh, the page **SandForge: Back into service** lists the steps that bring the sandbox back into use, in the order `sandforge env apply` takes them, each with where it stands: to do, done, skipped, does not apply, or refused with why. A status is read from what SandForge keeps — the users runs, the checkpoints and their replays, the masking runs, the inventories of the scheduled jobs —, never ticked by hand; only Skip, and Mark as done on the deliverability and the endpoints, which a person checks in Setup, are kept. A production org is refused before anything of it is read.

**Not yet proven on a refreshed sandbox.** The steps have run on scratch orgs, not yet on a sandbox just refreshed: that a refresh puts each address under `.invalid`, that the sandbox is reached on its My Domain host, and what a refresh leaves of the scheduled jobs and the deliverability rest on what the code reads and what Salesforce documents ([After a sandbox refresh](../environments.md#after-a-sandbox-refresh)).

<!-- how-to:start: written by scripts/sync-module-howto.mjs from howTo.recovery in packages/webview/src/i18n/locales/en.json -->

## How to

1. Pick the refreshed sandbox in the org picker: the page reads where its recovery stands.
2. Choose the users to bring back, simulate, then apply: each address awaits its owner's click.
3. Mask production's data, replay the checkpoint of before, then take Testers' start.
4. Read the deliverability, the scheduled jobs and the endpoints, and check them in Setup.
5. Write the handoff note, then keep what the next refresh starts from.

**Tip:** Take a checkpoint named Before refresh before each refresh: the next recovery replays it.

<!-- how-to:end -->

## The steps

1. **Refresh noticed**: when and how, the org before and after.
2. **Users**: the users under `.invalid`, frozen or inactive, a box each. Simulate, then Apply, which waits for a simulation of the same list and asks at each run to let Salesforce email the people whose address is asked back, and to write although the sandbox runs automation on users, each flow, trigger, process or workflow rule that would fire listed under the question. An address asked back awaits its owner's confirmation. The list is saved for the next refresh, exported as `users.json` for `sandforge users --config`, or imported from one.
3. **Mask the data copied from production**: opens Masking in DataOps, the objects of the sandbox's last masking picked — else those of the last masking on this machine —, on the template that masks them.
4. **Replay the checkpoint of before**: opens the replay of the newest checkpoint taken before the refresh. On a sandbox marked Staging, the replay asks for the org's name typed.
5. **Reload the frozen dataset**: opens Frozen Dataset on Load, the sandbox as its target.
6. **Testers' start checkpoint**: opens a take named Testers' start, kept until deleted.
7. **Email deliverability**: Read, then its Setup page; marked done once checked there.
8. **Scheduled jobs**: Read, compared with the inventory kept before the refresh, then their Setup page.
9. **Endpoints that still name production**: Read, each with its Setup page; marked done once changed.
10. **Handoff note**: written as Markdown and opened in the editor. Once written, Open opens it again as it was left, and Write it again and open it writes it anew.

**Before the next refresh**: a checkpoint named Before refresh, the inventory of the scheduled jobs, the list of the testers, and a pipeline from the Sandbox Refresh Post-Processing template.

**Finish**: once the sandbox is back in use, the launcher and Home no longer lead with it. The page opened again says when it was finished, and Resume puts it back at their head.
