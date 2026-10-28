# Test data for an Agentforce agent

An Agentforce agent is tested on records: a customer who writes in, the case they opened, the cases they had before and how those were resolved, the Knowledge article that answers them. Seed writes them from a **scenario pack**, records that agree with each other, and the agent's tests that ask about them, in a file the Salesforce CLI creates the tests from. No AI key is needed: the packs SandForge ships, and those you keep in your workspace, are compiled the same way every time, so a test that failed runs again on the data it failed on.

## What you need

- A sandbox, a scratch org or a Developer Edition org. Production Guard asks before the panel writes to a production org, and the command line refuses one.
- For the agent to answer from articles: Lightning Knowledge turned on in the org (Setup > Knowledge Settings), and an agent with a data library on Knowledge. Without Knowledge, the articles are skipped and the rest is written.
- For the test file: an Agentforce agent in the org. Without one, the data is written and the file is not: create the agent, then write the file from the run.
- To create and run the tests: the Salesforce CLI's `sf agent test` commands, from a Salesforce DX project. SandForge never runs them.

## In the panel

1. **Seed** > **Test data for an Agentforce agent**: pick a pack -- online shop orders, broadband support or software support, in English, or one of your `*.sandforge-scenario.json` files -- and **Review** it. Each topic shows its article, the facts an answer has to say, and what customers say. **Edit as JSON** to change it; an edited pack is saved in the workspace before it is seeded.
2. **Continue**, pick the org: the confirmation says what the run writes there -- 10 accounts, 10 contacts, 30 cases with their comments and 6 articles by default --, the case statuses it writes them with, read from the org, and whether the org has Knowledge. The seed's gates hold: data storage, the org's automation and the emails it would send, duplicate rules, then **Seed the scenario**.
3. On the results, **Agentforce test file**: pick the agent, match each topic of the scenario to one of its topics, with the actions it should take, and **Write the test file**. It goes to `specs/<agent>-<pack>-sandforge-testSpec.yaml` (`-ngtTestSpec.yaml` for Agentforce Studio) and never over a file there unless you say so. From a DX project, the page shows the two commands to run:

   ```bash
   sf agent test create --spec specs/<file> --api-name <name> -o <alias>
   sf agent test run --api-name <name> --wait 10 -o <alias>
   ```

4. Later, from **Earlier seeds**: the run's **Agentforce test file** writes the file once the org has an agent.

## From the command line

```bash
pnpm exec tsx packages/extension/cli/sandforge-seed.ts --target <alias> --scenario retail-orders --dry-run
pnpm exec tsx packages/extension/cli/sandforge-seed.ts --target <alias> --scenario retail-orders
pnpm exec tsx packages/extension/cli/sandforge-seed.ts --test-file <run file> --target <alias> \
  --agent <agent API name> --topic damaged-parcel=<agent topic> --topic refund=<agent topic> ...
```

`--scenario` takes a pack's id or a pack file; `--scenario-seed <n>` draws other names. `--test-file` without `--agent` lists the org's agents, their topics and actions. `sandforge-seed --help` gives every option.

## Drafting a pack from your own text

With AI on and an Anthropic key stored, **Draft from your own text** writes a pack from your description: a plan first, then one call per topic. What is sent: your text, its email addresses and phone numbers masked first -- **Show the text as it will be sent** shows it --, the language, and, for the org and the agent you pick, the Case picklist values and the agent's topic and action names. Never a record. **Stop** interrupts the call in flight; the topics already written are kept, and the draft goes on from them. A draft is seeded only once it is whole, reviewed and saved.

## Limits

- **No promise of a pass.** SandForge writes the data and what the agent is expected to do. The verdict depends on the agent's configuration and on a model that varies: a test that fails can come from the agent, not from the data.
- **Credits.** Running the tests spends the org's Agentforce or Einstein credits. SandForge never runs them.
- **Articles.** One language, the pack's, which the org's Knowledge base must have. No data categories. The body goes to a long text or rich text field of `Knowledge__kav`, or the article carries its summary alone. SandForge writes the articles as drafts and does not publish them yet: publish them in Knowledge for the agent's data library to index them, which takes some time. Once published, every internal Knowledge reader of the org sees them; the public channels stay closed.
- **Checkpoints.** A rewind does not take the articles back. Removing the seed does.
- **The test file goes stale.** It names the cases the run wrote: once the seed is removed, it points at cases that are gone, and the run's card says so. A test you created in the org from it is yours to delete: `sf project delete source -m AiEvaluationDefinition:<name>`.
- **Emails.** An agent that checks a customer by email sends one during the tests. The contacts' addresses reach nobody, but they count against a Developer Edition's 15 single emails a day.
- **Not in this version.** Emails, messaging sessions, voice calls and chat transcripts: the last three need channels set up.
