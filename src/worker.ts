import 'dotenv/config';
import { Worker, type Job } from 'bullmq';
import { redisConnection } from './queue/connection.js';
import { TICKET_QUEUE_NAME, type TicketJobData } from './queue/ticketQueue.js';
import { runAgentLoop, resumeAgentLoop } from './agent/orchestrator.js';

const worker = new Worker<TicketJobData>(
  TICKET_QUEUE_NAME,
  async (job: Job<TicketJobData>) => {
    const { ticketId, runId, approvalId } = job.data;

    // Two kinds of work on one queue. An approvalId means this run is parked at
    // the gate and a human has ruled on it; its absence means start from the top.
    if (approvalId !== undefined) {
      console.log(`↻ resuming run ${runId} after approval ${approvalId}`);
      return resumeAgentLoop(runId, approvalId);
    }

    console.log(`→ run ${runId} (ticket ${ticketId})`);
    return runAgentLoop(ticketId, runId);
  },
  { connection: redisConnection, concurrency: 2 },
);

// A job finishing and a run finishing are different events: pausing at the
// approval gate is a perfectly successful job whose run is not done. Logging
// the returned run status keeps the two from being read as the same thing.
worker.on('completed', (job, status) => {
  if (status === 'awaiting_approval') {
    console.log(`⏸ run ${job.data.runId} paused, waiting on a human`);
  } else {
    console.log(`✓ run ${job.data.runId} ${status}`);
  }
});

worker.on('failed', (job, err) => {
  console.error(`✗ run ${job?.data.runId} failed:`, err.message);
});

async function shutdown(): Promise<void> {
  console.log('Shutting down worker...');
  await worker.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log('✓ Worker listening on queue:', TICKET_QUEUE_NAME);
