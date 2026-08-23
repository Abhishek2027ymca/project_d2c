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
      await resumeAgentLoop(runId, approvalId);
      return;
    }

    console.log(`→ run ${runId} (ticket ${ticketId})`);
    await runAgentLoop(ticketId, runId);
  },
  { connection: redisConnection, concurrency: 2 },
);

worker.on('completed', (job) => {
  console.log(`✓ run ${job.data.runId} completed`);
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
