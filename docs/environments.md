# Environments as code: `sandforge.yaml`

A `sandforge.yaml` committed with your project says what records an environment needs: so many accounts, so many contacts under each. `sandforge-env`, one of the [command-line scripts](../ci-examples/README.md), applies it to an org: `plan` says what it would create, keep, replace and take back, `apply` does it, `destroy` takes it back into the recycle bin, and between them a **state** on your machine says what was applied to which org. Applied again, it writes nothing; changed, it replaces what changed.

It writes nothing to an org itself. Each resource of the file is applied by its script -- `sandforge-seed` for a seed resource, `sandforge-clone` for a forge resource, `sandforge-frozen` for a frozen resource --, run in a process of its own with `--json`, and taken back by that script's own removal: every guard, gate and run file of the script holds unchanged, and what `sandforge-env` adds is what no run knows -- the file, the order, the state, and refusals of its own. The checkpoints a file asks are taken, compared with and rewound to by `sandforge-checkpoint`, the same way.

This version applies **seed resources** -- records Seed generates, from a built-in template or from objects, counts, field rules and relations of the file's own --, **forge resources** -- records Forge clones from an org the file names by its role, one record and what hangs from it, or whole tables ([A forge resource](#a-forge-resource)) -- and **frozen resources**: a Frozen Dataset frozen beforehand, loaded as the **Load** tab loads it ([A frozen resource](#a-frozen-resource)). A seed relation may draw its parents from the records another resource created ([References between resources](#references-between-resources)). Around its applies, a file may ask **checkpoints** of the org ([Checkpoints](#checkpoints)): `reset` rewinds the org to the one taken once applied, between two test suites, and `destroy --rewind` to the one taken before the first apply. [Not yet](#not-yet) says what it does not do.

## Run it

From the root of a checkout of this repository, once `pnpm install` and `pnpm build:shared` have run, with each org logged in to the Salesforce CLI (`sf`), which holds its credentials:

```bash
alias sandforge-env='pnpm exec tsx packages/extension/cli/sandforge-env.ts'
```

The script runs from the checkout, so `--file` names your project's file; without it, `sandforge.yaml` of the folder it runs in is read. The sessions below run from `/home/dev/sandforge`, a checkout beside the project `/home/dev/case-flow`, against `pool-1`, a scratch org. Each script it runs says its own lines too, on stderr, as they come -- its dry run, what the org runs as records go in, the run file it keeps --: they are left out here, and what is shown is what `sandforge-env` itself says. With `--json`, the answer alone goes to stdout and every other line to stderr.

## The file

- **YAML 1.2, read strictly.** JSON is YAML, so a `.json` file named with `--file` reads too. A key the file does not take is refused with the keys it does; so are a key given twice in one mapping, a tag YAML 1.2 does not know, a second document in the file, and more than 100 aliases.
- **`version: 1`** at the top. A file written for a later SandForge is refused.
- **No secret.** A key shaped like a secret -- `password`, `token`, `secret`, `authUrl`, `privateKey`, `apiKey`, `salt`, and their spellings -- is refused wherever it stands: org credentials stay with the `sf` CLI. A value comes from the process environment only where the file writes `{ env: NAME }`, and that is the alias of an org role and the path of a frozen resource's dataset alone.
- **The org to fill is never in the file.** `--org` names it, on every command that reaches an org, so one file fills `pool-1`, `pool-2` and your own scratch org alike.
- **Two checks.** The file is held to its own schema, then each resource is turned into its module's payload: a seed resource into a Seed template, held to Seed's own schema and rules, as the Seed panel's are; a forge resource into a Forge template, held to Forge's own template schema, as the clone reads a template file; a frozen resource's configuration is held to Frozen's own schema, strict. What `validate` accepts is what the script is given.

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

| Where                                       | Keys                                                                                                                                                      | What they hold                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the file                                    | `version`, `name`, `description`, `targets`, `orgs`, `checkpoint`, `resources`                                                                            | `version: 1`; `name`, lower-case letters, digits and dashes, which names the state; `resources`, by name                                                                                                                                                                                                                                          |
| `targets`                                   | `kinds`, `sandboxes`, `protect`                                                                                                                           | the kinds of org it may be applied to, `scratch` and `developer` unless it says otherwise; the Organization Ids of the sandboxes it may write to, with `sandbox` among the kinds; the Organization Ids it refuses whatever else says                                                                                                              |
| `orgs.<role>`                               | `alias`                                                                                                                                                   | an sf CLI alias, or `{ env: NAME }`, the variable that holds one; `--alias <role>=<alias>` wins over it; an unset variable refuses every command but `validate`, exit `2`. A forge resource names one as its `source`                                                                                                                             |
| `checkpoint`                                | `before`, `after`, `ignoreFields`                                                                                                                         | `before: true`, a checkpoint of the org before the first write of the first apply, which `destroy --rewind` returns to; `after`, the name of one taken once an apply ended `0`, which `reset` returns to; the fields neither compares nor writes back ([Checkpoints](#checkpoints))                                                               |
| `resources.<name>`                          | `kind`, `dependsOn`, `accept`, `template`, `objects`, `relations`, `locale`, `seed`                                                                       | `kind: seed`; the resources applied before it; `template`, the id of one of Seed's built-in templates, or `objects` and `relations` of its own, not both; `locale`, the country names and addresses are drawn for, the org's own without it; `seed`, the draws                                                                                    |
| `resources.<name>.accept`                   | `automation`                                                                                                                                              | `true`: the `--accept-automation` of the line, for this resource, reviewed in the file                                                                                                                                                                                                                                                            |
| `resources.<name>.objects[]`                | `object`, `count`, `fields`, `recordTypes`, `batchSize`                                                                                                   | an object, listed once; how many records; Seed's field rules, as the Seed panel saves them ([Generated values](modules/seed.md#generated-values)); record types by API name, several taking turns at random                                                                                                                                       |
| `resources.<name>.relations[]`              | `lookup`, `parents`, `distribution`                                                                                                                       | a lookup named with its object, as `Contact.AccountId`; where its parents come from; how many children each one gets                                                                                                                                                                                                                              |
| `resources.<name>.relations[].parents`      | `object`, `existing`, `from`, `limit`                                                                                                                     | the parent object: the records this resource writes of it; with `existing`, records the org holds; with `from`, the records another resource created, `limit` of them at most ([References between resources](#references-between-resources))                                                                                                     |
| `….parents.existing`                        | `where`, `limit`                                                                                                                                          | a SOQL condition, without `WHERE`; how many parents at most                                                                                                                                                                                                                                                                                       |
| `resources.<name>.relations[].distribution` | `mode`, `count`, `min`, `max`, `ratio`                                                                                                                    | `perParent` with `count`, `range` with `min` and `max`, or `ratio` with `ratio`                                                                                                                                                                                                                                                                   |
| `resources.<name>`, `kind: forge`           | `kind`, `dependsOn`, `accept`, `source`, `record`, `tables`, `template`, `depth`, `customDepth`, `maxNodes`, `anonymize`, `keepContactPoints`, `maxTotal` | `kind: forge`; `source`, the org role it clones from; `record` or `tables`, not both; `template`, an entry of the project's templates file; the clone's depth, its custom depth and its cap of objects; Forge's anonymization; `keepContactPoints`, to write emails and phone numbers as read; `maxTotal`, the most records a run of it may write |
| `resources.<name>.record`                   | `id`, `object`, `where`                                                                                                                                   | the record it clones and what hangs from it: by its `id`, or by its `object` and a `where` its source answers with exactly one row, read at each plan                                                                                                                                                                                             |
| `resources.<name>.tables[]`                 | `object`, `where`                                                                                                                                         | a table it clones whole, the first the one discovery starts from; a SOQL condition, without `WHERE`, every row without it                                                                                                                                                                                                                         |
| `resources.<name>.template`                 | `file`, `id`                                                                                                                                              | a templates file of the project, from the file's folder, as `.sandforge/forge-templates.json`; the id of the template it takes the decisions, exclusions, filters and mappings of                                                                                                                                                                 |
| `resources.<name>.anonymize`                | `presetId`, `rules`, `fields`                                                                                                                             | Forge's anonymization, as a template holds it: the method of each category, and the personal fields of each object                                                                                                                                                                                                                                |
| `resources.<name>.accept`, `kind: forge`    | `automation`, `realData`                                                                                                                                  | `automation`, as for a seed resource; `realData: true`, to clone a production source without anonymizing it, reviewed in the file ([Real data](#real-data-from-a-production-org))                                                                                                                                                                 |
| `resources.<name>`, `kind: frozen`          | `kind`, `dependsOn`, `accept`, `config`, `dataset`                                                                                                        | `kind: frozen`; `config`, the project's Frozen configuration, from the file's folder; `dataset`, the dataset it loads, pinned                                                                                                                                                                                                                     |
| `resources.<name>.dataset`                  | `path`, `version`, `digest`                                                                                                                               | the dataset's folder, from the root, or `{ env: NAME }`; the version its manifest says; its digest, `sha256:` and 64 hexadecimal digits, as `sandforge-frozen --json` gives it                                                                                                                                                                    |

A built-in template is one of `prebuilt-crm-starter`, `prebuilt-leads-activities-starter`, `prebuilt-minimal-demo`, `prebuilt-service-cloud-starter` and `prebuilt-sales-cloud-starter`, the templates of Seed's gallery. Its content, not its id, is what the state compares: a SandForge whose template changed replaces what the old one wrote.

### A forge resource

```yaml
orgs:
  uat: { alias: { env: SF_UAT_ALIAS } } # the org it clones from, never the org to fill

resources:
  bug-1234:
    kind: forge
    source: uat
    record: { object: Case, where: "CaseNumber = '00001026'" } # exactly one row, read at each plan
    template: { file: .sandforge/forge-templates.json, id: case-with-history }
    maxTotal: 500
```

A forge resource is cloned by [`sandforge-clone`](forge-reference.md#the-command-line) from the org its `source` role names, into the org to fill: one `record` and what discovery reaches from it, or whole `tables`, each under its condition. It is turned into a Forge template -- the entry of the project's templates file it names, the file's `depth`, caps, anonymization and contact points over it -- and the clone is given that template with the record or the tables beside it.

- **The record of a query is read at each plan**, on the source: no row, or more than one, blocks the resource with the count. A scratch org made again gives the same case another id, which a record named by its `id` could not follow.
- **The source by its Organization Id.** What the resource's fingerprint is of names the org its role's alias reaches, and the record its query resolved to, never the alias: an alias pointed at another org replaces it, one renamed keeps it. A source that is the org to fill is refused.
- **Held to its plan's count.** The plan dry-runs the clone and keeps the count its gate gives, and the run is held to it as the most records it may write in all: a source that grew between the plan and the run is refused before its first write, and nothing is written. `maxTotal` is the most the file lets a run write, which the dry run is held to.
- **Verified.** Once a run ended, the clone's own verification reads back from the org filled what it created, and checks its lookups on a sample against the source: records not there, or lookups that do not hold, leave it partial, and readings that never agree end the apply with `4`.
- **Taken back by the clone's own removal**, from the summary the run wrote beside the state as it went: a run stopped part way is taken back from what its summary says it had created, then run again.

### Real data from a production org

Every script reads a production org: only writing to one is refused. An org built for tests is often reached by more people, pipelines and integrations than the org it was filled from, so a forge resource whose source types as a production org -- by the rule every guard reads, its Organization record saying `IsSandbox` false and an edition other than Developer Edition -- is blocked, and the apply with it, unless it says what is done to the data:

- **`anonymize`**, Forge's anonymization, a method for at least one category of personal field. One that sets no method anonymizes nothing, and is said so;
- **or `accept: { realData: true }`**, reviewed in the file: what it clones is written as read.

```yaml
orgs:
  prod: { alias: { env: SF_PROD_ALIAS } } # a production org, read: never written to

resources:
  bug-1234:
    kind: forge
    source: prod
    record: { object: Case, where: "CaseNumber = '00001026'" }
    anonymize: { rules: { name: fake, email: fake, address: mask } }
```

The refusal names both ways out: `Give the resource anonymize — Forge’s anonymization, a method for each category of personal field — or, reviewed in the file, accept: { realData: true }`. It is met before a record of the source is read: the plan neither reads the record its query names nor dry-runs the clone.

Either way, the clone neutralizes emails and phone numbers before it writes them, as it does from any source, unless the resource sets `keepContactPoints: true`, and the plan says which, under the resource: `real data: its source, the prod org (PROD), is a production org; what it clones is anonymized as its anonymize says (name fake, email fake, address mask)`, then `contact points: neutralized before writing (emails under .invalid, phone numbers in a fictional range), as the clone does unless keepContactPoints`.

### A frozen resource

```yaml
# sandforge.yaml: the claims the claim-flow tests need, and contacts under them
version: 1
name: claims-flow

resources:
  claims:
    kind: frozen
    config: frozen/claims.frozen.json # the Frozen configuration, committed: it holds no record
    dataset:
      path: { env: SANDFORGE_CLAIMS_DATASET } # where the pipeline put it, outside the repository
      version: 1.0.0
      digest: sha256:5a4160a5f7b1e116b0367fc2bd1ce2ff3d8720910092aedb6b658fb65db83c5b

  followers:
    kind: seed
    seed: 7
    objects:
      - object: Contact
        count: 3
        fields:
          - { fieldApiName: LastName, ruleType: static, config: { staticValue: CI follower } }
    relations:
      - lookup: Contact.AccountId
        parents: { from: claims.Account } # the accounts claims loaded, by their ids
        distribution: { mode: perParent, count: 1 }
```

A frozen resource loads a [Frozen Dataset](modules/frozen-dataset.md) a person froze beforehand -- selected, extracted, pseudonymized and checked by the non-reidentification control -- with [`sandforge-frozen`](modules/frozen-dataset.md#removing-a-load), which drives the **Load** tab's own handler.

- **Its configuration is committed, its dataset is not.** `config` names the project's Frozen configuration, from the file's folder, as the panel saves it: held to Frozen's own schema, strict, a key it does not name refused, and no key shaped like a secret -- a load never reads the salt. The dataset is pseudonymized business data: it stays outside the repository, where the pipeline downloads it, named by its path from the root or by a `{ env: NAME }` variable. A dataset inside the repository that holds the file is refused, exit `2`.
- **Pinned by its version and its digest.** `version` is the one its manifest stamps, and `digest` what `sandforge-frozen --json` gives it: `sha256:` over the files a load reads, the same wherever the folder is moved. A dataset whose digest or version is not the file's blocks the resource, both named: what was reviewed is what is loaded. The fingerprint is of the digest, never of the path: a dataset moved keeps the resource, a dataset frozen again replaces it once the file pins it.
- **The environment sets its folders.** Each run is given the committed configuration with its `sasDir` set to a folder of the state, `frozen/<resource>`, which keeps the resource's loads -- the mapping of what each created, its counting contract, the script's own store -- and its `datasetDir` set to the dataset pinned; a `sasDir` or a `datasetDir` the configuration gives is warned of and not used.
- **Held to its plan's count, and verified.** The plan dry-runs the load (`load --dry-run`) and shows what it would insert per object; the run (`load`) is held to that count with `--max-total`, and judged by the verification the load chains after it: an object it FAILED leaves the resource partial. On each plan after, its verification (`verify`) and the preview of its removal read what the org holds of it: an object FAILED, a record gone or changed since, and the resource is drifted, each named.
- **Replaced by a reload.** A dataset changed, a resource it depends on run again, or its last load stopped part way: the replace is one run, `load --reload`, whose purge takes back what the loads before it created, then loads again. It is refused before anything is written when that purge would leave records -- changed since, of an object the user may not delete -- and the plan blocks the resource in the load's own words, as it does what else a load refuses: an org its entry guards turn away, a protected one, a required field the dataset leaves empty with no default. What the load would leave out without refusing -- a field the target encrypts that may hold masks, a picklist value a restricted picklist refuses and its rule rewrites -- the plan says beside its counts.
- **Taken back by its own removal**, `remove`, the last load first, given the configuration its run was given; `destroy` previews it with `remove --preview`. A Frozen load and its removal take no `--accept-automation`, and `accept: { automation: true }` on a frozen resource is warned of.

<!-- replay: frozen -->

```console
$ sandforge-env plan --file ../claims-flow/sandforge.yaml --org pool-1
claims: reading its dataset at /home/dev/datasets/claims
claims: dry run
followers: dry run
plan of claims-flow on pool-1 (scratch, 00Dxx0000001gPLEAY)
state: none on this machine
  create   claims  Account 2 to write; Contact 2 to write
           not applied to this org yet
  create   followers  Contact at most 3 to write
           not applied to this org yet; it draws its parents from the records claims creates in this apply, which nobody knows before it runs: counted at most as the file gives it
           Contact.AccountId draws its parents from the Account records claims creates first
totals: 2 to create, 0 to replace, 0 to delete, 0 kept, 0 drifted, 0 blocked
API requests: about 1, 14000 left; not counted: the requests of the run of claims, which its script does not estimate, what followers draws from the records claims writes first
data storage: about 0.02 MB, 5 MB left
warning: this machine keeps no state of claims-flow on pool-1: records an earlier apply left there, from another machine or a cache that was not restored, cannot be told from the org’s own, and would be created twice
```

The dataset is read first, and held to its pin; the load's dry run counts what it would insert, as the **Load** tab's preview counts it. Applied:

<!-- replay: then -->

```console
$ sandforge-env apply --file ../claims-flow/sandforge.yaml --org pool-1 --yes
claims: reading its dataset at /home/dev/datasets/claims
claims: dry run
followers: dry run
plan of claims-flow on pool-1 (scratch, 00Dxx0000001gPLEAY)
state: none on this machine
  create   claims  Account 2 to write; Contact 2 to write
           not applied to this org yet
  create   followers  Contact at most 3 to write
           not applied to this org yet; it draws its parents from the records claims creates in this apply, which nobody knows before it runs: counted at most as the file gives it
           Contact.AccountId draws its parents from the Account records claims creates first
totals: 2 to create, 0 to replace, 0 to delete, 0 kept, 0 drifted, 0 blocked
API requests: about 1, 14000 left; not counted: the requests of the run of claims, which its script does not estimate, what followers draws from the records claims writes first
data storage: about 0.02 MB, 5 MB left
warning: this machine keeps no state of claims-flow on pool-1: records an earlier apply left there, from another machine or a cache that was not restored, cannot be told from the org’s own, and would be created twice
claims: run 1 (create)
followers: run 1 (create)

  claims run 1: exit 0, applied  Account 2 created; Contact 2 created
  followers run 1: exit 0, applied  Contact 2 created
apply: success; state serial 4
```

A test deletes one of the contacts the load wrote:

<!-- replay: then; a contact of the load deleted -->

```console
$ sandforge-env plan --file ../claims-flow/sandforge.yaml --org pool-1 --fail-on-drift
claims: reading its dataset at /home/dev/datasets/claims
followers: reading what the org holds of run 1
claims: reading what the org holds of run 1
claims: verifying run 1
plan of claims-flow on pool-1 (scratch, 00Dxx0000001gPLEAY)
state: kept on this machine, serial 4
  drifted  claims  Contact 1 in the org, 1 gone; Account 2 in the org
           its records changed since it was applied: Contact 1 gone; its verification: Contact FAILED (1 of 2 found). Left as they are: --replace claims or --replace-drifted replaces it
  keep     followers  Contact 2 in the org
           applied, and the org holds its 2 record(s) as written
totals: 0 to create, 0 to replace, 0 to delete, 1 kept, 1 drifted, 0 blocked
API requests: about 0, 14000 left
data storage: about 0 MB, 5 MB left
$ echo $?
3
```

Its verification FAILED the contacts, and its removal's preview finds one gone: `claims` is drifted, both said, and `--fail-on-drift` exits `3`. `followers` holds its records as written.

The dataset is frozen again, at the same path, with a third account; the file still pins the one before:

<!-- replay: then; the dataset frozen again -->

```console
$ sandforge-env plan --file ../claims-flow/sandforge.yaml --org pool-1
claims: reading its dataset at /home/dev/datasets/claims
followers: reading what the org holds of run 1
claims: reading what the org holds of run 1
claims: verifying run 1
plan of claims-flow on pool-1 (scratch, 00Dxx0000001gPLEAY)
state: kept on this machine, serial 4
  blocked  claims  Contact 1 in the org, 1 gone; Account 2 in the org
           applied from the same file
           refused: its dataset at /home/dev/datasets/claims has the digest sha256:c974d7172f004402b9101fc85cb74a65ab54bec2a71f82e693d3b554e975633e, and the file pins sha256:5a4160a5f7b1e116b0367fc2bd1ce2ff3d8720910092aedb6b658fb65db83c5b: it is not the dataset the file was reviewed with. Point the path at that one, or pin this digest once this dataset is reviewed
  keep     followers  Contact 2 in the org
           applied, and the org holds its 2 record(s) as written
totals: 0 to create, 0 to replace, 0 to delete, 1 kept, 0 drifted, 1 blocked
API requests: about 0, 14000 left
data storage: about 0 MB, 5 MB left
an apply now would be refused: A resource is blocked, and the apply refuses before its first write: claims (its dataset at /home/dev/datasets/claims has the digest sha256:c974d7172f004402b9101fc85cb74a65ab54bec2a71f82e693d3b554e975633e, and the file pins sha256:5a4160a5f7b1e116b0367fc2bd1ce2ff3d8720910092aedb6b658fb65db83c5b: it is not the dataset the file was reviewed with. Point the path at that one, or pin this digest once this dataset is reviewed)
```

Blocked, both digests named: an apply refuses before its first write.

Once the file pins it, the apply reloads it:

<!-- replay: then; the file pins the new dataset -->

```console
$ sandforge-env apply --file ../claims-flow/sandforge.yaml --org pool-1 --yes
claims: reading its dataset at /home/dev/datasets/claims
followers: reading what the org holds of run 1
claims: reading what the org holds of run 1
claims: verifying run 1
claims: dry run
followers: dry run
plan of claims-flow on pool-1 (scratch, 00Dxx0000001gPLEAY)
state: kept on this machine, serial 4
  replace  claims  Contact 3 to write, 1 in the org, 1 gone; Account 3 to write, 2 in the org
           replaced: what it writes changed in the file since it was applied
  replace  followers  Contact at most 3 to write, 2 in the org
           replaced: the resources it depends on run again, with new records: claims; it draws its parents from the records claims creates in this apply, which nobody knows before it runs: counted at most as the file gives it
           Contact.AccountId draws its parents from the Account records claims creates first
totals: 0 to create, 2 to replace, 0 to delete, 0 kept, 0 drifted, 0 blocked
API requests: about 1, 14000 left; not counted: the removal of the runs of claims, the requests of the run of claims, which its script does not estimate, the removal of the runs of followers, what followers draws from the records claims writes first
data storage: about 0.02 MB, 5 MB left
followers: taking back run 1
claims: run 2 (replace)
followers: run 2 (replace)

  followers removal of run 1: exit 0, destroyed  Contact 2 deleted
  claims run 2: exit 0, applied  Account 3 created; Contact 3 created
  followers run 2: exit 0, applied  Contact 3 created
apply: success; state serial 12
```

One run of `claims`, a reload: its purge took back what the load before it created -- the contact deleted since was gone already -- then it loaded the new dataset. `followers`, drawn from it, was taken back first and run again, under the three new accounts.

### References between resources

A seed relation may draw its parents from the records another resource of the file created: `parents: { from: claims.Account }`, or `from: claims` beside `object: Account`, as `followers` does above. The other resource may be a seed, a forge or a frozen resource.

- **By their ids, read from its run.** The ids are those the resource's last run created, read from what that run keeps: a seed's run file or its summary, a clone's summary -- the target ids its remap table gives the records it created, never those it linked to --, a Frozen load's mapping in its sas -- the records it created, never those it found and linked. They are handed to the seed as parents named by id, which it checks against the org before its first write: one deleted since refuses the run, in the seed's words.
- **At most 2,000.** A relation draws as many parents as an `existing` one may: a resource that created more of the object refuses the relation unless it gives `limit`, and its parents are then the first records created. `limit` goes with `from`; an `existing` relation keeps its own.
- **An order, and no circle.** `from` makes the resource depend on the one it draws from, as `dependsOn` does: it runs after it, and is taken back before it. A name that is no resource of the file, the resource itself, and a circle of dependencies, through `dependsOn` or `from`, are refused; so is a seed resource drawn from for an object it does not write.
- **Counted exactly once the other has run.** While the resource drawn from runs in the same apply, nobody knows its records: the plan counts the drawing resource at most as the file gives it, and says so -- `draws its parents from the Account records claims creates first`. Once it has run, its ids are known: the plan hands them to the dry run, counts exactly, and says how many -- `draws its parents from the 3 Account record(s) claims created` --, and the run is held to that count.
- **Replaced with what it draws from.** A resource drawn from that runs again has new records, with new ids: what draws from it is replaced too, `the resources it depends on run again`.

After the reload above, `followers` asks for four contacts:

<!-- replay: then; followers ask for four -->

```console
$ sandforge-env plan --file ../claims-flow/sandforge.yaml --org pool-1
claims: reading its dataset at /home/dev/datasets/claims
followers: reading what the org holds of run 2
claims: reading what the org holds of run 2
claims: verifying run 2
followers: dry run
plan of claims-flow on pool-1 (scratch, 00Dxx0000001gPLEAY)
state: kept on this machine, serial 12
  keep     claims  Contact 3 in the org; Account 3 in the org
           applied, and the org holds its 6 record(s) as written
  replace  followers  Contact 3 to write, 3 in the org
           replaced: what it writes changed in the file since it was applied
           Contact.AccountId draws its parents from the 3 Account record(s) claims created
totals: 0 to create, 1 to replace, 0 to delete, 1 kept, 0 drifted, 0 blocked
API requests: about 1, 14000 left; not counted: the removal of the runs of followers
data storage: about 0.01 MB, 5 MB left
```

The accounts are known now: three, so three contacts, exactly, one under each. `claims` is kept.

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

## Checkpoints

A file may ask two checkpoints of the org, each a [checkpoint](modules/checkpoint.md) of its data taken, compared with and rewound to by `sandforge-checkpoint` itself, spawned with `--json` as every script is:

```yaml
checkpoint:
  before: true # before the first write of the first apply: destroy --rewind returns to it
  after: baseline # once an apply ended 0, again after each that writes: reset returns to it
  ignoreFields: [Case.Last_Touched__c] # what your automation sets on every save
```

- **`after`** is taken once an apply ended `0`, and again by the next apply that writes, the one before deleted: once an apply wrote, the org no longer holds the environment as that one holds it. An apply that writes nothing takes none, unless the state names none. `reset` rewinds the org to it, and `plan` compares the whole org with it.
- **`before`** is taken before the first write of the first apply, and never again while the state names it. `destroy --rewind` returns the org to it. Asked of an environment an earlier apply wrote without one, it is not taken, and the plan says why: a rewind to it would keep those records.
- **Where they are kept**: in `checkpoints/` of the journal directory, outside the repository with the state. A checkpoint holds the records' values in clear, personal data among them: a cache that keeps the journal directory keeps them too, and is read by the pipeline alone.
- **What they cost, and what refuses them**: each take the apply would make is in its plan, with what the checkpoint script itself estimates it costs, and its API requests are in the day's sum. The checkpoint's own guard refuses a production org, a user without View All Data and Modify All Data, and more records than its limit: its refusal is the apply's, before its first write.

### Taken once applied: `checkpoint.after`

The file of the walk-through, with `checkpoint: { after: baseline }`:

<!-- replay: scratch; the file asks a checkpoint once applied -->

```console
$ sandforge-env apply --file ../case-flow/sandforge.yaml --org pool-1 --yes
accounts: dry run
contacts: dry run
checkpoint: estimating what a take of the org costs
plan of case-flow on pool-1 (scratch, 00Dxx0000001gPLEAY)
state: none on this machine
  create   accounts  Account 3 to write
           not applied to this org yet
  create   contacts  Contact at most 6 to write
           not applied to this org yet; its dry run read the org before accounts writes: what it draws from those records is counted at most as the file gives it
totals: 2 to create, 0 to replace, 0 to delete, 0 kept, 0 drifted, 0 blocked
API requests: about 17, 14000 left; not counted: what contacts draws from the records accounts writes first
data storage: about 0.02 MB, 5 MB left
checkpoint once applied: 'baseline', about 9 records, 15 API requests, 4 s, 0.01 MB on this machine
warning: this machine keeps no state of case-flow on pool-1: records an earlier apply left there, from another machine or a cache that was not restored, cannot be told from the org’s own, and would be created twice
accounts: run 1 (create)
contacts: run 1 (create)
checkpoint once applied: taking 'baseline'

  accounts run 1: exit 0, applied  Account 3 created
  contacts run 1: exit 0, applied  Contact 6 created
  checkpoint once applied: exit 0, taken ck-20261025-090230-a1b2
apply: success; state serial 5
```

The plan says what the take costs, by the checkpoint script's own estimate, and the API requests of the day add it: 17, the seeds' 2 and the take's 15. The take comes once every resource ended `0`; its id is in the state.

### The whole org against it: `plan --fail-on-drift`

A test renames one of the environment's accounts, and creates an account of its own:

<!-- replay: then; a test renames an account and creates one -->

```console
$ sandforge-env plan --file ../case-flow/sandforge.yaml --org pool-1 --fail-on-drift
contacts: reading what the org holds of run 1
accounts: reading what the org holds of run 1
checkpoint ck-20261025-090230-a1b2: comparing the whole org with it
plan of case-flow on pool-1 (scratch, 00Dxx0000001gPLEAY)
state: kept on this machine, serial 5
  drifted  accounts  Account 3 in the org, 1 changed
           its records changed since it was applied: Account 1 changed (last changed by Colleague 1). Left as they are: --replace accounts or --replace-drifted replaces it
  keep     contacts  Contact 6 in the org
           applied, and the org holds its 6 record(s) as written
totals: 0 to create, 0 to replace, 0 to delete, 1 kept, 1 drifted, 0 blocked
API requests: about 0, 14000 left
data storage: about 0 MB, 5 MB left
the whole org against the checkpoint after the last apply (ck-20261025-090230-a1b2): differs, 1 to delete · 1 to give back · 0 to bring back
$ echo $?
3
```

Each resource is read back by its removal preview, as without a checkpoint; the whole org, by the checkpoint's own preview, which sees what the environment's records do not: the account the test created. Either one moved makes `--fail-on-drift` exit `3`, and so does a whole org the checkpoint script could not compare.

### Between two suites: `reset`

<!-- replay: then -->

```console
$ sandforge-env reset --file ../case-flow/sandforge.yaml --org pool-1 --yes
reset: rewinding pool-1 to checkpoint ck-20261025-090230-a1b2

  rewind to ck-20261025-090230-a1b2: exit 0, success  1 deleted, 1 given back, 0 brought back
undo it until 2026-11-09T09:04:31.000Z, sooner if the recycle bin fills: sandforge-checkpoint undo --org pool-1 --checkpoint ck-20261025-090230-a1b2 --store /home/dev/.sandforge/checkpoints
reset: success; state serial 5
```

`reset` rewinds the org to the checkpoint taken after the last apply: what anyone created, changed or deleted since is taken back, and the environment's records are back as applied, with their Ids. The state stays as it was, its serial too: it names the same runs, and their records are in the org again. It never makes records again with new Ids, which the state would no longer name: one the recycle bin no longer gives back is left, and named.

- **The question**: on a terminal, it first reads what the rewind would do, then asks for the alias, as `apply` does: `Type pool-1 to reset it to 'baseline', as case-flow was applied: it deletes 1 record(s) created since, gives 1 their values back and brings 0 back from the recycle bin — whoever made these changes, last changed by Colleague 2:`. In CI, `--yes`; with no terminal and no `--yes`, it stops at the question, exit `2`, having written nothing.
- **The acceptances**: `--accept-automation` and `--accept-no-undo`, the rewind's own, given to it only when the line gives them.
- **Undo**: the checkpoint script offers to undo the reset, as it offers to undo any rewind, for 15 days, sooner if the recycle bin fills; the line above is the one that does it.
- **Refused** with no checkpoint after the last apply (`names no checkpoint taken after an apply`), and once an apply did not end whole: the checkpoint before it no longer holds the environment the state names (`Apply again, then reset.`).

The reset gave the renamed account its name back, which dates it after the apply: a removal preview reads its date alone, and counts it changed. The whole org holds what the checkpoint holds, so the plan keeps it:

<!-- replay: then -->

```console
$ sandforge-env plan --file ../case-flow/sandforge.yaml --org pool-1 --fail-on-drift
contacts: reading what the org holds of run 1
accounts: reading what the org holds of run 1
checkpoint ck-20261025-090230-a1b2: comparing the whole org with it
plan of case-flow on pool-1 (scratch, 00Dxx0000001gPLEAY)
state: kept on this machine, serial 5
  keep     accounts  Account 3 in the org, 1 changed
           applied, and the org holds its 3 record(s) as the checkpoint taken after the apply holds them: 1 written since hold their values again, as a reset gives them back
  keep     contacts  Contact 6 in the org
           applied, and the org holds its 6 record(s) as written
totals: 0 to create, 0 to replace, 0 to delete, 2 kept, 0 drifted, 0 blocked
API requests: about 0, 14000 left
data storage: about 0 MB, 5 MB left
the whole org against the checkpoint after the last apply (ck-20261025-090230-a1b2): nothing differs among the objects and fields it compares
$ echo $?
0
```

A `destroy` by removal still reads that account as changed since the apply, and keeps it unless `--include-changed`: on a pool's org, give the flag, or destroy by rewind.

### Back to before the first apply: `destroy --rewind`

With `checkpoint: { before: true }`, the first apply takes a checkpoint before its first write:

<!-- replay: scratch; the file asks a checkpoint before the first write -->

```console
$ sandforge-env apply --file ../case-flow/sandforge.yaml --org pool-1 --yes
accounts: dry run
contacts: dry run
checkpoint: estimating what a take of the org costs
plan of case-flow on pool-1 (scratch, 00Dxx0000001gPLEAY)
state: none on this machine
  create   accounts  Account 3 to write
           not applied to this org yet
  create   contacts  Contact at most 6 to write
           not applied to this org yet; its dry run read the org before accounts writes: what it draws from those records is counted at most as the file gives it
totals: 2 to create, 0 to replace, 0 to delete, 0 kept, 0 drifted, 0 blocked
API requests: about 17, 14000 left; not counted: what contacts draws from the records accounts writes first
data storage: about 0.02 MB, 5 MB left
checkpoint before the first write: 'case-flow before', about 0 records, 15 API requests, 4 s, 0.01 MB on this machine
warning: this machine keeps no state of case-flow on pool-1: records an earlier apply left there, from another machine or a cache that was not restored, cannot be told from the org’s own, and would be created twice
checkpoint before the first write: taking 'case-flow before'
accounts: run 1 (create)
contacts: run 1 (create)

  accounts run 1: exit 0, applied  Account 3 created
  contacts run 1: exit 0, applied  Contact 6 created
  checkpoint before the first write: exit 0, taken ck-20261025-090130-a1b2
apply: success; state serial 5
```

The checkpoint is taken before the first seed writes, of an org that holds none of the environment yet -- here an empty one: a team's own records in a sandbox are kept in it, and come back with it.

A test creates an account of its own; then:

<!-- replay: then; a test creates an account -->

```console
$ sandforge-env destroy --file ../case-flow/sandforge.yaml --org pool-1 --rewind --yes
destroy --rewind: rewinding pool-1 to checkpoint ck-20261025-090130-a1b2
checkpoint ck-20261025-090130-a1b2: deleted from this machine, the environment it was taken of is taken back
every record of case-flow is taken back from pool-1, with what anyone changed since its first apply: the state keeps it as destroyed, and the next apply creates it again

  rewind to ck-20261025-090130-a1b2: exit 0, success  4 deleted, 0 given back, 0 brought back
  checkpoint ck-20261025-090130-a1b2 deleted
no undo: the environment’s checkpoints are deleted with it, the journal of this rewind among them: a destroy is undone by applying again
destroy --rewind: success; state serial 7
```

The three accounts of the environment and the one the test created are deleted, and the six contacts go with their accounts, as Salesforce deletes them.

`destroy --rewind` returns the org to the checkpoint taken before the first apply: **everyone's** changes since are taken back, not only the environment's records. On a CI org of its own, the whole destroy; on a shared sandbox, the wrong one, and its question says it: `Type pool-1 to rewind it to before case-flow was first applied: it deletes … — whoever made these changes, last changed by …; the environment's checkpoints are then deleted, and this is not undone:`. Once it ended `0`, every resource of the state is destroyed, and the environment's checkpoints are deleted, the rewind's journal with them: it is not undone, but by applying again. `--include-changed` and `--sweep` belong to a destroy by removal, and are refused beside `--rewind`.

A destroy by removal that took every record back deletes the environment's checkpoints too; one that left records keeps them, for the destroy that takes the rest.

## The commands

| Command    | What it does                                                                                                                                                    | Flags                                                                                                                                  |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `validate` | checks the file offline: its schema, each resource against Seed's rules, the order, the variables                                                               | `--file`, `--json`                                                                                                                     |
| `plan`     | says what `apply` would do, writing nothing                                                                                                                     | `--file`, `--org`, `--alias`, `--json`, `--fail-on-change`, `--fail-on-drift`, `--quick`, `--replace`, `--replace-drifted`             |
| `apply`    | does what the plan says, once the alias is typed or `--yes` given                                                                                               | `--file`, `--org`, `--alias`, `--json`, `--replace`, `--replace-drifted`, `--accept-automation`, `--accept-no-state`, `--yes`          |
| `destroy`  | takes back what `apply` created, the last resource first, into the recycle bin; with `--rewind`, rewinds the org to the checkpoint taken before the first apply | `--file`, `--org`, `--alias`, `--json`, `--include-changed`, `--sweep`, `--accept-automation`, `--rewind`, `--accept-no-undo`, `--yes` |
| `reset`    | rewinds the org to the checkpoint taken after the last apply, once the alias is typed or `--yes` given                                                          | `--file`, `--org`, `--alias`, `--json`, `--accept-automation`, `--accept-no-undo`, `--yes`                                             |
| `state`    | lists the states kept on this machine, or those of one org or one file; reaches no org                                                                          | `--org`, `--file`, `--json`                                                                                                            |

### Every flag

```text
sandforge-env — apply a sandforge.yaml to an org: the data an environment needs, declared in
your repository, created, kept and taken back, without the editor.

Usage:
  pnpm exec tsx packages/extension/cli/sandforge-env.ts <command> [--file <sandforge.yaml>] --org <alias> [options]

Commands:
  validate  check the file, offline: its schema, each resource against its module's own rules,
            the order of the resources, the variables it names; reaches no org
  plan      say what apply would do to the org: per resource, create, keep, replace, delete, or why
            it is blocked; what an earlier apply left there and what changed since; per object the
            records it would write; the API requests, storage and emails it takes; writes nothing
  apply     do what plan says, after asking you to type the org's alias; applied again, it writes
            nothing; stopped, run it again and it takes up
  destroy   take back what apply created, the last resource first, into the recycle bin; name what
            it cannot take back
  reset     rewind the org to the checkpoint taken after the last apply: what anyone created,
            changed or deleted since is taken back, the environment's records back as applied;
            between two test suites, after asking you to type the org's alias
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
  --rewind                   rewind the org to the checkpoint taken before the first apply
                             instead: everyone's changes since are taken back, not only the
                             environment's records, and its checkpoints are then deleted
  --accept-no-undo           with --rewind, rewind although undo could not bring back some of
                             the records it deletes
  --yes                      as for apply
reset:
  --accept-automation        rewind although the org runs automation as records are written back
  --accept-no-undo           rewind although undo could not bring back some of the records it
                             deletes
  --yes                      as for apply

The file holds no secret: org credentials stay with the sf CLI. A value comes from the environment
only where the file writes { env: NAME }. The org to fill is never in the file. A resource's
accept: { automation: true } is the file's --accept-automation for that resource.

A forge resource clones from the org its source names: a role of the file's orgs, its alias
given there, in a { env: NAME } variable or with --alias. A record named by a query is the one
row its source answers, read at each plan. Each forge run is held to the count its dry run gave
the plan: a source that grew since is refused, not written. Once it ended, the clone verifies
what it created: records not there, or lookups that do not hold, leave it partial. A source that
is a production org is refused unless the resource anonymizes what it clones (anonymize) or the
file accepts real data (accept: { realData: true }); emails and phone numbers are neutralized
either way, unless keepContactPoints.

The file's checkpoint.before takes a checkpoint of the org before the first write of its first
apply, which destroy --rewind returns to; checkpoint.after takes one once an apply ended 0, and
again after each apply that writes, which reset returns to and plan compares the whole org with.
sandforge-checkpoint takes, rewinds to and deletes them, in checkpoints/ of the journal
directory: they hold the org's values in clear. plan says what each take costs and what refuses
it, which refuses the apply before its first write. A destroy that took everything back deletes
them; reset keeps them, and sandforge-checkpoint undo takes a reset back.

A frozen resource loads a Frozen Dataset frozen beforehand, through sandforge-frozen: its
configuration committed beside the file, its dataset named by its path from the root or in a
{ env: NAME } variable, and pinned by its version and its digest — a dataset whose digest is not
the file's is refused, both named. Each load is held to the count its dry run gave and judged by
the verification it chains; a replace is a reload, refused when it would leave records.

A seed relation may draw its parents from the records another resource created:
parents: { from: <resource>.<Object> }. They are read from that resource's own run, handed to
the seed by their ids, at most 2,000 or the relation's limit, and counted exactly once that
resource has run; the resource drawn from runs first, and is taken back last.

A production org is refused before anything is read, exit 1. No flag lifts it. A sandbox is
written to only when the file lists its Organization Id under targets.sandboxes and allows the
sandbox kind; scratch orgs and Developer Edition orgs need no listing. A scratch org is told
apart by the Dev Hub the sf CLI names for it; one it names none for is taken for a sandbox.

What apply keeps of the org is the state: ids, counts and dates, never a record's values, in
env/<Organization Id>/<name>/ of the folder SANDFORGE_JOURNAL_DIR names (default: ~/.sandforge),
beside the run files of the seeds and clones it ran; each frozen resource's loads are kept
there, in a sas of its own. That folder must be outside the repository that holds the file.
Keep it between the jobs that apply and destroy, in a cache keyed by the org. A scratch org's
state is deleted 30 days after its last write. Two machines applying to one org at once are not
kept apart: give the jobs one concurrency group.

Exit codes: 0 done (validate: the file is valid; plan: answered; apply: every resource applied
whole, or nothing to do; destroy: every record taken back; reset and destroy --rewind: read again,
the org matches the checkpoint); 1 refused before it read or wrote — a production org, a kind of
org or a sandbox the file does not allow, a protected org, a state of another org, no state
without --accept-no-state, another apply of the org under way, a removal refused for automation
without --accept-automation, more API requests, storage or emails than the org has left, a
checkpoint the file asks that its script refuses, a production source without anonymize or
accept: { realData: true }, no checkpoint to reset or rewind to, a rewind refused for want of
--accept-automation or --accept-no-undo —, or nothing written; 2 a bad command line, a file that
does not validate, a variable not set, the journal directory or a dataset inside the file's
repository, a question with no terminal (give --yes); 3 partial (apply: a resource partial, or
failed after others wrote; destroy: records left, each with why; reset and destroy --rewind:
records still differ; plan with --fail-on-change or --fail-on-drift: changes or drift found); 4
unstable (a forge run's or a frozen load's verification found records still changing; reset and
destroy --rewind: someone changed records during it); 130, 143, 129 Ctrl-C, SIGTERM or SIGHUP
stopped it — run it again: it takes up from the state.
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

**A frozen resource's dataset that is not the one its file pins**: the plan blocks it, both digests named -- [A frozen resource](#a-frozen-resource) shows it. A dataset inside the repository that holds the file is refused, exit `2`, as the journal directory is.

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
- **a forge resource cloning a production org** without `anonymize` or `accept: { realData: true }`: [Real data](#real-data-from-a-production-org);
- **a checkpoint the file asks that the checkpoint script refuses**, by its own estimate, before the first write: `would be refused`, with the checkpoint guard's words -- a user without View All Data and Modify All Data, more records than a take holds, more API requests than the org has left;
- **a `reset` or a `destroy --rewind` with no checkpoint to rewind to**: `names no checkpoint taken after an apply`, `names no checkpoint taken before its first apply`, and a `reset` once the last apply did not end whole. The rewind's own refusals are its: automation without `--accept-automation`, deletions undo could not bring back without `--accept-no-undo`, records the recycle bin no longer gives back, which an environment never makes again with new Ids (`never makes records again with new Ids`).

## The state

What `apply` keeps of the org: **ids, counts and dates, never a record's values**. Per resource, the fingerprint it was applied from, the order, and how each run ended; the records themselves are named by each seed run's own summary and run file, a clone's summary and a Frozen load's mapping, which the state points at.

- **Where.** `env/<Organization Id>/<name>/` of the journal directory, the folder `SANDFORGE_JOURNAL_DIR` names, `~/.sandforge` by default, beside the run files of the seeds it ran; a frozen resource's loads are kept there too, in `frozen/<resource>/`, its sas: folders readable by your user alone (`0700`), files too (`0600`). Filed under the Organization Id read from the org, not the alias: an alias reused for a new scratch org gets a new state, and so does a refreshed sandbox.
- **Outside the repository.** The journal directory must sit outside the repository that holds the file: committed, the state and the run summaries would publish the org's record ids with the project.
- **Between jobs.** Keep the journal directory between the jobs that apply and destroy, in a cache keyed by the org: in GitHub Actions, `$RUNNER_TEMP/sandforge`, restored before and saved after. Lost, the next plan cannot tell the environment's records from the org's own -- the refusal above.
- **One machine at a time.** An apply and a destroy hold a lock of the org on this machine, `~/.sandforge/locks/<Organization Id>.env.lock`, whatever `SANDFORGE_JOURNAL_DIR` says, and none of their runs starts while a checkpoint take, rewind or undo of the org is under way on this machine. Two machines applying to one org at once are not kept apart: give the jobs one concurrency group, keyed by the org.
- **How long.** A scratch org's state is deleted 30 days after its last write: every command but `validate` first deletes those whose date has come, and says so. Any other state stays, a `destroy` that took everything back included, until you delete its folder.
- **Its checkpoints.** The state names the ids of the environment's checkpoints, kept in `checkpoints/` of the same journal directory: a scratch org's for 30 days, any other's until the destroy that deletes them. Unlike the state, they hold the records' values, in clear.
- **Read strictly.** A state that does not parse is refused, never guessed; one that changed since it was read -- another apply ran, a cache put back an older one -- is refused, never written over.

## What destroy takes back, and what it leaves

Each resource is taken back by its script's own removal, the last applied first, into the recycle bin. What it cannot take back it names, exits `3`, and keeps in the state for the next destroy:

- **Records changed since the apply**, kept unless `--include-changed`, which takes them, and what was created under them since: on a CI scratch org, what you want; on a shared sandbox, a colleague's work, which the question says.
- **Records that stay because records of the org depend on them.**
- **What the org's automation created** as the records went in, unless `--sweep` takes it: as the run's user, in each run's window, refused when that user created records in the window that neither the run nor the automation reaches, likely by hand.
- **What the platform does not take back**: a person's contact apart from its account, a lead converted since, a contract activated since.

A removal refused before it deletes stops the destroy there, before the resources that one depended on: the org runs automation as records go and nothing accepted it, or the user may not delete the records of an object. Their records would be kept for it anyway.

A destroy is not undone as a whole: children deleted before their parent cannot come back with it from the recycle bin. It is undone by applying again.

Once every resource is taken back, the environment's checkpoints are deleted from this machine; a destroy that left records keeps them. What tests created on their own, not under the environment's records, is not the environment's, and a destroy by removal never sees it: `destroy --rewind` does ([Back to before the first apply](#back-to-before-the-first-apply-destroy---rewind)), and so does deleting the scratch org.

## Stopped part way

Ctrl-C, a SIGTERM -- a CI job cancelled or timed out -- or a SIGHUP stops the run under way before its next call to the org, and the command exits `130`, `143` or `129`. The state named the run before it started, and the seed's run file names what it wrote, a clone's summary what it created, a Frozen load's sas what it loaded, so the next plan says `replaced: its last run was stopped part way: what it wrote is taken back from its run file, then it runs again`, and `apply` takes up from there.

## Exit codes

The codes are those of every script ([`exitCodes.ts`](../packages/extension/cli/exitCodes.ts)):

| Code                | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`                 | Done: `validate`, the file is valid; `plan`, answered, whatever it found; `apply`, every resource applied whole, or nothing to do; `destroy`, every record taken back; `reset` and `destroy --rewind`, read again, the org matches the checkpoint                                                                                                                                                                                                                                                                                                                                                                                                          |
| `1`                 | Refused before it read or wrote, or nothing written: a production org, a kind of org or a sandbox the file does not allow, a protected org, a state of another org, no state without `--accept-no-state`, another apply of the org under way, a removal refused for automation without `--accept-automation`, more API requests, storage or emails than the org has left, a checkpoint the file asks that its script refuses, a production source without `anonymize` or `accept: { realData: true }`, no checkpoint to reset or rewind to, a rewind refused for want of `--accept-no-undo` or the automation acceptance; the alias typed is not the org's |
| `2`                 | A bad command line, a file that does not validate, a variable not set, the journal directory or a dataset inside the file's repository, a question with no terminal (give `--yes`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `3`                 | Partial: `apply`, a resource partial, or failed after others wrote; `destroy`, records left, each with why; `reset` and `destroy --rewind`, records still differ; `plan` with `--fail-on-change` or `--fail-on-drift`, changes or drift found, the whole org against the checkpoint after the last apply included                                                                                                                                                                                                                                                                                                                                          |
| `4`                 | Unstable: a verification found records still changing. No seed run verifies, so a file of seed resources does not end with it; a forge run is verified once it ends, and a frozen load by the verification it chains; `reset` and `destroy --rewind`, someone changed records during the rewind                                                                                                                                                                                                                                                                                                                                                            |
| `130`, `143`, `129` | Ctrl-C, a SIGTERM or a SIGHUP stopped it: run it again, it takes up from the state                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## Not yet

This version applies seed, forge and frozen resources; the rest waits for a later one:

- **Masking** as a resource: `kind: mask` is refused, `Resources of kind mask come with a later SandForge: this one applies seed, forge and frozen resources`.
- **Saved plans**: no `plan --out`, no `apply --plan`. `apply` plans again, against the org as it is then.
- **Outputs**, and the MCP server's tools for environments.

## In CI

[ci-examples](../ci-examples/README.md#an-environment-as-code) has the pattern: a plan with `--fail-on-drift` in a pull request, `apply` and `destroy` around the tests, the journal directory cached by org, and one concurrency group.
