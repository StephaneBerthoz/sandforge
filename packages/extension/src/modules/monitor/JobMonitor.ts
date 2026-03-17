/** Information about a Salesforce async job */
export interface JobInfo {
  id: string;
  jobType: 'Bulk' | 'Batch' | 'Future' | 'Queueable' | 'Scheduled';
  status: 'Queued' | 'Processing' | 'Completed' | 'Failed' | 'Aborted';
  objectType?: string;
  createdBy: string;
  createdDate: string;
  completedDate?: string;
  totalRecords?: number;
  processedRecords?: number;
  failedRecords?: number;
}

/** Aggregated statistics for jobs in an org */
export interface JobStats {
  total: number;
  active: number;
  completed: number;
  failed: number;
}

/** Function signature for querying Salesforce async jobs */
export type QueryJobsFn = (orgId: string) => Promise<JobInfo[]>;

const ACTIVE_STATUSES = new Set<JobInfo['status']>(['Queued', 'Processing']);

/**
 * Monitors Salesforce async jobs (Bulk, Batch, Future, Queueable, Scheduled).
 * Maintains a cached list of jobs per org and provides filtering
 * and statistics methods.
 */
export class JobMonitor {
  private readonly queryJobs: QueryJobsFn;
  private readonly jobCache: Map<string, JobInfo[]> = new Map();

  constructor(queryJobs: QueryJobsFn) {
    this.queryJobs = queryJobs;
  }

  /** Fetch active jobs from Salesforce and update the cache */
  async fetch(orgId: string): Promise<JobInfo[]> {
    const jobs = await this.queryJobs(orgId);
    this.jobCache.set(orgId, jobs);
    return jobs;
  }

  /** Return cached jobs with an active (Queued or Processing) status */
  getActiveJobs(orgId: string): JobInfo[] {
    const jobs = this.jobCache.get(orgId) ?? [];
    return jobs.filter((job) => ACTIVE_STATUSES.has(job.status));
  }

  /** Return cached jobs with Failed status */
  getFailedJobs(orgId: string): JobInfo[] {
    const jobs = this.jobCache.get(orgId) ?? [];
    return jobs.filter((job) => job.status === 'Failed');
  }

  /** Compute aggregate statistics across all cached jobs for an org */
  getJobStats(orgId: string): JobStats {
    const jobs = this.jobCache.get(orgId) ?? [];
    return {
      total: jobs.length,
      active: jobs.filter((j) => ACTIVE_STATUSES.has(j.status)).length,
      completed: jobs.filter((j) => j.status === 'Completed').length,
      failed: jobs.filter((j) => j.status === 'Failed').length,
    };
  }
}
