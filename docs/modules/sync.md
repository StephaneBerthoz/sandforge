# Sync

Synchronize data between two Salesforce orgs with full control over direction, field mapping, transforms, and conflict resolution. Sync supports bidirectional flows, incremental deltas, and Change Data Capture (CDC) for real-time change tracking.

## Quick Start

1. Navigate to **Sync** from the sidebar (requires at least 2 connected orgs)
2. Select a source org and a target org, then choose direction, mode, and conflict strategy
3. Configure the object set -- pick which objects to sync and set batch sizes
4. Map fields between source and target using the drag-and-drop Field Mapper or auto-match
5. Add transforms (optional), review the Sankey flow diagram, then execute

## Features

### Org Selection and Configuration

- **Source and Target Orgs** -- Select from your connected orgs with OrgBadge indicators
- **3 Directions** -- Source-to-target, target-to-source, or bidirectional
- **4 Sync Modes** -- Full, Incremental, Delta, and Change Data Capture (CDC)
- **5 Conflict Strategies** -- Source wins, target wins, newest wins, manual merge, or auto-merge

### Object Set Editor

- Add/remove objects to the sync scope
- Configure batch size per object
- Available objects are loaded from the source org schema

### Field Mapping

Two mapping interfaces work together:

- **Field Mapper** -- Visual drag-and-drop canvas showing source fields on the left and target fields on the right. Draw lines to create mappings, or click "Auto Match" to map fields with matching API names.
- **Field Mapping Canvas** -- Detailed table view with mapping type selection (Direct, Lookup, Formula, etc.) and per-mapping controls.

### Transforms

The Transform Builder lets you add data transformation rules that run during sync:

- String transforms (uppercase, lowercase, trim, regex replace)
- Date and number formatting
- Conditional logic and formula expressions
- Configurable per-field or per-object

### Review and Sankey Flow

Before execution, the Review step shows:

- Summary badges for direction, mode, and conflict strategy
- Object count, field mapping count, and transform count
- PII warnings if sensitive fields are detected in the sync scope
- A **Sankey Flow Diagram** visualizing data flow from source objects through mappings to target objects

### Execution and Results

- Real-time progress bar with elapsed time
- Sequential per-object execution; Grappe parallel execution is coming soon
- Per-object result breakdown: processed, succeeded, and failed counts
- Detailed error messages per object for troubleshooting

## Tips

- Use "Auto Match" in the Field Mapper first, then manually adjust the few fields that do not match
- Incremental mode is faster than Full for recurring syncs -- it only processes changed records
- CDC mode uses Salesforce Change Data Capture events for near-real-time sync
- Always review PII warnings in the Review step before executing
- If sync fails on certain objects, check field-level security on the target org
- Use the Sankey diagram to verify data flow before execution
