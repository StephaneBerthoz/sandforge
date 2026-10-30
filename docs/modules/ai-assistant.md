# AI Assistant

Chat about your Salesforce work, draft pipelines and SOQL in plain English, and let Seed fill fields with generated values, on your own Anthropic key. The assistant is off by default, and nothing is sent to a model before you turn it on and store a key.

<!-- how-to:start: written by scripts/sync-module-howto.mjs from howTo.ai in packages/webview/src/i18n/locales/en.json -->

## How to

1. If the page says AI Assistant Not Configured, click Go to Settings, then the AI tab.
2. Paste your Anthropic key into API key and click Save key and turn on AI.
3. Back in AI Assistant, click New Conversation.
4. Type your question in the message box and press Enter, or click Send.

**Tip:** The chat reads none of your orgs: paste into your question the error, query or field names it should look at.

<!-- how-to:end -->

## Quick Start

1. In the AI tab of the SandForge Settings page, read what each feature sends, then store your Anthropic API key with **Save key and turn on AI**. The key is kept in VS Code Secret Storage, never in a settings file. Tick **Suggest fixes for failed runs** beside it only if a failed run may send its error message (see Error resolution)
2. Open **AI Assistant** from the launcher's Modules list and start a conversation

The same card turns AI off and on again, and **Remove key** takes the key out of Secret Storage, turns AI off and deletes the conversations kept on this machine.

## Features

- **Chat** -- conversations on the AI Assistant page. A saved chat continues after a restart or an AI setting change, and the model is given its last 20 messages of it. The 50 conversations written to most recently are kept, whole, in VS Code's global state; **Delete all conversations** removes them
- **Pipeline drafts** -- in Automation, the AI Pipeline Generator drafts a pipeline from a description in natural language; its steps are marked when they cannot run (see [Automation](automation.md))
- **NL2SOQL** -- in Forge's AI tab, describe the records to clone in plain English and get the SOQL query discovery starts from (see [Seed](seed.md))
- **Custom personas and AI field rules** -- in Seed; an AI field rule is picked by you or set by a built-in persona
- **Scenario drafts** -- in Seed, **Draft from your own text** writes the scenario pack of an Agentforce agent's test data from your description, a plan then a call per topic, which **Stop** interrupts; its addresses and phone numbers are masked before it is sent, and the pack is reviewed and saved before it is seeded (see [Test data for an Agentforce agent](../agentforce-test-data.md))
- **One model, one budget** -- `sandforge.ai.model` picks the model every AI feature uses (chat, NL2SOQL, pipeline drafts, error resolution, Seed), and `sandforge.ai.tokenBudgetMaxPerSession` caps the tokens of a window session, shared by all of them, with a warning at 80%. Anthropic is the only provider

## Error resolution

While AI is on, a failed Seed, Sync, DataOps or Automation run sends its error message — every Salesforce Id in it replaced by `<id>` — to the model for a fix suggestion shown as a VS Code notification. A built-in table of common Salesforce error codes answers the codes it knows first, on your machine, AI on or off, and sends nothing: every module shows its answer under the error, in the interface language, and the notification says it only when the page that ran the operation does not. The failures SandForge writes itself, and any failure raised with no SandForge view open, send nothing either. `sandforge.ai.errorResolution` turns that sending off on its own, and the Settings page's AI card has a switch for it; the first key saved from that card sends no failure unless **Suggest fixes for failed runs** was ticked with it. Turning AI off stops it at once.

What each feature sends, a failed run included, is listed in the FAQ under [Is my data sent to external services?](../faq.md#is-my-data-sent-to-external-services)

## With AI off

Compare's schema advice and Monitor's anomaly scan are rule-based: they run with AI off and no key. Seed generates values with its Faker generators, templates and CSV import without any AI provider.
