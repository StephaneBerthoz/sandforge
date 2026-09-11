# Monitor

Track your Salesforce org health in real time. Monitor shows API limits consumption, active jobs, storage usage, alerts, trend analysis, and predictive analytics -- all in a single dashboard.

## Quick Start

1. Navigate to **Monitor** from the sidebar
2. Select a connected org from the org selector (or click an org card in the empty state)
3. The dashboard loads with KPIs, trends, jobs, and governor limits
4. Click the refresh button to pull the latest data, or enable auto-refresh for continuous monitoring

## Features

### KPI Overview

The top row shows four key metrics at a glance:

- **Health Score** -- A composite gauge aggregating limits, jobs, storage, and error rates. Displayed as a radial gauge with color coding (green/amber/red).
- **API Calls Today** -- Current REST API consumption with a progress bar and percentage. Includes a prediction warning when approaching the daily limit.
- **Data Storage** -- Storage used vs. allocated in GB with usage percentage.
- **Alerts** -- Active alert count with severity-based coloring.

### Org Info Panel

A compact panel below the KPIs showing:

- Org name, ID, edition, instance, and API version
- Release name and upcoming release info
- User count, custom object count, Apex class count, and Flow count
- Namespace prefix, creation date, pod name, and datacenter
- Hyperforce indicator badge

### Live Operations

When SandForge operations (Seed, Sync, etc.) are running, a Live Operations panel appears showing:

- Per-operation progress bars
- Cancel, pause, and resume controls
- Real-time throughput metrics

### Trends and Charts

- Historical trend charts for API usage, storage, and record counts
- Multiple data series with time-based visualization
- Predictions tile with forecasted values

### Jobs Table

- Active Apex jobs, Bulk API jobs, and scheduled tasks
- Status badges (running, completed, failed)
- Job type, object type, record counts, and timing
- A stalled batch job links to the org's Setup › Apex Jobs page in Salesforce,
  where it can be aborted; SandForge does not abort jobs itself

### Governor Limits

An expandable section listing all Salesforce governor limits:

- Sorted by usage percentage (highest first)
- Color-coded progress bars (green/amber/red)
- Critical limit badges highlighted at the top
- Anomaly scan button that uses AI to detect statistical outliers

### Alerts Panel

- Configurable alert thresholds by severity
- Active alerts with timestamps
- Integration with the notification system

## Tips

- Enable auto-refresh (clock icon) during long-running operations to keep the dashboard current
- Expand Governor Limits when troubleshooting API limit errors
- Use the Anomaly Scan to catch unusual patterns in your org data
- Critical job insights appear as red banners at the top of the dashboard -- act on those first
- API limit predictions show hours remaining before the daily limit is reached
