import { Queue } from 'bullmq';
import { redisConnection } from './connection.js';

export const TICKET_QUEUE_NAME = 'ticket-processing';

export interface TicketJobData {
  ticketId: number;
  runId: number;
  /**
   * Present only on resume jobs. Its absence means "start this run from the
   * top"; its presence means "this run is parked at the gate, carry on from
   * the persisted conversation with this approval's verdict".
   */
  approvalId?: number;
}

export const ticketQueue = new Queue<TicketJobData>(TICKET_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    // Retries are safe here only because every money-moving action downstream is
    // idempotency-keyed. Without that, a retry after a partial failure would
    // double-refund.
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 500 },
  },
});

export async function enqueueTicket(data: TicketJobData): Promise<void> {
  // jobId is the run, not the ticket: one run is one attempt at processing.
  // BullMQ drops duplicate jobIds, so a double-POST cannot spawn two agent runs
  // for the same run record.
  const jobId = `run-${data.runId}`;
  const job = await ticketQueue.add('process-ticket', data, { jobId });

  // That dedup is only meaningful while the job is still live. BullMQ counts
  // retained completed/failed jobs toward uniqueness too, and returns the old
  // job instead of adding a new one -- so a run whose id collides with a
  // finished job is silently never queued. `db:seed` truncates with RESTART
  // IDENTITY, which makes run ids repeat, which makes that collision real.
  // A live duplicate is the feature; a terminal-state collision is a bug, and
  // it must be loud rather than leaving the run stuck at 'pending' forever.
  const state = await job.getState();
  if (state === 'completed' || state === 'failed') {
    throw new Error(
      `Enqueue for run ${data.runId} collided with an already-finished job ` +
        `(${jobId}, state: ${state}). The run was not queued. ` +
        `Clear stale jobs with: npm run queue:clear`,
    );
  }
}

/**
 * Resume a run that a human has just approved or rejected.
 *
 * Keyed on the approval rather than the run: a run can hit the gate more than
 * once, and each verdict is its own unit of work. It also makes a double-click
 * on Approve harmless -- the second enqueue collapses onto the first job
 * instead of resuming the run twice.
 *
 * The execution itself is still idempotency-keyed downstream; this is the
 * cheaper guard that stops the duplicate before it ever reaches a worker.
 */
export async function enqueueApprovalResume(data: Required<TicketJobData>): Promise<void> {
  const jobId = `approval-${data.approvalId}`;
  const job = await ticketQueue.add('resume-run', data, { jobId });

  const state = await job.getState();
  if (state === 'completed' || state === 'failed') {
    throw new Error(
      `Resume for approval ${data.approvalId} collided with an already-finished ` +
        `job (${jobId}, state: ${state}). The run was not resumed.`,
    );
  }
}
