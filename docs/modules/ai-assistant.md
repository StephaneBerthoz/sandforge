# AI Assistant

Chat about your Salesforce work, draft pipelines and SOQL in plain English, and let Seed fill fields with generated values, on your own Anthropic key. The assistant is off by default, and nothing is sent to a model before you turn it on and store a key.

## Quick Start

1. Store your Anthropic API key in the AI tab of the SandForge Settings page. The key is kept in VS Code Secret Storage, never in a settings file
2. Turn on `sandforge.ai.enabled`
3. Open **AI Assistant** from the launcher's Modules list and start a conversation

## Features

- **Chat** -- conversations on the AI Assistant page. A saved chat continues after a restart or an AI setting change, and the model is given its last 20 messages of it
- **Pipeline drafts** -- in Automation, the AI Pipeline Generator drafts a pipeline from a description in natural language; its steps are marked when they cannot run (see [Automation](automation.md))
- **NL2SOQL** -- in Forge's AI tab, describe the records to clone in plain English and get the SOQL query discovery starts from (see [Seed](seed.md))
- **Custom personas and AI field rules** -- in Seed; an AI field rule is picked by you or set by a built-in persona
- **One model, one budget** -- `sandforge.ai.model` picks the model every AI feature uses (chat, NL2SOQL, pipeline drafts, error resolution, Seed), and `sandforge.ai.tokenBudgetMaxPerSession` caps the tokens of a window session, shared by all of them, with a warning at 80%. Anthropic is the only provider

## Error resolution

While AI is on, a failed Seed, Sync, DataOps or Automation run sends its error message — every Salesforce Id in it replaced by `<id>` — to the model for a fix suggestion shown as a VS Code notification. A built-in table of common Salesforce error codes answers the codes it knows first, on your machine, AI on or off, and sends nothing. The failures SandForge writes itself, and any failure raised with no SandForge view open, send nothing either. `sandforge.ai.errorResolution` turns that sending off on its own; turning AI off stops it at once.

What each feature sends, a failed run included, is listed in the FAQ under [Is my data sent to external services?](../faq.md#is-my-data-sent-to-external-services)

## With AI off

Compare's schema advice and Monitor's anomaly scan are rule-based: they run with AI off and no key. Seed generates values with its Faker generators, templates and CSV import without any AI provider.
