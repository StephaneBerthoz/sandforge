import type { AsyncApexJob, JobInsight, JobInsightType } from '@sandforge/shared';

/** Threshold for frequent failures: jobs failing more than this count in 24h */
const FREQUENT_FAILURE_THRESHOLD = 3;

/** Threshold for long-running jobs: more than 5 minutes (in ms) */
const LONG_RUNNING_THRESHOLD_MS = 5 * 60 * 1000;

/** Threshold for high-consumer jobs: more than 1000 batch items */
const HIGH_CONSUMER_THRESHOLD = 1000;

/** Threshold for stuck jobs: processing for more than 1 hour (in ms) */
const STUCK_THRESHOLD_MS = 60 * 60 * 1000;

/** Groups jobs by their Apex class name */
function groupByClass(jobs: AsyncApexJob[]): Map<string, AsyncApexJob[]> {
  const groups = new Map<string, AsyncApexJob[]>();
  for (const job of jobs) {
    const className = job.apexClassName || 'Unknown';
    const group = groups.get(className) ?? [];
    group.push(job);
    groups.set(className, group);
  }
  return groups;
}

/** Calculate duration for a job in milliseconds */
function jobDurationMs(job: AsyncApexJob): number {
  const start = new Date(job.createdDate).getTime();
  const end = job.completedDate ? new Date(job.completedDate).getTime() : Date.now();
  return end - start;
}

/**
 * Analyzes async Apex jobs to detect patterns and generate actionable insights.
 * Detects frequent failures, long-running jobs, high-consumer jobs, and stuck jobs.
 */
export class JobAnalyzer {
  /**
   * Analyze a list of async Apex jobs and produce insights.
   * @param jobs - Array of AsyncApexJob records from the last 24h.
   */
  analyze(jobs: AsyncApexJob[]): JobInsight[] {
    const insights: JobInsight[] = [];

    insights.push(...this.detectFrequentFailures(jobs));
    insights.push(...this.detectLongRunning(jobs));
    insights.push(...this.detectHighConsumers(jobs));
    insights.push(...this.detectStuckJobs(jobs));

    return insights;
  }

  /** Detect classes that fail more than N times in the job set */
  private detectFrequentFailures(jobs: AsyncApexJob[]): JobInsight[] {
    const insights: JobInsight[] = [];
    const grouped = groupByClass(jobs);

    for (const [className, classJobs] of grouped) {
      const failedJobs = classJobs.filter((j) => j.status === 'Failed');
      if (failedJobs.length >= FREQUENT_FAILURE_THRESHOLD) {
        const errorMessages = failedJobs.map((j) => j.extendedStatus).filter(Boolean) as string[];
        const mostCommonError = this.findMostCommon(errorMessages) ?? 'Unknown error';

        insights.push({
          type: 'frequent_failures' as JobInsightType,
          severity: failedJobs.length >= 5 ? 'critical' : 'warning',
          title: `Frequent failures: ${className}`,
          detail: `Failed ${failedJobs.length} times in the last 24h. Most common error: ${mostCommonError}`,
          affectedJobs: failedJobs.map((j) => j.id),
          recommendation: `Check the error handling in ${className}. The recurring error "${mostCommonError}" suggests a systematic issue.`,
        });
      }
    }

    return insights;
  }

  /** Detect jobs that take longer than 5 minutes */
  private detectLongRunning(jobs: AsyncApexJob[]): JobInsight[] {
    const insights: JobInsight[] = [];
    const completedJobs = jobs.filter((j) => j.status === 'Completed' && j.completedDate);

    const grouped = groupByClass(completedJobs);

    for (const [className, classJobs] of grouped) {
      const longJobs = classJobs.filter((j) => jobDurationMs(j) > LONG_RUNNING_THRESHOLD_MS);
      if (longJobs.length > 0) {
        const avgDuration =
          longJobs.reduce((sum, j) => sum + jobDurationMs(j), 0) / longJobs.length;
        const avgMinutes = Math.round(avgDuration / 60_000);

        insights.push({
          type: 'long_running' as JobInsightType,
          severity: avgMinutes > 30 ? 'warning' : 'info',
          title: `Long running: ${className}`,
          detail: `${longJobs.length} execution(s) averaging ${avgMinutes} minutes.`,
          affectedJobs: longJobs.map((j) => j.id),
          recommendation: `Consider optimizing ${className} to reduce execution time. Review SOQL queries and bulkify DML operations.`,
        });
      }
    }

    return insights;
  }

  /** Detect jobs processing more than 1000 batch items */
  private detectHighConsumers(jobs: AsyncApexJob[]): JobInsight[] {
    const insights: JobInsight[] = [];
    const grouped = groupByClass(jobs);

    for (const [className, classJobs] of grouped) {
      const highConsumerJobs = classJobs.filter((j) => j.totalJobItems > HIGH_CONSUMER_THRESHOLD);
      if (highConsumerJobs.length > 0) {
        const maxItems = Math.max(...highConsumerJobs.map((j) => j.totalJobItems));

        insights.push({
          type: 'high_consumer' as JobInsightType,
          severity: 'info',
          title: `High consumer: ${className}`,
          detail: `Processing up to ${maxItems.toLocaleString()} batch items. ${highConsumerJobs.length} execution(s) above threshold.`,
          affectedJobs: highConsumerJobs.map((j) => j.id),
          recommendation: `Monitor ${className} for governor limit consumption. Consider reducing batch scope or optimizing data processing.`,
        });
      }
    }

    return insights;
  }

  /** Detect jobs stuck in Processing state for more than 1 hour */
  private detectStuckJobs(jobs: AsyncApexJob[]): JobInsight[] {
    const insights: JobInsight[] = [];
    const processingJobs = jobs.filter((j) => j.status === 'Processing');

    for (const job of processingJobs) {
      const duration = jobDurationMs(job);
      if (duration > STUCK_THRESHOLD_MS) {
        const hours = Math.round((duration / (60 * 60 * 1000)) * 10) / 10;

        insights.push({
          type: 'stuck' as JobInsightType,
          severity: 'critical',
          title: `Stuck job: ${job.apexClassName}`,
          detail: `Job ${job.id} has been processing for ${hours}h. This appears stuck.`,
          affectedJobs: [job.id],
          recommendation: `Consider aborting job ${job.id}. If this is a recurring issue, check for lock contention or infinite loops in ${job.apexClassName}.`,
        });
      }
    }

    return insights;
  }

  /** Find the most commonly occurring string in an array */
  private findMostCommon(items: string[]): string | undefined {
    if (items.length === 0) return undefined;
    const counts = new Map<string, number>();
    for (const item of items) {
      counts.set(item, (counts.get(item) ?? 0) + 1);
    }
    let maxCount = 0;
    let result: string | undefined;
    for (const [item, count] of counts) {
      if (count > maxCount) {
        maxCount = count;
        result = item;
      }
    }
    return result;
  }
}
