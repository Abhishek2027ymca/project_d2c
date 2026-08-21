import 'dotenv/config';
import { Worker, type Job } from 'bullmq';
import { redisConnection } from './queue/connection.js';
import { TICKET_QUEUE_NAME, type TicketJobData } from './queue/ticketQueue.js';
import { runAgentLoop } from './agent/orchestrator.js';

const worker = new Worker<TicketJobData>(
  TICKET_QUEUE_NAME,
  async (job: Job<TicketJobData>) => {
    console.log(`→ run ${job.data.runId} (ticket ${job.data.ticketId})`);
    await runAgentLoop(job.data.ticketId, job.data.runId);
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
