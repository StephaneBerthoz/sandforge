/** Salesforce Bulk API 2.0 job status */
export type BulkJobStatus =
  | 'UploadComplete'
  | 'InProgress'
  | 'Aborted'
  | 'JobComplete'
  | 'Failed';

/** Bulk API 2.0 job information */
export interface BulkJobInfo {
  id: string;
  operation: 'insert' | 'update' | 'upsert' | 'delete' | 'hardDelete';
  object: string;
  state: BulkJobStatus;
  numberRecordsProcessed: number;
  numberRecordsFailed: number;
  totalProcessingTime: number;
  createdDate: string;
  /** Total records submitted to the job (set when known). */
  totalRecords?: number;
}

/** Options for creating a Bulk API 2.0 job */
export interface BulkJobOptions {
  operation: 'insert' | 'update' | 'upsert' | 'delete' | 'hardDelete';
  object: string;
  externalIdFieldName?: string;
  lineEnding?: 'LF' | 'CRLF';
  columnDelimiter?: 'COMMA' | 'TAB' | 'PIPE' | 'SEMICOLON';
}

/**
 * Manages Salesforce Bulk API 2.0 jobs.
 * Tracks job lifecycle: create -> upload -> close -> poll -> get results.
 */
export class BulkApiManager {
  private activeJobs: Map<string, BulkJobInfo> = new Map();
  private readonly maxConcurrentJobs: number;
  private readonly maxCompletedJobs = 50;

  constructor(maxConcurrentJobs: number = 5) {
    this.maxConcurrentJobs = maxConcurrentJobs;
  }

  /** Register a new job for tracking */
  registerJob(job: BulkJobInfo): void {
    this.activeJobs.set(job.id, job);
  }

  /** Update the state of a tracked job */
  updateJobState(jobId: string, state: BulkJobStatus): boolean {
    const job = this.activeJobs.get(jobId);
    if (!job) return false;
    job.state = state;
    if (state === 'JobComplete' || state === 'Failed' || state === 'Aborted') {
      this.purgeCompletedJobs();
    }
    return true;
  }

  /** Update the processed and failed record counts of a tracked job */
  updateJobCounts(
    jobId: string,
    processed: number,
    failed: number
  ): boolean {
    const job = this.activeJobs.get(jobId);
    if (!job) return false;
    job.numberRecordsProcessed = processed;
    job.numberRecordsFailed = failed;
    return true;
  }

  /** Update the total records count for a tracked job */
  updateTotalRecords(jobId: string, total: number): boolean {
    const job = this.activeJobs.get(jobId);
    if (!job) return false;
    job.totalRecords = total;
    return true;
  }

  /** Get a job by its ID */
  getJob(jobId: string): BulkJobInfo | undefined {
    return this.activeJobs.get(jobId);
  }

  /** Get all non-terminal (active) jobs */
  getActiveJobs(): BulkJobInfo[] {
    return Array.from(this.activeJobs.values()).filter(
      (j) => j.state === 'UploadComplete' || j.state === 'InProgress'
    );
  }

  /** Get all terminal (completed, failed, or aborted) jobs */
  getCompletedJobs(): BulkJobInfo[] {
    return Array.from(this.activeJobs.values()).filter(
      (j) =>
        j.state === 'JobComplete' ||
        j.state === 'Failed' ||
        j.state === 'Aborted'
    );
  }

  /** Check if a new job can be started without exceeding the concurrency limit */
  canStartNewJob(): boolean {
    return this.getActiveJobs().length < this.maxConcurrentJobs;
  }

  /** Remove a job from tracking */
  removeJob(jobId: string): boolean {
    return this.activeJobs.delete(jobId);
  }

  /** Get the total number of tracked jobs */
  get totalJobs(): number {
    return this.activeJobs.size;
  }

  /** Purge oldest completed jobs when exceeding the retention limit */
  private purgeCompletedJobs(): void {
    const completed = Array.from(this.activeJobs.entries())
      .filter(([, job]) => ['JobComplete', 'Failed', 'Aborted'].includes(job.state));
    if (completed.length > this.maxCompletedJobs) {
      const toPurge = completed.slice(0, completed.length - this.maxCompletedJobs);
      for (const [id] of toPurge) {
        this.activeJobs.delete(id);
      }
    }
  }

  /** Clear all tracked jobs */
  clear(): void {
    this.activeJobs.clear();
  }
}
