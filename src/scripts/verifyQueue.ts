/**
 * Manual smoke test for the BullMQ queue layer. No LLM, no orchestrator — this
 * only proves the producer side behaves.
 *
 * The property that matters: enqueueing the same run twice must not create two
 * jobs. A duplicate POST /tickets, a retried HTTP request, or an at-least-once
 * delivery upstream would otherwise put the same run through the agent loop
 * twice — and the second pass would attempt the refund again.
 *
 * Assertions are by job id rather than by waiting-count, because a worker may
 * be running: it can pull the scratch job out of 'waiting' before the next line
 * executes, which says nothing about whether the producer did its job.
 *
 * Run with:  npm run verify:queue
 */
import { ticketQueue, enqueueTicket } from '../queue/ticketQueue.js';

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

// A run id far outside the seeded range, so this never collides with real work.
const SCRATCH_RUN_ID = 987_654;
const SCRATCH_TICKET_ID = 987_654;
const SCRATCH_JOB_ID = `run-${SCRATCH_RUN_ID}`;

async function main(): Promise<void> {
  // Start clean: a leftover scratch job from a previous run would be in a
  // terminal state, which enqueueTicket now (correctly) refuses to collide with.
  await ticketQueue.remove(SCRATCH_JOB_ID).catch(() => undefined);

  console.log('enqueueTicket');
  await enqueueTicket({ ticketId: SCRATCH_TICKET_ID, runId: SCRATCH_RUN_ID });
  const job = await ticketQueue.getJob(SCRATCH_JOB_ID);
  check('first enqueue creates the job', job !== undefined, 'no job found by id');

  await enqueueTicket({ ticketId: SCRATCH_TICKET_ID, runId: SCRATCH_RUN_ID });
  await enqueueTicket({ ticketId: SCRATCH_TICKET_ID, runId: SCRATCH_RUN_ID });
  const afterDuplicates = await ticketQueue.getJob(SCRATCH_JOB_ID);
  check(
    'repeat enqueues of the same run collapse onto one job',
    afterDuplicates?.id === job?.id && afterDuplicates?.timestamp === job?.timestamp,
    'a duplicate enqueue replaced or added a job',
  );

  check('job id is derived from the run id', job?.id === SCRATCH_JOB_ID, `got ${job?.id}`);
  check(
    'job payload carries both ticket and run id',
    job?.data.ticketId === SCRATCH_TICKET_ID && job?.data.runId === SCRATCH_RUN_ID,
    JSON.stringify(job?.data),
  );
  check(
    'retries are configured (safe only because refunds are guarded)',
    job?.opts.attempts === 3,
    `attempts=${job?.opts.attempts}`,
  );

  // Leave the queue as we found it. A live worker may hold the lock, so this is
  // best-effort — the next run's remove() at startup covers what this misses.
  await ticketQueue.remove(SCRATCH_JOB_ID).catch(() => undefined);
  const cleaned = await ticketQueue.getJob(SCRATCH_JOB_ID);
  if (cleaned) {
    console.log(`  NOTE  scratch job still present (likely held by a running worker)`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

try {
  await main();
} finally {
  await ticketQueue.close();
}
