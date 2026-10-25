# Environments as code: `sandforge.yaml`

A `sandforge.yaml` committed with your project says what records an environment needs: so many accounts, so many contacts under each. `sandforge-env`, one of the [command-line scripts](../ci-examples/README.md), applies it to an org: `plan` says what it would create, keep, replace and take back, `apply` does it, `destroy` takes it back into the recycle bin, and between them a **state** on your machine says what was applied to which org. Applied again, it writes nothing; changed, it replaces what changed.

It writes nothing to an org itself. Each resource of the file is applied by `sandforge-seed`, run in a process of its own with `--json`, and taken back by the seed's own removal: every guard, gate and run file of the seed holds unchanged, and what `sandforge-env` adds is what no run knows -- the file, the order, the state, and refusals of its own.

This version applies **seed resources** alone: records Seed generates, from a built-in template or from objects, counts, field rules and relations of the file's own. [Not yet](#not-yet) says what it does not do.

## Run it

From the root of a checkout of this repository, once `pnpm install` and `pnpm build:shared` have run, with each org logged in to the Salesforce CLI (`sf`), which holds its credentials:

```bash
alias sandforge-env='pnpm exec tsx packages/extension/cli/sandforge-env.ts'
```

The script runs from the checkout, so `--file` names your project's file; without it, `sandforge.yaml` of the folder it runs in is read. The sessions below run from `/home/dev/sandforge`, a checkout beside the project `/home/dev/case-flow`, against `pool-1`, a scratch org. Each script it runs says its own lines too, on stderr, as they come -- its dry run, what the org runs as records go in, the run file it keeps --: they are left out here, and what is shown is what `sandforge-env` itself says. With `--json`, the answer alone goes to stdout and every other line to stderr.

## The file

- **YAML 1.2, read strictly.** JSON is YAML, so a `.json` file named with `--file` reads too. A key the file does not take is refused with the keys it does; so are a key given twice in one mapping, a tag YAML 1.2 does not know, a second document in the file, and more than 100 aliases.
- **`version: 1`** at the top. A file written for a later SandForge is refused.
- **No secret.** A key shaped like a secret -- `password`, `token`, `secret`, `authUrl`, `privateKey`, `apiKey`, `salt`, and their spellings -- is refused wherever it stands: org credentials stay with the `sf` CLI. A value comes from the process environment only where the file writes `{ env: NAME }`, and that is the alias of an org role alone.
- **The org to fill is never in the file.** `--org` names it, on every command that reaches an org, so one file fills `pool-1`, `pool-2` and your own scratch org alike.
- **Two checks.** The file is held to its own schema, then each resource is turned into a Seed template and held to Seed's own schema and rules, as the Seed panel's are: what `validate` accepts is what the seed is given.

### An example

```yaml
# sandforge.yaml: the data the case-flow end-to-end tests need
version: 1
name: case-flow
description: Three accounts, two contacts under each

targets:
  kinds: [scratch, developer] # the default; a sandbox is listed by its Organization Id

resources:
  accounts:
    kind: seed
    seed: 11 # the draws: the same records each time
    objects:
      - object: Account
        count: 3
        fields:
          - { fieldApiName: Name, ruleType: static, config: { staticValue: CI account } }

  contacts:
    kind: seed
    seed: 12
    dependsOn: [accounts] # applied after accounts, destroyed before it
    objects:
      - object: Contact
        count: 6
        fields:
          - { fieldApiName: LastName, ruleType: static, config: { staticValue: CI contact } }
    relations:
      - lookup: Contact.AccountId
        parents: { object: Account, existing: { where: "Name = 'CI account'", limit: 3 } }
        distribution: { mode: perParent, count: 2 }
```

Two resources, applied in order: `accounts` writes three accounts, then `contacts` writes six contacts, two under each account the org holds named `CI account` -- the ones `accounts` wrote. `dependsOn` gives the order, and a `where` on existing parents is how one resource hangs its records from another's. `seed` keeps the draws: the same file writes the same records again.

### Every key

| Where                                       | Keys                                                                                | What they hold                                                                                                                                                                                                                                                 |
| ------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the file                                    | `version`, `name`, `description`, `targets`, `orgs`, `checkpoint`, `resources`      | `version: 1`; `name`, lower-case letters, digits and dashes, which names the state; `resources`, by name                                                                                                                                                       |
| `targets`                                   | `kinds`, `sandboxes`, `protect`                                                     | the kinds of org it may be applied to, `scratch` and `developer` unless it says otherwise; the Organization Ids of the sandboxes it may write to, with `sandbox` among the kinds; the Organization Ids it refuses whatever else says                           |
| `orgs.<role>`                               | `alias`                                                                             | an sf CLI alias, or `{ env: NAME }`, the variable that holds one; `--alias <role>=<alias>` wins over it; an unset variable refuses every command but `validate`, exit `2`. No seed resource names a role                                                       |
| `checkpoint`                                | `before`, `after`, `ignoreFields`                                                   | read and checked, [not yet](#not-yet) taken                                                                                                                                                                                                                    |
| `resources.<name>`                          | `kind`, `dependsOn`, `accept`, `template`, `objects`, `relations`, `locale`, `seed` | `kind: seed`; the resources applied before it; `template`, the id of one of Seed's built-in templates, or `objects` and `relations` of its own, not both; `locale`, the country names and addresses are drawn for, the org's own without it; `seed`, the draws |
| `resources.<name>.accept`                   | `automation`                                                                        | `true`: the `--accept-automation` of the line, for this resource, reviewed in the file                                                                                                                                                                         |
| `resources.<name>.objects[]`                | `object`, `count`, `fields`, `recordTypes`, `batchSize`                             | an object, listed once; how many records; Seed's field rules, as the Seed panel saves them ([Generated values](modules/seed.md#generated-values)); record types by API name, several taking turns at random                                                    |
| `resources.<name>.relations[]`              | `lookup`, `parents`, `distribution`                                                 | a lookup named with its object, as `Contact.AccountId`; where its parents come from; how many children each one gets                                                                                                                                           |
| `resources.<name>.relations[].parents`      | `object`, `existing`                                                                | the parent object: the records this resource writes of it, or, with `existing`, records the org holds                                                                                                                                                          |
| `….parents.existing`                        | `where`, `limit`                                                                    | a SOQL condition, without `WHERE`; how many parents at most                                                                                                                                                                                                    |
| `resources.<name>.relations[].distribution` | `mode`, `count`, `min`, `max`, `ratio`                                              | `perParent` with `count`, `range` with `min` and `max`, or `ratio` with `ratio`                                                                                                                                                                                |

A built-in template is one of `prebuilt-crm-starter`, `prebuilt-leads-activities-starter`, `prebuilt-minimal-demo`, `prebuilt-service-cloud-starter` and `prebuilt-sales-cloud-starter`, the templates of Seed's gallery. Its content, not its id, is what the state compares: a SandForge whose template changed replaces what the old one wrote.

## A walk through

### Check the file: `validate`

<!-- replay: scratch -->

```console
$ sandforge-env validate --file ../case-flow/sandforge.yaml
/home/dev/case-flow/sandforge.yaml: valid, the environment case-flow
  accounts: Account 3
  contacts: Contact 6, after accounts
```

It reaches no org, and needs no `--org`. It names the order the resources are applied in and the variables the file reads, set or not in this shell. A file it refuses exits `2`, each issue where the file wrote it -- here with the field rule of `accounts` taken out:

<!-- replay: then; the accounts lose their field rule -->

```console
$ sandforge-env validate --file ../case-flow/sandforge.yaml
/home/dev/case-flow/sandforge.yaml does not validate:
  resources.accounts.objects[0]: Account asks for 3 record(s) and names no field to fill: add at least one field rule
$ echo $?
2
```

### See what it would do: `plan`

<!-- replay: then; the file as above -->

```console
$ sandforge-env plan --file ../case-flow/sandforge.yaml --org pool-1
accounts: dry run
contacts: dry run
plan of case-flow on pool-1 (scratch, 00Dxx0000001gPLEAY)
state: none on this machine
  create   accounts  Account 3 to write
           not applied to this org yet
  create   contacts  Contact at most 6 to write
           not applied to this org yet; its dry run read the org before accounts writes: what it draws from those records is counted at most as the file gives it
totals: 2 to create, 0 to replace, 0 to delete, 0 kept, 0 drifted, 0 blocked
API requests: about 2, 14000 left; not counted: what contacts draws from the records accounts writes first
data storage: about 0.02 MB, 5 MB left
warning: this machine keeps no state of case-flow on pool-1: records an earlier apply left there, from another machine or a cache that was not restored, cannot be told from the org’s own, and would be created twice
```

It writes nothing, to the org or to the state. Each resource to write is dry-run by the seed; each one applied before is read back from the org by the seed's removal preview, which deletes nothing. Per resource, one action:

| Action    | When                                                                                                                                               | What `apply` does                                             |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `create`  | not applied to this org yet                                                                                                                        | runs it                                                       |
| `keep`    | applied, unchanged in the file since, and the org holds its records as written                                                                     | nothing                                                       |
| `drifted` | applied, unchanged in the file since, and records of it are gone, changed since by someone, or could not be read                                   | nothing, unless `--replace <resource>` or `--replace-drifted` |
| `replace` | what it writes changed in the file; a resource it depends on runs again; its last run was stopped part way, partial or failed; or `--replace` asks | takes its runs back, then runs it again                       |
| `delete`  | applied, and gone from the file                                                                                                                    | takes its runs back                                           |
| `blocked` | its dry run, its removal's preview, a summed gate or what this SandForge does not do refuses it                                                    | nothing: the whole apply refuses before its first write       |

The totals follow, then what the resources take of the org's day: the API requests, the data storage and the emails each dry run counted, added up against what the org has left. Each run of the seed holds itself to what the org has left; together, three that each fit can overrun it, so the plan blocks every write when a sum goes past it. `contacts` is read before `accounts` writes, so its dry run finds no parent: what it draws from them is counted at most as the file gives it, and the plan says so. `--quick` skips the dry runs and the removal previews: no counts, and no word on what the org holds.

### Apply it: `apply`

<!-- replay: then -->

```console
$ sandforge-env apply --file ../case-flow/sandforge.yaml --org pool-1 --yes
accounts: dry run
contacts: dry run
plan of case-flow on pool-1 (scratch, 00Dxx0000001gPLEAY)
state: none on this machine
  create   accounts  Account 3 to write
           not applied to this org yet
  create   contacts  Contact at most 6 to write
           not applied to this org yet; its dry run read the org before accounts writes: what it draws from those records is counted at most as the file gives it
totals: 2 to create, 0 to replace, 0 to delete, 0 kept, 0 drifted, 0 blocked
API requests: about 2, 14000 left; not counted: what contacts draws from the records accounts writes first
data storage: about 0.02 MB, 5 MB left
warning: this machine keeps no state of case-flow on pool-1: records an earlier apply left there, from another machine or a cache that was not restored, cannot be told from the org’s own, and would be created twice
accounts: run 1 (create)
contacts: run 1 (create)

  accounts run 1: exit 0, applied  Account 3 created
  contacts run 1: exit 0, applied  Contact 6 created
apply: success; state serial 4
```

It plans first, then, on a terminal, asks for the org's alias to be typed -- `Type pool-1 to apply case-flow to it as planned:` --; with no terminal and no `--yes`, as in a CI step, it stops at the question, exit `2`, having written nothing. Before each run starts, the state names it; once it ends, the state says how. Applied again, it writes nothing:

<!-- replay: then -->

```console
$ sandforge-env apply --file ../case-flow/sandforge.yaml --org pool-1 --yes
contacts: reading what the org holds of run 1
accounts: reading what the org holds of run 1
plan of case-flow on pool-1 (scratch, 00Dxx0000001gPLEAY)
state: kept on this machine, serial 4
  keep     accounts  Account 3 in the org
           applied, and the org holds its 3 record(s) as written
  keep     contacts  Contact 6 in the org
           applied, and the org holds its 6 record(s) as written
totals: 0 to create, 0 to replace, 0 to delete, 2 kept, 0 drifted, 0 blocked
API requests: about 0, 14000 left
data storage: about 0 MB, 5 MB left
nothing to do: the org holds the environment as the file describes it

apply: success; state serial 4
$ echo $?
0
```

### What the machine keeps: `state`

<!-- replay: then -->

```console
$ sandforge-env state
case-flow on pool-1 (scratch, 00Dxx0000001gPLEAY): serial 4, written 2026-10-25T09:03:00.000Z, expires 2026-11-24T09:03:00.000Z; accounts applied, contacts applied
```

It reaches no org. `--org` keeps the states of one org, by its alias or its Organization Id, `--file` those of one file. A scratch org's state is deleted 30 days after its last write, as the scratch org is by then.

### When the org moved: `plan --fail-on-drift`

A test deletes one of the contacts:

<!-- replay: then; a contact deleted -->

```console
$ sandforge-env plan --file ../case-flow/sandforge.yaml --org pool-1 --fail-on-drift
contacts: reading what the org holds of run 1
accounts: reading what the org holds of run 1
plan of case-flow on pool-1 (scratch, 00Dxx0000001gPLEAY)
state: kept on this machine, serial 4
  keep     accounts  Account 3 in the org
           applied, and the org holds its 3 record(s) as written
  drifted  contacts  Contact 5 in the org, 1 gone
           its records changed since it was applied: Contact 1 gone. Left as they are: --replace contacts or --replace-drifted replaces it
totals: 0 to create, 0 to replace, 0 to delete, 1 kept, 1 drifted, 0 blocked
API requests: about 0, 14000 left
data storage: about 0 MB, 5 MB left
$ echo $?
3
```

`--fail-on-drift` exits `3` when the org no longer holds the environment as applied: a record deleted or changed since. `--fail-on-change` exits `3` when `apply` would write or delete anything. Without them, a plan exits `0` whatever it found.

### When the file moved

`accounts` now asks for four accounts:

<!-- replay: then; accounts asks for four -->

```console
$ sandforge-env apply --file ../case-flow/sandforge.yaml --org pool-1 --yes
contacts: reading what the org holds of run 1
accounts: reading what the org holds of run 1
accounts: dry run
contacts: dry run
plan of case-flow on pool-1 (scratch, 00Dxx0000001gPLEAY)
state: kept on this machine, serial 4
  replace  accounts  Account 4 to write, 3 in the org
           replaced: what it writes changed in the file since it was applied
  replace  contacts  Contact at most 6 to write, 5 in the org, 1 gone
           replaced: the resources it depends on run again, with new records: accounts; its dry run read the org before accounts writes: what it draws from those records is counted at most as the file gives it
totals: 0 to create, 2 to replace, 0 to delete, 0 kept, 0 drifted, 0 blocked
API requests: about 2, 14000 left; not counted: the removal of the runs of accounts, the removal of the runs of contacts, what contacts draws from the records accounts writes first
data storage: about 0.02 MB, 5 MB left
contacts: taking back run 1
accounts: taking back run 1
accounts: run 2 (replace)
contacts: run 2 (replace)

  contacts removal of run 1: exit 0, destroyed  Contact 5 deleted
  accounts removal of run 1: exit 0, destroyed  Account 3 deleted
  accounts run 2: exit 0, applied  Account 4 created
  contacts run 2: exit 0, applied  Contact 6 created
apply: success; state serial 14
```

`contacts` did not change in the file, but its parents are replaced, with new Ids: it is replaced too. What is taken back goes first, the last applied first -- `contacts`, then `accounts` --, then what is written, each resource after what it depends on. Taken back the other way, the removal would keep every account the contacts still hang from.

### Take it back: `destroy`

Someone edits one of the accounts:

<!-- replay: then; an account changed -->

```console
$ sandforge-env destroy --file ../case-flow/sandforge.yaml --org pool-1 --yes
contacts: reading what the org holds of run 2
accounts: reading what the org holds of run 2
plan of case-flow on pool-1 (scratch, 00Dxx0000001gPLEAY)
state: kept on this machine, serial 14
  delete   contacts  Contact 6 in the org
           taken back by destroy, into the recycle bin
  delete   accounts  Account 4 in the org, 1 changed
           taken back by destroy, into the recycle bin
totals: 0 to create, 0 to replace, 2 to delete, 0 kept, 0 drifted, 0 blocked
API requests: about 0; not counted: the removal of the runs of contacts, the removal of the runs of accounts
data storage: about 0 MB
contacts: taking back run 2
accounts: taking back run 2

  contacts removal of run 2: exit 0, destroyed  Contact 6 deleted
  accounts removal of run 2: exit 3, partial  Account 3 deleted, 1 kept
      Account: 1 changed since the run, kept
destroy: partial; state serial 19
$ echo $?
3
```

The account changed since is kept, the destroy exits `3`, and the state stays with what is left, for the next destroy. `--include-changed` takes it too:

<!-- replay: then -->

```console
$ sandforge-env destroy --file ../case-flow/sandforge.yaml --org pool-1 --yes --include-changed
accounts: reading what the org holds of run 2
plan of case-flow on pool-1 (scratch, 00Dxx0000001gPLEAY)
state: kept on this machine, serial 19
  delete   accounts  Account 1 in the org, 1 changed
           taken back by destroy, into the recycle bin
totals: 0 to create, 0 to replace, 1 to delete, 0 kept, 0 drifted, 0 blocked
API requests: about 0; not counted: the removal of the runs of accounts
data storage: about 0 MB
accounts: taking back run 2
every record of case-flow is taken back from pool-1: the state keeps it as destroyed, and the next apply creates it again

  accounts removal of run 2: exit 0, destroyed  Account 1 deleted
destroy: success; state serial 22
$ echo $?
0
$ sandforge-env state
case-flow on pool-1 (scratch, 00Dxx0000001gPLEAY): serial 22, written 2026-10-25T09:12:00.000Z, expires 2026-11-24T09:12:00.000Z; accounts destroyed, contacts destroyed
```

On a terminal, `destroy` asks for the alias too, and with `--include-changed` its question says what it takes: `Type pool-1 to take case-flow back from it, the records changed since included — on a shared org, others’ work:`. [What destroy leaves](#what-destroy-takes-back-and-what-it-leaves) has the rest.

## The commands

| Command    | What it does                                                                                      | Flags                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `validate` | checks the file offline: its schema, each resource against Seed's rules, the order, the variables | `--file`, `--json`                                                                                                            |
| `plan`     | says what `apply` would do, writing nothing                                                       | `--file`, `--org`, `--alias`, `--json`, `--fail-on-change`, `--fail-on-drift`, `--quick`, `--replace`, `--replace-drifted`    |
| `apply`    | does what the plan says, once the alias is typed or `--yes` given                                 | `--file`, `--org`, `--alias`, `--json`, `--replace`, `--replace-drifted`, `--accept-automation`, `--accept-no-state`, `--yes` |
| `destroy`  | takes back what `apply` created, the last resource first, into the recycle bin                    | `--file`, `--org`, `--alias`, `--json`, `--include-changed`, `--sweep`, `--accept-automation`, `--yes`                        |
| `state`    | lists the states kept on this machine, or those of one org or one file; reaches no org            | `--org`, `--file`, `--json`                                                                                                   |

### Every flag

```text
sandforge-env — apply a sandforge.yaml to an org: the data an environment needs, declared in
your repository, created, kept and taken back, without the editor.

Usage:
  pnpm exec tsx packages/extension/cli/sandforge-env.ts <command> [--file <sandforge.yaml>] --org <alias> [options]

Commands:
  validate  check the file, offline: its schema, each resource against Seed's own rules, the
            order of the resources, the variables it names; reaches no org
  plan      say what apply would do to the org: per resource, create, keep, replace, delete, or why
            it is blocked; what an earlier apply left there and what changed since; per object the
            records it would write; the API requests, storage and emails it takes; writes nothing
  apply     do what plan says, after asking you to type the org's alias; applied again, it writes
            nothing; stopped, run it again and it takes up
  destroy   take back what apply created, the last resource first, into the recycle bin; name what
            it cannot take back
  state     list the environments kept on this machine, or those of one org (--org, an alias or
            an Organization Id); reaches no org

Required:
  --org <alias>              sf CLI alias of the org to fill (validate and state: not needed)

Options:
  --file <path>              the file (default: sandforge.yaml in this folder)
  --alias <role>=<alias>     the alias of a role the file's orgs name; wins over its variable
  --json                     the answer alone on stdout, every other line on stderr
plan:
  --fail-on-change           exit 3 when apply would write or delete anything
  --fail-on-drift            exit 3 when the org no longer holds the environment as applied:
                             records deleted or changed since
  --quick                    skip the dry runs and the removal previews: no counts, and no word
                             on what the org holds
  --replace <resource>, --replace-drifted
                             plan what apply would do with them
apply:
  --replace <resource>       replace a resource kept or drifted; repeat for more
  --replace-drifted          replace every drifted resource
  --accept-automation        take back the runs a replace or a delete takes back although the org
                             runs automation as records go
  --accept-no-state          apply to a Developer Edition or a sandbox this machine has no state
                             of: records an earlier apply left there would be created twice
  --yes                      do not ask; without it and with no terminal, stop at the question,
                             exit 2, having written nothing
destroy:
  --include-changed          take also the records changed since apply, and what was created
                             under them since: on a shared sandbox, a colleague's work
  --sweep                    take also what the org's automation created during each run
  --accept-automation        delete although the org runs automation as records go
  --yes                      as for apply

The file holds no secret: org credentials stay with the sf CLI. A value comes from the environment
only where the file writes { env: NAME }. The org to fill is never in the file. A resource's
accept: { automation: true } is the file's --accept-automation for that resource.

A production org is refused before anything is read, exit 1. No flag lifts it. A sandbox is
written to only when the file lists its Organization Id under targets.sandboxes and allows the
sandbox kind; scratch orgs and Developer Edition orgs need no listing. A scratch org is told
apart by the Dev Hub the sf CLI names for it; one it names none for is taken for a sandbox.

What apply keeps of the org is the state: ids, counts and dates, never a record's values, in
env/<Organization Id>/<name>/ of the folder SANDFORGE_JOURNAL_DIR names (default: ~/.sandforge),
beside the run files of the seeds it ran. That folder must be outside the repository that holds
the file. Keep it between the jobs that apply and destroy, in a cache keyed by the org. A scratch
org's state is deleted 30 days after its last write. Two machines applying to one org at once are
not kept apart: give the jobs one concurrency group.

Exit codes: 0 done (validate: the file is valid; plan: answered; apply: every resource applied
whole, or nothing to do; destroy: every record taken back); 1 refused before it read or wrote — a
production org, a kind of org or a sandbox the file does not allow, a protected org, a state of
another org, no state without --accept-no-state, another apply of the org under way, a removal
refused for automation without --accept-automation, more API requests, storage or emails than
the org has left —, or nothing written; 2 a bad command line, a file that does not validate, a
variable not set, the journal directory inside the file's repository, a question with no
terminal (give --yes); 3 partial (apply: a resource partial, or failed after others wrote;
destroy: records left, each with why; plan with --fail-on-change or --fail-on-drift: changes or
drift found); 4 unstable; 130, 143, 129 Ctrl-C, SIGTERM or SIGHUP stopped it — run it again: it
takes up from the state.
```

## What is refused

Before any record is read, every command that reaches an org types it from its Organization record, and refuses:

**A production org**, and an org that will not say what it is. No flag lifts it:

<!-- replay: production -->

```console
$ sandforge-env plan --file ../case-flow/sandforge.yaml --org prod
prod is a production org (its Organization record says IsSandbox false, edition Enterprise Edition): an environment is applied to scratch orgs, Developer Edition orgs and the sandboxes its file lists. Nothing was read or written. No flag lifts this: an environment is never applied to a production org.
$ echo $?
1
```

**A kind of org the file does not allow.** Scratch orgs and Developer Edition orgs unless `targets.kinds` says otherwise. A scratch org says it is a sandbox, as a sandbox does: only the sf CLI tells them apart, by the Dev Hub `sf org display` names for it. One logged in with an auth URL alone, whose display names none, is taken for a sandbox:

<!-- replay: sandbox -->

```console
$ sandforge-env plan --file ../case-flow/sandforge.yaml --org uat
uat is a sandbox, and the file's targets.kinds allows scratch, developer: add sandbox to targets.kinds to apply it there. Nothing was read or written. If it is a scratch org, the sf CLI did not say so: its display names no Dev Hub for it, as when the org was logged in with an auth URL alone. Log its Dev Hub in on this machine, or list the org as a sandbox.
```

**A sandbox the file does not list by its Organization Id**, under `targets.sandboxes`, with `sandbox` among the kinds. Nothing Salesforce says tells a sandbox holding a client's records from a developer's, so each one is listed, and reviewed with the file; a refresh changes the Id, so a sandbox refreshed is refused until it is listed again:

<!-- replay: sandbox; the file lists another sandbox -->

```console
$ sandforge-env plan --file ../case-flow/sandforge.yaml --org uat
uat is a sandbox, and its Organization Id 00Dxx0000001gPLEAY is not listed under targets.sandboxes: nothing Salesforce says tells a sandbox that holds a client's records from a developer's, so each one the file writes to is listed, reviewed with the file. A refresh changes the Id: a sandbox listed before its refresh is listed again. Nothing was read or written. If it is a scratch org, the sf CLI did not say so: its display names no Dev Hub for it, as when the org was logged in with an auth URL alone.
```

**No state, on a Developer Edition org or a sandbox, without `--accept-no-state`.** Records an earlier apply left there cannot be told from the org's own, and would be created twice; a plan says what an apply would meet, and the apply refuses. On a scratch org, which usually lives as long as the job that fills it, it is a warning, as in the plan above:

<!-- replay: developer -->

```console
$ sandforge-env apply --file ../case-flow/sandforge.yaml --org my-de --yes
accounts: dry run
contacts: dry run
plan of case-flow on my-de (developer, 00Dxx0000001gPLEAY)
state: none on this machine
  create   accounts  Account 3 to write
           not applied to this org yet
  create   contacts  Contact at most 6 to write
           not applied to this org yet; its dry run read the org before accounts writes: what it draws from those records is counted at most as the file gives it
totals: 2 to create, 0 to replace, 0 to delete, 0 kept, 0 drifted, 0 blocked
API requests: about 2, 14000 left; not counted: what contacts draws from the records accounts writes first
data storage: about 0.02 MB, 5 MB left
an apply now would be refused: This machine keeps no state of case-flow on my-de: records an earlier apply left there, from another machine or a cache that was not restored, cannot be told from the org’s own, and would be created twice. On a Developer Edition org that lives on, apply asks --accept-no-state to go ahead: restore the journal directory of the apply before it, or give the flag. Nothing was written.

apply refused: This machine keeps no state of case-flow on my-de: records an earlier apply left there, from another machine or a cache that was not restored, cannot be told from the org’s own, and would be created twice. On a Developer Edition org that lives on, apply asks --accept-no-state to go ahead: restore the journal directory of the apply before it, or give the flag. Nothing was written.
apply: failure; state serial 0
$ echo $?
1
```

A `destroy` that took everything back keeps the state, every resource in it destroyed: the next `apply` creates them again, with no `--accept-no-state`. Only a state lost, or never kept on this machine, meets that refusal: give the flag once you know the org holds nothing of the environment.

**The journal directory inside the repository that holds the file**, exit `2`, every command but `validate`:

<!-- replay: scratch; the journal inside the repository -->

```console
$ sandforge-env plan --file ../case-flow/sandforge.yaml --org pool-1
The journal directory /home/dev/case-flow/.sandforge is inside the repository /home/dev/case-flow that holds the file: the state, the run summaries and the templates of its runs would be committed with it, and they name the org’s records by their ids. Point SANDFORGE_JOURNAL_DIR at a folder outside the repository — in CI, $RUNNER_TEMP/sandforge — and keep it between the jobs that apply and destroy, in a cache keyed by the org.
$ echo $?
2
```

And:

- **a protected org**, listed under `targets.protect`: `the file refuses it whatever else it says`;
- **a state of another org**, or one that does not read: `a state of another org is never applied`;
- **another apply or destroy of the org under way on this machine**: `Two jobs applying to one org from two machines are not kept apart: give them one concurrency group.`;
- **more than the org has left today**, summed over the resources the plan writes: API requests (`the apply would stop part way`), data storage (`the org would refuse records part way`) and emails (`each resource alone may fit, the day does not`);
- **automation**: a removal the `apply` of a `replace` or a `delete` runs, or the `destroy`, deletes nothing while the org runs flows, Apex triggers, processes or workflow rules as records go, unless `--accept-automation`, or `accept: { automation: true }` on the resource.

## The state

What `apply` keeps of the org: **ids, counts and dates, never a record's values**. Per resource, the fingerprint it was applied from, the order, and how each run ended; the records themselves are named by each seed run's own summary and run file, which the state points at.

- **Where.** `env/<Organization Id>/<name>/` of the journal directory, the folder `SANDFORGE_JOURNAL_DIR` names, `~/.sandforge` by default, beside the run files of the seeds it ran: folders readable by your user alone (`0700`), files too (`0600`). Filed under the Organization Id read from the org, not the alias: an alias reused for a new scratch org gets a new state, and so does a refreshed sandbox.
- **Outside the repository.** The journal directory must sit outside the repository that holds the file: committed, the state and the run summaries would publish the org's record ids with the project.
- **Between jobs.** Keep the journal directory between the jobs that apply and destroy, in a cache keyed by the org: in GitHub Actions, `$RUNNER_TEMP/sandforge`, restored before and saved after. Lost, the next plan cannot tell the environment's records from the org's own -- the refusal above.
- **One machine at a time.** An apply and a destroy hold a lock of the org on this machine, `~/.sandforge/locks/<Organization Id>.env.lock`, whatever `SANDFORGE_JOURNAL_DIR` says, and none of their runs starts while a checkpoint take, rewind or undo of the org is under way on this machine. Two machines applying to one org at once are not kept apart: give the jobs one concurrency group, keyed by the org.
- **How long.** A scratch org's state is deleted 30 days after its last write: every command but `validate` first deletes those whose date has come, and says so. Any other state stays, a `destroy` that took everything back included, until you delete its folder.
- **Read strictly.** A state that does not parse is refused, never guessed; one that changed since it was read -- another apply ran, a cache put back an older one -- is refused, never written over.

## What destroy takes back, and what it leaves

Each resource is taken back by the seed's own removal, the last applied first, into the recycle bin. What it cannot take back it names, exits `3`, and keeps in the state for the next destroy:

- **Records changed since the apply**, kept unless `--include-changed`, which takes them, and what was created under them since: on a CI scratch org, what you want; on a shared sandbox, a colleague's work, which the question says.
- **Records that stay because records of the org depend on them.**
- **What the org's automation created** as the records went in, unless `--sweep` takes it: as the run's user, in each run's window, refused when that user created records in the window that neither the run nor the automation reaches, likely by hand.
- **What the platform does not take back**: a person's contact apart from its account, a lead converted since, a contract activated since.

A removal refused before it deletes stops the destroy there, before the resources that one depended on: the org runs automation as records go and nothing accepted it, or the user may not delete the records of an object. Their records would be kept for it anyway.

A destroy is not undone as a whole: children deleted before their parent cannot come back with it from the recycle bin. It is undone by applying again.

## Stopped part way

Ctrl-C, a SIGTERM -- a CI job cancelled or timed out -- or a SIGHUP stops the run under way before its next call to the org, and the command exits `130`, `143` or `129`. The state named the run before it started, and the seed's run file names what it wrote, so the next plan says `replaced: its last run was stopped part way: what it wrote is taken back from its run file, then it runs again`, and `apply` takes up from there.

## Exit codes

The codes are those of every script ([`exitCodes.ts`](../packages/extension/cli/exitCodes.ts)):

| Code                | Meaning                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`                 | Done: `validate`, the file is valid; `plan`, answered, whatever it found; `apply`, every resource applied whole, or nothing to do; `destroy`, every record taken back                                                                                                                                                                                                                                      |
| `1`                 | Refused before it read or wrote, or nothing written: a production org, a kind of org or a sandbox the file does not allow, a protected org, a state of another org, no state without `--accept-no-state`, another apply of the org under way, a removal refused for automation without `--accept-automation`, more API requests, storage or emails than the org has left; the alias typed is not the org's |
| `2`                 | A bad command line, a file that does not validate, a variable not set, the journal directory inside the file's repository, a question with no terminal (give `--yes`)                                                                                                                                                                                                                                      |
| `3`                 | Partial: `apply`, a resource partial, or failed after others wrote; `destroy`, records left, each with why; `plan` with `--fail-on-change` or `--fail-on-drift`, changes or drift found                                                                                                                                                                                                                    |
| `4`                 | Unstable: a verification found records still changing. No seed run verifies, so a file of seed resources does not end with it                                                                                                                                                                                                                                                                              |
| `130`, `143`, `129` | Ctrl-C, a SIGTERM or a SIGHUP stopped it: run it again, it takes up from the state                                                                                                                                                                                                                                                                                                                         |

## Not yet

This version applies seed resources; the rest waits for a later one:

- **Forge clones, Frozen Dataset loads and masking** as resources: `kind: forge`, `kind: frozen` and `kind: mask` are refused, `Resources of kind forge come with a later SandForge: this one applies seed resources`.
- **Checkpoints in the file**: `checkpoint.before` and `checkpoint.after` are read and checked, and `validate` warns of them; the plan of a file that asks one says an apply would be refused, and `apply` refuses it, `which a later SandForge takes`. Take one with [`sandforge-checkpoint`](modules/checkpoint.md#from-the-command-line) before the apply instead.
- **Saved plans**: no `plan --out`, no `apply --plan`. `apply` plans again, against the org as it is then.
- **Parents drawn by Id from another resource's records**: a relation's `parents` take an `object` and `existing` alone. Draw them with a `where`, as the example does.
- **Outputs, `reset`, `destroy --rewind`**, and the MCP server's tools for environments.

## In CI

[ci-examples](../ci-examples/README.md#an-environment-as-code) has the pattern: a plan with `--fail-on-drift` in a pull request, `apply` and `destroy` around the tests, the journal directory cached by org, and one concurrency group.
