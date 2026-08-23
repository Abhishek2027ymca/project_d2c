/**
 * Manual smoke test for the approval gate's state machine. No LLM, no worker.
 *
 * What this is really checking is that a human verdict can only ever be
 * recorded once. Everything downstream — the resume, the payout — treats an
 * approval as authorisation for exactly one action, so if the same approval
 * could be granted twice, the idempotency key derived from it would no longer
 * mean what it claims to.
 *
 * Run with:  npm run verify:approvals
 * Destructive: writes scratch tickets/runs/approvals. Re-seed afterwards.
 */
import pool from '../db/connection.js';
import { decideApproval } from '../approvals/decide.js';

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

/** A run parked at the gate, built directly so no model call is needed. */
async function createPausedRun(): Promise<{ runId: number; approvalId: number }> {
  const { rows: ticketRows } = await pool.query<{ id: number }>(
    `INSERT INTO tickets (customer_id, order_id, message, status)
     SELECT id, NULL, '[verifyApprovals] scratch ticket', 'awaiting_approval'
       FROM customers ORDER BY id LIMIT 1
     RETURNING id`,
  );
  const ticketId = ticketRows[0]!.id;

  const { rows: runRows } = await pool.query<{ id: number }>(
    `INSERT INTO agent_runs (ticket_id, status, conversation_state)
     VALUES ($1, 'awaiting_approval', $2) RETURNING id`,
    [ticketId, JSON.stringify({ contents: [], pendingResponses: [], stepOrder: 3 })],
  );
  const runId = runRows[0]!.id;

  const { rows: approvalRows } = await pool.query<{ id: number }>(
    `INSERT INTO approvals (run_id, proposed_action, status)
     VALUES ($1, $2, 'pending') RETURNING id`,
    [runId, JSON.stringify({ tool: 'issue_refund', args: { order_id: 1, amount: 10, reason: 'x' } })],
  );

  return { runId, approvalId: approvalRows[0]!.id };
}

async function statusOf(approvalId: number): Promise<string> {
  const { rows } = await pool.query<{ status: string }>(
    'SELECT status FROM approvals WHERE id = $1',
    [approvalId],
  );
  return rows[0]!.status;
}

async function main(): Promise<void> {
  console.log('validation');
  const scratch = await createPausedRun();

  const noReviewer = await decideApproval({
    approvalId: scratch.approvalId,
    decision: 'approved',
    reviewedBy: '   ',
  });
  check('refuses a decision with no reviewer', !noReviewer.ok, JSON.stringify(noReviewer));

  const noReason = await decideApproval({
    approvalId: scratch.approvalId,
    decision: 'rejected',
    reviewedBy: 'tester',
  });
  check('refuses a rejection with no reason', !noReason.ok, JSON.stringify(noReason));

  const missing = await decideApproval({
    approvalId: 999_999,
    decision: 'approved',
    reviewedBy: 'tester',
  });
  check(
    'reports an unknown approval as not_found',
    !missing.ok && missing.code === 'not_found',
    JSON.stringify(missing),
  );
  check('a rejected validation left the approval pending', (await statusOf(scratch.approvalId)) === 'pending');

  console.log('\nsingle decision');
  const approved = await decideApproval({
    approvalId: scratch.approvalId,
    decision: 'approved',
    reviewedBy: 'tester',
    reason: 'looks fine',
  });
  check('records a valid approval', approved.ok, JSON.stringify(approved));
  check('the approval is now approved', (await statusOf(scratch.approvalId)) === 'approved');

  const again = await decideApproval({
    approvalId: scratch.approvalId,
    decision: 'approved',
    reviewedBy: 'tester',
    reason: 'double click',
  });
  check(
    'a second approval is refused as already_decided',
    !again.ok && again.code === 'already_decided',
    JSON.stringify(again),
  );

  const flip = await decideApproval({
    approvalId: scratch.approvalId,
    decision: 'rejected',
    reviewedBy: 'someone else',
    reason: 'changed my mind',
  });
  check(
    'an approved action cannot then be rejected',
    !flip.ok && flip.code === 'already_decided',
    JSON.stringify(flip),
  );

  // The property that matters most: whatever else happened, exactly one verdict
  // is on record, so exactly one payout can ever be authorised by it.
  const { rows: grants } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM audit_log
      WHERE run_id = $1 AND event_type IN ('approval_granted','approval_rejected')`,
    [scratch.runId],
  );
  check(
    'exactly one decision was written to the audit log',
    grants[0]!.count === '1',
    `found ${grants[0]!.count}`,
  );

  console.log('\nconcurrent decisions');
  const race = await createPausedRun();
  // Fired together on separate pool connections: the conditional UPDATE, not
  // application ordering, is what has to pick a winner.
  const results = await Promise.all(
    ['alice', 'bob', 'carol'].map((who) =>
      decideApproval({ approvalId: race.approvalId, decision: 'approved', reviewedBy: who }),
    ),
  );
  check(
    'exactly one of three simultaneous approvals succeeds',
    results.filter((r) => r.ok).length === 1,
    `${results.filter((r) => r.ok).length} succeeded`,
  );
  check(
    'the losers report already_decided, not a crash',
    results.filter((r) => !r.ok && r.code === 'already_decided').length === 2,
    JSON.stringify(results.map((r) => (r.ok ? 'ok' : r.code))),
  );

  const { rows: raceGrants } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM audit_log WHERE run_id = $1 AND event_type = 'approval_granted'`,
    [race.runId],
  );
  check(
    'the race produced exactly one audit entry',
    raceGrants[0]!.count === '1',
    `found ${raceGrants[0]!.count}`,
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
  console.log('\nThis script wrote scratch rows. Restore with: npm run db:seed');
}

try {
  await main();
} finally {
  await pool.end();
}
