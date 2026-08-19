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
  await ticketQueue.add('process-ticket', data, { jobId: `run-${data.runId}` });
}
