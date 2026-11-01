## Tune your settings

SandForge keeps its settings in two places:

- **Open Settings** opens SandForge's own page: the language of its panels, and the optional AI assistant, powered by Anthropic (Claude).
- **Open SandForge settings in VS Code** opens the editor's Settings, filtered to SandForge: the default batch sizes for Seed and Sync, the record of Production Guard's decisions kept with each run in the audit trail (Reports, `sandforge.safety.auditLogging`), and how Forge shows a large graph — drawn up to 25 objects and listed in a table past that, or always one way (`sandforge.forge.graphView`).

[Open Settings](command:sandforge.openSettings)

[Open SandForge settings in VS Code](command:workbench.action.openSettings?%5B%22%40ext%3AStephaneBerthoz.sandforge%22%5D)

> Forge, Frozen Dataset loads, Checkpoints and Compare's deploy refuse a production org; deletes are refused there too; every other write there asks first, and no setting turns that off. A sandbox holding real data (full copy, UAT): open its **Edit** dialog on Organizations and tick **Staging**, and Production Guard then asks before every delete, deployment and write over 10,000 records.
