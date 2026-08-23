import { Queue } from 'bullmq';
import { redisConnection } from './connection.js';

export const TICKET_QUEUE_NAME = 'ticket-processing';

export interface TicketJobData {
  ticketId: number;
  runId: number;
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
