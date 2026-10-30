# Grappe

A progress page, not an engine: once `sandforge.grappe.enabled` is on (off by default), a large Seed run reports there partition by partition, a large Sync one partition per object, and a large Autopilot run only its start and its end. Execution stays sequential: Grappe does not make a run faster.

<!-- how-to:start: written by scripts/sync-module-howto.mjs from howTo.grappe in packages/webview/src/i18n/locales/en.json -->

## How to

1. Click Open the Grappe setting and turn on sandforge.grappe.enabled.
2. Leave the Grappe page open, open Seed in the side panel, and seed 10,000 records or more.
3. Return to the Grappe page during the run: Active Execution shows each partition's progress.
4. When the run ends, read its totals on the Partitions, Records, processed and failed cards.

**Tip:** Lower sandforge.grappe.autoActivateThreshold to watch smaller runs; Grappe runs nothing itself and makes no run faster.

<!-- how-to:end -->
