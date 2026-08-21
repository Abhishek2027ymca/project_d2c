/**
 * Manual smoke test for the BullMQ queue layer. No LLM, no worker — this only
 * proves the producer side behaves.
 *
 * The property that matters: enqueueing the same run twice must not create two
 * jobs. A duplicate POST /tickets, a retried HTTP request, or an at-least-once
 * delivery upstream would otherwise put the same run through the agent loop
 * twice — and the second pass would attempt the refund again.
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

async function main(): Promise<void> {
  // Start clean in case a previous run left the scratch job behind.
  await ticketQueue.remove(`run-${SCRATCH_RUN_ID}`).catch(() => undefined);

  const before = await ticketQueue.getWaitingCount();
  console.log(`waiting jobs before: ${before}\n`);

  console.log('enqueueTicket');
  await enqueueTicket({ ticketId: SCRATCH_TICKET_ID, runId: SCRATCH_RUN_ID });
  const afterFirst = await ticketQueue.getWaitingCount();
  check('first enqueue adds a job', afterFirst === before + 1, `count went ${before} -> ${afterFirst}`);

  await enqueueTicket({ ticketId: SCRATCH_TICKET_ID, runId: SCRATCH_RUN_ID });
  await enqueueTicket({ ticketId: SCRATCH_TICKET_ID, runId: SCRATCH_RUN_ID });
  const afterDuplicates = await ticketQueue.getWaitingCount();
  check(
    'repeat enqueues of the same run are deduped by jobId',
    afterDuplicates === afterFirst,
    `count went ${afterFirst} -> ${afterDuplicates}`,
  );

  const job = await ticketQueue.getJob(`run-${SCRATCH_RUN_ID}`);
  check('job id is derived from the run id', job?.id === `run-${SCRATCH_RUN_ID}`, `got ${job?.id}`);
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

  // Leave the queue as we found it.
  await ticketQueue.remove(`run-${SCRATCH_RUN_ID}`);
  const afterCleanup = await ticketQueue.getWaitingCount();
  check('scratch job cleaned up', afterCleanup === before, `count went ${afterDuplicates} -> ${afterCleanup}`);

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
