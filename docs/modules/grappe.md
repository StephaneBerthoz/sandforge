# Grappe

A setting, not an engine: with `sandforge.grappe.enabled` on (off by default), a large Seed, Sync or Autopilot run shows its progress in a Grappe panel of its own run screen, Seed and Sync partition by partition, Autopilot only its start and its end. Execution stays sequential: Grappe does not make a run faster.

## Which runs, from which size

A run is reported once its records reach `sandforge.grappe.autoActivateThreshold`, 10,000 by default, counted before its first write. Under that, or with the setting off, the run screen shows its own progress and no Grappe panel.

- **Seed**, beside the run's progress by object, on Quick Seed's run screen and on the wizard's Execute step: the records the template plans. The run is cut into partitions of `sandforge.grappe.grappeSize` records, 5,000 by default, written one after another in insert order, and each is reported as it completes.
- **Sync**, on the Execute step: the source records, counted with one `SELECT COUNT()` per object before the run, which [Sync](sync.md) counts whether the setting is on or off. Each object is a partition, reported as its write ends.
- **Autopilot**, above the dependency graph and the control panel: the records of its plan. The run reports only its start and its end, its waves counted as its partitions; nothing is reported in between.

## What the panel shows

- A badge, **Grappe** while the run goes, **Completed** once it ends.
- **Partitions**: the partitions completed out of the run's, with a bar of them.
- **Records**: the records the run counted.
- While the run goes, up to five partitions still under way, each with its own bar.
- Once it ends, the records processed and failed.
